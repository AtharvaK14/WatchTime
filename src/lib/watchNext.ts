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
import { daysSince } from "./showStatus";
import { lastProgressionAt } from "./watchEvents";
import { matchesMoodFilter, showToMoodCandidate, type MoodFilter } from "./moodSearch/search";

export type Category = "watch-next" | "stale" | "not-started";

export interface WatchNextRow {
  showId: number;
  showName: string;
  posterPath: string | null;
  nextEpisode: Episode | null; // for not-started: the first episode to start with; for in-progress: the next unseen one. Null when nothing is cached yet.
  additionalCount: number; // the "+N" badge
  lastProgressedAt: string | null; // most recent first-watch of an unseen episode; drives the split AND the sort
  addedAt: string; // for ordering the "Haven't Yet Started" list (recently added first)
  category: Category;
}

/**
 * The three mutually-exclusive Home categories, driven purely by real watch
 * data (not the imported tvTimeStatus snapshot, which goes stale the moment
 * you watch anything in-app):
 *
 * - "not-started": zero watch activity ever. A show added to the library
 *   but never begun. Its own section so a long watchlist doesn't crowd out
 *   shows you're actually mid-way through.
 * - "watch-next": at least one episode watched AND a next UNSEEN released
 *   episode exists AND either that episode aired after the last progression
 *   (new content on a show you were caught up on) or the last progression is
 *   within the threshold. In progress and active.
 * - "stale": same as watch-next but the next episode was already available
 *   when they last watched, and that was longer ago than the threshold.
 *   Started, then genuinely dropped for a while.
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
 */
export function categorize(
  next: Episode | null,
  watchedCount: number,
  lastProgressedAt: string | null,
  threshold: number
): Category | null {
  if (watchedCount === 0) return "not-started";
  if (next === null) return null; // caught up / finished; rewatches don't bring it back

  // Is the next episode NEW, or is the viewer behind on something that was
  // already out?
  //
  // Age of the last watch alone cannot tell these apart, and reading it as
  // "stale" was wrong for the more common case. Finish Ted Lasso season 3,
  // come back when season 4 premieres a year later, and the last progression
  // is a year old — so the show reappeared under "Paused a while" instead of
  // "Watch next", which is where someone would actually look for a brand new
  // episode of a show they are up to date on.
  //
  // The distinguishing fact is whether the episode existed yet when they last
  // watched. If it aired AFTER, they were caught up and this is genuinely new
  // content: Watch next, however long the gap. If it aired BEFORE and is
  // still unwatched, they really are behind, and the threshold decides whether
  // that counts as active or dropped.
  //
  // Compared date-only because airDate is a plain YYYY-MM-DD while
  // lastProgressedAt is a full ISO timestamp; without the slice, an episode
  // that aired the same day would compare as earlier purely because the
  // shorter string is a prefix of the longer one.
  if (next.airDate && lastProgressedAt && next.airDate > lastProgressedAt.slice(0, 10)) {
    return "watch-next";
  }

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
  filter?: MoodFilter | null
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
    const category = categorize(next, watchedKeys.size, lastProgressedAt, staleThreshold);
    if (category === null) continue; // caught up / finished

    result.push({
      showId: show.tmdbId,
      showName: show.name,
      posterPath: show.posterPath,
      nextEpisode: next,
      additionalCount: next ? countAdditionalUnwatched(episodes, watchedKeys) : 0,
      lastProgressedAt,
      addedAt: show.addedAt,
      category,
    });
  }
  return result;
}

/** Most recent progression first. Rewatches never reorder this. */
export const byRecency = (a: WatchNextRow, b: WatchNextRow) =>
  (b.lastProgressedAt ?? "").localeCompare(a.lastProgressedAt ?? "");

/** Most recently added to the library first. */
export const byAddedAt = (a: WatchNextRow, b: WatchNextRow) =>
  (b.addedAt ?? "").localeCompare(a.addedAt ?? "");
