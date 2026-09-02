// The panel WebView's channel back to native.
//
// The episode panel opened from a widget runs in EpisodePanelActivity: a
// small, dialog-themed activity hosting a WebView that loads this same web
// build at the same origin (https://localhost) as the main app. Same origin
// means the SAME IndexedDB, so the panel reads and writes the real library
// directly - it is not a copy of the data and not a queue.
//
// That activity is not a Capacitor BridgeActivity, so there is no Capacitor
// plugin here. It injects a plain @JavascriptInterface object instead, which
// is all this needs: close the overlay, and tell the widgets to redraw.

/** Injected by EpisodePanelActivity.addJavascriptInterface. Absent everywhere else. */
interface PanelHost {
  close(): void;
  /** Hands native a fresh widget snapshot and refreshes every placed widget. */
  updateSnapshot(snapshot: string): void;
  /**
   * Closes the overlay and launches the MAIN app on the given deep-link
   * target. The only thing in the overlay that opens the app.
   *
   * Optional at the type level because the page and the activity ship
   * separately: a web build newer than the installed APK would otherwise call
   * a method that is not there and throw inside the panel.
   */
  openInApp?(target: string): void;
}

declare global {
  interface Window {
    WatchTimePanelHost?: PanelHost;
  }
}

export function panelHost(): PanelHost | null {
  return typeof window !== "undefined" && window.WatchTimePanelHost ? window.WatchTimePanelHost : null;
}

/** True when this document is the widget's episode overlay rather than the app. */
export function isPanelHosted(): boolean {
  return panelHost() !== null;
}

export function closePanel(): void {
  panelHost()?.close();
}

/**
 * Whether this overlay can hand off to the main app.
 *
 * False on an older APK whose PanelHost has no openInApp, and false in every
 * non-panel context. Callers use it to decide whether to OFFER the handoff at
 * all, so a control that could not work is never shown.
 */
export function canOpenInApp(): boolean {
  return typeof panelHost()?.openInApp === "function";
}

/**
 * Opens the show's full episode list in the main app and dismisses the
 * overlay.
 *
 * This is the ONLY path from the widget's episode panel into the app. Every
 * other interaction in that panel - marking watched, rewatching, closing -
 * deliberately stays inside the overlay, which is the whole point of the
 * overlay existing. It is never automatic: the user has to tap the
 * season/episode capsule or the episode title to get here.
 *
 * `seasonNumber` rides along so the app opens with that season already
 * expanded, rather than on a collapsed accordion the user has to search for
 * the episode they were just looking at.
 */
export function openShowEpisodeListInApp(showId: number, seasonNumber: number): void {
  const host = panelHost();
  if (!host?.openInApp) return;
  try {
    host.openInApp(JSON.stringify({ kind: "show", showId, seasonNumber }));
  } catch {
    // The overlay stays open and usable; only the handoff is lost.
  }
}
