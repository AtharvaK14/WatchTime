package com.indie.watchtime.notify;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web layer's door to the release notifications, matching
 * src/lib/notifications/bridge.ts.
 *
 * Two methods, and neither of them decides anything. WHAT to announce is
 * worked out entirely in TypeScript (src/lib/notifications/events.ts), from
 * rows already in the local database and nothing else - which is what keeps
 * the guarantee that a notification can only ever be about something in the
 * user's library. This side is told the answer and handles WHEN and how it is
 * drawn.
 *
 * There is deliberately no method here that reads library data, and none that
 * posts a notification directly: everything goes through the stored schedule,
 * so "already notified" stays a single source of truth.
 *
 * Permissions are not here either. @capacitor/local-notifications still owns
 * POST_NOTIFICATIONS, and the Settings screen still talks to it; splitting
 * that out would have meant reimplementing a flow that works.
 */
@CapacitorPlugin(name = "ReleaseNotifications")
public class NotificationBridgePlugin extends Plugin {

    @PluginMethod
    public void schedule(PluginCall call) {
        String payload = call.getString("payload");
        if (payload == null) {
            call.reject("payload is required");
            return;
        }
        ReleaseNotifier.store(getContext(), payload);
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        ReleaseNotifier.cancelAll(getContext());
        call.resolve();
    }
}
