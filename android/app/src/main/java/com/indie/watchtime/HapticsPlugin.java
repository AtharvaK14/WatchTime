package com.indie.watchtime;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Light touch feedback for the app's ticks and switches (src/lib/haptics.ts).
 *
 * Deliberately View.performHapticFeedback rather than the Vibrator: it is the
 * same crisp click the system keyboard and settings switches use, needs no
 * VIBRATE permission, and follows the user's own "Touch feedback" setting, so
 * someone who has turned that off gets nothing here either.
 */
@CapacitorPlugin(name = "WatchTimeHaptics")
public class HapticsPlugin extends Plugin {

    @PluginMethod
    public void perform(PluginCall call) {
        String kind = call.getString("kind", "tick");
        View view = getBridge().getWebView();
        if (view != null) {
            int constant = constantFor(kind);
            view.post(() -> view.performHapticFeedback(constant));
        }
        call.resolve();
    }

    /** Shared with EpisodePanelActivity's host interface. */
    public static int constantFor(String kind) {
        if ("confirm".equals(kind)) {
            // A watched tick: a firmer, "done" click.
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? HapticFeedbackConstants.CONFIRM
                    : HapticFeedbackConstants.VIRTUAL_KEY;
        }
        if ("toggle".equals(kind)) {
            // A segmented switch changing position.
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                    ? HapticFeedbackConstants.SEGMENT_TICK
                    : HapticFeedbackConstants.CLOCK_TICK;
        }
        return HapticFeedbackConstants.CLOCK_TICK;
    }
}
