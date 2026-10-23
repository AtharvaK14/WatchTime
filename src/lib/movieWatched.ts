// Marking a movie watched: the write, and what every list shows while it lands.
//
// The episode cards on Home have had a watched sequence for a while (see
// useWatchedTransitions): the card holds its place, turns translucent green
// with a tick, and only then leaves. Movies simply vanished from whatever list
// they were on, in the same frame as the tap. This is the movie version, built
// the way lib/libraryRemoval.ts builds the removal exit, because it is the same
// problem: every list reads the library through live queries, so the moment
// the write lands the movie is gone from (or moved within) the data, and a
// list that wants to show the user what happened has to hold the card.
//
//   tick -> the write lands -> green veil and a tick over the poster
//        -> the card leaves the list it no longer belongs on (or, where it
//           stays - Discover, For You, the Movies page's All filter - the veil
//           fades off it) -> the cards around it glide into place
//
// Nothing here decides where a movie belongs. Which lists show it is still
// each list's own query over the library (isOnWatchlist() for the watchlists),
// and the movie itself is never removed from the library: marking it watched
// sets `watched`, nothing else is deleted, and every list it now belongs to -
// the Movies page's Watched filter, for one - shows it as before.

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { db } from "../db";
import { libraryKey } from "./libraryRemoval";
import { requestNotificationSync } from "./notifications";
import { prefersReducedMotion } from "./useAnimatedDismiss";
import { WATCHED_CONFIRM_MS } from "./useWatchedTransitions";

// ---- The write ------------------------------------------------------------

/**
 * The one write path for a movie's watched flag. It used to be three, and
 * they disagreed: the Movies grid and the Home rail set only `watched`, while
 * the details panel also took the movie off the watchlist, and put it back
 * on when unmarked. So a movie unticked on the grid after being marked in the
 * panel ended up on neither list. Everyone uses the panel's rule now:
 *
 *  - watched: watched, dated now, and no longer wanted (it has been seen);
 *  - unwatched: undated, and back on the watchlist rather than stranded.
 *
 * Watch history the movie already has - rewatchCount - is left alone either
 * way, and nothing is ever deleted.
 *
 * Rejects if the movie is not in the library, or the stored row does not
 * read back as asked: the animation only plays for a write that is known to
 * have happened.
 */
export async function setMovieWatched(tmdbId: number, watched: boolean): Promise<void> {
  await db.movies.update(
    tmdbId,
    watched
      ? { watched: true, watchedAt: new Date().toISOString(), wantsToWatch: false }
      : { watched: false, watchedAt: null, wantsToWatch: true }
  );
  const stored = await db.movies.get(tmdbId);
  if (!stored) throw new Error("This movie is no longer in your library.");
  if (stored.watched !== watched) throw new Error("The change didn't save.");
  // A watched movie stops getting its theatrical notification (its digital
  // one stays); the schedule is rebuilt to match without waiting for a resume.
  requestNotificationSync();
}

// ---- The sequence ----------------------------------------------------------

/**
 * - saving: tapped on a card; the write is in flight. The card keeps its slot
 *   and takes no taps, and looks as it did - nothing claims success yet.
 * - held: marked in a details panel that is still open. Same hold; the card is
 *   under the panel, and plays the rest when the panel closes.
 * - confirm: the write landed. Green veil and tick over the poster.
 * - exit: the card leaves a list it no longer belongs on; a card that stays
 *   loses the veil. When this ends the entry is dropped.
 */
export type MovieWatchedPhase = "saving" | "held" | "confirm" | "exit";

/** Same acknowledgement length as an episode card's green state. */
export const MOVIE_WATCHED_CONFIRM_MS = WATCHED_CONFIRM_MS;
/** Must match .is-watched-exit in index.css (the removal exit's 240ms). */
export const MOVIE_WATCHED_EXIT_MS = 240;

let phases: ReadonlyMap<string, MovieWatchedPhase> = new Map();
const listeners = new Set<() => void>();
const timers = new Map<string, number[]>();

const keyFor = (tmdbId: number) => libraryKey("movie", tmdbId);

function clearTimers(key: string): void {
  for (const id of timers.get(key) ?? []) window.clearTimeout(id);
  timers.delete(key);
}

function setPhase(key: string, phase: MovieWatchedPhase | null): void {
  const next = new Map(phases);
  if (phase) next.set(key, phase);
  else next.delete(key);
  phases = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getPhases = () => phases;

/** Every movie currently mid-sequence, by libraryKey(). */
export function useMovieWatchedPhases(): ReadonlyMap<string, MovieWatchedPhase> {
  return useSyncExternalStore(subscribe, getPhases);
}

/**
 * Starts holding a movie's cards. Called BEFORE the write: the live queries
 * can deliver the updated lists before the write's own promise resolves, and
 * a list that has already re-rendered without the card has nothing to hold.
 */
export function holdMovieWatched(tmdbId: number, phase: "saving" | "held" = "held"): void {
  const key = keyFor(tmdbId);
  clearTimers(key);
  setPhase(key, phase);
}

/** Drops a hold without playing anything: the write failed, or it was undone in the panel. */
export function cancelMovieWatched(tmdbId: number): void {
  const key = keyFor(tmdbId);
  if (!phases.has(key)) return;
  clearTimers(key);
  setPhase(key, null);
}

/**
 * Plays the acknowledgement and the exit for a held movie. Idempotent:
 * anything not currently held is left alone.
 *
 * Reduced motion skips straight to the end, the same rule as the episode
 * sequence and the removal exit: the CSS durations are ~0 there, and waiting
 * them out would be a delay with nothing in it.
 */
export function playMovieWatched(tmdbId: number): void {
  const key = keyFor(tmdbId);
  const current = phases.get(key);
  if (current !== "saving" && current !== "held") return;
  if (prefersReducedMotion()) {
    setPhase(key, null);
    return;
  }
  setPhase(key, "confirm");
  const toExit = window.setTimeout(() => setPhase(key, "exit"), MOVIE_WATCHED_CONFIRM_MS);
  const toGone = window.setTimeout(() => {
    timers.delete(key);
    setPhase(key, null);
  }, MOVIE_WATCHED_CONFIRM_MS + MOVIE_WATCHED_EXIT_MS);
  timers.set(key, [toExit, toGone]);
}

/**
 * The tick on a movie card: write, then - only once it has landed - play the
 * sequence. A failed write releases the card exactly as the database has it
 * and rejects, so the caller can say what went wrong; nothing green is ever
 * shown for a change that did not happen.
 *
 * A second press while the first is still playing is ignored rather than
 * queued, the same as the episode cards.
 */
export async function markMovieWatchedFromCard(tmdbId: number): Promise<void> {
  if (phases.has(keyFor(tmdbId))) return;
  if (prefersReducedMotion()) {
    await setMovieWatched(tmdbId, true);
    return;
  }
  holdMovieWatched(tmdbId, "saving");
  try {
    await setMovieWatched(tmdbId, true);
  } catch (error) {
    cancelMovieWatched(tmdbId);
    throw error;
  }
  playMovieWatched(tmdbId);
}

// ---- The lists -------------------------------------------------------------

export interface WatchedSlot<T> {
  item: T;
  /** Set while this movie is mid-sequence. */
  watched?: MovieWatchedPhase;
  /**
   * Whether the card is still in this list's live data. A staying card shows
   * the acknowledgement and keeps its place; a held one leaves at "exit".
   */
  staying?: boolean;
}

/** The live items, with every card this list was showing for a mid-sequence movie put back in its slot. */
function withWatchedCards<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  pending: ReadonlyMap<string, MovieWatchedPhase>,
  previous: WatchedSlot<T>[]
): WatchedSlot<T>[] {
  const display: WatchedSlot<T>[] = items.map((item) => {
    const phase = pending.get(keyOf(item));
    return phase ? { item, watched: phase, staying: true } : { item };
  });
  if (pending.size === 0) return display;

  const live = new Set(items.map(keyOf));
  const held: { slot: number; entry: WatchedSlot<T> }[] = [];
  for (const [key, phase] of pending) {
    if (live.has(key)) continue;
    // Only a list that was actually showing the card holds it. One the movie
    // was never on - or one that only gains it now, like the Watched filter -
    // has nothing to put back.
    const slot = previous.findIndex((d) => keyOf(d.item) === key);
    if (slot === -1) continue;
    held.push({ slot, entry: { item: previous[slot].item, watched: phase, staying: false } });
  }
  held.sort((a, b) => a.slot - b.slot);
  for (const { slot, entry } of held) display.splice(Math.min(slot, display.length), 0, entry);
  return display;
}

/**
 * A list's items, with movies marked watched held in place until their
 * sequence has played. The movie counterpart of useRemovalExit, with the same
 * contract: `keyOf` returns libraryKey() and should be a stable module-level
 * function; `beforeLayoutChange` (useFlipLayout's capture) is called right
 * before a held card is dropped so the rest glide into the gap; `listId`
 * stops a card held in one tab of a list being put back into the next.
 */
export function useMovieWatchedExit<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  beforeLayoutChange?: () => void,
  listId?: string
): WatchedSlot<T>[] {
  const pending = useMovieWatchedPhases();
  const previous = useRef<{ listId: string | undefined; display: WatchedSlot<T>[] }>({ listId, display: [] });
  const display = useMemo(
    () =>
      withWatchedCards(items, keyOf, pending, previous.current.listId === listId ? previous.current.display : []),
    [items, keyOf, pending, listId]
  );

  const latest = useRef({ display, keyOf, beforeLayoutChange });
  useLayoutEffect(() => {
    previous.current = { listId, display };
    latest.current = { display, keyOf, beforeLayoutChange };
  });

  // Store listeners run synchronously, before React re-renders for the change,
  // so what is measured here is still the layout with the card in it.
  useEffect(
    () =>
      subscribe(() => {
        const { display, keyOf, beforeLayoutChange } = latest.current;
        if (!beforeLayoutChange) return;
        const leaving = display.some((d) => d.watched === "exit" && !d.staying && !phases.has(keyOf(d.item)));
        if (leaving) beforeLayoutChange();
      }),
    []
  );

  return display;
}

/** The is-watched-* classes for a card, or "" when it is not mid-sequence. */
export function watchedClass(phase: MovieWatchedPhase | undefined, staying: boolean | undefined): string {
  if (!phase) return "";
  return ` is-watched-${phase}${staying ? " is-watched-staying" : ""}`;
}
