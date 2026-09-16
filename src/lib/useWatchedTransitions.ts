import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "./useAnimatedDismiss";
import type { WatchNextRow } from "./watchNext";

/**
 * The Up Next "marked watched" sequence:
 *
 *   tick -> the card turns translucent green, with a tick (or "That's all
 *           folks!" when the show has nothing left to watch)
 *        -> the card flips away
 *        -> the show's next episode flips in where it was, or the gap closes
 *        -> the list glides into its real order
 *
 * The watch is still written the instant the tick is tapped. This hook changes
 * only what the LIST shows while that write flows back through the live
 * queries. Without it, the rebuilt rows replaced the card in the same frame:
 * it jumped to the top (its show had just become the most recent), or
 * vanished, and every row between moved at once.
 *
 * It works by HOLDING the tapped card. For the length of the sequence the card
 * keeps its slot and keeps showing the episode that was tapped, while every
 * other row stays live. The hold is released once the card has flipped, and
 * the caller's `beforeLayoutChange` is called right before that release so the
 * move from the held slot to the real one can glide (see useFlipLayout).
 *
 * Nothing here decides anything about Watch Next. Which list a show belongs
 * in, and which episode it offers, are still buildWatchNextRows() reading the
 * database: the next episode that flips in IS the live row, and a card whose
 * show left this list (caught up, or started and so no longer "not started")
 * is simply not replaced. A held card is also never a copy of a live one — it
 * stands in for that show's row, so the same show cannot appear twice.
 */

/**
 * How long the green state holds before the flip starts: long enough for the
 * tick to pop in and be read, short enough that a binge is not slowed down.
 */
export const WATCHED_CONFIRM_MS = 460;
/** Must match .watch-next-row.is-flip-out in index.css. */
export const WATCHED_FLIP_OUT_MS = 200;
/** Must match .watch-next-row.is-flip-in in index.css. */
export const WATCHED_FLIP_IN_MS = 260;

/**
 * How long a card that has flipped away waits for the watch to reach the live
 * rows. A local IndexedDB write normally lands long before the flip even
 * starts; this exists so a write that fails can never leave a card edge-on.
 */
const WRITE_WAIT_LIMIT_MS = 2000;

export type WatchedPhase = "confirm" | "flip-out" | "flip-in";

export interface WatchedTransition {
  showId: number;
  /** The Up Next tab the card was marked in. A transition only renders there. */
  list: string;
  phase: WatchedPhase;
  /** The row as it was tapped, shown until the card has flipped away. */
  outgoing: WatchNextRow;
  /**
   * Whether the show still has an episode to watch after this one. The tick
   * says "watched, and there is more"; "That's all folks!" says there is not.
   * Decided at the tap (see hasNextAfterWatching) so the card can say it
   * before the write has landed.
   */
  hasNext: boolean;
  /** The position the card holds in the list until the sequence ends. */
  slot: number;
  /** Flipped edge-on, waiting for the recorded watch to show up in the rows. */
  flippedAway: boolean;
}

export interface DisplayRow {
  row: WatchNextRow;
  transition?: WatchedTransition;
}

/** The live rows with every held card put back in the slot it is holding. */
function withHeldCards(
  rows: WatchNextRow[],
  transitions: Map<number, WatchedTransition>,
  list: string
): DisplayRow[] {
  const held = [...transitions.values()].filter((t) => t.list === list).sort((a, b) => a.slot - b.slot);
  if (held.length === 0) return rows.map((row) => ({ row }));

  const heldIds = new Set(held.map((t) => t.showId));
  const display: DisplayRow[] = rows.filter((row) => !heldIds.has(row.showId)).map((row) => ({ row }));
  for (const t of held) {
    let row = t.outgoing;
    if (t.phase === "flip-in") {
      // The incoming side is the live row itself, never the stored copy. If the
      // show has gone from the list mid-flip there is nothing true to show, so
      // it is not shown; the effect below ends the transition.
      const live = rows.find((r) => r.showId === t.showId);
      if (!live) continue;
      row = live;
    }
    display.splice(Math.min(t.slot, display.length), 0, { row, transition: t });
  }
  return display;
}

export function useWatchedTransitions({
  list,
  rows,
  beforeLayoutChange,
}: {
  /** Which list `rows` is. Changing it (a tab switch) should go with reset(). */
  list: string;
  /** The live rows for that list, in display order. */
  rows: WatchNextRow[];
  /** Called immediately before a card is released or removed. */
  beforeLayoutChange: () => void;
}) {
  const [transitions, setTransitions] = useState<Map<number, WatchedTransition>>(() => new Map());
  const display = useMemo(() => withHeldCards(rows, transitions, list), [rows, transitions, list]);

  // Timers and handlers need what is on screen NOW, not what was on screen in
  // the render that scheduled them.
  const latest = useRef({ display, beforeLayoutChange });
  useLayoutEffect(() => {
    latest.current = { display, beforeLayoutChange };
  });

  // Which cards are mid-sequence, updated synchronously. State would only
  // catch up on the next commit, and two presses inside one frame would
  // otherwise both start, recording the next episode as well.
  const active = useRef(new Set<number>());
  const timers = useRef(new Map<number, number[]>());

  const clearTimers = useCallback((showId: number) => {
    for (const id of timers.current.get(showId) ?? []) window.clearTimeout(id);
    timers.current.delete(showId);
  }, []);

  const after = useCallback((showId: number, ms: number, fn: () => void) => {
    const id = window.setTimeout(fn, ms);
    timers.current.set(showId, [...(timers.current.get(showId) ?? []), id]);
  }, []);

  const patch = useCallback((showId: number, changes: Partial<WatchedTransition>) => {
    setTransitions((prev) => {
      const current = prev.get(showId);
      return current ? new Map(prev).set(showId, { ...current, ...changes }) : prev;
    });
  }, []);

  const finish = useCallback(
    (showId: number) => {
      clearTimers(showId);
      if (!active.current.delete(showId)) return;
      latest.current.beforeLayoutChange();
      setTransitions((prev) => {
        if (!prev.has(showId)) return prev;
        const next = new Map(prev);
        next.delete(showId);
        return next;
      });
    },
    [clearTimers]
  );

  const start = useCallback(
    (row: WatchNextRow, hasNext: boolean, write: () => Promise<void>) => {
      const { showId } = row;
      // One sequence per card. The card ignores pointers while it plays; this
      // covers a keyboard press on the still-focused tick.
      if (active.current.has(showId)) return;

      const recorded = write();

      // Same rule as useAnimatedDismiss: with motion reduced the CSS durations
      // collapse to ~0, so holding the card would be a delay with nothing in
      // it. The list updates the moment the write lands, as it always did.
      if (prefersReducedMotion()) return;

      active.current.add(showId);
      const slot = latest.current.display.findIndex((d) => d.row.showId === showId);
      setTransitions((prev) =>
        new Map(prev).set(showId, {
          showId,
          list,
          phase: "confirm",
          outgoing: row,
          hasNext,
          slot: Math.max(0, slot),
          flippedAway: false,
        })
      );
      after(showId, WATCHED_CONFIRM_MS, () => patch(showId, { phase: "flip-out" }));
      after(showId, WATCHED_CONFIRM_MS + WATCHED_FLIP_OUT_MS, () => patch(showId, { flippedAway: true }));
      after(showId, WATCHED_CONFIRM_MS + WATCHED_FLIP_OUT_MS + WRITE_WAIT_LIMIT_MS, () => finish(showId));
      // A failed write puts the card straight back to what the database says.
      // The error still surfaces, as it did when the handler awaited it.
      recorded.catch((error) => {
        finish(showId);
        throw error;
      });
    },
    [list, after, patch, finish]
  );

  // The swap. Runs whenever the rows change as well as when a card finishes
  // flipping away, so it proceeds the moment BOTH are true: the card is
  // edge-on, and the watch is visible in the live rows.
  useEffect(() => {
    for (const t of transitions.values()) {
      if (t.list !== list) continue;
      const live = rows.find((r) => r.showId === t.showId);

      if (t.phase === "flip-in") {
        if (!live) finish(t.showId);
        continue;
      }
      if (!t.flippedAway) continue;

      // Still offering the episode that was tapped: the write has not reached
      // the rows yet. This effect runs again when it does.
      if (live && live.nextEpisode?.key === t.outgoing.nextEpisode?.key) continue;

      if (live) {
        // The show's next episode, in this same list: it flips in where the
        // watched one was, and the hold is released once it has.
        clearTimers(t.showId);
        patch(t.showId, { phase: "flip-in", flippedAway: false });
        after(t.showId, WATCHED_FLIP_IN_MS, () => finish(t.showId));
      } else {
        // Nothing to replace it with here: the show is caught up, or it has
        // moved to another list. The gap closes.
        finish(t.showId);
      }
    }
  }, [transitions, rows, list, clearTimers, patch, after, finish]);

  /** Drops every transition at once, for a tab switch. Writes already made stand. */
  const reset = useCallback(() => {
    for (const showId of [...timers.current.keys()]) clearTimers(showId);
    active.current.clear();
    setTransitions((prev) => (prev.size === 0 ? prev : new Map()));
  }, [clearTimers]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const ids of pending.values()) for (const id of ids) window.clearTimeout(id);
    };
  }, []);

  return { display, start, reset };
}
