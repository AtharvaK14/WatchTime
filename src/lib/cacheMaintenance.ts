// Keeping the re-derivable caches from growing without limit.
//
// Three tables hold nothing but copies of things that can be fetched or
// computed again: OMDb ratings, streaming availability, and mood-search
// vectors. Each had a rule for when an entry stops being USED (a TTL, a source
// hash) and none for when it stops being STORED, so an expired entry, or one
// for a title long since removed from the library, stayed on the device for
// good. Nothing here touches the library or watch history.

import { db } from "../db";
import { OMDB_CACHE_TTL_MS, omdbCacheKeysFor } from "../omdb";
import { STREAMING_CACHE_TTL_MS } from "./streaming/providers";

const LAST_PRUNE_STORAGE = "cache_pruned_at";
/** Once a day is plenty: every rule below is measured in weeks. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How many mood-search vectors are kept for titles that are NOT in the
 * library. Discovery embeds every candidate TMDB returns and keeps the vector
 * so a repeated or overlapping search is free, which is worth having and has
 * no natural end: each new search adds a few dozen more. A couple of thousand
 * (about 3 MB) covers a great many searches.
 */
export const MAX_DISCOVERY_EMBEDDINGS = 2000;

function olderThan(fetchedAt: string, ttlMs: number, now: number): boolean {
  const at = new Date(fetchedAt).getTime();
  // An unreadable date can never be served as fresh, so it goes too.
  return !Number.isFinite(at) || now - at > ttlMs;
}

/**
 * Which cached vectors to drop: those for titles outside the library, beyond
 * the allowance. Pure. Takes keys only, so the vectors themselves are never
 * loaded to decide this.
 */
export function embeddingsToDrop(
  cachedKeys: string[],
  libraryKeys: ReadonlySet<string>,
  max = MAX_DISCOVERY_EMBEDDINGS
): string[] {
  const outside = cachedKeys.filter((key) => !libraryKeys.has(key));
  return outside.length > max ? outside.slice(0, outside.length - max) : [];
}

/** Deletes cache entries nothing will read again. Safe to call at any time. */
export async function pruneCaches(now = Date.now()): Promise<void> {
  await db.omdbCache.filter((entry) => olderThan(entry.fetchedAt, OMDB_CACHE_TTL_MS, now)).delete();
  await db.watchProviders.filter((entry) => olderThan(entry.fetchedAt, STREAMING_CACHE_TTL_MS, now)).delete();

  const [showIds, movieIds, embeddingKeys] = await Promise.all([
    db.shows.toCollection().primaryKeys(),
    db.movies.toCollection().primaryKeys(),
    db.titleEmbeddings.toCollection().primaryKeys(),
  ]);
  const libraryKeys = new Set([...showIds.map((id) => `show:${id}`), ...movieIds.map((id) => `movie:${id}`)]);
  const drop = embeddingsToDrop(embeddingKeys, libraryKeys);
  if (drop.length > 0) await db.titleEmbeddings.bulkDelete(drop);
}

/**
 * Runs pruneCaches at most once a day. Called once the app is idle after
 * launch; a failure is swallowed, because a cache that stayed a little large
 * is not something to show anyone.
 */
export async function pruneCachesIfDue(now = Date.now()): Promise<void> {
  try {
    const last = Number(localStorage.getItem(LAST_PRUNE_STORAGE));
    if (Number.isFinite(last) && last > 0 && now - last < PRUNE_INTERVAL_MS && now >= last) return;
    await pruneCaches(now);
    localStorage.setItem(LAST_PRUNE_STORAGE, String(now));
  } catch {
    // Tried again on the next launch.
  }
}

/**
 * Drops what was cached about one title, when it leaves the library.
 *
 * Best effort and deliberately outside the removal's own transaction: these
 * rows can all be fetched again, and failing to delete one must never be the
 * reason a removal is reported as failed. The mood-search vector is left
 * alone - that cache is shared with discovery on purpose, where the same
 * title may well turn up again, and pruneCaches bounds it.
 */
export async function dropCachesForTitle(
  kind: "show" | "movie",
  title: { tmdbId: number; name: string; year: number | null; imdbId?: string | null }
): Promise<void> {
  try {
    await db.watchProviders.delete(`${kind}:${title.tmdbId}`);
    const { exact, prefixes } = omdbCacheKeysFor(title);
    await db.omdbCache.bulkDelete(exact);
    for (const prefix of prefixes) await db.omdbCache.where("cacheKey").startsWith(prefix).delete();
  } catch {
    // Left for pruneCaches, which removes them once they expire.
  }
}
