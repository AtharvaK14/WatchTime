package com.indie.watchtime.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import com.indie.watchtime.MainActivity;
import com.indie.watchtime.R;

import org.json.JSONArray;

/**
 * Shared behaviour for both widgets.
 *
 * Subclasses supply only their WidgetKind; everything about how a widget is
 * assembled, sized and refreshed lives here, so the two families cannot drift
 * apart visually or behaviourally.
 */
abstract class BaseWidgetProvider extends AppWidgetProvider {

    /** Below this height the header would occupy the space of a whole row, so it goes. */
    private static final int HEADER_MIN_HEIGHT_DP = 110;

    abstract WidgetKind kind();

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            render(context, manager, appWidgetId);
        }
    }

    /**
     * Fired when the user finishes dragging a resize handle. Re-rendering here
     * is what makes the layout adapt: the header visibility is recomputed for
     * the new height, and the list is invalidated so the factory re-measures
     * and picks compact or full rows for the new width.
     */
    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                          int appWidgetId, Bundle newOptions) {
        render(context, manager, appWidgetId);
        manager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.widget_list);
    }

    void render(Context context, AppWidgetManager manager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_container);
        WidgetKind kind = kind();

        views.setTextViewText(R.id.widget_title, context.getString(kind.titleRes()));

        // "No snapshot at all" and "a snapshot with no rows" are different
        // situations and must not read the same. The first happens on a freshly
        // placed widget before the app has next run, and telling that user
        // their list is empty would be wrong - it is unknown, not empty.
        boolean haveSnapshot = WidgetStore.readSnapshot(context) != null;
        views.setTextViewText(R.id.widget_empty, context.getString(
                haveSnapshot ? kind.emptyRes() : R.string.widget_needs_app));

        Bundle options = manager.getAppWidgetOptions(appWidgetId);
        int height = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        boolean showHeader = height == 0 || height >= HEADER_MIN_HEIGHT_DP;
        views.setViewVisibility(R.id.widget_header, showHeader ? View.VISIBLE : View.GONE);

        JSONArray rows = WidgetStore.readRows(context, kind.snapshotField());
        views.setTextViewText(R.id.widget_count, rows.length() > 0 ? String.valueOf(rows.length()) : "");

        // A unique data URI per widget id and kind. Without it the framework
        // treats the service intents as equal and hands every instance the same
        // factory, which breaks per-instance sizing.
        Intent serviceIntent = new Intent(context, WidgetListService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        serviceIntent.putExtra(WidgetKind.EXTRA_KIND, kind.name());
        serviceIntent.setData(Uri.parse(serviceIntent.toUri(Intent.URI_INTENT_SCHEME)));
        // Deprecated since API 31 in favour of the RemoteCollectionItems
        // overload, which requires every row to be built up front. This app
        // supports API 24, where that overload does not exist, and the
        // service-backed adapter is also what lets rows fetch their poster
        // bitmaps lazily on a background thread. Kept deliberately.
        views.setRemoteAdapter(R.id.widget_list, serviceIntent);

        // The empty view the framework swaps in when the adapter has no rows,
        // so an empty list says something useful instead of showing a void.
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);

        // One template for every row; each row supplies only its fill-in extras.
        Intent templateIntent = new Intent(context, WidgetActionReceiver.class);
        templateIntent.setAction(WidgetActionReceiver.ACTION_ROW_CLICK);
        templateIntent.setData(Uri.parse("watchtime://widget/" + kind.name() + "/" + appWidgetId));
        PendingIntent template = PendingIntent.getBroadcast(context, appWidgetId, templateIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        views.setPendingIntentTemplate(R.id.widget_list, template);

        // Tapping the header opens the app itself, which is the natural
        // "show me everything" affordance for content the widget cannot fit.
        Intent openApp = new Intent(context, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        views.setOnClickPendingIntent(R.id.widget_header, PendingIntent.getActivity(
                context, appWidgetId, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        manager.updateAppWidget(appWidgetId, views);
    }

    /**
     * Redraws every placed widget of both families. Called after a snapshot
     * push and after a widget-originated tap, so "the app changed" and "the
     * widget changed" converge on the same refresh path.
     */
    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        refreshFamily(context, manager, WatchNextWidgetProvider.class);
        refreshFamily(context, manager, ComingUpWidgetProvider.class);
    }

    private static void refreshFamily(Context context, AppWidgetManager manager, Class<?> provider) {
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, provider));
        if (ids == null || ids.length == 0) return;

        Intent update = new Intent(context, provider);
        update.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        update.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        context.sendBroadcast(update);

        // The chrome above is redrawn by the broadcast; the list contents are
        // owned by the adapter and need their own invalidation.
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    /** True when the user has at least one widget of either family on a home screen. */
    static boolean anyPlaced(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        return count(manager, context, WatchNextWidgetProvider.class) > 0
                || count(manager, context, ComingUpWidgetProvider.class) > 0;
    }

    private static int count(AppWidgetManager manager, Context context, Class<?> provider) {
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, provider));
        return ids == null ? 0 : ids.length;
    }
}
