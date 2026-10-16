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
import { airDateAsTimestamp, reactivationState, type ReactivationState } from "./releaseState";
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
  stopped = false,
  now = new Date()
): Category | null {
  if (stopped) return "stopped"; // explicit, and beats every automatic rule below
  if (watchedCount === 0) return "not-started";
  if (next === null) return null; // caught up / finished; rewatches don't bring it back
  if (reactivates) return "watch-next"; // a release, to someone who was keeping up
  return (daysSince(lastProgressedAt, now) ?? 0) < threshold ? "watch-next" : "stale";
}

/**
 * Where a show stands with the user: one of the four Home categories, or
 * "caught-up" - started, not stopped, and every released episode watched.
 *
 * categorize() reports caught-up as null because, for the Home lists, it means
 * "on none of them". Anything asking a different question about the same
 * show - is the user following it? - needs it as a state of its own, since
 * caught-up is the most engaged a viewer can be, not an absence of a state.
 */
export type ViewingState = Category | "caught-up";

export interface ShowClassification {
  state: ViewingState;
  /** The first UNSEEN released episode in original progression; null when caught up or nothing is cached. */
  next: Episode | null;
  watchedKeys: Set<string>;
  lastProgressedAt: string | null;
  release: ReactivationState;
}

/**
 * The one place a show's viewing state is worked out, for every caller that
 * needs one: the Home lists (buildWatchNextRows), Upcoming Episodes
 * (lib/comingUp.ts) and the widget built from both. They read the same
 * history and release state through the same rules, so a show cannot be
 * "Haven't Watched For a While" in one place and active in another.
 *
 * `episodes` and `watched` are this show's rows only.
 */
export function classifyShow(
  show: Show,
  episodes: Episode[],
  watched: WatchedEpisode[],
  staleThreshold: number,
  now = new Date()
): ShowClassification {
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
    isStoppedWatching(show),
    now
  );
  return { state: category ?? "caught-up", next, watchedKeys, lastProgressedAt, release };
}

/**
 * Whether the user is actively following a show: watching it now, or caught
 * up and waiting for more.
 *
 * Everything else is excluded, each for a reason that the release schedule
 * cannot override:
 *   - "stopped": the user said so, and it beats every automatic rule.
 *   - "not-started": nothing has been watched, so there is nothing being
 *     followed; a scheduled episode does not change that.
 *   - "stale": released episodes have sat unwatched past the threshold, and a
 *     release only reactivates a show for someone who was caught up (see
 *     reactivationState), which is already folded into "watch-next".
 *
 * Caught-up is deliberately IN. Having watched everything out so far is not
 * inactivity, however long the break before the next episode - a show waiting
 * months for its next season is exactly what Upcoming Episodes is for.
 */
export function isActivelyFollowing(state: ViewingState): boolean {
  return state === "watch-next" || state === "caught-up";
}

/** Groups episode or watch rows by show, for callers that classify many shows at once. */
export function groupByShow<T extends { showId: number }>(rows: T[]): Map<number, T[]> {
  const byShow = new Map<number, T[]>();
  for (const row of rows) {
    const list = byShow.get(row.showId);
    if (list) list.push(row);
    else byShow.set(row.showId, [row]);
  }
  return byShow;
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
  const episodesByShow = groupByShow(allEpisodes);
  const watchedByShow = groupByShow(allWatched);

  const result: WatchNextRow[] = [];
  for (const show of shows) {
    if (filter && !matchesMoodFilter(showToMoodCandidate(show), filter)) continue;

    const episodes = episodesByShow.get(show.tmdbId) ?? [];
    const { state, next, watchedKeys, lastProgressedAt, release } = classifyShow(
      show,
      episodes,
      watchedByShow.get(show.tmdbId) ?? [],
      staleThreshold,
      now
    );
    if (state === "caught-up") continue; // caught up / finished: on none of the lists
    const category = state;

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

/**
 * Whether marking `justWatchedKey` watched still leaves the show with an
 * episode to watch: the next season, or the rest of this one. False when it
 * was the last released episode, including when later ones are announced but
 * have not aired.
 *
 * This is what the Up Next card shows the moment its tick is tapped (a tick
 * when there is more, "That's all folks!" when there is not), so it is asked
 * before the write lands, from the rows as they stand plus the one episode
 * being marked. It walks findNextUnwatched() exactly as buildWatchNextRows()
 * does, so the card can never promise an episode the rebuilt list will not
 * then offer, or announce the end of a show the list keeps.
 */
export function hasNextAfterWatching(
  allEpisodes: Episode[],
  allWatched: WatchedEpisode[],
  showId: number,
  justWatchedKey: string
): boolean {
  const episodes = allEpisodes.filter((ep) => ep.showId === showId);
  const watchedKeys = new Set(allWatched.filter((w) => w.showId === showId).map((w) => w.key));
  watchedKeys.add(justWatchedKey);
  return findNextUnwatched(episodes, watchedKeys) !== null;
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
