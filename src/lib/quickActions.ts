// Which Quick Actions an item offers, decided in one place from its current
// state. Pure, so the rules can be checked by `npm run check:watch-history`
// and so no screen can offer an action the item's state does not allow.
//
// Each id maps to an existing operation (see lib/watchEvents.ts,
// lib/stoppedWatching.ts, lib/libraryRemoval.ts, lib/movieWatched.ts,
// lib/library.ts); this module only decides availability and wording.

export type QuickActionId =
  | "view-details"
  | "mark-watched"
  | "watched-again"
  | "mark-unwatched"
  | "resume"
  | "stop"
  | "add"
  | "remove"
  | "history"
  | "season-details"
  | "episode-details"
  | "watched-once"
  | "remove-last"
  | "not-watched";

/** One entry in a menu. `danger` entries are drawn last, behind a separator. */
export interface QuickActionSpec {
  id: QuickActionId;
  label: string;
  danger?: boolean;
  /** Asks before running: the action discards history in bulk. */
  confirm?: boolean;
  /** Describes the current state rather than changing it (drawn with a check). */
  checked?: boolean;
}

/**
 * The choices behind a watched title's indicator - the green tick or its
 * viewing count - for episodes and movies alike, so the two cannot drift.
 *
 * Reducing a count and unwatching are separate entries on purpose: "Remove
 * last viewing" undoes only the most recent rewatch and leaves the title
 * watched, while "Not watched" takes it back to unwatched. "Watched once" is
 * the current state at one viewing, is left out at two (where it would do the
 * same as "Remove last viewing"), and resets several rewatches at once from
 * three on.
 */
export function viewingStatusActions(count: number): QuickActionSpec[] {
  const actions: QuickActionSpec[] = [];
  if (count === 1 || count >= 3) actions.push({ id: "watched-once", label: "Watched once", checked: count === 1 });
  actions.push({ id: "watched-again", label: "Watched again" });
  if (count >= 2) actions.push({ id: "remove-last", label: "Remove last viewing" });
  actions.push({ id: "not-watched", label: "Not watched", danger: true });
  return actions;
}

export interface ShowActionState {
  inLibrary: boolean;
  stopped: boolean;
  /** Unique episodes with a watch row. */
  watchedEpisodes: number;
  /** Released episodes not yet watched; null when the episode list is not cached, so it is unknown. */
  releasedUnwatched: number | null;
}

export function showActions(s: ShowActionState): QuickActionSpec[] {
  if (!s.inLibrary) {
    return [
      { id: "view-details", label: "View details" },
      { id: "add", label: "Add to Shows" },
    ];
  }
  const actions: QuickActionSpec[] = [{ id: "view-details", label: "View details" }];
  // Unknown counts as "maybe": marking syncs the episode list first, and a
  // show with nothing left simply reports that.
  if (s.releasedUnwatched === null || s.releasedUnwatched > 0) actions.push({ id: "mark-watched", label: "Mark as watched" });
  actions.push(s.stopped ? { id: "resume", label: "Resume watching" } : { id: "stop", label: "Stop watching" });
  if (s.watchedEpisodes > 0) {
    actions.push({ id: "history", label: "View watch history" });
    actions.push({ id: "mark-unwatched", label: "Mark as unwatched", danger: true, confirm: true });
  }
  actions.push({ id: "remove", label: "Remove from Shows", danger: true, confirm: true });
  return actions;
}

export interface MovieActionState {
  inLibrary: boolean;
  watched: boolean;
  /** Total viewings; 0 when unwatched. */
  watchCount?: number;
}

export function movieActions(s: MovieActionState): QuickActionSpec[] {
  const actions: QuickActionSpec[] = [{ id: "view-details", label: "View details" }];
  if (!s.inLibrary) {
    // The same pair the details panel offers a title outside the library.
    actions.push({ id: "mark-watched", label: "Mark as watched" });
    actions.push({ id: "add", label: "Add to Movies" });
    return actions;
  }
  if (s.watched) {
    actions.push({ id: "watched-again", label: "Watched again" });
    if ((s.watchCount ?? 1) >= 2) actions.push({ id: "remove-last", label: "Remove last viewing" });
    actions.push({ id: "history", label: "View watch history" });
    actions.push({ id: "mark-unwatched", label: "Mark as unwatched", danger: true });
  } else {
    actions.push({ id: "mark-watched", label: "Mark as watched" });
  }
  actions.push({ id: "remove", label: "Remove from Movies", danger: true, confirm: true });
  return actions;
}

export interface SeasonActionState {
  inLibrary: boolean;
  /** Episodes in the season (as cached). */
  total: number;
  /** Of those, watched at least once. */
  watched: number;
}

/**
 * A partially watched season offers "Mark season as watched" (to finish it)
 * and never "watched again": watching it again is only a thing once it has
 * been watched through, the same rule as its season watch count.
 */
export function seasonActions(s: SeasonActionState): QuickActionSpec[] {
  const details: QuickActionSpec = { id: "season-details", label: "View season details" };
  if (!s.inLibrary || s.total === 0) return [details];
  const actions: QuickActionSpec[] = [];
  if (s.watched === s.total) actions.push({ id: "watched-again", label: "Mark season as watched again" });
  else actions.push({ id: "mark-watched", label: "Mark season as watched" });
  actions.push(details);
  if (s.watched > 0) actions.push({ id: "mark-unwatched", label: "Mark season as unwatched", danger: true });
  return actions;
}

export interface EpisodeActionState {
  inLibrary: boolean;
  /** 0 = never watched. */
  watchCount: number;
}

export function episodeActions(s: EpisodeActionState): QuickActionSpec[] {
  const details: QuickActionSpec = { id: "episode-details", label: "View episode details" };
  if (!s.inLibrary) return [details];
  if (s.watchCount === 0) return [{ id: "mark-watched", label: "Mark as watched" }, details];
  return [
    { id: "watched-again", label: "Watched again" },
    ...(s.watchCount >= 2 ? [{ id: "remove-last" as const, label: "Remove last viewing" }] : []),
    details,
    { id: "mark-unwatched", label: "Mark as unwatched", danger: true },
  ];
}
