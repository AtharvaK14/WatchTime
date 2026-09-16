// The one definition of "when did this episode become available", shared by
// everything that has an opinion about it.
//
// Before this module there were two: the notification scheduler decided an
// episode was worth announcing from its air date, and Home's Watch Next split
// decided a show was stale purely from how long ago the USER last watched
// something. Those two answers could contradict each other, and did: a show
// that had not been touched in two years would announce "Season 2 is now
// available" and then file every one of those episodes under "Haven't Watched
// For a While", because nothing in the categorisation looked at release state
// at all.
//
// Both sides now read the same three primitives from here:
//
//   - todayIso()             what day it is, in the user's own calendar
//   - hasConfirmedAirDate()  whether TMDB actually told us a date
//   - becameAvailableAt()    the moment an episode went from upcoming to watchable
//
// so "newly available" cannot mean one thing to a notification and another to
// a list. See also isAvailableToWatch()/findNextUpcoming() in episodeSync.ts,
// which answer the adjacent questions ("can it be watched at all", "what is
// still ahead") from the same field.

import type { Episode } from "../db";

/**
 * How long an episode counts as NEWLY available, in days.
 *
 * This is the window in which a release can pull a show back onto Watch Next
 * over the top of the inactivity rules. It is deliberately not the stale
 * threshold in showStatus.ts and does not change it: a show with nothing new
 * still goes stale on exactly the same day it always did.
 *
 * 45 matches HORIZON_DAYS in lib/notifications/events.ts, which is how far
 * ahead the scheduler looks. Tying the two together is the point rather than a
 * coincidence: every release that was close enough to earn a notification is
 * still inside this window when the user acts on it, so the notification and
 * the list cannot disagree about whether something is new. Past the window the
 * release genuinely is old news, and a show nobody watched in all that time
 * belongs under "Haven't Watched For a While" like any other dropped show.
 */
export const RELEASE_ACTIVATION_DAYS = 45;

/**
 * The current calendar day as YYYY-MM-DD, in LOCAL time rather than UTC.
 *
 * An episode airing "today" has to read as today for a user in UTC-5 at 9pm,
 * which toISOString() would call tomorrow. Lives here rather than in the
 * notification module it started in because release state is exactly what it
 * is for; notifications/events.ts re-exports it so its own callers are
 * unaffected.
 */
export function todayIso(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/** YYYY-MM-DD for `days` ago, same local-calendar basis as todayIso(). */
export function daysAgoIso(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return todayIso(d);
}

/**
 * Whether TMDB has actually given this episode an air date.
 *
 * A missing date is unknown, not "no". Which way that cuts depends on the
 * question being asked, and the two callers deliberately differ:
 *
 *  - isAvailableToWatch() treats unknown as AVAILABLE, because hiding an
 *    episode the user may well be able to watch is the worse failure (this is
 *    the Spider-Noir bug).
 *  - everything that CLAIMS something has just happened - a notification, or
 *    the newly-available gate below - requires a confirmed date, because an
 *    unknown date is not evidence of a release.
 */
export function hasConfirmedAirDate<T extends { airDate: string | null }>(
  ep: T
): ep is T & { airDate: string } {
  return ep.airDate !== null && ep.airDate !== "";
}

/**
 * The day an episode became watchable, or null when TMDB has not said.
 *
 * Specials (season 0) are excluded: they are not part of a season's run, and a
 * decade-old special that TMDB happens to date recently must not be read as a
 * show returning. The same exclusion is applied by the notification clusterer
 * and by ensureEpisodesCached, which never caches season 0 at all.
 */
export function becameAvailableAt(ep: Episode): string | null {
  if (ep.seasonNumber <= 0) return null;
  return hasConfirmedAirDate(ep) ? ep.airDate : null;
}

/**
 * Episodes that became available inside the activation window and are still
 * unwatched - "there is new content here that the user has not seen".
 *
 * Unwatched is part of the definition, not a filter on top of it: a user who
 * watched the premiere the day it dropped has nothing newly available waiting,
 * and their show is carried by the ordinary progression rules instead.
 */
export function newlyAvailableEpisodes(
  episodes: Episode[],
  watchedKeys: Set<string>,
  now = new Date()
): Episode[] {
  const today = todayIso(now);
  const windowStart = daysAgoIso(RELEASE_ACTIVATION_DAYS, now);
  return episodes.filter((ep) => {
    if (watchedKeys.has(ep.key)) return false;
    const at = becameAvailableAt(ep);
    // Strictly released: a future date is upcoming, not new.
    return at !== null && at <= today && at >= windowStart;
  });
}

/**
 * What a release means for a show the user has not touched in a while.
 *
 * `newlyAvailable` on its own is NOT enough to call a show active, and
 * treating it as though it were is a real failure mode: a long-running series
 * someone gave up on years ago still puts out an episode every week, and a
 * show whose next season arrives while two earlier ones sit unwatched has not
 * become interesting again either. Both would be pulled back onto Watch Next
 * by availability alone, alongside the returning series this is actually for.
 *
 * The signal that separates them is already in the data: WAS THE USER CAUGHT
 * UP WHEN THE NEW CONTENT ARRIVED. Someone who had watched everything released
 * and then saw a new season appear is following the show and waiting for it.
 * Someone with a backlog of older released episodes stopped, whatever has come
 * out since - the new episode is not what they would watch next, and the next
 * thing they would watch has been sitting there unwatched all along.
 *
 * It is a statement about the user's progress, not about elapsed time, so a
 * long break does not by itself count as giving up (an episode released while
 * you were away still reaches you, as long as you had finished the rest), and
 * it never changes any stored state - it only decides whether a release is
 * allowed to override the staleness rules.
 */
export interface ReactivationState {
  /** Unwatched episodes released inside the activation window. */
  newlyAvailable: Episode[];
  /**
   * Unwatched episodes that were already out BEFORE the newest arrivals -
   * the evidence that the user had stopped rather than was waiting. Empty for
   * a show they were caught up on.
   */
  backlog: Episode[];
  /** newlyAvailable.length > 0 && backlog.length === 0. */
  reactivates: boolean;
  /** Newest release among newlyAvailable, as YYYY-MM-DD; null when there are none. */
  newestAvailableAt: string | null;
}

/**
 * Unwatched episodes that became available strictly before `cutoff`.
 *
 * Only confirmed dates count, which matters here: an episode TMDB has not
 * dated is not evidence the user skipped anything, and counting it would
 * silently block a returning show from coming back over a gap in TMDB's data.
 * That is the same reading of a missing date as everywhere else in this file,
 * and the opposite of isAvailableToWatch(), which errs toward showing.
 */
export function backlogBefore(episodes: Episode[], watchedKeys: Set<string>, cutoff: string): Episode[] {
  return episodes.filter((ep) => {
    if (watchedKeys.has(ep.key)) return false;
    const at = becameAvailableAt(ep);
    return at !== null && at < cutoff;
  });
}

export function reactivationState(
  episodes: Episode[],
  watchedKeys: Set<string>,
  now = new Date()
): ReactivationState {
  const newlyAvailable = newlyAvailableEpisodes(episodes, watchedKeys, now);
  if (newlyAvailable.length === 0) {
    return { newlyAvailable, backlog: [], reactivates: false, newestAvailableAt: null };
  }

  // Measured from the EARLIEST of the new arrivals, not from the window's
  // start: what matters is whether the user was caught up at the moment this
  // run began. For a weekly show mid-season that is exactly right - having
  // watched last week's episode, this week's arrives with no backlog behind
  // it, and progression continues one episode at a time.
  let earliest: string | null = null;
  for (const ep of newlyAvailable) {
    const at = becameAvailableAt(ep);
    if (at !== null && (earliest === null || at < earliest)) earliest = at;
  }

  const backlog = earliest === null ? [] : backlogBefore(episodes, watchedKeys, earliest);
  return {
    newlyAvailable,
    backlog,
    reactivates: backlog.length === 0,
    newestAvailableAt: newestAvailabilityAt(newlyAvailable),
  };
}

/**
 * The most recent release date among an episode list, or null when none of
 * them qualifies. Used as the show's "something happened here" timestamp so a
 * returning show sorts by when it RETURNED rather than by watch history that
 * may be years old.
 */
export function newestAvailabilityAt(episodes: Episode[]): string | null {
  let max: string | null = null;
  for (const ep of episodes) {
    const at = becameAvailableAt(ep);
    if (at !== null && (max === null || at > max)) max = at;
  }
  return max;
}

/**
 * An air date (YYYY-MM-DD) as a comparable ISO timestamp.
 *
 * Watch history is stored as a full timestamp and release dates only carry a
 * day, so anything comparing the two has to agree on how to widen the day.
 * Midnight UTC is the honest reading of a date-only value and, critically,
 * sorts before every timestamp recorded later that same day - so watching an
 * episode on its release day still counts as the more recent event.
 */
export function airDateAsTimestamp(airDate: string): string {
  return `${airDate}T00:00:00.000Z`;
}
