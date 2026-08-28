package com.indie.watchtime.widget;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The web layer's door to the widgets. Three methods, matching
 * src/lib/widget/bridge.ts:
 *
 *  - updateSnapshot: store what the widgets should show, then redraw them
 *  - hasPlacedWidgets: let the app skip snapshot work when nobody uses them
 *  - consumePendingDeepLink: collect a target the user asked to open in the app
 *
 * The episode overlay reaches the same WidgetStore through its own injected
 * host object instead (see EpisodePanelActivity), because it runs outside
 * Capacitor.
 *
 * There is deliberately no method that reads library data: the widgets never
 * query, they only receive.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    @PluginMethod
    public void updateSnapshot(PluginCall call) {
        String snapshot = call.getString("snapshot");
        if (snapshot == null) {
            call.reject("snapshot is required");
            return;
        }
        WidgetStore.writeSnapshot(getContext(), snapshot);
        BaseWidgetProvider.refreshAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void hasPlacedWidgets(PluginCall call) {
        JSObject result = new JSObject();
        result.put("placed", BaseWidgetProvider.anyPlaced(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void consumePendingDeepLink(PluginCall call) {
        JSONObject target = WidgetStore.takePendingDeepLink(getContext());
        JSObject result = new JSObject();
        if (target == null) {
            result.put("target", JSObject.NULL);
        } else {
            try {
                result.put("target", JSObject.fromJSONObject(target));
            } catch (JSONException e) {
                result.put("target", JSObject.NULL);
            }
        }
        call.resolve(result);
    }
}
