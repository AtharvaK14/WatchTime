package com.indie.watchtime.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.indie.watchtime.MainActivity;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Handles taps on widget rows.
 *
 * Both row actions land here because a collection item can only carry a
 * fill-in intent against one template, so the template is a broadcast and the
 * extras say which of the two the user meant.
 *
 * ACTION_OPEN launches the app with a deep-link target stored for the web
 * layer to pick up, which opens the app's real episode detail panel - not a
 * second copy of it built for the widget.
 *
 * ACTION_MARK_WATCHED is the direct action, and never opens the app. The
 * write itself cannot happen here: the library is in IndexedDB behind the
 * WebView. So the tap is queued for replay and the row is hidden immediately,
 * which is what makes the widget feel like it did the thing, because from the
 * user's point of view it did - the queued write is applied verbatim, at the
 * timestamp of this tap, the next time the app runs.
 */
public class WidgetActionReceiver extends BroadcastReceiver {

    public static final String ACTION_ROW_CLICK = "com.indie.watchtime.widget.ROW_CLICK";

    public static final String EXTRA_ACTION = "action";
    public static final String EXTRA_SHOW_ID = "showId";
    public static final String EXTRA_EPISODE_KEY = "episodeKey";
    public static final String EXTRA_SEASON = "seasonNumber";
    public static final String EXTRA_EPISODE = "episodeNumber";

    public static final String ACTION_OPEN = "open";
    public static final String ACTION_MARK_WATCHED = "markWatched";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_ROW_CLICK.equals(intent.getAction())) return;

        String action = intent.getStringExtra(EXTRA_ACTION);
        int showId = intent.getIntExtra(EXTRA_SHOW_ID, 0);
        String episodeKey = intent.getStringExtra(EXTRA_EPISODE_KEY);

        if (ACTION_MARK_WATCHED.equals(action) && episodeKey != null && !episodeKey.isEmpty()) {
            WidgetStore.queueWatchAction(context, episodeKey, showId,
                    intent.getIntExtra(EXTRA_SEASON, 0),
                    intent.getIntExtra(EXTRA_EPISODE, 0));
            WidgetStore.hideRow(context, episodeKey);
            BaseWidgetProvider.refreshAll(context);
            return;
        }

        openInApp(context, showId, episodeKey);
    }

    private void openInApp(Context context, int showId, String episodeKey) {
        try {
            JSONObject target = new JSONObject();
            if (episodeKey != null && !episodeKey.isEmpty()) {
                target.put("kind", "episode");
                target.put("showId", showId);
                target.put("episodeKey", episodeKey);
            } else {
                // A row with no cached episode still identifies its show, and
                // the show panel is the right place to land.
                target.put("kind", "show");
                target.put("showId", showId);
            }
            WidgetStore.setPendingDeepLink(context, target.toString());
        } catch (JSONException e) {
            // Fall through: the app still opens, just at its usual home screen.
        }

        Intent launch = new Intent(context, MainActivity.class);
        // SINGLE_TOP rather than CLEAR_TOP: MainActivity is already singleTask,
        // and clearing would tear down a running session the user may return to.
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(launch);
    }
}
