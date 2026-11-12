import { db } from "./db";

const OMDB_BASE = "https://www.omdbapi.com/";

// Exported so Settings and the backup/restore code reference the same
// storage key instead of re-typing the literal.
export const OMDB_API_KEY_STORAGE = "omdb_api_key";

// When OMDb's daily quota is hit, we record the time it's expected to reset
// here and skip requests until then (Play Store prep, Phase 3).
const OMDB_QUOTA_EXHAUSTED_UNTIL = "omdb_quota_exhausted_until";

// Ratings barely change, so a month-long cache slashes the quota cost of
// re-opening the same details panel while still refreshing eventually.
export const OMDB_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const OMDB_RATE_LIMIT_MESSAGE =
  "Daily ratings lookup limit reached. Ratings will resume automatically tomorrow.";

function getOmdbKey(): string | null {
  return localStorage.getItem(OMDB_API_KEY_STORAGE);
}

export function hasOmdbKey(): boolean {
  return !!getOmdbKey();
}

// ---- Rate-limit state -------------------------------------------------------

/**
 * True while OMDb's daily quota is known-exhausted. Self-clearing: once the
 * stored reset time passes, the flag is removed and calls resume on their
 * own, so nothing has to be manually reset.
 */
export function isOmdbRateLimited(): boolean {
  const until = localStorage.getItem(OMDB_QUOTA_EXHAUSTED_UNTIL);
  if (!until) return false;
  if (Date.now() >= new Date(until).getTime()) {
    localStorage.removeItem(OMDB_QUOTA_EXHAUSTED_UNTIL);
    return false;
  }
  return true;
}

/** ISO time the quota is expected to reset, or null if not currently rate-limited. */
export function omdbQuotaResumeTime(): string | null {
  return isOmdbRateLimited() ? localStorage.getItem(OMDB_QUOTA_EXHAUSTED_UNTIL) : null;
}

function markOmdbRateLimited(): void {
  // OMDb's free quota resets daily; resume at the next local midnight. If
  // it's somehow still limited then, the next call re-detects and re-arms
  // this, so an imperfect reset boundary is self-correcting.
  const resetAt = new Date();
  resetAt.setHours(24, 0, 0, 0);
  localStorage.setItem(OMDB_QUOTA_EXHAUSTED_UNTIL, resetAt.toISOString());
}

/**
 * OMDb signals a spent quota in the JSON "Error" field ("Request limit
 * reached!") with Response="False", NOT via a distinct HTTP status (it uses
 * 401 for both a bad key and an exhausted quota). Matching the message is
 * the only reliable way to tell a rate-limit apart from other errors.
 */
function isRateLimitError(errorMessage: unknown): boolean {
  return String(errorMessage ?? "").toLowerCase().includes("limit");
}

// ---- TTL cache (Dexie omdbCache) -------------------------------------------

// The cache keys, in one place: the lookups below write under them and
// lib/cacheMaintenance.ts deletes under them when a title leaves the library,
// and the two must never disagree about what a title's entries are called.

function ratingsCacheKey(identifier: { imdbId?: string | null; title: string; year: number | null }): string {
  return `ratings:${identifier.imdbId ?? `${identifier.title}:${identifier.year ?? ""}`}`;
}

function episodeCachePrefix(show: { imdbId?: string | null; title: string }): string {
  return `episode:${show.imdbId ?? show.title}:S`;
}

/**
 * Every key a title's lookups can have been cached under: by IMDb id, and by
 * title for a lookup made before the id was known. `exact` are whole keys,
 * `prefixes` match that title's per-episode entries.
 */
export function omdbCacheKeysFor(title: { name: string; year: number | null; imdbId?: string | null }): {
  exact: string[];
  prefixes: string[];
} {
  const byTitle = { title: title.name, year: title.year, imdbId: null };
  const exact = [ratingsCacheKey(byTitle)];
  const prefixes = [episodeCachePrefix(byTitle)];
  if (title.imdbId) {
    exact.push(ratingsCacheKey({ ...byTitle, imdbId: title.imdbId }));
    prefixes.push(episodeCachePrefix({ ...byTitle, imdbId: title.imdbId }));
  }
  return { exact, prefixes };
}

async function readCache<T>(cacheKey: string): Promise<T | null> {
  try {
    const entry = await db.omdbCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - new Date(entry.fetchedAt).getTime() > OMDB_CACHE_TTL_MS) return null; // expired
    return entry.data as T;
  } catch {
    return null; // a cache miss must never be fatal
  }
}

async function writeCache(cacheKey: string, kind: "ratings" | "episode", data: unknown): Promise<void> {
  try {
    await db.omdbCache.put({ cacheKey, kind, fetchedAt: new Date().toISOString(), data });
  } catch {
    // Caching failing must never break the actual lookup.
  }
}

// ---- Key verification -------------------------------------------------------

// Distinguishes the reasons a key test can fail, because they need
// different user advice: a typo'd/unactivated key vs a key that already
// burned its 1,000/day quota (which is proof the key itself is VALID) vs
// OMDb being unreachable.
export type OmdbKeyCheckResult = "valid" | "invalid" | "rate-limited" | "network-error";

export async function checkOmdbKey(key: string): Promise<OmdbKeyCheckResult> {
  try {
    const url = new URL(OMDB_BASE);
    url.searchParams.set("apikey", key);
    url.searchParams.set("t", "Inception"); // any well-known title, just to validate the key
    const res = await fetch(url.toString());
    const data = await res.json().catch(() => null);
    if (data?.Response === "True") return "valid";
    if (isRateLimitError(data?.Error)) return "rate-limited"; // "Request limit reached!"
    if (String(data?.Error ?? "").toLowerCase().includes("invalid api key")) return "invalid";
    if (res.status >= 500) return "network-error";
    return "invalid";
  } catch {
    return "network-error";
  }
}

export async function verifyOmdbKey(key: string): Promise<boolean> {
  return (await checkOmdbKey(key)) === "valid";
}

// ---- Ratings ----------------------------------------------------------------

export interface OmdbRatings {
  imdbRating: string | null; // e.g. "8.8"
  rottenTomatoes: string | null; // e.g. "87%", movies only per OMDb's own data, often absent for series
  plot: string | null;
  error: string | null;
  rateLimited: boolean; // true when the daily quota is spent; UI shows the resume-tomorrow message
}

const emptyRatings = (error: string | null, rateLimited: boolean): OmdbRatings => ({
  imdbRating: null,
  rottenTomatoes: null,
  plot: null,
  error,
  rateLimited,
});

/**
 * Looks up ratings by IMDb ID when available (exact, no ambiguity), falling
 * back to title+year search only when no ID is cached. Order of operations:
 * a fresh TTL cache hit is served without a network call; otherwise, if the
 * daily quota is known-exhausted, we return the rate-limited state instead
 * of spending a request just to fail; otherwise we fetch, detect a
 * rate-limit specifically, and cache only genuine results.
 */
export async function getOmdbRatings(identifier: {
  imdbId?: string | null;
  title: string;
  year: number | null;
}): Promise<OmdbRatings | null> {
  const key = getOmdbKey();
  if (!key) return null;

  const cacheKey = ratingsCacheKey(identifier);
  const cached = await readCache<OmdbRatings>(cacheKey);
  if (cached) return { ...cached, rateLimited: false };

  if (isOmdbRateLimited()) return emptyRatings(null, true);

  let data: Record<string, unknown> | null;
  try {
    const url = new URL(OMDB_BASE);
    url.searchParams.set("apikey", key);
    if (identifier.imdbId) {
      url.searchParams.set("i", identifier.imdbId);
    } else {
      url.searchParams.set("t", identifier.title);
      if (identifier.year) url.searchParams.set("y", String(identifier.year));
    }
    const res = await fetch(url.toString());
    data = await res.json().catch(() => null);
  } catch {
    return emptyRatings("Couldn't reach OMDb.", false); // network error: don't cache, don't flag quota
  }
  if (!data) return emptyRatings("Unexpected OMDb response.", false);

  if (data.Response !== "True") {
    if (isRateLimitError(data.Error)) {
      markOmdbRateLimited();
      return emptyRatings(null, true);
    }
    const result = emptyRatings((data.Error as string) ?? "Unknown OMDb error", false);
    // Cache genuine content misses only (not auth errors), so a not-found
    // title doesn't re-spend quota, but a fixed key isn't stuck on a stale error.
    if (/not found/i.test(String(data.Error ?? ""))) await writeCache(cacheKey, "ratings", result);
    return result;
  }

  const ratingsArray: { Source: string; Value: string }[] = (data.Ratings as never) ?? [];
  const imdb = ratingsArray.find((r) => r.Source === "Internet Movie Database")?.Value ?? (data.imdbRating as string) ?? null;
  const rt = ratingsArray.find((r) => r.Source === "Rotten Tomatoes")?.Value ?? null;

  const result: OmdbRatings = {
    imdbRating: imdb && imdb !== "N/A" ? imdb : null,
    rottenTomatoes: rt ?? null,
    plot: data.Plot && data.Plot !== "N/A" ? (data.Plot as string) : null,
    error: null,
    rateLimited: false,
  };
  await writeCache(cacheKey, "ratings", result);
  return result;
}

// ---- Per-episode ratings ----------------------------------------------------

export interface OmdbEpisodeRating {
  imdbRating: string | null;
  imdbId: string | null;
  plot: string | null;
  error: string | null; // OMDb's own error message when Response=False, e.g. "Series not found!"
  rateLimited: boolean;
}

const emptyEpisodeRating = (error: string | null, rateLimited: boolean): OmdbEpisodeRating => ({
  imdbRating: null,
  imdbId: null,
  plot: null,
  error,
  rateLimited,
});

/**
 * Per-episode IMDb rating via OMDb's documented Season+Episode query params.
 * Same cache-then-quota-then-fetch flow as getOmdbRatings.
 */
export async function getOmdbEpisodeRating(
  show: { imdbId?: string | null; title: string },
  seasonNumber: number,
  episodeNumber: number
): Promise<OmdbEpisodeRating | null> {
  const key = getOmdbKey();
  if (!key) return null;

  const cacheKey = `${episodeCachePrefix(show)}${seasonNumber}E${episodeNumber}`;
  const cached = await readCache<OmdbEpisodeRating>(cacheKey);
  if (cached) return { ...cached, rateLimited: false };

  if (isOmdbRateLimited()) return emptyEpisodeRating(null, true);

  let data: Record<string, unknown> | null;
  try {
    const url = new URL(OMDB_BASE);
    url.searchParams.set("apikey", key);
    if (show.imdbId) url.searchParams.set("i", show.imdbId);
    else url.searchParams.set("t", show.title);
    url.searchParams.set("Season", String(seasonNumber));
    url.searchParams.set("Episode", String(episodeNumber));
    const res = await fetch(url.toString());
    data = await res.json().catch(() => null);
  } catch {
    return emptyEpisodeRating("Couldn't reach OMDb.", false);
  }
  if (!data) return emptyEpisodeRating("Unexpected OMDb response.", false);

  if (data.Response !== "True") {
    if (isRateLimitError(data.Error)) {
      markOmdbRateLimited();
      return emptyEpisodeRating(null, true);
    }
    const result = emptyEpisodeRating((data.Error as string) ?? "Unknown OMDb error", false);
    if (/not found/i.test(String(data.Error ?? ""))) await writeCache(cacheKey, "episode", result);
    return result;
  }

  const result: OmdbEpisodeRating = {
    imdbRating: data.imdbRating && data.imdbRating !== "N/A" ? (data.imdbRating as string) : null,
    imdbId: (data.imdbID as string) || null,
    plot: data.Plot && data.Plot !== "N/A" ? (data.Plot as string) : null,
    error: null,
    rateLimited: false,
  };
  await writeCache(cacheKey, "episode", result);
  return result;
}
