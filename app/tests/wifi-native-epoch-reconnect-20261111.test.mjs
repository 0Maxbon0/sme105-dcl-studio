import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WifiTransport } from '../js/wifi.js';

function nativeHarness() {
  const callbacks = new Map(), lines = [], reconnects = [], statuses = [];
  let statusErrorNext = false;
  const state = {
    connected: true, authenticated: true, reconnecting: false, connecting: false,
    socketEpoch: 10, activeSocketEpoch: 10, generation: 2,
    bootId: '00AB12CD', sessionId: '00123ABC', lastSeq: 50,
  };
  const WifiBridge = {
    async addListener(name, cb) {
      const item = { cb, active: true };
      if (!callbacks.has(name)) callbacks.set(name, []);
      callbacks.get(name).push(item);
      return { async remove() { item.active = false; } };
    },
    async savePassword() {},
    async hasPassword() { return { hasPassword: true }; },
    async connect() { return { connected: true, authenticated: true, socketEpoch: 10 }; },
    async disconnect() {},
    async getStatus() {
      if (statusErrorNext) { statusErrorNext = false; throw new Error('Native getStatus IPC unavailable'); }
      return { ...state };
    },
  };
  const transport = new WifiTransport({
    onLine: line => lines.push(line),
    onDisconnect() {},
    onReconnected: data => reconnects.push(data),
    onStatus: text => statuses.push(text),
  }, { isNative: () => true, loadNative: async () => ({ WifiBridge }) });
  const emit = async (name, payload) => {
    await Promise.all((callbacks.get(name) || []).filter(x => x.active).map(x => x.cb(payload)));
  };
  const update = patch => Object.assign(state, patch);
  return { transport, lines, reconnects, statuses, update, emit, failNextStatus: () => { statusErrorNext = true; } };
}

async function startDrop(h) {
  await h.transport.connect({ mode: 'ap', password: 'ExamplePass9' });
  h.update({ connected: false, authenticated: false, reconnecting: true, activeSocketEpoch: 0 });
  await h.emit('reconnecting', { socketEpoch: 10, generation: 2, reason: 'radio link lost' });
  assert.equal(h.transport.reconnecting, true);
  assert.equal(h.transport.authenticated, false);
}

const recovered = {
  connected: true, authenticated: true, reconnecting: false, connecting: false,
  socketEpoch: 11, activeSocketEpoch: 11, generation: 3,
  bootId: '00AB12CD', sessionId: '00123ABC', lastSeq: 63,
};

test('real Android event order: reconnected new socketEpoch arrives BEFORE first healthy diagnostic', async () => {
  const h = nativeHarness();
  await startDrop(h);
  h.update(recovered);
  await h.emit('reconnected', { socketEpoch: 11, generation: 3, bootId: '00AB12CD', sessionId: '00123ABC', seq: 63 });
  assert.equal(h.transport.connected, true);
  assert.equal(h.transport.authenticated, true);
  assert.equal(h.transport.nativeEpoch, 11);
  assert.equal(h.reconnects.length, 1);
  assert.deepEqual(h.reconnects[0], { bootId: '00AB12CD', sessionId: '00123ABC', seq: 63 });
  await h.emit('line', { socketEpoch: 11, line: 'RX t_us=2 byte=1A' });
  assert.deepEqual(h.lines, ['RX t_us=2 byte=1A']);
  await h.emit('diagnostic', { socketEpoch: 11, linkHealth: 'healthy' });
  assert.equal(h.reconnects.length, 1, 'one authenticated native socket leads to one recovery notification');
  await h.emit('reconnected', { socketEpoch: 10, generation: 2, seq: 50 });
  assert.equal(h.reconnects.length, 1, 'stale old socket must not replay a recovery');
});

test('reconnected event with failed status IPC cannot grant authentication; subsequent healthy diagnostic verifies it', async () => {
  const h = nativeHarness();
  await startDrop(h);
  h.update(recovered);
  h.failNextStatus();
  await h.emit('reconnected', { socketEpoch: 11, generation: 3, seq: 63 });
  assert.equal(h.transport.connected, false);
  assert.equal(h.transport.authenticated, false);
  assert.equal(h.transport.reconnecting, true);
  assert.deepEqual(h.reconnects, []);
  await h.emit('line', { socketEpoch: 11, line: 'UNTRUSTED' });
  assert.deepEqual(h.lines, [], 'do not feed ECU bytes before verified authentication');
  await h.emit('diagnostic', { socketEpoch: 11, linkHealth: 'healthy' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.transport.connected, true);
  assert.equal(h.transport.authenticated, true);
  assert.equal(h.reconnects.length, 1);
});

test('falsely authenticated status with mismatched active or event socketEpoch fails closed', async () => {
  const h = nativeHarness();
  await startDrop(h);
  h.update({ ...recovered, activeSocketEpoch: 10 });
  await h.emit('reconnected', { socketEpoch: 11, generation: 3 });
  assert.equal(h.transport.connected, false);
  assert.deepEqual(h.reconnects, []);
  h.update({ ...recovered, activeSocketEpoch: 11 });
  await h.emit('reconnected', { socketEpoch: 12, generation: 4 });
  assert.equal(h.transport.connected, false);
  assert.deepEqual(h.reconnects, []);
  await h.emit('reconnected', { socketEpoch: 11, generation: 3 });
  assert.equal(h.transport.connected, true);
  assert.equal(h.reconnects.length, 1);
});

test('native status missing an authenticated epoch cannot recover on event contents alone', async () => {
  const h = nativeHarness();
  await startDrop(h);
  h.update({ ...recovered, socketEpoch: undefined, activeSocketEpoch: undefined, generation: undefined });
  await h.emit('reconnected', { socketEpoch: 11, generation: 3 });
  assert.equal(h.transport.connected, false);
  assert.equal(h.transport.authenticated, false);
  assert.equal(h.reconnects.length, 0);
});

test('authenticated native reconnect carries the real socket profile to application ownership checks', async () => {
  const h = nativeHarness();
  await startDrop(h);
  h.update({ ...recovered, mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765 });
  await h.emit('reconnected', { socketEpoch: 11, generation: 3 });
  assert.equal(h.reconnects.length, 1);
  assert.deepEqual(h.reconnects[0].profile,
    { mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765 });
});

test('actual app onReconnected handler rejects a different authenticated AP before controller resumes', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const match = source.match(/  onReconnected\(metadata\) \{([\s\S]*?)\n  \},\n\}\);/);
  const rejectHelper = source.match(/function rejectMismatchedWifiProfile\(\) \{([\s\S]*?)\n\}\n/);
  assert.ok(match, 'production app onReconnected callback exists');
  assert.ok(rejectHelper, 'production app rejection flight exists');
  const expected = { mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765 };
  let disconnected = 0, controllerConnects = 0, controllerDisconnects = 0, incompleteCaptures = 0;
  const events = [];
  // Production WifiTransport.disconnect calls handlers.onDisconnect exactly
  // once on success; model that real callback, not a no-op stub.
  const wifi = { async disconnect() { disconnected += 1; controllerDisconnects += 1; } };
  const controller = {
    state: { phase: 'idle', link: 'reconnecting', op: null, transportStatus: 'reconnecting', message: '' },
    onConnected() { controllerConnects += 1; },
    onDisconnected() { this.state.link = 'disconnected'; },
    abortUnrecoverableRecovery() { incompleteCaptures += 1; this.state.op = null; },
  };
  const nativeWifiProfileMatches = (profile, target) =>
    !!profile && !!target && profile.mode === target.mode && profile.ssid === target.ssid &&
    profile.host === target.host && profile.port === target.port;
  const onReconnected = new Function('transport', 'wifi', 'transportSwitchWork', 'connectWork',
    'nativeWifiProfileMatches', 'wifiConfig', 'recordDiagnosticEvent', 'controller', 'renderApp',
    'handleTransportDisconnect', 'restoredRecovery', 'syncRecordingProtection',
    `let wifiProfileRejectionWork = null;
     function rejectMismatchedWifiProfile() {${rejectHelper[1]}\n}
     return function onReconnected(metadata) {${match[1]}\n};`)(
      wifi, wifi, null, null, nativeWifiProfileMatches, () => expected,
      (...event) => events.push(event), controller, () => {},
      () => { controllerDisconnects += 1; }, null, async () => {},
    );
  onReconnected({ profile: { ...expected, ssid: 'OTHER-SME105' }, bootId: '1234' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controllerConnects, 0, 'a different native AP cannot trigger controller RESUME or identity handshake');
  assert.equal(disconnected, 1, 'the mismatched native owner must be revoked');
  assert.equal(controllerDisconnects, 1);
  assert.equal(controller.state.transportStatus, 'disconnected');
  assert.equal(events.filter(([type]) => type === 'WIFI_RECONNECTED_PROFILE_REJECTED').length, 1);
  onReconnected({ profile: expected, bootId: '1234' });
  assert.equal(controllerConnects, 1, 'authenticated matching AP is accepted once');
  controller.state.op = { variant: 'ALL' };
  onReconnected({ profile: { ...expected, port: 8080 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controllerConnects, 1, 'wrong-AP reconnect must never resume a live capture');
  assert.equal(incompleteCaptures, 1, 'a revoked native owner cannot falsely retain a recoverable capture');
  assert.equal(disconnected, 2);
  assert.equal(controllerDisconnects, 2, 'one and only one disconnect callback per rejected profile');
});

test('Wi-Fi profile editor has an active connection/vehicle operation guard', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(source, /function wifiProfileEditAllowed\(\) \{[\s\S]*?controller\.state\.op[\s\S]*?!wifi\.connectionWanted/);
  assert.match(source, /getElementById\("wifi-ssid"\)\.addEventListener\("change"[\s\S]*?if \(!wifiProfileEditAllowed\(\)\)/);
  assert.match(source, /getElementById\("wifi-port"\)\.addEventListener\("change"[\s\S]*?if \(!wifiProfileEditAllowed\(\)\)/);
});
