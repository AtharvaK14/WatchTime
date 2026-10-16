// Removing a title from the library: the write, and the exit every list plays
// for it afterwards.
//
// The two live together because the second depends on exactly when the first
// succeeds. Removal is started from DetailsPanel, which every tab opens on top
// of its own list, so the card being removed is under the panel the whole
// time. The sequence the user sees is:
//
//   Remove -> the write lands -> the panel closes -> the card is briefly
//   highlighted -> it leaves its list -> the remaining cards close the gap
//
// Every list reads the library through live queries, so the moment the write
// lands the card's row is gone from the data. Left alone the card would vanish
// behind the panel and there would be nothing to highlight once it closed.
// The store below holds it: a list that was showing the card keeps showing it,
// in its slot, until its exit has played. It is the same move
// useWatchedTransitions makes for a watched episode, and for the same reason:
// the data is already true, and only what the list SHOWS waits.

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { db } from "../db";
import { prefersReducedMotion } from "./useAnimatedDismiss";

export type LibraryKind = "show" | "movie";

/** Show and movie TMDB ids are separate spaces and collide, so the kind is part of the key. */
export function libraryKey(kind: LibraryKind, tmdbId: number): string {
  return `${kind}:${tmdbId}`;
}

/**
 * Removes a title from the library.
 *
 * A show takes its watch history and its cached episode list with it: that is
 * the documented behaviour of this action ("Also deletes its watch history"),
 * and orphaned history would otherwise keep counting toward Episodes watched
 * and TV time for a show the library no longer has. Nothing else is touched -
 * not other titles, not import mappings, not the TMDB catalogue the title came
 * from, which can be added back from Discover at any time.
 *
 * One transaction, so it happens entirely or not at all. The three deletes
 * used to be separate awaits, and a failure part-way could delete a show's
 * history while leaving the show itself in the library. It also rejects,
 * rather than resolving quietly, if the title is somehow still there
 * afterwards, so the caller can never announce a removal that did not happen.
 */
export async function removeFromLibrary(kind: LibraryKind, tmdbId: number): Promise<void> {
  if (kind === "show") {
    await db.transaction("rw", db.shows, db.episodes, db.watchedEpisodes, async () => {
      await db.watchedEpisodes.where("showId").equals(tmdbId).delete();
      await db.episodes.where("showId").equals(tmdbId).delete();
      await db.shows.delete(tmdbId);
    });
  } else {
    await db.movies.delete(tmdbId);
  }
  const remaining = kind === "show" ? await db.shows.get(tmdbId) : await db.movies.get(tmdbId);
  if (remaining) throw new Error("The title is still in your library.");
}

// ---- The exit -------------------------------------------------------------

/**
 * - held: removed, panel still open. The card keeps its slot, looking as it
 *   did; nobody can see it under the panel, and it must still be there to
 *   highlight when the panel goes.
 * - highlight: the panel has closed; the card is marked so the user can see
 *   which one is leaving.
 * - exit: the card leaves. When this phase ends the entry is dropped and every
 *   list lets the card go, with the cards around it gliding into the gap.
 */
export type RemovalPhase = "held" | "highlight" | "exit";

/** Must match .is-removal-highlight in index.css. */
export const REMOVAL_HIGHLIGHT_MS = 560;
/** Must match .is-removal-exit in index.css. */
export const REMOVAL_EXIT_MS = 240;

let removals: ReadonlyMap<string, RemovalPhase> = new Map();
const listeners = new Set<() => void>();
const timers = new Map<string, number[]>();

function clearTimers(key: string): void {
  for (const id of timers.get(key) ?? []) window.clearTimeout(id);
  timers.delete(key);
}

function setPhase(key: string, phase: RemovalPhase | null): void {
  const next = new Map(removals);
  if (phase) next.set(key, phase);
  else next.delete(key);
  removals = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getRemovals = () => removals;

/** Every title currently mid-removal, by libraryKey(). */
export function useLibraryRemovals(): ReadonlyMap<string, RemovalPhase> {
  return useSyncExternalStore(subscribe, getRemovals);
}

/**
 * Starts holding a title's cards. Called BEFORE the delete is written: the
 * live queries can deliver the shorter list before the write's own promise
 * resolves, and a list that has already re-rendered without the card has
 * nothing left to hold. A failed write calls cancelRemoval(), so a hold never
 * outlives a removal that did not happen.
 */
export function holdRemoval(kind: LibraryKind, tmdbId: number): void {
  const key = libraryKey(kind, tmdbId);
  clearTimers(key);
  setPhase(key, "held");
}

/** Drops a hold without playing anything: the write failed, or the title was added back. */
export function cancelRemoval(kind: LibraryKind, tmdbId: number): void {
  const key = libraryKey(kind, tmdbId);
  if (!removals.has(key)) return;
  clearTimers(key);
  setPhase(key, null);
}

/**
 * Plays the highlight and the exit for a held title. Called when the panel it
 * was removed from closes. Idempotent: anything not currently held is left
 * alone, so a second close path (unmount after onClose) is a no-op.
 *
 * Reduced motion skips straight to the end, the same rule useAnimatedDismiss
 * and useWatchedTransitions follow: the CSS durations are ~0 there, and
 * waiting them out would be a delay with nothing in it.
 */
export function playRemoval(kind: LibraryKind, tmdbId: number): void {
  const key = libraryKey(kind, tmdbId);
  if (removals.get(key) !== "held") return;
  if (prefersReducedMotion()) {
    setPhase(key, null);
    return;
  }
  setPhase(key, "highlight");
  const toExit = window.setTimeout(() => setPhase(key, "exit"), REMOVAL_HIGHLIGHT_MS);
  const toGone = window.setTimeout(() => {
    timers.delete(key);
    setPhase(key, null);
  }, REMOVAL_HIGHLIGHT_MS + REMOVAL_EXIT_MS);
  timers.set(key, [toExit, toGone]);
}

export interface RemovalSlot<T> {
  item: T;
  /** Set while this card is mid-removal. Render the matching is-removal-* class. */
  removal?: RemovalPhase;
}

/** The live items, with every card this list was showing for a mid-removal title put back in its slot. */
function withRemovedCards<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  pending: ReadonlyMap<string, RemovalPhase>,
  previous: RemovalSlot<T>[]
): RemovalSlot<T>[] {
  const display: RemovalSlot<T>[] = items.map((item) => {
    // A card still in the live data while its title is highlighted belongs to
    // a list the title was never IN because of library membership - a
    // Discover or For You recommendation. It stays, and is marked so the
    // change is visible there too.
    const phase = pending.get(keyOf(item));
    return phase === "highlight" ? { item, removal: phase } : { item };
  });
  if (pending.size === 0) return display;

  const live = new Set(items.map(keyOf));
  const held: { slot: number; entry: RemovalSlot<T> }[] = [];
  for (const [key, phase] of pending) {
    if (live.has(key)) continue;
    // Only a list that was actually showing the card holds it. A list mounted
    // after the removal, or one filtered so the title was never on it, has
    // nothing to animate and nothing to put back.
    const slot = previous.findIndex((d) => keyOf(d.item) === key);
    if (slot === -1) continue;
    held.push({ slot, entry: { item: previous[slot].item, removal: phase } });
  }
  held.sort((a, b) => a.slot - b.slot);
  for (const { slot, entry } of held) display.splice(Math.min(slot, display.length), 0, entry);
  return display;
}

/**
 * A list's items, with removed titles held in place until their exit has
 * played.
 *
 * `keyOf` must return libraryKey() for the item's title, and should be a
 * stable function (a module-level one), since it is a memo dependency.
 *
 * `beforeLayoutChange` is called immediately before a held card is finally
 * dropped, so the caller can glide the remaining cards into the gap - pass
 * useFlipLayout's capture, with data-flip-key on the list's children.
 *
 * `listId` is for a component that shows different lists in one place (Up
 * Next's tabs): a card held in one list must not be put back into the next
 * one the user switches to while its exit is still playing.
 */
export function useRemovalExit<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  beforeLayoutChange?: () => void,
  listId?: string
): RemovalSlot<T>[] {
  const pending = useLibraryRemovals();
  const previous = useRef<{ listId: string | undefined; display: RemovalSlot<T>[] }>({ listId, display: [] });
  // Reading the previous commit's display is the point: it is where a card
  // that has just left the live data was, and what it looked like.
  const display = useMemo(
    () =>
      withRemovedCards(items, keyOf, pending, previous.current.listId === listId ? previous.current.display : []),
    [items, keyOf, pending, listId]
  );

  const latest = useRef({ display, keyOf, beforeLayoutChange });
  useLayoutEffect(() => {
    previous.current = { listId, display };
    latest.current = { display, keyOf, beforeLayoutChange };
  });

  // Store listeners run synchronously, before React has re-rendered for the
  // change, so the DOM measured here is still the one with the card in it.
  useEffect(
    () =>
      subscribe(() => {
        const { display, keyOf, beforeLayoutChange } = latest.current;
        if (!beforeLayoutChange) return;
        const leaving = display.some((d) => d.removal === "exit" && !removals.has(keyOf(d.item)));
        if (leaving) beforeLayoutChange();
      }),
    []
  );

  return display;
}

/** The is-removal-* class for a card, or "" when it is not mid-removal. */
export function removalClass(phase: RemovalPhase | undefined): string {
  return phase ? ` is-removal-${phase}` : "";
}
