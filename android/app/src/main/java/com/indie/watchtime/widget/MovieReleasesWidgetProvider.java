package com.indie.watchtime.widget;

/**
 * The Coming Soon widget: watchlist movies with a release still ahead, soonest
 * first, with the date and whether it is the cinema or the digital release.
 */
public class MovieReleasesWidgetProvider extends BaseWidgetProvider {
    @Override
    WidgetKind kind() {
        return WidgetKind.MOVIE_RELEASES;
    }
}
