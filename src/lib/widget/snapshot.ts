// Builds the payload the native widgets render from.
//
// Every row here comes out of the SAME builders the app screens use -
// buildWatchNextRows() for Watch Next and buildUpcomingEpisodeRows() for
// Coming Up - so the widget cannot show a different list, a different order,
// or a title the app would have filtered out. The widget is a projection of
// Home, not a parallel implementation of it.
//
// Formatting (the "S3 E1" label, the "+7 more · New · Season premiere" line,
// the "Tomorrow" date) is done here rather than in Java for the same reason:
// one implementation, shared wording.

import type { Episode, Movie, Show, WatchedEpisode } from "../../db";
import { TMDB_IMAGE_BASE } from "../../tmdb";
import { buildUpcomingEpisodeRows, formatUpcomingDate, releaseKindLabel, type ReleaseKind } from "../comingUp";
import { formatRating } from "../ratings";
import { todayIso } from "../releaseState";
import { isOnWatchlist } from "../watchlist";
import { getStaleDaysThreshold } from "../showStatus";
import { buildWatchNextRows, byRecency } from "../watchNext";

/**
 * Bumped when the shape changes incompatibly. The native side ignores a
 * snapshot whose version it does not understand and keeps the last one it
 * could read, so an app update that lands before the widget process restarts
 * degrades to stale-but-correct instead of blank.
 */
export const WIDGET_SNAPSHOT_VERSION = 1;

/**
 * How many rows a snapshot carries. Larger than any widget size can show on
 * purpose: the widget decides how many of them fit at its current dimensions,
 * which is what makes resizing work without a round-trip to the app.
 */
const WATCH_NEXT_SNAPSHOT_ROWS = 20;

export interface WidgetWatchNextRow {
  showId: number;
  showName: string;
  episodeKey: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeName: string;
  /** "S3 E1" - the app's own Up Next wording. */
  episodeLabel: string;
  /** How many more episodes are waiting after this one; 0 when it is the only one. */
  extraCount: number;
  isPremiere: boolean;
  /**
   * The card's metadata line, as Home writes it: "+7 more · New · Season
   * premiere". Split around "New" so the widget can colour that one word in
   * the accent, as the app does, without parsing the text: metaBefore, then
   * "New" when isNew, then metaAfter. All three empty when there is nothing
   * to say. Optional fields: a widget built before them shows no meta line.
   */
  metaBefore: string;
  isNew: boolean;
  metaAfter: string;
  posterUrl: string | null;
  /**
   * Set only on the short-lived snapshot pushed right after this row's tick
   * was tapped: the widget draws the app's watched veil over the row ("next":
   * the tick, "done": "That's all folks!") until the real Up Next replaces it.
   */
  watchedPhase?: "next" | "done";
  stillUrl: string | null;
}

export interface WidgetComingUpRow {
  showId: number;
  showName: string;
  episodeKey: string;
  episodeLabel: string;
  episodeName: string;
  airDate: string | null;
  /** "Today" / "Tomorrow" / "Mar 4", matching the app's Coming up column. */
  dateLabel: string;
  posterUrl: string | null;
}

/** A Movies to Watch widget row: a watchlist movie, in Home's order. */
export interface WidgetMovieRow {
  tmdbId: number;
  title: string;
  /** "2024 · 2h 15m", either part left out when unknown. */
  meta: string;
  /** "7.4", or "" when TMDB has no rating. */
  rating: string;
  posterUrl: string | null;
  /** As on WidgetWatchNextRow: set only on the snapshot pushed right after the row's tick. */
  watchedPhase?: "next" | "done";
}

/** A Coming Soon widget row: a watchlist movie with a release still ahead. */
export interface WidgetMovieReleaseRow {
  tmdbId: number;
  title: string;
  releaseDate: string;
  /** "Today" / "Tomorrow" / "Mar 4". */
  dateLabel: string;
  /** "In Theaters" / "Digital Release", or "" when the stored dates cannot say. */
  releaseLabel: string;
  posterUrl: string | null;
}

export interface WidgetSnapshot {
  version: number;
  generatedAt: string;
  watchNext: WidgetWatchNextRow[];
  comingUp: WidgetComingUpRow[];
  /** The movie widgets. Native reads a missing field (an older snapshot) as empty. */
  moviesToWatch: WidgetMovieRow[];
  movieReleases: WidgetMovieReleaseRow[];
  /** True when the library itself is empty, so the widget can say "add some shows" rather than "all caught up". */
  libraryEmpty: boolean;
}

function episodeLabel(ep: { seasonNumber: number; episodeNumber: number }): string {
  return `S${ep.seasonNumber} E${ep.episodeNumber}`;
}

/**
 * Home's Up Next metadata line, split around "New" (see WidgetWatchNextRow).
 * The same rules as EpisodeRow in pages/Home.tsx: "+N more", then New when
 * something has been released the user has not seen, then the premiere.
 */
function metaLine(
  extraCount: number,
  isNew: boolean,
  ep: { seasonNumber: number; episodeNumber: number }
): { metaBefore: string; isNew: boolean; metaAfter: string } {
  const more = extraCount > 0 ? `+${extraCount} more` : "";
  const premiere = ep.episodeNumber === 1 ? (ep.seasonNumber === 1 ? "Series premiere" : "Season premiere") : "";
  return {
    metaBefore: more + (isNew && more ? " · " : ""),
    isNew,
    metaAfter: premiere ? ((more || isNew) ? " · " : "") + premiere : "",
  };
}

function imageUrl(path: string | null): string | null {
  return path ? `${TMDB_IMAGE_BASE}${path}` : null;
}

/**
 * Watch Next rows exactly as the app's first tab shows them: the
 * "watch-next" category only, sorted by most recent progression.
 *
 * The "stale" and "not-started" categories are deliberately excluded. They
 * are separate tabs in the app, and a widget called Watch Next that quietly
 * mixed in shows you abandoned or never began would be showing something the
 * user did not ask for - the same objection as putting recommendations in it.
 *
 * Rows whose next episode could not be matched against TMDB are dropped too:
 * the app renders them with an explanatory line, which a widget row has no
 * room for, and a row that cannot say which episode it means is not useful.
 */
export function buildWidgetSnapshot(
  shows: Show[],
  episodes: Episode[],
  watched: WatchedEpisode[],
  movies: Movie[],
  now = new Date()
): WidgetSnapshot {
  const followed = shows.filter((s) => s.isFollowed && !s.isArchived);
  const staleThreshold = getStaleDaysThreshold();

  const watchNext = buildWatchNextRows(followed, episodes, watched, staleThreshold)
    .filter((row) => row.category === "watch-next" && row.nextEpisode !== null)
    .sort(byRecency)
    .slice(0, WATCH_NEXT_SNAPSHOT_ROWS)
    .map<WidgetWatchNextRow>((row) => {
      const ep = row.nextEpisode!;
      return {
        showId: row.showId,
        showName: row.showName,
        episodeKey: ep.key,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        episodeName: ep.name,
        episodeLabel: episodeLabel(ep),
        extraCount: row.additionalCount,
        isPremiere: ep.episodeNumber === 1,
        ...metaLine(row.additionalCount, row.newlyAvailable, ep),
        posterUrl: imageUrl(row.posterPath),
        stillUrl: imageUrl(ep.stillPath),
      };
    });

  // Same actively-following filter as the app's Upcoming episodes column, so
  // the widget never lists an unstarted or abandoned show the app leaves out.
  const comingUp = buildUpcomingEpisodeRows(followed, episodes, watched, staleThreshold).map<WidgetComingUpRow>((row) => ({
    showId: row.showId,
    showName: row.showName,
    episodeKey: row.episode.key,
    episodeLabel: episodeLabel(row.episode),
    episodeName: row.episode.name,
    airDate: row.episode.airDate,
    dateLabel: formatUpcomingDate(row.episode.airDate, now),
    posterUrl: imageUrl(row.posterPath),
  }));

  return {
    version: WIDGET_SNAPSHOT_VERSION,
    generatedAt: now.toISOString(),
    watchNext,
    comingUp,
    moviesToWatch: buildMovieRows(movies),
    movieReleases: buildMovieReleaseRows(movies, now),
    libraryEmpty: followed.length === 0 && movies.length === 0,
  };
}

const MOVIE_SNAPSHOT_ROWS = 30;

function runtimeLabel(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * Movies to Watch, as Home's Movies tab lists them: watchlist movies only
 * (isOnWatchlist, the same rule as the Movies page's Want to watch filter),
 * most recently added first.
 */
export function buildMovieRows(movies: Movie[]): WidgetMovieRow[] {
  return movies
    .filter(isOnWatchlist)
    .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""))
    .slice(0, MOVIE_SNAPSHOT_ROWS)
    .map((m) => ({
      tmdbId: m.tmdbId,
      title: m.title,
      meta: [m.releaseYear ? String(m.releaseYear) : "", runtimeLabel(m.runtimeMinutes)].filter(Boolean).join(" · "),
      rating: formatRating(m.tmdbRating) ?? "",
      posterUrl: imageUrl(m.posterPath),
    }));
}

/**
 * Coming Soon: watchlist movies with a release still ahead (today or later),
 * soonest first. Each is listed under its next typed release (theatrical or
 * digital) when the stored dates have one, otherwise under TMDB's primary
 * date untagged - the same evidence rules as Home's Releasing this month,
 * without the month boundary, since a widget showing nothing for the last
 * week of every month would be no use.
 */
export function buildMovieReleaseRows(movies: Movie[], now = new Date()): WidgetMovieReleaseRow[] {
  const today = todayIso(now);
  const rows: WidgetMovieReleaseRow[] = [];
  for (const m of movies) {
    if (!isOnWatchlist(m)) continue;
    const typed: { date: string; kind: ReleaseKind }[] = [];
    if (m.theatricalReleaseDate && m.theatricalReleaseDate >= today) typed.push({ date: m.theatricalReleaseDate, kind: "theatrical" });
    if (m.digitalReleaseDate && m.digitalReleaseDate >= today && m.digitalReleaseDate !== m.theatricalReleaseDate) {
      typed.push({ date: m.digitalReleaseDate, kind: "digital" });
    }
    typed.sort((a, b) => a.date.localeCompare(b.date));
    const next = typed[0] ?? (m.releaseDate && m.releaseDate >= today ? { date: m.releaseDate, kind: null } : null);
    if (!next) continue;
    rows.push({
      tmdbId: m.tmdbId,
      title: m.title,
      releaseDate: next.date,
      dateLabel: formatUpcomingDate(next.date, now),
      releaseLabel: next.kind ? releaseKindLabel(next.kind) : "",
      posterUrl: imageUrl(m.posterPath),
    });
  }
  return rows.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate)).slice(0, MOVIE_SNAPSHOT_ROWS);
}
