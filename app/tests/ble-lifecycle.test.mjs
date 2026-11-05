import test from 'node:test';
import assert from 'node:assert/strict';
import { BleTransport } from '../js/ble.js';
import { createController } from '../js/controller.js';
import { EXPECTED_HELLO, EXPECTED_PINS } from '../js/protocol.js';

function harness() {
  const calls = [], disconnects = [], notifications = [], lines = [], errors = [];
  let connected = [], failWrite = false, lost = 0, servicesReady = false;
  const device = { deviceId: 'test-bridge', name: 'SME105-DCL' };
  const BleClient = {
    initialize: async () => {},
    requestDevice: async () => device,
    disconnect: async id => { calls.push(['disconnect', id]); connected = []; servicesReady = false; },
    isBonded: async () => true,
    connect: async (id, callback) => { calls.push(['connect', id]); connected = [device]; disconnects.push(callback); },
    discoverServices: async id => { calls.push(['discover', id]); servicesReady = true; },
    startNotifications: async (id, service, characteristic, callback) => { assert.equal(servicesReady, true, 'notifications must wait for service discovery'); calls.push(['notify', id]); notifications.push(callback); },
    getMtu: async () => 185,
    getConnectedDevices: async () => connected,
    write: async (id, service, characteristic, data) => {
      calls.push(['write', new TextDecoder().decode(data)]);
      if (failWrite) throw new Error('GATT write failed');
    },
  };
  const BridgeConnection = {
    start: async () => { calls.push(['service-start']); },
    stop: async () => { calls.push(['service-stop']); },
    setRecording: async ({ active }) => { calls.push(['recording', active]); },
  };
  const transport = new BleTransport({ onLine: line => lines.push(line), onDisconnect: () => lost++, onError: error => errors.push(error) },
    { isNative: () => true, loadNative: async () => ({ Capacitor: { isNativePlatform: () => true }, BleClient, BridgeConnection }) });
  const emit = (callback, line) => { const data = new TextEncoder().encode(line + '\n'); callback(new DataView(data.buffer)); };
  return { transport, calls, device, disconnects, notifications, lines, errors, emit,
    lose() { connected = []; }, failWrite(value) { failWrite = value; }, get lost() { return lost; } };
}

test('foreground reconciliation preserves an established link and its notification stream', async () => {
  const h = harness();
  await h.transport.connect();
  await h.transport.setRecording(true);
  const before = h.calls.length;
  assert.deepEqual(await h.transport.reconcile(), { connected: true, reconnected: false });
  assert.equal(h.calls.length, before, 'resume must not reconnect, stop, or replace notifications');
  h.emit(h.notifications[0], 'RX t_us=1 byte=12');
  assert.deepEqual(h.lines, ['RX t_us=1 byte=12']);
  assert.equal(h.lost, 0);
});

test('a stale native link is closed and reconnected once; old callbacks cannot clear the new link', async () => {
  const h = harness();
  await h.transport.connect();
  h.lose();
  const result = await h.transport.reconcile();
  assert.equal(result.reconnected, true);
  assert.equal(h.lost, 1);
  assert.equal(h.calls.filter(call => call[0] === 'connect').length, 2);
  h.disconnects[0]();
  h.emit(h.notifications[0], 'stale');
  h.emit(h.notifications[1], 'current');
  assert.equal(h.transport.nativeDeviceId, h.device.deviceId);
  assert.deepEqual(h.lines, ['current']);
  assert.equal(h.lost, 1);
});

test('write failure releases the real GATT handle and permits recovery without replaying commands', async () => {
  const h = harness();
  await h.transport.connect();
  h.failWrite(true);
  await h.transport.write('HELLO');
  assert.equal(h.transport.nativeDeviceId, null);
  assert.equal(h.errors.length, 1);
  assert.equal(h.calls.at(-1)[0], 'service-stop');
  h.failWrite(false);
  await h.transport.reconcile();
  assert.equal(h.transport.nativeDeviceId, h.device.deviceId);
  assert.deepEqual(h.calls.filter(call => call[0] === 'write'), [['write', 'HELLO\n']]);
});

test('explicit disconnect disables foreground reconnection and releases recording protection', async () => {
  const h = harness();
  await h.transport.connect();
  await h.transport.disconnect();
  assert.equal(h.transport.remembered, null);
  assert.equal(h.transport.connectionWanted, false);
  const before = h.calls.length;
  assert.deepEqual(await h.transport.reconcile(), { connected: false });
  assert.equal(h.calls.length, before);
});

test('concurrent connection requests share one native connection attempt', async () => {
  const h = harness();
  const first = h.transport.connectNative(h.device);
  const second = h.transport.connectNative(h.device);
  assert.equal(first, second);
  await first;
  assert.equal(h.calls.filter(call => call[0] === 'connect').length, 1);
});

test('a restored controller link performs identity checks without arming a vehicle operation', () => {
  const sent = [];
  const controller = createController({ send: command => sent.push(command) });
  controller.onConnected('SME105-DCL');
  controller.handleLine('AUTH OK transport=BLE');
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  assert.deepEqual(sent, ['HELLO', 'PINS', 'STATUS']);
  assert.equal(controller.state.op, null);
});

test('an early connect/MTU completion cannot start notifications before UART service discovery', async () => {
  const h = harness();
  await h.transport.connect();
  const steps = h.calls.map(call => call[0]);
  assert.ok(steps.indexOf('connect') < steps.indexOf('discover'));
  assert.ok(steps.indexOf('discover') < steps.indexOf('notify'));
});
