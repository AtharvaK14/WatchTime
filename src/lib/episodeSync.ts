import { db, episodeKey, type Episode } from "../db";
import { getTvShowDetails, getSeasonDetails, type TvShowDetails } from "../tmdb";
import { getTvmazeRuntimesByTvdbId } from "../tvmaze";

/**
 * Sum of episode_count across real seasons (season_number > 0, excluding
 * specials), matching the same filter already used everywhere else in this
 * file for season numbers. Used to populate Show.numberOfEpisodes, which
 * powers the watched/total progress bar on the Shows grid, added at every
 * write site (DetailsPanel's handleAdd, both importers, and the stats.ts
 * backfill) since existing shows predate this field.
 */
export function totalEpisodeCount(seasons: TvShowDetails["seasons"]): number {
  return seasons.filter((s) => s.season_number > 0).reduce((sum, s) => sum + s.episode_count, 0);
}

// In-memory cache of TVmaze runtime lookups, keyed by tmdbId, for this
// browser session only (not persisted, cheap to re-derive, and TVmaze data
// doesn't change often enough to justify Dexie persistence complexity).
// Avoids re-fetching TVmaze once per season for the same show.
const tvmazeRuntimeCache = new Map<number, Promise<Map<string, number>>>();

async function getTvmazeRuntimesForShow(tmdbId: number): Promise<Map<string, number>> {
  const cached = tvmazeRuntimeCache.get(tmdbId);
  if (cached) return cached;

  const promise = (async () => {
    const show = await db.shows.get(tmdbId);
    if (!show?.tvdbId) return new Map<string, number>();
    return getTvmazeRuntimesByTvdbId(show.tvdbId);
  })();
  tvmazeRuntimeCache.set(tmdbId, promise);
  return promise;
}

async function toEpisodeRecords(
  tmdbId: number,
  seasonNumber: number,
  episodes: {
    episode_number: number;
    name: string;
    overview: string | null;
    air_date: string | null;
    vote_average: number;
    still_path: string | null;
  }[]
): Promise<Episode[]> {
  const tvmazeRuntimes = await getTvmazeRuntimesForShow(tmdbId);
  return episodes.map((ep) => ({
    key: episodeKey(tmdbId, seasonNumber, ep.episode_number),
    showId: tmdbId,
    seasonNumber,
    episodeNumber: ep.episode_number,
    name: ep.name,
    overview: ep.overview,
    airDate: ep.air_date,
    tmdbRating: ep.vote_average,
    stillPath: ep.still_path,
    runtimeMinutes: tvmazeRuntimes.get(`${seasonNumber}-${ep.episode_number}`) ?? null,
  }));
}

/**
 * How long a still-airing show's episode data stays trusted before its
 * newest season is pulled again.
 *
 * Twelve hours is a deliberate compromise. Episodes air at most daily, so
 * anything shorter buys nothing; anything much longer and a show watched the
 * morning after broadcast still shows a placeholder. Bounded cost: one extra
 * TMDB request per RETURNING show per twelve hours, and only for its latest
 * season, not the whole back catalogue.
 */
const AIRING_REFRESH_HOURS = 12;

/**
 * TMDB statuses that mean "more episodes are expected". Anything else —
 * "Ended", "Canceled" — has a fixed episode list, so once cached it is
 * genuinely complete and never needs re-pulling.
 */
const STILL_AIRING = new Set(["Returning Series", "In Production", "Planned", "Pilot"]);

function isStale(syncedAt: string | undefined, hours: number): boolean {
  if (!syncedAt) return true; // never synced, or cached before this field existed
  const age = Date.now() - new Date(syncedAt).getTime();
  return !Number.isFinite(age) || age > hours * 3600_000;
}

/**
 * Makes sure every season's episode list for a show is cached locally. Used
 * by Home, which needs the "next unwatched episode" across every followed
 * show without the user having opened each show page first.
 *
 * A season is (re)fetched when any of these hold:
 *
 *   1. Nothing is cached for it yet.
 *   2. TMDB now lists more episodes than we hold. This is free to check —
 *      episode_count comes back in the show details response we already
 *      fetched — and catches a season that gained episodes after we cached it.
 *   3. The show is still airing and our data has gone stale, in which case
 *      the LATEST season is re-pulled. This is the case count alone cannot
 *      catch: TMDB publishes upcoming episodes as placeholders and fills in
 *      the real title, overview and still only once they air, so the count
 *      never changes but the contents do. Without this, a weekly show sat
 *      permanently on "Episode 5" with no artwork.
 *
 * Re-fetching is safe: records are keyed by show/season/episode and written
 * with bulkPut, so they update in place. Watched state lives in a separate
 * table and is never touched by any of this.
 */
export async function ensureEpisodesCached(tmdbId: number): Promise<number[]> {
  const details = await getTvShowDetails(tmdbId);
  const seasonNumbers = details.seasons.map((s) => s.season_number).filter((n) => n > 0);

  const existing = await db.episodes.where("showId").equals(tmdbId).toArray();
  const cachedCount = new Map<number, number>();
  for (const e of existing) cachedCount.set(e.seasonNumber, (cachedCount.get(e.seasonNumber) ?? 0) + 1);

  const expectedCount = new Map(
    details.seasons.filter((s) => s.season_number > 0).map((s) => [s.season_number, s.episode_count])
  );

  const show = await db.shows.get(tmdbId);
  const airing = STILL_AIRING.has(details.status);
  const stale = airing && isStale(show?.episodesSyncedAt, AIRING_REFRESH_HOURS);
  const latestSeason = seasonNumbers.length ? Math.max(...seasonNumbers) : null;

  const toFetch = seasonNumbers.filter((s) => {
    const have = cachedCount.get(s) ?? 0;
    if (have === 0) return true;
    if (have < (expectedCount.get(s) ?? 0)) return true;
    return stale && s === latestSeason;
  });

  for (const seasonNumber of toFetch) {
    const season = await getSeasonDetails(tmdbId, seasonNumber);
    const records = await toEpisodeRecords(tmdbId, seasonNumber, season.episodes);
    await db.episodes.bulkPut(records);
  }

  // Stamped even when nothing needed fetching, so a returning show is not
  // re-checked on every single Home visit — the point of the timestamp is to
  // bound how often we ask, not to record that we found something.
  if (show && airing) {
    await db.shows.update(tmdbId, { episodesSyncedAt: new Date().toISOString() });
  }

  return seasonNumbers;
}

export interface SeasonSummary {
  seasonNumber: number;
  /** TMDB's episode_count for this season, including not-yet-aired entries. */
  episodeCount: number;
}

/**
 * Fetches just the season list (one request, no per-season episode lists).
 * Used by the details panel's accordion, which pulls a season's episodes only
 * when the user actually expands it.
 *
 * Returns episodeCount alongside the number so the caller can tell
 * ensureSeasonCached what TMDB believes the season holds — that comparison is
 * what catches a season that has gained episodes since it was cached, and it
 * costs nothing extra because the count arrives in this same response.
 */
export async function getSeasonSummaries(tmdbId: number): Promise<SeasonSummary[]> {
  const details = await getTvShowDetails(tmdbId);
  return details.seasons
    .filter((s) => s.season_number > 0)
    .map((s) => ({ seasonNumber: s.season_number, episodeCount: s.episode_count }));
}

/**
 * Fetches and caches one season's episodes, for the details panel's
 * accordion. Re-fetches on the same terms as ensureEpisodesCached: having
 * SOME episodes cached is not proof the season is complete or current.
 *
 * `expectedCount` is the season's episode_count from TMDB, which the caller
 * already holds from the show details response. Passing it lets a season that
 * has gained episodes be spotted without a request; omitting it just falls
 * back to the staleness rule.
 */
export async function ensureSeasonCached(
  tmdbId: number,
  seasonNumber: number,
  expectedCount?: number
): Promise<void> {
  const existing = await db.episodes.where("[showId+seasonNumber]").equals([tmdbId, seasonNumber]).count();

  if (existing > 0) {
    if (expectedCount === undefined || existing >= expectedCount) {
      // Complete as far as the count goes. Still re-pull if this is an airing
      // show whose data has aged out, since placeholders for upcoming
      // episodes get their real title and still filled in later.
      const show = await db.shows.get(tmdbId);
      if (!show || !STILL_AIRING.has(show.status) || !isStale(show.episodesSyncedAt, AIRING_REFRESH_HOURS)) {
        return;
      }
    }
  }

  const season = await getSeasonDetails(tmdbId, seasonNumber);
  const records = await toEpisodeRecords(tmdbId, seasonNumber, season.episodes);
  await db.episodes.bulkPut(records);
  const show = await db.shows.get(tmdbId);
  if (show && STILL_AIRING.has(show.status)) {
    await db.shows.update(tmdbId, { episodesSyncedAt: new Date().toISOString() });
  }
}

/**
 * An episode counts as available to watch unless TMDB gives a CONFIRMED
 * future air date. A missing air date is treated as available, not
 * excluded, missing data means TMDB doesn't have the date populated yet,
 * it is not confirmation the episode hasn't aired. Treating missing as
 * "not aired" was the actual bug behind Watch Next silently hiding
 * episodes that were correctly marked unwatched but had incomplete TMDB
 * date data, confirmed via Diagnostics against a real show (Spider-Noir).
 */
export function isAvailableToWatch(airDate: string | null, today: string): boolean {
  if (!airDate) return true;
  return airDate <= today;
}

/** The next available, unwatched episode for a show, in season/episode order. Null if none (up to date, or nothing cached yet). */
export function findNextUnwatched(episodes: Episode[], watchedKeys: Set<string>): Episode | null {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...episodes].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  for (const ep of sorted) {
    if (isAvailableToWatch(ep.airDate, today) && !watchedKeys.has(ep.key)) return ep;
  }
  return null;
}

/**
 * How many available-but-unwatched episodes exist beyond the immediate next
 * one, for the "+N" badge TV Time shows (e.g. "S01|E04 +4"). Returns 0 if
 * the next episode is the only one waiting.
 */
export function countAdditionalUnwatched(episodes: Episode[], watchedKeys: Set<string>): number {
  const today = new Date().toISOString().slice(0, 10);
  const unwatchedAvailable = episodes.filter((ep) => isAvailableToWatch(ep.airDate, today) && !watchedKeys.has(ep.key));
  return Math.max(0, unwatchedAvailable.length - 1);
}

/**
 * Nearest not-yet-aired episode, for Home's "Coming up" section. Mirror of
 * isAvailableToWatch's future-date check, but deliberately NOT the mirror
 * of its missing-date handling: isAvailableToWatch treats a missing
 * air_date as available (correct for Watch Next, where absence of proof
 * shouldn't hide something you might already be able to watch), but here
 * that same missing-date case must NOT count as "upcoming", an unknown
 * date is not a confirmed future one, and showing it under "coming up"
 * would overclaim something TMDB hasn't actually told us.
 */
export function findNextUpcoming(episodes: Episode[], today = new Date().toISOString().slice(0, 10)): Episode | null {
  const upcoming = episodes
    .filter((ep) => ep.airDate && ep.airDate > today)
    .sort((a, b) => (a.airDate as string).localeCompare(b.airDate as string));
  return upcoming[0] ?? null;
}
