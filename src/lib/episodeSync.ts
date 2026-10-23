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
 * When each live season was last re-read, keyed `${tmdbId}:${season}`, as
 * epoch millis.
 *
 * A season that is currently airing has to be re-read occasionally even when
 * nothing about it looks wrong locally, because TMDB revises air dates during
 * a run. Deliberately in memory only - persisting it would buy a handful of
 * requests and cost a schema field that means nothing outside a run of the
 * app.
 *
 * It used to be a set, "refreshed once this session". On Android the
 * WebView's session is the life of the process, which routinely runs for
 * days in the background, so "once per session" could mean once a week: a
 * date TMDB filled in or moved after that one read was never seen, and
 * neither the notification scheduler nor Coming Up could know about it.
 */
const lastInFlightRefresh = new Map<string, number>();

/**
 * How often a live season is re-read. A few times a day is the same order of
 * cost as the first sync spread thin, and a date correction that arrives a few
 * hours late changes nothing the user can act on.
 */
export const IN_FLIGHT_REFRESH_MS = 6 * 60 * 60 * 1000;

/** How far back a season still counts as "mid-run" for the refresh above. */
const IN_FLIGHT_LOOKBACK_DAYS = 21;

/** How old a season's dated episodes can be before its undated ones count as a permanent gap. */
const UNDATED_GAP_AFTER_DAYS = 365;

/**
 * Whether a cached season still looks live - one whose episode list or dates
 * can still change under us:
 *
 *  - an episode still to come, or one that landed within the last few weeks;
 *  - or it is the show's latest season, TMDB has not dated some of its
 *    episodes yet, and none of it aired over a year ago.
 *
 * The second case is the one that used to be missed. An announced season is
 * often listed on TMDB with all of its episodes and no dates at all - and
 * streaming drops are often only dated around release. A season first cached
 * in that state had no dated episode to look live and the same episode count
 * as TMDB, so it was never read again: the dates arrived upstream and never
 * reached the cache, and a whole-season release was never scheduled as a
 * notification. Limited to the latest season, and to one that is not old, so
 * a finished season with a permanent gap in TMDB's data is not re-read
 * forever. TMDB's show status is deliberately not consulted: it is often still
 * "Ended" for a while after a new season is announced.
 */
function seasonIsInFlight(cached: Episode[], now: Date, isLatestSeason: boolean): boolean {
  const today = todayIso(now);
  const recent = daysAgoIso(IN_FLIGHT_LOOKBACK_DAYS, now);
  if (cached.some((ep) => ep.airDate !== null && (ep.airDate > today || ep.airDate >= recent))) return true;
  if (!isLatestSeason || !cached.some((ep) => !ep.airDate)) return false;
  const old = daysAgoIso(UNDATED_GAP_AFTER_DAYS, now);
  return !cached.some((ep) => ep.airDate !== null && ep.airDate < old);
}

export interface SeasonRefresh {
  seasonNumber: number;
  /** "count": TMDB's episode count differs from the cache. "in-flight": live, and not re-read recently. */
  reason: "count" | "in-flight";
}

/**
 * Which of a show's seasons to re-read, from the show details response and the
 * cached episodes. Pure, so the scenario scripts can run the exact decision
 * ensureEpisodesCached makes. `lastRefreshed` is read, never written.
 */
export function seasonsNeedingRefresh(
  details: Pick<TvShowDetails, "id" | "seasons">,
  cachedBySeason: Map<number, Episode[]>,
  now: Date,
  lastRefreshed: ReadonlyMap<string, number> = lastInFlightRefresh
): SeasonRefresh[] {
  const realSeasons = details.seasons.filter((s) => s.season_number > 0);
  const latest = Math.max(0, ...realSeasons.map((s) => s.season_number));

  const refresh: SeasonRefresh[] = [];
  for (const season of realSeasons) {
    const cached = cachedBySeason.get(season.season_number) ?? [];
    if (cached.length !== season.episode_count) {
      refresh.push({ seasonNumber: season.season_number, reason: "count" });
      continue;
    }
    if (cached.length === 0) continue;
    const last = lastRefreshed.get(`${details.id}:${season.season_number}`);
    if (last !== undefined && now.getTime() - last < IN_FLIGHT_REFRESH_MS) continue;
    if (seasonIsInFlight(cached, now, season.season_number === latest)) {
      refresh.push({ seasonNumber: season.season_number, reason: "in-flight" });
    }
  }
  return refresh;
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
 *   - it is still in flight (see seasonIsInFlight) and has not been re-read
 *     in the last IN_FLIGHT_REFRESH_MS.
 *
 * Neither costs a request when nothing has changed: episode_count arrives in
 * the show details response this function already fetches, and a finished
 * season is never in flight.
 */
export async function ensureEpisodesCached(tmdbId: number, now = new Date()): Promise<number[]> {
  const details = await getTvShowDetails(tmdbId);
  const seasonNumbers = details.seasons.filter((s) => s.season_number > 0).map((s) => s.season_number);

  const existing = await db.episodes.where("showId").equals(tmdbId).toArray();
  const cachedBySeason = new Map<number, Episode[]>();
  for (const ep of existing) {
    const list = cachedBySeason.get(ep.seasonNumber);
    if (list) list.push(ep);
    else cachedBySeason.set(ep.seasonNumber, [ep]);
  }

  for (const { seasonNumber } of seasonsNeedingRefresh(details, cachedBySeason, now)) {
    // Marked before the request, not after: a season whose fetch fails should
    // not be retried on every re-render until the interval is up. The count
    // check is not subject to it, so a count change is still fetched on the
    // next sync. A count fetch is a fresh read too, so it is marked as well.
    lastInFlightRefresh.set(`${tmdbId}:${seasonNumber}`, now.getTime());
    await fetchSeasonInto(tmdbId, seasonNumber, cachedBySeason.get(seasonNumber) ?? []);
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

/**
 * A show's available episodes, in season/episode order.
 *
 * isAvailableToWatch() decides each episode on its own, which is right for a
 * missing date in isolation and wrong for one that comes AFTER a confirmed
 * future episode. TMDB routinely lists an announced season as a dated premiere
 * followed by undated episodes; those cannot have aired before the premiere
 * has, so they are not available whatever their missing date would otherwise
 * suggest. Without this a user caught up and waiting for that premiere looked
 * part-way through the show - pointed at an unaired "next episode" in Watch
 * Next, and filed as stale (and so dropped from Upcoming Episodes) once the
 * break outlasted the staleness threshold.
 *
 * Only undated episodes are inferred this way. A confirmed past date is still
 * believed wherever it sits, and an undated episode with nothing scheduled
 * before it is still available, which is the Spider-Noir case unchanged.
 */
function availableInProgression(episodes: Episode[], today: string): Episode[] {
  const sorted = [...episodes].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const available: Episode[] = [];
  let afterAnUnairedEpisode = false;
  for (const ep of sorted) {
    if (!isAvailableToWatch(ep.airDate, today)) {
      afterAnUnairedEpisode = true;
      continue;
    }
    if (!ep.airDate && afterAnUnairedEpisode) continue;
    available.push(ep);
  }
  return available;
}

/** The next available, unwatched episode for a show, in season/episode order. Null if none (up to date, or nothing cached yet). */
export function findNextUnwatched(episodes: Episode[], watchedKeys: Set<string>): Episode | null {
  const today = new Date().toISOString().slice(0, 10);
  return availableInProgression(episodes, today).find((ep) => !watchedKeys.has(ep.key)) ?? null;
}

/**
 * How many available-but-unwatched episodes exist beyond the immediate next
 * one, for the "+N" badge TV Time shows (e.g. "S01|E04 +4"). Returns 0 if
 * the next episode is the only one waiting.
 */
export function countAdditionalUnwatched(episodes: Episode[], watchedKeys: Set<string>): number {
  const today = new Date().toISOString().slice(0, 10);
  const unwatchedAvailable = availableInProgression(episodes, today).filter((ep) => !watchedKeys.has(ep.key));
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
