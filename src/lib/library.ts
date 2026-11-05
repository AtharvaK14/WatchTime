// Adding a title to the library: the record shapes, and the write.
//
// One builder per kind, used by the details panel's Add buttons and by Quick
// Actions on Discover / For You cards, so a title added either way is stored
// identically. The panel already has the TMDB details loaded and passes them
// in; a card does not, so addShowToLibrary / addMovieToLibrary fetch them.

import { db, type Movie, type Show } from "../db";
import { getMovieDetails, getTvShowDetails, type MovieDetails, type TvShowDetails } from "../tmdb";
import { averageRuntime } from "./runtime";
import { totalEpisodeCount } from "./episodeSync";
import { requestNotificationSync } from "./notifications";

/** The fields a new show row is built from, as the details panel holds them. */
export interface ShowRecordSource {
  name: string;
  posterPath: string | null;
  releaseDate: string | null;
  status?: string;
  episodeRuntimeMinutes?: number | null;
  numberOfEpisodes?: number;
  imdbId?: string | null;
}

/** The fields a new movie row is built from. */
export interface MovieRecordSource {
  name: string;
  posterPath: string | null;
  releaseDate: string | null;
  runtimeMinutes?: number | null;
  imdbId?: string | null;
}

export function showRecord(tmdbId: number, d: ShowRecordSource, now = new Date().toISOString()): Show {
  return {
    tmdbId,
    name: d.name,
    posterPath: d.posterPath,
    firstAirYear: d.releaseDate ? Number(d.releaseDate.slice(0, 4)) : null,
    status: d.status ?? "",
    addedAt: now,
    isFollowed: true,
    isArchived: false,
    lastWatchedAt: null,
    episodeRuntimeMinutes: d.episodeRuntimeMinutes ?? null,
    numberOfEpisodes: d.numberOfEpisodes ?? null,
    imdbId: d.imdbId ?? null,
  };
}

/**
 * "Add to Movies" (unwatched) and "Add & mark watched" share this, so the two
 * paths can't drift apart. Unwatched goes on the watchlist; watched does not.
 */
export function movieRecord(tmdbId: number, watched: boolean, d: MovieRecordSource, now = new Date().toISOString()): Movie {
  return {
    tmdbId,
    title: d.name,
    posterPath: d.posterPath,
    releaseYear: d.releaseDate ? Number(d.releaseDate.slice(0, 4)) : null,
    releaseDate: d.releaseDate ?? null,
    watched,
    watchedAt: watched ? now : null,
    wantsToWatch: !watched,
    runtimeMinutes: d.runtimeMinutes ?? null,
    imdbId: d.imdbId ?? null,
    addedAt: now,
  };
}

export function showSourceFromTmdb(d: TvShowDetails): ShowRecordSource {
  return {
    name: d.name,
    posterPath: d.poster_path,
    releaseDate: d.first_air_date,
    status: d.status,
    episodeRuntimeMinutes: averageRuntime(d.episode_run_time),
    numberOfEpisodes: totalEpisodeCount(d.seasons),
    imdbId: d.external_ids?.imdb_id ?? null,
  };
}

export function movieSourceFromTmdb(d: MovieDetails): MovieRecordSource {
  return {
    name: d.title,
    posterPath: d.poster_path,
    releaseDate: d.release_date,
    runtimeMinutes: d.runtime,
    imdbId: d.external_ids?.imdb_id ?? null,
  };
}

/** Adds a show from its TMDB id. Rejects if it did not land. */
export async function addShowToLibrary(tmdbId: number): Promise<Show> {
  const record = showRecord(tmdbId, showSourceFromTmdb(await getTvShowDetails(tmdbId)));
  await db.shows.put(record);
  if (!(await db.shows.get(tmdbId))) throw new Error("The show didn't save.");
  return record;
}

/**
 * Adds a movie from its TMDB id, watched or on the watchlist. A watched add
 * re-syncs notifications, the same as the panel's "Add & mark watched": a
 * watched movie stops getting its theatrical alert.
 */
export async function addMovieToLibrary(tmdbId: number, watched: boolean): Promise<Movie> {
  const record = movieRecord(tmdbId, watched, movieSourceFromTmdb(await getMovieDetails(tmdbId)));
  await db.movies.put(record);
  if (!(await db.movies.get(tmdbId))) throw new Error("The movie didn't save.");
  if (watched) requestNotificationSync();
  return record;
}
