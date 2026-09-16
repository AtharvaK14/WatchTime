// Home's "Coming up" section, extracted so the home-screen widget renders
// from the same computation rather than a second one that could drift.
//
// This is the same move watchNext.ts made for the Watch Next lists, and for
// the same reason: the widget's whole promise is that it shows what the app
// shows. Behaviour is unchanged by the extraction - the filtering rules, the
// sort, and the caps are the code that previously lived in ComingUp's two
// useMemos in pages/Home.tsx.

import type { Episode, Movie, Show } from "../db";
import { findNextUpcoming } from "./episodeSync";

/** How many rows the app's Coming up columns show. The widget takes a prefix of the same list. */
export const COMING_UP_LIMIT = 6;

export interface UpcomingEpisodeRow {
  showId: number;
  showName: string;
  posterPath: string | null;
  episode: Episode;
}

/**
 * The nearest confirmed-future episode for each followed, unarchived show,
 * soonest first, capped at COMING_UP_LIMIT.
 *
 * One row per show, not one per episode: a show that has announced six
 * episodes should not fill the whole section on its own. That comes from
 * findNextUpcoming(), which also enforces that a missing air date is NOT
 * treated as upcoming - an unknown date is not a confirmed future one.
 */
export function buildUpcomingEpisodeRows(
  shows: Show[],
  allEpisodes: Episode[],
  limit = COMING_UP_LIMIT
): UpcomingEpisodeRow[] {
  const episodesByShow = new Map<number, Episode[]>();
  for (const ep of allEpisodes) {
    const list = episodesByShow.get(ep.showId);
    if (list) list.push(ep);
    else episodesByShow.set(ep.showId, [ep]);
  }

  const rows: UpcomingEpisodeRow[] = [];
  for (const show of shows) {
    const next = findNextUpcoming(episodesByShow.get(show.tmdbId) ?? []);
    if (next) rows.push({ showId: show.tmdbId, showName: show.name, posterPath: show.posterPath, episode: next });
  }
  rows.sort((a, b) => (a.episode.airDate as string).localeCompare(b.episode.airDate as string));
  return rows.slice(0, limit);
}

/** Library movies whose release date falls inside the current calendar month, soonest first. */
export function buildReleasingThisMonth(movies: Movie[], now = new Date(), limit = COMING_UP_LIMIT): Movie[] {
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthEndExclusive = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
  return movies
    .filter((m) => m.releaseDate && m.releaseDate >= monthStart && m.releaseDate < monthEndExclusive)
    .sort((a, b) => (a.releaseDate as string).localeCompare(b.releaseDate as string))
    .slice(0, limit);
}

/**
 * The status line under a movie in "Releasing this month", or null for none.
 *
 * Watched wins. The two flags are independent in the data and a watched movie
 * can still carry wantsToWatch: the Movies grid's tick sets only `watched`, and
 * a TV Time import can bring both. A film the user has already seen is not one
 * they still want to see, so it never says both — and it reads the same
 * `watched` flag the Movies page's Watched filter does, rather than any
 * separate record of its own.
 */
export function releaseStatusLabel(movie: Pick<Movie, "watched" | "wantsToWatch">): string | null {
  if (movie.watched) return "Already Watched";
  if (movie.wantsToWatch) return "Want to watch";
  return null;
}

/**
 * "Today" / "Tomorrow" / "Mar 4" for an air or release date.
 *
 * Exported because the widget shows the same relative wording as the app;
 * the native side is handed the already-formatted string rather than
 * reimplementing this in Java, so the two can never disagree.
 */
export function formatUpcomingDate(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00`);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((date.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
