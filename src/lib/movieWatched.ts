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
import { recordMovieRewatch, removeLatestMovieViewing, setMovieWatchedOnce } from "./watchEvents";
import { movieWatchCount } from "./watchHistory";

// ---- The write ------------------------------------------------------------

/**
 * The one write path for a movie's watched flag. It used to be three, and
 * they disagreed: the Movies grid and the Home rail set only `watched`, while
 * the details panel also took the movie off the watchlist, and put it back
 * on when unmarked. So a movie unticked on the grid after being marked in the
 * panel ended up on neither list. Everyone uses the panel's rule now:
 *
 *  - watched: watched, dated now, and no longer wanted (it has been seen);
 *  - unwatched: no viewings, and back on the watchlist rather than stranded.
 *
 * "Not watched" means zero viewings, the same as for an episode (whose watch
 * row is deleted). It used to leave rewatchCount (and later firstWatchedAt)
 * in place, which was invisible while the app showed no counts; with the
 * count now ON the indicator, a movie watched three times, marked not
 * watched and then watched again would have come back as "3" with a first
 * viewing from before it was unwatched. A movie marked watched again starts
 * from one viewing. The movie itself always stays in the library.
 *
 * Resolves to the viewings the stored row now holds (0 once unwatched), read
 * back from the same row the check below uses, so a card's acknowledgement
 * needs no second read queued behind every list's re-query of the library.
 *
 * Rejects if the movie is not in the library, or the stored row does not
 * read back as asked: the animation only plays for a write that is known to
 * have happened.
 */
export async function setMovieWatched(tmdbId: number, watched: boolean): Promise<number> {
  await db.movies.update(
    tmdbId,
    watched
      ? { watched: true, watchedAt: new Date().toISOString(), wantsToWatch: false }
      : {
          watched: false,
          watchedAt: null,
          wantsToWatch: true,
          rewatchCount: 0,
          firstWatchedAt: undefined,
          latestBeforeRewatch: undefined,
        }
  );
  const stored = await db.movies.get(tmdbId);
  if (!stored) throw new Error("This movie is no longer in your library.");
  if (stored.watched !== watched) throw new Error("The change didn't save.");
  // A watched movie stops getting its theatrical notification (its digital
  // one stays); the schedule is rebuilt to match without waiting for a resume.
  requestNotificationSync();
  return movieWatchCount(stored);
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

/**
 * What the acknowledgement says, decided by what was written:
 *  - watched: green veil, the tick for one viewing, the count for more;
 *  - decrement: "-1" over the poster, after which the card's indicator shows
 *    the new count (or the tick, back at one viewing);
 *  - unwatched: red veil and a red X. The movie is still in the library; the
 *    card only leaves a list (the Watched filter) it no longer belongs on.
 */
export type MovieMark =
  | { kind: "watched"; count: number }
  | { kind: "decrement"; count: number }
  | { kind: "unwatched" };

/** Same acknowledgement length as an episode card's green state. */
export const MOVIE_WATCHED_CONFIRM_MS = WATCHED_CONFIRM_MS;
/** Must match .is-watched-exit in index.css (the removal exit's 240ms). */
export const MOVIE_WATCHED_EXIT_MS = 240;

let phases: ReadonlyMap<string, MovieWatchedPhase> = new Map();
// Set when a sequence starts playing, dropped with its phase. Read at render
// time by MovieWatchedOverlay; every change to it comes with a phase change,
// which is what re-renders the cards.
const marks = new Map<string, MovieMark>();
const listeners = new Set<() => void>();
const timers = new Map<string, number[]>();

const keyFor = (tmdbId: number) => libraryKey("movie", tmdbId);

/** The acknowledgement a movie's card is showing, if any. */
export function movieMarkFor(tmdbId: number): MovieMark | undefined {
  return marks.get(keyFor(tmdbId));
}

function clearTimers(key: string): void {
  for (const id of timers.get(key) ?? []) window.clearTimeout(id);
  timers.delete(key);
}

function setPhase(key: string, phase: MovieWatchedPhase | null): void {
  const next = new Map(phases);
  if (phase) next.set(key, phase);
  else {
    next.delete(key);
    marks.delete(key);
  }
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
export function playMovieWatched(tmdbId: number, mark: MovieMark = { kind: "watched", count: 1 }): void {
  const key = keyFor(tmdbId);
  const current = phases.get(key);
  if (current !== "saving" && current !== "held") return;
  if (prefersReducedMotion()) {
    setPhase(key, null);
    return;
  }
  marks.set(key, mark);
  setPhase(key, "confirm");
  const toExit = window.setTimeout(() => setPhase(key, "exit"), MOVIE_WATCHED_CONFIRM_MS);
  const toGone = window.setTimeout(() => {
    timers.delete(key);
    setPhase(key, null);
  }, MOVIE_WATCHED_CONFIRM_MS + MOVIE_WATCHED_EXIT_MS);
  timers.set(key, [toExit, toGone]);
}

/**
 * Every viewing change made on a movie card - the tick, its viewing-status
 * menu, and Quick Actions - runs through here: hold the card, write, and only
 * once the write has landed play the acknowledgement it earned. A failed write
 * releases the card exactly as the database has it and rejects, so the caller
 * can say what went wrong; nothing is ever shown for a change that did not
 * happen.
 *
 * A second press while a card's sequence is still playing is ignored rather
 * than queued, the same as the episode cards, and resolves false so callers
 * do not report a change that was not made.
 */
async function runCardSequence(tmdbId: number, write: () => Promise<MovieMark>): Promise<boolean> {
  if (phases.has(keyFor(tmdbId))) return false;
  if (prefersReducedMotion()) {
    await write();
    return true;
  }
  holdMovieWatched(tmdbId, "saving");
  let mark: MovieMark;
  try {
    mark = await write();
  } catch (error) {
    cancelMovieWatched(tmdbId);
    throw error;
  }
  playMovieWatched(tmdbId, mark);
  return true;
}

/** The tick on an unwatched movie's card. Green veil with the tick (or the count, if earlier viewings were kept). */
export function markMovieWatchedFromCard(tmdbId: number): Promise<boolean> {
  return runCardSequence(tmdbId, async () => ({ kind: "watched", count: await setMovieWatched(tmdbId, true) }));
}

/** "Not watched": red veil and a red X, then the card leaves a watched-only list. It stays in the library. */
export function markMovieUnwatchedFromCard(tmdbId: number): Promise<boolean> {
  return runCardSequence(tmdbId, async () => {
    await setMovieWatched(tmdbId, false);
    return { kind: "unwatched" };
  });
}

/** "Watched again": green veil with the new viewing count. */
export function rewatchMovieFromCard(tmdbId: number): Promise<boolean> {
  return runCardSequence(tmdbId, async () => ({ kind: "watched", count: await recordMovieRewatch(tmdbId) }));
}

/** "Remove last viewing": "-1", then the card's indicator shows the new count (the tick at one). */
export function removeLatestMovieViewingFromCard(tmdbId: number): Promise<boolean> {
  return runCardSequence(tmdbId, async () => ({ kind: "decrement", count: await removeLatestMovieViewing(tmdbId) }));
}

/** "Watched once": green veil with the tick. */
export function setMovieWatchedOnceFromCard(tmdbId: number): Promise<boolean> {
  return runCardSequence(tmdbId, async () => ({ kind: "watched", count: await setMovieWatchedOnce(tmdbId) }));
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
