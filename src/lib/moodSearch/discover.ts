// Mood DISCOVERY: recommends titles you have not watched, including ones not
// in your library at all.
//
// This is a different problem from the mood filter on Home. That one ranks
// titles already in the library, every one of which has a cached vector. Here
// most candidates are not on the device, and there is no local copy of TMDB's
// catalogue to search, so the model has nothing to rank until something is
// fetched.
//
// The shape is retrieve-then-rerank:
//
//   1. Turn the query into filters TMDB actually understands. TMDB has no
//      semantic search, so this is the only way to get a candidate pool at
//      all. Vocabulary tags become keyword IDs and genre IDs; parsed runtime
//      bounds become with_runtime, enforced server-side rather than by
//      throwing away results after fetching them.
//   2. Re-rank that pool on device with the same embedding model, against the
//      titles' TMDB summaries.
//   3. Drop anything already watched, and fold in library titles you own but
//      have never started, whose vectors are already cached and therefore free.
//
// The ceiling of this design is worth stating plainly: the model can only
// reorder what retrieval returned. A perfect match that TMDB files under a
// genre and keyword set the query never touched is never fetched, and so can
// never appear. Retrieval quality, not ranking quality, is the limit.

import { db } from "../../db";
import {
  discoverMoviesBy,
  discoverTvBy,
  searchKeywords,
  type MovieSearchResult,
  type TvSearchResult,
} from "../../tmdb";
import { parseConstraints, satisfiesRuntime, type RuntimeConstraint } from "./constraints";
import { cosineSimilarity, embed, loadEmbedder } from "./embedder";
import {
  embeddingCacheKey,
  ensureVectorsFor,
  type EmbeddableTitle,
  type ProgressCallback,
} from "./titleIndex";
import { loadVocabularyVectors } from "./search";
import {
  MAX_MATCHED_TAGS,
  NEGATION_ABSOLUTE_FLOOR,
  NEGATION_RELATIVE_FACTOR,
  TAG_MATCH_THRESHOLD,
  TITLE_ABSOLUTE_FLOOR,
  TITLE_RELATIVE_FLOOR,
} from "./vocabulary";

/** How many vocabulary tags contribute keywords to retrieval. */
const MAX_RETRIEVAL_KEYWORDS = 4;
/**
 * Minimum TMDB vote count for a discovered title. Low on purpose: this is a
 * discovery feature, so the bar exists only to skip entries too obscure to
 * have a written summary (which would be unrankable anyway), not to restrict
 * results to popular titles.
 */
const MIN_VOTE_COUNT = 25;

export interface DiscoveryItem {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  posterPath: string | null;
  year: number | null;
  overview: string | null;
  score: number;
  /** True when the title is already in the library (but unwatched). */
  inLibrary: boolean;
}

export interface DiscoveryOutcome {
  items: DiscoveryItem[];
  matchedTags: string[];
  excludedTags: string[];
  runtime: RuntimeConstraint;
  /** TMDB keyword names that retrieval actually used. Empty means genres only. */
  usedKeywords: string[];
  /** Size of the candidate pool before ranking, for diagnostics. */
  pooled: number;
  /**
   * True when every TMDB retrieval call failed, so the results are drawn
   * only from titles already in the library.
   *
   * Surfaced rather than swallowed because the failure is otherwise
   * invisible in a damaging way: a user with an expired key still sees a
   * ranked list of plausible suggestions and no error, and would reasonably
   * conclude discovery is working when it has silently stopped recommending
   * anything new.
   */
  retrievalFailed: boolean;
  status: "ok" | "no-query" | "unavailable" | "no-candidates";
  message?: string;
}

// Keyword lookups are stable and repeat constantly across searches, so they
// are memoised for the session. Not persisted: the map is small and a session
// is short enough that staleness is not worth a migration.
const keywordIdCache = new Map<string, number | null>();

/**
 * Resolves vocabulary tags to TMDB keyword IDs.
 *
 * Requires an exact case-insensitive name match. TMDB's keyword search is a
 * substring match that will happily return "found footage horror" style
 * near-misses and unrelated entries for a vague term, and retrieving on a
 * wrong keyword silently poisons the entire candidate pool. A miss is
 * cheap (genres still retrieve); a wrong hit is not.
 */
async function resolveKeywordIds(tagIds: string[]): Promise<{ ids: number[]; names: string[] }> {
  const ids: number[] = [];
  const names: string[] = [];
  for (const tagId of tagIds.slice(0, MAX_RETRIEVAL_KEYWORDS)) {
    if (!keywordIdCache.has(tagId)) {
      const results = await searchKeywords(tagId);
      const exact = results.find((k) => k.name.toLowerCase() === tagId.toLowerCase());
      keywordIdCache.set(tagId, exact ? exact.id : null);
    }
    const id = keywordIdCache.get(tagId);
    if (id != null) {
      ids.push(id);
      names.push(tagId);
    }
  }
  return { ids, names };
}

function movieToItem(m: MovieSearchResult): DiscoveryItem {
  return {
    kind: "movie",
    tmdbId: m.id,
    name: m.title,
    posterPath: m.poster_path,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) || null : null,
    overview: m.overview ?? null,
    score: 0,
    inLibrary: false,
  };
}

function tvToItem(t: TvSearchResult): DiscoveryItem {
  return {
    kind: "show",
    tmdbId: t.id,
    name: t.name,
    posterPath: t.poster_path,
    year: t.first_air_date ? Number(t.first_air_date.slice(0, 4)) || null : null,
    overview: t.overview ?? null,
    score: 0,
    inLibrary: false,
  };
}

/**
 * Retrieves the candidate pool.
 *
 * Keyword-driven and genre-driven retrieval are issued as SEPARATE calls and
 * merged, rather than combined into one. TMDB ANDs different filter types, so
 * a single call with both would demand a title carry the keyword AND sit in
 * the genre, which is far narrower than either alone and frequently returns
 * nothing. Run apart, the keyword call supplies precision and the genre call
 * supplies recall.
 */
async function retrieveCandidates(
  keywordIds: number[],
  genreIds: number[],
  runtime: RuntimeConstraint
): Promise<{ items: DiscoveryItem[]; anySucceeded: boolean }> {
  const shared = {
    maxRuntimeMinutes: runtime.maxMinutes,
    minRuntimeMinutes: runtime.minMinutes,
    minVoteCount: MIN_VOTE_COUNT,
  };

  const calls: Promise<DiscoveryItem[]>[] = [];
  if (keywordIds.length > 0) {
    calls.push(discoverMoviesBy({ ...shared, keywordIds }).then((r) => r.map(movieToItem)));
    calls.push(discoverTvBy({ ...shared, keywordIds }).then((r) => r.map(tvToItem)));
  }
  if (genreIds.length > 0) {
    calls.push(discoverMoviesBy({ ...shared, genreIds }).then((r) => r.map(movieToItem)));
    calls.push(discoverTvBy({ ...shared, genreIds }).then((r) => r.map(tvToItem)));
  }

  // allSettled, not all: one failed call (a rate limit on the third request)
  // should narrow the pool, never empty it.
  const settled = await Promise.allSettled(calls);
  const pool = new Map<string, DiscoveryItem>();
  let anySucceeded = false;
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    anySucceeded = true;
    for (const item of outcome.value) {
      pool.set(embeddingCacheKey(item.kind, item.tmdbId), item);
    }
  }
  // No calls issued at all (no tags to retrieve on) is not a failure.
  return { items: [...pool.values()], anySucceeded: anySucceeded || calls.length === 0 };
}

/** Library titles the user owns but has never watched. */
async function libraryUnwatched(): Promise<{ items: DiscoveryItem[]; watched: Set<string> }> {
  const [shows, movies, watchedEpisodes] = await Promise.all([
    db.shows.toArray(),
    db.movies.toArray(),
    db.watchedEpisodes.toArray(),
  ]);

  const watchedShowIds = new Set(watchedEpisodes.map((w) => w.showId));
  const watched = new Set<string>();
  const items: DiscoveryItem[] = [];

  for (const s of shows) {
    const key = embeddingCacheKey("show", s.tmdbId);
    // A show counts as watched once ANY episode is logged: the user has
    // started it, so it does not belong in "find me something new".
    if (watchedShowIds.has(s.tmdbId)) {
      watched.add(key);
      continue;
    }
    items.push({
      kind: "show",
      tmdbId: s.tmdbId,
      name: s.name,
      posterPath: s.posterPath,
      year: s.firstAirYear,
      overview: s.overview ?? null,
      score: 0,
      inLibrary: true,
    });
  }

  for (const m of movies) {
    const key = embeddingCacheKey("movie", m.tmdbId);
    if (m.watched) {
      watched.add(key);
      continue;
    }
    items.push({
      kind: "movie",
      tmdbId: m.tmdbId,
      name: m.title,
      posterPath: m.posterPath,
      year: m.releaseYear,
      overview: m.overview ?? null,
      score: 0,
      inLibrary: true,
    });
  }

  return { items, watched };
}

/** Runtime known locally for a library title, for the post-retrieval check. */
async function localRuntimes(): Promise<Map<string, number | null | undefined>> {
  const [shows, movies] = await Promise.all([db.shows.toArray(), db.movies.toArray()]);
  const map = new Map<string, number | null | undefined>();
  for (const s of shows) map.set(embeddingCacheKey("show", s.tmdbId), s.episodeRuntimeMinutes);
  for (const m of movies) map.set(embeddingCacheKey("movie", m.tmdbId), m.runtimeMinutes);
  return map;
}

/**
 * The whole discovery pipeline.
 *
 * Returns an outcome rather than throwing for ordinary failures, matching
 * buildMoodFilter: the caller shows a message and the rest of the tab keeps
 * working.
 */
export async function discoverByMood(
  query: string,
  onProgress?: ProgressCallback,
  shouldStop?: () => boolean
): Promise<DiscoveryOutcome> {
  const parsed = parseConstraints(query);
  const base = {
    matchedTags: [] as string[],
    excludedTags: [] as string[],
    runtime: parsed.runtime,
    usedKeywords: [] as string[],
    pooled: 0,
    retrievalFailed: false,
  };

  if (!parsed.positiveText) {
    return { ...base, items: [], status: "no-query", message: "Describe what you're in the mood for." };
  }

  try {
    await loadEmbedder();
  } catch {
    return {
      ...base,
      items: [],
      status: "unavailable",
      message: "Smart search could not start on this device. Use the title search below instead.",
    };
  }
  if (shouldStop?.()) return { ...base, items: [], status: "no-query" };

  try {
    const [vocabulary, queryVector] = await Promise.all([
      loadVocabularyVectors(),
      embed(parsed.positiveText),
    ]);

    const tags = vocabulary
      .map((t) => ({ id: t.id, genreIds: t.genreIds, score: cosineSimilarity(queryVector, t.vector) }))
      .filter((t) => t.score >= TAG_MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED_TAGS);

    const genreIds = [...new Set(tags.flatMap((t) => t.genreIds))];
    const { ids: keywordIds, names: usedKeywords } = await resolveKeywordIds(tags.map((t) => t.id));
    if (shouldStop?.()) return { ...base, items: [], status: "no-query" };

    const [fetched, library, runtimeByKey] = await Promise.all([
      // With no tags at all there is nothing to retrieve on; the library half
      // below still works, so this degrades rather than failing.
      genreIds.length || keywordIds.length
        ? retrieveCandidates(keywordIds, genreIds, parsed.runtime)
        : Promise.resolve({ items: [] as DiscoveryItem[], anySucceeded: true }),
      libraryUnwatched(),
      localRuntimes(),
    ]);
    if (shouldStop?.()) return { ...base, items: [], status: "no-query" };

    // Library entries win over fetched ones for the same title: they carry
    // our own data and the inLibrary flag the UI shows.
    const pool = new Map<string, DiscoveryItem>();
    for (const item of fetched.items) {
      const key = embeddingCacheKey(item.kind, item.tmdbId);
      if (library.watched.has(key)) continue; // already watched, never recommend
      pool.set(key, item);
    }
    for (const item of library.items) {
      pool.set(embeddingCacheKey(item.kind, item.tmdbId), item);
    }

    const candidates = [...pool.values()];
    if (candidates.length === 0) {
      return {
        ...base,
        matchedTags: tags.map((t) => t.id),
        usedKeywords,
        retrievalFailed: !fetched.anySucceeded,
        items: [],
        status: "no-candidates",
        message: !fetched.anySucceeded
          ? "Couldn't reach TMDB, and there's nothing unwatched in your library to fall back on."
          : "Nothing came back for that. Try describing it differently.",
      };
    }

    const embeddable: EmbeddableTitle[] = candidates.map((c) => ({
      kind: c.kind,
      tmdbId: c.tmdbId,
      name: c.name,
      overview: c.overview,
    }));
    const vectors = await ensureVectorsFor(embeddable, onProgress, shouldStop);
    if (shouldStop?.()) return { ...base, items: [], status: "no-query" };

    // Negation, by embedding similarity only. Same relative-plus-floor rule
    // as the Home filter; see vocabulary.ts for why exclusion needs a higher
    // bar than inclusion.
    const excluded = new Set<string>();
    const excludedTags: string[] = [];
    for (const phrase of parsed.negatedPhrases) {
      const phraseVector = await embed(phrase);
      for (const t of vocabulary) {
        if (cosineSimilarity(phraseVector, t.vector) >= TAG_MATCH_THRESHOLD) excludedTags.push(t.id);
      }
      let topSim = 0;
      const sims = new Map<string, number>();
      for (const [key, vector] of vectors) {
        const sim = cosineSimilarity(phraseVector, vector);
        sims.set(key, sim);
        if (sim > topSim) topSim = sim;
      }
      const bar = Math.max(NEGATION_ABSOLUTE_FLOOR, topSim * NEGATION_RELATIVE_FACTOR);
      for (const [key, sim] of sims) if (sim >= bar) excluded.add(key);
    }

    let best = 0;
    const scored: DiscoveryItem[] = [];
    for (const candidate of candidates) {
      const key = embeddingCacheKey(candidate.kind, candidate.tmdbId);
      if (excluded.has(key)) continue;
      const vector = vectors.get(key);
      if (!vector) continue; // no usable summary, so not rankable
      // TMDB already applied runtime to the fetched half; this re-checks the
      // library half, whose runtimes are local and never went through the API.
      if (!satisfiesRuntime(runtimeByKey.get(key), parsed.runtime)) continue;
      const score = cosineSimilarity(queryVector, vector);
      if (score > best) best = score;
      scored.push({ ...candidate, score });
    }

    const cut = Math.max(TITLE_ABSOLUTE_FLOOR, best * TITLE_RELATIVE_FLOOR);
    const items = scored.filter((i) => i.score >= cut).sort((a, b) => b.score - a.score);

    return {
      items,
      matchedTags: tags.map((t) => t.id),
      excludedTags: [...new Set(excludedTags)],
      runtime: parsed.runtime,
      usedKeywords,
      pooled: candidates.length,
      retrievalFailed: !fetched.anySucceeded,
      status: "ok",
    };
  } catch (e) {
    return {
      ...base,
      items: [],
      status: "unavailable",
      message: e instanceof Error ? e.message : "Something went wrong running that search.",
    };
  }
}
