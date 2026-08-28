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
