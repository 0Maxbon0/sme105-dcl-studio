import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createController } from '../js/controller.js';
import { EXPECTED_HELLO, EXPECTED_PINS } from '../js/protocol.js';
import { nativeWifiProfileMatches } from '../js/wifi.js';

const SAFE_STATUS = 'STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=27';

function activeLiveCapture() {
  const writes = [], archive = {
    id: 'interleaved-native-owner', variant: 'LIVE', lines: [], closed: false,
    line(value) { this.lines.push(String(value)); }, sample() {},
    finish(verdict) { this.closed = true; this.verdict = verdict; return Promise.resolve(); },
  };
  const controller = createController({ now: () => 10000, send: value => writes.push(value) });
  controller.onConnected('Original bridge', 'wifi');
  controller.handleLine('AUTH OK');
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine(SAFE_STATUS);
  controller.setArchive(archive);
  assert.equal(controller.requestVehicle('LIVE').ok, true);
  controller.handleLine(SAFE_STATUS);
  controller.handleLine('EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1');
  controller.handleLine('EVENT session=READ_CANDIDATE epoch=9 boot_id=77 session_id=31');
  controller.handleLine('RX t_us=100 byte=AA seq=100');
  controller.onDisconnected();
  assert.equal(controller.state.link, 'reconnecting');
  return { controller, writes, archive };
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { resolve, promise };
}

test('active foreground native reconcile loses ownership when newer callback rejects old authenticated AP', async () => {
  const js = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const rejectMatch = js.match(/function rejectMismatchedWifiProfile\(\) \{([\s\S]*?)\n\}\n/);
  const reconnectMatch = js.match(/  onReconnected\(metadata\) \{([\s\S]*?)\n  \},\n\}\);/);
  const foregroundMatch = js.match(/async function reconcileBridgeConnection\(\) \{([\s\S]*?)\n\}\n\nfunction connect\(/);
  for (const [label, match] of [['reject', rejectMatch], ['reconnected', reconnectMatch], ['foreground', foregroundMatch]]) {
    assert.ok(match, `production ${label} function must be executable by the test`);
  }
  const h = activeLiveCapture();
  const target = { mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765 };
  const oldProfile = { ...target };
  const actualSettings = { ...target };
  const reconcileGate = deferred(), reconcileStarted = deferred(), disconnectGate = deferred();
  let reconnections = 0, disconnects = 0;
  const events = [];
  const wifi = {
    connectionWanted: true, authenticated: true, connecting: null,
    async getNativeStatus() { return { ...oldProfile, connected: true, authenticated: true, socketEpoch: 10 }; },
    reconcile() { reconnections += 1; reconcileStarted.resolve(); return reconcileGate.promise; },
    async disconnect() { disconnects += 1; await disconnectGate.promise; },
  };
  const script = `let resumeWork = null, connectWork = null, transportSwitchWork = null, wifiProfileRejectionWork = null;
    let transport = wifi, restoredRecovery = null;
    function rejectMismatchedWifiProfile(){${rejectMatch[1]}\n}
    async function reconcileBridgeConnection(){${foregroundMatch[1]}\n}
    function onReconnected(metadata){${reconnectMatch[1]}\n}
    return {reconcileBridgeConnection, onReconnected, hasRejected:()=>!!wifiProfileRejectionWork};`;
  const factory = new Function('controller', 'wifi', 'ble', 'configuredTransport', 'demoEnabled', 'nativeApp',
    'renderApp', 'wifiConfig', 'nativeWifiProfileMatches', 'recordDiagnosticEvent', 'syncRecordingProtection', script);
  const flow = factory(h.controller, wifi, {}, () => 'wifi', () => false, () => true,
    () => {}, () => ({ ...actualSettings }), nativeWifiProfileMatches,
    (...a) => events.push(a), async () => {});

  const foreground = flow.reconcileBridgeConnection();
  await reconcileStarted.promise;
  assert.equal(reconnections, 1, 'real foreground function reached native reconcile');
  const countBefore = h.writes.length;
  actualSettings.ssid = 'SME105-ANOTHER-DEVICE';
  flow.onReconnected({ profile: oldProfile, socketEpoch: 11, bootId: 77, sessionId: 31 });
  assert.equal(flow.hasRejected(), true, 'rejection mutex must be acquired before native disconnect completes');
  await h.archive.finished;
  assert.equal(h.controller.state.op, null, 'native mismatch must terminate active capture synchronously');
  assert.equal(h.archive.verdict.status, 'INCOMPLETE');
  assert.match(h.archive.verdict.reasons.join(' '), /profile no longer matches Settings/);
  assert.equal(h.writes.length, countBefore, 'do not issue RESUME or STOP to rejected AP');
  flow.onReconnected({ profile: oldProfile, socketEpoch: 12 });
  assert.equal(disconnects, 1, 'repeated callbacks share one native teardown flight');
  reconcileGate.resolve({ connected: true, reconnected: true, device: { name: 'Rejected old AP' } });
  await foreground;
  assert.equal(h.writes.length, countBefore, 'stale foreground result is ignored even after native returns connected');
  assert.equal(h.controller.state.op, null);
  assert.equal(h.controller.state.link, 'disconnected');
  disconnectGate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flow.hasRejected(), false);
  assert.equal(disconnects, 1);
  assert.equal(h.archive.verdict.end, null);
  assert.equal(h.archive.lines.some(l => l.startsWith('END ')), false);
  assert.ok(events.some(([type]) => type === 'WIFI_RECONNECTED_PROFILE_REJECTED'));
});
