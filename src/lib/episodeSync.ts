import { db, episodeKey, type Episode } from "../db";
import { getTvShowDetails, getSeasonDetails, type TvShowDetails } from "../tmdb";
import { getTvmazeRuntimesByTvdbId } from "../tvmaze";
import { daysAgoIso, todayIso } from "./releaseState";

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
 * Seasons already refreshed in this browser session because they were
 * mid-run, keyed `${tmdbId}:${season}`.
 *
 * A season that is currently airing has to be re-read occasionally even when
 * nothing about it looks wrong locally, because TMDB revises air dates during
 * a run. Once per session is the right frequency for that: it is the same
 * order of cost as the first sync, and a date correction that arrives a few
 * hours late changes nothing the user can act on. Deliberately in memory
 * only - persisting it would buy a handful of requests and cost a schema
 * field that means nothing outside a single run of the app.
 */
const refreshedInFlightSeasons = new Set<string>();

/** How far back a season still counts as "mid-run" for the refresh above. */
const IN_FLIGHT_LOOKBACK_DAYS = 21;

/**
 * Whether a cached season still looks live: an episode still to come, or one
 * that landed within the last few weeks. Those are the seasons whose episode
 * list can still change under us.
 */
function seasonIsInFlight(cached: Episode[], now: Date): boolean {
  const today = todayIso(now);
  const recent = daysAgoIso(IN_FLIGHT_LOOKBACK_DAYS, now);
  return cached.some((ep) => ep.airDate !== null && (ep.airDate > today || ep.airDate >= recent));
}

/** Replaces one season's cached episodes with a freshly fetched list. */
async function fetchSeasonInto(tmdbId: number, seasonNumber: number, cached: Episode[]): Promise<void> {
  const season = await getSeasonDetails(tmdbId, seasonNumber);
  const records = await toEpisodeRecords(tmdbId, seasonNumber, season.episodes);
  const fresh = new Set(records.map((r) => r.key));
  // Rows TMDB no longer lists (a renumbered or withdrawn episode) are dropped
  // rather than left behind. Without this, a season that shrinks upstream
  // would fail the count check on every single sync and re-fetch forever.
  const removed = cached.filter((ep) => !fresh.has(ep.key)).map((ep) => ep.key);
  if (removed.length > 0) await db.episodes.bulkDelete(removed);
  await db.episodes.bulkPut(records);
}

/**
 * Makes sure every season's episode list for a show is cached locally, and
 * that the ones which can still change are up to date.
 *
 * Used by Home, which needs the "next unwatched episode" across every
 * followed show without the user having opened each show page first.
 *
 * It used to fetch only seasons it held NOTHING for, which was the quiet half
 * of the returning-shows bug. A season first cached while TMDB listed one
 * dated episode stayed a one-episode season locally forever: the rest of the
 * run never appeared in Watch Next, and the notification scheduler - which
 * reads these same rows - never saw an episode to announce. A season is now
 * re-read when either
 *
 *   - TMDB's episode_count disagrees with what is cached (episodes were added
 *     or removed upstream since the first fetch), or
 *   - it is still in flight and has not been refreshed yet this session.
 *
 * Neither costs a request when nothing has changed: episode_count arrives in
 * the show details response this function already fetches, and a finished
 * season is never in flight.
 */
export async function ensureEpisodesCached(tmdbId: number, now = new Date()): Promise<number[]> {
  const details = await getTvShowDetails(tmdbId);
  const realSeasons = details.seasons.filter((s) => s.season_number > 0);
  const seasonNumbers = realSeasons.map((s) => s.season_number);

  const existing = await db.episodes.where("showId").equals(tmdbId).toArray();
  const cachedBySeason = new Map<number, Episode[]>();
  for (const ep of existing) {
    const list = cachedBySeason.get(ep.seasonNumber);
    if (list) list.push(ep);
    else cachedBySeason.set(ep.seasonNumber, [ep]);
  }

  for (const season of realSeasons) {
    const cached = cachedBySeason.get(season.season_number) ?? [];
    const inFlightKey = `${tmdbId}:${season.season_number}`;
    const countChanged = cached.length !== season.episode_count;
    const inFlight =
      cached.length > 0 && !refreshedInFlightSeasons.has(inFlightKey) && seasonIsInFlight(cached, now);
    if (!countChanged && !inFlight) continue;

    // Marked before the request, not after: a season whose fetch fails should
    // not be retried on every re-render for the rest of the session. The
    // count check above still catches it on the next app launch.
    if (inFlight) refreshedInFlightSeasons.add(inFlightKey);
    await fetchSeasonInto(tmdbId, season.season_number, cached);
  }

  return seasonNumbers;
}

/**
 * Fetches just the season list (numbers only, cheap) without pulling every
 * season's full episode list. Used by ShowDetail's accordion, which fetches
 * a season's episodes only when the user actually expands it.
 */
export async function getSeasonNumbers(tmdbId: number): Promise<number[]> {
  const details = await getTvShowDetails(tmdbId);
  return details.seasons.map((s) => s.season_number).filter((n) => n > 0);
}

/** Fetches and caches one season's episodes, only if not already cached. */
export async function ensureSeasonCached(tmdbId: number, seasonNumber: number): Promise<void> {
  const existing = await db.episodes.where("[showId+seasonNumber]").equals([tmdbId, seasonNumber]).count();
  if (existing > 0) return;
  const season = await getSeasonDetails(tmdbId, seasonNumber);
  const records = await toEpisodeRecords(tmdbId, seasonNumber, season.episodes);
  await db.episodes.bulkPut(records);
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
