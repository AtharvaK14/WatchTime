package com.indie.watchtime.widget;

/**
 * The Coming Up widget: the same upcoming episodes the app's Coming up column
 * lists, with their air dates. Display-only by design - there is nothing to
 * act on for an episode that has not aired - so tapping a row opens it in the
 * app rather than offering an inline action.
 */
public class ComingUpWidgetProvider extends BaseWidgetProvider {
    @Override
    WidgetKind kind() {
        return WidgetKind.COMING_UP;
    }
}
