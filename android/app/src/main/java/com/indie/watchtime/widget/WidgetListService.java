package com.indie.watchtime.widget;

import android.content.Intent;
import android.widget.RemoteViewsService;

/**
 * Hosts the collection adapter for both widgets. The kind and the widget id
 * ride on the intent, which is why the providers give each RemoteViewsService
 * intent a unique data URI - without it the framework reuses one factory for
 * every widget instance and they all render the same size and list.
 */
public class WidgetListService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new WidgetListFactory(getApplicationContext(), intent);
    }
}
