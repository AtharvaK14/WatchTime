// The detailed statistics behind the Shows and Movies stat tiles.
//
// Pure, over the same rows and the same rules everything else uses - viewing
// counts from lib/watchHistory.ts, a show's state from the Shows page's own
// status filter - so a number in the pop-up can never disagree with the tile,
// the grid or a filter. Checked by `npm run check:watch-history`.
//
// Unique titles and viewing events are always separate numbers: a movie
// watched three times is one movie watched and three movie viewings.
// Nothing is estimated. Where the data cannot answer a question (a season
// whose episode list was never synced, the date of a rewatch imported without
// one) the statistic is either left out or says what it covers.

import type { Episode, Movie, Show, WatchedEpisode } from "../db";
import type { ShowWatchStatus } from "./showWatchStatus";
import { isStoppedWatching } from "./stoppedWatching";
import { episodeWatchCount, movieFirstWatchedAt, movieWatchCount } from "./watchHistory";

export interface RankedTitle {
  tmdbId: number;
  name: string;
  /** Viewing events. */
  views: number;
  /** Unique items watched (episodes for a show; 1 for a movie). */
  unique: number;
}

export interface MonthCount {
  /** "2026-11" */
  month: string;
  count: number;
}

export interface ShowLibraryStats {
  totalShows: number;
  /** The Shows page's own "Currently Watching" rule: has a next episode, not stopped. */
  currentlyWatching: number;
  /** Every released episode watched (and not stopped). */
  caughtUp: number;
  notStarted: number;
  stopped: number;
  /** Not stopped, and the episode list is not synced on this device, so its state is not known. */
  unknown: number;
  uniqueEpisodes: number;
  episodeViews: number;
  /** Viewing events beyond each episode's first. */
  rewatchViews: number;
  /** Seasons watched all the way through, among seasons whose episode list is synced here. */
  seasonsCompleted: number;
  mostWatched: RankedTitle[];
  /** First-time episode viewings per month, oldest first, ending with `now`'s month. */
  firstWatchesByMonth: MonthCount[];
}

const monthOf = (iso: string) => iso.slice(0, 7);

function lastMonths(now: Date, n: number): string[] {
  const months: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

export function showLibraryStats(
  shows: Show[],
  episodes: Episode[],
  watched: WatchedEpisode[],
  statusByShow: ReadonlyMap<number, ShowWatchStatus>,
  now = new Date(),
  months = 6
): ShowLibraryStats {
  let currentlyWatching = 0;
  let caughtUp = 0;
  let notStarted = 0;
  let stopped = 0;
  let unknown = 0;
  for (const show of shows) {
    if (isStoppedWatching(show)) {
      stopped++;
      continue;
    }
    switch (statusByShow.get(show.tmdbId)) {
      case "currently-watching":
        currentlyWatching++;
        break;
      case "up-to-date":
        caughtUp++;
        break;
      case "not-started":
        notStarted++;
        break;
      default:
        unknown++;
    }
  }

  const libraryIds = new Set(shows.map((s) => s.tmdbId));
  // Every watch row, as the tile counts them, so the two can never differ.
  const byKey = new Map(watched.map((w) => [w.key, w]));
  const episodeViews = watched.reduce((sum, w) => sum + episodeWatchCount(w), 0);

  // Seasons watched through: every cached episode of the season has a row.
  const seasons = new Map<string, Episode[]>();
  for (const ep of episodes) {
    if (ep.seasonNumber <= 0 || !libraryIds.has(ep.showId)) continue;
    const key = `${ep.showId}:${ep.seasonNumber}`;
    const list = seasons.get(key);
    if (list) list.push(ep);
    else seasons.set(key, [ep]);
  }
  let seasonsCompleted = 0;
  for (const list of seasons.values()) if (list.every((ep) => byKey.has(ep.key))) seasonsCompleted++;

  const perShow = new Map<number, RankedTitle>();
  const names = new Map(shows.map((s) => [s.tmdbId, s.name]));
  for (const w of watched) {
    if (!libraryIds.has(w.showId)) continue;
    const entry = perShow.get(w.showId) ?? { tmdbId: w.showId, name: names.get(w.showId) ?? "", views: 0, unique: 0 };
    entry.views += episodeWatchCount(w);
    entry.unique += 1;
    perShow.set(w.showId, entry);
  }
  const mostWatched = [...perShow.values()]
    .sort((a, b) => b.views - a.views || b.unique - a.unique || a.name.localeCompare(b.name))
    .slice(0, 5);

  const window = lastMonths(now, months);
  const counts = new Map(window.map((m) => [m, 0]));
  for (const w of watched) {
    const m = monthOf(w.watchedAt);
    if (counts.has(m)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }

  return {
    totalShows: shows.length,
    currentlyWatching,
    caughtUp,
    notStarted,
    stopped,
    unknown,
    uniqueEpisodes: watched.length,
    episodeViews,
    rewatchViews: episodeViews - watched.length,
    seasonsCompleted,
    mostWatched,
    firstWatchesByMonth: window.map((month) => ({ month, count: counts.get(month) ?? 0 })),
  };
}

export interface MovieLibraryStats {
  totalMovies: number;
  /** Unique movies watched. */
  watched: number;
  unwatched: number;
  /** Viewing events, rewatches included. */
  views: number;
  rewatchViews: number;
  /** Movies watched more than once, most viewings first. */
  mostRewatched: RankedTitle[];
  /** First viewings per month, oldest first, ending with `now`'s month. */
  firstWatchesByMonth: MonthCount[];
}

export function movieLibraryStats(movies: Movie[], now = new Date(), months = 6): MovieLibraryStats {
  const watchedMovies = movies.filter((m) => m.watched);
  const views = watchedMovies.reduce((sum, m) => sum + movieWatchCount(m), 0);
  return {
    totalMovies: movies.length,
    watched: watchedMovies.length,
    unwatched: movies.length - watchedMovies.length,
    views,
    rewatchViews: views - watchedMovies.length,
    mostRewatched: watchedMovies
      .map((m) => ({ tmdbId: m.tmdbId, name: m.title, views: movieWatchCount(m), unique: 1 }))
      .filter((m) => m.views >= 2)
      .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name))
      .slice(0, 5),
    firstWatchesByMonth: countByMonth(
      watchedMovies.map((m) => movieFirstWatchedAt(m)),
      now,
      months
    ),
  };
}

/** How many of `dates` fall in each of the last `months` months (missing dates are skipped). */
function countByMonth(dates: (string | null | undefined)[], now: Date, months: number): MonthCount[] {
  const window = lastMonths(now, months);
  const counts = new Map(window.map((m) => [m, 0]));
  for (const d of dates) {
    if (!d) continue;
    const m = monthOf(d);
    if (counts.has(m)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return window.map((month) => ({ month, count: counts.get(month) ?? 0 }));
}
