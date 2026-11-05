import { db, episodeKey, type Episode, type WatchedEpisode } from "../db";
import { availableInProgression, ensureEpisodesCached } from "./episodeSync";
import {
  episodeWatchCount,
  firstWatchRecord,
  movieWatchCount,
  withMovieRewatch,
  withMovieWatchedOnce,
  withoutLatestMovieViewing,
  withoutLatestViewing,
  withRewatch,
  withWatchedOnce,
} from "./watchHistory";

/**
 * The single write path for viewing history. Every screen that records,
 * repeats or clears a viewing - the season browser, its green-tick menu, the
 * episode panel, Watch Next, the widget overlay, deep links and Quick Actions -
 * calls these, so there is one implementation of each operation and no screen
 * can apply different rules. What the stored fields mean is set out in
 * lib/watchHistory.ts.
 *
 * - ensureEpisodesWatched: idempotent "make these count as watched". Rows
 *   that already exist are left completely untouched — re-running "mark
 *   season watched" must never reset an imported watchCount back to 1
 *   (the old bulkPut-with-watchCount:1 did exactly that, silently wiping
 *   rewatch history for episodes that were already watched).
 * - recordEpisodeRewatch: adds one more watch EVENT to rows: watchCount + 1 and
 *   lastWatchedAt = now, never a duplicate row, so time-watched stats grow
 *   while distinct-episodes-watched stays stable.
 * - setEpisodesWatchedOnce / markEpisodesUnwatched: the two corrections.
 *
 * Every read-modify-write runs inside ONE transaction. They used to be a read
 * followed by a separate write, so two rewatches landing together (a double
 * tap) both read the same count and both wrote count + 1: one viewing was
 * silently lost. IndexedDB serialises overlapping read-write transactions,
 * which makes each increment atomic.
 *
 * Separately, an identical operation that is already in flight is not started
 * a second time (see `once`): a double tap records one viewing, not two.
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

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Runs `op` unless the identical operation is already running, in which case
 * the caller shares that run instead of starting a second one. This is what
 * turns a double tap on "Watched again" into one viewing rather than two. It
 * is keyed on the operation AND its targets, so two different actions (a
 * rewatch of one episode while its season is being rewatched) both happen.
 */
function once<T>(id: string, op: () => Promise<T>): Promise<T> {
  const running = inFlight.get(id);
  if (running) return running as Promise<T>;
  const run = op().finally(() => inFlight.delete(id));
  inFlight.set(id, run);
  return run;
}

/** Inside an open transaction: moves Show.lastWatchedAt forward, never back. */
async function bumpShowRecency(showId: number, when: string): Promise<void> {
  const show = await db.shows.get(showId);
  if (!show) return;
  if (!show.lastWatchedAt || when > show.lastWatchedAt) {
    await db.shows.update(showId, { lastWatchedAt: when });
  }
}

type EpisodeRef = Pick<Episode, "key" | "seasonNumber" | "episodeNumber">;

const keysOf = (eps: { key: string }[]) => eps.map((e) => e.key).join(",");

/** First viewings for the episodes not yet watched. Returns how many were newly marked. */
export function ensureEpisodesWatched(showId: number, eps: EpisodeRef[], when?: string): Promise<number> {
  if (eps.length === 0) return Promise.resolve(0);
  return once(`watch:${keysOf(eps)}`, () =>
    db.transaction("rw", db.watchedEpisodes, db.shows, async () => {
      const now = when ?? new Date().toISOString();
      const existing = await db.watchedEpisodes.bulkGet(eps.map((ep) => ep.key));
      // Already watched: its history is left alone.
      const missing = eps.filter((_, i) => !existing[i]).map((ep) => firstWatchRecord(showId, ep, now));
      if (missing.length > 0) await db.watchedEpisodes.bulkPut(missing);
      await bumpShowRecency(showId, now);
      return missing.length;
    })
  );
}

/**
 * One more viewing EVENT for each episode: watchCount + 1 and the latest date,
 * never a second row. Returns how many viewing events were recorded.
 *
 * An episode with no row becomes a first watch. No screen offers a rewatch of
 * an unwatched episode (the season action requires the whole season watched),
 * but a stale view must not be able to turn a rewatch into nothing at all.
 */
export function recordEpisodeRewatch(showId: number, eps: EpisodeRef[], when?: string): Promise<number> {
  if (eps.length === 0) return Promise.resolve(0);
  return once(`rewatch:${keysOf(eps)}`, () =>
    db.transaction("rw", db.watchedEpisodes, db.shows, async () => {
      const now = when ?? new Date().toISOString();
      const existing = await db.watchedEpisodes.bulkGet(eps.map((ep) => ep.key));
      const records = eps.map((ep, i) => {
        const prior = existing[i];
        return prior ? withRewatch(prior, now) : firstWatchRecord(showId, ep, now);
      });
      await db.watchedEpisodes.bulkPut(records);
      await bumpShowRecency(showId, now);
      return records.length;
    })
  );
}

/**
 * "Watched once": each watched episode's count back to one, keeping its
 * original viewing date. Unwatched episodes are not marked by this - it is a
 * correction to a count, not a way to record a viewing. Returns how many
 * rows changed.
 */
export function setEpisodesWatchedOnce(showId: number, eps: { key: string }[]): Promise<number> {
  if (eps.length === 0) return Promise.resolve(0);
  return once(`once:${keysOf(eps)}`, () =>
    db.transaction("rw", db.watchedEpisodes, async () => {
      const existing = await db.watchedEpisodes.bulkGet(eps.map((ep) => ep.key));
      const changed = existing.filter(
        (row): row is WatchedEpisode => !!row && row.showId === showId && episodeWatchCount(row) !== 1
      );
      if (changed.length > 0) await db.watchedEpisodes.bulkPut(changed.map(withWatchedOnce));
      return changed.length;
    })
  );
}

/**
 * "Remove last viewing": undoes the most recent rewatch of one episode (see
 * withoutLatestViewing for exactly what is restored). The episode stays
 * watched, with its first viewing untouched. Rejects for an episode watched
 * only once, so a stale menu cannot turn this into an unwatch. Returns the
 * new count.
 */
export function removeLatestEpisodeViewing(showId: number, ep: { key: string }): Promise<number> {
  return once(`unrewatch:${ep.key}`, () =>
    db.transaction("rw", db.watchedEpisodes, async () => {
      const prior = await db.watchedEpisodes.get(ep.key);
      if (!prior || prior.showId !== showId) throw new Error("This episode isn't marked as watched.");
      const next = withoutLatestViewing(prior);
      await db.watchedEpisodes.put(next);
      return next.watchCount;
    })
  );
}

/**
 * Not watched. Deletes the episodes' rows, which is what "unwatched" is in
 * this data model: the row existing IS the watched state, and every list,
 * count and Watch Next rule reads it that way. Keeping a zero-count row
 * would have every one of those readers treat the episode as watched.
 * Returns the rows removed, so a caller can say how many viewings went.
 */
export function markEpisodesUnwatched(showId: number, eps: { key: string }[]): Promise<WatchedEpisode[]> {
  if (eps.length === 0) return Promise.resolve([]);
  return once(`unwatch:${keysOf(eps)}`, () =>
    db.transaction("rw", db.watchedEpisodes, async () => {
      const keys = eps.map((ep) => ep.key);
      const existing = (await db.watchedEpisodes.bulkGet(keys)).filter(
        (row): row is WatchedEpisode => !!row && row.showId === showId
      );
      await db.watchedEpisodes.bulkDelete(existing.map((row) => row.key));
      return existing;
    })
  );
}

/**
 * Show-level "Mark as Watched": first viewings for every RELEASED episode not
 * yet watched, already-watched ones untouched. The episode list is synced
 * first (a network read) because a show opened only on Home may not have
 * every season cached, and marking only the cached ones would quietly leave
 * the rest unwatched. Unaired episodes are never marked. Returns how many
 * were newly marked.
 */
export function markShowWatched(showId: number): Promise<number> {
  return once(`show-watch:${showId}`, async () => {
    await ensureEpisodesCached(showId);
    const episodes = await db.episodes.where("showId").equals(showId).toArray();
    const released = availableInProgression(episodes, new Date().toISOString().slice(0, 10));
    return ensureEpisodesWatched(showId, released);
  });
}

/** Show-level "Mark as Unwatched": every watch row of the show. Returns the rows removed. */
export function markShowUnwatched(showId: number): Promise<WatchedEpisode[]> {
  return once(`show-unwatch:${showId}`, () =>
    db.transaction("rw", db.watchedEpisodes, async () => {
      const rows = await db.watchedEpisodes.where("showId").equals(showId).toArray();
      await db.watchedEpisodes.bulkDelete(rows.map((row) => row.key));
      return rows;
    })
  );
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
export function markNextEpisodeWatched(showId: number, ep: {
  seasonNumber: number;
  episodeNumber: number;
}, when?: string): Promise<void> {
  const key = episodeKey(showId, ep.seasonNumber, ep.episodeNumber);
  return once(`next:${key}`, () =>
    db.transaction("rw", db.watchedEpisodes, db.shows, async () => {
      const now = when ?? new Date().toISOString();
      const prior = await db.watchedEpisodes.get(key);
      await db.watchedEpisodes.put(prior ? withRewatch(prior, now) : firstWatchRecord(showId, { key, ...ep }, now));
      await bumpShowRecency(showId, now);
    })
  );
}

/**
 * Records one more watch of an already-watched movie: rewatchCount + 1 and
 * watchedAt = latest, with the first viewing date kept in firstWatchedAt.
 * Never a new row, never inflates "movies watched". Rejects (rather than
 * quietly doing nothing) when the movie is not in the library or not watched,
 * so no caller can show a rewatch that was not recorded. Returns the new
 * total number of viewings.
 */
export function recordMovieRewatch(tmdbId: number): Promise<number> {
  return once(`movie-rewatch:${tmdbId}`, () =>
    db.transaction("rw", db.movies, async () => {
      const movie = await db.movies.get(tmdbId);
      if (!movie) throw new Error("This movie is no longer in your library.");
      if (!movie.watched) throw new Error("This movie isn't marked as watched yet.");
      const changes = withMovieRewatch(movie, new Date().toISOString());
      await db.movies.update(tmdbId, changes);
      return 1 + (changes.rewatchCount ?? 0);
    })
  );
}

/**
 * "Remove last viewing" for a movie: one fewer viewing, the movie still
 * watched (see withoutLatestMovieViewing). Rejects when it has only one
 * viewing: that is "Not watched", a separate action. Returns the new total.
 */
export function removeLatestMovieViewing(tmdbId: number): Promise<number> {
  return once(`movie-unrewatch:${tmdbId}`, () =>
    db.transaction("rw", db.movies, async () => {
      const movie = await db.movies.get(tmdbId);
      if (!movie) throw new Error("This movie is no longer in your library.");
      await db.movies.update(tmdbId, withoutLatestMovieViewing(movie));
      const stored = await db.movies.get(tmdbId);
      return stored ? movieWatchCount(stored) : 0;
    })
  );
}

/** "Watched once" for a movie: its rewatches cleared, the first viewing kept. Returns the new total (1). */
export function setMovieWatchedOnce(tmdbId: number): Promise<number> {
  return once(`movie-once:${tmdbId}`, () =>
    db.transaction("rw", db.movies, async () => {
      const movie = await db.movies.get(tmdbId);
      if (!movie) throw new Error("This movie is no longer in your library.");
      if (!movie.watched) throw new Error("This movie isn't marked as watched yet.");
      await db.movies.update(tmdbId, withMovieWatchedOnce(movie));
      return 1;
    })
  );
}
