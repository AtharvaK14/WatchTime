package com.indie.watchtime;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.indie.watchtime.notify.NotificationBridgePlugin;
import com.indie.watchtime.notify.ReleaseNotifier;
import com.indie.watchtime.widget.WidgetBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate so the bridge picks them up while it
        // builds its plugin registry; registering afterwards is too late.
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(NotificationBridgePlugin.class);
        super.onCreate(savedInstanceState);
        // A tap that cold-started the app. The target is parked now and the
        // web layer drains it as soon as it mounts.
        ReleaseNotifier.handleTapTarget(this, getIntent());
    }

    /**
     * A tap that arrived while the app was already running.
     *
     * MainActivity is singleTask, so the notification's PendingIntent resumes
     * this instance rather than creating one, and the extras come through here.
     * setIntent keeps getIntent() consistent with what was actually delivered;
     * the web layer picks the target up on the resume that follows.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        ReleaseNotifier.handleTapTarget(this, intent);
    }
}
