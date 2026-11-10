package com.maximizotech.sme105dclstudio;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "WifiBridge", permissions = {
    @Permission(alias = "nearbyWifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
    @Permission(alias = "wifiLocation", strings = {
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION
    })
})
public class WifiBridgePlugin extends Plugin {
    private static final String PREFS_NAME = "wifi_bridge_secure";
    private static final String TOKEN_KEY = "auth_token";
    private static final String PASSWORD_KEY = "wpa2_password";
    private static final String KEY_ALIAS = "sme105_wifi_bridge_token";
    private static final Pattern TOKEN_PATTERN = Pattern.compile("^[0-9a-fA-F]{32}$");
    private static final Pattern WPA2_PASSWORD_PATTERN = Pattern.compile("^[\\x20-\\x7E]{8,63}$");
    private static final Pattern STA_PASSWORD_PATTERN = Pattern.compile("^[\\x20-\\x7E]{8,63}$");
    private static final Pattern AP_SSID_PATTERN = Pattern.compile("^[\\x20-\\x7E]{1,32}$");
    private static final Pattern PONG_PATTERN = Pattern.compile(
        "^PONG\\s+(\\S+)\\s+boot=(\\S+)\\s+session=(\\S+)\\s+seq=(\\d+)$"
    );
    private static final String DEFAULT_AP_SSID = "SME105-DIRECT-2BF8";
    private static final String AP_AUTH_SALT_PREFIX = "SME105-DCL-AUTH-V1:";
    private static final int MAX_LINE_BYTES = 16 * 1024;
    private static final int MAX_TIMEOUT_MS = 120_000;
    private static final long HEARTBEAT_INTERVAL_MS = 2_000L;
    private static final long HEARTBEAT_STALE_MS = 6_000L;
    private static final long HEARTBEAT_CHECK_INTERVAL_MS = 250L;
    private static final int MAX_QUEUED_WRITES = 32;
    private static final long RECONNECT_MAX_DELAY_MS = 15_000L;
    private static final Random RECONNECT_JITTER = new Random();
    private static final String WRITE_INVALIDATED_MESSAGE =
        "The authenticated Wi-Fi session for this queued write is no longer active. Reconnect and submit a fresh command after checking device state.";
    private static final String WRITE_UNCERTAIN_MESSAGE =
        "The write started but its delivery could not be confirmed. Reconnect and verify device state before deciding whether to send a new command.";

    // These fields intentionally outlive each Capacitor Plugin instance. WebView recreation
    // replaces the listener surface, while this process-owned state retains the native link.
    private static final Object stateLock = new Object();
    private static final Object secureStorageLock = new Object();
    private static volatile WifiBridgePlugin attachedPlugin;
    private static volatile Context appContext;
    private static ExecutorService ioExecutor = newIoExecutor();
    private static ExecutorService writeExecutor = newWriteExecutor();
    private static ScheduledExecutorService reconnectExecutor = newReconnectExecutor();
    private static ScheduledExecutorService heartbeatExecutor = newHeartbeatExecutor();
    private static ScheduledFuture<?> reconnectTask;
    private static final List<PluginCall> pendingDisconnectCalls = new ArrayList<>();

    private static ExecutorService newWriteExecutor() {
        return new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(MAX_QUEUED_WRITES), runnable -> {
                Thread thread = new Thread(runnable, "sme105-wifi-bridge-writer");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.AbortPolicy());
    }

    private static ExecutorService newIoExecutor() {
        return Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "sme105-wifi-bridge-io");
            thread.setDaemon(true);
            return thread;
        });
    }

    private static ScheduledExecutorService newReconnectExecutor() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "sme105-wifi-bridge-reconnect");
            thread.setDaemon(true);
            return thread;
        });
    }

    private static ScheduledExecutorService newHeartbeatExecutor() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "sme105-wifi-bridge-heartbeat-watchdog");
            thread.setDaemon(true);
            return thread;
        });
    }

    private static void ensureExecutorsLocked() {
        if (ioExecutor == null || ioExecutor.isShutdown()) ioExecutor = newIoExecutor();
        if (writeExecutor == null || writeExecutor.isShutdown()) writeExecutor = newWriteExecutor();
        if (reconnectExecutor == null || reconnectExecutor.isShutdown()) reconnectExecutor = newReconnectExecutor();
        if (heartbeatExecutor == null || heartbeatExecutor.isShutdown()) heartbeatExecutor = newHeartbeatExecutor();
    }

    private static ConnectAttempt activeAttempt;
    private static long nextAttemptGeneration;
    private static long socketEpoch;
    private static Socket socket;
    private static OutputStream output;
    private static boolean connecting;
    private static boolean authenticated;
    private static boolean disconnecting;
    private static boolean connectionWanted;
    private static boolean reconnecting;
    private static boolean reconnectScheduled;
    private static int consecutiveReconnectFailures;
    private static int reconnectCount;
    private static long lastHeartbeatRttMs = -1L;
    private static long lastSeq = -1L;
    private static String bootId = "";
    private static String sessionId = "";
    private static String networkState = "unknown";
    private static String host = "10.77.13.1";
    private static String ssid = DEFAULT_AP_SSID;
    private static int port = 8765;
    private static int connectTimeoutMs = 10_000;
    private static int authTimeoutMs = 5_000;
    private static String mode = "ap";

    public WifiBridgePlugin() {
        synchronized (stateLock) {
            ensureExecutorsLocked();
        }
    }

    private static void emit(String eventName, JSObject data) {
        WifiBridgePlugin plugin = attachedPlugin;
        if (plugin != null) plugin.notifyListeners(eventName, data);
    }

    private static void emitError(String reason) {
        JSObject event = new JSObject();
        event.put("error", reason == null ? "Wi-Fi bridge connection failed" : reason);
        emit("error", event);
    }

    private void attachPlugin() {
        Context context;
        try {
            context = getContext();
        } catch (NullPointerException ignored) {
            // Unit constructed plugins have no Capacitor Bridge attached.
            return;
        }
        if (context == null) return;
        synchronized (stateLock) {
            appContext = context.getApplicationContext();
            attachedPlugin = this;
            ensureExecutorsLocked();
        }
    }

    static final class ConnectAttempt {
        final long generation;
        final Object networkLock = new Object();
        final Object writeLock = new Object();
        final Map<String, Long> outstandingPings = new HashMap<>();
        volatile boolean cancelled;
        volatile boolean authenticated;
        volatile boolean networkLost;
        volatile boolean writeInProgress;
        volatile boolean serviceStarted;
        volatile boolean reattempt;
        volatile boolean reconnectedEventPending;
        volatile Network network;
        volatile Network socketNetwork;
        volatile long lastValidPongNanos;
        volatile long lastPingScheduledNanos;
        volatile long nextPingNonce;
        volatile long socketEpoch;
        volatile ScheduledFuture<?> heartbeatTask;
        final AtomicBoolean heartbeatWriteQueued = new AtomicBoolean(false);
        volatile Socket socket;
        volatile ConnectivityManager connectivityManager;
        volatile ConnectivityManager.NetworkCallback networkCallback;

        ConnectAttempt(long generation) {
            this(generation, false);
        }

        ConnectAttempt(long generation, boolean reattempt) {
            this.generation = generation;
            this.reattempt = reattempt;
            this.lastValidPongNanos = System.nanoTime();
        }
    }

    private static final class WriteTicket {
        final ConnectAttempt attempt;
        final long generation;
        final Socket socket;
        final OutputStream output;

        WriteTicket(ConnectAttempt attempt, Socket socket, OutputStream output) {
            this.attempt = attempt;
            this.generation = attempt.generation;
            this.socket = socket;
            this.output = output;
        }
    }

    static final class Pong {
        final String nonce;
        final String bootId;
        final String sessionId;
        final long seq;

        Pong(String nonce, String bootId, String sessionId, long seq) {
            this.nonce = nonce;
            this.bootId = bootId;
            this.sessionId = sessionId;
            this.seq = seq;
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        attachPlugin();
        synchronized (stateLock) {
            if (connecting || disconnecting || reconnecting || reconnectScheduled || socket != null ||
                (connectionWanted && activeAttempt != null)) {
                call.reject("A Wi-Fi bridge connection is already active or reconnecting");
                return;
            }
        }
        String requestedMode = valueOr(call.getString("mode"), "ap").toLowerCase();
        String requestedSsid = valueOr(call.getString("ssid"),
            requestedMode.equals("sta") ? "SME105_DCL" : DEFAULT_AP_SSID);
        String requestedHost = valueOr(call.getString("host"), "10.77.13.1");
        String password = call.getString("password");
        if ((password == null || password.isEmpty()) && requestedMode.equals("ap")) {
            password = loadPassword();
        }
        String token = call.getString("token");
        int requestedPort = call.getInt("port", 8765);
        int connectTimeoutMs = call.getInt("connectTimeoutMs", 10_000);
        int authTimeoutMs = call.getInt("authTimeoutMs", 5_000);

        if (!requestedMode.equals("ap") && !requestedMode.equals("sta")) {
            call.reject("Mode must be ap or sta");
            return;
        }
        if (requestedMode.equals("ap") && !isValidWpa2Password(password)) {
            call.reject("SoftAP WPA2 password (8–63 printable ASCII characters) is required");
            return;
        }
        if (requestedHost.isEmpty() || requestedPort < 1 || requestedPort > 65535) {
            call.reject("Invalid bridge host or port");
            return;
        }
        if (!validTimeout(connectTimeoutMs) || !validTimeout(authTimeoutMs)) {
            call.reject("Connection timeouts must be between 1 and 120000 milliseconds");
            return;
        }
        if (requestedMode.equals("ap")) {
            try {
                // Direct Wi-Fi uses one user-entered password for WPA2 and TCP AUTH.
                // Ignore even a supplied legacy token for SoftAP; its NVS peer derives
                // the identical 16-byte result from the password and exact SSID.
                token = deriveApAuthToken(password, requestedSsid);
            } catch (GeneralSecurityException error) {
                call.reject("Could not derive direct bridge authentication");
                return;
            }
        } else if (token == null || token.isEmpty()) {
            token = loadToken();
        }
        if (token == null || !TOKEN_PATTERN.matcher(token).matches()) {
            call.reject("A valid 32-character authentication token is required");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && requestedMode.equals("ap")) {
            String permissionAlias = wifiPermissionAlias();
            if (getPermissionState(permissionAlias) != PermissionState.GRANTED) {
                requestPermissionForAlias(permissionAlias, call, "wifiPermissionResult");
                return;
            }
        }

        // Reconnect uses only Keystore-backed values. Persist supplied credentials here so
        // the long-lived native owner can recover after the JavaScript instance is replaced.
        try {
            if (requestedMode.equals("ap") && call.getString("password") != null &&
                !call.getString("password").isEmpty()) {
                storeSecret(PASSWORD_KEY, call.getString("password"));
            } else if (requestedMode.equals("sta") && call.getString("token") != null) {
                storeSecret(TOKEN_KEY, token);
            }
        } catch (GeneralSecurityException | IOException error) {
            call.reject("Could not store bridge credentials securely");
            return;
        }

        startConnection(call, requestedMode, requestedSsid, password, requestedHost,
            requestedPort, token, connectTimeoutMs, authTimeoutMs);
    }

    @PermissionCallback
    private void wifiPermissionResult(PluginCall call) {
        String permissionAlias = wifiPermissionAlias();
        if (getPermissionState(permissionAlias) != PermissionState.GRANTED) {
            call.reject("Nearby Wi-Fi permission is required to connect to the SME105 bridge");
            return;
        }
        connect(call);
    }

    private String wifiPermissionAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "nearbyWifi" : "wifiLocation";
    }

    private void startConnection(PluginCall call, String requestedMode, String requestedSsid,
                                 String password, String requestedHost, int requestedPort,
                                 String token, int connectTimeoutMs, int authTimeoutMs) {
        ConnectAttempt attempt;
        synchronized (stateLock) {
            ensureExecutorsLocked();
            if (connecting || disconnecting || reconnecting || reconnectScheduled || socket != null ||
                (connectionWanted && activeAttempt != null)) {
                call.reject("A Wi-Fi bridge connection is already active or reconnecting");
                return;
            }
            connecting = true;
            authenticated = false;
            host = requestedHost;
            ssid = requestedSsid;
            port = requestedPort;
            mode = requestedMode;
            WifiBridgePlugin.connectTimeoutMs = connectTimeoutMs;
            WifiBridgePlugin.authTimeoutMs = authTimeoutMs;
            connectionWanted = true;
            reconnecting = false;
            reconnectScheduled = false;
            consecutiveReconnectFailures = 0;
            reconnectCount = 0;
            lastHeartbeatRttMs = -1L;
            lastSeq = -1L;
            bootId = "";
            sessionId = "";
            activeAttempt = attempt = new ConnectAttempt(++nextAttemptGeneration, false);
        }

        ioExecutor.execute(() -> establishConnection(call, attempt, requestedMode, requestedSsid,
            password, requestedHost, requestedPort, token, connectTimeoutMs, authTimeoutMs));
    }

    private static void establishConnection(PluginCall call, ConnectAttempt attempt, String requestedMode,
                                    String requestedSsid, String password, String requestedHost,
                                    int requestedPort, String token, int connectTimeoutMs,
                                    int authTimeoutMs) {
        try {
            Socket candidate;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && requestedMode.equals("ap")) {
                ConnectivityManager manager = appContext.getSystemService(ConnectivityManager.class);
                if (manager == null) throw new IOException("Wi-Fi network service is unavailable");
                // Never send even a derived AUTH line to an arbitrary Wi-Fi
                // network merely because it happens to expose the bridge IP.
                // Android must select the exact SSID through the system's
                // Wi-Fi network request before this socket may open.
                Network network = requestWifiNetwork(attempt, requestedSsid, password, connectTimeoutMs);
                attempt.network = network;
                attempt.socketNetwork = network;
                candidate = network.getSocketFactory().createSocket();
                attempt.socket = candidate;
                if (attempt.cancelled || attempt.networkLost) throw new IOException("Connection was cancelled");
                candidate.connect(new InetSocketAddress(network.getAllByName(requestedHost)[0], requestedPort), connectTimeoutMs);
            } else if (requestedMode.equals("sta")) {
                Network network = requestDefaultNetwork(attempt);
                attempt.socketNetwork = network;
                candidate = network == null ? new Socket() : network.getSocketFactory().createSocket();
                attempt.socket = candidate;
                if (attempt.cancelled || attempt.networkLost) throw new IOException("Connection was cancelled");
                candidate.connect(new InetSocketAddress(requestedHost, requestedPort), connectTimeoutMs);
            } else {
                WifiManager wifi = appContext != null ? appContext.getSystemService(WifiManager.class) : null;
                WifiInfo info = wifi == null ? null : wifi.getConnectionInfo();
                String currentSsid = info == null ? null : info.getSSID();
                if (currentSsid != null) {
                    if (currentSsid.startsWith("\"") && currentSsid.endsWith("\"") && currentSsid.length() >= 2) {
                        currentSsid = currentSsid.substring(1, currentSsid.length() - 1);
                    }
                }
                if (currentSsid == null || !currentSsid.equals(requestedSsid)) {
                    throw new IOException("Direct SoftAP on Android 9 or lower requires connecting Wi-Fi to " + requestedSsid + " first");
                }
                candidate = new Socket();
                attempt.socket = candidate;
                if (attempt.cancelled || attempt.networkLost) throw new IOException("Connection was cancelled");
                candidate.connect(new InetSocketAddress(requestedHost, requestedPort), connectTimeoutMs);
            }
            if (attempt.cancelled || attempt.networkLost) throw new IOException("Connection was cancelled");
            candidate.setTcpNoDelay(true);
            candidate.setKeepAlive(true);

            candidate.setSoTimeout(authTimeoutMs);
            OutputStream candidateOutput = candidate.getOutputStream();
            InputStream candidateInput = candidate.getInputStream();
            candidateOutput.write(("AUTH " + token + "\n").getBytes(StandardCharsets.UTF_8));
            candidateOutput.flush();

            String reply;
            try {
                reply = readProtocolLine(candidate, candidateInput, authTimeoutMs);
            } catch (SocketTimeoutException timeout) {
                throw new AuthenticationException("timeout");
            } catch (IOException error) {
                throw new AuthenticationException(safeMessage(error));
            }
            if (reply == null) throw new AuthenticationException("connection closed");
            if (!reply.equals("AUTH OK") && !reply.startsWith("AUTH OK ")) {
                throw new AuthenticationException(redactToken(reply, token));
            }
            candidate.setSoTimeout(0);

            synchronized (stateLock) {
                if (attempt.cancelled || activeAttempt != attempt || attempt.networkLost) {
                    throw new IOException("Connection was cancelled");
                }
                socket = candidate;
                output = candidateOutput;
                attempt.socketEpoch = ++socketEpoch;
                authenticated = true;
                connecting = false;
                connectionWanted = true;
                reconnecting = false;
                reconnectScheduled = false;
                consecutiveReconnectFailures = 0;
                networkState = attempt.networkLost ? "lost" : "available";
                attempt.authenticated = true;
                attempt.lastValidPongNanos = System.nanoTime();
                attempt.lastPingScheduledNanos = attempt.lastValidPongNanos;
                BridgeConnectionService.setConnectionWanted(true);
                startConnectionService();
                attempt.serviceStarted = true;
            }

            if (call != null) call.resolve(statusObject(true));
            if (attempt.reattempt) {
                attempt.reconnectedEventPending = true;
            }
            startReader(attempt, candidate, candidateInput);
            startHeartbeat(attempt);
        } catch (AuthenticationException error) {
            if (call != null) {
                emitError("Authentication failed: " + error.reply);
                failAttempt(attempt);
                call.reject("Authentication failed: " + error.reply);
            } else {
                failUnrecoverableReconnect(attempt, "Authentication failed: " + error.reply);
            }
        } catch (Exception error) {
            if (attempt.reattempt) {
                retryReconnect(attempt, safeMessage(error));
            } else {
                emitError("Could not connect to the SME105 bridge: " + safeMessage(error));
                failAttempt(attempt);
                if (call != null) call.reject("Could not connect to the SME105 bridge: " + safeMessage(error));
            }
        }
    }

    private static Network requestWifiNetwork(ConnectAttempt attempt, String requestedSsid,
                                       String password, int timeoutMs) throws IOException {
        ConnectivityManager manager = appContext.getSystemService(ConnectivityManager.class);
        if (manager == null) throw new IOException("Wi-Fi network service is unavailable");

        WifiNetworkSpecifier.Builder specifierBuilder = new WifiNetworkSpecifier.Builder()
            .setSsid(requestedSsid)
            .setWpa2Passphrase(password);
        NetworkRequest request = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifierBuilder.build())
            .build();

        CountDownLatch available = new CountDownLatch(1);
        AtomicReference<Network> selectedNetwork = new AtomicReference<>();
        AtomicReference<String> failure = new AtomicReference<>();
        ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                selectedNetwork.set(network);
                attempt.network = network;
                synchronized (stateLock) { networkState = "available"; }
                available.countDown();
            }

            @Override public void onUnavailable() {
                failure.compareAndSet(null, "Requested Wi-Fi network is unavailable");
                available.countDown();
            }

            @Override public void onLost(Network network) {
                if (selectedNetwork.compareAndSet(network, null)) {
                    handleNetworkLost(attempt, network, "Wi-Fi network disconnected");
                    failure.compareAndSet(null, "Wi-Fi network disconnected");
                    available.countDown();
                }
            }
        };

        try {
            synchronized (attempt.networkLock) {
                if (attempt.cancelled) throw new IOException("Connection was cancelled");
                attempt.connectivityManager = manager;
                attempt.networkCallback = callback;
                manager.requestNetwork(request, callback, timeoutMs);
            }
        } catch (IOException error) {
            throw error;
        } catch (RuntimeException error) {
            releaseNetworkRequest(attempt);
            throw new IOException("Could not request the SME105 Wi-Fi network", error);
        }

        boolean success = false;
        try {
            try {
                if (!available.await(timeoutMs + 1_000L, TimeUnit.MILLISECONDS)) {
                    throw new IOException("Timed out waiting for the SME105 Wi-Fi network");
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while waiting for the SME105 Wi-Fi network", error);
            }
            if (attempt.cancelled) throw new IOException("Connection was cancelled");
            if (attempt.networkLost) throw new IOException("Wi-Fi network disconnected");
            Network network = selectedNetwork.get();
            if (network == null) {
                String reason = failure.get();
                throw new IOException(reason == null ? "Requested Wi-Fi network is unavailable" : reason);
            }
            success = true;
            return network;
        } finally {
            if (!success) releaseNetworkRequest(attempt);
        }
    }

    private static Network requestDefaultNetwork(ConnectAttempt attempt) throws IOException {
        ConnectivityManager manager = appContext.getSystemService(ConnectivityManager.class);
        if (manager == null) throw new IOException("Wi-Fi network service is unavailable");
        Network network = manager.getActiveNetwork();
        if (network == null) throw new IOException("No active network is available");
        ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network available) {
                attempt.network = available;
                synchronized (stateLock) { networkState = "available"; }
            }

            @Override public void onLost(Network lost) {
                handleNetworkLost(attempt, lost, "Wi-Fi network disconnected");
            }
        };
        try {
            synchronized (attempt.networkLock) {
                if (attempt.cancelled) throw new IOException("Connection was cancelled");
                attempt.connectivityManager = manager;
                attempt.networkCallback = callback;
                manager.registerDefaultNetworkCallback(callback);
            }
        } catch (RuntimeException error) {
            releaseNetworkRequest(attempt);
            throw new IOException("Could not monitor the active network", error);
        }
        attempt.network = network;
        synchronized (stateLock) { networkState = "available"; }
        return network;
    }

    private static void handleNetworkLost(ConnectAttempt attempt, Network lost, String reason) {
        if (attempt.socketNetwork != null && lost != null && !attempt.socketNetwork.equals(lost)) return;
        attempt.networkLost = true;
        synchronized (stateLock) { networkState = "lost"; }
        Socket pending = attempt.socket;
        if (pending != null) closeQuietly(pending);
        if (attempt.authenticated) handleTransportFailure(attempt, reason);
    }

    private static void startReader(ConnectAttempt attempt, Socket connectedSocket, InputStream input) {
        Thread reader = new Thread(() -> {
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            try {
                int value;
                while ((value = input.read()) != -1) {
                    if (value == '\n') {
                        byte[] bytes = line.toByteArray();
                        int length = bytes.length;
                        if (length > 0 && bytes[length - 1] == '\r') length--;
                        String content = new String(bytes, 0, length, StandardCharsets.UTF_8);
                        line.reset();
                        if (content.startsWith("PONG ")) {
                            acceptPong(attempt, content);
                            continue;
                        }
                        JSObject event = new JSObject();
                        event.put("line", content);
                        emit("line", event);
                    } else {
                        if (line.size() >= MAX_LINE_BYTES) throw new IOException("Bridge response line exceeded the limit");
                        line.write(value);
                    }
                }
                finishConnection(attempt, "Bridge closed the connection");
            } catch (IOException error) {
                finishConnection(attempt, safeMessage(error));
            }
        }, "sme105-wifi-bridge-reader");
        reader.setDaemon(true);
        reader.start();
    }

    private static void startHeartbeat(ConnectAttempt attempt) {
        synchronized (stateLock) {
            ensureExecutorsLocked();
            if (attempt.cancelled || activeAttempt != attempt) return;
            attempt.heartbeatTask = heartbeatExecutor.scheduleWithFixedDelay(
                () -> {
                    try {
                        heartbeatTick(attempt);
                    } catch (RuntimeException error) {
                        finishConnection(attempt, "Heartbeat watchdog failed: " + safeMessage(error));
                    }
                }, HEARTBEAT_CHECK_INTERVAL_MS,
                HEARTBEAT_CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS);
        }
    }

    static void heartbeatTick(ConnectAttempt attempt) {
        long now = System.nanoTime();
        boolean stale;
        synchronized (stateLock) {
            if (attempt.cancelled || activeAttempt != attempt || !authenticated) return;
            stale = isHeartbeatStale(attempt.lastValidPongNanos, now);
        }
        if (stale) {
            emitDiagnostic("half_open", -1L);
            // This runs independently of writeLock. Closing the socket in finishConnection
            // revokes a blocked OutputStream.write/flush and lets the writer unwind.
            finishConnection(attempt, "Heartbeat expired; bridge socket was stale");
            return;
        }
        if (now - attempt.lastPingScheduledNanos < TimeUnit.MILLISECONDS.toNanos(HEARTBEAT_INTERVAL_MS) ||
            !attempt.heartbeatWriteQueued.compareAndSet(false, true)) return;

        attempt.lastPingScheduledNanos = now;
        try {
            writeExecutor.execute(() -> sendHeartbeat(attempt));
        } catch (RejectedExecutionException ignored) {
            // A full bounded queue drops this ping. The independent stale check remains active.
            attempt.heartbeatWriteQueued.set(false);
        }
    }

    private static void sendHeartbeat(ConnectAttempt attempt) {
        try {
            synchronized (attempt.writeLock) {
                OutputStream currentOutput;
                synchronized (stateLock) {
                    if (attempt.cancelled || activeAttempt != attempt || !authenticated) return;
                    currentOutput = output;
                }
                if (currentOutput == null) throw new IOException("Bridge output stream is unavailable");

                // Firmware accepts only 1–16 alphanumeric characters for a PING nonce.
                String nonce = Long.toString(++attempt.nextPingNonce, 36);
                byte[] ping = ("PING " + nonce + "\n").getBytes(StandardCharsets.UTF_8);
                long sentAt = System.nanoTime();
                synchronized (attempt.outstandingPings) {
                    attempt.outstandingPings.put(nonce, sentAt);
                    while (attempt.outstandingPings.size() > 4) {
                        String oldest = attempt.outstandingPings.keySet().iterator().next();
                        attempt.outstandingPings.remove(oldest);
                    }
                }
                currentOutput.write(ping);
                currentOutput.flush();
            }
        } catch (IOException error) {
            finishConnection(attempt, "Heartbeat write failed: " + safeMessage(error));
        } finally {
            attempt.heartbeatWriteQueued.set(false);
        }
    }

    static boolean isHeartbeatStale(long lastValidPongNanos, long nowNanos) {
        return nowNanos - lastValidPongNanos >= TimeUnit.MILLISECONDS.toNanos(HEARTBEAT_STALE_MS);
    }

    private static void acceptPong(ConnectAttempt attempt, String line) {
        Pong pong = parsePong(line);
        if (pong == null) return;

        long sentAt;
        synchronized (attempt.outstandingPings) {
            Long timestamp = attempt.outstandingPings.remove(pong.nonce);
            if (timestamp == null) return;
            sentAt = timestamp;
        }
        long rttMs = TimeUnit.NANOSECONDS.toMillis(Math.max(0L, System.nanoTime() - sentAt));
        synchronized (stateLock) {
            if (activeAttempt != attempt || !authenticated) return;
            attempt.lastValidPongNanos = System.nanoTime();
            lastHeartbeatRttMs = rttMs;
            bootId = pong.bootId;
            sessionId = pong.sessionId;
            lastSeq = pong.seq;
            networkState = "available";
        }
        if (attempt.reconnectedEventPending) {
            attempt.reconnectedEventPending = false;
            JSObject event = new JSObject();
            event.put("bootId", bootId);
            event.put("sessionId", sessionId);
            event.put("seq", lastSeq);
            event.put("generation", attempt.generation);
            event.put("socketEpoch", attempt.socketEpoch);
            event.put("host", host);
            event.put("port", port);
            event.put("ssid", ssid);
            event.put("mode", mode);
            emit("reconnected", event);
        }
        emitDiagnostic(rttMs <= HEARTBEAT_INTERVAL_MS ? "healthy" : "degraded", rttMs);
    }

    static Pong parsePong(String line) {
        if (line == null) return null;
        java.util.regex.Matcher matcher = PONG_PATTERN.matcher(line);
        if (!matcher.matches()) return null;
        try {
            return new Pong(matcher.group(1), matcher.group(2), matcher.group(3),
                Long.parseLong(matcher.group(4)));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static void emitDiagnostic(String health, long rttMs) {
        if (attachedPlugin == null) return;
        JSObject event = new JSObject();
        synchronized (stateLock) {
            event.put("generation", activeAttempt == null ? nextAttemptGeneration : activeAttempt.generation);
            event.put("bootId", bootId);
            event.put("sessionId", sessionId);
            event.put("lastSeq", lastSeq);
            event.put("heartbeatRttMs", rttMs >= 0 ? rttMs : lastHeartbeatRttMs);
            event.put("reconnectCount", reconnectCount);
            event.put("networkState", networkState);
            event.put("socketEpoch", socketEpoch);
            event.put("attemptInProgress", connecting && activeAttempt != null);
            event.put("connectionWanted", connectionWanted);
            event.put("reconnecting", reconnecting);
            event.put("reconnectScheduled", reconnectScheduled);
        }
        event.put("linkHealth", health);
        addWifiDiagnostics(event);
        emit("diagnostic", event);
    }

    private static void addWifiDiagnostics(JSObject result) {
        try {
            Context context = appContext;
            if (context == null) return;
            WifiManager wifi = context.getSystemService(WifiManager.class);
            WifiInfo info = wifi == null ? null : wifi.getConnectionInfo();
            if (info != null) {
                result.put("rssi", info.getRssi());
                result.put("linkSpeed", info.getLinkSpeed());
                result.put("frequency", info.getFrequency());
            }
        } catch (RuntimeException ignored) {
            // Some Android versions restrict connection details unless location is enabled.
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Missing bridge data");
            return;
        }
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        String invalidReason;
        synchronized (stateLock) {
            ensureExecutorsLocked();
            invalidReason = currentWriteErrorLocked();
            if (invalidReason == null) {
                WriteTicket ticket = new WriteTicket(activeAttempt, socket, output);
                try {
                    // Enqueue under stateLock so concurrent calls keep their invocation order.
                    writeExecutor.execute(() -> performWrite(call, ticket, bytes));
                } catch (RejectedExecutionException error) {
                    invalidReason = "The Wi-Fi bridge write queue is full. Wait for pending commands to finish before sending another command.";
                }
            }
        }
        if (invalidReason != null) call.reject(invalidReason);
    }

    private String currentWriteErrorLocked() {
        ConnectAttempt attempt = activeAttempt;
        Socket currentSocket = socket;
        OutputStream currentOutput = output;
        boolean sessionIdentityValid = attempt != null && currentSocket != null && currentOutput != null;
        boolean authValid = authenticated && attempt != null && attempt.authenticated;
        boolean attemptUsable = attempt != null && !attempt.cancelled && !attempt.networkLost;
        boolean socketUsable = currentSocket != null && currentSocket.isConnected() && !currentSocket.isClosed();
        if (disconnecting || !sessionIdentityValid || !authValid || !attemptUsable || !socketUsable) {
            return "Wi-Fi bridge is not authenticated and connected. Connect before sending a command.";
        }
        return null;
    }

    private void performWrite(PluginCall call, WriteTicket ticket, byte[] bytes) {
        boolean writeStarted = false;
        try {
            String invalidReason;
            synchronized (stateLock) {
                invalidReason = writeTicketErrorLocked(ticket);
                if (invalidReason == null) {
                    // This is the write's admission point. Teardown closes the socket immediately
                    // and drains this executor before reporting disconnect completion.
                    ticket.attempt.writeInProgress = true;
                    writeStarted = true;
                }
            }
            if (invalidReason != null) {
                call.reject(invalidReason);
                return;
            }

            synchronized (ticket.attempt.writeLock) {
                ticket.output.write(bytes);
                synchronized (stateLock) {
                    invalidReason = writeTicketErrorLocked(ticket);
                }
                if (invalidReason != null) {
                    finishConnection(ticket.attempt, "Wi-Fi session ended while a write was in progress");
                    call.reject(WRITE_UNCERTAIN_MESSAGE);
                    return;
                }

                ticket.output.flush();
            }
            synchronized (stateLock) {
                invalidReason = writeTicketErrorLocked(ticket);
            }
            if (invalidReason != null) {
                finishConnection(ticket.attempt, "Wi-Fi session ended while a write was in progress");
                call.reject(WRITE_UNCERTAIN_MESSAGE);
                return;
            }
            call.resolve();
        } catch (IOException error) {
            finishConnection(ticket.attempt, safeMessage(error));
            String message = writeStarted
                ? WRITE_UNCERTAIN_MESSAGE + " I/O error: " + safeMessage(error)
                : "Could not write to the SME105 bridge: " + safeMessage(error);
            call.reject(message);
        } finally {
            if (writeStarted) {
                synchronized (stateLock) {
                    ticket.attempt.writeInProgress = false;
                }
            }
        }
    }

    private String writeTicketErrorLocked(WriteTicket ticket) {
        ConnectAttempt attempt = ticket.attempt;
        Socket currentSocket = socket;
        OutputStream currentOutput = output;
        boolean sameAttempt = activeAttempt == attempt && attempt.generation == ticket.generation;
        boolean authValid = authenticated && attempt.authenticated;
        boolean attemptUsable = !attempt.cancelled && !attempt.networkLost;
        boolean sameStreams = currentSocket == ticket.socket && currentOutput == ticket.output;
        boolean socketUsable = ticket.socket.isConnected() && !ticket.socket.isClosed();

        if (!sameAttempt) return WRITE_INVALIDATED_MESSAGE;
        if (!authValid) return "Wi-Fi bridge authentication is no longer active. Reconnect before sending.";
        if (attempt.cancelled || attempt.networkLost || !attemptUsable) {
            return "The Wi-Fi network or session was lost before this write. Reconnect before sending.";
        }
        if (disconnecting || !sameStreams || !socketUsable) return WRITE_INVALIDATED_MESSAGE;
        return null;
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        attachPlugin();
        ConnectAttempt attempt;
        Socket connectedSocket;
        Socket pendingSocket;
        synchronized (stateLock) {
            ensureExecutorsLocked();
            pendingDisconnectCalls.add(call);
            if (disconnecting) return;
            disconnecting = true;
            connectionWanted = false;
            reconnecting = false;
            reconnectScheduled = false;
            networkState = "disconnected";
            if (reconnectTask != null) reconnectTask.cancel(false);
            reconnectTask = null;
            attempt = activeAttempt;
            connectedSocket = socket;
            pendingSocket = attempt == null ? null : attempt.socket;
            activeAttempt = null;
            socket = null;
            output = null;
            authenticated = false;
            connecting = false;
            if (attempt != null) attempt.cancelled = true;
        }
        cancelHeartbeat(attempt);
        BridgeConnectionService.setConnectionWanted(false);
        if (connectedSocket != null) closeQuietly(connectedSocket);
        if (pendingSocket != null && pendingSocket != connectedSocket) closeQuietly(pendingSocket);
        if (attempt != null) releaseNetworkRequest(attempt);
        try {
            stopConnectionService();
        } catch (RuntimeException ignored) {
            // Socket and reconnect intent are already revoked; service teardown is best-effort.
        }
        scheduleSessionCleanup(null, false, "Disconnected by client", true);
    }

    private void scheduleSessionCleanup(ConnectAttempt attempt, boolean stopService,
                                       String reason, boolean notifyDisconnect) {
        Runnable cleanup = () -> {
                RuntimeException cleanupError = null;
                try {
                    if (attempt != null) releaseNetworkRequest(attempt);
                    if (stopService) stopConnectionService();
                    if (notifyDisconnect) {
                        JSObject event = new JSObject();
                        event.put("reason", reason == null || reason.isEmpty() ? "Connection closed" : reason);
                        emit("disconnect", event);
                    }
                } catch (RuntimeException error) {
                    cleanupError = error;
                }

                List<PluginCall> callsToResolve;
                synchronized (stateLock) {
                    if (activeAttempt == null) disconnecting = false;
                    callsToResolve = new ArrayList<>(pendingDisconnectCalls);
                    pendingDisconnectCalls.clear();
                }
                for (PluginCall disconnectCall : callsToResolve) {
                    if (cleanupError == null) {
                        JSObject result = new JSObject();
                        result.put("disconnected", true);
                        disconnectCall.resolve(result);
                    } else {
                        disconnectCall.reject("Could not complete Wi-Fi disconnect: " + safeMessage(cleanupError));
                    }
                }
        };
        try {
            synchronized (stateLock) {
                ensureExecutorsLocked();
                // Keep completion ordered after admitted writes where queue capacity permits.
                writeExecutor.execute(cleanup);
            }
        } catch (RejectedExecutionException error) {
            // Disconnect has already revoked and closed the socket. Complete directly if the
            // bounded writer queue is full; queued tickets will fail their finite session check.
            cleanup.run();
        }
    }

    @PluginMethod
    public void setRecording(PluginCall call) {
        attachPlugin();
        boolean active = call.getBoolean("active", false);
        boolean updated = BridgeConnectionService.setRecording(active);
        if (!updated && active) {
            call.reject("SME105 bridge connection service is not running");
            return;
        }
        JSObject result = new JSObject();
        result.put("success", updated);
        call.resolve(result);
    }

    @PluginMethod
    public void saveToken(PluginCall call) {
        attachPlugin();
        String token = call.getString("token");
        if (token == null || !TOKEN_PATTERN.matcher(token).matches()) {
            call.reject("Token must contain exactly 32 hexadecimal characters");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecureKey());
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            String storedValue = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                Base64.encodeToString(encrypted, Base64.NO_WRAP);
            tokenPreferences().edit().putString(TOKEN_KEY, storedValue).apply();
        } catch (GeneralSecurityException | IOException error) {
            call.reject("Could not store the token securely");
            return;
        }
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void hasToken(PluginCall call) {
        attachPlugin();
        String token = loadToken();
        boolean configured = token != null && TOKEN_PATTERN.matcher(token).matches();
        JSObject result = new JSObject();
        result.put("hasToken", configured);
        result.put("configured", configured);
        call.resolve(result);
    }

    @PluginMethod
    public void savePassword(PluginCall call) {
        attachPlugin();
        String password = call.getString("password");
        String requestedMode = valueOr(call.getString("mode"), "ap").toLowerCase();
        if (!requestedMode.equals("ap") && !requestedMode.equals("sta")) {
            call.reject("Mode must be ap or sta");
            return;
        }
        boolean valid = requestedMode.equals("sta")
            ? isValidStaPassword(password)
            : isValidWpa2Password(password);
        if (!valid) {
            call.reject(requestedMode.equals("sta")
                ? "STA password (8–63 printable ASCII characters) is required"
                : "SoftAP WPA2 password (8–63 printable ASCII characters) is required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecureKey());
            byte[] encrypted = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
            String storedValue = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                Base64.encodeToString(encrypted, Base64.NO_WRAP);
            tokenPreferences().edit().putString(PASSWORD_KEY, storedValue).apply();
        } catch (GeneralSecurityException | IOException error) {
            call.reject("Could not store the password securely");
            return;
        }
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void clearPassword(PluginCall call) {
        attachPlugin();
        tokenPreferences().edit().remove(PASSWORD_KEY).apply();
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void hasPassword(PluginCall call) {
        attachPlugin();
        String password = loadPassword();
        boolean configured = isValidWpa2Password(password);
        JSObject result = new JSObject();
        result.put("hasPassword", configured);
        result.put("configured", configured);
        call.resolve(result);
    }

    @PluginMethod
    public void clearToken(PluginCall call) {
        attachPlugin();
        tokenPreferences().edit().remove(TOKEN_KEY).apply();
        JSObject result = new JSObject();
        result.put("cleared", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        attachPlugin();
        call.resolve(statusObject(false));
    }

    private static JSObject statusObject(boolean connected) {
        JSObject result = new JSObject();
        synchronized (stateLock) {
            result.put("connected", connected || (socket != null && socket.isConnected() && !socket.isClosed()));
            result.put("host", host);
            result.put("port", port);
            result.put("ssid", ssid);
            result.put("authenticated", authenticated);
            result.put("mode", mode);
            result.put("generation", activeAttempt == null ? nextAttemptGeneration : activeAttempt.generation);
            result.put("attemptGeneration", activeAttempt == null ? nextAttemptGeneration : activeAttempt.generation);
            result.put("attemptInProgress", connecting && activeAttempt != null);
            result.put("connectionWanted", connectionWanted);
            result.put("socketEpoch", socketEpoch);
            result.put("activeSocketEpoch", activeAttempt != null && activeAttempt.authenticated
                ? activeAttempt.socketEpoch : 0L);
            result.put("bootId", bootId);
            result.put("sessionId", sessionId);
            result.put("lastSeq", lastSeq);
            result.put("heartbeatRttMs", lastHeartbeatRttMs);
            result.put("heartbeatRTT", lastHeartbeatRttMs);
            result.put("reconnectCount", reconnectCount);
            result.put("networkState", networkState);
            result.put("reconnecting", reconnecting);
            result.put("reconnectScheduled", reconnectScheduled);
            result.put("connectionState", authenticated ? "connected"
                : reconnecting ? "reconnecting"
                : connecting ? (connectionWanted && reconnectCount > 0 ? "reconnecting" : "connecting")
                : disconnecting ? "disconnecting" : "disconnected");
        }
        result.put("rssi", 0);
        result.put("linkSpeed", 0);
        result.put("frequency", 0);
        addWifiDiagnostics(result);
        return result;
    }

    private static void failAttempt(ConnectAttempt attempt) {
        Socket connectedSocket = null;
        boolean wasActive;
        synchronized (stateLock) {
            wasActive = activeAttempt == attempt;
            if (wasActive) {
                disconnecting = true;
                activeAttempt = null;
                connectedSocket = socket;
                socket = null;
                output = null;
                authenticated = false;
                connecting = false;
                reconnecting = false;
                connectionWanted = false;
                networkState = "disconnected";
            }
            attempt.cancelled = true;
        }
        cancelHeartbeat(attempt);
        releaseNetworkRequest(attempt);
        if (attempt.socket != null) closeQuietly(attempt.socket);
        if (connectedSocket != null && connectedSocket != attempt.socket) closeQuietly(connectedSocket);
        if (wasActive) {
            BridgeConnectionService.setConnectionWanted(false);
            WifiBridgePlugin plugin = attachedPlugin;
            if (plugin != null) plugin.scheduleSessionCleanup(attempt, attempt.serviceStarted, null, false);
            else {
                releaseNetworkRequest(attempt);
                if (attempt.serviceStarted) stopServiceForOwner();
                synchronized (stateLock) {
                    if (activeAttempt == null) disconnecting = false;
                }
            }
        }
    }

    static void finishConnection(ConnectAttempt attempt, String reason) {
        handleTransportFailure(attempt, reason);
    }

    static void setTestConnectionState(ConnectAttempt attempt, Socket activeSocket, boolean isAuthenticated) {
        synchronized (stateLock) {
            activeAttempt = attempt;
            socket = activeSocket;
            authenticated = isAuthenticated;
            connectionWanted = true;
        }
    }

    static void resetTestConnectionState() {
        synchronized (stateLock) {
            activeAttempt = null;
            socket = null;
            output = null;
            authenticated = false;
            connecting = false;
            disconnecting = false;
            reconnecting = false;
            connectionWanted = false;
        }
    }

    static boolean isTestAuthenticated() {
        synchronized (stateLock) {
            return authenticated;
        }
    }

    static ConnectAttempt getTestActiveAttempt() {
        synchronized (stateLock) {
            return activeAttempt;
        }
    }

    private static void handleTransportFailure(ConnectAttempt attempt, String reason) {
        if (attempt == null) return;
        Socket connectedSocket;
        Socket pendingSocket;
        boolean wanted;
        synchronized (stateLock) {
            if (activeAttempt != attempt) return;
            wanted = connectionWanted;
            activeAttempt = null;
            connectedSocket = socket;
            pendingSocket = attempt.socket;
            socket = null;
            output = null;
            authenticated = false;
            connecting = false;
            disconnecting = false;
            reconnecting = wanted;
            networkState = wanted ? "reconnecting" : "disconnected";
            if (!wanted) reconnectScheduled = false;
            attempt.cancelled = true;
        }
        cancelHeartbeat(attempt);
        if (connectedSocket != null) closeQuietly(connectedSocket);
        if (pendingSocket != null && pendingSocket != connectedSocket) closeQuietly(pendingSocket);
        releaseNetworkRequest(attempt);
        if (wanted) {
            if (attachedPlugin != null) {
                JSObject event = new JSObject();
                event.put("reason", reason == null ? "Bridge connection lost" : reason);
                event.put("generation", attempt.generation);
                event.put("socketEpoch", attempt.socketEpoch);
                emit("reconnecting", event);
            }
            emitDiagnostic("reconnecting", -1L);
            scheduleReconnect();
        } else {
            stopServiceForOwner();
            if (attachedPlugin != null) {
                JSObject event = new JSObject();
                event.put("reason", reason == null ? "Bridge connection closed" : reason);
                emit("disconnect", event);
            }
        }
    }

    private static void retryReconnect(ConnectAttempt attempt, String reason) {
        Socket connectedSocket;
        Socket pendingSocket;
        synchronized (stateLock) {
            if (activeAttempt != attempt || !connectionWanted) {
                if (attempt != null && attempt.socket != null) closeQuietly(attempt.socket);
                if (attempt != null) releaseNetworkRequest(attempt);
                return;
            }
            activeAttempt = null;
            connectedSocket = socket;
            pendingSocket = attempt.socket;
            socket = null;
            output = null;
            authenticated = false;
            connecting = false;
            reconnecting = true;
            disconnecting = false;
            networkState = "reconnecting";
            consecutiveReconnectFailures++;
            attempt.cancelled = true;
        }
        cancelHeartbeat(attempt);
        if (connectedSocket != null) closeQuietly(connectedSocket);
        if (pendingSocket != null && pendingSocket != connectedSocket) closeQuietly(pendingSocket);
        releaseNetworkRequest(attempt);
        JSObject event = new JSObject();
        event.put("reason", reason == null ? "Reconnect attempt failed" : reason);
        event.put("generation", attempt.generation);
        event.put("socketEpoch", socketEpoch);
        emit("reconnecting", event);
        emitDiagnostic("reconnecting", -1L);
        scheduleReconnect();
    }

    private static void failUnrecoverableReconnect(ConnectAttempt attempt, String reason) {
        Socket connectedSocket;
        Socket pendingSocket;
        synchronized (stateLock) {
            if (attempt != null && activeAttempt != attempt) {
                if (attempt.socket != null) closeQuietly(attempt.socket);
                releaseNetworkRequest(attempt);
                return;
            }
            if (attempt != null) attempt.cancelled = true;
            connectedSocket = socket;
            pendingSocket = attempt == null ? null : attempt.socket;
            activeAttempt = null;
            socket = null;
            output = null;
            authenticated = false;
            connecting = false;
            disconnecting = false;
            connectionWanted = false;
            reconnecting = false;
            reconnectScheduled = false;
            networkState = "disconnected";
            if (reconnectTask != null) reconnectTask.cancel(false);
            reconnectTask = null;
        }
        cancelHeartbeat(attempt);
        if (connectedSocket != null) closeQuietly(connectedSocket);
        if (pendingSocket != null && pendingSocket != connectedSocket) closeQuietly(pendingSocket);
        if (attempt != null) releaseNetworkRequest(attempt);
        stopServiceForOwner();
        JSObject error = new JSObject();
        error.put("error", reason == null ? "Bridge reconnection failed permanently" : reason);
        emit("error", error);
        JSObject disconnected = new JSObject();
        disconnected.put("reason", reason == null ? "Bridge reconnection failed permanently" : reason);
        emit("disconnect", disconnected);
    }

    private static void scheduleReconnect() {
        long delayMs;
        synchronized (stateLock) {
            if (!connectionWanted || disconnecting || reconnectScheduled || connecting || activeAttempt != null) return;
            ensureExecutorsLocked();
            int exponent = Math.min(consecutiveReconnectFailures, 4);
            long baseDelay = Math.min(1_000L << exponent, RECONNECT_MAX_DELAY_MS);
            long jitterLimit = Math.min(baseDelay / 4L, RECONNECT_MAX_DELAY_MS - baseDelay);
            long jitter = jitterLimit <= 0 ? 0 : Math.floorMod(RECONNECT_JITTER.nextLong(), jitterLimit + 1L);
            delayMs = Math.min(RECONNECT_MAX_DELAY_MS, baseDelay + jitter);
            reconnectScheduled = true;
            reconnectTask = reconnectExecutor.schedule(WifiBridgePlugin::beginReconnect, delayMs, TimeUnit.MILLISECONDS);
        }
    }

    private static void beginReconnect() {
        final String requestedMode;
        final String requestedSsid;
        final String requestedHost;
        final int requestedPort;
        final int connectTimeout;
        final int authTimeout;
        final ConnectAttempt attempt;
        synchronized (stateLock) {
            reconnectScheduled = false;
            reconnectTask = null;
            if (!connectionWanted || disconnecting || connecting || activeAttempt != null) return;
            ensureExecutorsLocked();
            requestedMode = mode;
            requestedSsid = ssid;
            requestedHost = host;
            requestedPort = port;
            connectTimeout = connectTimeoutMs;
            authTimeout = authTimeoutMs;
            attempt = new ConnectAttempt(++nextAttemptGeneration, true);
            activeAttempt = attempt;
            connecting = true;
            authenticated = false;
            reconnecting = true;
            reconnectCount++;
            networkState = "connecting";
        }

        try {
            String password = requestedMode.equals("ap") ? loadSecret(PASSWORD_KEY) : null;
            String token;
            if (requestedMode.equals("ap")) {
                if (!isValidWpa2Password(password)) throw new GeneralSecurityException("Stored WPA2 credentials are unavailable");
                token = deriveApAuthToken(password, requestedSsid);
            } else {
                token = loadSecret(TOKEN_KEY);
                if (token == null || !TOKEN_PATTERN.matcher(token).matches()) {
                    throw new GeneralSecurityException("Stored authentication credentials are unavailable");
                }
            }
            ioExecutor.execute(() -> establishConnection(null, attempt, requestedMode, requestedSsid,
                password, requestedHost, requestedPort, token, connectTimeout, authTimeout));
        } catch (GeneralSecurityException | RejectedExecutionException error) {
            failUnrecoverableReconnect(attempt, safeMessage(error));
        }
    }

    private static void releaseNetworkRequest(ConnectAttempt attempt) {
        ConnectivityManager manager;
        ConnectivityManager.NetworkCallback callback;
        synchronized (attempt.networkLock) {
            manager = attempt.connectivityManager;
            callback = attempt.networkCallback;
            attempt.networkCallback = null;
            attempt.connectivityManager = null;
        }
        if (manager != null && callback != null) {
            try {
                manager.unregisterNetworkCallback(callback);
            } catch (IllegalArgumentException ignored) {
                // The request may already have expired or been released.
            }
        }
    }

    private static void cancelHeartbeat(ConnectAttempt attempt) {
        if (attempt == null) return;
        ScheduledFuture<?> task = attempt.heartbeatTask;
        attempt.heartbeatTask = null;
        if (task != null) task.cancel(false);
    }

    private static void startConnectionService() {
        Context context = appContext;
        if (context == null) return;
        Intent intent = new Intent(context, BridgeConnectionService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
        else context.startService(intent);
    }

    protected void stopConnectionService() {
        Context context = appContext;
        if (context == null) {
            try {
                context = getContext().getApplicationContext();
            } catch (NullPointerException ignored) {
                return;
            }
        }
        BridgeConnectionService.stopIfUnowned(context);
    }

    private static void stopServiceForOwner() {
        BridgeConnectionService.setConnectionWanted(false);
        WifiBridgePlugin plugin = attachedPlugin;
        if (plugin != null) {
            plugin.stopConnectionService();
        } else if (appContext != null) {
            BridgeConnectionService.stopIfUnowned(appContext);
        }
    }

    private static SharedPreferences tokenPreferences() {
        Context context = appContext;
        if (context == null) throw new IllegalStateException("Application context is unavailable");
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String loadToken() {
        return loadSecret(TOKEN_KEY);
    }

    private static String loadPassword() {
        return loadSecret(PASSWORD_KEY);
    }

    private static String loadSecret(String key) {
        String storedValue = tokenPreferences().getString(key, null);
        if (storedValue == null) return null;
        try {
            String[] parts = storedValue.split("\\.", 2);
            if (parts.length != 2) return null;
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecureKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return null;
        }
    }

    private static void storeSecret(String key, String value) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecureKey());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        String storedValue = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
            Base64.encodeToString(encrypted, Base64.NO_WRAP);
        tokenPreferences().edit().putString(key, storedValue).apply();
    }

    private static SecretKey getOrCreateSecureKey() throws GeneralSecurityException, IOException {
        synchronized (secureStorageLock) {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) {
                java.security.Key key = keyStore.getKey(KEY_ALIAS, null);
                if (key instanceof SecretKey) return (SecretKey) key;
                throw new GeneralSecurityException("Stored secure-storage key is invalid");
            }
            KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            keyGenerator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
            return keyGenerator.generateKey();
        }
    }

    private static String readProtocolLine(Socket socket, InputStream input, int timeoutMs) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        int value;
        while (true) {
            long remainingNanos = deadlineNanos - System.nanoTime();
            if (remainingNanos <= 0) throw new SocketTimeoutException("Authentication response timed out");
            int remainingMs = (int) Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
            socket.setSoTimeout(remainingMs);
            value = input.read();
            if (value == -1) return null;
            if (value == '\n') {
                byte[] bytes = line.toByteArray();
                int length = bytes.length;
                if (length > 0 && bytes[length - 1] == '\r') length--;
                return new String(bytes, 0, length, StandardCharsets.UTF_8);
            }
            if (line.size() >= MAX_LINE_BYTES) throw new IOException("Authentication response exceeded the limit");
            line.write(value);
        }
    }

    private static String redactToken(String message, String token) {
        return message.replaceAll("(?i)" + Pattern.quote(token), "[redacted]");
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? "I/O error" : message;
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static boolean validTimeout(int value) {
        return value > 0 && value <= MAX_TIMEOUT_MS;
    }

    private static boolean isValidWpa2Password(String password) {
        return password != null && WPA2_PASSWORD_PATTERN.matcher(password).matches();
    }

    private static boolean isValidStaPassword(String password) {
        return password != null && STA_PASSWORD_PATTERN.matcher(password).matches();
    }

    static String deriveApAuthToken(String password, String ssid) throws GeneralSecurityException {
        if (!isValidWpa2Password(password) || ssid == null || !AP_SSID_PATTERN.matcher(ssid).matches()) {
            throw new GeneralSecurityException("Invalid direct bridge credentials");
        }
        char[] chars = password.toCharArray();
        PBEKeySpec spec = new PBEKeySpec(chars,
            (AP_AUTH_SALT_PREFIX + ssid).getBytes(StandardCharsets.UTF_8), 10_000, 128);
        java.util.Arrays.fill(chars, '\0');
        try {
            byte[] derived = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                .generateSecret(spec).getEncoded();
            try {
                StringBuilder token = new StringBuilder(32);
                for (byte value : derived) {
                    token.append(Character.forDigit((value >>> 4) & 0x0f, 16));
                    token.append(Character.forDigit(value & 0x0f, 16));
                }
                return token.toString();
            } finally {
                java.util.Arrays.fill(derived, (byte) 0);
            }
        } finally {
            spec.clearPassword();
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // Best-effort cleanup.
        }
    }

    private static final class AuthenticationException extends Exception {
        final String reply;
        AuthenticationException(String reply) { this.reply = reply; }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (stateLock) {
            if (attachedPlugin == this) attachedPlugin = null;
            if (connectionWanted && activeAttempt != null && activeAttempt.authenticated &&
                socket != null && !socket.isClosed() && !BridgeConnectionService.isRunning()) {
                startConnectionService();
            }
        }
        // The Activity/WebView and its event listeners are transient. Socket, watchdog,
        // network callback, and reconnect executor belong to the process-level owner.
        super.handleOnDestroy();
    }
}
