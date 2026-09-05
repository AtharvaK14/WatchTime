package com.indie.watchtime.notify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.util.List;

/**
 * Fires the release notifications that have come due.
 *
 * Three ways in, all wanting the same thing:
 *
 *  - the rolling alarm ReleaseNotifier arms;
 *  - BOOT_COMPLETED, because pending alarms do not survive a restart and
 *    without re-arming every future release would be silently dropped;
 *  - MY_PACKAGE_REPLACED, because an app update cancels them too.
 *
 * So there is no branching on the action. deliverDue() posts whatever is now
 * due (skipping anything already notified about, and anything so old that
 * announcing it would be wrong) and re-arms for the next one, which is the
 * correct response to all three.
 */
public class ReleaseAlarmReceiver extends BroadcastReceiver {

    static final String ACTION_DELIVER = "com.indie.watchtime.notify.DELIVER";

    @Override
    public void onReceive(Context context, Intent intent) {
        // The receiver's own context is short-lived; everything downstream
        // touches SharedPreferences and the notification manager, which want
        // the application context.
        final Context app = context.getApplicationContext();

        // Runs on the main thread, and deliberately so: it only touches prefs
        // and posts text, both fast. The notification is on screen before this
        // returns rather than waiting on a poster download.
        final List<ReleaseNotifier.Entry> needArtwork = ReleaseNotifier.deliverDue(app);
        if (needArtwork.isEmpty()) return;

        // Posters are a network fetch and must not happen on this thread.
        // goAsync keeps the receiver alive while a worker loads them and
        // re-posts each notification with its artwork.
        final PendingResult result = goAsync();
        new Thread(() -> {
            try {
                ReleaseNotifier.attachArtwork(app, needArtwork);
            } catch (Exception e) {
                // Offline, a TMDB hiccup, or a decode failure. The
                // notifications are already posted and readable without the
                // poster; losing the artwork must never lose the alert.
            } finally {
                result.finish();
            }
        }, "watchtime-notification-art").start();
    }
}
