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

    // ---- Appearance ------------------------------------------------------
    //
    // Background opacity is per widget INSTANCE, keyed by appWidgetId: someone
    // may want a solid Up Next widget on one screen and a barely-there Coming
    // Up widget over a photo wallpaper on another.
    //
    // It is applied only to the widget_bg layer (see widget_container.xml), so
    // the list, its text, its artwork and its separators are never affected by
    // it, whatever the user picks.

    /** Percent, 0 (invisible background) to 100 (solid). */
    public static final int DEFAULT_OPACITY = 95;

    private static String opacityKey(int appWidgetId) {
        return "opacity_" + appWidgetId;
    }

    public static int getOpacity(Context context, int appWidgetId) {
        int stored = prefs(context).getInt(opacityKey(appWidgetId), DEFAULT_OPACITY);
        return Math.max(0, Math.min(100, stored));
    }

    public static void setOpacity(Context context, int appWidgetId, int percent) {
        prefs(context).edit().putInt(opacityKey(appWidgetId), Math.max(0, Math.min(100, percent))).apply();
    }

    /** Forgets a removed widget's setting so ids recycled by the launcher start clean. */
    public static void clearOpacity(Context context, int appWidgetId) {
        prefs(context).edit().remove(opacityKey(appWidgetId)).apply();
    }

    /**
     * 0-100 percent as the 0..1 fraction View.setAlpha takes.
     *
     * setAlpha is used rather than ImageView.setImageAlpha because RemoteViews
     * can only invoke methods the framework marks @RemotableViewMethod, and
     * View.setAlpha is the long-established one for exactly this job.
     */
    public static float opacityToAlpha(int percent) {
        return Math.max(0, Math.min(100, percent)) / 100f;
    }

    // ---- Appearance settings, per widget -----------------------------------
    // Each placed widget has its own, set in WidgetConfigActivity. Every
    // default reproduces the widget as it looked before the setting existed,
    // so a widget placed earlier is unchanged until the user edits it.

    /** Background colours: the app's background, true black, and its raised grey. */
    public static final int BG_DARK = 0, BG_BLACK = 1, BG_GREY = 2;
    /** Corner radii: 8dp, 16dp (the original), 28dp (One UI's widget rounding). */
    public static final int CORNERS_SMALL = 0, CORNERS_MEDIUM = 1, CORNERS_LARGE = 2;
    /** Text sizes: 90%, 100%, 115% of each view's own size. */
    public static final int TEXT_SMALL = 0, TEXT_DEFAULT = 1, TEXT_LARGE = 2;

    public static int getBackground(Context c, int id) { return clamp(prefs(c).getInt("bg_" + id, BG_DARK), 0, 2); }
    public static int getCorners(Context c, int id) { return clamp(prefs(c).getInt("corners_" + id, CORNERS_MEDIUM), 0, 2); }
    public static int getTextSize(Context c, int id) { return clamp(prefs(c).getInt("text_" + id, TEXT_DEFAULT), 0, 2); }
    /** Compact rows everywhere, not only when the widget is too small for full ones. */
    public static boolean getCompact(Context c, int id) { return prefs(c).getBoolean("compact_" + id, false); }
    /** The title and count above the list. Still hidden when the widget is too short for it. */
    public static boolean getShowHeader(Context c, int id) { return prefs(c).getBoolean("header_" + id, true); }
    /** Posters in full rows. */
    public static boolean getShowArtwork(Context c, int id) { return prefs(c).getBoolean("artwork_" + id, true); }

    public static void saveAppearance(Context c, int id, int background, int corners, int textSize,
                                      boolean compact, boolean showHeader, boolean showArtwork) {
        prefs(c).edit()
                .putInt("bg_" + id, background)
                .putInt("corners_" + id, corners)
                .putInt("text_" + id, textSize)
                .putBoolean("compact_" + id, compact)
                .putBoolean("header_" + id, showHeader)
                .putBoolean("artwork_" + id, showArtwork)
                .apply();
    }

    /** Everything stored for a widget, when it is removed from the home screen. */
    public static void clearAll(Context c, int id) {
        prefs(c).edit()
                .remove(opacityKey(id))
                .remove("bg_" + id)
                .remove("corners_" + id)
                .remove("text_" + id)
                .remove("compact_" + id)
                .remove("header_" + id)
                .remove("artwork_" + id)
                .apply();
    }

    public static int backgroundColor(int background) {
        switch (background) {
            case BG_BLACK: return 0xFF000000;
            case BG_GREY: return 0xFF1D1D20;
            default: return 0xFF0A0A0B;
        }
    }

    public static int backgroundDrawable(int corners) {
        switch (corners) {
            case CORNERS_SMALL: return com.indie.watchtime.R.drawable.widget_background_small;
            case CORNERS_LARGE: return com.indie.watchtime.R.drawable.widget_background_large;
            default: return com.indie.watchtime.R.drawable.widget_background;
        }
    }

    public static float textScale(int textSize) {
        switch (textSize) {
            case TEXT_SMALL: return 0.9f;
            case TEXT_LARGE: return 1.15f;
            default: return 1f;
        }
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
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
