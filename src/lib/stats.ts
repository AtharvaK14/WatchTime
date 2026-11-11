import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Movie, type Show } from "../db";
import { getTvShowDetails, getMovieDetails } from "../tmdb";
import { averageRuntime } from "./runtime";
import { totalEpisodeCount } from "./episodeSync";

export interface DurationParts {
  months: number;
  days: number;
  hours: number;
}

export function toDurationParts(totalMinutes: number): DurationParts {
  const totalHours = Math.floor(totalMinutes / 60);
  const months = Math.floor(totalHours / (24 * 30));
  const days = Math.floor((totalHours % (24 * 30)) / 24);
  const hours = totalHours % 24;
  return { months, days, hours };
}

// Movies almost always have a real TMDB runtime, but for the rare title
// that doesn't, use the same "don't silently contribute zero forever"
// principle as the show-level fallback. ~110 min is a reasonable general
// movie-length estimate, a judgment call like the show fallback above,
// not a TMDB-confirmed number.
const FALLBACK_MOVIE_RUNTIME_MINUTES = 110;

/**
 * Library rows this session has already tried to fill in, per table. Module
 * level so it outlives the page: leaving Shows or Movies and coming back does
 * not try the same titles again.
 *
 * This is what stops the backfill looping. A title TMDB genuinely has nothing
 * for (no release date, no seasons) is written back with the same empty value
 * it had, so it would still "need" filling after every attempt, and every
 * write to the table, its own included, used to restart the whole pass: one
 * stuck title meant a request, a write and a restart forever, with the
 * progress line above the grid appearing and disappearing each time and the
 * grid jumping with it. Each title now gets one attempt per launch; a failed
 * one is retried on the next launch, never in a tight loop.
 */
const attemptedShows = new Set<number>();
const attemptedMovies = new Set<number>();

/**
 * Fills in rows that need it, one at a time, and reports progress for the
 * line above the grid. Runs while any row still needs filling and has not
 * been tried this session; reads the current rows from a ref on each step, so
 * the writes it makes (live-query updates) never restart it.
 */
function useLibraryBackfill<T extends { tmdbId: number }>(
  rows: T[] | undefined,
  needs: (row: T) => boolean,
  attempted: Set<number>,
  fill: (row: T) => Promise<void>
) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const untried = (row: T) => needs(row) && !attempted.has(row.tmdbId);
  const pending = rows?.some(untried) ?? false;
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    (async () => {
      const total = rowsRef.current?.filter(untried).length ?? 0;
      let done = 0;
      setProgress({ done, total });
      while (!cancelled) {
        const next = rowsRef.current?.find(untried);
        if (!next) break;
        attempted.add(next.tmdbId);
        await fill(next);
        done++;
        if (!cancelled) setProgress({ done, total: Math.max(total, done) });
      }
      if (!cancelled) setProgress(null);
    })();
    return () => {
      cancelled = true;
      // Also reached when the pass's own last attempt is what made `pending`
      // false, before the loop above gets to clear the line itself.
      setProgress(null);
    };
    // `untried`, `needs` and `fill` are module-level logic re-created each
    // render; only whether there is anything to do should restart the pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  return { backfilling: progress !== null, backfillProgress: progress };
}

// == null catches BOTH undefined (never attempted) and null (a past fetch
// attempt that failed, e.g. a network error), so a failed attempt is retried
// (on the next launch, see attemptedShows) instead of contributing zero
// forever. Also catches numberOfEpisodes == null on its own: a show
// backfilled for episodeRuntimeMinutes under an older schema version would
// otherwise sit with no episode total (and no progress bar on the Shows grid)
// permanently.
const showNeedsBackfill = (s: Show) => s.episodeRuntimeMinutes == null || s.numberOfEpisodes == null;

async function backfillShow(show: Show): Promise<void> {
  try {
    const details = await getTvShowDetails(show.tmdbId);
    await db.shows.update(show.tmdbId, {
      episodeRuntimeMinutes: averageRuntime(details.episode_run_time),
      numberOfEpisodes: totalEpisodeCount(details.seasons),
      genreIds: show.genreIds ?? details.genres.map((g) => g.id),
      imdbId: show.imdbId ?? details.external_ids?.imdb_id ?? null,
    });
  } catch {
    // Genuine fetch/network error, leave as null so it's retried next launch
    // (unlike "TMDB responded with no data", which averageRuntime already
    // resolves to the fallback, never null).
    await db.shows.update(show.tmdbId, { episodeRuntimeMinutes: null, numberOfEpisodes: null });
  }
}

const movieNeedsBackfill = (m: Movie) => m.runtimeMinutes == null || m.releaseDate == null;

async function backfillMovie(movie: Movie): Promise<void> {
  try {
    const details = await getMovieDetails(movie.tmdbId);
    await db.movies.update(movie.tmdbId, {
      runtimeMinutes: details.runtime ?? FALLBACK_MOVIE_RUNTIME_MINUTES,
      releaseDate: details.release_date,
      genreIds: movie.genreIds ?? details.genres.map((g) => g.id),
      imdbId: movie.imdbId ?? details.external_ids?.imdb_id ?? null,
    });
  } catch {
    await db.movies.update(movie.tmdbId, { runtimeMinutes: null, releaseDate: null });
  }
}

/** TV time and episode count, rewatch-aware (uses watchCount, not just presence of a row). */
export function useShowStats() {
  const shows = useLiveQuery(() => db.shows.toArray(), []);
  const watched = useLiveQuery(() => db.watchedEpisodes.toArray(), []);
  const episodesWithRuntime = useLiveQuery(
    () => db.episodes.toArray().then((eps) => eps.filter((e) => e.runtimeMinutes != null)),
    []
  );
  const { backfilling, backfillProgress } = useLibraryBackfill(shows, showNeedsBackfill, attemptedShows, backfillShow);

  if (!shows || !watched || !episodesWithRuntime) {
    return {
      loading: true as const,
      backfilling,
      backfillProgress,
      totalMinutes: 0,
      episodeWatchEvents: 0,
      distinctEpisodesWatched: 0,
      exactRuntimeCount: 0,
    };
  }

  const runtimeByShow = new Map(shows.map((s) => [s.tmdbId, s.episodeRuntimeMinutes ?? 0]));
  // Real per-episode runtime (from TVmaze) when we have it, keyed the same
  // way as WatchedEpisode. Falls back to the show-level average otherwise,
  // since TMDB/TVDB don't reliably expose per-episode runtime at all.
  const episodeRuntimeByKey = new Map(episodesWithRuntime.map((e) => [e.key, e.runtimeMinutes as number]));

  let totalMinutes = 0;
  let episodeWatchEvents = 0;
  let exactRuntimeCount = 0;
  for (const w of watched) {
    const count = w.watchCount ?? 1;
    const exact = episodeRuntimeByKey.get(w.key);
    const perEpisodeMinutes = exact ?? runtimeByShow.get(w.showId) ?? 0;
    if (exact != null) exactRuntimeCount++;
    totalMinutes += perEpisodeMinutes * count;
    episodeWatchEvents += count;
  }

  return {
    loading: false as const,
    backfilling,
    backfillProgress,
    totalMinutes,
    episodeWatchEvents,
    distinctEpisodesWatched: watched.length,
    exactRuntimeCount,
  };
}

/** Movie time and count, rewatch-aware (uses rewatchCount). */
export function useMovieStats() {
  const movies = useLiveQuery(() => db.movies.toArray(), []);
  const { backfilling, backfillProgress } = useLibraryBackfill(movies, movieNeedsBackfill, attemptedMovies, backfillMovie);

  if (!movies) {
    return { loading: true as const, backfilling, backfillProgress, totalMinutes: 0, moviesWatched: 0 };
  }

  const watchedMovies = movies.filter((m) => m.watched);
  const totalMinutes = watchedMovies.reduce((sum, m) => {
    const watches = 1 + (m.rewatchCount ?? 0);
    return sum + (m.runtimeMinutes ?? 0) * watches;
  }, 0);

  return { loading: false as const, backfilling, backfillProgress, totalMinutes, moviesWatched: watchedMovies.length };
}
