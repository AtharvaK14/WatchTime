const TMDB_BASE = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";
// w780 is TMDB's documented "Medium" backdrop size (their sizes are
// w300/w780/w1280/original for backdrops specifically, a different size
// ladder than posters), verified against TMDB's own image-path reference
// rather than assumed. Appropriate width for a ~190px-tall hero banner
// without shipping a full 1280w/original image for that.
export const TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/w780";

// Exported so Settings and the backup/restore code reference the same
// storage key instead of re-typing the literal.
export const TMDB_API_KEY_STORAGE = "tmdb_api_key";

function getApiKey(): string {
  const key = localStorage.getItem(TMDB_API_KEY_STORAGE);
  if (!key) {
    throw new Error("TMDB API key is not set. Add it on the Settings page.");
  }
  return key;
}

export function hasApiKey(): boolean {
  return !!localStorage.getItem(TMDB_API_KEY_STORAGE);
}

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set("api_key", getApiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) {
    if (res.status === 401) throw new Error("TMDB rejected the API key. Check it on the Settings page.");
    throw new Error(`TMDB request failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Distinguishes "TMDB said no" from "couldn't reach TMDB" so the first-run
// wizard and Settings can show an actionable message instead of a generic
// failure (a user with a typo'd key needs different advice than a user on
// a dead connection).
export type KeyCheckResult = "valid" | "invalid" | "network-error";

export async function checkTmdbKey(key: string): Promise<KeyCheckResult> {
  try {
    const url = new URL(TMDB_BASE + "/authentication");
    url.searchParams.set("api_key", key);
    const res = await fetch(url.toString());
    if (res.ok) return "valid";
    if (res.status >= 500) return "network-error"; // TMDB itself is having trouble
    return "invalid"; // 401 for a bad key; any other 4xx is still key-side
  } catch {
    return "network-error"; // offline, DNS failure, etc.
  }
}

export async function verifyApiKey(key: string): Promise<boolean> {
  return (await checkTmdbKey(key)) === "valid";
}

// ---- Search ---------------------------------------------------------------

// overview is returned by /search and /discover alike, but was not declared
// here until mood discovery needed it: it is the text that gets embedded to
// rank a candidate, and it is the only tone-bearing field these endpoints
// return. Optional because TMDB gives an empty string (not null) for titles
// with no summary, and older callers never asked for it.
export interface TvSearchResult {
  id: number;
  name: string;
  first_air_date: string | null;
  poster_path: string | null;
  popularity: number;
  overview?: string | null;
  genre_ids?: number[];
}

export interface MovieSearchResult {
  id: number;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  popularity: number;
  overview?: string | null;
  genre_ids?: number[];
}

export async function searchTvShow(query: string): Promise<TvSearchResult[]> {
  const data = await tmdbGet<{ results: TvSearchResult[] }>("/search/tv", { query });
  return data.results;
}

export async function searchMovie(query: string): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/search/movie", { query });
  return data.results;
}

// ---- Details ----------------------------------------------------------------
// Both detail endpoints use append_to_response=external_ids to get imdb_id in
// the SAME call, confirmed against TMDB's own docs, rather than a second
// request. This is what makes accurate (ID-based, not title-based) OMDb
// lookups possible without doubling API calls.

export interface TvShowDetails {
  id: number;
  name: string;
  status: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string | null;
  overview: string | null;
  number_of_seasons: number;
  episode_run_time: number[]; // TMDB's array of common episode runtimes in minutes, often just one value, sometimes empty
  original_language?: string | null;
  genres: { id: number; name: string }[];
  seasons: { season_number: number; episode_count: number; name: string }[];
  external_ids?: { imdb_id: string | null };
}

export async function getTvShowDetails(tmdbId: number): Promise<TvShowDetails> {
  return tmdbGet<TvShowDetails>(`/tv/${tmdbId}`, { append_to_response: "external_ids" });
}

export interface SeasonEpisode {
  episode_number: number;
  name: string;
  overview: string | null;
  air_date: string | null;
  vote_average: number;
  still_path: string | null;
}

export interface SeasonDetails {
  season_number: number;
  episodes: SeasonEpisode[];
}

export async function getSeasonDetails(tmdbId: number, seasonNumber: number): Promise<SeasonDetails> {
  return tmdbGet<SeasonDetails>(`/tv/${tmdbId}/season/${seasonNumber}`);
}

export interface MovieDetails {
  id: number;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string | null;
  runtime: number | null; // minutes
  original_language?: string | null;
  genres: { id: number; name: string }[];
  external_ids?: { imdb_id: string | null };
}

export async function getMovieDetails(tmdbId: number): Promise<MovieDetails> {
  return tmdbGet<MovieDetails>(`/movie/${tmdbId}`, { append_to_response: "external_ids" });
}

// ---- Genres -----------------------------------------------------------------

export interface Genre {
  id: number;
  name: string;
}

export async function getTvGenres(): Promise<Genre[]> {
  const data = await tmdbGet<{ genres: Genre[] }>("/genre/tv/list");
  return data.genres;
}

export async function getMovieGenres(): Promise<Genre[]> {
  const data = await tmdbGet<{ genres: Genre[] }>("/genre/movie/list");
  return data.genres;
}

// ---- Discovery (Add page suggestions) ----------------------------------------

export async function getPopularTvShows(): Promise<TvSearchResult[]> {
  const data = await tmdbGet<{ results: TvSearchResult[] }>("/trending/tv/week");
  return data.results;
}

export async function getPopularMovies(): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/trending/movie/week");
  return data.results;
}

export async function getUpcomingMovies(): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/movie/upcoming", { region: "US" });
  return data.results;
}

export async function getRecentlyAvailableAtHome(): Promise<MovieSearchResult[]> {
  const today = new Date();
  const past = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/discover/movie", {
    region: "US",
    with_release_type: "4",
    "release_date.gte": fmt(past),
    "release_date.lte": fmt(today),
    sort_by: "release_date.desc",
  });
  return data.results;
}

export interface DiscoverFilters {
  genreId?: number;
  minRating?: number;
}

export async function discoverMovies(filters: DiscoverFilters): Promise<MovieSearchResult[]> {
  const params: Record<string, string> = { sort_by: "popularity.desc" };
  if (filters.genreId) params.with_genres = String(filters.genreId);
  if (filters.minRating) params["vote_average.gte"] = String(filters.minRating);
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/discover/movie", params);
  return data.results;
}

// ---- Keyword + discovery retrieval (mood discovery) -------------------------
//
// TMDB has no semantic search, so mood discovery cannot ask it for "slow burn
// and unsettling" directly. Instead the query is turned into filters TMDB does
// understand (keywords, genres, runtime), a candidate pool is fetched, and the
// on-device model re-ranks that pool. See lib/moodSearch/discover.ts.

export interface TmdbKeyword {
  id: number;
  name: string;
}

/**
 * Resolves a phrase to TMDB keyword IDs.
 *
 * Keywords are the reason this retrieval path can express things genres
 * cannot: TMDB tags titles with entries like "found footage" and "time loop",
 * where the genre list only offers Horror. Returns an empty array rather than
 * throwing, because keyword resolution is an optional precision boost and a
 * miss must degrade to genre-only retrieval, not fail the search.
 */
export async function searchKeywords(query: string): Promise<TmdbKeyword[]> {
  try {
    const data = await tmdbGet<{ results: TmdbKeyword[] }>("/search/keyword", { query });
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

export interface DiscoverQuery {
  /** OR-ed together. TMDB treats a pipe-separated list as "any of". */
  genreIds?: number[];
  keywordIds?: number[];
  /** Excludes titles carrying any of these genres. */
  withoutGenreIds?: number[];
  /** Movies: total runtime. TV: per-episode runtime. */
  maxRuntimeMinutes?: number | null;
  minRuntimeMinutes?: number | null;
  /** Suppresses titles with too few votes to have a meaningful summary. */
  minVoteCount?: number;
  /** Upper bound on votes. Used by "hidden gems" to exclude blockbusters. */
  maxVoteCount?: number;
  minRating?: number;
  /** ISO 639-1, e.g. "ja". OR-ed. */
  originalLanguages?: string[];
  /** ISO date. Maps to primary_release_date / first_air_date per media type. */
  releasedAfter?: string;
  releasedBefore?: string;
  sortBy?: "popularity.desc" | "vote_average.desc" | "primary_release_date.asc" | "first_air_date.asc";
  page?: number;
}

/**
 * TV and movie discover take the same filters under different date parameter
 * names, which is the one place the two endpoints genuinely diverge, so the
 * media type is passed in rather than duplicating the whole builder.
 */
function toDiscoverParams(q: DiscoverQuery, media: "movie" | "tv"): Record<string, string> {
  const params: Record<string, string> = {
    sort_by: q.sortBy ?? "popularity.desc",
    include_adult: "false",
    page: String(q.page ?? 1),
  };
  // Pipe is OR, comma is AND. OR is correct here: a query matching several
  // tags should widen the pool, not demand a title carry every one of them,
  // which in practice returns nothing.
  if (q.genreIds?.length) params.with_genres = q.genreIds.join("|");
  if (q.keywordIds?.length) params.with_keywords = q.keywordIds.join("|");
  if (q.withoutGenreIds?.length) params.without_genres = q.withoutGenreIds.join(",");
  if (q.maxRuntimeMinutes != null) params["with_runtime.lte"] = String(q.maxRuntimeMinutes);
  if (q.minRuntimeMinutes != null) params["with_runtime.gte"] = String(q.minRuntimeMinutes);
  if (q.minVoteCount) params["vote_count.gte"] = String(q.minVoteCount);
  if (q.maxVoteCount) params["vote_count.lte"] = String(q.maxVoteCount);
  if (q.minRating) params["vote_average.gte"] = String(q.minRating);
  if (q.originalLanguages?.length) params.with_original_language = q.originalLanguages.join("|");

  const dateField = media === "movie" ? "primary_release_date" : "first_air_date";
  if (q.releasedAfter) params[`${dateField}.gte`] = q.releasedAfter;
  if (q.releasedBefore) params[`${dateField}.lte`] = q.releasedBefore;
  return params;
}

export async function discoverMoviesBy(q: DiscoverQuery): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/discover/movie", toDiscoverParams(q, "movie"));
  return data.results ?? [];
}

export async function discoverTvBy(q: DiscoverQuery): Promise<TvSearchResult[]> {
  const data = await tmdbGet<{ results: TvSearchResult[] }>("/discover/tv", toDiscoverParams(q, "tv"));
  return data.results ?? [];
}

// ---- Taste recommendations ---------------------------------------------------
//
// /recommendations carries something the on-device model fundamentally cannot
// produce: co-watching signal from TMDB's user base. An embedding only ever
// sees a plot summary, so it has no way to know that people who finished one
// show tend to like another whose synopsis reads nothing like it. That is why
// recommendations are RETRIEVED here rather than computed locally, and the
// local model is used to personalise and filter what comes back.
//
// Note this is deliberately /recommendations and not /similar: TMDB's
// "similar" is built from genres and keywords (which the discover path
// already covers), while "recommendations" is behavioural.

export async function getTvRecommendations(tmdbId: number): Promise<TvSearchResult[]> {
  const data = await tmdbGet<{ results: TvSearchResult[] }>(`/tv/${tmdbId}/recommendations`);
  return data.results ?? [];
}

export async function getMovieRecommendations(tmdbId: number): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>(`/movie/${tmdbId}/recommendations`);
  return data.results ?? [];
}

// ---- Exact ID-based lookup, verified against TMDB's own community docs -----

export interface FindResults {
  movie_results: MovieSearchResult[];
  tv_results: TvSearchResult[];
}

export async function findByExternalId(
  externalId: string,
  source: "imdb_id" | "tvdb_id"
): Promise<FindResults> {
  return tmdbGet<FindResults>(`/find/${externalId}`, { external_source: source });
}
// ---- Release dates (notifications) -------------------------------------
//
// TMDB's movie object carries a single `release_date` (the primary one,
// usually theatrical). The distinction between "in cinemas" and "available
// at home" only exists on the separate /release_dates endpoint, which
// returns per-country lists of typed dates. Type 3 is Theatrical and type 4
// is Digital, per TMDB's own release-type enumeration.
export const TMDB_RELEASE_TYPE_THEATRICAL = 3;
export const TMDB_RELEASE_TYPE_DIGITAL = 4;

interface ReleaseDatesResponse {
  results: {
    iso_3166_1: string;
    release_dates: { type: number; release_date: string }[];
  }[];
}

/**
 * Earliest theatrical and digital release dates for a movie, as YYYY-MM-DD.
 *
 * `region` is preferred but deliberately not required to match: if TMDB has
 * no entry for it, the earliest date of that type from ANY country is used
 * rather than returning nothing. A missing regional entry is a gap in TMDB's
 * data, not evidence the release isn't happening, and the same reasoning
 * already governs isAvailableToWatch() for episodes.
 */
export async function getMovieReleaseDates(
  tmdbId: number,
  region = "US"
): Promise<{ theatrical: string | null; digital: string | null }> {
  const data = await tmdbGet<ReleaseDatesResponse>(`/movie/${tmdbId}/release_dates`);

  function earliest(type: number): string | null {
    const preferred = data.results.find((r) => r.iso_3166_1 === region);
    const pools = preferred ? [[preferred], data.results] : [data.results];
    for (const pool of pools) {
      const dates = pool
        .flatMap((r) => r.release_dates)
        .filter((d) => d.type === type && d.release_date)
        // TMDB returns full ISO datetimes here; only the calendar day matters.
        .map((d) => d.release_date.slice(0, 10))
        .sort();
      if (dates.length > 0) return dates[0];
    }
    return null;
  }

  return {
    theatrical: earliest(TMDB_RELEASE_TYPE_THEATRICAL),
    digital: earliest(TMDB_RELEASE_TYPE_DIGITAL),
  };
}
