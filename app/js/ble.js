/** Authenticated Nordic UART transport for browser Web Bluetooth and native Android. */
import { chunkBytes, createLineBuffer, encodeCommand, NUS_RX, NUS_SERVICE, NUS_TX } from "./protocol.js";


function nativeAndroid() {
  return typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
}

export function bluetoothAvailable() {
  return (typeof navigator !== "undefined" && !!navigator.bluetooth) || nativeAndroid();
}

export class BleTransport {
  constructor(handlers, { loadNative = () => import("../vendor/native-bridge.js"), isNative = nativeAndroid } = {}) {
    this.loadNative = loadNative;
    this.isNative = isNative;
    this.nativeBleClient = null;
    this.nativeConnection = null;
    this.nativeInitialized = null;
    this.generation = 0;
    this.connecting = null;
    this.remembered = null;
    try { this.remembered = JSON.parse(globalThis.localStorage?.getItem("sme105-bridge-device") || "null"); } catch {}
    if (typeof this.remembered?.deviceId !== "string") this.remembered = null;
    this.connectionWanted = !!this.remembered;
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
    if (this.isNative()) return this.connectNative();
    if (typeof navigator === "undefined" || !navigator.bluetooth) throw new Error("Bluetooth is unavailable. Use the installed Android app or Chrome on Android.");
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NUS_SERVICE] });
    return this.attach(device);
  }

  remember(device) {
    this.remembered = device;
    try {
      if (device) globalThis.localStorage?.setItem("sme105-bridge-device", JSON.stringify(device));
      else globalThis.localStorage?.removeItem("sme105-bridge-device");
    } catch {}
  }

  connectNative(device = this.remembered) {
    if (this.connecting) return this.connecting;
    this.connecting = this.openNative(device).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async openNative(knownDevice) {
    const { Capacitor, BleClient, BridgeConnection } = await this.loadNative();
    if (!Capacitor.isNativePlatform()) throw new Error("Native Bluetooth is only available in the installed Android app.");
    this.nativeBleClient = BleClient;
    this.nativeConnection = BridgeConnection;
    if (!this.nativeInitialized) this.nativeInitialized = BleClient.initialize({ androidNeverForLocation: true });
    let device;
    const generation = ++this.generation;
    try {
      await this.nativeInitialized;
      device = knownDevice || await BleClient.requestDevice({ optionalServices: [NUS_SERVICE] });
      this.connectionWanted = true;
      // Clear a stale OS/plugin GATT handle before attaching again. This is a
      // transport disconnect, never an ECU command or firmware reset.
      await BleClient.disconnect(device.deviceId);
      if (!(await BleClient.isBonded(device.deviceId))) await BleClient.createBond(device.deviceId);
      await BridgeConnection.start();
      this.nativeDeviceId = device.deviceId;
      this.device = { name: device.name || "SME105-DCL bridge" };
      this.buffer = createLineBuffer();
      this.decoder = new TextDecoder();
      this.queue = Promise.resolve();
      await BleClient.connect(device.deviceId, () => {
        if (this.generation !== generation || this.nativeDeviceId !== device.deviceId) return;
        this.nativeDeviceId = null;
        this.generation += 1;
        void BridgeConnection.stop().catch(() => {});
        this.handlers.onDisconnect();
      });
      // Android can emit an MTU callback before service discovery completes;
      // the BLE plugin may resolve connect at that point. Wait for an explicit
      // service-discovery completion before touching UART characteristics.
      await BleClient.discoverServices(device.deviceId);
      if (this.generation !== generation) throw new Error("Bluetooth disconnected during connection setup");
      await BleClient.startNotifications(device.deviceId, NUS_SERVICE, NUS_TX, (value) => {
        if (this.generation !== generation || this.nativeDeviceId !== device.deviceId) return;
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        for (const line of this.buffer.push(this.decoder.decode(bytes, { stream: true }))) this.handlers.onLine(line);
      });
      if (this.generation !== generation) throw new Error("Bluetooth disconnected during notification setup");
      this.remember({ deviceId: device.deviceId, name: this.device.name });
      return { name: this.device.name, mtu: await BleClient.getMtu(device.deviceId).catch(() => null) };
    } catch (error) {
      if (this.generation === generation) {
        this.nativeDeviceId = null;
        this.generation += 1;
        this.nativeInitialized = null;
        if (device) await BleClient.disconnect(device.deviceId).catch(() => {});
        await BridgeConnection.stop().catch(() => {});
      }
      const reason = error?.message || String(error);
      if (/denied|permission/i.test(reason)) throw new Error(`Bluetooth permission is required to connect. Allow Nearby devices, then retry. (${reason})`);
      throw error;
    }
  }

  async reconcile() {
    if (!this.isNative() || !this.connectionWanted || !this.remembered) return { connected: false };
    if (this.connecting) return { connected: true, reconnected: true, device: await this.connecting };
    const { BleClient } = await this.loadNative();
    if (this.nativeDeviceId) {
      const devices = await BleClient.getConnectedDevices([NUS_SERVICE]);
      if (devices.some(device => device.deviceId === this.nativeDeviceId)) return { connected: true, reconnected: false };
      this.nativeDeviceId = null;
      this.generation += 1;
      this.handlers.onDisconnect();
    }
    return { connected: true, reconnected: true, device: await this.connectNative(this.remembered) };
  }

  async setRecording(active) {
    if (this.nativeDeviceId && this.nativeConnection) await this.nativeConnection.setRecording({ active });
  }

  async discardNative() {
    const deviceId = this.nativeDeviceId;
    this.nativeDeviceId = null;
    this.generation += 1;
    if (deviceId) await this.nativeBleClient.disconnect(deviceId).catch(() => {});
    await this.nativeConnection?.stop().catch(() => {});
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
      const generation = this.generation;
      this.queue = this.queue.then(async () => {
        for (const chunk of chunks) {
          if (this.generation !== generation || this.nativeDeviceId !== deviceId) return;
          await this.nativeBleClient.write(deviceId, NUS_SERVICE, NUS_RX,
            new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
      }).catch(async (error) => {
        if (this.generation !== generation) return;
        await this.discardNative();
        this.handlers.onError?.(error);
      });
      return this.queue;
    }
    if (!this.rx) return Promise.reject(new Error("not connected"));
    this.queue = this.queue.then(async () => {
      for (const chunk of chunks) await this.rx.writeValueWithResponse(chunk);
    }).catch((error) => this.handlers.onError?.(error));
    return this.queue;
  }

  async disconnect() {
    this.connectionWanted = false;
    this.remember(null);
    if (this.nativeDeviceId || this.nativeConnection) {
      await this.discardNative();
      this.handlers.onDisconnect();
      return;
    }
    if (this.tx) this.tx.removeEventListener("characteristicvaluechanged", this.onValue);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.handlers.onDisconnect();
  }
}
