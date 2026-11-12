package com.indie.watchtime.widget;

import android.content.Intent;

import com.indie.watchtime.R;

/**
 * The widget families, and the small set of things that actually differ
 * between them: which array of the snapshot they read, which row layouts they
 * use, and what they say when empty.
 *
 * Keeping the differences in one enum is what lets a single provider, service
 * and factory serve both without either becoming a special case.
 */
enum WidgetKind {
    // The enum constant and the "watchNext" snapshot key are internal names and
    // deliberately unchanged: the key is the JSON field snapshot.ts writes, and
    // a launcher stores a placed widget by its provider ComponentName, so
    // renaming the provider classes would break every widget already on a home
    // screen. Everything the user actually reads says "Up Next".
    WATCH_NEXT("watchNext", R.string.widget_up_next_title, R.string.widget_empty_up_next,
            R.layout.widget_row_watch_next, R.layout.widget_row_watch_next_compact),
    COMING_UP("comingUp", R.string.widget_coming_up_title, R.string.widget_empty_coming_up,
            R.layout.widget_row_coming_up, R.layout.widget_row_coming_up_compact),
    // The movie families reuse the episode rows: a watchlist movie has the
    // same shape as an Up Next row (artwork, title, a line, a tick), and a
    // release the same shape as a Coming Up row (artwork, title, a date).
    MOVIES_TO_WATCH("moviesToWatch", R.string.widget_movies_title, R.string.widget_empty_movies,
            R.layout.widget_row_watch_next, R.layout.widget_row_watch_next_compact),
    MOVIE_RELEASES("movieReleases", R.string.widget_releases_title, R.string.widget_empty_releases,
            R.layout.widget_row_coming_up, R.layout.widget_row_coming_up_compact);

    static final String EXTRA_KIND = "com.indie.watchtime.widget.KIND";

    private final String snapshotField;
    private final int titleRes;
    private final int emptyRes;
    private final int fullLayout;
    private final int compactLayout;

    WidgetKind(String snapshotField, int titleRes, int emptyRes, int fullLayout, int compactLayout) {
        this.snapshotField = snapshotField;
        this.titleRes = titleRes;
        this.emptyRes = emptyRes;
        this.fullLayout = fullLayout;
        this.compactLayout = compactLayout;
    }

    String snapshotField() {
        return snapshotField;
    }

    int titleRes() {
        return titleRes;
    }

    int emptyRes() {
        return emptyRes;
    }

    int rowLayout(boolean compact) {
        return compact ? compactLayout : fullLayout;
    }

    /** A movie family: rows are movies, keyed by tmdbId, opened in the app. */
    boolean isMovie() {
        return this == MOVIES_TO_WATCH || this == MOVIE_RELEASES;
    }

    /** Rows built from the Up Next layouts, which carry the tick. */
    boolean hasTick() {
        return this == WATCH_NEXT || this == MOVIES_TO_WATCH;
    }

    static WidgetKind fromIntent(Intent intent) {
        String name = intent == null ? null : intent.getStringExtra(EXTRA_KIND);
        if (name != null) {
            for (WidgetKind k : values()) {
                if (k.name().equals(name)) return k;
            }
        }
        return WATCH_NEXT;
    }
}
