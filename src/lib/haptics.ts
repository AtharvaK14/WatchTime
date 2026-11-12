import { Capacitor, registerPlugin } from "@capacitor/core";
import { panelHost } from "./widget/panelHost";

/**
 * Light touch feedback, Android only.
 *
 *   tick    - a small step: pull-to-refresh catching, a menu choice
 *   confirm - something recorded: an episode or movie marked watched
 *   toggle  - a switch changing position (Home's Shows / Movies)
 *
 * In the app this goes through HapticsPlugin, and in the widget overlay
 * (which has no Capacitor bridge) through its panel host; both end in
 * View.performHapticFeedback, so the user's system "Touch feedback" setting
 * decides whether anything is felt. On the web it does nothing: the browser
 * vibration API is a buzz, not a click, and would feel worse than nothing.
 */
export type HapticKind = "tick" | "confirm" | "toggle";

interface HapticsPlugin {
  perform(options: { kind: HapticKind }): Promise<void>;
}

const NativeHaptics = registerPlugin<HapticsPlugin>("WatchTimeHaptics");

export function haptic(kind: HapticKind = "tick"): void {
  try {
    const host = panelHost();
    if (host) {
      host.haptic?.(kind);
      return;
    }
    if (Capacitor.isNativePlatform()) {
      // An APK older than this web build has no such plugin; that rejection
      // is expected and harmless.
      NativeHaptics.perform({ kind }).catch(() => {});
    }
  } catch {
    // Feedback is never worth an error.
  }
}
