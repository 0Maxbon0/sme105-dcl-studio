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

function nativeEventEpoch(value) {
  const epoch = value?.socketEpoch ?? value?.nativeEpoch ?? value?.generation ?? value?.epoch;
  if (epoch === undefined || epoch === null || epoch === "") return null;
  const number = Number(epoch);
  return Number.isSafeInteger(number) ? number : null;
}

export class WifiTransport {
  constructor(handlers, { loadNative = () => import("../vendor/native-bridge.js"), isNative = nativeAndroid } = {}) {
    this.loadNative = loadNative;
    this.isNative = isNative;
    this.handlers = handlers;
    this.generation = 0;
    this.connecting = null;
    this.reconciling = null;
    this.listenerAttachment = null;
    this.listenerContext = null;
    this.nativeEpoch = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnecting = false;
    this.reconnectingCheck = null;
    this.explicitDisconnect = false;
    this.disconnectNotified = false;
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
    this.connectionMetadata = { bootId: null, sessionId: null, seq: null };
    this.bootId = null;
    this.sessionId = null;
    this.seq = null;
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

  async attachListeners(bridge, generation, nativeEpoch = this.nativeEpoch) {
    if (generation !== this.generation) return false;
    if (this.listenerContext?.active && this.listenerContext.generation === generation) {
      if (nativeEpoch !== null && nativeEpoch !== undefined) this.listenerContext.nativeEpoch = nativeEpoch;
      return true;
    }
    if (this.listenerAttachment?.generation === generation) return this.listenerAttachment.promise;

    if (this.listenerHandles.length > 0) await this.cleanupListeners();

    const context = { generation, nativeEpoch, active: true };
    this.listenerContext = context;

    const listeners = [
      ["line", event => this.receiveLineEvent(event, context)],
      ["disconnect", event => { void this.handleDisconnect(event, context); }],
      ["error", error => { void this.handleError(error, context); }],
      ["reconnecting", event => this.handleReconnecting(event, context)],
      ["reconnected", event => this.handleReconnected(event, context)],
      ["diagnostic", event => this.handleDiagnostic(event, context)],
    ];
    const promise = (async () => {
      const handles = [];
      try {
        for (const [eventName, listener] of listeners) {
          const handle = await bridge.addListener(eventName, listener);
          if (generation !== this.generation) {
            context.active = false;
            await Promise.resolve(handle?.remove?.()).catch(() => {});
            await Promise.all(handles.map(item => Promise.resolve(item?.remove?.()).catch(() => {})));
            if (this.listenerContext === context) this.listenerContext = null;
            return false;
          }
          handles.push(handle);
        }
        if (generation !== this.generation) {
          context.active = false;
          await Promise.all(handles.map(item => Promise.resolve(item?.remove?.()).catch(() => {})));
          if (this.listenerContext === context) this.listenerContext = null;
          return false;
        }
        this.listenerHandles.push(...handles);
        return true;
      } catch (error) {
        context.active = false;
        if (this.listenerContext === context) this.listenerContext = null;
        await Promise.all(handles.map(item => Promise.resolve(item?.remove?.()).catch(() => {})));
        throw error;
      }
    })();
    const attachment = { generation, promise };
    this.listenerAttachment = attachment;
    try {
      return await promise;
    } finally {
      if (this.listenerAttachment === attachment) this.listenerAttachment = null;
    }
  }

  async cleanupListeners() {
    if (this.listenerContext) this.listenerContext.active = false;
    this.listenerContext = null;
    const handles = this.listenerHandles.splice(0);
    await Promise.all(handles.map(handle => Promise.resolve(handle?.remove?.()).catch(() => {})));
  }

  isCurrentEvent(event, context) {
    if (!context?.active || context !== this.listenerContext || context.generation !== this.generation) return false;
    const eventEpoch = nativeEventEpoch(event);
    return eventEpoch === null || context.nativeEpoch === null || context.nativeEpoch === undefined || eventEpoch === context.nativeEpoch;
  }

  syncListenerGeneration() {
    if (this.listenerContext?.active) this.listenerContext.generation = this.generation;
  }

  notifyDisconnectOnce() {
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.handlers.onDisconnect?.();
  }

  handleReconnecting(event, context) {
    if (!this.isCurrentEvent(event, context)) return;
    const check = {};
    this.reconnectingCheck = check;
    return this.confirmReconnecting(event, context, check);
  }

  async confirmReconnecting(event, context, check) {
    try {
      const status = await this.wifiBridge.getStatus();
      if (!this.isCurrentEvent(event, context) || this.reconnectingCheck !== check) return;
      if (status.connected && status.authenticated && !status.reconnecting && !status.connecting) {
        this.reconnectingCheck = null;
        return;
      }
    } catch { /* The native reconnecting event remains authoritative if status is unavailable. */ }
    if (this.reconnectingCheck !== check) return;
    this.reconnectingCheck = null;
    this.markReconnecting(context);
  }

  markReconnecting(context) {
    if (!context?.active || context !== this.listenerContext || context.generation !== this.generation) return;
    this.reconnectingCheck = null;
    if (!this.reconnecting) {
      this.generation += 1;
      this.syncListenerGeneration();
    }
    this.reconnecting = true;
    this.connected = false;
    this.authenticated = false;
    this.lineBuffer = createLineBuffer();
    this.handlers.onStatus?.("reconnecting");
    this.notifyDisconnectOnce();
  }

  async handleError(error, context) {
    if (!this.isCurrentEvent(error, context)) return;
    let status = {};
    try { status = await this.wifiBridge.getStatus(); } catch { /* Report the native error if status is unavailable. */ }
    if (!this.isCurrentEvent(error, context)) return;
    if ((status.connected && status.authenticated) || status.reconnecting || status.connecting) return;
    this.handlers.onError?.(error?.error ?? error);
  }

  handleDiagnostic(event, context) {
    if (!context?.active || context !== this.listenerContext || context.generation !== this.generation) return;
    const eventEpoch = nativeEventEpoch(event);
    if (eventEpoch !== null && context.nativeEpoch !== null && context.nativeEpoch !== undefined &&
        eventEpoch !== context.nativeEpoch) {
      if ((!this.reconnecting && !this.reconnectingCheck) || eventEpoch < context.nativeEpoch) return;
      context.nativeEpoch = eventEpoch;
      this.nativeEpoch = eventEpoch;
    }
    if (context.nativeEpoch === null || context.nativeEpoch === undefined) {
      context.nativeEpoch = eventEpoch;
      this.nativeEpoch = context.nativeEpoch;
    }
    this.handlers.onDiagnostic?.(event);
  }

  async handleReconnected(event, context) {
    if (!this.isCurrentEvent(event, context)) return;
    if (context.reconnectedCheck) return;
    const check = {};
    context.reconnectedCheck = check;
    let status = {};
    try { status = await this.wifiBridge.getStatus(); } catch { /* The native event still carries recovery metadata. */ }
    if (!this.isCurrentEvent(event, context) || context.reconnectedCheck !== check) return;
    const statusEpoch = nativeEventEpoch(status);
    if (statusEpoch !== null && context.nativeEpoch !== null && context.nativeEpoch !== undefined &&
        statusEpoch < context.nativeEpoch) {
      context.reconnectedCheck = null;
      return;
    }
    if (status.connected === false || status.authenticated === false) {
      context.reconnectedCheck = null;
      return;
    }
    if (!this.reconnecting && statusEpoch !== null && statusEpoch === context.nativeEpoch) {
      context.reconnectedCheck = null;
      return;
    }

    context.reconnectedCheck = null;
    if (!this.reconnecting) {
      this.generation += 1;
      this.syncListenerGeneration();
    }
    if (statusEpoch !== null) context.nativeEpoch = statusEpoch;
    this.nativeEpoch = context.nativeEpoch ?? nativeEventEpoch(event);
    const metadata = {
      bootId: status.bootId ?? event?.bootId ?? null,
      sessionId: status.sessionId ?? event?.sessionId ?? null,
      seq: status.seq ?? status.lastSeq ?? event?.seq ?? null,
    };
    this.connectionMetadata = metadata;
    Object.assign(this, metadata);
    this.connected = true;
    this.authenticated = true;
    this.reconnecting = false;
    this.reconnectingCheck = null;
    this.disconnectNotified = false;
    this.lineBuffer = createLineBuffer();

    this.handlers.onStatus?.("connected");
    this.handlers.onReconnected?.(metadata);
  }

  async handleDisconnect(event, context) {
    if (!this.isCurrentEvent(event, context)) return;
    let status = {};
    try { status = await this.wifiBridge.getStatus(); } catch { /* Fall back to the JavaScript connection intent. */ }
    if (!this.isCurrentEvent(event, context)) return;

    if (status.connected && status.authenticated) return;
    if (status.reconnecting || status.connecting) {
      this.markReconnecting(context);
      return;
    }

    const explicitlyClosed = this.explicitDisconnect || !this.connectionWanted ||
      /disconnected by client/i.test(String(event?.reason ?? ""));
    if (!explicitlyClosed && this.connectionWanted) {
      this.handleReconnecting(event, context);
      return;
    }

    this.connected = false;
    this.authenticated = false;
    this.reconnecting = false;
    this.reconnectingCheck = null;
    this.connectionWanted = false;
    this.generation += 1;
    this.lineBuffer = createLineBuffer();
    await this.cleanupListeners();
    this.notifyDisconnectOnce();
  }

  receiveLineEvent(event, context) {
    if (!this.isCurrentEvent(event, context) || this.reconnecting) return;

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
    this.explicitDisconnect = false;
    this.disconnectNotified = false;
    this.reconnecting = false;
    this.reconnectingCheck = null;
    this.connected = false;
    this.authenticated = false;
    this.lineBuffer = createLineBuffer();
    this.nativeEpoch = null;

    try {
      await this.cleanupListeners();
      const { WifiBridge } = await this.loadPlugins();
      if (generation !== this.generation) throw new Error("Wi-Fi connection superseded");

      if (mode === "ap" && password) {
        // Enter once: native encrypts the passphrase before starting any
        // network activity. Android derives the TCP AUTH from that same secret.
        await WifiBridge.savePassword({ password, mode: "ap" });
        password = "";
      }
      if (generation !== this.generation) throw new Error("Wi-Fi connection superseded");

      if (!(await this.attachListeners(WifiBridge, generation))) {
        throw new Error("Wi-Fi connection superseded");
      }
      if (generation !== this.generation) throw new Error("Wi-Fi connection superseded");

      const result = await WifiBridge.connect({ mode, ssid, password, host, port, ...(token === undefined ? {} : { token }) });
      if (generation !== this.generation) throw new Error("Wi-Fi disconnected during connection setup");
      this.nativeEpoch = nativeEventEpoch(result);
      if (this.listenerContext?.active) this.listenerContext.nativeEpoch = this.nativeEpoch;
      this.connected = true;
      this.authenticated = true;
      this.reconnecting = false;
      this.reconnectingCheck = null;
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

  connect(options = {}) {
    if (this.connecting) return this.connecting;
    const attempt = this.openConnection(options);
    const tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = null;
    });
    this.connecting = tracked;
    return tracked;
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
    this.explicitDisconnect = true;
    this.connectionWanted = false;
    this.remembered = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnecting = false;
    this.reconnectingCheck = null;
    this.generation += 1;
    await this.cleanupListeners();
    if (this.wifiBridge) await this.wifiBridge.disconnect();
    this.notifyDisconnectOnce();
  }

  async setRecording(active) {
    const { WifiBridge } = await this.loadPlugins();
    await WifiBridge.setRecording({ active });
  }

  reconcile() {
    if (this.reconciling) return this.reconciling;
    const attempt = this.reconcileOnce();
    const tracked = attempt.finally(() => {
      if (this.reconciling === tracked) this.reconciling = null;
    });
    this.reconciling = tracked;
    return tracked;
  }

  async reconcileConnectionFlight() {
    if (!this.connecting) return null;
    try {
      const device = await this.connecting;
      return { connected: true, reconnected: true, device };
    } catch {
      return { connected: false };
    }
  }

  async reconcileOnce() {
    const generation = this.generation;
    const { WifiBridge } = await this.loadPlugins();
    const status = await WifiBridge.getStatus();

    if (generation !== this.generation) {
      const racedConnect = await this.reconcileConnectionFlight();
      if (racedConnect) return racedConnect;
      return this.connected && this.authenticated
        ? { connected: true, reconnected: false }
        : { connected: false, reconnecting: this.reconnecting };
    }

    const statusEpoch = nativeEventEpoch(status);
    if (status?.reconnecting === true || status?.connecting === true) {
      if (!this.listenerContext?.active || this.listenerContext.generation !== generation) {
        const attached = await this.attachListeners(WifiBridge, generation, statusEpoch);
        if (!attached || generation !== this.generation) return { connected: false, reconnecting: true };
      } else if (statusEpoch !== null) {
        this.listenerContext.nativeEpoch = statusEpoch;
      }
      this.nativeEpoch = statusEpoch ?? this.nativeEpoch;
      this.markReconnecting(this.listenerContext);
      return { connected: false, reconnecting: true };
    }

    if (status?.connected && status?.authenticated) {
      if (!this.listenerContext?.active || this.listenerContext.generation !== generation) {
        const attached = await this.attachListeners(WifiBridge, generation, statusEpoch);
        if (!attached || generation !== this.generation) return { connected: false };
      } else if (statusEpoch !== null) {
        this.listenerContext.nativeEpoch = statusEpoch;
      }
      this.nativeEpoch = statusEpoch ?? this.nativeEpoch;
      this.connected = true;
      this.authenticated = true;
      this.reconnecting = false;
      this.reconnectingCheck = null;
      this.disconnectNotified = false;
      this.connectionMetadata = {
        bootId: status.bootId ?? this.bootId,
        sessionId: status.sessionId ?? this.sessionId,
        seq: status.seq ?? status.lastSeq ?? this.seq,
      };
      Object.assign(this, this.connectionMetadata);
      return { connected: true, reconnected: false };
    }

    const activeConnect = await this.reconcileConnectionFlight();
    if (activeConnect) return activeConnect;

    this.connected = false;
    this.authenticated = false;
    this.reconnecting = false;
    this.reconnectingCheck = null;
    this.generation += 1;
    this.nativeEpoch = statusEpoch;
    await this.cleanupListeners();
    this.notifyDisconnectOnce();

    if (!this.connectionWanted || !this.remembered) return { connected: false };
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
