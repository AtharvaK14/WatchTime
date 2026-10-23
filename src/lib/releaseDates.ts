// Typed movie release dates: which date is the cinema release and which is
// the one at home.
//
// TMDB's movie object carries a single release_date, and the distinction only
// exists on /movie/{id}/release_dates (see getMovieReleaseDates). Two features
// need it - the theatrical/digital notifications and the release-type tags on
// Home's Releasing this month - and both store the answer through
// storeTypedReleaseDates() below, and both decide WHEN to look a movie up
// through moviesNeedingTypedDates(), so one lookup serves both and neither can
// record a different reading of the same response or go stale on its own
// schedule.

import { db, type Movie } from "../db";
import { getMovieReleaseDates } from "../tmdb";
import { daysAgoIso, todayIso } from "./releaseState";

/**
 * Looks up one movie's typed release dates and stores them.
 *
 * Both typed fields are written every time, null included: null means "looked
 * up, TMDB has none". releaseDate is replaced by the typed theatrical date
 * when there is one, as the notification backfill always did - it is the more
 * precise date for a cinema release - and otherwise by TMDB's current primary
 * date, which is fresher than whatever was stored when the movie was added. A
 * response with neither never wipes the stored value.
 *
 * update() rather than put(): a movie removed from the library while its
 * lookup was in flight stays removed.
 */
export async function storeTypedReleaseDates(tmdbId: number, now = new Date()): Promise<void> {
  const dates = await getMovieReleaseDates(tmdbId);
  const releaseDate = dates.theatrical ?? dates.primary;
  await db.movies.update(tmdbId, {
    theatricalReleaseDate: dates.theatrical,
    digitalReleaseDate: dates.digital,
    releaseDatesCheckedAt: now.toISOString(),
    ...(releaseDate ? { releaseDate } : {}),
  });
}

/**
 * How far back a movie's dates can be and still matter. A theatrical release
 * in that window can still have its digital release ahead of it, or inside
 * the current month; theatrical-to-digital windows are typically one to four
 * months, and six covers the long tail.
 */
const RELEVANT_BEHIND_DAYS = 180;

/**
 * How far ahead. A dated release a year out can still be brought forward into
 * this month, which is exactly the kind of change a stored date misses.
 */
const RELEVANT_AHEAD_DAYS = 365;

/**
 * How long a lookup is trusted. Long enough that a visit to Home normally
 * costs no request at all, short enough that a digital date announced after
 * the first lookup - the usual order of events - is picked up well before it
 * arrives, and a release that moved is not listed in the wrong month for long.
 */
export const RELEASE_DATES_REFRESH_DAYS = 7;

/** Upper bound on lookups per call, so a large import never fires a burst of requests at once. */
const MAX_LOOKUPS = 20;

function knownDates(m: Movie): string[] {
  return [m.releaseDate, m.theatricalReleaseDate, m.digitalReleaseDate].filter(
    (d): d is string => typeof d === "string" && d !== ""
  );
}

/**
 * Movies whose release could matter now - to Releasing this month or to a
 * release notification - and whose typed dates are missing or old.
 *
 * Relevant means a known date between six months ago and a year ahead, or, for
 * a movie not yet watched, no date at all yet (an announced film the user put
 * on their list before TMDB dated it). Watched movies stay relevant while they
 * are in that window, because a digital release is still worth announcing
 * after the user has seen a film in cinemas.
 *
 * Old means never looked up, looked up before releaseDatesCheckedAt existed,
 * or looked up more than RELEASE_DATES_REFRESH_DAYS ago. The previous rule
 * looked each movie up exactly once, ever: a digital date TMDB added after
 * that lookup was never seen, and nor was a release that moved.
 *
 * Ordered by need: never looked up first, then nearest to today, so the cap
 * spends its requests where they change what the user sees soonest.
 */
export function moviesNeedingTypedDates(movies: Movie[], now = new Date()): Movie[] {
  const earliest = daysAgoIso(RELEVANT_BEHIND_DAYS, now);
  const latest = daysAgoIso(-RELEVANT_AHEAD_DAYS, now);
  const staleBefore = new Date(now.getTime() - RELEASE_DATES_REFRESH_DAYS * 86400000).toISOString();
  const today = todayIso(now);

  const distance = (m: Movie) => {
    const dates = knownDates(m);
    if (dates.length === 0) return Number.MAX_SAFE_INTEGER;
    return Math.min(...dates.map((d) => Math.abs(new Date(d).getTime() - new Date(today).getTime())));
  };

  return movies
    .filter((m) => {
      const dates = knownDates(m);
      const relevant =
        dates.length === 0 ? !m.watched : dates.some((d) => d >= earliest && d <= latest);
      if (!relevant) return false;
      const neverLookedUp = m.theatricalReleaseDate === undefined || m.digitalReleaseDate === undefined;
      return neverLookedUp || !m.releaseDatesCheckedAt || m.releaseDatesCheckedAt < staleBefore;
    })
    .sort((a, b) => {
      const aNever = a.theatricalReleaseDate === undefined || a.digitalReleaseDate === undefined;
      const bNever = b.theatricalReleaseDate === undefined || b.digitalReleaseDate === undefined;
      if (aNever !== bNever) return aNever ? -1 : 1;
      return distance(a) - distance(b);
    });
}

/**
 * Lookups currently on the wire. The caller re-runs the backfill whenever its
 * candidate list changes - which every successful lookup does - so a new run
 * routinely starts while the previous one's last request is still out. This
 * is what stops the two asking about the same movie.
 */
const inFlight = new Set<number>();

/**
 * Fills in typed release dates for the movies that need them, one request at
 * a time. A failure (offline, rate limited) leaves that movie as it was so a
 * later run retries it; the rest of the batch carries on.
 */
export async function backfillTypedReleaseDates(
  movies: Movie[],
  isCancelled: () => boolean = () => false,
  now = new Date(),
  limit = MAX_LOOKUPS
): Promise<void> {
  for (const movie of moviesNeedingTypedDates(movies, now).slice(0, limit)) {
    if (isCancelled()) return;
    if (inFlight.has(movie.tmdbId)) continue;
    inFlight.add(movie.tmdbId);
    try {
      await storeTypedReleaseDates(movie.tmdbId, now);
    } catch {
      // Left as it was: retried on the next run.
    } finally {
      inFlight.delete(movie.tmdbId);
    }
  }
}
