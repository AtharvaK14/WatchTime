package com.indie.watchtime.stream;

import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The app's door to StreamingLauncher, matching src/lib/streaming/launch.ts.
 *
 * Thin on purpose: every decision about which app to open, whether it is
 * installed, and what to fall back to lives in StreamingLauncher, because the
 * widget's episode overlay asks the same question through a different door
 * (EpisodePanelActivity's injected host) and the two must not be able to
 * answer it differently.
 */
@CapacitorPlugin(name = "StreamingLauncher")
public class StreamingLauncherPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        // Optional by design: a service with no Android app (Apple TV+ among
        // them) is a normal case, not a missing configuration, and goes
        // straight to the web rung.
        String packageName = call.getString("packageName");

        // The activity's context when there is one, so the launch is
        // attributed to the visible task rather than to the application.
        android.content.Context context = getActivity() != null ? getActivity() : getContext();

        JSObject result = new JSObject();
        result.put("outcome", StreamingLauncher.launch(context, Uri.parse(url), packageName));
        call.resolve(result);
    }
}
