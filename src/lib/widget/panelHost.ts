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
  /**
   * Opens a streaming service outside the overlay, returning which rung of the
   * launch ladder it reached (see StreamingLauncherPlugin / StreamingLauncher
   * on the native side - both run the identical code).
   *
   * The overlay cannot do this for itself in any form. Its WebViewClient
   * refuses every navigation by design (it is one page showing one episode),
   * and it is not a Capacitor activity, so the plugin the app uses is not
   * reachable from here either. Without this method a capsule in the overlay
   * would be a control that silently does nothing, which is why the UI asks
   * whether it exists before offering one.
   *
   * Optional for the same reason openInApp is: an installed APK older than the
   * web build would not have it.
   */
  openExternal?(request: string): string;
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
 * The two ways out of the widget's episode panel and into the app. Both are
 * explicit taps by the user; nothing here ever fires on its own, which is the
 * whole point of the overlay existing. Marking watched, rewatching and
 * closing all stay inside the overlay.
 *
 * They are deliberately different destinations, and each opens the panel the
 * user was pointing at rather than its container:
 *
 *  - the episode title opens THAT EPISODE's own detail panel in the app
 *  - the show capsule opens the SERIES panel for the show as a whole
 *
 * Both are shapes DeepLinkHost already renders — an episode link is the same
 * one a tapped notification uses — so neither adds a navigation path or a
 * panel that did not already exist.
 */
function openInApp(payload: Record<string, unknown>): void {
  const host = panelHost();
  if (!host?.openInApp) return;
  try {
    host.openInApp(JSON.stringify(payload));
  } catch {
    // The overlay stays open and usable; only the handoff is lost.
  }
}

/** The episode title's destination: this episode's own panel in the app. */
export function openEpisodeInApp(showId: number, episodeKey: string): void {
  openInApp({ kind: "episode", showId, episodeKey });
}

/** The show capsule's destination: the series panel, no season pre-expanded. */
export function openSeriesInApp(showId: number): void {
  openInApp({ kind: "show", showId });
}

/**
 * Whether this overlay can hand a streaming link to the system.
 *
 * Separate from canOpenInApp(): they are different methods added at different
 * times, and an APK carrying one need not carry the other.
 */
export function canOpenExternal(): boolean {
  return typeof panelHost()?.openExternal === "function";
}

/**
 * Opens a streaming service from the overlay. Returns the outcome native
 * reports, or "failed" if the call itself could not be made - the caller
 * treats both the same way, and neither is allowed to throw into a panel the
 * user is still looking at.
 */
export function openExternalFromPanel(request: { url: string; packageName?: string }): string {
  const host = panelHost();
  if (!host?.openExternal) return "failed";
  try {
    return host.openExternal(JSON.stringify(request)) ?? "failed";
  } catch {
    return "failed";
  }
}
