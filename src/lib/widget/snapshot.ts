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
    libraryEmpty: followed.length === 0 && movies.length === 0,
  };
}
