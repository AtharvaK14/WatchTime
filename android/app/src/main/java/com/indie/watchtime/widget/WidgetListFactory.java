package com.indie.watchtime.widget;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.text.SpannableStringBuilder;
import android.util.TypedValue;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.graphics.Typeface;
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
    /** The widget's Artwork setting (WidgetStore), read with the data. */
    private boolean showArtwork = true;
    /** The widget's Text size setting, as a factor on each view's own size. */
    private float textScale = 1f;

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
        // Appearance settings first: a change on the settings screen ends in
        // notifyAppWidgetViewDataChanged, which lands here.
        if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
            showArtwork = WidgetStore.getShowArtwork(context, appWidgetId);
            textScale = WidgetStore.textScale(WidgetStore.getTextSize(context, appWidgetId));
        }
        resolveCompact();
        // The Compact rows setting: compact everywhere, not only when small.
        if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID && WidgetStore.getCompact(context, appWidgetId)) {
            compact = true;
        }
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

        switch (kind) {
            case WATCH_NEXT:
                views.setTextViewText(R.id.row_show, row.optString("showName"));
                bindWatchNext(views, row);
                break;
            case COMING_UP:
                views.setTextViewText(R.id.row_show, row.optString("showName"));
                bindComingUp(views, row);
                break;
            case MOVIES_TO_WATCH:
                views.setTextViewText(R.id.row_show, row.optString("title"));
                bindMovie(views, row);
                break;
            case MOVIE_RELEASES:
                views.setTextViewText(R.id.row_show, row.optString("title"));
                bindMovieRelease(views, row);
                break;
        }

        if (!compact) {
            if (showArtwork) {
                views.setViewVisibility(R.id.row_poster, View.VISIBLE);
                bindPoster(views, row.optString("posterUrl", null));
            } else {
                views.setViewVisibility(R.id.row_poster, View.GONE);
            }
        }
        applyTextScale(views);

        // The whole row opens the episode; the tick at its end marks it
        // watched without opening anything. Widget collection items can only
        // carry fill-in intents; the template lives on the provider side
        // (setPendingIntentTemplate). Both go to EpisodePanelActivity, which
        // is what can write the app's database: the tick's extra makes it do
        // the write, show a one-line confirmation and close by itself.
        views.setOnClickFillInIntent(R.id.row_root, openIntent(row));
        if (kind.hasTick()) {
            bindWatchedPhase(views, row.optString("watchedPhase", ""));
            Intent mark = openIntent(row);
            mark.putExtra(EpisodePanelActivity.EXTRA_MARK_WATCHED, true);
            views.setOnClickFillInIntent(R.id.row_tick, mark);
        }

        return views;
    }

    /**
     * The moment after a row's tick is tapped (see QuickMarkWatched.tsx): the
     * app's green veil over the row with the white tick ("next": the show has
     * another episode) or "That's all folks!" ("done"). The page pushes this
     * state first and the real Up Next about a second later, so the row
     * confirms the watch before it moves on, instead of vanishing. Always set
     * explicitly: the launcher may reuse a row view that was showing it.
     */
    private void bindWatchedPhase(RemoteViews views, String phase) {
        boolean shown = "next".equals(phase) || "done".equals(phase);
        views.setViewVisibility(R.id.row_watched, shown ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.row_watched_tick, "done".equals(phase) ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.row_watched_folks, "done".equals(phase) ? View.VISIBLE : View.GONE);
    }

    /** Plain text in a row view whose layout sets a monospace face for episode codes. */
    private static CharSequence sans(String text) {
        SpannableStringBuilder b = new SpannableStringBuilder(text);
        b.setSpan(new TypefaceSpan("sans-serif"), 0, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return b;
    }

    /**
     * A watchlist movie in the Up Next row: title, "2024 · 2h 15m" where the
     * episode line goes, and the TMDB rating with its gold star on the meta
     * line (the app's rating chip, as text).
     */
    private void bindMovie(RemoteViews views, JSONObject row) {
        String meta = row.optString("meta");
        String rating = row.optString("rating");
        if (compact) {
            String line = rating.isEmpty() ? meta : (meta.isEmpty() ? "★ " + rating : meta + " · ★ " + rating);
            views.setTextViewText(R.id.row_episode, sans(line));
            return;
        }
        SpannableStringBuilder line = new SpannableStringBuilder(meta);
        line.setSpan(new ForegroundColorSpan(context.getColor(R.color.widget_text_2)), 0, line.length(),
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        views.setTextViewText(R.id.row_episode, line);
        if (rating.isEmpty()) {
            views.setViewVisibility(R.id.row_meta, View.GONE);
        } else {
            SpannableStringBuilder chip = new SpannableStringBuilder("★ " + rating);
            chip.setSpan(new ForegroundColorSpan(context.getColor(R.color.widget_rating_star)), 0, 1,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            views.setTextViewText(R.id.row_meta, chip);
            views.setViewVisibility(R.id.row_meta, View.VISIBLE);
        }
    }

    /** A movie release in the Coming Up row: title, "In Theaters", and the date. */
    private void bindMovieRelease(RemoteViews views, JSONObject row) {
        String label = row.optString("releaseLabel");
        views.setTextViewText(R.id.row_episode, sans(label));
        views.setViewVisibility(R.id.row_episode, label.isEmpty() ? View.GONE : View.VISIBLE);
        views.setTextViewText(R.id.row_date, WidgetDates.relativeLabel(
                row.optString("releaseDate", null), row.optString("dateLabel")));
        if (!compact) views.setViewVisibility(R.id.row_episode_name, View.GONE);
    }

    private void bindWatchNext(RemoteViews views, JSONObject row) {
        String label = row.optString("episodeLabel");
        int extra = row.optInt("extraCount", 0);

        if (compact) {
            // One line only: the code, and the count of what is waiting after it.
            views.setTextViewText(R.id.row_episode, extra > 0 ? label + " · +" + extra + " more" : label);
            return;
        }

        // "S3 E1 · Chapter One" on one line, as the app's Up Next card writes
        // it: the code in mono and full white, the name after it a step
        // quieter. Spans rather than two views, so the name takes whatever
        // width the code leaves and the line ellipsizes as one.
        SpannableStringBuilder episode = new SpannableStringBuilder(label);
        episode.setSpan(new TypefaceSpan("monospace"), 0, label.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        episode.setSpan(new StyleSpan(Typeface.BOLD), 0, label.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        String name = row.optString("episodeName");
        if (!name.isEmpty()) {
            int start = episode.length();
            episode.append(" · ").append(name);
            episode.setSpan(new ForegroundColorSpan(context.getColor(R.color.widget_text_2)), start, episode.length(),
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        views.setTextViewText(R.id.row_episode, episode);

        // The metadata line, worded by the app (see metaLine in
        // lib/widget/snapshot.ts) and only coloured here: "New" is the one
        // word on the row in the accent, exactly as on Home.
        String before = row.optString("metaBefore", "");
        boolean isNew = row.optBoolean("isNew", false);
        String after = row.optString("metaAfter", "");
        SpannableStringBuilder meta = new SpannableStringBuilder(before);
        if (isNew) {
            int start = meta.length();
            meta.append("New");
            meta.setSpan(new ForegroundColorSpan(context.getColor(R.color.widget_accent)), start, meta.length(),
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            meta.setSpan(new StyleSpan(Typeface.BOLD), start, meta.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        meta.append(after);
        views.setTextViewText(R.id.row_meta, meta);
        views.setViewVisibility(R.id.row_meta, meta.length() > 0 ? View.VISIBLE : View.GONE);
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

    /**
     * The Text size setting. Each view's size is its layout's own, times the
     * factor, so the hierarchy within a row stays as designed. The sizes here
     * mirror the row layouts' android:textSize values.
     */
    private void applyTextScale(RemoteViews views) {
        if (textScale == 1f) return;
        // The movie families use the episode rows, so they scale the same way.
        boolean comingUp = kind == WidgetKind.COMING_UP || kind == WidgetKind.MOVIE_RELEASES;
        if (!comingUp && !compact) {
            size(views, R.id.row_show, 14); size(views, R.id.row_episode, 12); size(views, R.id.row_meta, 11);
        } else if (!comingUp) {
            size(views, R.id.row_show, 12); size(views, R.id.row_episode, 11);
        } else if (!compact) {
            size(views, R.id.row_show, 12); size(views, R.id.row_episode, 11);
            size(views, R.id.row_episode_name, 11); size(views, R.id.row_date, 12);
        } else {
            size(views, R.id.row_show, 12); size(views, R.id.row_episode, 10); size(views, R.id.row_date, 11);
        }
    }

    private void size(RemoteViews views, int id, float sp) {
        views.setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, sp * textScale);
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
        // A fill-in intent: only the extras matter. The component, flags and
        // task handling all come from the provider's PendingIntent template.
        Intent intent = new Intent();
        if (kind.isMovie()) {
            // A movie has no overlay of its own: the row opens it in the app,
            // and the tick (which adds EXTRA_MARK_WATCHED) marks it watched.
            intent.putExtra(EpisodePanelActivity.EXTRA_MOVIE_ID, row.optInt("tmdbId"));
            return intent;
        }
        intent.putExtra(EpisodePanelActivity.EXTRA_SHOW_ID, row.optInt("showId"));
        intent.putExtra(EpisodePanelActivity.EXTRA_EPISODE_KEY, row.optString("episodeKey"));
        intent.putExtra(EpisodePanelActivity.EXTRA_READONLY, kind == WidgetKind.COMING_UP);
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
