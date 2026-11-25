import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WifiTransport, nativeWifiProfileMatches } from '../js/wifi.js';
import { BleTransport } from '../js/ble.js';
import { NUS_SERVICE } from '../js/protocol.js';

test('explicit Wi-Fi disconnect after WebView recreation revokes an orphaned native reconnect owner', async () => {
  let nativeDisconnects = 0;
  const WifiBridge = {
    async disconnect() { nativeDisconnects += 1; },
    async getStatus() { return { reconnecting: true, connectionState: 'reconnecting', authenticated: false }; },
  };
  const t = new WifiTransport({ onDisconnect() {} }, {
    isNative: () => true,
    loadNative: async () => ({ WifiBridge }),
  });
  assert.equal(t.wifiBridge, null, 'a WebView recreation has no local plugin reference');
  assert.equal((await t.getNativeStatus()).reconnecting, true);
  await t.disconnect();
  assert.equal(nativeDisconnects, 1, 'native reconnect must be cancelled by explicit operator intent');
  assert.equal(t.connectionWanted, false);
  assert.equal(t.connected, false);
  assert.equal(t.remembered, null);
});

test('a Wi-Fi disconnect without previous status query still loads native plugin and revokes it', async () => {
  const calls = [];
  const t = new WifiTransport({ onDisconnect() {} }, {
    isNative: () => true,
    loadNative: async () => ({ WifiBridge: { async disconnect() { calls.push('disconnect'); } } }),
  });
  await t.disconnect();
  assert.deepEqual(calls, ['disconnect']);
});

test('previous authenticated Wi-Fi owner must match exact configured bridge profile before adoption', () => {
  const expected = { mode: 'ap', ssid: 'SME105-DIRECT-2BF8', host: '10.77.13.1', port: 8765 };
  assert.equal(nativeWifiProfileMatches({ ...expected, connected: true, authenticated: true }, expected), true);
  assert.equal(nativeWifiProfileMatches({ ...expected, ssid: 'ANOTHER-ESP32', connected: true, authenticated: true }, expected), false);
  assert.equal(nativeWifiProfileMatches({ ...expected, mode: 'sta' }, expected), false);
  assert.equal(nativeWifiProfileMatches({ ...expected, host: '10.77.13.2' }, expected), false);
  assert.equal(nativeWifiProfileMatches({ ...expected, port: 80 }, expected), false);
  assert.equal(nativeWifiProfileMatches({ connected: true, authenticated: true }, expected), false, 'unknown bridge profile must fail closed');
});

test('BLE chooser restricts pairing to SME105 NUS devices and allows an explicit saved-device reset', async () => {
  const calls = [], device = { deviceId: 'test-sme105-id', name: 'SME105-DCL' };
  const BleClient = {
    async initialize() {},
    async requestDevice(opts) { calls.push(['picker', opts]); return device; },
    async disconnect() {},
    async isBonded() { return true; },
    async connect() {},
    async discoverServices() {},
    async startNotifications() {},
    async getMtu() { return 185; },
    async getConnectedDevices() { return []; },
  };
  const BridgeConnection = { async start() {}, async stop() {} };
  const t = new BleTransport({ onLine() {}, onDisconnect() {} }, {
    isNative: () => true,
    loadNative: async () => ({ Capacitor: { isNativePlatform: () => true }, BleClient, BridgeConnection }),
  });
  await t.connect();
  assert.deepEqual(calls, [['picker', { services: [NUS_SERVICE], namePrefix: 'SME105', optionalServices: [NUS_SERVICE] }]]);
  assert.equal(t.remembered.deviceId, device.deviceId);
  assert.throws(() => t.forgetRememberedDevice(), /Disconnect the active Bluetooth bridge/);
  await t.disconnect({ forget: false });
  assert.equal(t.remembered.deviceId, device.deviceId, 'switching transport preserves the paired device');
  assert.equal(t.connectionWanted, false);
  t.forgetRememberedDevice();
  assert.equal(t.remembered, null);
});

test('app wires transport ownership, a single Connect flight, recovery and explicit BLE reselection', async () => {
  const js = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const fragment of ['if (connectWork) return connectWork;', 'if (transportSwitchWork) await transportSwitchWork;',
    'await wifi.getNativeStatus()', 'WIFI_MANUAL_RECONNECT_RESET',
    'nativeWifiProfileMatches(nativeStatus, config)', 'rejectMismatchedWifiProfile()',
    'await wifi.disconnect()', 'if (transport !== wifi || transportSwitchWork) return;',
    'changeConfiguredTransport(event.target.value, event.target)', 'ble.forgetRememberedDevice()']) {
    assert.ok(js.includes(fragment), `missing recovery and ownership seam: ${fragment}`);
  }
  assert.match(html, /id="ble-choose-device"/);
  assert.match(html, /id="ble-firmware-help"/);
  assert.match(js, /controller\.state\.op && controller\.state\.link === "reconnecting"/,
    'manual reconnect must not interrupt an active vehicle recording');
  assert.match(js, /if \(connectWork \|\| transportSwitchWork \|\| wifiProfileRejectionWork\) return;/,
    'foreground reconciliation must not race an explicit Connect');
  assert.match(js, /if \(connectWork \|\| transportSwitchWork \|\| wifiProfileRejectionWork \|\| transport !== active\) return;/,
    'a stale foreground result must not take over a different transport');
});
