/** Web Bluetooth Nordic UART transport. Touches navigator only when called. */

import { chunkBytes, createLineBuffer, encodeCommand, NUS_RX, NUS_SERVICE, NUS_TX } from "./protocol.js";

export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

export class BleTransport {
  constructor(handlers) {
    this.handlers = handlers;
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.buffer = createLineBuffer();
    this.decoder = new TextDecoder();
    this.queue = Promise.resolve();
    this.onValue = (event) => {
      const view = event.target.value;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const text = this.decoder.decode(bytes, { stream: true });
      const lines = this.buffer.push(text);
      for (const line of lines) this.handlers.onLine(line);
    };
    this.onGattDisconnect = () => this.handlers.onDisconnect();
  }

  async connect() {
    if (!bluetoothAvailable()) throw new Error("Web Bluetooth is not available in this browser");
    // Show every nearby device. A name filter leaves Samsung's chooser
    // spinning when the ESP32 puts its name only in the scan response.
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [NUS_SERVICE],
    });
    return this.attach(device);
  }

  async attach(device) {
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this.onGattDisconnect);
    this.device = device;
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
    if (!this.rx) return Promise.reject(new Error("not connected"));
    const chunks = chunkBytes(encodeCommand(command));
    this.queue = this.queue.then(async () => {
      for (const chunk of chunks) await this.rx.writeValueWithResponse(chunk);
    }).catch((error) => {
      this.handlers.onError?.(error);
    });
    return this.queue;
  }

  async disconnect() {
    if (this.tx) this.tx.removeEventListener("characteristicvaluechanged", this.onValue);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.handlers.onDisconnect();
  }
}
