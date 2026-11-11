// TMDB star ratings for library titles (Show.tmdbRating / Movie.tmdbRating).
//
// New titles get theirs when they are added (lib/library.ts and the
// importers). Rows from before the field existed have none, so the cards that
// show a rating fill in exactly the ones they are about to display, one request
// each, the same way Home fills typed release dates for Releasing this month.

import { db, type Movie } from "../db";
import { getMovieDetails } from "../tmdb";

/** The rating as a card shows it ("7.4"), or null when there is nothing worth showing. */
export function formatRating(rating: number | null | undefined): string | null {
  // TMDB reports 0 for a title nobody has voted on yet; that is "no rating",
  // not a terrible one.
  if (rating === null || rating === undefined || !(rating > 0)) return null;
  return rating.toFixed(1);
}

/** Movies whose rating has never been looked up. */
export function moviesNeedingRating(movies: Movie[]): Movie[] {
  return movies.filter((m) => m.tmdbRating === undefined);
}

/**
 * Looks up and stores the rating of each movie given, in order, one request at
 * a time. Stops at the first failure (offline, a rate limit) and leaves the
 * rest undefined, so they are tried again on the next visit rather than being
 * recorded as having no rating.
 */
export async function backfillMovieRatings(movies: Movie[], shouldStop: () => boolean): Promise<void> {
  for (const movie of movies) {
    if (shouldStop()) return;
    let rating: number | null;
    try {
      const details = await getMovieDetails(movie.tmdbId);
      rating = details.vote_average ?? null;
    } catch {
      return;
    }
    if (shouldStop()) return;
    await db.movies.update(movie.tmdbId, { tmdbRating: rating });
  }
}
