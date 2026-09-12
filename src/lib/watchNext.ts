// The three mutually-exclusive Home categories.
//
// This logic used to live inline inside ShowsHome's useMemo in
// pages/Home.tsx. It moved here so mood search could filter the same list
// rather than fork it. Behaviour is unchanged by the extraction: the
// categorisation rules, the sort comparators, and the null "caught up" case
// are the same code, and the filter parameter is optional so calling it
// without one produces exactly the previous result.
//
// Note for anyone reconciling this with pages/Diagnostics.tsx: that file has
// its own watchNextVerdict(), deliberately left in place. It applies the same
// rules but its job is to emit a human-readable explanation of WHY a single
// show landed where it did, which is a different output shape from building
// the list. Worth collapsing one day, out of scope here.

import type { Episode, Show, WatchedEpisode } from "../db";
import { countAdditionalUnwatched, findNextUnwatched } from "./episodeSync";
import { airDateAsTimestamp, reactivationState } from "./releaseState";
import { isStoppedWatching } from "./stoppedWatching";
import { daysSince } from "./showStatus";
import { lastProgressionAt } from "./watchEvents";
import { matchesMoodFilter, showToMoodCandidate, type MoodFilter } from "./moodSearch/search";

export type Category = "watch-next" | "stale" | "not-started" | "stopped";

export interface WatchNextRow {
  showId: number;
  showName: string;
  posterPath: string | null;
  nextEpisode: Episode | null; // for not-started: the first episode to start with; for in-progress: the next unseen one. Null when nothing is cached yet.
  additionalCount: number; // the "+N" badge
  lastProgressedAt: string | null; // most recent first-watch of an unseen episode; half of the split, and rewatch-proof
  /**
   * True when the show has at least one unwatched episode that became
   * available inside the activation window (see lib/releaseState.ts) - a
   * season that just dropped, or this week's episode of a returning show.
   *
   * This is what stops a returning series from being filed as stale, and the
   * "NEW" tag on Home reads straight off it, so the reason a long-dormant
   * show reappeared is visible rather than mysterious.
   */
  newlyAvailable: boolean;
  /** The newest such release, as YYYY-MM-DD. Null when nothing is newly available. */
  newlyAvailableAt: string | null;
  /**
   * True when a release was found but did NOT reactivate the show, because
   * older released episodes are still unwatched.
   *
   * Carried so the Stopped and stale lists can say WHY a show with new
   * episodes is not in Watch Next — otherwise the honest answer ("you never
   * finished what was already out") is invisible and the categorisation looks
   * like the bug it used to be.
   */
  releasedButBehind: boolean;
  /**
   * The most recent thing that happened to this show: the later of the user's
   * last progression and its newest release. Drives the Watch Next ordering,
   * so a show that just returned is not buried underneath shows the user
   * happened to watch more recently.
   */
  activityAt: string | null;
  addedAt: string; // for ordering the "Haven't Yet Started" list (recently added first)
  category: Category;
}

/**
 * The three mutually-exclusive Home categories, driven purely by real watch
 * data (not the imported tvTimeStatus snapshot, which goes stale the moment
 * you watch anything in-app):
 *
 * - "stopped": the user said they are done with this one. Checked FIRST and
 *   it wins over everything below, including a brand-new season. See
 *   Show.isArchived.
 * - "not-started": zero watch activity ever. A show added to the library
 *   but never begun. Its own section so a long watchlist doesn't crowd out
 *   shows you're actually mid-way through.
 * - "watch-next": at least one episode watched AND a next UNSEEN released
 *   episode exists AND either the last PROGRESSION is within the threshold
 *   (in progress and active) or something new has just become available.
 * - "stale": same as watch-next but the last progression is older than the
 *   threshold AND nothing has become available recently. Started, then
 *   genuinely dropped, and nothing since has changed that.
 * - null (not shown): watched at least one episode but no next unseen
 *   episode remains, i.e. caught up / finished. Rewatching an old episode
 *   updates history/time/recency but must NEVER resurface the show here:
 *   "next" is always the next UNSEEN episode in original progression, never
 *   "the episode after a rewatch". A finished series simply stays off all
 *   three lists.
 *
 * CRITICAL: the split uses last PROGRESSION (the most recent first-watch of
 * a previously-unseen episode), NOT last activity. Rewatching already-seen
 * episodes of a stalled show must not drag it back into Watch Next. Only
 * watching the next NEW episode counts as resuming. lastProgressedAt is
 * max(WatchedEpisode.watchedAt), which a rewatch never changes.
 *
 * The tvTimeStatus === "continuing" clause was deliberately dropped: it
 * could force a finished show (all cached episodes watched, next === null)
 * back onto Watch Next via a stale imported flag, which is exactly the
 * rewatch-resurfacing this spec forbids.
 *
 * NEWLY AVAILABLE OUTRANKS STALE, BUT ONLY FOR A SHOW THE USER WAS KEEPING UP
 * WITH. `reactivates` is the release-state gate (lib/releaseState.ts) and it
 * is checked BEFORE the inactivity comparison, not folded into it. A show
 * whose season 2 dropped last week is not stale, however long ago season 1 was
 * watched - watch history says nothing about content that did not exist when
 * the user stopped watching. This is deliberately not the same as widening the
 * threshold: a show with nothing new still crosses into "stale" on exactly the
 * day it always did.
 *
 * What `reactivates` adds over "something came out" is the other half of the
 * question: was the user CAUGHT UP when it did. A show with older released
 * episodes still unwatched is one they stopped, and a new season does not
 * change that - the thing they would watch next has been waiting all along and
 * they have not watched it. That show stays exactly where the inactivity rules
 * put it. See reactivationState() for the full reasoning.
 *
 * What it does NOT do is change which episode is offered. That is still
 * findNextUnwatched() walking original progression, so a returning show whose
 * user stopped at S01E08 comes back pointing at S01E09, not at the premiere
 * of the new season. Release state decides whether a show is ACTIVE; watch
 * history decides WHERE IN IT the user is. The two answer different questions
 * and neither overrides the other.
 *
 * "not-started" is checked before the release gate and is deliberately
 * untouched by it. A show that has never been begun is not a show the user is
 * progressing through, and a new season does not change that - it stays in
 * its own tab rather than being promoted into Watch Next.
 *
 * "stopped" is checked before everything, including the caught-up case, so a
 * show the user has finished AND stopped still appears under Stopped Watching
 * rather than vanishing - that tab is where they would go to undo it.
 */
export function categorize(
  next: Episode | null,
  watchedCount: number,
  lastProgressedAt: string | null,
  threshold: number,
  reactivates = false,
  stopped = false
): Category | null {
  if (stopped) return "stopped"; // explicit, and beats every automatic rule below
  if (watchedCount === 0) return "not-started";
  if (next === null) return null; // caught up / finished; rewatches don't bring it back
  if (reactivates) return "watch-next"; // a release, to someone who was keeping up
  return (daysSince(lastProgressedAt) ?? 0) < threshold ? "watch-next" : "stale";
}

/**
 * Builds the Home rows.
 *
 * `filter` is optional and additive: it only ever removes rows that the
 * unfiltered computation would have produced. Categorisation happens first
 * and is never influenced by it, so a filtered list is a strict subset of
 * the real one and a show can never be moved between tabs by a search.
 */
export function buildWatchNextRows(
  shows: Show[],
  allEpisodes: Episode[],
  allWatched: WatchedEpisode[],
  staleThreshold: number,
  filter?: MoodFilter | null,
  now = new Date()
): WatchNextRow[] {
  const episodesByShow = new Map<number, Episode[]>();
  for (const ep of allEpisodes) {
    const list = episodesByShow.get(ep.showId);
    if (list) list.push(ep);
    else episodesByShow.set(ep.showId, [ep]);
  }
  const watchedByShow = new Map<number, WatchedEpisode[]>();
  for (const w of allWatched) {
    const list = watchedByShow.get(w.showId);
    if (list) list.push(w);
    else watchedByShow.set(w.showId, [w]);
  }

  const result: WatchNextRow[] = [];
  for (const show of shows) {
    if (filter && !matchesMoodFilter(showToMoodCandidate(show), filter)) continue;

    const episodes = episodesByShow.get(show.tmdbId) ?? [];
    const watched = watchedByShow.get(show.tmdbId) ?? [];
    const watchedKeys = new Set(watched.map((w) => w.key));
    // next = the first UNSEEN released episode in original progression.
    // For a never-started show this is the first episode (the one to
    // begin with); for an in-progress show it's the genuine next up.
    // Rewatches never enter this: watched episodes stay in watchedKeys,
    // so "next" only ever moves forward through unseen episodes.
    const next = findNextUnwatched(episodes, watchedKeys);
    // Split by last PROGRESSION, not last activity: a rewatch never
    // changes watchedAt, so rewatching a stalled show leaves this stuck
    // in the past and the show stays under "Haven't Watched For a While".
    const lastProgressedAt = lastProgressionAt(watched);
    // Release state, read from the same db.episodes rows the notification
    // scheduler reads: what has just come out, and whether the user was caught
    // up when it did.
    const release = reactivationState(episodes, watchedKeys, now);
    const category = categorize(
      next,
      watchedKeys.size,
      lastProgressedAt,
      staleThreshold,
      release.reactivates,
      isStoppedWatching(show)
    );
    if (category === null) continue; // caught up / finished

    result.push({
      showId: show.tmdbId,
      showName: show.name,
      posterPath: show.posterPath,
      nextEpisode: next,
      additionalCount: next ? countAdditionalUnwatched(episodes, watchedKeys) : 0,
      lastProgressedAt,
      // The NEW tag marks a release the user can act on, so it follows
      // `reactivates` rather than "an episode came out": on a show they had
      // stopped keeping up with, the new episode is not what the row offers
      // and tagging it NEW would point at the wrong thing.
      newlyAvailable: release.reactivates,
      newlyAvailableAt: release.reactivates ? release.newestAvailableAt : null,
      releasedButBehind: release.newlyAvailable.length > 0 && !release.reactivates,
      activityAt: mostRecent(
        lastProgressedAt,
        release.reactivates && release.newestAvailableAt ? airDateAsTimestamp(release.newestAvailableAt) : null
      ),
      addedAt: show.addedAt,
      category,
    });
  }
  return result;
}

/** The later of two ISO instants, tolerating nulls on either side. */
function mostRecent(a: string | null, b: string | null | undefined): string | null {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Most recent ACTIVITY first, where activity is the later of "the user
 * progressed" and "an episode was released".
 *
 * It used to be progression alone, which read correctly until release state
 * started moving shows: a series returning after two years would arrive on
 * Watch Next carrying a two-year-old progression date and sort to the very
 * bottom of the list - present, but below everything the user had touched
 * since, which for the show the notification was about is barely different
 * from missing.
 *
 * Rewatches still never reorder anything: neither half of activityAt moves
 * when an already-seen episode is watched again.
 */
export const byRecency = (a: WatchNextRow, b: WatchNextRow) =>
  (b.activityAt ?? "").localeCompare(a.activityAt ?? "");

/** Most recently added to the library first. */
export const byAddedAt = (a: WatchNextRow, b: WatchNextRow) =>
  (b.addedAt ?? "").localeCompare(a.addedAt ?? "");
