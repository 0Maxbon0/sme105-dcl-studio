package com.maximizotech.sme105dclstudio;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BridgeConnection")
public class BridgeConnectionPlugin extends Plugin {
    @PluginMethod public void start(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), BridgeConnectionService.class);
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent);
            else getContext().startService(intent);
            call.resolve();
        } catch (Exception error) { call.reject("Cannot protect Bluetooth connection: " + error.getMessage(), error); }
    }
    @PluginMethod public void setRecording(PluginCall call) {
        boolean active = call.getBoolean("active", false);
        // startForegroundService is asynchronous; schedule this update on the main
        // queue after service creation, rather than racing it on the plugin thread.
        getActivity().runOnUiThread(() -> {
            if (!BridgeConnectionService.setRecording(active) && active) call.reject("Bluetooth connection service is not running");
            else call.resolve();
        });
    }
    @PluginMethod public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), BridgeConnectionService.class));
        call.resolve();
    }
    @Override protected void handleOnDestroy() {
        getContext().stopService(new Intent(getContext(), BridgeConnectionService.class));
    }
}
