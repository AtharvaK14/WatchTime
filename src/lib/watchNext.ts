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
 *   episode exists AND that episode has been waiting less than the threshold,
 *   where "waiting" counts from the later of the last progression and the
 *   episode's own air date. In progress and active.
 * - "stale": same, but the episode at the front of the queue has been waiting
 *   longer than the threshold. Started, then dropped — and it stays here while
 *   new episodes pile up behind, because the front of the queue keeps its old
 *   air date. Only watching something brings it back.
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

  // ONE threshold, measured from the moment the waiting episode actually
  // became available to them — which is the later of "when they last made
  // progress" and "when the episode now at the front of the queue aired".
  //
  // Both halves matter, and getting either wrong breaks one of the two
  // features:
  //
  //   next.airDate carries it for a show they were CAUGHT UP on. Finishing Ted
  //   Lasso season 3 and returning when season 4 premieres a year later, the
  //   last progression is a year old but the episode has been waiting a week,
  //   so it is active. Judging on the last watch alone buried it under "Paused
  //   a while", where nobody looks for a brand new episode.
  //
  //   lastProgressedAt carries it for a show they are mid-way through. If they
  //   watched something recently, the show is active even when the next
  //   episode aired long ago.
  //
  // Taking the LATER of the two, rather than treating "aired after the last
  // watch" as a gate that skips the threshold, is the whole correction here.
  // That gate was true for practically every abandoned weekly show — watch
  // episode 2, episode 3 airs the following week, never come back — so it
  // promoted dormant shows wholesale. Black Mirror sat in Watch next on an
  // episode from 2013.
  //
  // It also decays on its own, and that is what makes "paused" stick. Ignore
  // that Ted Lasso premiere for a few months and the air date recedes past the
  // threshold. Later episodes cannot rescue it either, because `next` is the
  // FIRST unseen episode: once a backlog exists, the front of the queue keeps
  // its old air date no matter how much new material arrives behind it. Only
  // actually watching something moves lastProgressedAt and revives the show.
  //
  // Dates are compared date-only: airDate is a plain YYYY-MM-DD while
  // lastProgressedAt is a full ISO timestamp, and without the slice the
  // shorter string sorts before the longer one on a same-day comparison.
  const candidates = [lastProgressedAt?.slice(0, 10), next.airDate].filter(
    (d): d is string => typeof d === "string" && d.length > 0
  );
  // Neither known (no timestamps, unknown air date) leaves nothing to measure;
  // 0 days keeps the long-standing "treat unknown as active" behaviour.
  const waitingSince = candidates.length ? candidates.sort()[candidates.length - 1] : null;

  return (daysSince(waitingSince) ?? 0) < threshold ? "watch-next" : "stale";
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
