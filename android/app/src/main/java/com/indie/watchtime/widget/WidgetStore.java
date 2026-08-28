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
 * The reverse direction needs nothing equivalent. A watch recorded from a
 * widget happens in EpisodePanelActivity, whose WebView is same-origin with
 * the app and writes IndexedDB directly, then hands a recomputed snapshot
 * straight back to writeSnapshot() below. There is no queue and no replay.
 */
public final class WidgetStore {

    private static final String PREFS = "watchtime_widgets";
    private static final String KEY_SNAPSHOT = "snapshot";
    private static final String KEY_DEEP_LINK = "pending_deep_link";

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
