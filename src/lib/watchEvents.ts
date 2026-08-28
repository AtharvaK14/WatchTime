import { db, episodeKey, type Episode, type WatchedEpisode } from "../db";

/**
 * Single write path for episode watch events (rewatch support). Two
 * distinct operations with deliberately different semantics:
 *
 * - ensureEpisodesWatched: idempotent "make these count as watched". Rows
 *   that already exist are left completely untouched — re-running "mark
 *   season watched" must never reset an imported watchCount back to 1
 *   (the old bulkPut-with-watchCount:1 did exactly that, silently wiping
 *   rewatch history for episodes that were already watched).
 * - recordRewatch: adds one more watch EVENT to rows: watchCount + 1 and
 *   lastWatchedAt = now, never a duplicate row, so time-watched stats grow
 *   while distinct-episodes-watched stays stable.
 *
 * Both bump Show.lastWatchedAt = "last activity of ANY kind" (used by
 * Library's "Recently watched" sort). This is deliberately NOT what the
 * Watch Next / "Haven't Watched For a While" split keys off — that uses
 * last PROGRESSION (lastProgressionAt below), so rewatching old episodes
 * updates history/time/recency without faking forward progress.
 */

/**
 * The most recent time the user watched a previously-UNSEEN episode, i.e.
 * genuine forward progress. WatchedEpisode.watchedAt is the FIRST-watch
 * date and is never touched by a rewatch (rewatches only bump watchCount +
 * lastWatchedAt), so max(watchedAt) across a show's rows is exactly "when
 * did they last advance the series". Null when nothing has been watched.
 *
 * This is the signal the Home category split must use: rewatching S1E1..
 * S2E2 of a stalled show leaves every watchedAt untouched, so the show
 * stays in "Haven't Watched For a While" until S2E3 (a new episode) is
 * actually watched.
 */
export function lastProgressionAt(watched: WatchedEpisode[]): string | null {
  let max: string | null = null;
  for (const w of watched) {
    if (!max || w.watchedAt > max) max = w.watchedAt;
  }
  return max;
}

async function bumpShowRecency(showId: number, when: string): Promise<void> {
  const show = await db.shows.get(showId);
  if (!show) return;
  if (!show.lastWatchedAt || when > show.lastWatchedAt) {
    await db.shows.update(showId, { lastWatchedAt: when });
  }
}

export async function ensureEpisodesWatched(showId: number, eps: Episode[]): Promise<void> {
  if (eps.length === 0) return;
  const now = new Date().toISOString();
  const keys = eps.map((ep) => ep.key);
  const existing = await db.watchedEpisodes.bulkGet(keys);
  const missing: WatchedEpisode[] = [];
  eps.forEach((ep, i) => {
    if (existing[i]) return; // already watched: leave its history alone
    missing.push({
      key: ep.key,
      showId,
      seasonNumber: ep.seasonNumber,
      episodeNumber: ep.episodeNumber,
      watchedAt: now,
      watchCount: 1,
      lastWatchedAt: now,
    });
  });
  if (missing.length > 0) await db.watchedEpisodes.bulkPut(missing);
  await bumpShowRecency(showId, now);
}

export async function recordEpisodeRewatch(showId: number, eps: Episode[]): Promise<void> {
  if (eps.length === 0) return;
  const now = new Date().toISOString();
  const keys = eps.map((ep) => ep.key);
  const existing = await db.watchedEpisodes.bulkGet(keys);
  const records: WatchedEpisode[] = eps.map((ep, i) => {
    const prior = existing[i];
    return prior
      ? { ...prior, watchCount: (prior.watchCount ?? 1) + 1, lastWatchedAt: now }
      : {
          // Rewatching something never marked watched (possible via the
          // season-level "Watch again"): it becomes a first watch.
          key: ep.key,
          showId,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          watchedAt: now,
          watchCount: 1,
          lastWatchedAt: now,
        };
  });
  await db.watchedEpisodes.bulkPut(records);
  await bumpShowRecency(showId, now);
}

/**
 * Home's Watch Next checkmark: works for both a first watch and an active
 * rewatch pass, because it operates on whatever row state exists.
 *
 * `when` exists for the home-screen widget. A tap on the widget cannot write
 * to the database from the launcher process, so it is queued natively and
 * replayed here the next time the app runs - which can be hours later. The
 * recorded watch must be when the user actually tapped, not when the replay
 * happened, or the Watch Next ordering (which sorts on exactly this value)
 * would quietly disagree with what the user did. Defaults to now, so every
 * in-app caller is unaffected.
 */
export async function markNextEpisodeWatched(showId: number, ep: {
  seasonNumber: number;
  episodeNumber: number;
}, when?: string): Promise<void> {
  const key = episodeKey(showId, ep.seasonNumber, ep.episodeNumber);
  const now = when ?? new Date().toISOString();
  const prior = await db.watchedEpisodes.get(key);
  await db.watchedEpisodes.put(
    prior
      ? { ...prior, watchCount: (prior.watchCount ?? 1) + 1, lastWatchedAt: now }
      : {
          key,
          showId,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          watchedAt: now,
          watchCount: 1,
          lastWatchedAt: now,
        }
  );
  await bumpShowRecency(showId, now);
}

/** Records one more watch of an already-watched movie: rewatchCount + 1, watchedAt = latest. Never a new row, never inflates "movies watched". */
export async function recordMovieRewatch(tmdbId: number): Promise<void> {
  const movie = await db.movies.get(tmdbId);
  if (!movie || !movie.watched) return;
  await db.movies.update(tmdbId, {
    rewatchCount: (movie.rewatchCount ?? 0) + 1,
    watchedAt: new Date().toISOString(),
  });
}
