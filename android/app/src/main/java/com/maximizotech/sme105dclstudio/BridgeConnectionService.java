package com.maximizotech.sme105dclstudio;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.*;

/** Keeps an operator-established SME105 bridge link alive while the activity is hidden. */
public class BridgeConnectionService extends Service {
    private static final String CHANNEL = "sme105_bridge";
    private static final int NOTICE = 105;
    private static volatile BridgeConnectionService instance;
    private static volatile boolean wifiConnectionWanted;
    private static volatile boolean bluetoothConnectionWanted;
    private static volatile boolean recording;
    private PowerManager.WakeLock wakeLock;

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Bridge connection", NotificationManager.IMPORTANCE_LOW));
        wakeLock = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sme105:recording");
        wakeLock.setReferenceCounted(false);
    }
    public static boolean isRunning() { return instance != null; }
    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("SME105 DCL bridge connection")
            .setContentText(recording ? "Recording continues over Wi-Fi or BLE" : "Wi-Fi or BLE connection kept ready · tap to return")
            .setContentIntent(pending).setOngoing(true).setOnlyAlertOnce(true).build();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(NOTICE, notification());
        // A disconnect can race an asynchronous startForegroundService request.
        if (!shouldKeepRunning()) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (recording && wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(4 * 60 * 60 * 1000L);
        return START_NOT_STICKY;
    }
    /** Wi-Fi bridge ownership is controlled by WifiBridgePlugin. */
    public static void setConnectionWanted(boolean wanted) { wifiConnectionWanted = wanted; }
    /** BLE bridge ownership is controlled independently by BridgeConnectionPlugin. */
    public static void setBluetoothConnectionWanted(boolean wanted) { bluetoothConnectionWanted = wanted; }
    public static boolean isConnectionWanted() { return wifiConnectionWanted || bluetoothConnectionWanted; }
    public static boolean isRecording() { return recording; }

    private static boolean shouldKeepRunning() {
        return isConnectionWanted() || recording;
    }

    public static void stopIfUnowned(Context context) {
        if (context == null || shouldKeepRunning()) return;
        Context app = context.getApplicationContext();
        app.stopService(new Intent(app, BridgeConnectionService.class));
    }

    public static boolean setRecording(boolean active) {
        BridgeConnectionService service = instance;
        if (service == null) return false;
        service.recording = active;
        if (active && !service.wakeLock.isHeld()) service.wakeLock.acquire(4 * 60 * 60 * 1000L);
        if (!active && service.wakeLock.isHeld()) service.wakeLock.release();
        // Update the existing foreground-service notification through the same
        // API used at startup; no extra POST_NOTIFICATIONS permission is needed.
        if (Build.VERSION.SDK_INT >= 29) service.startForeground(NOTICE, service.notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else service.startForeground(NOTICE, service.notification());
        if (!active) stopIfUnowned(service);
        return true;
    }
    @Override public void onTaskRemoved(Intent rootIntent) {
        if (!shouldKeepRunning()) stopSelf();
    }
    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        instance = null;
        if (shouldKeepRunning()) {
            Context app = getApplicationContext();
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (!shouldKeepRunning()) return;
                Intent restart = new Intent(app, BridgeConnectionService.class);
                try {
                    if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(restart);
                    else app.startService(restart);
                } catch (RuntimeException ignored) {
                    // The process-owned socket remains valid even if Android declines a service restart.
                }
            }, 250L);
        }
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
