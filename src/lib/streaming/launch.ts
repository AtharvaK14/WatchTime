// Opening a streaming service from a capsule.
//
// The ladder, and why it is a ladder rather than a link:
//
//   1. the service's own URL for the title, aimed at its Android app
//   2. the same URL, with no app in mind (browser, or whichever app claims it)
//   3. the app's Play Store listing, when the app is named and step 1 failed
//   4. nothing further - the caller has already been told it did not work
//
// A plain <a href> collapses all of that into step 2. A raw custom scheme
// collapses it into step 1 and fails silently when the app is missing, which
// is precisely the dead end this is built to avoid: the user taps "Netflix"
// and lands on a blank page telling them nothing.
//
// The decision has to happen natively because only the platform can answer
// "is this app here", so the ladder itself lives in
// android/.../stream/StreamingLauncher.java and this module is the typed door
// to it. There are two doors on the native side - the Capacitor plugin for the
// app, the panel host's openExternal for the widget overlay - and one room
// behind them, so a capsule behaves the same wherever it is tapped. On the web
// build it degrades to step 2, which is the correct behaviour there rather
// than a missing feature.

import { Capacitor, registerPlugin } from "@capacitor/core";
import { canOpenExternal, isPanelHosted, openExternalFromPanel } from "../widget/panelHost";
import type { StreamingBrand } from "./registry";

export interface StreamingLauncherPlugin {
  /**
   * Walks the ladder above and resolves with what actually happened, so the
   * UI can say something true when a service could not be opened at all.
   */
  open(options: {
    /** The service's web address for this title. Always present. */
    url: string;
    /** Android application id, when the service has an app worth trying. */
    packageName?: string;
  }): Promise<{ outcome: StreamingLaunchOutcome }>;
}

/** Which rung of the ladder the launch ended on. */
export type StreamingLaunchOutcome =
  /** The service's own app opened. */
  | "app"
  /** Opened outside our app, but not in the service's app - normally the browser. */
  | "web"
  /** The app is not installed, so its store listing was opened instead. */
  | "store"
  /** Nothing could handle it. The only outcome the caller has to tell the user about. */
  | "failed";

const StreamingLauncher = registerPlugin<StreamingLauncherPlugin>("StreamingLauncher");

/**
 * Where a tap on this capsule should go.
 *
 * `brand` is the app's own knowledge of the service and is allowed to be null:
 * a provider TMDB returned that the registry has never heard of still opens
 * the JustWatch page TMDB supplied for the title, which lists every way to
 * watch it. That is a worse destination than the service itself and a much
 * better one than nothing, and it means the capsule row never contains a
 * control that does nothing.
 */
export function resolveTarget(
  brand: StreamingBrand | null,
  title: string,
  fallbackLink: string | null
): { url: string; packageName?: string } | null {
  if (brand) return { url: brand.url(title), packageName: brand.androidPackage };
  if (fallbackLink) return { url: fallbackLink };
  return null;
}

/**
 * Whether a tap could actually open anything from here.
 *
 * There is exactly one context where it could not: the widget's episode
 * overlay running on an APK whose panel host predates openExternal. That
 * overlay refuses navigations by design and has no Capacitor bridge, so a
 * capsule there would be a control that does nothing at all. The UI asks this
 * first and renders the capsules as plain information when the answer is no -
 * the same pattern canOpenInApp() already sets for the overlay's other
 * hand-offs, and the reason the availability row can be shown everywhere
 * without any surface having to special-case itself.
 */
export function canLaunchStreaming(): boolean {
  if (isPanelHosted()) return canOpenExternal();
  return true; // the app (Capacitor plugin) and the web build (window.open)
}

/**
 * Opens a streaming service, preferring its app and falling back through the
 * ladder above.
 *
 * Never throws: a service that will not open is a disappointment, not an
 * error, and the details panel behind it must stay usable. The outcome is
 * returned instead so the caller can surface the one case worth mentioning.
 */
export async function openStreaming(target: { url: string; packageName?: string }): Promise<StreamingLaunchOutcome> {
  // The widget overlay, checked first because it is the one context that is
  // neither "native" by Capacitor's reckoning nor able to fall back to the
  // browser. Native runs the same ladder either way - the two entry points
  // call one implementation on the Java side.
  if (isPanelHosted()) {
    return openExternalFromPanel(target) as StreamingLaunchOutcome;
  }

  if (Capacitor.isNativePlatform()) {
    try {
      const { outcome } = await StreamingLauncher.open({
        url: target.url,
        ...(target.packageName ? { packageName: target.packageName } : {}),
      });
      return outcome;
    } catch {
      // An APK older than this web build has no such plugin. Falling through
      // to the browser is strictly better than reporting a failure: the web
      // address works everywhere, it just does not get to prefer the app.
    }
  }

  try {
    const opened = window.open(target.url, "_blank", "noopener,noreferrer");
    return opened ? "web" : "failed";
  } catch {
    return "failed";
  }
}
