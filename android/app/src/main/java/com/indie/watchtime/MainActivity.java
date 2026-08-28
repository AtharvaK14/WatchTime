package com.indie.watchtime;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.indie.watchtime.widget.WidgetBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate so the bridge picks it up while it
        // builds its plugin registry; registering afterwards is too late.
        registerPlugin(WidgetBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
