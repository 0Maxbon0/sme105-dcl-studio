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
    this.reconciling = null;
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
    this.notificationListener = null;
    this.gattDisconnectListener = null;
    this.mtu = null;
  }

  connect() {
    if (this.connecting) return this.connecting;
    if (this.isNative()) return this.connectNative();
    if (typeof navigator === "undefined" || !navigator.bluetooth) {
      return Promise.reject(new Error("Bluetooth is unavailable. Use the installed Android app or Chrome on Android."));
    }
    const generation = ++this.generation;
    const attempt = this.openBrowser(generation);
    const tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = null;
    });
    this.connecting = tracked;
    return tracked;
  }

  async openBrowser(generation) {
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NUS_SERVICE] });
    if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
    return this.attach(device, generation);
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
    this.connectionWanted = true;
    const attempt = this.openNative(device);
    const tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = null;
    });
    this.connecting = tracked;
    return tracked;
  }

  async openNative(knownDevice) {
    const generation = ++this.generation;
    this.mtu = null;
    let BleClient;
    let BridgeConnection;
    let device;
    try {
      const native = await this.loadNative();
      if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
      const { Capacitor } = native;
      BleClient = native.BleClient;
      BridgeConnection = native.BridgeConnection;
      if (!Capacitor.isNativePlatform()) throw new Error("Native Bluetooth is only available in the installed Android app.");
      this.nativeBleClient = BleClient;
      this.nativeConnection = BridgeConnection;
      if (!this.nativeInitialized) this.nativeInitialized = BleClient.initialize({ androidNeverForLocation: true });
      await this.nativeInitialized;
      if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
      device = knownDevice || await BleClient.requestDevice({ optionalServices: [NUS_SERVICE] });
      if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
      // Clear a stale OS/plugin GATT handle before attaching again. This is a
      // transport disconnect, never an ECU command or firmware reset.
      await BleClient.disconnect(device.deviceId);
      if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
      if (!(await BleClient.isBonded(device.deviceId))) await BleClient.createBond(device.deviceId);
      if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
      await BridgeConnection.start();
      if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
      this.nativeDeviceId = device.deviceId;
      this.device = { name: device.name || "SME105-DCL bridge" };
      this.buffer = createLineBuffer();
      this.decoder = new TextDecoder();
      this.queue = Promise.resolve();
      await BleClient.connect(device.deviceId, () => {
        if (this.generation !== generation || this.nativeDeviceId !== device.deviceId) return;
        this.nativeDeviceId = null;
        this.device = null;
        this.mtu = null;
        this.generation += 1;
        void BridgeConnection.stop().catch(() => {});
        this.handlers.onDisconnect?.();
      });
      // Android can emit an MTU callback before service discovery completes;
      // the BLE plugin may resolve connect at that point. Wait for an explicit
      // service-discovery completion before touching UART characteristics.
      if (this.generation !== generation) throw new Error("Bluetooth disconnected during connection setup");
      await BleClient.discoverServices(device.deviceId);
      if (this.generation !== generation) throw new Error("Bluetooth disconnected during connection setup");
      await BleClient.startNotifications(device.deviceId, NUS_SERVICE, NUS_TX, (value) => {
        if (this.generation !== generation || this.nativeDeviceId !== device.deviceId) return;
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        for (const line of this.buffer.push(this.decoder.decode(bytes, { stream: true }))) {
          if (this.generation !== generation || this.nativeDeviceId !== device.deviceId) return;
          this.handlers.onLine(line);
        }
      });
      if (this.generation !== generation) throw new Error("Bluetooth disconnected during notification setup");
      const mtu = await BleClient.getMtu(device.deviceId).catch(() => null);
      if (this.generation !== generation || this.nativeDeviceId !== device.deviceId) {
        throw new Error("Bluetooth disconnected during MTU negotiation");
      }
      this.mtu = mtu;
      this.remember({ deviceId: device.deviceId, name: this.device.name });
      return { name: this.device.name, mtu };
    } catch (error) {
      if (this.generation === generation) {
        this.nativeDeviceId = null;
        this.device = null;
        this.generation += 1;
        this.nativeInitialized = null;
        if (device && BleClient) await BleClient.disconnect(device.deviceId).catch(() => {});
        await BridgeConnection?.stop?.().catch(() => {});
      }
      const reason = error?.message || String(error);
      if (/denied|permission/i.test(reason)) throw new Error(`Bluetooth permission is required to connect. Allow Nearby devices, then retry. (${reason})`);
      throw error;
    }
  }

  reconcile() {
    if (this.reconciling) return this.reconciling;
    const attempt = this.reconcileNative();
    const tracked = attempt.finally(() => {
      if (this.reconciling === tracked) this.reconciling = null;
    });
    this.reconciling = tracked;
    return tracked;
  }

  async reconcileNative() {
    if (!this.isNative() || !this.connectionWanted || !this.remembered) return { connected: false };
    if (this.connecting) {
      try { return { connected: true, reconnected: true, device: await this.connecting }; }
      catch { return { connected: false }; }
    }
    const generation = this.generation;
    const deviceId = this.nativeDeviceId;
    const { BleClient } = await this.loadNative();
    if (generation !== this.generation) {
      if (this.connecting) {
        try { return { connected: true, reconnected: true, device: await this.connecting }; }
        catch { return { connected: false }; }
      }
      return this.nativeDeviceId ? { connected: true, reconnected: false } : { connected: false };
    }
    if (deviceId) {
      const devices = await BleClient.getConnectedDevices([NUS_SERVICE]);
      if (generation !== this.generation) {
        if (this.connecting) {
          try { return { connected: true, reconnected: true, device: await this.connecting }; }
          catch { return { connected: false }; }
        }
        return this.nativeDeviceId ? { connected: true, reconnected: false } : { connected: false };
      }
      if (devices.some(device => device.deviceId === deviceId)) return { connected: true, reconnected: false };
      this.nativeDeviceId = null;
      this.device = null;
      this.mtu = null;
      this.generation += 1;
      this.handlers.onDisconnect?.();
    }
    return { connected: true, reconnected: true, device: await this.connectNative(this.remembered) };
  }

  async setRecording(active) {
    if (this.nativeDeviceId && this.nativeConnection) await this.nativeConnection.setRecording({ active });
  }

  async discardNative() {
    const deviceId = this.nativeDeviceId;
    this.nativeDeviceId = null;
    this.device = null;
    this.mtu = null;
    this.generation += 1;
    if (deviceId) await this.nativeBleClient.disconnect(deviceId).catch(() => {});
    await this.nativeConnection?.stop().catch(() => {});
  }

  async attach(device, generation = ++this.generation) {
    if (generation !== this.generation) throw new Error("Bluetooth connection superseded");
    this.removeBrowserListeners();
    this.device = device;
    this.mtu = null;
    this.buffer = createLineBuffer();
    this.decoder = new TextDecoder();
    const onDisconnect = () => {
      if (generation !== this.generation || this.device !== device) return;
      this.removeBrowserListeners();
      this.device = null;
      this.rx = null;
      this.tx = null;
      this.generation += 1;
      this.handlers.onDisconnect?.();
    };
    this.gattDisconnectListener = onDisconnect;
    device.addEventListener("gattserverdisconnected", onDisconnect);

    try {
      const server = await device.gatt.connect();
      this.assertBrowserGeneration(generation, device);
      const service = await server.getPrimaryService(NUS_SERVICE);
      this.assertBrowserGeneration(generation, device);
      const rx = await service.getCharacteristic(NUS_RX);
      this.assertBrowserGeneration(generation, device);
      const tx = await service.getCharacteristic(NUS_TX);
      this.assertBrowserGeneration(generation, device);
      this.rx = rx;
      this.tx = tx;
      const onValue = event => {
        if (generation !== this.generation || this.device !== device || this.tx !== tx) return;
        const view = event.target.value;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        for (const line of this.buffer.push(this.decoder.decode(bytes, { stream: true }))) {
          if (generation !== this.generation || this.device !== device || this.tx !== tx) return;
          this.handlers.onLine(line);
        }
      };
      this.notificationListener = onValue;
      tx.addEventListener("characteristicvaluechanged", onValue);
      await tx.startNotifications();
      this.assertBrowserGeneration(generation, device);
      return device;
    } catch (error) {
      if (generation === this.generation && this.device === device) {
        this.removeBrowserListeners();
        this.device = null;
        this.rx = null;
        this.tx = null;
        this.generation += 1;
        if (device.gatt?.connected) device.gatt.disconnect();
      }
      throw error;
    }
  }

  assertBrowserGeneration(generation, device) {
    if (generation !== this.generation || this.device !== device) {
      throw new Error("Bluetooth connection superseded");
    }
  }

  removeBrowserListeners() {
    if (this.tx && this.notificationListener) {
      this.tx.removeEventListener("characteristicvaluechanged", this.notificationListener);
    }
    if (this.device && this.gattDisconnectListener) {
      this.device.removeEventListener("gattserverdisconnected", this.gattDisconnectListener);
    }
    this.notificationListener = null;
    this.gattDisconnectListener = null;
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
          if (this.generation !== generation || this.nativeDeviceId !== deviceId) return;
        }
      }).catch(async (error) => {
        if (this.generation !== generation) return;
        await this.discardNative();
        this.handlers.onError?.(error);
      });
      return this.queue;
    }
    if (!this.rx) return Promise.reject(new Error("not connected"));
    const rx = this.rx;
    const generation = this.generation;
    const device = this.device;
    this.queue = this.queue.then(async () => {
      for (const chunk of chunks) {
        if (this.generation !== generation || this.device !== device || this.rx !== rx) return;
        await rx.writeValueWithResponse(chunk);
        if (this.generation !== generation || this.device !== device || this.rx !== rx) return;
      }
    }).catch((error) => {
      if (this.generation === generation) this.handlers.onError?.(error);
    });
    return this.queue;
  }

  async disconnect() {
    this.connectionWanted = false;
    this.remember(null);
    this.generation += 1;
    if (this.nativeDeviceId || this.nativeConnection) {
      await this.discardNative();
      this.handlers.onDisconnect?.();
      return;
    }
    const device = this.device;
    this.removeBrowserListeners();
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.mtu = null;
    if (device?.gatt?.connected) device.gatt.disconnect();
    this.handlers.onDisconnect?.();
  }
}
