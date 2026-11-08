package com.maximizotech.sme105dclstudio;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
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
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
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
    private static final Pattern WPA2_PASSWORD_PATTERN = Pattern.compile("^[\\x20-\\x7E]{16,63}$");
    private static final Pattern STA_PASSWORD_PATTERN = Pattern.compile("^[\\x20-\\x7E]{8,63}$");
    private static final int MAX_LINE_BYTES = 16 * 1024;
    private static final int MAX_TIMEOUT_MS = 120_000;
    private static final int WIFI_PROBE_TIMEOUT_MS = 1_500;
    private static final String WRITE_INVALIDATED_MESSAGE =
        "The authenticated Wi-Fi session for this queued write is no longer active. Reconnect and submit a fresh command after checking device state.";
    private static final String WRITE_UNCERTAIN_MESSAGE =
        "The write started but its delivery could not be confirmed. Reconnect and verify device state before deciding whether to send a new command.";

    private final Object stateLock = new Object();
    private final Object secureStorageLock = new Object();
    private final ExecutorService ioExecutor = Executors.newCachedThreadPool();
    private final ExecutorService writeExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "sme105-wifi-bridge-writer");
        thread.setDaemon(true);
        return thread;
    });
    private final List<PluginCall> pendingDisconnectCalls = new ArrayList<>();

    private ConnectAttempt activeAttempt;
    private long nextAttemptGeneration;
    private Socket socket;
    private OutputStream output;
    private boolean connecting;
    private boolean authenticated;
    private boolean disconnecting;
    private String host = "10.77.13.1";
    private String ssid = "SME105_DCL";
    private int port = 8765;
    private String mode = "ap";

    private static final class ConnectAttempt {
        final long generation;
        final Object networkLock = new Object();
        volatile boolean cancelled;
        volatile boolean authenticated;
        volatile boolean networkLost;
        volatile boolean writeInProgress;
        volatile boolean serviceStarted;
        volatile Socket socket;
        volatile ConnectivityManager connectivityManager;
        volatile ConnectivityManager.NetworkCallback networkCallback;

        ConnectAttempt(long generation) {
            this.generation = generation;
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

    @PluginMethod
    public void connect(PluginCall call) {
        String requestedMode = valueOr(call.getString("mode"), "ap").toLowerCase();
        String requestedSsid = valueOr(call.getString("ssid"), "SME105_DCL");
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
            call.reject("SoftAP WPA2 password (16–63 printable ASCII characters) is required");
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
        if (token == null || token.isEmpty()) token = loadToken();
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
            if (connecting || disconnecting || socket != null) {
                call.reject("A Wi-Fi bridge connection is already active");
                return;
            }
            attempt = new ConnectAttempt(++nextAttemptGeneration);
            connecting = true;
            authenticated = false;
            host = requestedHost;
            ssid = requestedSsid;
            port = requestedPort;
            mode = requestedMode;
            activeAttempt = attempt;
        }

        ioExecutor.execute(() -> establishConnection(call, attempt, requestedMode, requestedSsid,
            password, requestedHost, requestedPort, token, connectTimeoutMs, authTimeoutMs));
    }

    private void establishConnection(PluginCall call, ConnectAttempt attempt, String requestedMode,
                                    String requestedSsid, String password, String requestedHost,
                                    int requestedPort, String token, int connectTimeoutMs,
                                    int authTimeoutMs) {
        try {
            Socket candidate;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && requestedMode.equals("ap")) {
                ConnectivityManager manager = getContext().getSystemService(ConnectivityManager.class);
                if (manager == null) throw new IOException("Wi-Fi network service is unavailable");
                Network network = findReachableWifiNetwork(attempt, manager, requestedHost, requestedPort,
                    Math.min(connectTimeoutMs, WIFI_PROBE_TIMEOUT_MS));
                if (network == null) {
                    try {
                        network = requestWifiNetwork(attempt, requestedSsid, password, connectTimeoutMs);
                    } catch (IOException requestError) {
                        network = findReachableWifiNetwork(attempt, manager, requestedHost, requestedPort,
                            Math.min(connectTimeoutMs, WIFI_PROBE_TIMEOUT_MS));
                        if (network == null) throw requestError;
                    }
                }
                candidate = network.getSocketFactory().createSocket();
                attempt.socket = candidate;
                if (attempt.cancelled || attempt.networkLost) throw new IOException("Connection was cancelled");
                candidate.connect(new InetSocketAddress(network.getAllByName(requestedHost)[0], requestedPort), connectTimeoutMs);
            } else {
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
            if (!reply.equals("AUTH OK")) {
                throw new AuthenticationException(redactToken(reply, token));
            }
            candidate.setSoTimeout(0);

            synchronized (stateLock) {
                if (attempt.cancelled || activeAttempt != attempt || attempt.networkLost) {
                    throw new IOException("Connection was cancelled");
                }
                socket = candidate;
                output = candidateOutput;
                authenticated = true;
                connecting = false;
                attempt.authenticated = true;
                startConnectionService();
                attempt.serviceStarted = true;
            }

            call.resolve(statusObject(true));
            startReader(attempt, candidate, candidateInput);
        } catch (AuthenticationException error) {
            failAttempt(attempt);
            call.reject("Authentication failed: " + error.reply);
        } catch (Exception error) {
            failAttempt(attempt);
            call.reject("Could not connect to the SME105 bridge: " + safeMessage(error));
        }
    }

    private Network requestWifiNetwork(ConnectAttempt attempt, String requestedSsid,
                                       String password, int timeoutMs) throws IOException {
        ConnectivityManager manager = getContext().getSystemService(ConnectivityManager.class);
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
                available.countDown();
            }

            @Override public void onUnavailable() {
                failure.compareAndSet(null, "Requested Wi-Fi network is unavailable");
                available.countDown();
            }

            @Override public void onLost(Network network) {
                if (selectedNetwork.compareAndSet(network, null)) {
                    attempt.networkLost = true;
                    Socket pending = attempt.socket;
                    if (pending != null) closeQuietly(pending);
                    if (attempt.authenticated) finishConnection(attempt, "Wi-Fi network disconnected");
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

    private Network findReachableWifiNetwork(ConnectAttempt attempt, ConnectivityManager manager,
                                             String targetHost, int targetPort, int timeoutMs) throws IOException {
        for (Network network : manager.getAllNetworks()) {
            if (attempt.cancelled) return null;
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
            InetAddress[] addresses;
            try {
                addresses = network.getAllByName(targetHost);
            } catch (UnknownHostException ignored) {
                continue;
            }
            for (InetAddress address : addresses) {
                if (attempt.cancelled) return null;
                Socket probe = null;
                try {
                    probe = network.getSocketFactory().createSocket();
                    attempt.socket = probe;
                    if (attempt.cancelled) throw new IOException("Connection was cancelled");
                    probe.connect(new InetSocketAddress(address, targetPort), timeoutMs);
                    return network;
                } catch (IOException ignored) {
                    // Try other addresses or active Wi-Fi networks.
                } finally {
                    if (probe != null) {
                        if (attempt.socket == probe) attempt.socket = null;
                        closeQuietly(probe);
                    }
                }
            }
        }
        return null;
    }

    private void startReader(ConnectAttempt attempt, Socket connectedSocket, InputStream input) {
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
                        JSObject event = new JSObject();
                        event.put("line", content);
                        notifyListeners("line", event);
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
            invalidReason = currentWriteErrorLocked();
            if (invalidReason == null) {
                WriteTicket ticket = new WriteTicket(activeAttempt, socket, output);
                try {
                    // Enqueue under stateLock so concurrent calls keep their invocation order.
                    writeExecutor.execute(() -> performWrite(call, ticket, bytes));
                } catch (RejectedExecutionException error) {
                    invalidReason = "The Wi-Fi bridge writer is shutting down. Reconnect before sending a command.";
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
        ConnectAttempt attempt;
        Socket connectedSocket;
        Socket pendingSocket;
        synchronized (stateLock) {
            pendingDisconnectCalls.add(call);
            if (disconnecting) return;
            disconnecting = true;
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
        if (connectedSocket != null) closeQuietly(connectedSocket);
        if (pendingSocket != null && pendingSocket != connectedSocket) closeQuietly(pendingSocket);
        scheduleSessionCleanup(attempt, true, "Disconnected by client", true);
    }

    private void scheduleSessionCleanup(ConnectAttempt attempt, boolean stopService,
                                       String reason, boolean notifyDisconnect) {
        try {
            // This task is a barrier after all writes that were admitted before revocation.
            writeExecutor.execute(() -> {
                RuntimeException cleanupError = null;
                try {
                    if (attempt != null) releaseNetworkRequest(attempt);
                    if (stopService) stopConnectionService();
                    if (notifyDisconnect) {
                        JSObject event = new JSObject();
                        event.put("reason", reason == null || reason.isEmpty() ? "Connection closed" : reason);
                        notifyListeners("disconnect", event);
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
            });
        } catch (RejectedExecutionException error) {
            List<PluginCall> callsToResolve;
            synchronized (stateLock) {
                if (activeAttempt == null) disconnecting = false;
                callsToResolve = new ArrayList<>(pendingDisconnectCalls);
                pendingDisconnectCalls.clear();
            }
            for (PluginCall disconnectCall : callsToResolve) {
                disconnectCall.reject("Wi-Fi bridge is shutting down before disconnect cleanup completed");
            }
        }
    }

    @PluginMethod
    public void setRecording(PluginCall call) {
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
        String token = loadToken();
        boolean configured = token != null && TOKEN_PATTERN.matcher(token).matches();
        JSObject result = new JSObject();
        result.put("hasToken", configured);
        result.put("configured", configured);
        call.resolve(result);
    }

    @PluginMethod
    public void savePassword(PluginCall call) {
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
                : "SoftAP WPA2 password (16–63 printable ASCII characters) is required");
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
        tokenPreferences().edit().remove(PASSWORD_KEY).apply();
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void hasPassword(PluginCall call) {
        String password = loadPassword();
        boolean configured = isValidStaPassword(password);
        JSObject result = new JSObject();
        result.put("hasPassword", configured);
        result.put("configured", configured);
        call.resolve(result);
    }

    @PluginMethod
    public void clearToken(PluginCall call) {
        tokenPreferences().edit().remove(TOKEN_KEY).apply();
        JSObject result = new JSObject();
        result.put("cleared", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(statusObject(false));
    }

    private JSObject statusObject(boolean connected) {
        JSObject result = new JSObject();
        synchronized (stateLock) {
            result.put("connected", connected || socket != null);
            result.put("host", host);
            result.put("port", port);
            result.put("ssid", ssid);
            result.put("authenticated", authenticated);
            result.put("mode", mode);
        }
        return result;
    }

    private void failAttempt(ConnectAttempt attempt) {
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
            }
            attempt.cancelled = true;
        }
        releaseNetworkRequest(attempt);
        if (attempt.socket != null) closeQuietly(attempt.socket);
        if (connectedSocket != null && connectedSocket != attempt.socket) closeQuietly(connectedSocket);
        if (wasActive) scheduleSessionCleanup(attempt, attempt.serviceStarted, null, false);
    }

    private void finishConnection(ConnectAttempt attempt, String reason) {
        if (attempt == null) return;
        Socket connectedSocket;
        Socket pendingSocket;
        synchronized (stateLock) {
            if (activeAttempt != attempt) return;
            disconnecting = true;
            activeAttempt = null;
            connectedSocket = socket;
            pendingSocket = attempt.socket;
            socket = null;
            output = null;
            authenticated = false;
            connecting = false;
            attempt.cancelled = true;
        }
        if (connectedSocket != null) closeQuietly(connectedSocket);
        if (pendingSocket != null && pendingSocket != connectedSocket) closeQuietly(pendingSocket);
        scheduleSessionCleanup(attempt, true, reason, true);
    }

    private void releaseNetworkRequest(ConnectAttempt attempt) {
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

    private void startConnectionService() {
        Context context = getContext();
        Intent intent = new Intent(context, BridgeConnectionService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
        else context.startService(intent);
    }

    protected void stopConnectionService() {
        Context context = getContext();
        context.stopService(new Intent(context, BridgeConnectionService.class));
    }

    private SharedPreferences tokenPreferences() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private String loadToken() {
        return loadSecret(TOKEN_KEY);
    }

    private String loadPassword() {
        return loadSecret(PASSWORD_KEY);
    }

    private String loadSecret(String key) {
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

    private SecretKey getOrCreateSecureKey() throws GeneralSecurityException, IOException {
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
        ConnectAttempt attempt;
        Socket connectedSocket;
        synchronized (stateLock) {
            attempt = activeAttempt;
            connectedSocket = socket;
            disconnecting = true;
            activeAttempt = null;
            socket = null;
            output = null;
            connecting = false;
            authenticated = false;
            if (attempt != null) attempt.cancelled = true;
        }
        if (attempt != null) {
            releaseNetworkRequest(attempt);
            if (attempt.socket != null) closeQuietly(attempt.socket);
        }
        if (connectedSocket != null) closeQuietly(connectedSocket);
        stopConnectionService();
        writeExecutor.shutdown();
        ioExecutor.shutdownNow();
        super.handleOnDestroy();
    }
}
