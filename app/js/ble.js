/** Authenticated Nordic UART transport for browser Web Bluetooth and native Android. */
import { chunkBytes, createLineBuffer, encodeCommand, NUS_RX, NUS_SERVICE, NUS_TX } from "./protocol.js";

let nativeBleClient = null;
let nativeInitialized = null;

function nativeAndroid() {
  return typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
}

export function bluetoothAvailable() {
  return (typeof navigator !== "undefined" && !!navigator.bluetooth) || nativeAndroid();
}

export class BleTransport {
  constructor(handlers) {
    this.handlers = handlers;
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.nativeDeviceId = null;
    this.buffer = createLineBuffer();
    this.decoder = new TextDecoder();
    this.queue = Promise.resolve();
    this.onValue = (event) => {
      const view = event.target.value;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (const line of this.buffer.push(this.decoder.decode(bytes, { stream: true }))) this.handlers.onLine(line);
    };
    this.onGattDisconnect = () => this.handlers.onDisconnect();
  }

  async connect() {
    if (nativeAndroid()) return this.connectNative();
    if (typeof navigator === "undefined" || !navigator.bluetooth) throw new Error("Bluetooth is unavailable. Use the installed Android app or Chrome on Android.");
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NUS_SERVICE] });
    return this.attach(device);
  }

  async connectNative() {
    const { Capacitor, BleClient } = await import("../vendor/native-bridge.js");
    if (!Capacitor.isNativePlatform()) throw new Error("Native Bluetooth is only available in the installed Android app.");
    nativeBleClient = BleClient;
    if (!nativeInitialized) nativeInitialized = BleClient.initialize({ androidNeverForLocation: true });
    try {
      await nativeInitialized;
      const device = await BleClient.requestDevice({ optionalServices: [NUS_SERVICE] });
      this.nativeDeviceId = device.deviceId;
      this.device = { name: device.name || "SME105-DCL bridge" };
      this.buffer = createLineBuffer();
      this.decoder = new TextDecoder();
      this.queue = Promise.resolve();
      if (!(await BleClient.isBonded(device.deviceId))) await BleClient.createBond(device.deviceId);
      await BleClient.connect(device.deviceId, () => {
        if (this.nativeDeviceId) {
          this.nativeDeviceId = null;
          this.handlers.onDisconnect();
        }
      });
      await BleClient.startNotifications(device.deviceId, NUS_SERVICE, NUS_TX, (value) => {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        for (const line of this.buffer.push(this.decoder.decode(bytes, { stream: true }))) this.handlers.onLine(line);
      });
      return { name: this.device.name, mtu: await BleClient.getMtu(device.deviceId).catch(() => null) };
    } catch (error) {
      const deviceId = this.nativeDeviceId;
      this.nativeDeviceId = null;
      nativeInitialized = null;
      if (deviceId) await BleClient.disconnect(deviceId).catch(() => {});
      const reason = error?.message || String(error);
      if (/denied|permission/i.test(reason)) throw new Error(`Bluetooth permission is required to connect. Allow Nearby devices, then retry. (${reason})`);
      throw error;
    }
  }

  async attach(device) {
    if (this.device) this.device.removeEventListener?.("gattserverdisconnected", this.onGattDisconnect);
    this.device = device;
    this.buffer = createLineBuffer();
    this.decoder = new TextDecoder();
    device.addEventListener("gattserverdisconnected", this.onGattDisconnect);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    this.tx = await service.getCharacteristic(NUS_TX);
    await this.tx.startNotifications();
    this.tx.addEventListener("characteristicvaluechanged", this.onValue);
    return device;
  }

  write(command) {
    const chunks = chunkBytes(encodeCommand(command));
    if (this.nativeDeviceId) {
      const deviceId = this.nativeDeviceId;
      this.queue = this.queue.then(async () => {
        for (const chunk of chunks) await nativeBleClient.write(deviceId, NUS_SERVICE, NUS_RX,
          new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }).catch((error) => this.handlers.onError?.(error));
      return this.queue;
    }
    if (!this.rx) return Promise.reject(new Error("not connected"));
    this.queue = this.queue.then(async () => {
      for (const chunk of chunks) await this.rx.writeValueWithResponse(chunk);
    }).catch((error) => this.handlers.onError?.(error));
    return this.queue;
  }

  async disconnect() {
    if (this.nativeDeviceId) {
      const deviceId = this.nativeDeviceId;
      this.nativeDeviceId = null;
      await nativeBleClient.disconnect(deviceId).catch((error) => this.handlers.onError?.(error));
      this.handlers.onDisconnect();
      return;
    }
    if (this.tx) this.tx.removeEventListener("characteristicvaluechanged", this.onValue);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.handlers.onDisconnect();
  }
}
