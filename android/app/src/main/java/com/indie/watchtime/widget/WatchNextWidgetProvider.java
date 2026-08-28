package com.indie.watchtime.widget;

/**
 * The Watch Next widget: the episodes sitting in the app's Up Next list, in
 * the app's order, each tappable for its details and tickable as watched.
 */
public class WatchNextWidgetProvider extends BaseWidgetProvider {
    @Override
    WidgetKind kind() {
        return WidgetKind.WATCH_NEXT;
    }
}
