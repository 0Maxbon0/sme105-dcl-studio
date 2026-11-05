package com.maximizotech.sme105dclstudio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ExportStoragePlugin.class);
        registerPlugin(BridgeConnectionPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.getWebView().setRendererPriorityPolicy(android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    @Override public void onResume() {
        super.onResume();
        if (bridge != null) bridge.getWebView().evaluateJavascript(
            "window.dispatchEvent(new Event('sme105-native-resume'))", null);
    }
}
