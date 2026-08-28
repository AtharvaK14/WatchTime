package com.indie.watchtime.widget;

import android.content.Intent;

import com.indie.watchtime.R;

/**
 * The two widget families, and the small set of things that actually differ
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

    static WidgetKind fromIntent(Intent intent) {
        String name = intent == null ? null : intent.getStringExtra(EXTRA_KIND);
        return COMING_UP.name().equals(name) ? COMING_UP : WATCH_NEXT;
    }
}
