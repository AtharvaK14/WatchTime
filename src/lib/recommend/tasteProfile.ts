// Aggregates a whole watch history into one taste profile.
//
// This replaces the earlier per-title approach ("because you watched X").
// Seeding off individual titles had two problems worth naming, because they
// are what this file exists to fix:
//
//   1. It over-fitted to whatever you happened to watch last. One sampled
//      documentary produced a whole row of documentaries.
//   2. It could not express anything you like in general. "You watch a lot of
//      dark crime, mostly hour-long, mostly Korean" is a real preference that
//      no single title represents.
//
// Everything here is a pure function of data passed in, clock included. Same
// reasoning as signals.ts: the judgment calls live here, so they need to be
// inspectable and testable without a network or a database.

import type { Episode, Movie, Show, WatchedEpisode } from "../../db";
import type { Genre } from "../../tmdb";
import { computeWatchSignals, type WatchSignal } from "./signals";

// ---- Tuning ------------------------------------------------------------------

/** Genres above this share of total affinity are "favourites". */
const FAVOURITE_GENRE_SHARE = 0.08;
/** Never treat more than this many genres as favourites, however flat the spread. */
const MAX_FAVOURITE_GENRES = 6;
/** Days counted as "recent" for the recency-weighted genre view. */
const RECENT_WINDOW_DAYS = 90;
/**
 * A language must cover at least this share of the library before it is used
 * to filter recommendations. Below it, filtering by language would narrow
 * results on what is probably incidental (one subtitled film) rather than a
 * real preference.
 */
const LANGUAGE_SIGNIFICANCE_SHARE = 0.25;
/** Watched titles needed before the profile is worth acting on. */
const LOW_CONFIDENCE_BELOW = 5;
const HIGH_CONFIDENCE_AT = 25;
/** Widens the runtime preference into a usable filter band. */
const RUNTIME_BAND_MINUTES = 35;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GenreAffinity {
  genreId: number;
  name: string;
  /** Share of total genre affinity, 0..1. */
  share: number;
  /** Distinct watched titles carrying this genre. */
  titleCount: number;
}

export interface TasteProfile {
  /** All genres with any signal, strongest first. */
  genres: GenreAffinity[];
  /** The subset worth recommending on. */
  favouriteGenreIds: number[];
  /** Genres weighted toward the last RECENT_WINDOW_DAYS, strongest first. */
  recentGenreIds: number[];
  /**
   * Genres present in the library but clearly disliked: watched at least
   * twice and abandoned every time. Used to exclude, which is a signal
   * ordinary recommenders throw away.
   */
  avoidedGenreIds: number[];
  /** ISO 639-1 codes covering a meaningful share of the library. */
  preferredLanguages: string[];
  /** Typical movie length and episode length, as a filter band. */
  movieRuntime: { min: number; max: number } | null;
  episodeRuntime: { min: number; max: number } | null;
  /** Series finished / series started, 0..1. Null when nothing was started. */
  completionRate: number | null;
  /** Average TMDB rating of episodes actually watched. Null when unknown. */
  averageEpisodeRating: number | null;
  /** Titles with real watch history behind this profile. */
  signalCount: number;
  confidence: "none" | "low" | "medium" | "high";
  /** Strongest titles, for the insights strip. */
  topTitles: { name: string; kind: "show" | "movie"; affinity: number }[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function band(centre: number | null, width: number): { min: number; max: number } | null {
  if (centre === null) return null;
  return { min: Math.max(0, Math.round(centre - width)), max: Math.round(centre + width) };
}

function genreIdsFor(kind: "show" | "movie", tmdbId: number, shows: Show[], movies: Movie[]): number[] {
  if (kind === "show") return shows.find((s) => s.tmdbId === tmdbId)?.genreIds ?? [];
  return movies.find((m) => m.tmdbId === tmdbId)?.genreIds ?? [];
}

export function buildTasteProfile(
  shows: Show[],
  movies: Movie[],
  watchedEpisodes: WatchedEpisode[],
  episodesByShow: Map<number, Episode[]>,
  genreNames: Map<number, string>,
  now: number = Date.now()
): TasteProfile {
  const signals = computeWatchSignals(shows, movies, watchedEpisodes, episodesByShow, now);
  const positive = signals.filter((s) => !s.abandoned && s.affinity > 0);

  // ---- Genre affinity -------------------------------------------------------
  // A title's affinity is split across its genres rather than counted once
  // per genre. Without the split, a title tagged with five genres would
  // contribute five times as much as a single-genre title of identical
  // engagement, which systematically over-weights sprawling franchise
  // entries against focused ones.
  const rawAffinity = new Map<number, number>();
  const titleCounts = new Map<number, number>();
  const recentAffinity = new Map<number, number>();

  for (const signal of positive) {
    const ids = genreIdsFor(signal.kind, signal.tmdbId, shows, movies);
    if (ids.length === 0) continue;
    const perGenre = signal.affinity / ids.length;
    const isRecent =
      signal.lastWatchedAt !== null && (now - new Date(signal.lastWatchedAt).getTime()) / DAY_MS <= RECENT_WINDOW_DAYS;
    for (const id of ids) {
      rawAffinity.set(id, (rawAffinity.get(id) ?? 0) + perGenre);
      titleCounts.set(id, (titleCounts.get(id) ?? 0) + 1);
      if (isRecent) recentAffinity.set(id, (recentAffinity.get(id) ?? 0) + perGenre);
    }
  }

  const total = [...rawAffinity.values()].reduce((a, b) => a + b, 0);
  const genres: GenreAffinity[] = [...rawAffinity.entries()]
    .map(([genreId, value]) => ({
      genreId,
      name: genreNames.get(genreId) ?? `Genre ${genreId}`,
      share: total > 0 ? value / total : 0,
      titleCount: titleCounts.get(genreId) ?? 0,
    }))
    .sort((a, b) => b.share - a.share);

  // Corroboration guard. One heavily engaged single-genre title can take a
  // huge share on its own (a rewatched, finished comedy with no other genre
  // tag), which would tilt every recommendation toward a genre backed by a
  // single data point. Genres seen across two or more titles are preferred,
  // but only when enough of them qualify: on a small library that filter
  // would leave nothing, and no favourites is worse than shaky ones.
  const qualifying = genres.filter((g) => g.share >= FAVOURITE_GENRE_SHARE);
  const corroborated = qualifying.filter((g) => g.titleCount >= 2);
  const favouriteGenreIds = (corroborated.length >= 2 ? corroborated : qualifying)
    .slice(0, MAX_FAVOURITE_GENRES)
    .map((g) => g.genreId);

  const recentGenreIds = [...recentAffinity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FAVOURITE_GENRES)
    .map(([id]) => id);

  // ---- Avoided genres -------------------------------------------------------
  // Only genres where EVERY encounter was abandoned, and there were at least
  // two. One abandoned show says nothing (people quit for reasons unrelated
  // to taste); a consistent pattern across several does.
  const abandonedCounts = new Map<number, number>();
  for (const signal of signals.filter((s) => s.abandoned)) {
    for (const id of genreIdsFor(signal.kind, signal.tmdbId, shows, movies)) {
      abandonedCounts.set(id, (abandonedCounts.get(id) ?? 0) + 1);
    }
  }
  const avoidedGenreIds = [...abandonedCounts.entries()]
    .filter(([id, count]) => count >= 2 && !titleCounts.has(id))
    .map(([id]) => id);

  // ---- Language -------------------------------------------------------------
  const languageCounts = new Map<string, number>();
  let languageKnown = 0;
  for (const signal of positive) {
    const lang =
      signal.kind === "show"
        ? shows.find((s) => s.tmdbId === signal.tmdbId)?.originalLanguage
        : movies.find((m) => m.tmdbId === signal.tmdbId)?.originalLanguage;
    if (!lang) continue;
    languageKnown++;
    languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + 1);
  }
  const preferredLanguages =
    languageKnown === 0
      ? []
      : [...languageCounts.entries()]
          .filter(([, count]) => count / languageKnown >= LANGUAGE_SIGNIFICANCE_SHARE)
          .sort((a, b) => b[1] - a[1])
          .map(([code]) => code);

  // ---- Runtime --------------------------------------------------------------
  const watchedMovieRuntimes = movies
    .filter((m) => m.watched && m.runtimeMinutes != null)
    .map((m) => m.runtimeMinutes as number);
  const startedShowIds = new Set(watchedEpisodes.map((w) => w.showId));
  const watchedEpisodeRuntimes = shows
    .filter((s) => startedShowIds.has(s.tmdbId) && s.episodeRuntimeMinutes != null)
    .map((s) => s.episodeRuntimeMinutes as number);

  // ---- Completion + ratings -------------------------------------------------
  let started = 0;
  let finished = 0;
  for (const show of shows) {
    if (!startedShowIds.has(show.tmdbId)) continue;
    started++;
    const episodes = episodesByShow.get(show.tmdbId) ?? [];
    if (episodes.length === 0) continue;
    const watchedKeys = new Set(watchedEpisodes.filter((w) => w.showId === show.tmdbId).map((w) => w.key));
    if (episodes.every((e) => watchedKeys.has(e.key))) finished++;
  }

  // Rating of episodes the user actually watched, not of the show overall.
  // Note this is TMDB's public score, not the user's own: the app has no
  // user-rating feature, so "highly rated" can only mean "well regarded by
  // others, and you watched it".
  const watchedKeySet = new Set(watchedEpisodes.map((w) => w.key));
  const ratings: number[] = [];
  for (const episodes of episodesByShow.values()) {
    for (const ep of episodes) {
      if (watchedKeySet.has(ep.key) && ep.tmdbRating > 0) ratings.push(ep.tmdbRating);
    }
  }

  const signalCount = positive.length;
  const confidence: TasteProfile["confidence"] =
    signalCount === 0
      ? "none"
      : signalCount < LOW_CONFIDENCE_BELOW
        ? "low"
        : signalCount < HIGH_CONFIDENCE_AT
          ? "medium"
          : "high";

  return {
    genres,
    favouriteGenreIds,
    recentGenreIds,
    avoidedGenreIds,
    preferredLanguages,
    movieRuntime: band(median(watchedMovieRuntimes), RUNTIME_BAND_MINUTES),
    episodeRuntime: band(median(watchedEpisodeRuntimes), RUNTIME_BAND_MINUTES),
    completionRate: started > 0 ? finished / started : null,
    averageEpisodeRating: ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    signalCount,
    confidence,
    topTitles: [...positive]
      .sort((a, b) => b.affinity - a.affinity)
      .slice(0, 5)
      .map((s: WatchSignal) => ({ name: s.name, kind: s.kind, affinity: s.affinity })),
  };
}

/** Genre id -> name, merging TMDB's separate TV and movie lists. */
export function mergeGenreNames(tv: Genre[], movie: Genre[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const g of [...tv, ...movie]) map.set(g.id, g.name);
  return map;
}
