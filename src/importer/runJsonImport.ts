import { db, episodeKey, type Show, type WatchedEpisode, type Movie } from "../db";
import { getTvShowDetails, getMovieDetails } from "../tmdb";
import { averageRuntime } from "../lib/runtime";
import { totalEpisodeCount } from "../lib/episodeSync";
import { parseMoviesJson, parseSeriesJson, type TvTimeShowExport } from "./parseTvTimeJson";
import { resolveShowByIds, resolveMovieByIds, type ResolveAmbiguous } from "./matcher";

export interface JsonImportProgress {
  phase: "shows" | "movies" | "done";
  current: number;
  total: number;
  currentTitle: string;
}

export interface JsonImportResult {
  showsMatched: number;
  showsSkipped: string[];
  moviesMatched: number;
  moviesSkipped: string[];
  episodesImported: number;
  matchMethodCounts: Record<string, number>;
}

function computeShowLastWatched(show: TvTimeShowExport): string | null {
  let max: string | null = null;
  for (const season of show.seasons) {
    for (const ep of season.episodes) {
      if (ep.watched_at && (!max || ep.watched_at > max)) max = ep.watched_at;
    }
  }
  return max;
}

/**
 * Imports from the third-party TV Time export (JSON), which carries exact
 * IMDb/TVDB IDs and TV Time's own explicit watch status per episode and per
 * show, verified against the user's real uploaded files. This replaces
 * reconstructing watch state from TV Time's raw event-log CSVs, and uses
 * exact ID-based TMDB matching instead of fuzzy title search wherever an ID
 * is available (effectively all movies, and the large majority of shows).
 */
export async function runJsonImport(
  opts: { seriesJsonText?: string; moviesJsonText?: string },
  resolveAmbiguous: ResolveAmbiguous,
  onProgress?: (p: JsonImportProgress) => void
): Promise<JsonImportResult> {
  const result: JsonImportResult = {
    showsMatched: 0,
    showsSkipped: [],
    moviesMatched: 0,
    moviesSkipped: [],
    episodesImported: 0,
    matchMethodCounts: {},
  };

  async function tallyMethod(cacheKey: string) {
    const m = await db.titleMatches.get(cacheKey);
    const method = m?.matchMethod ?? "unknown";
    result.matchMethodCounts[method] = (result.matchMethodCounts[method] ?? 0) + 1;
  }

  // ---- Shows ----------------------------------------------------------------
  if (opts.seriesJsonText) {
    const shows = parseSeriesJson(opts.seriesJsonText);

    for (let i = 0; i < shows.length; i++) {
      const show = shows[i];
      onProgress?.({ phase: "shows", current: i + 1, total: shows.length, currentTitle: show.title });

      const tmdbId = await resolveShowByIds(show.id.tvdb, show.id.imdb, show.title, resolveAmbiguous);
      const cacheKey = show.id.tvdb ? `tvdb:${show.id.tvdb}` : show.id.imdb ? `imdb:${show.id.imdb}` : show.title;
      await tallyMethod(cacheKey);
      if (tmdbId === null) {
        result.showsSkipped.push(show.title);
        continue;
      }

      const lastWatchedAt = computeShowLastWatched(show);
      const existingShow = await db.shows.get(tmdbId);

      if (!existingShow) {
        const details = await getTvShowDetails(tmdbId);
        const showRecord: Show = {
          tmdbId: details.id,
          tvdbId: show.id.tvdb,
          name: details.name,
          posterPath: details.poster_path,
          firstAirYear: details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : null,
          status: details.status,
          addedAt: new Date().toISOString(),
          isFollowed: show.status !== "stopped",
          isArchived: show.status === "stopped",
          lastWatchedAt,
          episodeRuntimeMinutes: averageRuntime(details.episode_run_time),
          numberOfEpisodes: totalEpisodeCount(details.seasons),
          genreIds: details.genres.map((g) => g.id),
          imdbId: details.external_ids?.imdb_id ?? show.id.imdb ?? null,
          tmdbRating: details.vote_average ?? null,
          tvTimeStatus: show.status,
        };
        await db.shows.put(showRecord);
      } else {
        await db.shows.update(tmdbId, {
          tvdbId: show.id.tvdb,
          isFollowed: show.status !== "stopped",
          isArchived: show.status === "stopped",
          tvTimeStatus: show.status,
          lastWatchedAt:
            !existingShow.lastWatchedAt || (lastWatchedAt && lastWatchedAt > existingShow.lastWatchedAt)
              ? lastWatchedAt
              : existingShow.lastWatchedAt,
        });
      }

      // Explicit per-episode watch data, no reconstruction needed: is_watched,
      // watched_at, and watched_count (which already includes rewatches) are
      // all given directly by this export.
      const watchedRecords: WatchedEpisode[] = [];
      for (const season of show.seasons) {
        for (const ep of season.episodes) {
          if (!ep.is_watched) continue;
          // The export carries one watched_at per episode (its latest
          // known watch), so it seeds BOTH first- and last-watch fields;
          // in-app rewatches diverge them from there.
          watchedRecords.push({
            key: episodeKey(tmdbId, season.number, ep.number),
            showId: tmdbId,
            seasonNumber: season.number,
            episodeNumber: ep.number,
            watchedAt: ep.watched_at || new Date().toISOString(),
            watchCount: ep.watched_count || 1,
            lastWatchedAt: ep.watched_at || new Date().toISOString(),
          });
        }
      }
      if (watchedRecords.length > 0) {
        await db.watchedEpisodes.bulkPut(watchedRecords);
      }
      result.episodesImported += watchedRecords.length;
      result.showsMatched++;
    }
  }

  // ---- Movies -----------------------------------------------------------------
  if (opts.moviesJsonText) {
    const movies = parseMoviesJson(opts.moviesJsonText);

    for (let i = 0; i < movies.length; i++) {
      const movie = movies[i];
      onProgress?.({ phase: "movies", current: i + 1, total: movies.length, currentTitle: movie.title });

      const tmdbId = await resolveMovieByIds(movie.id.imdb, movie.id.tvdb, movie.title, resolveAmbiguous);
      const cacheKey = movie.id.imdb ? `imdb:${movie.id.imdb}` : movie.id.tvdb ? `tvdb:${movie.id.tvdb}` : movie.title;
      await tallyMethod(cacheKey);
      if (tmdbId === null) {
        result.moviesSkipped.push(movie.title);
        continue;
      }

      const details = await getMovieDetails(tmdbId);
      const movieRecord: Movie = {
        tmdbId: details.id,
        title: details.title,
        posterPath: details.poster_path,
        releaseYear: details.release_date ? Number(details.release_date.slice(0, 4)) : null,
        releaseDate: details.release_date,
        watched: movie.is_watched,
        watchedAt: movie.watched_at,
        wantsToWatch: !movie.is_watched,
        runtimeMinutes: details.runtime,
        rewatchCount: movie.rewatch_count,
        genreIds: details.genres.map((g) => g.id),
        imdbId: details.external_ids?.imdb_id ?? movie.id.imdb ?? null,
        tmdbRating: details.vote_average ?? null,
        addedAt: new Date().toISOString(),
      };
      await db.movies.put(movieRecord);
      result.moviesMatched++;
    }
  }

  onProgress?.({ phase: "done", current: 1, total: 1, currentTitle: "" });
  return result;
}
