// Typed proxy for the native widget bridge.
//
// Home-screen widgets are rendered by the launcher, in a process that has no
// WebView and therefore no access to IndexedDB, where the entire library
// lives. So the widget cannot query anything: the app pushes it a snapshot,
// and the widget renders that. Everything a widget needs must be added to the
// snapshot builder in ./snapshot.ts, never fetched natively.
//
// There are two transports, because a snapshot can be pushed from two places:
//
//  - the main app, through the Capacitor WidgetBridge plugin
//  - the episode overlay opened FROM a widget, which runs in a plain WebView
//    with no Capacitor bridge and uses the injected host object instead
//
// Both end up in the same WidgetStore, so a watch recorded in the overlay
// refreshes the widgets exactly like one recorded in the app.

import { Capacitor, registerPlugin } from "@capacitor/core";
import { parseDeepLinkTarget, requestDeepLink } from "../deepLink";
import { panelHost } from "./panelHost";
import type { WidgetSnapshot } from "./snapshot";

export interface WidgetBridgePlugin {
  /** Replaces the stored snapshot and asks every placed widget to redraw. */
  updateSnapshot(options: { snapshot: string }): Promise<void>;
  /** Whether the user actually has at least one widget placed, so the app can skip snapshot work entirely. */
  hasPlacedWidgets(): Promise<{ placed: boolean }>;
  /**
   * Returns and CLEARS the target of a widget row the user tapped that asked
   * for the full app rather than the overlay. Read rather than pushed as an
   * event because such a tap can cold-start the app, in which case the event
   * would fire long before any JavaScript exists to hear it.
   */
  consumePendingDeepLink(): Promise<{ target: Record<string, unknown> | null }>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>("WidgetBridge");

export function widgetsSupported(): boolean {
  return Capacitor.getPlatform() === "android" || panelHost() !== null;
}

export async function pushSnapshot(snapshot: WidgetSnapshot): Promise<void> {
  if (!widgetsSupported()) return;
  const payload = JSON.stringify(snapshot);

  // In the overlay the injected host is the only transport available, and it
  // is synchronous, so the widgets are already refreshed by the time this
  // resolves - which is what lets the overlay close onto an updated widget.
  const host = panelHost();
  if (host) {
    try {
      host.updateSnapshot(payload);
    } catch {
      // The overlay still works; only the redraw is lost.
    }
    return;
  }

  try {
    await WidgetBridge.updateSnapshot({ snapshot: payload });
  } catch {
    // A build without the plugin registered, or a launcher that rejected the
    // update. Widgets keep their previous snapshot, which is stale but valid;
    // failing here must never break the app screen that triggered it.
  }
}

export async function hasPlacedWidgets(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") return false;
  try {
    return (await WidgetBridge.hasPlacedWidgets()).placed;
  } catch {
    return false;
  }
}

/**
 * Delivers a pending widget deep link into the app's store, if one is waiting.
 * Called at mount and on every resume.
 *
 * Most widget taps now open the episode overlay instead of the app, so this
 * fires only for the cases that genuinely want the full app - tapping the
 * widget header, or an overlay's "open in app" path.
 */
export async function drainWidgetDeepLink(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return;
  try {
    const { target } = await WidgetBridge.consumePendingDeepLink();
    const parsed = parseDeepLinkTarget(target);
    if (parsed) requestDeepLink(parsed);
  } catch {
    // No plugin, or nothing queued.
  }
}
