// Builds the payload the native widgets render from.
//
// Every row here comes out of the SAME builders the app screens use -
// buildWatchNextRows() for Watch Next and buildUpcomingEpisodeRows() for
// Coming Up - so the widget cannot show a different list, a different order,
// or a title the app would have filtered out. The widget is a projection of
// Home, not a parallel implementation of it.
//
// Formatting (the "S01 | E04" label, the "Tomorrow" date) is done here rather
// than in Java for the same reason: one implementation, shared wording.

import type { Episode, Movie, Show, WatchedEpisode } from "../../db";
import { TMDB_IMAGE_BASE } from "../../tmdb";
import { buildUpcomingEpisodeRows, formatUpcomingDate } from "../comingUp";
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
  /** "S01 | E04" - the app's own Watch Next wording. */
  episodeLabel: string;
  /** The "+N" badge; 0 when the next episode is the only one waiting. */
  extraCount: number;
  isPremiere: boolean;
  posterUrl: string | null;
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

export interface WidgetSnapshot {
  version: number;
  generatedAt: string;
  watchNext: WidgetWatchNextRow[];
  comingUp: WidgetComingUpRow[];
  /** True when the library itself is empty, so the widget can say "add some shows" rather than "all caught up". */
  libraryEmpty: boolean;
}

function episodeLabel(ep: { seasonNumber: number; episodeNumber: number }): string {
  return `S${String(ep.seasonNumber).padStart(2, "0")} | E${String(ep.episodeNumber).padStart(2, "0")}`;
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

  const watchNext = buildWatchNextRows(followed, episodes, watched, getStaleDaysThreshold())
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
        posterUrl: imageUrl(row.posterPath),
        stillUrl: imageUrl(ep.stillPath),
      };
    });

  const comingUp = buildUpcomingEpisodeRows(followed, episodes).map<WidgetComingUpRow>((row) => ({
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
    libraryEmpty: followed.length === 0 && movies.length === 0,
  };
}
