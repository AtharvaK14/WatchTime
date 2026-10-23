// The one definition of "a movie the user still wants to watch".
//
// It used to be written out inline wherever a list needed it - the Movies
// page's Want to watch filter, Home's Movies to Watch rail, Home's search
// candidates - and Releasing this month did not apply it at all, which is how
// a film watched in cinemas came back onto Home the day its digital release
// was dated. Every list that is a watchlist reads this now.
//
// Pure, types only, so the scenario scripts can import it without a database.

import type { Movie } from "../db";

/**
 * In the library (the caller's rows are library rows), not watched, and still
 * marked as wanted. Both flags matter: they are independent in the data, and a
 * TV Time import can bring a movie that is neither watched nor on the
 * watchlist.
 */
export function isOnWatchlist(movie: Pick<Movie, "watched" | "wantsToWatch">): boolean {
  return !movie.watched && movie.wantsToWatch;
}
