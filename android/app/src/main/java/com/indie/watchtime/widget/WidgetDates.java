package com.indie.watchtime.widget;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * Recomputes the "Today" / "Tomorrow" / "Mar 4" label a Coming Up row shows.
 *
 * The snapshot already carries a formatted dateLabel from formatUpcomingDate()
 * in src/lib/comingUp.ts, and everything else the widget displays is taken
 * from it verbatim. This one field cannot be, because it is the only value in
 * the payload whose correctness depends on when it is READ rather than when it
 * was written: a snapshot built on Monday says "Tomorrow" for Tuesday, and if
 * the app is not opened again that label is still claiming "Tomorrow" on
 * Thursday. Deriving it from the raw airDate at render time is the only way a
 * widget that refreshes without the app can stay truthful.
 *
 * The wording deliberately matches formatUpcomingDate exactly; the snapshot's
 * own dateLabel remains the fallback for a row with no parseable date.
 */
final class WidgetDates {

    private WidgetDates() {}

    /** @param airDate ISO calendar day (YYYY-MM-DD), as stored on an Episode. */
    static String relativeLabel(String airDate, String fallback) {
        if (airDate == null || airDate.length() < 10) return fallback;

        Calendar target = Calendar.getInstance();
        try {
            SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            parser.setLenient(false);
            Date parsed = parser.parse(airDate.substring(0, 10));
            if (parsed == null) return fallback;
            target.setTime(parsed);
        } catch (Exception e) {
            return fallback;
        }

        Calendar today = Calendar.getInstance();
        startOfDay(today);
        startOfDay(target);

        long diffDays = Math.round((target.getTimeInMillis() - today.getTimeInMillis()) / 86400000.0);
        if (diffDays == 0) return "Today";
        if (diffDays == 1) return "Tomorrow";
        // Locale-aware short month and day, matching the app's
        // toLocaleDateString({ month: "short", day: "numeric" }).
        return new SimpleDateFormat("MMM d", Locale.getDefault()).format(target.getTime());
    }

    private static void startOfDay(Calendar calendar) {
        calendar.set(Calendar.HOUR_OF_DAY, 0);
        calendar.set(Calendar.MINUTE, 0);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
    }
}
