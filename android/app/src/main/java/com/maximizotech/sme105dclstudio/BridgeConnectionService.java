package com.maximizotech.sme105dclstudio;

import android.app.*;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.*;

/** Keeps an operator-established SME105 bridge link alive while the activity is hidden. */
public class BridgeConnectionService extends Service {
    private static final String CHANNEL = "sme105_bridge";
    private static final int NOTICE = 105;
    private static BridgeConnectionService instance;
    private PowerManager.WakeLock wakeLock;
    private boolean recording;

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Bridge connection", NotificationManager.IMPORTANCE_LOW));
        wakeLock = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sme105:recording");
        wakeLock.setReferenceCounted(false);
    }
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
        return START_NOT_STICKY;
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
        return true;
    }
    @Override public void onTaskRemoved(Intent rootIntent) { stopSelf(); }
    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        instance = null;
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
