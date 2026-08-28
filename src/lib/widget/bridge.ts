// Typed proxy for the native WidgetBridge plugin.
//
// Home-screen widgets are rendered by the launcher, in a process that has no
// WebView and therefore no access to IndexedDB, where the entire library
// lives. So the widget cannot query anything: the app pushes it a snapshot,
// and the widget renders that. Everything a widget needs must be added to
// the snapshot builder in ./snapshot.ts, never fetched natively.
//
// The reverse direction has the same constraint, which is why
// takePendingWatchActions() exists: a "watched" tap on the widget happens in
// the launcher process and cannot write Dexie. Native queues it and the web
// layer drains the queue on its next run. See ./sync.ts.

import { Capacitor, registerPlugin } from "@capacitor/core";
import { parseDeepLinkTarget, requestDeepLink } from "../deepLink";
import type { WidgetSnapshot } from "./snapshot";

/** One episode the user ticked from the widget, awaiting a write into Dexie. */
export interface PendingWatchAction {
  showId: number;
  episodeKey: string;
  seasonNumber: number;
  episodeNumber: number;
  /** Epoch millis of the tap, so the recorded watch time is when they tapped, not when the app next opened. */
  tappedAt: number;
}

export interface WidgetBridgePlugin {
  /** Replaces the stored snapshot and asks every placed widget to redraw. */
  updateSnapshot(options: { snapshot: string }): Promise<void>;
  /** Returns and CLEARS the queue of widget-originated watch taps. */
  takePendingWatchActions(): Promise<{ actions: PendingWatchAction[] }>;
  /** Whether the user actually has at least one widget placed, so the app can skip snapshot work entirely. */
  hasPlacedWidgets(): Promise<{ placed: boolean }>;
  /**
   * Returns and CLEARS the target of the widget row the user tapped to get
   * here, if any. Read rather than pushed as an event because the tap can
   * cold-start the app, in which case the event would fire long before any
   * JavaScript exists to hear it.
   */
  consumePendingDeepLink(): Promise<{ target: Record<string, unknown> | null }>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>("WidgetBridge");

export function widgetsSupported(): boolean {
  return Capacitor.getPlatform() === "android";
}

export async function pushSnapshot(snapshot: WidgetSnapshot): Promise<void> {
  if (!widgetsSupported()) return;
  try {
    await WidgetBridge.updateSnapshot({ snapshot: JSON.stringify(snapshot) });
  } catch {
    // A build without the plugin registered, or a launcher that rejected the
    // update. Widgets keep their previous snapshot, which is stale but valid;
    // failing here must never break the app screen that triggered it.
  }
}

export async function takePendingWatchActions(): Promise<PendingWatchAction[]> {
  if (!widgetsSupported()) return [];
  try {
    const result = await WidgetBridge.takePendingWatchActions();
    return result.actions ?? [];
  } catch {
    return [];
  }
}

export async function hasPlacedWidgets(): Promise<boolean> {
  if (!widgetsSupported()) return false;
  try {
    return (await WidgetBridge.hasPlacedWidgets()).placed;
  } catch {
    return false;
  }
}

/**
 * Delivers a pending widget tap into the app's deep-link store, if one is
 * waiting. Called at mount and on every resume, which covers both a cold
 * start from the launcher and a tap while the app was already backgrounded.
 */
export async function drainWidgetDeepLink(): Promise<void> {
  if (!widgetsSupported()) return;
  try {
    const { target } = await WidgetBridge.consumePendingDeepLink();
    const parsed = parseDeepLinkTarget(target);
    if (parsed) requestDeepLink(parsed);
  } catch {
    // No plugin, or nothing queued.
  }
}
