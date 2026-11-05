// What a viewing history MEANS: the record transforms every watch write goes
// through, and the counts every screen derives from the stored rows.
//
// Pure on purpose (no database access), so the rules can be checked in one
// command (`npm run check:watch-history`) and so a screen cannot grow its own
// slightly different idea of "watched twice".
//
// The model is the one the app already had, made explicit:
//
//   - ONE WatchedEpisode row per episode, and the row existing is what
//     "watched" means. Nothing else stores watched state.
//   - watchCount is that episode's number of viewing events (1 = watched
//     once). It is the only counter; every aggregate below is derived from it,
//     never stored beside it, so there is nothing that can drift out of step.
//   - watchedAt is the FIRST viewing and is never moved by a rewatch, and
//     lastWatchedAt is the most recent one. The two are how an original
//     viewing stays distinguishable from a rewatch. Watch Next keys its
//     "progress" off watchedAt for exactly that reason (see watchEvents.ts).
//
// Definitions, used by every caller:
//
//   episode watch count  = watchCount (0 when there is no row)
//   season watch count   = how many times the WHOLE season has been watched:
//                          the lowest watch count among its episodes, and 0
//                          while any episode is unwatched. Rewatching three
//                          episodes of a season therefore never adds a season
//                          viewing; rewatching all of them adds exactly one.
//   show watch count     = the same rule over every RELEASED episode of the
//                          show (see availableInProgression), so an announced
//                          but unaired season does not reset it to zero.
//   episodes watched     = total viewing events, rewatches included (the sum
//                          of watchCount). The number of unique episodes is
//                          reported separately and never moves on a rewatch.

import type { Episode, Movie, WatchedEpisode } from "../db";
import { availableInProgression } from "./episodeSync";

/** Viewing events for one episode. Rows written before v5 have no watchCount and mean one watch. */
export function episodeWatchCount(row: Pick<WatchedEpisode, "watchCount"> | undefined): number {
  if (!row) return 0;
  return Math.max(1, row.watchCount ?? 1);
}

// ---- Record transforms ------------------------------------------------------

/** A first viewing: one event, first and latest date both `when`. */
export function firstWatchRecord(
  showId: number,
  ep: Pick<Episode, "key" | "seasonNumber" | "episodeNumber">,
  when: string
): WatchedEpisode {
  return {
    key: ep.key,
    showId,
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.episodeNumber,
    watchedAt: when,
    watchCount: 1,
    lastWatchedAt: when,
  };
}

/**
 * One more viewing event. The first-watch date is untouched; only the count and
 * the latest date move. `when` never moves lastWatchedAt backwards: a widget tap
 * replayed hours later can carry an older time than a rewatch recorded since.
 */
export function withRewatch(prior: WatchedEpisode, when: string): WatchedEpisode {
  const latest = prior.lastWatchedAt ?? prior.watchedAt;
  return {
    ...prior,
    watchCount: episodeWatchCount(prior) + 1,
    lastWatchedAt: when > latest ? when : latest,
    // What the latest date was before this viewing, so removing it again
    // (withoutLatestViewing) restores the record exactly.
    latestBeforeRewatch: [...(prior.latestBeforeRewatch ?? []), latest],
  };
}

/**
 * "Watched once": the count back to one, keeping the ORIGINAL viewing. The
 * latest date goes back to the first one, since the rewatches it described are
 * the events being discarded.
 */
export function withWatchedOnce(prior: WatchedEpisode): WatchedEpisode {
  const { latestBeforeRewatch: _discarded, ...rest } = prior;
  return { ...rest, watchCount: 1, lastWatchedAt: prior.watchedAt };
}

/**
 * "Remove last viewing": undoes the most recent rewatch and nothing else. The
 * first viewing and every earlier rewatch keep their dates; the latest date
 * goes back to exactly what it was before that rewatch.
 *
 * A rewatch counted by an import (TV Time gives a count, not a date per
 * viewing) has no saved date to go back to. Removing one of those lowers the
 * count and keeps the latest date the record has, except that a record back
 * down to a single viewing always takes its first viewing's date, which is
 * known. Needs at least two viewings: removing the only one is "Not watched",
 * a different action (markEpisodesUnwatched).
 */
export function withoutLatestViewing(prior: WatchedEpisode): WatchedEpisode {
  const count = episodeWatchCount(prior);
  if (count < 2) throw new Error("This episode has only been watched once.");
  const stack = [...(prior.latestBeforeRewatch ?? [])];
  const restored = stack.pop();
  const { latestBeforeRewatch: _old, ...rest } = prior;
  const next = count - 1;
  return {
    ...rest,
    watchCount: next,
    lastWatchedAt: next === 1 ? prior.watchedAt : restored ?? prior.lastWatchedAt ?? prior.watchedAt,
    ...(stack.length > 0 && next > 1 ? { latestBeforeRewatch: stack } : {}),
  };
}

/**
 * One more viewing of an already-watched movie. Movie.watchedAt is the LATEST
 * viewing (it always was), so the first one is kept in firstWatchedAt the
 * first time a rewatch would otherwise overwrite it. A movie whose rewatches
 * predate that field has no first date left to keep; it stays undefined
 * rather than being given a wrong one. As for episodes, the latest date being
 * replaced is saved so the rewatch can be removed again exactly.
 */
export function withMovieRewatch(prior: Movie, when: string): Partial<Movie> {
  const firstWatchedAt = prior.firstWatchedAt ?? ((prior.rewatchCount ?? 0) === 0 ? prior.watchedAt ?? undefined : undefined);
  return {
    rewatchCount: (prior.rewatchCount ?? 0) + 1,
    watchedAt: when,
    ...(firstWatchedAt ? { firstWatchedAt } : {}),
    latestBeforeRewatch: [...(prior.latestBeforeRewatch ?? []), ...(prior.watchedAt ? [prior.watchedAt] : [])],
  };
}

/**
 * "Remove last viewing" for a movie: one fewer rewatch, the latest date back to
 * what it was before that rewatch (or, with no saved date, the first viewing
 * once none are left, and otherwise the date it has). The movie stays watched;
 * removing its only viewing is "Not watched" (setMovieWatched).
 */
export function withoutLatestMovieViewing(prior: Movie): Partial<Movie> {
  const rewatches = prior.rewatchCount ?? 0;
  if (!prior.watched || rewatches < 1) throw new Error("This movie has only been watched once.");
  const stack = [...(prior.latestBeforeRewatch ?? [])];
  const restored = stack.pop();
  const next = rewatches - 1;
  return {
    rewatchCount: next,
    watchedAt: next === 0 ? movieFirstWatchedAt(prior) ?? restored ?? prior.watchedAt : restored ?? prior.watchedAt,
    latestBeforeRewatch: next > 0 && stack.length > 0 ? stack : undefined,
  };
}

/** "Watched once" for a movie: no rewatches, dated at its first viewing where that is known. */
export function withMovieWatchedOnce(prior: Movie): Partial<Movie> {
  return {
    rewatchCount: 0,
    watchedAt: movieFirstWatchedAt(prior) ?? prior.latestBeforeRewatch?.[0] ?? prior.watchedAt,
    latestBeforeRewatch: undefined,
  };
}

/** The first viewing date of a movie, when the app still knows it. */
export function movieFirstWatchedAt(movie: Movie): string | null {
  if (movie.firstWatchedAt) return movie.firstWatchedAt;
  return (movie.rewatchCount ?? 0) === 0 ? movie.watchedAt : null;
}

/** Total viewings of a movie: 0 when unwatched, otherwise the first plus every rewatch. */
export function movieWatchCount(movie: Pick<Movie, "watched" | "rewatchCount">): number {
  return movie.watched ? 1 + (movie.rewatchCount ?? 0) : 0;
}

// ---- Derived counts ---------------------------------------------------------

export interface WatchSummary {
  /** Episodes the summary is over. */
  total: number;
  /** Of those, how many have been watched at least once. */
  watched: number;
  /** Viewing events across them, rewatches included. */
  views: number;
  /** Times the whole set has been watched: the lowest count, 0 while any is unwatched. */
  completions: number;
}

/** The counts for one set of episodes (a season, or a show's released episodes). */
export function summarize(
  episodes: Pick<Episode, "key">[],
  watchedByKey: ReadonlyMap<string, Pick<WatchedEpisode, "watchCount">>
): WatchSummary {
  let watched = 0;
  let views = 0;
  let lowest = Infinity;
  for (const ep of episodes) {
    const count = episodeWatchCount(watchedByKey.get(ep.key));
    if (count > 0) watched++;
    views += count;
    if (count < lowest) lowest = count;
  }
  return {
    total: episodes.length,
    watched,
    views,
    completions: episodes.length === 0 ? 0 : lowest,
  };
}

export interface ShowWatchSummary {
  /** Unique episodes with a watch row, the number "watched" has always meant on a progress bar. */
  uniqueWatched: number;
  /** All viewing events for the show, rewatches included. */
  views: number;
  /** Released episodes, the "of N" a show can actually be watched through. */
  released: number;
  /** Times every released episode has been watched. */
  completions: number;
}

/**
 * The show-level counts. `episodes` are the show's cached episodes and
 * `watched` its watch rows; the two are not assumed to match, since history
 * recorded against a season TMDB has since withdrawn is kept (episodeSync).
 * Views and unique counts are over every row so they agree with the library
 * totals; completions are over released episodes only.
 */
export function summarizeShow(
  episodes: Episode[],
  watched: WatchedEpisode[],
  today = new Date().toISOString().slice(0, 10)
): ShowWatchSummary {
  const byKey = new Map(watched.map((w) => [w.key, w]));
  const released = availableInProgression(episodes, today);
  const releasedSummary = summarize(released, byKey);
  return {
    uniqueWatched: watched.length,
    views: watched.reduce((sum, w) => sum + episodeWatchCount(w), 0),
    released: released.length,
    completions: releasedSummary.completions,
  };
}

/** "Watched once" / "Watched 3 times" / "Not watched", for aria-labels and menu headers. */
export function viewingsInWords(count: number): string {
  if (count <= 0) return "Not watched";
  return count === 1 ? "Watched once" : `Watched ${count} times`;
}

/** "2×" style label for a count worth calling out (two or more), or null. */
export function repeatLabel(count: number): string | null {
  return count >= 2 ? `${count}×` : null;
}
