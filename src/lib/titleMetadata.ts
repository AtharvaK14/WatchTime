// Filling in what a library row is missing from TMDB's details response.
//
// Three features each need a field that rows from before the field existed do
// not have: time-watched stats (runtime, episode total, genres, IMDb id), the
// star rating on a card, and mood search (overview, language). Each had its own
// backfill, and each asked TMDB for the very same details response to take its
// own one or two fields from it - so an imported library paid three requests a
// title where one already carried everything.
//
// Every backfill now stores the whole patch below. Whichever runs first leaves
// the row complete, and the other two find nothing to do.

import { db, type Movie, type Show } from "../db";
import { getMovieDetails, getTvShowDetails, type MovieDetails, type TvShowDetails } from "../tmdb";
import { averageRuntime } from "./runtime";
import { totalEpisodeCount } from "./episodeSync";

// Movies almost always have a real TMDB runtime, but for the rare title
// that doesn't, use the same "don't silently contribute zero forever"
// principle as the show-level fallback. ~110 min is a reasonable general
// movie-length estimate, a judgment call like the show fallback above,
// not a TMDB-confirmed number.
export const FALLBACK_MOVIE_RUNTIME_MINUTES = 110;

/**
 * Every field the show's row is missing that the details response can supply.
 *
 * Only missing fields: a value already stored is never replaced here. Several
 * of them have a better-informed owner (the episode total is kept current by
 * every sync, genres and the IMDb id come from the import), and a backfill is
 * for filling gaps, not for second-guessing them.
 *
 * Missing means null as well as undefined. For most of these null is "a past
 * attempt failed"; where it means "TMDB has none" asking again returns the
 * same null, and each backfill already limits itself to one try per title.
 */
export function showMetadataPatch(show: Show, d: TvShowDetails): Partial<Show> {
  const patch: Partial<Show> = {};
  if (show.episodeRuntimeMinutes == null) patch.episodeRuntimeMinutes = averageRuntime(d.episode_run_time);
  if (show.numberOfEpisodes == null) patch.numberOfEpisodes = totalEpisodeCount(d.seasons);
  if (show.genreIds == null) patch.genreIds = d.genres.map((g) => g.id);
  if (show.imdbId == null) patch.imdbId = d.external_ids?.imdb_id ?? null;
  if (show.overview == null) patch.overview = d.overview ?? null;
  if (show.originalLanguage == null) patch.originalLanguage = d.original_language ?? null;
  if (show.tmdbRating == null) patch.tmdbRating = d.vote_average ?? null;
  return patch;
}

/** The movie counterpart of showMetadataPatch. */
export function movieMetadataPatch(movie: Movie, d: MovieDetails): Partial<Movie> {
  const patch: Partial<Movie> = {};
  if (movie.runtimeMinutes == null) patch.runtimeMinutes = d.runtime ?? FALLBACK_MOVIE_RUNTIME_MINUTES;
  // Only when there is none: a stored date may be the typed theatrical one
  // from lib/releaseDates.ts, which is more precise than this primary date.
  if (movie.releaseDate == null) patch.releaseDate = d.release_date;
  if (movie.genreIds == null) patch.genreIds = d.genres.map((g) => g.id);
  if (movie.imdbId == null) patch.imdbId = d.external_ids?.imdb_id ?? null;
  if (movie.overview == null) patch.overview = d.overview ?? null;
  if (movie.originalLanguage == null) patch.originalLanguage = d.original_language ?? null;
  if (movie.tmdbRating == null) patch.tmdbRating = d.vote_average ?? null;
  return patch;
}

/**
 * Fetches a library title's details and works out its patch, without writing
 * it, for callers that save several at once. Null when the title is no longer
 * in the library. Throws what the TMDB client throws.
 */
export async function fetchMetadataPatch(
  kind: "show" | "movie",
  tmdbId: number
): Promise<Partial<Show> | Partial<Movie> | null> {
  if (kind === "show") {
    const details = await getTvShowDetails(tmdbId);
    const show = await db.shows.get(tmdbId);
    return show ? showMetadataPatch(show, details) : null;
  }
  const details = await getMovieDetails(tmdbId);
  const movie = await db.movies.get(tmdbId);
  return movie ? movieMetadataPatch(movie, details) : null;
}

/**
 * Fetches and stores everything a library title is missing. update() rather
 * than put(): a title removed while its request was out stays removed.
 */
export async function fillTitleMetadata(kind: "show" | "movie", tmdbId: number): Promise<void> {
  const patch = await fetchMetadataPatch(kind, tmdbId);
  if (!patch || Object.keys(patch).length === 0) return;
  if (kind === "show") await db.shows.update(tmdbId, patch as Partial<Show>);
  else await db.movies.update(tmdbId, patch as Partial<Movie>);
}
