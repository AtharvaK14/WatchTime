package com.indie.watchtime.stream;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

/**
 * Opens a streaming service on the title the user is looking at.
 *
 * This is the one implementation of that, shared by the two places the web
 * layer can ask from: StreamingLauncherPlugin (the app, over Capacitor) and
 * EpisodePanelActivity's injected host (the widget's episode overlay, which is
 * not a Capacitor activity and has no plugins at all). They are different
 * doors into the same room deliberately - a capsule tapped in the overlay has
 * to behave exactly like the same capsule tapped in the app, and the only way
 * to guarantee that is for there to be nothing to keep in sync.
 *
 * It exists at all because only the platform can answer the question the web
 * layer actually needs answered: is this app here? A link cannot ask that.
 * Capacitor's own handling of an external URL is a single
 * startActivity(ACTION_VIEW) whose ActivityNotFoundException is swallowed, so
 * a tap on a service the user does not have produces nothing whatsoever -
 * the dead end this whole feature is meant to avoid.
 *
 * The ladder, in order, and the outcome each rung reports back:
 *
 *   1. "app"    the service's app is installed: open it, on the title's URL
 *               where the app claims that URL, and at its own front door where
 *               it does not
 *   2. "store"  the service names an app and it is NOT installed: its Play
 *               Store listing
 *   3. "web"    no app named, or nothing above worked: whatever handles the
 *               URL, normally the browser
 *   4. "failed" nothing on the device would take it
 *
 * Order is the whole design. Trying the browser before the store would mean
 * the store rung never ran (a browser always exists), and trying the store
 * before checking installation would send people who HAVE the app to a listing
 * for something they already own.
 *
 * Nothing here is service-specific: every service arrives as a (url, package)
 * pair from src/lib/streaming/registry.ts, which is the only place that knows
 * the difference between Netflix and Crunchyroll. Adding a service is an entry
 * in that file and no change here.
 */
public final class StreamingLauncher {

    public static final String OUTCOME_APP = "app";
    public static final String OUTCOME_STORE = "store";
    public static final String OUTCOME_WEB = "web";
    public static final String OUTCOME_FAILED = "failed";

    private StreamingLauncher() {}

    /**
     * @param context     any context; the activity's when there is one, so the
     *                    launch is attributed to the visible task
     * @param url         the service's web address for this title
     * @param packageName the service's Android app, or null when it has none
     * @return one of the OUTCOME_* values above
     */
    public static String launch(Context context, Uri url, String packageName) {
        if (packageName != null && !packageName.isEmpty()) {
            if (isInstalled(context, packageName)) {
                // The app has the title's URL. Most services register theirs as
                // App Links, so this lands inside the app on the title.
                if (start(context, new Intent(Intent.ACTION_VIEW, url).setPackage(packageName))) {
                    return OUTCOME_APP;
                }
                // Installed but it does not claim this URL. Its front door is
                // the best remaining app-level destination, and still better
                // than bouncing a subscriber out to a browser.
                Intent launcher = context.getPackageManager().getLaunchIntentForPackage(packageName);
                if (launcher != null && start(context, launcher)) return OUTCOME_APP;
            } else if (start(context, new Intent(Intent.ACTION_VIEW, storeUri(packageName)))
                    || start(context, new Intent(Intent.ACTION_VIEW, storeWebUri(packageName)))) {
                // market:// first so an installed Play Store opens directly;
                // the https form covers devices without it, where the listing
                // still opens in a browser.
                return OUTCOME_STORE;
            }
        }

        // No app named, or every app route declined. An implicit view of an
        // https URL is the one thing practically every Android device can do.
        if (start(context, new Intent(Intent.ACTION_VIEW, url))) return OUTCOME_WEB;
        return OUTCOME_FAILED;
    }

    /** Convenience for callers holding a JSON `{"url":…,"packageName":…}` payload. */
    public static String launchFromJson(Context context, String json) {
        try {
            org.json.JSONObject request = new org.json.JSONObject(json);
            String url = request.optString("url", "");
            if (url.isEmpty()) return OUTCOME_FAILED;
            String packageName = request.optString("packageName", null);
            return launch(context, Uri.parse(url), packageName);
        } catch (org.json.JSONException e) {
            return OUTCOME_FAILED;
        }
    }

    /**
     * Whether the package is present.
     *
     * On Android 11+ this is only answerable for packages this app declares in
     * its <queries> block - anything else reads as not installed however
     * present it is. The manifest therefore lists exactly the packages the
     * registry names, and the two have to be kept in step: a package added to
     * the registry but not to the manifest would send users who have that app
     * to a store listing instead of opening it.
     */
    private static boolean isInstalled(Context context, String packageName) {
        try {
            context.getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private static Uri storeUri(String packageName) {
        return Uri.parse("market://details?id=" + packageName);
    }

    private static Uri storeWebUri(String packageName) {
        return Uri.parse("https://play.google.com/store/apps/details?id=" + packageName);
    }

    /**
     * Starts an activity, reporting whether it went anywhere rather than
     * throwing.
     *
     * The caller needs "did that work" to choose its next rung, and a failure
     * here is an ordinary outcome (the app is not there, the URL is not
     * claimed) rather than an error worth propagating into the UI.
     */
    private static boolean start(Context context, Intent intent) {
        // Required when the context is not an Activity, harmless when it is:
        // the streaming app belongs in its own task, not stacked inside ours.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }
}
