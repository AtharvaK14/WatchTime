// Turns a natural-language query into a single filter object, and applies
// it to library titles.
//
// Pipeline, in order:
//   1. Deterministic parse (constraints.ts): runtime bounds and negations
//      come out, and the remaining "positive" text goes on to the model.
//   2. Embed the positive text once.
//   3. Vocabulary tags: cosine against the precomputed build-time vectors,
//      for display and for the no-embedding genre fallback.
//   4. Title ranking: cosine against each cached title vector.
//   5. Negation: embed each negated phrase and exclude titles too close to it.
//
// If step 2 cannot happen (model unavailable), the whole thing degrades to
// mode "keyword" and the caller gets plain substring matching, with the
// runtime and negation parsing from step 1 still applied, since that half
// never needed the model.

import type { Movie, Show } from "../../db";
import {
  isEmptyConstraints,
  parseConstraints,
  satisfiesRuntime,
  type RuntimeConstraint,
} from "./constraints";
import { cosineSimilarity, embed, isEmbedderReady } from "./embedder";
import { loadEmbeddingIndex, embeddingCacheKey } from "./titleIndex";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  MAX_MATCHED_TAGS,
  NEGATION_ABSOLUTE_FLOOR,
  NEGATION_RELATIVE_FACTOR,
  TAG_MATCH_THRESHOLD,
  TITLE_ABSOLUTE_FLOOR,
  TITLE_RELATIVE_FLOOR,
} from "./vocabulary";

/** Anything in the library that mood search can rank. */
export interface MoodCandidate {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  /** Per-episode runtime for shows, total runtime for movies. */
  runtimeMinutes: number | null | undefined;
  genreIds: number[] | undefined;
}

export function showToMoodCandidate(show: Show): MoodCandidate {
  return {
    kind: "show",
    tmdbId: show.tmdbId,
    name: show.name,
    // Per-episode runtime, not whole-series: "under 90 minutes" against a
    // show sensibly means one sitting, and a series total would make every
    // upper bound exclude everything.
    runtimeMinutes: show.episodeRuntimeMinutes,
    genreIds: show.genreIds,
  };
}

export function movieToMoodCandidate(movie: Movie): MoodCandidate {
  return {
    kind: "movie",
    tmdbId: movie.tmdbId,
    name: movie.title,
    runtimeMinutes: movie.runtimeMinutes,
    genreIds: movie.genreIds,
  };
}

export interface MoodFilter {
  mode: "semantic" | "keyword";
  /** Original query, kept for display. */
  query: string;
  /**
   * What keyword mode actually matches title names against: the query with
   * runtime clauses and negated spans stripped out. Matching the raw query
   * instead would break the moment a user combined the two, since
   * "stranger things under 90 minutes" is not a substring of any title.
   */
  keyword: string;
  /** Vocabulary tags the query resolved to, best first. Shown in the UI. */
  matchedTags: string[];
  /** Tags the user explicitly excluded, resolved from the negated phrases. */
  excludedTags: string[];
  runtime: RuntimeConstraint;
  /**
   * Similarity per `${kind}:${tmdbId}` for EVERY title that had a cached
   * vector, including ones below the cut.
   *
   * Deliberately not pre-filtered. Membership of this map is what
   * distinguishes "the model has never seen this title" from "the model
   * scored it and it was weak", and those two need opposite treatment:
   * the first deserves the coarse genre fallback below, the second must
   * not get one, or a title the ranking already rejected sneaks back in
   * through a much blunter rule.
   */
  scores: Map<string, number>;
  /** Minimum score in `scores` that counts as a match. See vocabulary.ts. */
  cut: number;
  /** Titles ruled out by a negated phrase. */
  excluded: Set<string>;
  /**
   * Genres implied by the matched tags. Used ONLY for titles with no cached
   * embedding at all, so an unindexed title still gets a coarse chance
   * rather than vanishing. Null means no genre signal was derived.
   *
   * There is deliberately no genre-based EXCLUSION counterpart. Tag genres
   * are far broader than the tags themselves: "found footage" maps to
   * Horror, so denying that genre on a negation would turn "not found
   * footage" into "no horror at all", throwing away most of what the user
   * actually asked for. Exclusion is done by embedding similarity only,
   * which is narrow enough to be trusted with it.
   */
  fallbackGenreIds: Set<number> | null;
}

// ---- Precomputed vocabulary asset -------------------------------------------

interface VocabularyFile {
  model: string;
  dimensions: number;
  tags: { id: string; genreIds: number[]; vector: number[] }[];
}

let vocabularyCache: { id: string; genreIds: number[]; vector: Float32Array }[] | null = null;

/**
 * Loads and validates public/mood-vocabulary.json.
 *
 * Validated rather than trusted because it is a build artefact that can
 * drift: regenerating it after changing EMBEDDING_MODEL_ID without updating
 * the constant (or the reverse) would produce vectors from a different model
 * than the query is embedded with. Nothing downstream could detect that, the
 * cosine values would just be quietly meaningless, so it is caught here.
 */
export async function loadVocabularyVectors() {
  if (vocabularyCache) return vocabularyCache;

  const res = await fetch(`${import.meta.env.BASE_URL}mood-vocabulary.json`);
  if (!res.ok) throw new Error(`Could not load mood vocabulary: ${res.status}`);
  const parsed = (await res.json()) as VocabularyFile;

  if (parsed?.model !== EMBEDDING_MODEL_ID) {
    throw new Error(
      `Mood vocabulary was built with "${parsed?.model}" but the app uses "${EMBEDDING_MODEL_ID}". ` +
        `Re-run: npm run build:mood-vocabulary`
    );
  }
  if (parsed.dimensions !== EMBEDDING_DIMENSIONS || !Array.isArray(parsed.tags) || parsed.tags.length === 0) {
    throw new Error("Mood vocabulary file is malformed");
  }

  vocabularyCache = parsed.tags.map((t) => {
    if (!Array.isArray(t.vector) || t.vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Mood vocabulary tag "${t?.id}" has the wrong vector length`);
    }
    return { id: t.id, genreIds: t.genreIds ?? [], vector: Float32Array.from(t.vector) };
  });
  return vocabularyCache;
}

// ---- Filter construction ----------------------------------------------------

function matchTags(
  queryVector: Float32Array,
  vocabulary: { id: string; genreIds: number[]; vector: Float32Array }[]
): { id: string; genreIds: number[]; score: number }[] {
  return vocabulary
    .map((t) => ({ id: t.id, genreIds: t.genreIds, score: cosineSimilarity(queryVector, t.vector) }))
    .filter((t) => t.score >= TAG_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_TAGS);
}

/** A filter carrying only what the deterministic parse found. No model needed. */
function keywordFilter(query: string, keyword: string, runtime: RuntimeConstraint): MoodFilter {
  return {
    mode: "keyword",
    query,
    keyword,
    matchedTags: [],
    excludedTags: [],
    runtime,
    scores: new Map(),
    cut: 0,
    excluded: new Set(),
    fallbackGenreIds: null,
  };
}

/**
 * Builds the filter for a query.
 *
 * Never throws for an ordinary failure: a model that will not load, a
 * malformed vocabulary file, or a query the model produces nothing useful
 * for all resolve to keyword mode. The feature failing must never take the
 * rest of the screen down with it.
 */
export async function buildMoodFilter(query: string, candidates: MoodCandidate[]): Promise<MoodFilter> {
  const parsed = parseConstraints(query);

  // Gibberish, an unsupported language, or a query that was nothing but a
  // runtime clause: there is no positive text left to embed. Keyword mode
  // still applies the runtime bounds, which is more useful than an empty list.
  if (!parsed.positiveText && isEmptyConstraints(parsed)) return keywordFilter(query, parsed.positiveText, parsed.runtime);
  if (!parsed.positiveText) return keywordFilter(query, parsed.positiveText, parsed.runtime);

  if (!isEmbedderReady()) return keywordFilter(query, parsed.positiveText, parsed.runtime);

  try {
    const [vocabulary, index, queryVector] = await Promise.all([
      loadVocabularyVectors(),
      loadEmbeddingIndex(),
      embed(parsed.positiveText),
    ]);

    const tags = matchTags(queryVector, vocabulary);

    // Title similarity, then a relative cut. See the threshold commentary in
    // vocabulary.ts for why this is relative and not a fixed number.
    const scores = new Map<string, number>();
    let best = 0;
    for (const candidate of candidates) {
      const key = embeddingCacheKey(candidate.kind, candidate.tmdbId);
      const vector = index.get(key);
      if (!vector) continue; // unindexed; handled by the genre fallback
      const score = cosineSimilarity(queryVector, vector);
      scores.set(key, score);
      if (score > best) best = score;
    }
    const cut = Math.max(TITLE_ABSOLUTE_FLOOR, best * TITLE_RELATIVE_FLOOR);

    // Negation. Each phrase is embedded and compared against the same title
    // vectors; the exclusion bar is relative to how close the phrase gets to
    // anything in THIS library, floored so a phrase with no real match here
    // does not still exclude the nearest thing to it.
    const excluded = new Set<string>();
    const excludedTags: string[] = [];
    for (const phrase of parsed.negatedPhrases) {
      const phraseVector = await embed(phrase);

      // Display only. The tag's genres are deliberately not used to exclude
      // anything; see the fallbackGenreIds comment on MoodFilter.
      for (const tag of matchTags(phraseVector, vocabulary)) excludedTags.push(tag.id);

      const sims = new Map<string, number>();
      let topSim = 0;
      for (const [key, vector] of index) {
        const sim = cosineSimilarity(phraseVector, vector);
        sims.set(key, sim);
        if (sim > topSim) topSim = sim;
      }
      const bar = Math.max(NEGATION_ABSOLUTE_FLOOR, topSim * NEGATION_RELATIVE_FACTOR);
      for (const [key, sim] of sims) if (sim >= bar) excluded.add(key);
    }

    const fallbackGenreIds = new Set<number>();
    for (const tag of tags) for (const id of tag.genreIds) fallbackGenreIds.add(id);

    // Nothing recognised at all and no structured constraint: the query was
    // meaningless to the model. Plain search beats an empty list.
    if (scores.size === 0 && tags.length === 0 && isEmptyConstraints(parsed)) {
      return keywordFilter(query, parsed.positiveText, parsed.runtime);
    }

    return {
      mode: "semantic",
      query,
      keyword: parsed.positiveText,
      matchedTags: tags.map((t) => t.id),
      excludedTags: [...new Set(excludedTags)],
      runtime: parsed.runtime,
      scores,
      cut,
      excluded,
      fallbackGenreIds: fallbackGenreIds.size > 0 ? fallbackGenreIds : null,
    };
  } catch {
    // Model, vocabulary, or Dexie failure. The deterministic half of the
    // parse survives, so keyword mode keeps the runtime bounds.
    return keywordFilter(query, parsed.positiveText, parsed.runtime);
  }
}

// ---- Filter application -----------------------------------------------------

/**
 * The same plain substring match the Shows and Movies pages use. An empty
 * keyword matches everything, which is what makes a query that was nothing
 * but a runtime clause ("under 90 minutes") behave as a pure runtime filter
 * rather than returning nothing.
 */
function matchesKeyword(candidate: MoodCandidate, keyword: string): boolean {
  const q = keyword.trim().toLowerCase();
  if (!q) return true;
  return candidate.name.toLowerCase().includes(q);
}

/**
 * Whether a candidate survives the filter. Exported separately from the
 * ranking helper below so callers that only need a yes/no (Watch Next) do
 * not have to sort.
 */
export function matchesMoodFilter(candidate: MoodCandidate, filter: MoodFilter): boolean {
  if (!satisfiesRuntime(candidate.runtimeMinutes, filter.runtime)) return false;
  if (filter.mode === "keyword") return matchesKeyword(candidate, filter.keyword);

  const key = embeddingCacheKey(candidate.kind, candidate.tmdbId);
  if (filter.excluded.has(key)) return false;

  // Scored by the model: its verdict is final, in both directions. A title
  // below the cut must NOT fall through to the genre rule below, or the
  // coarse signal would silently overturn the precise one.
  const score = filter.scores.get(key);
  if (score !== undefined) return score >= filter.cut;

  // Genuinely unindexed. Fall back to the coarse genre signal rather than
  // dropping it: a title with no vector is a gap in our index, not evidence
  // that the user does not want it.
  const genreIds = candidate.genreIds;
  if (!genreIds || genreIds.length === 0) return false;
  if (!filter.fallbackGenreIds) return false;
  return genreIds.some((id) => filter.fallbackGenreIds!.has(id));
}

/** Filters and orders by match strength. Unindexed survivors sort last. */
export function rankByMoodFilter<T extends MoodCandidate>(candidates: T[], filter: MoodFilter): T[] {
  const kept = candidates.filter((c) => matchesMoodFilter(c, filter));
  if (filter.mode === "keyword") return kept;
  return kept.sort((a, b) => {
    const sa = filter.scores.get(embeddingCacheKey(a.kind, a.tmdbId)) ?? -1;
    const sb = filter.scores.get(embeddingCacheKey(b.kind, b.tmdbId)) ?? -1;
    return sb - sa;
  });
}
