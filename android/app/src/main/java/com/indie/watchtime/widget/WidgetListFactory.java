package com.indie.watchtime.widget;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import com.indie.watchtime.R;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Renders the rows of either widget from the stored snapshot.
 *
 * One factory serves both widgets because the two differ only in which array
 * they read and which row layout they inflate; the sizing logic, the poster
 * handling and the tap wiring are identical, and forking them would guarantee
 * they drifted.
 *
 * Sizing is resolved per row, not per widget, from the dimensions the launcher
 * last reported. A widget that is narrow or short renders compact rows, which
 * carry less information rather than the same information clipped - the
 * failure mode a fixed layout would produce at those sizes.
 */
class WidgetListFactory implements RemoteViewsService.RemoteViewsFactory {

    /** Below this width the full row's poster plus three text lines stop fitting legibly. */
    private static final int COMPACT_WIDTH_DP = 200;
    /** Below this height only a couple of rows are visible; compact ones buy another. */
    private static final int COMPACT_HEIGHT_DP = 130;

    private final Context context;
    private final int appWidgetId;
    private final WidgetKind kind;
    private final List<JSONObject> rows = new ArrayList<>();
    private boolean compact;

    WidgetListFactory(Context context, Intent intent) {
        this.context = context.getApplicationContext();
        this.appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,
                AppWidgetManager.INVALID_APPWIDGET_ID);
        this.kind = WidgetKind.fromIntent(intent);
    }

    @Override
    public void onCreate() {}

    @Override
    public void onDataSetChanged() {
        resolveCompact();
        rows.clear();

        JSONArray source = WidgetStore.readRows(context, kind.snapshotField());
        for (int i = 0; i < source.length(); i++) {
            JSONObject row = source.optJSONObject(i);
            if (row != null) rows.add(row);
        }
    }

    /**
     * Reads the size the launcher currently gives this widget. MAX_WIDTH with
     * MIN_HEIGHT is the portrait-orientation pair: the launcher reports a range
     * spanning both orientations, and these two are the bounds that apply in
     * the one the user is almost always looking at.
     */
    private void resolveCompact() {
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            compact = false;
            return;
        }
        Bundle options = AppWidgetManager.getInstance(context).getAppWidgetOptions(appWidgetId);
        if (options == null) {
            compact = false;
            return;
        }
        int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
        int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        // A zero means the launcher has not reported yet; assume the full
        // layout rather than pessimistically degrading a widget we can't measure.
        compact = (width > 0 && width < COMPACT_WIDTH_DP) || (height > 0 && height < COMPACT_HEIGHT_DP);
    }

    @Override
    public void onDestroy() {
        rows.clear();
    }

    @Override
    public int getCount() {
        return rows.size();
    }

    @Override
    public RemoteViews getViewAt(int position) {
        if (position < 0 || position >= rows.size()) return null;
        JSONObject row = rows.get(position);
        RemoteViews views = new RemoteViews(context.getPackageName(), kind.rowLayout(compact));

        views.setTextViewText(R.id.row_show, row.optString("showName"));

        if (kind == WidgetKind.WATCH_NEXT) {
            bindWatchNext(views, row);
        } else {
            bindComingUp(views, row);
        }

        if (!compact) {
            bindPoster(views, row.optString("posterUrl", null));
        }

        // The whole row is the tap target, not just its text: with the
        // per-row watch button gone there is nothing else competing for the
        // touch, and a row with dead zones feels broken. Widget collection
        // items can only carry a fill-in intent; the template lives on the
        // provider side (setPendingIntentTemplate).
        views.setOnClickFillInIntent(R.id.row_root, openIntent(row));

        return views;
    }

    private void bindWatchNext(RemoteViews views, JSONObject row) {
        String label = row.optString("episodeLabel");
        int extra = row.optInt("extraCount", 0);
        // The app renders the "+N" badge inline after the S/E number; matching
        // it here keeps the two readable as the same list.
        views.setTextViewText(R.id.row_episode, extra > 0 ? label + "  +" + extra : label);

        if (!compact) {
            views.setTextViewText(R.id.row_episode_name, row.optString("episodeName"));
            views.setViewVisibility(R.id.row_premiere,
                    row.optBoolean("isPremiere", false) ? View.VISIBLE : View.GONE);
        }
    }

    private void bindComingUp(RemoteViews views, JSONObject row) {
        views.setTextViewText(R.id.row_episode, row.optString("episodeLabel"));
        // Recomputed rather than taken from the snapshot: see WidgetDates.
        views.setTextViewText(R.id.row_date, WidgetDates.relativeLabel(
                row.optString("airDate", null), row.optString("dateLabel")));
        if (!compact) {
            views.setTextViewText(R.id.row_episode_name, row.optString("episodeName"));
        }
    }

    private void bindPoster(RemoteViews views, String posterUrl) {
        Bitmap poster = PosterCache.get(context, posterUrl);
        if (poster != null) {
            views.setImageViewBitmap(R.id.row_poster, poster);
        } else {
            // Leaves the placeholder background visible, matching the app's
            // .poster-placeholder for a title with no artwork.
            views.setImageViewBitmap(R.id.row_poster, null);
        }
    }

    /**
     * Opens this episode's detail overlay. Coming Up rows go read-only: the
     * episode has not aired, so the panel shows the information without
     * offering a watch action it would make no sense to take.
     */
    private Intent openIntent(JSONObject row) {
        Intent intent = new Intent();
        intent.putExtra(WidgetActionReceiver.EXTRA_SHOW_ID, row.optInt("showId"));
        intent.putExtra(WidgetActionReceiver.EXTRA_EPISODE_KEY, row.optString("episodeKey"));
        intent.putExtra(WidgetActionReceiver.EXTRA_READONLY, kind == WidgetKind.COMING_UP);
        return intent;
    }

    @Override
    public RemoteViews getLoadingView() {
        return null; // the default fade is fine and avoids a layout that could mis-size
    }

    @Override
    public int getViewTypeCount() {
        // Compact and full are distinct layouts and the factory can switch
        // between them on a resize, so both must be declared.
        return 2;
    }

    @Override
    public long getItemId(int position) {
        return position;
    }

    @Override
    public boolean hasStableIds() {
        return false;
    }
}
