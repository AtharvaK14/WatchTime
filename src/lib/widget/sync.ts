// Keeps the home-screen widgets and the app in step, in both directions.
//
// App -> widget: whenever the tables the snapshot is derived from change,
// a fresh snapshot is pushed and the widgets redraw. Because the source is a
// live query over the same tables Home reads, marking an episode watched in
// the app updates the widget without anything having to remember to call a
// refresh.
//
// Widget -> app: nothing needs replaying. A watch recorded from a widget
// happens in the episode overlay (EpisodePanelActivity), whose WebView is
// same-origin with the app and therefore writes the real IndexedDB directly,
// then pushes a fresh snapshot itself. The app simply sees the write, exactly
// as if it had been made in-app. There is deliberately no pending-action
// queue any more: the earlier row-level "mark watched" button had no way to
// reach the database from the launcher process and needed one, but that
// button is gone and a queue with no producer is just a trap.

import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { db } from "../../db";
import { drainWidgetDeepLink, hasPlacedWidgets, pushSnapshot } from "./bridge";
import { buildWidgetSnapshot } from "./snapshot";

/**
 * Rebuilding and serialising the snapshot walks every episode row, so it is
 * debounced: a bulk operation like "mark season watched" fires many Dexie
 * writes in quick succession and only the final state is worth pushing.
 */
const PUSH_DEBOUNCE_MS = 400;

/**
 * Mounted once from App. Does nothing at all on the web build, and nothing
 * beyond a single capability check on Android until the user actually places
 * a widget - the live queries below read whole tables, which is not a cost
 * worth paying for a feature nobody is using.
 */
export function useWidgetSync(): void {
  const [placed, setPlaced] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whether a widget exists can change while the app is open (the user drops
  // one on the home screen and comes back), so this is re-checked on resume
  // rather than only at mount. The same resume is the right moment to drain
  // taps that happened while we were backgrounded.
  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let cancelled = false;

    async function refresh() {
      // Deep links first: a tap that launched the app should open its panel
      // without waiting on the widget census.
      await drainWidgetDeepLink();
      const isPlaced = await hasPlacedWidgets();
      if (cancelled) return;
      setPlaced(isPlaced);
    }

    refresh();
    const handle = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) refresh();
    });

    return () => {
      cancelled = true;
      handle.then((h) => h.remove()).catch(() => {});
    };
  }, []);

  // Whole-table live queries, matching the pattern Home already uses: each is
  // independently reactive to writes on its own table, and the snapshot is
  // assembled synchronously from the results. Gated on `placed` so the query
  // resolves to null - and reads nothing - until a widget exists.
  const shows = useLiveQuery(async () => (placed ? await db.shows.toArray() : null), [placed]);
  const episodes = useLiveQuery(async () => (placed ? await db.episodes.toArray() : null), [placed]);
  const watched = useLiveQuery(async () => (placed ? await db.watchedEpisodes.toArray() : null), [placed]);
  const movies = useLiveQuery(async () => (placed ? await db.movies.toArray() : null), [placed]);

  useEffect(() => {
    if (!placed || !shows || !episodes || !watched || !movies) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pushSnapshot(buildWidgetSnapshot(shows, episodes, watched, movies));
    }, PUSH_DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [placed, shows, episodes, watched, movies]);
}
