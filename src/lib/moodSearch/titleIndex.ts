// Builds and maintains the per-title embedding index that mood search ranks
// against.
//
// Two independent, resumable passes, in this order:
//
//   1. Overview backfill (network). Show.overview / Movie.overview were only
//      added in schema v12, so every pre-existing row has them undefined.
//      This fetches them from TMDB, one title at a time, using exactly the
//      lazy-backfill pattern already established by useShowStats in
//      lib/stats.ts: undefined means never attempted, null means attempted
//      and unavailable.
//   2. Embedding (local, no network once the model is cached). Turns each
//      title's text into a vector and stores it in db.titleEmbeddings.
//
// Both are interruptible and both skip work already done, so a user who
// closes the app halfway through resumes rather than restarts.

import { db, type Movie, type Show } from "../../db";
import { getMovieDetails, getTvShowDetails } from "../../tmdb";
import { embed } from "./embedder";
import { EMBEDDING_MODEL_ID } from "./vocabulary";

export interface IndexProgress {
  phase: "fetching-overviews" | "embedding";
  done: number;
  total: number;
}

export type ProgressCallback = (progress: IndexProgress) => void;

/** Cheap non-cryptographic hash (FNV-1a), used only to detect changed source text. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function embeddingCacheKey(kind: "show" | "movie", tmdbId: number): string {
  return `${kind}:${tmdbId}`;
}

/**
 * The text actually embedded for a title.
 *
 * The name is included alongside the overview because a fair number of
 * titles have a short, near-useless TMDB summary, and the name is often the
 * only remaining signal. Genres are deliberately NOT concatenated in: TMDB
 * genre labels are generic enough ("Drama", "Mystery") that repeating them
 * across hundreds of titles pulls every vector toward a common centre and
 * flattens exactly the distinctions this feature exists to make. Genres are
 * used as a separate discrete filter instead (see search.ts).
 */
export function buildSourceText(name: string, overview: string | null | undefined): string {
  const summary = (overview ?? "").trim();
  return summary ? `${name}. ${summary}` : name;
}

/** Model + text identity. A change to either invalidates the cached vector. */
function sourceHash(text: string): string {
  return `${EMBEDDING_MODEL_ID}:${hashText(text)}`;
}

/**
 * Fetches missing overviews from TMDB.
 *
 * Failures are swallowed per title, not per batch, for the same reason
 * Home's episode sync collects failures rather than throwing: one rate-limit
 * response partway through a 200-title library must not stop every title
 * after it from ever being indexed. A failed fetch writes null so the title
 * is retried on a later run rather than being retried immediately in a
 * tight loop against an API that just rejected us.
 */
export async function backfillOverviews(
  onProgress?: ProgressCallback,
  shouldStop?: () => boolean
): Promise<{ attempted: number; failed: number }> {
  const shows = await db.shows.filter((s) => s.overview === undefined).toArray();
  const movies = await db.movies.filter((m) => m.overview === undefined).toArray();
  const total = shows.length + movies.length;
  if (total === 0) return { attempted: 0, failed: 0 };

  let done = 0;
  let failed = 0;
  onProgress?.({ phase: "fetching-overviews", done, total });

  for (const show of shows) {
    if (shouldStop?.()) break;
    try {
      const details = await getTvShowDetails(show.tmdbId);
      await db.shows.update(show.tmdbId, { overview: details.overview ?? null });
    } catch {
      await db.shows.update(show.tmdbId, { overview: null });
      failed++;
    }
    onProgress?.({ phase: "fetching-overviews", done: ++done, total });
  }

  for (const movie of movies) {
    if (shouldStop?.()) break;
    try {
      const details = await getMovieDetails(movie.tmdbId);
      await db.movies.update(movie.tmdbId, { overview: details.overview ?? null });
    } catch {
      await db.movies.update(movie.tmdbId, { overview: null });
      failed++;
    }
    onProgress?.({ phase: "fetching-overviews", done: ++done, total });
  }

  return { attempted: done, failed };
}

interface IndexableTitle {
  kind: "show" | "movie";
  tmdbId: number;
  sourceText: string;
}

function toIndexable(shows: Show[], movies: Movie[]): IndexableTitle[] {
  const titles: IndexableTitle[] = [];
  for (const s of shows) {
    titles.push({ kind: "show", tmdbId: s.tmdbId, sourceText: buildSourceText(s.name, s.overview) });
  }
  for (const m of movies) {
    titles.push({ kind: "movie", tmdbId: m.tmdbId, sourceText: buildSourceText(m.title, m.overview) });
  }
  return titles;
}

/**
 * Computes and caches embeddings for every title whose vector is missing or
 * stale. Requires the model to be loaded; callers await loadEmbedder first.
 *
 * Titles are embedded one at a time rather than as a single batch. Batching
 * would be faster in wall-clock terms, but on the WASM path a large batch is
 * one long uninterruptible block of main-thread work, which on a low-end
 * device means a visibly frozen UI. One at a time keeps the app responsive
 * and keeps the pass genuinely cancellable between titles.
 */
export async function buildTitleEmbeddings(
  onProgress?: ProgressCallback,
  shouldStop?: () => boolean
): Promise<{ embedded: number; failed: number }> {
  const [shows, movies, cached] = await Promise.all([
    db.shows.toArray(),
    db.movies.toArray(),
    db.titleEmbeddings.toArray(),
  ]);

  const cachedByKey = new Map(cached.map((c) => [c.cacheKey, c]));
  const stale = toIndexable(shows, movies).filter((t) => {
    const existing = cachedByKey.get(embeddingCacheKey(t.kind, t.tmdbId));
    return !existing || existing.sourceHash !== sourceHash(t.sourceText);
  });

  const total = stale.length;
  if (total === 0) return { embedded: 0, failed: 0 };

  let done = 0;
  let failed = 0;
  onProgress?.({ phase: "embedding", done, total });

  for (const title of stale) {
    if (shouldStop?.()) break;
    try {
      const vector = await embed(title.sourceText);
      await db.titleEmbeddings.put({
        cacheKey: embeddingCacheKey(title.kind, title.tmdbId),
        kind: title.kind,
        tmdbId: title.tmdbId,
        vector,
        sourceHash: sourceHash(title.sourceText),
      });
    } catch {
      // Nothing is written on failure, so this title is simply retried on
      // the next pass. It still participates in search via the genre
      // fallback in the meantime.
      failed++;
    }
    onProgress?.({ phase: "embedding", done: ++done, total });
  }

  return { embedded: done - failed, failed };
}

/** Every cached vector, keyed by `${kind}:${tmdbId}`, for the search pass. */
export async function loadEmbeddingIndex(): Promise<Map<string, Float32Array>> {
  const rows = await db.titleEmbeddings.toArray();
  return new Map(rows.map((r) => [r.cacheKey, r.vector]));
}

/** Drops the whole embedding cache (Settings action; it is fully re-derivable). */
export async function clearTitleEmbeddings(): Promise<void> {
  await db.titleEmbeddings.clear();
}
