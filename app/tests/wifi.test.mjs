import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WifiTransport, wifiAvailable } from '../js/wifi.js';

const AP_PASSWORD = 'abcdefghijklmnop';

function harness({ connectError = null, hasPasswordResult = false } = {}) {
  const calls = [];
  const lines = [];
  const errors = [];
  let disconnects = 0;
  let statusConnected = false;
  let statusAuthenticated = false;
  let tokenResult = { hasToken: true };
  let passwordResult = hasPasswordResult;
  let maxConcurrentWrites = 0;
  let activeWrites = 0;
  let writeBehavior = null;
  const writeAttempts = [];
  const listeners = new Map();
  const WifiBridge = {
    async addListener(eventName, callback) {
      const handle = { eventName, callback, active: true };
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(handle);
      return { remove: async () => { handle.active = false; } };
    },
    async connect(options) {
      calls.push(['connect', options]);
      if (connectError) throw connectError;
      statusConnected = true;
      statusAuthenticated = true;
      return { connected: true, authenticated: true };
    },
    async disconnect() { calls.push(['disconnect']); statusConnected = false; statusAuthenticated = false; },
    async write({ data }) {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      writeAttempts.push(data);
      try {
        if (writeBehavior) await writeBehavior(data);
        else {
          await new Promise(resolve => setTimeout(resolve, 1));
          calls.push(['write', data]);
        }
      } finally {
        activeWrites -= 1;
      }
    },
    async setRecording({ active }) { calls.push(['recording', active]); },
    async getStatus() { return { connected: statusConnected, authenticated: statusAuthenticated }; },
    async saveToken({ token }) { calls.push(['saveToken', token]); },
    async hasToken() { return tokenResult; },
    async clearToken() { calls.push(['clearToken']); },
    async hasPassword() { return passwordResult; },
    async savePassword({ password }) { calls.push(['savePassword', password]); passwordResult = true; },
    async clearPassword() { calls.push(['clearPassword']); passwordResult = false; },
  };
  const BridgeConnection = {};
  const transport = new WifiTransport({
    onLine: line => lines.push(line),
    onDisconnect: () => { disconnects += 1; },
    onError: error => errors.push(error),
  }, { isNative: () => true, loadNative: async () => ({ WifiBridge, BridgeConnection }) });
  const emit = (eventName, value) => {
    for (const handle of listeners.get(eventName) || []) {
      if (handle.active) handle.callback(value);
    }
  };
  const callbacks = eventName => (listeners.get(eventName) || []).map(handle => handle.callback);
  const listenerHandles = eventName => listeners.get(eventName) || [];
  return {
    transport, calls, lines, errors, WifiBridge, emit, callbacks, listenerHandles,
    writeAttempts,
    get disconnects() { return disconnects; },
    get maxConcurrentWrites() { return maxConcurrentWrites; },
    setStatus(connected, authenticated = connected) {
      statusConnected = connected;
      statusAuthenticated = authenticated;
    },
    setTokenResult(result) { tokenResult = result; },
    setWriteBehavior(fn) { writeBehavior = fn; },
  };
}

test('connects in AP mode with a valid 16-character password and delivers framed plugin lines', async () => {
  const h = harness();
  const result = await h.transport.connect({ password: AP_PASSWORD });
  assert.deepEqual(result, {
    name: 'ESP32 Wi-Fi (10.77.13.1:8765)', host: '10.77.13.1', port: 8765, mode: 'ap',
  });
  assert.deepEqual(h.calls[0], ['connect', {
    mode: 'ap', ssid: 'SME105_DCL', password: AP_PASSWORD, host: '10.77.13.1', port: 8765, token: undefined,
  }]);
  assert.equal(h.transport.connected, true);
  assert.equal(h.transport.authenticated, true);
  h.emit('line', { line: 'AUTH OK transport=WIFI' });
  assert.deepEqual(h.lines, ['AUTH OK transport=WIFI']);
});

test('AP mode fails closed when the password is missing, empty, or shorter than 16 characters', async () => {
  const missing = harness();
  await assert.rejects(missing.transport.connect(), /SoftAP WPA2 password/);
  assert.equal(missing.calls.some(call => call[0] === 'connect'), false);

  const empty = harness();
  await assert.rejects(empty.transport.connect({ password: '' }), /SoftAP WPA2 password/);
  assert.equal(empty.calls.some(call => call[0] === 'connect'), false);

  const short = harness();
  await assert.rejects(short.transport.connect({ password: '123456789012345' }), /SoftAP WPA2 password/);
  assert.equal(short.calls.some(call => call[0] === 'connect'), false);
});

test('AP mode can use a password stored by the native secure password API', async () => {
  const h = harness({ hasPasswordResult: { hasPassword: true } });
  await h.transport.connect();
  assert.deepEqual(h.calls[0], ['connect', {
    mode: 'ap', ssid: 'SME105_DCL', password: '', host: '10.77.13.1', port: 8765, token: undefined,
  }]);
});

test('STA mode requires an explicit host', async () => {
  const h = harness();
  await assert.rejects(h.transport.connect({ mode: 'sta' }), /host is required in STA mode/);
  assert.equal(h.calls.some(call => call[0] === 'connect'), false);
});

test('buffers fragmented raw chunks and splits multi-line batches', async () => {
  const h = harness();
  await h.transport.connect({ password: AP_PASSWORD });
  h.emit('line', { chunk: 'RX t_us=1 ' });
  h.emit('line', { data: 'byte=12\r\nRX t_us=2 byte=34\nRX t_us=3' });
  h.emit('line', { data: ' byte=56\n' });
  assert.deepEqual(h.lines, [
    'RX t_us=1 byte=12',
    'RX t_us=2 byte=34',
    'RX t_us=3 byte=56',
  ]);
});

test('serializes command writes and adds one newline to each command', async () => {
  const h = harness();
  await h.transport.connect({ password: AP_PASSWORD });
  await Promise.all([
    h.transport.write('HELLO'),
    h.transport.write('PINS\n'),
    h.transport.write('STATUS'),
  ]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'write'), [
    ['write', 'HELLO\n'], ['write', 'PINS\n'], ['write', 'STATUS\n'],
  ]);
  assert.equal(h.maxConcurrentWrites, 1);
});

test('rejects a failed native write once, does not retry it, and drains later writes while connected', async () => {
  const failure = new Error('native write failed');
  const h = harness();
  await h.transport.connect({ password: AP_PASSWORD });
  h.setWriteBehavior(async data => {
    if (data === 'STATUS\n') throw failure;
    h.calls.push(['write', data]);
  });

  const failed = h.transport.write('STATUS');
  const following = h.transport.write('PINS');
  await assert.rejects(failed, error => error === failure);
  await following;

  assert.deepEqual(h.errors, [failure]);
  assert.deepEqual(h.writeAttempts, ['STATUS\n', 'PINS\n']);
  assert.deepEqual(h.calls.filter(call => call[0] === 'write'), [['write', 'PINS\n']]);
  assert.equal(h.transport.connected, true);
});

test('disconnect rejects pending writes and stale queued commands never send after reconnect', async () => {
  const h = harness();
  await h.transport.connect({ password: AP_PASSWORD });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let releaseWrite;
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  h.setWriteBehavior(async data => {
    if (data === 'IN_FLIGHT\n') {
      markStarted();
      await gate;
    }
    h.calls.push(['write', data]);
  });

  const inFlight = h.transport.write('IN_FLIGHT');
  const staleQueued = h.transport.write('STALE_QUEUED');
  await started;
  await h.transport.disconnect();
  await h.transport.connect({ mode: 'sta', host: '192.168.4.1' });
  const current = h.transport.write('CURRENT');
  releaseWrite();

  await assert.rejects(inFlight, /invalidated/);
  await assert.rejects(staleQueued, /invalidated/);
  await current;
  assert.deepEqual(h.writeAttempts, ['IN_FLIGHT\n', 'CURRENT\n']);
  assert.deepEqual(h.calls.filter(call => call[0] === 'write'), [
    ['write', 'IN_FLIGHT\n'], ['write', 'CURRENT\n'],
  ]);
});

test('the app controller send wrapper consumes transport rejections without duplicating error handling', async () => {
  const failure = new Error('native write failed');
  const h = harness();
  await h.transport.connect({ password: AP_PASSWORD });
  h.setWriteBehavior(async () => { throw failure; });

  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const match = source.match(/const controller = createController\(\{\s*send\(command\) \{([\s\S]*?)\n  \},\n\}\);/);
  assert.ok(match, 'controller send wrapper is present');
  const send = new Function('transport', 'controller', `return function(command) {${match[1]}\n};`)(
    h.transport,
    { state: { link: 'ready' } },
  );
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    send('STATUS');
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(h.errors, [failure]);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(h.writeAttempts, ['STATUS\n']);
});

test('disconnect invalidates old event callbacks and notifies once', async () => {
  const h = harness();
  await h.transport.connect({ password: AP_PASSWORD });
  const oldLine = h.callbacks('line')[0];
  const oldDisconnect = h.callbacks('disconnect')[0];
  const generation = h.transport.generation;
  h.emit('disconnect');
  await Promise.resolve();
  assert.equal(h.transport.connected, false);
  assert.equal(h.transport.authenticated, false);
  assert.equal(h.transport.generation, generation + 1);
  assert.equal(h.disconnects, 1);

  await h.transport.connect({ mode: 'sta', host: '192.168.4.1' });
  oldLine({ line: 'stale line' });
  oldDisconnect();
  assert.deepEqual(h.lines, []);
  assert.equal(h.disconnects, 1);
  assert.equal(h.transport.connected, true);
});

test('explicit disconnect calls the plugin, clears reconnect intent, and notifies', async () => {
  const h = harness();
  await h.transport.connect({ password: AP_PASSWORD });
  await h.transport.disconnect();
  assert.deepEqual(h.calls.at(-1), ['disconnect']);
  assert.equal(h.transport.connected, false);
  assert.equal(h.transport.authenticated, false);
  assert.equal(h.transport.connectionWanted, false);
  assert.equal(h.disconnects, 1);
});

test('reconcile requires authentication and reconnects a wanted connection through native connect', async () => {
  const h = harness();
  await h.transport.connect({ ssid: 'shop-net', password: AP_PASSWORD });
  assert.deepEqual(await h.transport.reconcile(), { connected: true, reconnected: false });
  h.setStatus(true, false);
  const recovered = await h.transport.reconcile();
  assert.equal(recovered.reconnected, true);
  assert.equal(h.transport.connected, true);
  assert.equal(h.transport.authenticated, true);
  assert.equal(h.disconnects, 1);
  assert.equal(h.calls.filter(call => call[0] === 'connect').length, 2);
});

test('reconcile clears state and listeners when the native connection is not authenticated', async () => {
  const h = harness();
  await h.transport.connect({ mode: 'sta', host: '192.168.4.1' });
  h.transport.connectionWanted = false;
  h.transport.remembered = null;
  h.setStatus(true, false);
  const generation = h.transport.generation;

  assert.deepEqual(await h.transport.reconcile(), { connected: false });
  assert.equal(h.transport.connected, false);
  assert.equal(h.transport.authenticated, false);
  assert.equal(h.transport.generation, generation + 1);
  assert.equal(h.disconnects, 1);
  assert.equal(h.listenerHandles('line').every(handle => !handle.active), true);
});

test('validates and delegates token management', async () => {
  const h = harness();
  await assert.rejects(h.transport.saveToken('not-a-token'), /32 hexadecimal/);
  await assert.rejects(h.transport.saveToken('0123456789abcdef0123456789abcdeg'), /32 hexadecimal/);
  const token = '0123456789abcdefABCDEF0123456789';
  await h.transport.saveToken(token);
  assert.equal(await h.transport.hasToken(), true);
  h.setTokenResult({ configured: true });
  assert.equal(await h.transport.hasToken(), true);
  await h.transport.clearToken();
  assert.deepEqual(h.calls.filter(call => ['saveToken', 'clearToken'].includes(call[0])), [
    ['saveToken', token], ['clearToken'],
  ]);
});

test('validates and delegates secure password management', async () => {
  const h = harness();
  await assert.rejects(h.transport.savePassword('short'), /between 8 and 63 characters/);
  await assert.rejects(h.transport.savePassword('x'.repeat(64)), /between 8 and 63 characters/);
  const password = 'secure-pass-1234';
  await h.transport.savePassword(password);
  assert.equal(await h.transport.hasPassword(), true);
  await h.transport.clearPassword();
  assert.equal(await h.transport.hasPassword(), false);
  assert.deepEqual(h.calls.filter(call => ['savePassword', 'clearPassword'].includes(call[0])), [
    ['savePassword', password], ['clearPassword'],
  ]);
});

test('delegates recording protection to WifiBridge', async () => {
  const h = harness();
  await h.transport.setRecording(true);
  assert.deepEqual(h.calls, [['recording', true]]);
});

test('reports a native connect failure and leaves transport disconnected', async () => {
  const failure = new Error('Wi-Fi authentication failed');
  const h = harness({ connectError: failure });
  await assert.rejects(h.transport.connect({ password: AP_PASSWORD }), /Wi-Fi authentication failed/);
  assert.equal(h.transport.connected, false);
  assert.equal(h.transport.authenticated, false);
  assert.deepEqual(h.errors, [failure]);
});

test('wifiAvailable recognizes native Android and the simulation flag', () => {
  const prior = globalThis.__SME105_WIFI_SIMULATED__;
  try {
    delete globalThis.__SME105_WIFI_SIMULATED__;
    assert.equal(wifiAvailable(), false);
    globalThis.__SME105_WIFI_SIMULATED__ = true;
    assert.equal(wifiAvailable(), true);
  } finally {
    if (prior === undefined) delete globalThis.__SME105_WIFI_SIMULATED__;
    else globalThis.__SME105_WIFI_SIMULATED__ = prior;
  }
});
