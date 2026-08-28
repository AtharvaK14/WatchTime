package com.indie.watchtime.widget;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The handoff point between the app and its home-screen widgets.
 *
 * The library lives in IndexedDB inside the WebView, which the launcher
 * process that draws a widget cannot reach. So nothing here queries anything:
 * the web layer serialises what the widgets need (see src/lib/widget/snapshot.ts)
 * and this class stores it in SharedPreferences, which both processes can read.
 *
 * The reverse direction has the same constraint. A "watched" tap arrives in
 * the launcher's process and cannot write to IndexedDB, so it is appended to a
 * queue here and replayed by the web layer on its next run. That asymmetry is
 * inherent to the platform, not a shortcut.
 */
public final class WidgetStore {

    private static final String PREFS = "watchtime_widgets";
    private static final String KEY_SNAPSHOT = "snapshot";
    private static final String KEY_PENDING = "pending_watch_actions";
    private static final String KEY_DEEP_LINK = "pending_deep_link";
    private static final String KEY_HIDDEN_PREFIX = "hidden_";

    /**
     * Snapshot schema this build understands. A snapshot written by a newer web
     * layer is ignored rather than half-parsed, so the widget keeps showing the
     * last payload it could read instead of going blank during the window
     * between a web update and a native one.
     */
    public static final int SUPPORTED_VERSION = 1;

    private WidgetStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---- Snapshot ---------------------------------------------------------

    public static void writeSnapshot(Context context, String json) {
        prefs(context).edit().putString(KEY_SNAPSHOT, json).apply();
        // A fresh snapshot supersedes every optimistic hide: the rows it
        // contains are what the database now actually says.
        clearHidden(context);
    }

    /** The stored snapshot, or null when there is none or it is a version we cannot read. */
    public static JSONObject readSnapshot(Context context) {
        String raw = prefs(context).getString(KEY_SNAPSHOT, null);
        if (raw == null) return null;
        try {
            JSONObject snapshot = new JSONObject(raw);
            if (snapshot.optInt("version", -1) != SUPPORTED_VERSION) return null;
            return snapshot;
        } catch (JSONException e) {
            return null;
        }
    }

    /** The named row array from the snapshot, never null. */
    public static JSONArray readRows(Context context, String field) {
        JSONObject snapshot = readSnapshot(context);
        if (snapshot == null) return new JSONArray();
        JSONArray rows = snapshot.optJSONArray(field);
        return rows == null ? new JSONArray() : rows;
    }

    // ---- Optimistic hiding ------------------------------------------------
    //
    // Ticking an episode on the widget has to remove that row immediately -
    // waiting for the app to next launch and push a new snapshot would leave a
    // watched episode sitting in Watch Next for hours. The key is remembered
    // per widget family and cleared as soon as a real snapshot arrives, so the
    // hide is only ever a short-lived overlay on top of the true data.

    public static void hideRow(Context context, String episodeKey) {
        String existing = prefs(context).getString(KEY_HIDDEN_PREFIX + "keys", "");
        if (existing.contains("\n" + episodeKey + "\n")) return;
        String updated = existing.isEmpty() ? "\n" + episodeKey + "\n" : existing + episodeKey + "\n";
        prefs(context).edit().putString(KEY_HIDDEN_PREFIX + "keys", updated).apply();
    }

    public static boolean isHidden(Context context, String episodeKey) {
        String existing = prefs(context).getString(KEY_HIDDEN_PREFIX + "keys", "");
        return existing.contains("\n" + episodeKey + "\n");
    }

    private static void clearHidden(Context context) {
        prefs(context).edit().remove(KEY_HIDDEN_PREFIX + "keys").apply();
    }

    // ---- Pending watch actions -------------------------------------------

    /** Queues a widget-originated watch for the web layer to replay. */
    public static void queueWatchAction(Context context, String episodeKey, int showId,
                                        int seasonNumber, int episodeNumber) {
        try {
            JSONArray queue = readPendingActions(context);
            JSONObject action = new JSONObject();
            action.put("episodeKey", episodeKey);
            action.put("showId", showId);
            action.put("seasonNumber", seasonNumber);
            action.put("episodeNumber", episodeNumber);
            // The tap time, not the replay time: the app records the watch at
            // this instant so Watch Next ordering reflects what the user did.
            action.put("tappedAt", System.currentTimeMillis());
            queue.put(action);
            prefs(context).edit().putString(KEY_PENDING, queue.toString()).apply();
        } catch (JSONException e) {
            // A malformed entry is not worth losing the queue over.
        }
    }

    public static JSONArray readPendingActions(Context context) {
        String raw = prefs(context).getString(KEY_PENDING, null);
        if (raw == null) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Reads and clears the queue in one step, so a replay can never double-apply. */
    public static JSONArray takePendingActions(Context context) {
        JSONArray queue = readPendingActions(context);
        prefs(context).edit().remove(KEY_PENDING).apply();
        return queue;
    }

    // ---- Deep links -------------------------------------------------------
    //
    // Stored rather than delivered as an event because a widget tap can cold-
    // start the app, in which case there is no JavaScript alive to receive one.
    // The web layer reads this at mount and on every resume.

    public static void setPendingDeepLink(Context context, String json) {
        prefs(context).edit().putString(KEY_DEEP_LINK, json).apply();
    }

    public static JSONObject takePendingDeepLink(Context context) {
        String raw = prefs(context).getString(KEY_DEEP_LINK, null);
        if (raw == null) return null;
        prefs(context).edit().remove(KEY_DEEP_LINK).apply();
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }
}
