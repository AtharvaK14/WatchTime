// Turns raw watch history into a per-title affinity score, and picks the
// seeds that recommendations are built from.
//
// Everything here is a pure function of data passed in (including the clock,
// which is a parameter, not Date.now()). No Dexie, no network, no DOM. Same
// reasoning as constraints.ts: this is the part of the recommender where the
// judgment calls live, so it needs to be inspectable and directly testable
// rather than tangled up with fetching.
//
// The scoring weights below are stated as constants with the reasoning
// attached. None of them is derived from evaluation data, because there is
// no ground truth to evaluate against here: nobody has labelled which
// recommendations you would have liked. They encode ordinary assumptions
// about what watching behaviour means, and they are meant to be argued with.

import type { Episode, Movie, Show, WatchedEpisode } from "../../db";
import { findNextUnwatched } from "../episodeSync";

// ---- Tuning ------------------------------------------------------------------

/** Episodes watched at which depth stops adding to the score. */
const DEPTH_SATURATION_EPISODES = 10;
/** Added when a series has no unwatched released episodes left. */
const COMPLETION_BONUS = 0.8;
/** Added per rewatch event, capped. Rewatching is the strongest signal available. */
const REWATCH_BONUS_PER = 0.25;
const REWATCH_BONUS_CAP = 1.0;
/**
 * A watched movie's baseline. Lower than a completed series on purpose:
 * finishing 60 episodes is a far larger commitment than sitting through one
 * film, and treating them as equal evidence lets idle movie-watching drown
 * out the shows someone actually invested in.
 */
const MOVIE_BASE = 0.6;

/**
 * Days after which a title's influence halves. Taste drifts, and a show
 * someone loved in 2019 should not outvote what they are watching now.
 */
const RECENCY_HALF_LIFE_DAYS = 365;
/**
 * Floor on the recency multiplier. Without it, an all-time favourite watched
 * years ago decays to irrelevance, which is wrong: old favourites still say
 * something true about taste.
 */
const MIN_RECENCY_WEIGHT = 0.15;

/**
 * Below this many watched episodes, a stalled show counts as abandoned
 * rather than merely paused. Someone who stopped 30 episodes in did not
 * dislike it; someone who stopped after 2 probably did.
 */
const ABANDON_MAX_EPISODES = 4;
/** Days of no progression before a stalled, shallow show counts as abandoned. */
const ABANDON_STALE_DAYS = 120;

/** Seeds used to generate recommendation rows. */
export const SEED_COUNT = 8;
/**
 * Lowest affinity that may seed a row.
 *
 * Without this, sampling one episode of something and never returning
 * produces a "Because you watched X" row, which is both a bad basis for
 * recommendations and actively embarrassing: it tells the user the app
 * thinks they liked something they clearly did not. Set just above a
 * single-episode score and just below a recently watched film.
 */
export const MIN_SEED_AFFINITY = 0.3;
/**
 * Fewest seeds needed before recommending at all. Under this the suggestions
 * would be extrapolating from almost nothing, and saying so is better than
 * quietly producing a list that looks authoritative.
 */
export const MIN_SEEDS_FOR_RECOMMENDATIONS = 3;

// ---- Types -------------------------------------------------------------------

export interface WatchSignal {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  posterPath: string | null;
  /** Higher means stronger evidence the user liked it. Recency applied. */
  affinity: number;
  /** Evidence the user actively disliked or bounced off it. */
  abandoned: boolean;
  lastWatchedAt: string | null;
  /** Human-readable basis for the score, surfaced in the UI and diagnostics. */
  reasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function recencyWeight(lastWatchedAt: string | null, now: number): number {
  if (!lastWatchedAt) return MIN_RECENCY_WEIGHT;
  const days = (now - new Date(lastWatchedAt).getTime()) / DAY_MS;
  if (!Number.isFinite(days) || days <= 0) return 1;
  return Math.max(MIN_RECENCY_WEIGHT, Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS));
}

/** Latest watch across a show's episodes, rewatches included. */
function lastActivityAt(watched: WatchedEpisode[]): string | null {
  let latest: string | null = null;
  for (const w of watched) {
    const at = w.lastWatchedAt ?? w.watchedAt;
    if (at && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function daysSinceIso(iso: string | null, now: number): number | null {
  if (!iso) return null;
  return (now - new Date(iso).getTime()) / DAY_MS;
}

/**
 * Scores every title with watch history.
 *
 * `episodesByShow` may be missing entries: the episode cache is populated
 * lazily, and a show with no cached episodes simply cannot be assessed for
 * completion. That case degrades to depth-only scoring rather than guessing.
 */
export function computeWatchSignals(
  shows: Show[],
  movies: Movie[],
  watchedEpisodes: WatchedEpisode[],
  episodesByShow: Map<number, Episode[]>,
  now: number = Date.now()
): WatchSignal[] {
  const watchedByShow = new Map<number, WatchedEpisode[]>();
  for (const w of watchedEpisodes) {
    const list = watchedByShow.get(w.showId);
    if (list) list.push(w);
    else watchedByShow.set(w.showId, [w]);
  }

  const signals: WatchSignal[] = [];

  for (const show of shows) {
    const watched = watchedByShow.get(show.tmdbId) ?? [];
    if (watched.length === 0) continue; // never started; no taste signal either way

    const reasons: string[] = [];
    const depth = Math.min(1, watched.length / DEPTH_SATURATION_EPISODES);
    let score = depth;
    if (watched.length >= DEPTH_SATURATION_EPISODES) reasons.push(`${watched.length} episodes watched`);

    const episodes = episodesByShow.get(show.tmdbId) ?? [];
    const watchedKeys = new Set(watched.map((w) => w.key));
    const completed = episodes.length > 0 && findNextUnwatched(episodes, watchedKeys) === null;
    if (completed) {
      score += COMPLETION_BONUS;
      reasons.push("finished it");
    }

    // watchCount is undefined on rows written before v5; treat as one watch.
    const rewatchEvents = watched.reduce((sum, w) => sum + Math.max(0, (w.watchCount ?? 1) - 1), 0);
    if (rewatchEvents > 0) {
      score += Math.min(REWATCH_BONUS_CAP, rewatchEvents * REWATCH_BONUS_PER);
      reasons.push("rewatched");
    }

    const lastAt = lastActivityAt(watched);
    const staleDays = daysSinceIso(lastAt, now);
    // COMPLETION OVERRIDES EVERYTHING. isArchived is documented in db.ts as
    // "still has history, just not active", and the overwhelmingly common
    // reason to archive a series is that you finished it. Treating the flag
    // as dislike would exclude precisely the shows someone watched all the
    // way through, which are the best seeds available. Same for TV Time's
    // "stopped": on a completed series it means "no longer airing for me",
    // not "gave up". Only an UNFINISHED series can be abandoned.
    const abandoned =
      !completed &&
      (show.isArchived ||
        show.tvTimeStatus === "stopped" ||
        // Shallow and long stalled: watched a couple of episodes and never
        // came back. Kept deliberately narrow, since a false positive here
        // silently removes a title from ever seeding recommendations.
        (watched.length <= ABANDON_MAX_EPISODES && staleDays !== null && staleDays > ABANDON_STALE_DAYS));
    if (abandoned) reasons.push("stopped watching");

    signals.push({
      kind: "show",
      tmdbId: show.tmdbId,
      name: show.name,
      posterPath: show.posterPath,
      affinity: score * recencyWeight(lastAt, now),
      abandoned,
      lastWatchedAt: lastAt,
      reasons,
    });
  }

  for (const movie of movies) {
    if (!movie.watched) continue;
    const reasons: string[] = [];
    let score = MOVIE_BASE;
    const rewatches = movie.rewatchCount ?? 0;
    if (rewatches > 0) {
      score += Math.min(REWATCH_BONUS_CAP, rewatches * REWATCH_BONUS_PER);
      reasons.push("rewatched");
    }
    signals.push({
      kind: "movie",
      tmdbId: movie.tmdbId,
      name: movie.title,
      posterPath: movie.posterPath,
      affinity: score * recencyWeight(movie.watchedAt, now),
      abandoned: false, // a finished film carries no abandonment signal
      lastWatchedAt: movie.watchedAt,
      reasons,
    });
  }

  return signals;
}

/**
 * Picks the titles to build recommendation rows from.
 *
 * Abandoned titles are excluded rather than penalised. This is the cheap,
 * high-confidence use of the negative signal: never ask "what else is like
 * this?" about something the user bounced off. Using abandonment to also
 * demote individual candidates would need an embedding per candidate, which
 * costs far more than it is worth for a weaker inference.
 *
 * At most one seed per franchise-ish name prefix is not attempted here; TMDB
 * recommendations already overlap heavily between sequels, and cross-row
 * de-duplication in forYou.ts handles the visible result.
 */
export function selectSeeds(signals: WatchSignal[], limit: number = SEED_COUNT): WatchSignal[] {
  return signals
    .filter((s) => !s.abandoned && s.affinity >= MIN_SEED_AFFINITY)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, limit);
}
