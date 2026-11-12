package com.indie.watchtime.widget;

/**
 * The Movies to Watch widget: the movies on the app's watchlist, most
 * recently added first, each tappable to open it in the app and tickable as
 * watched.
 */
public class MoviesToWatchWidgetProvider extends BaseWidgetProvider {
    @Override
    WidgetKind kind() {
        return WidgetKind.MOVIES_TO_WATCH;
    }
}
