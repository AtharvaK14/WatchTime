package com.indie.watchtime.notify;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.indie.watchtime.MainActivity;
import com.indie.watchtime.R;
import com.indie.watchtime.widget.PosterCache;
import com.indie.watchtime.widget.WidgetStore;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Delivery for the release notifications the web layer schedules.
 *
 * WHY THIS EXISTS AT ALL. The app used @capacitor/local-notifications for the
 * whole job, and it still owns the runtime permission. What it cannot do is
 * put the show's artwork on the notification: its `largeIcon` is resolved
 * through AssetUtil.getResourceID(context, name, "drawable"), so it only ever
 * accepts a compile-time drawable, and there is no route from a TMDB poster
 * URL to it. Posting the notification here is what makes the poster possible.
 *
 * The visual treatment then comes free from the platform. A notification that
 * carries BOTH a large icon and a small icon is drawn by Android as the large
 * icon with the small one badged into its bottom-right corner - which is
 * exactly the "content thumbnail plus app mark" look. So: large icon = the
 * poster, small icon = the WatchTime mark. Nothing is composited by hand.
 *
 * SCHEDULING. One rolling alarm, not one alarm per event. The web layer hands
 * over the whole horizon, native arms the earliest unposted entry, and each
 * firing posts everything now due and arms the next. That removes the
 * per-app pending-alarm ceiling from the design entirely, makes reboot
 * recovery a single re-arm, and makes "already notified" a set of ids rather
 * than a question about what the OS still holds.
 *
 * The alarm is deliberately INEXACT (setAndAllowWhileIdle). "A new episode is
 * out today" does not need to-the-minute delivery, and exact alarms on
 * Android 12+ need a restricted permission that this would not justify.
 */
public final class ReleaseNotifier {

    private static final String PREFS = "watchtime_notifications";
    private static final String KEY_SCHEDULE = "schedule";
    private static final String KEY_POSTED = "posted";

    /** Must match SCHEDULE_PAYLOAD_VERSION in src/lib/notifications/bridge.ts. */
    private static final int SUPPORTED_VERSION = 1;

    /**
     * Unchanged from the channel the Capacitor implementation created, so an
     * updating install keeps whatever importance and sound the user had
     * already tuned for it instead of getting a second, unfamiliar channel.
     */
    private static final String CHANNEL_ID = "library_releases";

    /** The single rolling alarm's request code. */
    private static final int ALARM_REQUEST_CODE = 0x5741;

    /**
     * How late a notification may be and still be worth posting.
     *
     * Only reachable when a firing was missed - the device was off over the
     * date, say - and the backlog is delivered on the next boot. Announcing a
     * week of releases at once the moment a phone turns on is noise, and
     * "available" is not news after a day. Anything older is marked handled
     * and silently skipped, never posted and never re-considered.
     */
    private static final long STALE_AFTER_MS = 24L * 60 * 60 * 1000;

    /** Brand accent, applied to the small icon and the app name in the header. */
    private static final int ACCENT = 0xFFFF4433;

    /**
     * Where the tapped notification's deep-link target rides into the app.
     * MainActivity reads it and parks it in the pending-deep-link slot, the
     * same one a widget tap uses, so both routes converge on the web layer's
     * existing drain rather than growing a second mechanism.
     */
    public static final String EXTRA_TARGET = "watchtime.notification.target";

    private ReleaseNotifier() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---- Schedule ---------------------------------------------------------

    /** One scheduled notification, as the web layer serialises it. */
    static final class Entry {
        final String id;
        final int notificationId;
        final long at;
        final String title;
        final String body;
        final String imageUrl;
        final String target;

        Entry(String id, int notificationId, long at, String title, String body, String imageUrl, String target) {
            this.id = id;
            this.notificationId = notificationId;
            this.at = at;
            this.title = title;
            this.body = body;
            this.imageUrl = imageUrl;
            this.target = target;
        }
    }

    /**
     * Replaces the stored schedule and re-arms.
     *
     * Deliberately does NOT deliver anything: the web layer drops events whose
     * time has already passed before it ever gets here, so a freshly pushed
     * schedule is entirely in the future. Posting on store could therefore
     * only ever fire something a second time.
     */
    public static void store(Context context, String json) {
        if (json == null || json.isEmpty()) return;
        // A payload this build cannot read is ignored rather than stored, so
        // the last good schedule keeps running. An EMPTY but readable one is
        // stored: that is the library legitimately having nothing queued, and
        // it has to be able to clear the schedule.
        if (!isReadable(json)) return;
        prefs(context).edit().putString(KEY_SCHEDULE, json).apply();
        ensureChannel(context);
        List<Entry> entries = schedule(context);
        writePosted(context, readPosted(context), entries);
        arm(context);
    }

    /**
     * Forgets the schedule and disarms.
     *
     * Notifications already showing in the shade are left alone on purpose:
     * turning the feature off is about what happens NEXT, and silently
     * clearing something the user has not read yet would lose it.
     */
    public static void cancelAll(Context context) {
        prefs(context).edit().remove(KEY_SCHEDULE).remove(KEY_POSTED).apply();
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) alarms.cancel(alarmIntent(context));
    }

    private static boolean isReadable(String json) {
        try {
            return new JSONObject(json).optInt("version", -1) == SUPPORTED_VERSION;
        } catch (JSONException e) {
            return false;
        }
    }

    private static List<Entry> schedule(Context context) {
        return readEntries(prefs(context).getString(KEY_SCHEDULE, null));
    }

    /**
     * Entries from a payload, or empty for anything this build cannot read.
     *
     * A version it does not understand is ignored wholesale rather than
     * half-parsed, so a web update that lands before a native one degrades to
     * "no new notifications" instead of malformed ones.
     */
    private static List<Entry> readEntries(String json) {
        List<Entry> entries = new ArrayList<>();
        if (json == null || json.isEmpty()) return entries;
        try {
            JSONObject payload = new JSONObject(json);
            if (payload.optInt("version", -1) != SUPPORTED_VERSION) return entries;
            JSONArray array = payload.optJSONArray("notifications");
            if (array == null) return entries;
            for (int i = 0; i < array.length(); i++) {
                JSONObject row = array.optJSONObject(i);
                if (row == null) continue;
                String id = row.optString("id", "");
                if (id.isEmpty()) continue;
                entries.add(
                    new Entry(
                        id,
                        row.optInt("notificationId", id.hashCode() & 0x7fffffff),
                        row.optLong("at", 0L),
                        row.optString("title", ""),
                        row.optString("body", ""),
                        row.isNull("imageUrl") ? null : row.optString("imageUrl", null),
                        row.optString("target", "")
                    )
                );
            }
        } catch (JSONException e) {
            // Corrupt payload. An empty schedule is the safe reading: nothing
            // fires, and the next sync from the app replaces it.
        }
        return entries;
    }

    // ---- Already-notified state ------------------------------------------

    private static Set<String> readPosted(Context context) {
        Set<String> ids = new HashSet<>();
        String raw = prefs(context).getString(KEY_POSTED, null);
        if (raw == null) return ids;
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) ids.add(array.optString(i, ""));
        } catch (JSONException e) {
            // Unreadable. Treating it as empty risks re-posting, but only for
            // entries still in the schedule, which is a bounded and rare cost.
        }
        ids.remove("");
        return ids;
    }

    /**
     * Persists the notified set, pruned to ids the schedule still mentions.
     *
     * That pruning is what keeps this from growing forever, and it is safe
     * precisely because of how events are built: an event's id encodes its
     * date, and the web layer only ever emits future dates, so an id that has
     * dropped out of the schedule can never be produced again. Forgetting it
     * cannot resurrect it.
     */
    private static void writePosted(Context context, Set<String> posted, List<Entry> entries) {
        Set<String> known = new HashSet<>();
        for (Entry entry : entries) known.add(entry.id);
        JSONArray array = new JSONArray();
        for (String id : posted) {
            if (known.contains(id)) array.put(id);
        }
        prefs(context).edit().putString(KEY_POSTED, array.toString()).apply();
    }

    // ---- Delivery ---------------------------------------------------------

    /**
     * Posts everything now due and arms the next alarm.
     *
     * Returns the entries that have artwork still to load. Text goes out
     * first, synchronously, so the notification is never held up by a network
     * fetch - and so this can run on a BroadcastReceiver's main thread without
     * risking an ANR. The caller re-posts them with their poster from a
     * background thread; because the id is the same and onlyAlertOnce is set,
     * that update is silent and the user just sees the artwork arrive.
     */
    static List<Entry> deliverDue(Context context) {
        List<Entry> entries = schedule(context);
        Set<String> posted = readPosted(context);
        long now = System.currentTimeMillis();

        List<Entry> withArtwork = new ArrayList<>();
        boolean channelReady = false;
        for (Entry entry : entries) {
            if (entry.at > now || posted.contains(entry.id)) continue;
            // Marked handled whether or not it is actually posted below, so a
            // skipped stale entry is never reconsidered on the next firing.
            posted.add(entry.id);
            if (now - entry.at > STALE_AFTER_MS) continue;
            if (!channelReady) {
                ensureChannel(context);
                channelReady = true;
            }
            post(context, entry, null);
            if (entry.imageUrl != null && !entry.imageUrl.isEmpty()) withArtwork.add(entry);
        }

        writePosted(context, posted, entries);
        arm(context);
        return withArtwork;
    }

    /**
     * Loads each poster and re-posts its notification with it.
     *
     * Blocking on the network; background thread only. Reuses the widgets'
     * PosterCache rather than fetching separately - the memory and disk caches
     * in front of it mean a show already drawn on a widget costs nothing here.
     */
    static void attachArtwork(Context context, List<Entry> entries) {
        for (Entry entry : entries) {
            Bitmap poster = PosterCache.get(context, entry.imageUrl);
            if (poster == null) continue; // stays a text notification, which is still correct
            post(context, entry, squareCrop(poster));
        }
    }

    private static void post(Context context, Entry entry, Bitmap largeIcon) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            // Monochrome mark. Android tints and, when a large icon is present,
            // badges it into that icon's corner - the whole point of the
            // treatment, and why this must be a silhouette rather than the
            // full-colour launcher icon.
            .setSmallIcon(R.drawable.ic_stat_watchtime)
            .setColor(ACCENT)
            .setContentTitle(entry.title)
            .setContentText(entry.body)
            .setAutoCancel(true)
            // The artwork pass re-posts this same id; without this the second
            // post would buzz a second time for one event.
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(tapIntent(context, entry));

        if (largeIcon != null) builder.setLargeIcon(largeIcon);

        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            manager.notify(entry.notificationId, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS revoked between scheduling and firing. The
            // schedule stays; nothing else to do.
        }
    }

    /**
     * A square taken from the upper half of the poster.
     *
     * Android masks the large icon to a circle, and a 2:3 poster masked whole
     * loses its sides. Cropping here makes that decision explicit instead of
     * leaving it to the framework's scaling, and the crop sits above centre
     * because poster artwork puts its subject there and its billing block at
     * the bottom.
     */
    private static Bitmap squareCrop(Bitmap source) {
        int width = source.getWidth();
        int height = source.getHeight();
        int side = Math.min(width, height);
        if (side <= 0 || (width == side && height == side)) return source;
        int x = (width - side) / 2;
        int y = Math.round((height - side) * 0.3f);
        try {
            return Bitmap.createBitmap(source, x, y, side, side);
        } catch (IllegalArgumentException e) {
            return source;
        }
    }

    private static PendingIntent tapIntent(Context context, Entry entry) {
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra(EXTRA_TARGET, entry.target);
        // A distinct request code per notification. With a shared one every
        // notification would end up carrying the first one's extras, and every
        // tap would open the same title.
        return PendingIntent.getActivity(
            context,
            entry.notificationId,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Releases from your library",
            NotificationManager.IMPORTANCE_DEFAULT // shade and a sound, never interrupts full-screen
        );
        channel.setDescription("New episodes, season premieres and movie releases for titles you follow.");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC); // nothing here is sensitive
        manager.createNotificationChannel(channel);
    }

    // ---- Alarm ------------------------------------------------------------

    /** Arms the earliest entry not yet notified about. Idempotent. */
    static void arm(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;

        PendingIntent pending = alarmIntent(context);
        alarms.cancel(pending);

        Set<String> posted = readPosted(context);
        long now = System.currentTimeMillis();
        long next = Long.MAX_VALUE;
        for (Entry entry : schedule(context)) {
            if (posted.contains(entry.id)) continue;
            if (entry.at < next) next = entry.at;
        }
        if (next == Long.MAX_VALUE) return;

        // An entry already overdue (a firing missed while the device was off)
        // is handled by scheduling a moment from now rather than recursing
        // into delivery from here, which keeps arm() free of side effects.
        long at = Math.max(next, now + 1000L);
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, ReleaseAlarmReceiver.class);
        intent.setAction(ReleaseAlarmReceiver.ACTION_DELIVER);
        return PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /**
     * Hands a tapped notification's target to the pending-deep-link slot.
     *
     * Called by MainActivity. Reuses WidgetStore's slot rather than adding a
     * parallel one: the web layer already drains it at mount and on every
     * resume, which is exactly what a notification tap needs, whether it cold
     * started the app or resumed it.
     */
    public static void handleTapTarget(Context context, Intent intent) {
        if (intent == null) return;
        String target = intent.getStringExtra(EXTRA_TARGET);
        if (target == null || target.isEmpty()) return;
        WidgetStore.setPendingDeepLink(context.getApplicationContext(), target);
        // Consumed, so a configuration change that re-delivers the same intent
        // cannot re-open the panel the user has since navigated away from.
        intent.removeExtra(EXTRA_TARGET);
    }
}
