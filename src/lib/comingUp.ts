// Home's "Coming up" section, extracted so the home-screen widget renders
// from the same computation rather than a second one that could drift.
//
// This is the same move watchNext.ts made for the Watch Next lists, and for
// the same reason: the widget's whole promise is that it shows what the app
// shows. Behaviour is unchanged by the extraction - the filtering rules, the
// sort, and the caps are the code that previously lived in ComingUp's two
// useMemos in pages/Home.tsx.

import type { Episode, Movie, Show, WatchedEpisode } from "../db";
import { findNextUpcoming } from "./episodeSync";
import { todayIso } from "./releaseState";
import { classifyShow, groupByShow, isActivelyFollowing } from "./watchNext";

/** How many rows the app's Coming up columns show. The widget takes a prefix of the same list. */
export const COMING_UP_LIMIT = 6;

export interface UpcomingEpisodeRow {
  showId: number;
  showName: string;
  posterPath: string | null;
  episode: Episode;
}

/**
 * The nearest confirmed-future episode for each show the user is actively
 * following, soonest first, capped at COMING_UP_LIMIT.
 *
 * "Actively following" is isActivelyFollowing() over classifyShow(), the
 * same classification the Up Next tabs are built from, so this section can
 * never disagree with them: a show filed under Haven't Yet Started, Haven't
 * Watched For a While or Stopped Watching has no upcoming episodes here, and
 * a show the user is caught up on and waiting for does - however long the
 * wait. Being in the library is not enough, and neither is having something
 * scheduled: an announced episode does not make an unstarted show started or
 * an abandoned one active.
 *
 * One row per show, not one per episode: a show that has announced six
 * episodes should not fill the whole section on its own. That comes from
 * findNextUpcoming(), which also enforces that a missing air date is NOT
 * treated as upcoming - an unknown date is not a confirmed future one.
 */
export function buildUpcomingEpisodeRows(
  shows: Show[],
  allEpisodes: Episode[],
  allWatched: WatchedEpisode[],
  staleThreshold: number,
  limit = COMING_UP_LIMIT,
  now = new Date()
): UpcomingEpisodeRow[] {
  const episodesByShow = groupByShow(allEpisodes);
  const watchedByShow = groupByShow(allWatched);

  const rows: UpcomingEpisodeRow[] = [];
  for (const show of shows) {
    const episodes = episodesByShow.get(show.tmdbId) ?? [];
    const next = findNextUpcoming(episodes);
    if (!next) continue;
    const { state } = classifyShow(show, episodes, watchedByShow.get(show.tmdbId) ?? [], staleThreshold, now);
    if (!isActivelyFollowing(state)) continue;
    rows.push({ showId: show.tmdbId, showName: show.name, posterPath: show.posterPath, episode: next });
  }
  rows.sort((a, b) => (a.episode.airDate as string).localeCompare(b.episode.airDate as string));
  return rows.slice(0, limit);
}

/** Which release a "Releasing this month" row is about. */
export type ReleaseKind = "theatrical" | "digital";

export interface ReleasingThisMonthRow {
  movie: Movie;
  /** The date the row is listed under, inside the current month. */
  date: string;
  /** Which release that date is; null when the stored metadata cannot say. */
  releaseKind: ReleaseKind | null;
}

/** The first day of `now`'s month and of the month after, as YYYY-MM-DD. */
export function monthBounds(now = new Date()): { start: string; endExclusive: string } {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
    endExclusive: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`,
  };
}

/**
 * The release that puts a movie in this month's listing, or null for none.
 *
 * Typed dates (Movie.theatricalReleaseDate / digitalReleaseDate, TMDB release
 * types 3 and 4) are the only evidence of WHICH release something is.
 * releaseDate cannot say: it is TMDB's primary date, which is the theatrical
 * one for a cinema release and the streaming premiere for a film that never
 * played in cinemas, and the notification backfill overwrites it with the
 * theatrical date where one exists. So:
 *
 *  - A typed date inside the month lists the movie under that date, tagged.
 *    A digital date is only ever a stored digital date, never inferred from a
 *    theatrical one having passed.
 *  - Both inside the month: the one still to come, or once both have passed,
 *    the later. A digital date on the same day as the theatrical one adds
 *    nothing and the theatrical one stands, matching the notifications.
 *  - No typed date this month but releaseDate is: listed as before, untagged.
 *    This covers both "never looked up" and "TMDB has no typed date for it",
 *    where any tag would be a guess.
 */
export function releaseThisMonth(movie: Movie, now = new Date()): Omit<ReleasingThisMonthRow, "movie"> | null {
  const { start, endExclusive } = monthBounds(now);
  const inMonth = (d: string | null | undefined): d is string => !!d && d >= start && d < endExclusive;

  const typed: { date: string; releaseKind: ReleaseKind }[] = [];
  const theatrical = movie.theatricalReleaseDate;
  const digital = movie.digitalReleaseDate;
  if (inMonth(theatrical)) typed.push({ date: theatrical, releaseKind: "theatrical" });
  if (inMonth(digital) && digital !== theatrical) typed.push({ date: digital, releaseKind: "digital" });

  if (typed.length > 0) {
    typed.sort((a, b) => a.date.localeCompare(b.date));
    const today = todayIso(now);
    return typed.find((t) => t.date >= today) ?? typed[typed.length - 1];
  }
  if (inMonth(movie.releaseDate)) return { date: movie.releaseDate, releaseKind: null };
  return null;
}

/** Library movies with a release inside the current calendar month, soonest first. */
export function buildReleasingThisMonth(
  movies: Movie[],
  now = new Date(),
  limit = COMING_UP_LIMIT
): ReleasingThisMonthRow[] {
  const rows: ReleasingThisMonthRow[] = [];
  for (const movie of movies) {
    const release = releaseThisMonth(movie, now);
    if (release) rows.push({ movie, ...release });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
}

/** The tag on a "Releasing this month" row. */
export function releaseKindLabel(kind: ReleaseKind): string {
  return kind === "theatrical" ? "In Theaters" : "Digital Release";
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
