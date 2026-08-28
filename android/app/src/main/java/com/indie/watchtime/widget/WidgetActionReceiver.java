package com.indie.watchtime.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Handles taps on widget rows.
 *
 * A row tap opens the episode overlay (EpisodePanelActivity), NOT the app. The
 * user stays on their home screen and gets the app's own episode detail panel
 * as a pop-up, with "Mark as Watched" inside it. Both widgets behave the same
 * way; the only difference is that Coming Up rows open read-only, because an
 * episode that has not aired cannot be watched.
 *
 * The row-level "mark watched" button this receiver used to handle is gone.
 * The action now lives where the user expects it, inside the panel, and works
 * properly there: the overlay shares the app's IndexedDB, so it writes the
 * library directly instead of queueing an intention for the app to replay.
 */
public class WidgetActionReceiver extends BroadcastReceiver {

    public static final String ACTION_ROW_CLICK = "com.indie.watchtime.widget.ROW_CLICK";

    public static final String EXTRA_SHOW_ID = "showId";
    public static final String EXTRA_EPISODE_KEY = "episodeKey";
    public static final String EXTRA_READONLY = "readonly";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_ROW_CLICK.equals(intent.getAction())) return;

        String episodeKey = intent.getStringExtra(EXTRA_EPISODE_KEY);
        if (episodeKey == null || episodeKey.isEmpty()) return;

        Intent panel = new Intent(context, EpisodePanelActivity.class);
        panel.putExtra(EpisodePanelActivity.EXTRA_SHOW_ID, intent.getIntExtra(EXTRA_SHOW_ID, 0));
        panel.putExtra(EpisodePanelActivity.EXTRA_EPISODE_KEY, episodeKey);
        panel.putExtra(EpisodePanelActivity.EXTRA_READONLY, intent.getBooleanExtra(EXTRA_READONLY, false));
        // NEW_TASK is required to start an activity from a receiver.
        // CLEAR_TOP drops any overlay left over from a previous row, so tapping
        // a second episode replaces the pop-up rather than stacking on it.
        panel.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(panel);
    }
}
