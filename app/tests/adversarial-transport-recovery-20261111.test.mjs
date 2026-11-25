import test from 'node:test';
import assert from 'node:assert/strict';
import { WifiTransport, nativeWifiProfileMatches } from '../js/wifi.js';
import { BleTransport } from '../js/ble.js';
import { createController } from '../js/controller.js';
import { NUS_SERVICE, EXPECTED_HELLO, EXPECTED_PINS } from '../js/protocol.js';

test('adversarial: repeated concurrent Connect taps share a single in-flight connection', async () => {
  let connectCalls = 0;
  const WifiBridge = {
    async getStatus() { return { connected: false, connecting: false, reconnecting: false }; },
    async savePassword() {},
    async hasPassword() { return true; },
    async connect() {
      connectCalls += 1;
      await new Promise(r => setTimeout(r, 20));
      return { connected: true, authenticated: true, nativeEpoch: 1 };
    },
    async addListener() { return { remove() {} }; },
    async disconnect() {},
  };
  const t = new WifiTransport({ onLine() {}, onDisconnect() {}, onStatus() {} }, {
    isNative: () => true,
    loadNative: async () => ({ WifiBridge }),
  });

  const [p1, p2, p3] = [
    t.connect({ mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765, password: 'password123' }),
    t.connect({ mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765, password: 'password123' }),
    t.connect({ mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765, password: 'password123' }),
  ];
  await Promise.all([p1, p2, p3]);
  assert.equal(connectCalls, 1, 'concurrent connect taps must deduplicate to exactly one flight');
  assert.equal(t.connected, true);
  assert.equal(t.authenticated, true);
});

test('adversarial: native disconnect rejection or timeout does not wedge transport state', async () => {
  const WifiBridge = {
    async disconnect() { throw new Error('Native IPC binder dead'); },
    async getStatus() { return { connected: false }; },
  };
  const t = new WifiTransport({ onDisconnect() {} }, {
    isNative: () => true,
    loadNative: async () => ({ WifiBridge }),
  });
  t.connected = true;
  t.authenticated = true;
  t.connectionWanted = true;

  // Even if native plugin rejects, JS transport state must be cleanly cleared
  await t.disconnect().catch(() => {});
  assert.equal(t.connected, false);
  assert.equal(t.authenticated, false);
  assert.equal(t.connectionWanted, false);
});

test('adversarial: stale callbacks from an older socket epoch cannot tear down or deliver to a newer connection', async () => {
  const lines = [];
  let disconnects = 0;
  const t = new WifiTransport({
    onLine: l => lines.push(l),
    onDisconnect: () => { disconnects += 1; },
  });

  const ctxOlder = { generation: 1, nativeEpoch: 10, active: true };
  const ctxNewer = { generation: 2, nativeEpoch: 11, active: true };
  t.generation = 2;
  t.listenerContext = ctxNewer;
  t.connected = true;
  t.authenticated = true;

  // Event from older epoch arriving late
  t.receiveLineEvent({ line: 'OLD_HELLO', socketEpoch: 10 }, ctxOlder);
  assert.deepEqual(lines, [], 'older epoch line must be discarded');

  // Error from older epoch arriving late
  await t.handleError({ reason: 'socket reset', socketEpoch: 10 }, ctxOlder);
  assert.equal(t.connected, true, 'older error must not tear down current connection');
  assert.equal(disconnects, 0);

  // Event from current epoch
  t.receiveLineEvent({ line: 'NEW_HELLO', socketEpoch: 11 }, ctxNewer);
  assert.deepEqual(lines, ['NEW_HELLO'], 'current epoch line must be delivered');
});

test('adversarial: lost transport during active diagnostic read transitions to incomplete/untrusted and never retries', async () => {
  const sent = [];
  let now = 1000;
  const controller = createController({
    now: () => now,
    send: cmd => { sent.push(cmd); return Promise.resolve(); },
  });

  // Complete bridge boot/hello/status handshake
  controller.onConnected('SME105-DCL');
  controller.handleLine('AUTH OK transport=BLE');
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine('STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0 fw=27');
  assert.equal(controller.requestVehicle('LIVE').ok, true);

  // Simulate transport drop
  controller.onDisconnected();
  assert.equal(controller.requestVehicle('LIVE').ok, false);

  // Clear sent commands
  sent.length = 0;

  // On reconnect without AUTH, vehicle requests fail closed
  controller.onConnected('SME105-DCL');
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine('STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0 fw=27');
  assert.equal(controller.requestVehicle('LIVE').ok, false, 'unauthorized reconnect must not accept vehicle requests');

  // Verify no vehicle command was replayed
  assert.ok(!sent.includes('READ_LIVE'), 'dangerous vehicle command must NEVER be replayed after reconnect');
  assert.ok(!sent.includes('ARM_LIVE'), 'arm must NEVER be replayed automatically after reconnect');
  assert.ok(!sent.includes('ARM_KOEO'), 'koeo must NEVER be replayed automatically after reconnect');
});

test('adversarial: BLE connection timeout releases GATT handles and cleans up connecting state', async () => {
  const BleClient = {
    async initialize() {},
    async requestDevice() { return { deviceId: 'test-ble-id', name: 'SME105-DCL' }; },
    async disconnect() {},
    async isBonded() { return true; },
    async connect() {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('Connection timeout.');
    },
  };
  const BridgeConnection = { async start() {}, async stop() {} };
  const t = new BleTransport({ onLine() {}, onDisconnect() {} }, {
    isNative: () => true,
    loadNative: async () => ({
      Capacitor: { isNativePlatform: () => true },
      BleClient,
      BridgeConnection,
    }),
  });

  await assert.rejects(t.connect(), /Connection timeout/);
  assert.equal(t.connecting, null, 'connecting flight must be reset after timeout');
  assert.equal(t.nativeDeviceId, null, 'nativeDeviceId must be null after timeout');
});

test('adversarial: native Wi-Fi profile mismatch fails closed and rejects rogue or legacy SSIDs', () => {
  const target = { mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765 };

  // Null or missing fields
  assert.equal(nativeWifiProfileMatches(null, target), false);
  assert.equal(nativeWifiProfileMatches({}, target), false);
  assert.equal(nativeWifiProfileMatches(target, null), false);

  // Mismatched SSID (e.g. older SME105_DCL or competitor AP)
  assert.equal(nativeWifiProfileMatches({ ...target, ssid: 'SME105_DCL' }, target), false);

  // Mismatched mode (e.g. sta instead of ap)
  assert.equal(nativeWifiProfileMatches({ ...target, mode: 'sta' }, target), false);

  // Mismatched IP / port
  assert.equal(nativeWifiProfileMatches({ ...target, host: '192.168.4.1' }, target), false);
  assert.equal(nativeWifiProfileMatches({ ...target, port: 8080 }, target), false);
  assert.equal(nativeWifiProfileMatches({ ...target, port: '8765' }, target), false, 'port must be strict integer');
});
