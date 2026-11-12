const TMDB_BASE = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";
// w780 is TMDB's documented "Medium" backdrop size (their sizes are
// w300/w780/w1280/original for backdrops specifically, a different size
// ladder than posters), verified against TMDB's own image-path reference
// rather than assumed. Appropriate width for a ~190px-tall hero banner
// without shipping a full 1280w/original image for that.
export const TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/w780";

// Episode stills. These were being served from TMDB_IMAGE_BASE (w342), which
// is a POSTER width: fine for the 64x36 thumbnails in the season browser it
// was originally chosen for, but the episode detail panel renders the same
// still as a full-width 16:9 hero. At a 480px modal on a 3x phone that is
// roughly 1440 physical pixels being filled from a 342px source, which is
// why it looked soft. w780 is the same size the show detail hero already
// uses for its backdrop, so the two heroes now match in quality as well as
// in layout.
//
// Note this is deliberately a separate constant rather than a change to
// TMDB_IMAGE_BASE: that one is used for poster grids all over the app, where
// w342 is already generous and raising it would cost bandwidth on every
// screen for no visible gain.
export const TMDB_STILL_BASE = "https://image.tmdb.org/t/p/w780";

// Streaming-provider logos. TMDB serves these from a separate size ladder to
// posters and backdrops (w45/w92/w154/w185/w300/w500/original); w92 is the
// smallest that still looks clean on a 3x phone at the ~16px the capsules
// render them, and the assets themselves are tiny square marks.
//
// Using TMDB's copy of each provider's logo is deliberate: it is the mark the
// provider supplies to TMDB for exactly this purpose, so nothing
// trademark-bearing is checked into this repo or re-drawn by hand, and a
// provider that rebrands does so here without an app update.
export const TMDB_LOGO_BASE = "https://image.tmdb.org/t/p/w92";

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

// ---- Request layer ----------------------------------------------------------
//
// Every TMDB read goes through tmdbGet, so the rules that keep the app from
// asking for the same thing twice live in one place rather than in each
// caller:
//
//  - Identical requests that overlap share one fetch. A details panel and a
//    library backfill asking about the same title at the same moment used to
//    cost two requests.
//  - A response can be kept in memory for a while (ttlMs), for data that does
//    not change at the pace the UI re-asks for it: reopening a panel, or
//    coming back to Discover, is then served without a request.
//  - A 429 is waited out and retried rather than surfaced. Backfills treat a
//    thrown error as "TMDB has nothing for this title", so a rate limit part
//    way through a large library used to be recorded as missing data.
//  - A request that never answers is abandoned, so a sync walking the library
//    one show at a time cannot hang on one of them.

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 2;
/** Upper bound on one Retry-After wait; TMDB normally asks for a second or two. */
const MAX_RETRY_WAIT_MS = 10_000;
/** Responses kept in memory at once. Least recently used goes first. */
const MEMORY_CACHE_ENTRIES = 200;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A title's details: long enough to cover a panel and a backfill reading the same title. */
const DETAILS_TTL_MS = 5 * MINUTE_MS;
/** Cast lists and people: effectively fixed for as long as anyone is looking at them. */
const CREDITS_TTL_MS = 6 * HOUR_MS;
/** Trending, upcoming and discover shelves, which TMDB itself recomputes daily at most. */
const SHELF_TTL_MS = 3 * HOUR_MS;
const SEARCH_TTL_MS = 5 * MINUTE_MS;
/** Genre and region lists change a few times a decade. */
const STATIC_LIST_TTL_MS = 30 * DAY_MS;

export interface TmdbReadOptions {
  /** Skip the in-memory copy and ask TMDB now. For a pull to refresh. */
  fresh?: boolean;
}

interface TmdbGetOptions extends TmdbReadOptions {
  /** Keep the response in memory this long. Omitted: never kept. */
  ttlMs?: number;
}

const inFlight = new Map<string, Promise<unknown>>();
const memoryCache = new Map<string, { at: number; data: unknown }>();

/**
 * Callers get their own copy, never the cached object: several of them sort
 * or trim what they are handed, and that must not reach the next reader.
 */
function copyOf<T>(data: T): T {
  return typeof structuredClone === "function" ? structuredClone(data) : (JSON.parse(JSON.stringify(data)) as T);
}

function remember(key: string, data: unknown): void {
  memoryCache.delete(key);
  memoryCache.set(key, { at: Date.now(), data });
  while (memoryCache.size > MEMORY_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

/** Drops every response held in memory. For a changed API key, and for tests. */
export function clearTmdbMemoryCache(): void {
  memoryCache.clear();
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new Error("TMDB took too long to respond.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(url);
    if (res.ok) return res.json() as Promise<T>;
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : attempt + 1;
      await wait(Math.min(seconds * 1000, MAX_RETRY_WAIT_MS));
      continue;
    }
    if (res.status === 401) throw new Error("TMDB rejected the API key. Check it on the Settings page.");
    if (res.status === 429) throw new Error("TMDB is rate limiting requests. Try again in a moment.");
    throw new Error(`TMDB request failed: ${res.status} ${res.statusText}`);
  }
}

async function tmdbGet<T>(
  path: string,
  params: Record<string, string> = {},
  options: TmdbGetOptions = {}
): Promise<T> {
  const url = new URL(TMDB_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // The request's identity: the URL before the key goes on it, so the key is
  // never held anywhere but the outgoing request.
  url.searchParams.sort();
  const key = url.pathname + url.search;
  url.searchParams.set("api_key", getApiKey());

  if (options.ttlMs && !options.fresh) {
    const hit = memoryCache.get(key);
    if (hit && Date.now() - hit.at < options.ttlMs) {
      // Moved to most recently used, keeping its age.
      memoryCache.delete(key);
      memoryCache.set(key, hit);
      return copyOf(hit.data as T);
    }
  }

  let pending = inFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = requestJson<T>(url.toString()).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    if (options.ttlMs) {
      // Only answers are kept. A failure is asked again next time.
      pending.then((data) => remember(key, data)).catch(() => {});
    }
  }
  return copyOf(await pending);
}

/**
 * A small list kept in localStorage, for the few TMDB answers that are the
 * same for months and are asked for on every visit to a page. A failed read
 * or write of the stored copy only ever costs the request it would have saved.
 */
async function storedList<T>(name: string, load: () => Promise<T>): Promise<T> {
  const storageKey = `tmdb_list:${name}`;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const stored = JSON.parse(raw) as { at: number; data: T };
      if (Date.now() - stored.at < STATIC_LIST_TTL_MS && Array.isArray(stored.data) && stored.data.length > 0) {
        return stored.data;
      }
    }
  } catch {
    // Unreadable copy: fetch it again.
  }
  const data = await load();
  try {
    localStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Storage full or unavailable: the list still came back.
  }
  return data;
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
  vote_average?: number;
}

export interface MovieSearchResult {
  id: number;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  popularity: number;
  overview?: string | null;
  genre_ids?: number[];
  vote_average?: number;
}

export async function searchTvShow(query: string): Promise<TvSearchResult[]> {
  const data = await tmdbGet<{ results: TvSearchResult[] }>("/search/tv", { query }, { ttlMs: SEARCH_TTL_MS });
  return data.results;
}

export async function searchMovie(query: string): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/search/movie", { query }, { ttlMs: SEARCH_TTL_MS });
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
  // air_date is the season's premiere, null while TMDB has not dated any of it.
  seasons: { season_number: number; episode_count: number; name: string; air_date?: string | null }[];
  external_ids?: { imdb_id: string | null };
  vote_average?: number;
}

export async function getTvShowDetails(tmdbId: number, options: TmdbReadOptions = {}): Promise<TvShowDetails> {
  return tmdbGet<TvShowDetails>(
    `/tv/${tmdbId}`,
    { append_to_response: "external_ids" },
    { ttlMs: DETAILS_TTL_MS, fresh: options.fresh }
  );
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
  vote_average?: number;
}

// ---- Credits ----------------------------------------------------------------
// For the details panel's Cast row and a movie's director. A separate request
// rather than append_to_response on the details call: the details endpoints
// are also used by every library backfill, which has no use for a cast list.

export interface CastMember {
  id: number;
  name: string;
  /** The role, or "" when TMDB has none. */
  character: string;
  profilePath: string | null;
}

export interface TitleCredits {
  cast: CastMember[];
  /** Movies only: the first credited director. */
  director: string | null;
}

/** How many cast members the panel shows; TMDB orders them by billing. */
const CAST_LIMIT = 12;

export async function getCredits(kind: "show" | "movie", tmdbId: number): Promise<TitleCredits> {
  // Shows: aggregate_credits, which spans every season, so a series' main
  // cast is the people across its run rather than only its latest season's.
  // Its cast rows carry roles[] instead of a single character.
  const data = await tmdbGet<{
    cast?: { id: number; name: string; character?: string; roles?: { character: string }[]; profile_path: string | null }[];
    crew?: { job?: string; name: string }[];
  }>(kind === "show" ? `/tv/${tmdbId}/aggregate_credits` : `/movie/${tmdbId}/credits`, {}, { ttlMs: CREDITS_TTL_MS });
  return {
    cast: (data.cast ?? []).slice(0, CAST_LIMIT).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character ?? c.roles?.[0]?.character ?? "",
      profilePath: c.profile_path,
    })),
    director: kind === "movie" ? (data.crew?.find((c) => c.job === "Director")?.name ?? null) : null,
  };
}

// ---- One episode's credits (the episode page) -------------------------------

export interface EpisodeCredits {
  /** Minutes, from TMDB; null when it has none. */
  runtime: number | null;
  directors: string[];
  writers: string[];
  /** The series regulars in this episode first, then its guest stars. */
  cast: CastMember[];
}

const EPISODE_CAST_LIMIT = 16;
const WRITER_JOBS = new Set(["Writer", "Screenplay", "Teleplay", "Story"]);

export async function getEpisodeCredits(showId: number, season: number, episode: number): Promise<EpisodeCredits> {
  type RawPerson = { id: number; name: string; character?: string; profile_path: string | null };
  const data = await tmdbGet<{
    runtime?: number | null;
    crew?: { job?: string; name: string }[];
    guest_stars?: RawPerson[];
    credits?: { cast?: RawPerson[] };
  }>(`/tv/${showId}/season/${season}/episode/${episode}`, { append_to_response: "credits" }, { ttlMs: CREDITS_TTL_MS });

  const names = (jobs: (job: string) => boolean) => [
    ...new Set((data.crew ?? []).filter((c) => c.job && jobs(c.job)).map((c) => c.name)),
  ];
  const seen = new Set<number>();
  const cast: CastMember[] = [];
  for (const p of [...(data.credits?.cast ?? []), ...(data.guest_stars ?? [])]) {
    if (seen.has(p.id) || cast.length >= EPISODE_CAST_LIMIT) continue;
    seen.add(p.id);
    cast.push({ id: p.id, name: p.name, character: p.character ?? "", profilePath: p.profile_path });
  }
  return {
    runtime: data.runtime ?? null,
    directors: names((j) => j === "Director"),
    writers: names((j) => WRITER_JOBS.has(j)),
    cast,
  };
}

// ---- People (cast pages) -----------------------------------------------------

export interface PersonCredit {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  year: number | null;
  posterPath: string | null;
  rating: number | null;
  /** Their character, or their job for a crew credit; "" when TMDB has none. */
  role: string;
}

export interface PersonDetails {
  id: number;
  name: string;
  biography: string;
  /** TMDB's known_for_department: "Acting", "Directing", ... */
  knownFor: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  profilePath: string | null;
  shows: PersonCredit[];
  movies: PersonCredit[];
}

/**
 * TV genres that are not the person's work but an appearance as themselves:
 * talk shows, news, reality and award-show broadcasts. A cast page listing
 * every late-night interview an actor ever gave would bury their actual
 * series under them.
 */
const APPEARANCE_GENRES = new Set([10767 /* Talk */, 10763 /* News */, 10764 /* Reality */]);

interface RawPersonCredit {
  id: number;
  media_type: "tv" | "movie";
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path: string | null;
  vote_average?: number;
  vote_count?: number;
  character?: string;
  job?: string;
  genre_ids?: number[];
}

/**
 * A cast member's page: who they are, and the shows and movies they are in,
 * best known first (TMDB vote count, which favours titles many people have
 * actually seen over ones that are merely new). One request: the credits come
 * appended to the person.
 *
 * Acting credits for actors; for someone known for directing, writing or
 * producing, their crew credits too, so a director's page is not empty.
 */
export async function getPerson(personId: number): Promise<PersonDetails> {
  const data = await tmdbGet<{
    id: number;
    name: string;
    biography?: string;
    known_for_department?: string;
    birthday?: string | null;
    deathday?: string | null;
    place_of_birth?: string | null;
    profile_path: string | null;
    combined_credits?: { cast?: RawPersonCredit[]; crew?: RawPersonCredit[] };
  }>(`/person/${personId}`, { append_to_response: "combined_credits" }, { ttlMs: CREDITS_TTL_MS });

  const knownFor = data.known_for_department ?? null;
  const raw = [
    ...(data.combined_credits?.cast ?? []),
    ...(knownFor && knownFor !== "Acting" ? (data.combined_credits?.crew ?? []) : []),
  ];

  const seen = new Map<string, RawPersonCredit & { votes: number }>();
  for (const c of raw) {
    if (c.media_type !== "tv" && c.media_type !== "movie") continue;
    if (c.media_type === "tv" && c.genre_ids?.some((g) => APPEARANCE_GENRES.has(g))) continue;
    // Self-appearances outside those genres (documentaries, specials).
    if (/^(self|himself|herself|themselves)\b/i.test(c.character ?? "")) continue;
    const key = `${c.media_type}:${c.id}`;
    // One card per title even when they hold several roles or jobs on it.
    if (!seen.has(key)) seen.set(key, { ...c, votes: c.vote_count ?? 0 });
  }

  const toCredit = (c: RawPersonCredit): PersonCredit => ({
    kind: c.media_type === "tv" ? "show" : "movie",
    tmdbId: c.id,
    name: (c.media_type === "tv" ? c.name : c.title) ?? "",
    year: Number((c.media_type === "tv" ? c.first_air_date : c.release_date)?.slice(0, 4)) || null,
    posterPath: c.poster_path,
    rating: c.vote_average ?? null,
    role: c.character || c.job || "",
  });
  const credits = [...seen.values()].sort((a, b) => b.votes - a.votes);

  return {
    id: data.id,
    name: data.name,
    biography: data.biography ?? "",
    knownFor,
    birthday: data.birthday ?? null,
    deathday: data.deathday ?? null,
    placeOfBirth: data.place_of_birth ?? null,
    profilePath: data.profile_path,
    shows: credits.filter((c) => c.media_type === "tv").map(toCredit),
    movies: credits.filter((c) => c.media_type === "movie").map(toCredit),
  };
}

export async function getMovieDetails(tmdbId: number): Promise<MovieDetails> {
  return tmdbGet<MovieDetails>(`/movie/${tmdbId}`, { append_to_response: "external_ids" }, { ttlMs: DETAILS_TTL_MS });
}

// ---- Genres -----------------------------------------------------------------

export interface Genre {
  id: number;
  name: string;
}

// Stored for a month rather than fetched on every visit to Shows, Movies and
// For You: the lists are a couple of dozen fixed entries.
export async function getTvGenres(): Promise<Genre[]> {
  return storedList("tv-genres", async () => (await tmdbGet<{ genres: Genre[] }>("/genre/tv/list")).genres);
}

export async function getMovieGenres(): Promise<Genre[]> {
  return storedList("movie-genres", async () => (await tmdbGet<{ genres: Genre[] }>("/genre/movie/list")).genres);
}

// ---- Discovery (Add page suggestions) ----------------------------------------

export async function getPopularTvShows(): Promise<TvSearchResult[]> {
  const data = await tmdbGet<{ results: TvSearchResult[] }>("/trending/tv/week", {}, { ttlMs: SHELF_TTL_MS });
  return data.results;
}

export async function getPopularMovies(): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/trending/movie/week", {}, { ttlMs: SHELF_TTL_MS });
  return data.results;
}

export async function getUpcomingMovies(): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/movie/upcoming", { region: "US" }, { ttlMs: SHELF_TTL_MS });
  return data.results;
}

export async function getRecentlyAvailableAtHome(): Promise<MovieSearchResult[]> {
  const today = new Date();
  const past = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const data = await tmdbGet<{ results: MovieSearchResult[] }>(
    "/discover/movie",
    {
      region: "US",
      with_release_type: "4",
      "release_date.gte": fmt(past),
      "release_date.lte": fmt(today),
      sort_by: "release_date.desc",
    },
    { ttlMs: SHELF_TTL_MS }
  );
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
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/discover/movie", params, { ttlMs: SHELF_TTL_MS });
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
  const data = await tmdbGet<{ results: MovieSearchResult[] }>("/discover/movie", toDiscoverParams(q, "movie"), {
    ttlMs: SHELF_TTL_MS,
  });
  return data.results ?? [];
}

export async function discoverTvBy(q: DiscoverQuery): Promise<TvSearchResult[]> {
  const data = await tmdbGet<{ results: TvSearchResult[] }>("/discover/tv", toDiscoverParams(q, "tv"), {
    ttlMs: SHELF_TTL_MS,
  });
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
  const data = await tmdbGet<{ results: TvSearchResult[] }>(`/tv/${tmdbId}/recommendations`, {}, { ttlMs: SHELF_TTL_MS });
  return data.results ?? [];
}

export async function getMovieRecommendations(tmdbId: number): Promise<MovieSearchResult[]> {
  const data = await tmdbGet<{ results: MovieSearchResult[] }>(`/movie/${tmdbId}/recommendations`, {}, {
    ttlMs: SHELF_TTL_MS,
  });
  return data.results ?? [];
}

// ---- Exact ID-based lookup, verified against TMDB's own community docs -----

export interface FindResults {
  movie_results: MovieSearchResult[];
  tv_results: TvSearchResult[];
}

// ---- Watch providers (streaming availability) -----------------------------
//
// TMDB fronts JustWatch's availability data on /watch/providers, per media
// type, broken down BY COUNTRY - a title on Netflix in one region can be on a
// different service, or nowhere, in another, so a region is part of the
// question rather than a detail. See lib/streaming/providers.ts for how one is
// chosen.
//
// Two things this endpoint does NOT return, which shapes everything built on
// it: there is no per-provider URL for the title (the `link` it gives is a
// TMDB/JustWatch page, not a Netflix or Apple TV one), and no app identifiers.
// Turning a provider into something tappable is therefore the registry's job
// in lib/streaming/registry.ts, not this module's.
//
// TMDB's terms require attribution to JustWatch wherever this data is used;
// the notice lives in components/About.tsx alongside the TMDB one.

export interface TmdbWatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  /** TMDB's own ordering hint within a region, lowest first. */
  display_priority?: number;
}

export interface TmdbWatchProviderRegion {
  /** JustWatch's page for this title and region. The only link TMDB supplies. */
  link?: string;
  /** Included with a subscription. */
  flatrate?: TmdbWatchProvider[];
  /** Free, no subscription. */
  free?: TmdbWatchProvider[];
  /** Free with advertising. */
  ads?: TmdbWatchProvider[];
  rent?: TmdbWatchProvider[];
  buy?: TmdbWatchProvider[];
}

export interface TmdbWatchProviderResponse {
  id: number;
  /** Keyed by ISO 3166-1 country code. */
  results: Record<string, TmdbWatchProviderRegion>;
}

/**
 * Raw availability for one title, every region TMDB has.
 *
 * Returns every region because that is what TMDB sends; the cache in
 * lib/streaming/providers.ts keeps only the one the user is in.
 */
export async function getWatchProviders(
  kind: "show" | "movie",
  tmdbId: number
): Promise<TmdbWatchProviderResponse> {
  const path = kind === "show" ? `/tv/${tmdbId}/watch/providers` : `/movie/${tmdbId}/watch/providers`;
  return tmdbGet<TmdbWatchProviderResponse>(path);
}

export interface TmdbWatchRegion {
  iso_3166_1: string;
  english_name: string;
  native_name?: string;
}

/**
 * Every region TMDB has availability data for, for the Settings picker.
 *
 * Fetched rather than hard-coded so the list cannot go stale, and because a
 * hand-written list of countries would be a much larger thing to maintain
 * than one request made on the one screen that needs it. Callers fall back to
 * a plain text entry if this fails - being unable to reach TMDB should not
 * stop someone typing "GB".
 */
export async function getWatchProviderRegions(): Promise<TmdbWatchRegion[]> {
  return storedList(
    "watch-regions",
    async () => (await tmdbGet<{ results: TmdbWatchRegion[] }>("/watch/providers/regions")).results ?? []
  );
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
export const TMDB_RELEASE_TYPE_THEATRICAL_LIMITED = 2;
export const TMDB_RELEASE_TYPE_THEATRICAL = 3;
export const TMDB_RELEASE_TYPE_DIGITAL = 4;

interface ReleaseDatesResponse {
  results: {
    iso_3166_1: string;
    release_dates: { type: number; release_date: string }[];
  }[];
}

/** The movie object with its typed dates appended, so one request answers both questions. */
interface MovieWithReleaseDates {
  release_date: string | null;
  release_dates?: ReleaseDatesResponse;
}

/**
 * Earliest theatrical and digital release dates for a movie, as YYYY-MM-DD.
 *
 * `region` is preferred but deliberately not required to match: if TMDB has
 * no entry for it, the earliest date of that type from ANY country is used
 * rather than returning nothing. A missing regional entry is a gap in TMDB's
 * data, not evidence the release isn't happening, and the same reasoning
 * already governs isAvailableToWatch() for episodes.
 *
 * The fallback is for a missing ENTRY, not a missing type within one. When
 * the region is listed, its list is the answer: a US entry with a theatrical
 * date and no digital one says the film is not out at home in the US yet,
 * and another country's digital date does not change that. Falling back per
 * type used to borrow exactly that date, which mislabelled films as "Digital
 * Release" on Home and could announce one as available to watch early.
 *
 * Theatrical is the wide release (type 3), or the limited one (type 2) when
 * that is the only cinema release listed. Both are a film playing in cinemas,
 * and a film that only ever opened limited was otherwise left with no
 * theatrical date at all.
 *
 * Fetched as the movie object with release_dates appended rather than from
 * /release_dates alone, so the same single request also returns TMDB's
 * current primary release_date. The primary date is what the untagged
 * fallback on Home lists a movie under, and it moves (a delay, a date brought
 * forward); re-reading it here is what keeps a refreshed movie from being
 * listed in the wrong month off the date stored when it was added.
 */
export async function getMovieReleaseDates(
  tmdbId: number,
  region = "US"
): Promise<{ primary: string | null; theatrical: string | null; digital: string | null }> {
  const movie = await tmdbGet<MovieWithReleaseDates>(`/movie/${tmdbId}`, { append_to_response: "release_dates" });
  const data: ReleaseDatesResponse = movie.release_dates ?? { results: [] };

  function earliest(type: number): string | null {
    const preferred = data.results.find((r) => r.iso_3166_1 === region);
    const pools = preferred ? [[preferred]] : [data.results];
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
    primary: movie.release_date || null,
    theatrical: earliest(TMDB_RELEASE_TYPE_THEATRICAL) ?? earliest(TMDB_RELEASE_TYPE_THEATRICAL_LIMITED),
    digital: earliest(TMDB_RELEASE_TYPE_DIGITAL),
  };
}
