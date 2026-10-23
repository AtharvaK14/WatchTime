package com.indie.watchtime.notify;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web layer's door to the release notifications, matching
 * src/lib/notifications/bridge.ts.
 *
 * Three methods, and none of them decides anything. WHAT to announce is
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
 * POST_NOTIFICATIONS, and onboarding and the Settings screen still talk to it;
 * splitting that out would have meant reimplementing a flow that works. The
 * one thing it cannot do is send the user to the system screen once the
 * dialog stops appearing, which is what openSettings() is for.
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

    /**
     * Opens this app's notification settings.
     *
     * Android shows the POST_NOTIFICATIONS dialog a limited number of times;
     * after that a request resolves "denied" with no UI, and the only way to
     * turn notifications on is the system screen. This takes the user there
     * instead of describing the path. Notification settings directly on 8.0+
     * (where channels made that screen exist), the app's info page before it
     * or if a device has no handler for the first.
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Context context = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        } else {
            intent = appDetailsIntent(context);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            try {
                Intent fallback = appDetailsIntent(context);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
                call.resolve();
            } catch (ActivityNotFoundException again) {
                call.reject("No settings screen available");
            }
        }
    }

    private static Intent appDetailsIntent(Context context) {
        return new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.getPackageName(), null)
        );
    }
}
