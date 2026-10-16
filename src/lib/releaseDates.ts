// Typed movie release dates: which date is the cinema release and which is
// the one at home.
//
// TMDB's movie object carries a single release_date, and the distinction only
// exists on /movie/{id}/release_dates (see getMovieReleaseDates). Two features
// need it - the theatrical/digital notifications and the release-type tags on
// Home's Releasing this month - and both store the answer through
// storeTypedReleaseDates() below, so one lookup serves both and neither can
// record a different reading of the same response.

import { db, type Movie } from "../db";
import { getMovieReleaseDates } from "../tmdb";
import { monthBounds } from "./comingUp";
import { daysAgoIso } from "./releaseState";

/**
 * Looks up one movie's typed release dates and stores them.
 *
 * Both typed fields are written every time, null included: null means "looked
 * up, TMDB has none", which is what stops the same movie being asked about
 * again. releaseDate is also replaced by the typed theatrical date when there
 * is one, as the notification backfill always did - it is the more precise
 * date for a cinema release - but a missing one never wipes the stored value.
 *
 * update() rather than put(): a movie removed from the library while its
 * lookup was in flight stays removed.
 */
export async function storeTypedReleaseDates(tmdbId: number): Promise<void> {
  const dates = await getMovieReleaseDates(tmdbId);
  await db.movies.update(tmdbId, {
    theatricalReleaseDate: dates.theatrical,
    digitalReleaseDate: dates.digital,
    ...(dates.theatrical ? { releaseDate: dates.theatrical } : {}),
  });
}

/**
 * How far before the current month a movie's release date can be and still
 * have its digital release land in it. Theatrical-to-digital windows are
 * typically one to four months; six covers the long tail without turning this
 * into a sweep of the whole library.
 */
const DIGITAL_WINDOW_DAYS = 180;

/** Upper bound on lookups per call, so a large import never fires a burst of requests at once. */
const MAX_LOOKUPS = 20;

/**
 * Movies whose release could fall in the current month but whose typed dates
 * have never been looked up.
 *
 * Only movies that are actually candidates: a release date inside the month,
 * or recent enough that the digital release could still be in it. Everything
 * else already has the metadata it needs, or cannot be releasing this month,
 * and costs no request.
 */
export function moviesNeedingTypedDates(movies: Movie[], now = new Date()): Movie[] {
  const { endExclusive } = monthBounds(now);
  const earliest = daysAgoIso(DIGITAL_WINDOW_DAYS, now);
  return movies.filter(
    (m) =>
      (m.theatricalReleaseDate === undefined || m.digitalReleaseDate === undefined) &&
      !!m.releaseDate &&
      m.releaseDate >= earliest &&
      m.releaseDate < endExclusive
  );
}

/**
 * Lookups currently on the wire. The caller re-runs the backfill whenever its
 * candidate list changes - which every successful lookup does - so a new run
 * routinely starts while the previous one's last request is still out. This
 * is what stops the two asking about the same movie.
 */
const inFlight = new Set<number>();

/**
 * Fills in typed release dates for this month's candidates, one request at a
 * time. A failure (offline, rate limited) leaves that movie undefined so a
 * later visit retries it; the rest of the batch carries on.
 */
export async function backfillTypedReleaseDates(
  movies: Movie[],
  isCancelled: () => boolean = () => false,
  now = new Date()
): Promise<void> {
  for (const movie of moviesNeedingTypedDates(movies, now).slice(0, MAX_LOOKUPS)) {
    if (isCancelled()) return;
    if (inFlight.has(movie.tmdbId)) continue;
    inFlight.add(movie.tmdbId);
    try {
      await storeTypedReleaseDates(movie.tmdbId);
    } catch {
      // Left undefined: retried next time Home is opened.
    } finally {
      inFlight.delete(movie.tmdbId);
    }
  }
}
