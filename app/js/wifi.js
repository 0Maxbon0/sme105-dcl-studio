/** Authenticated SME105 bridge transport over the native Wi-Fi plugin. */
import { createLineBuffer } from "./protocol.js";

export const DIRECT_AP_SSID = "SME105-DIRECT-2BF8";

function nativeAndroid() {
  return typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
}

export function wifiAvailable() {
  return nativeAndroid() || globalThis.__SME105_WIFI_SIMULATED__ === true;
}

function rawText(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return null;
}

export class WifiTransport {
  constructor(handlers, { loadNative = () => import("../vendor/native-bridge.js"), isNative = nativeAndroid } = {}) {
    this.loadNative = loadNative;
    this.isNative = isNative;
    this.handlers = handlers;
    this.generation = 0;
    this.connecting = null;
    this.connected = false;
    this.authenticated = false;
    this.mode = "ap";
    this.host = "10.77.13.1";
    this.port = 8765;
    this.ssid = DIRECT_AP_SSID;
    this.queue = Promise.resolve();
    this.lineBuffer = createLineBuffer();
    this.remembered = null;
    this.connectionWanted = false;
    this.wifiBridge = null;
    this.nativeConnection = null;
    this.listenerHandles = [];
  }

  async loadPlugins() {
    if (this.wifiBridge) {
      return { WifiBridge: this.wifiBridge, BridgeConnection: this.nativeConnection };
    }
    const { WifiBridge, BridgeConnection } = await this.loadNative();
    if (!WifiBridge) throw new Error("Native Wi-Fi transport is unavailable.");
    this.wifiBridge = WifiBridge;
    this.nativeConnection = BridgeConnection || null;
    return { WifiBridge, BridgeConnection };
  }

  async addListener(bridge, eventName, listener, generation) {
    const handle = await bridge.addListener(eventName, listener);
    if (generation !== this.generation) {
      await handle?.remove?.();
      return;
    }
    this.listenerHandles.push(handle);
  }

  async cleanupListeners() {
    const handles = this.listenerHandles.splice(0);
    await Promise.all(handles.map(handle => Promise.resolve(handle?.remove?.()).catch(() => {})));
  }

  receiveLineEvent(event, generation) {
    if (generation !== this.generation) return;

    // Capacitor plugins may emit a framed line as { line }, or raw stream data
    // as { data } / { chunk }. Plain strings without delimiters are framed lines.
    if (event && typeof event === "object" && typeof event.line === "string") {
      const line = event.line.replace(/\r?\n$/, "");
      this.handlers.onLine(line);
      return;
    }

    const raw = typeof event === "string"
      ? (/[\r\n]/.test(event) ? event : null)
      : rawText(event?.data ?? event?.chunk ?? event?.value);
    if (raw !== null) {
      for (const line of this.lineBuffer.push(raw)) this.handlers.onLine(line);
      return;
    }

    if (typeof event === "string") this.handlers.onLine(event);
  }

  async openConnection(options) {
    const mode = options.mode ?? "ap";
    const ssid = options.ssid ?? (mode === "sta" ? "SME105_DCL" : DIRECT_AP_SSID);
    let password = options.password;
    let host = options.host;
    if (mode === "ap") {
      if (password !== undefined) {
        if (typeof password !== "string" || !/^[\x20-\x7E]{8,63}$/.test(password)) {
          throw new Error("SoftAP WPA2 password (8–63 printable ASCII characters) is required.");
        }
      } else {
        if (!(await this.hasPassword())) {
          throw new Error("SoftAP WPA2 password (8–63 printable ASCII characters) is required.");
        }
        // The native bridge reads the password previously saved in its secure store.
        password = "";
      }
    }
    if (mode === "sta" && (typeof host !== "string" || !host.trim())) {
      throw new Error("Wi-Fi host is required in STA mode.");
    }
    if (mode === "ap") host ??= "10.77.13.1";
    const port = options.port ?? 8765;
    const token = mode === "sta" ? options.token : undefined;
    const generation = ++this.generation;

    this.mode = mode;
    this.ssid = ssid;
    this.host = host;
    this.port = port;
    // Reconnect with the native Keystore value; never retain the typed AP
    // password in a long-lived JavaScript connection configuration.
    this.remembered = { mode, ssid, host, port, ...(token === undefined ? {} : { token }) };
    this.connectionWanted = true;
    this.connected = false;
    this.authenticated = false;
    this.lineBuffer = createLineBuffer();

    try {
      const { WifiBridge } = await this.loadPlugins();
      if (generation !== this.generation) throw new Error("Wi-Fi connection superseded");

      if (mode === "ap" && password) {
        // Enter once: native encrypts the passphrase before starting any
        // network activity. Android derives the TCP AUTH from that same secret.
        await WifiBridge.savePassword({ password, mode: "ap" });
        password = "";
      }
      if (generation !== this.generation) throw new Error("Wi-Fi connection superseded");

      await this.addListener(WifiBridge, "line", event => this.receiveLineEvent(event, generation), generation);
      await this.addListener(WifiBridge, "disconnect", () => {
        if (generation !== this.generation) return;
        this.connected = false;
        this.authenticated = false;
        this.generation += 1;
        void this.cleanupListeners();
        this.handlers.onDisconnect();
      }, generation);
      await this.addListener(WifiBridge, "error", error => {
        if (generation !== this.generation) return;
        this.handlers.onError(error?.error ?? error);
      }, generation);

      await WifiBridge.connect({ mode, ssid, password, host, port, ...(token === undefined ? {} : { token }) });
      if (generation !== this.generation) throw new Error("Wi-Fi disconnected during connection setup");
      this.connected = true;
      this.authenticated = true;
      return { name: `ESP32 Wi-Fi (${host}:${port})`, host, port, mode };
    } catch (error) {
      if (generation === this.generation) {
        this.connected = false;
        this.authenticated = false;
        this.generation += 1;
      }
      await this.cleanupListeners();
      this.handlers.onError?.(error);
      throw error;
    }
  }

  async connect(options = {}) {
    if (this.connecting) return this.connecting;
    const attempt = this.openConnection(options);
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  write(command) {
    const data = command.endsWith("\n") ? command : command + "\n";
    if (!this.wifiBridge || !this.connected) return Promise.reject(new Error("not connected"));
    const bridge = this.wifiBridge;
    const generation = this.generation;
    const write = this.queue.then(async () => {
      if (generation !== this.generation || !this.connected) {
        throw new Error("Wi-Fi write invalidated");
      }
      try {
        await bridge.write({ data });
      } catch (error) {
        if (generation === this.generation && this.connected) {
          try { this.handlers.onError?.(error); } catch { /* Preserve the native write failure for the caller. */ }
        }
        throw error;
      }
      if (generation !== this.generation || !this.connected) {
        throw new Error("Wi-Fi write invalidated");
      }
    });
    // The caller sees this command's failure, while the recovered tail lets
    // later writes drain and check their own connection generation.
    this.queue = write.catch(() => {});
    return write;
  }

  async disconnect() {
    this.connectionWanted = false;
    this.remembered = null;
    this.connected = false;
    this.authenticated = false;
    this.generation += 1;
    await this.cleanupListeners();
    if (this.wifiBridge) await this.wifiBridge.disconnect();
    this.handlers.onDisconnect();
  }

  async setRecording(active) {
    const { WifiBridge } = await this.loadPlugins();
    await WifiBridge.setRecording({ active });
  }

  async reconcile() {
    const { WifiBridge } = await this.loadPlugins();
    const status = await WifiBridge.getStatus();
    if (status?.connected && status?.authenticated) {
      this.connected = true;
      this.authenticated = true;
      return { connected: true, reconnected: false };
    }

    this.connected = false;
    this.authenticated = false;
    this.generation += 1;
    await this.cleanupListeners();
    this.handlers.onDisconnect();

    if (!this.connectionWanted || !this.remembered) return { connected: false };
    if (this.connecting) {
      try {
        await this.connecting;
      } catch {
        // The attempt was invalidated above; issue a fresh native connection below.
      }
    }
    try {
      const device = await this.connect(this.remembered);
      return { connected: true, reconnected: true, device };
    } catch {
      return { connected: false };
    }
  }

  async saveToken(token) {
    if (typeof token !== "string" || !/^[0-9a-fA-F]{32}$/.test(token)) {
      throw new Error("Wi-Fi token must be exactly 32 hexadecimal characters.");
    }
    const { WifiBridge } = await this.loadPlugins();
    return WifiBridge.saveToken({ token });
  }

  async hasToken() {
    const { WifiBridge } = await this.loadPlugins();
    const result = await WifiBridge.hasToken();
    return typeof result === "boolean" ? result : !!(result?.hasToken ?? result?.configured);
  }

  async hasPassword() {
    const { WifiBridge } = await this.loadPlugins();
    const result = await WifiBridge.hasPassword();
    return typeof result === "boolean" ? result : !!(result?.hasPassword ?? result?.configured);
  }

  async savePassword(password) {
    if (typeof password !== "string" || !/^[\x20-\x7E]{8,63}$/.test(password)) {
      throw new Error("Wi-Fi password must be 8–63 printable ASCII characters.");
    }
    const { WifiBridge } = await this.loadPlugins();
    return WifiBridge.savePassword({ password, mode: "ap" });
  }

  async clearPassword() {
    const { WifiBridge } = await this.loadPlugins();
    return WifiBridge.clearPassword();
  }

  async clearToken() {
    const { WifiBridge } = await this.loadPlugins();
    return WifiBridge.clearToken();
  }
}
