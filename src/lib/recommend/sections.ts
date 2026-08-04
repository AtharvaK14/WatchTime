// Builds the For You page from a taste profile.
//
// Design rules this file follows, since "more rows" was the failure mode of
// the previous version:
//
//   - Every section must answer a question the others do not. A row that is
//     just "more recommendations" is cut.
//   - A title appears in at most ONE section. Sections are filled in priority
//     order and claim their items, so the page never shows the same poster
//     four times, which is what makes a recommendation page feel padded.
//   - Sections that come back empty are dropped entirely rather than rendered
//     as an empty shelf.
//   - Local sections cost nothing and never fail, so they are computed first
//     and always available even when TMDB is unreachable.

import { db, type Episode, type Movie, type Show, type WatchedEpisode } from "../../db";
import {
  discoverMoviesBy,
  discoverTvBy,
  getMovieGenres,
  getTvGenres,
  type DiscoverQuery,
  type MovieSearchResult,
  type TvSearchResult,
} from "../../tmdb";
import { buildTasteProfile, mergeGenreNames, type TasteProfile } from "./tasteProfile";

/** Items shown per rail. */
const ITEMS_PER_SECTION = 14;
/** Votes needed before a title is considered well enough known to judge. */
const ESTABLISHED_VOTE_COUNT = 200;
/** Hidden gems: highly rated but under this many votes. */
const GEM_MAX_VOTES = 900;
const GEM_MIN_VOTES = 40;
const GEM_MIN_RATING = 7.2;
/** Minimum rating for the "acclaimed" section. */
const ACCLAIMED_MIN_RATING = 7.8;

export interface SectionItem {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  posterPath: string | null;
  year: number | null;
  overview: string | null;
  /** Already in the library but unwatched. */
  inLibrary: boolean;
  /** Short marker rendered ON the poster (never below the title, which wraps). */
  note?: string;
}

export interface ForYouSection {
  id: string;
  title: string;
  subtitle?: string;
  items: SectionItem[];
}

export interface ForYouResult {
  profile: TasteProfile;
  sections: ForYouSection[];
  status: "ok" | "cold-start" | "offline";
  message?: string;
  /** True when TMDB could not be reached; local sections may still be present. */
  retrievalFailed: boolean;
}

/** Watched titles below which a taste profile is not worth acting on. */
export const MIN_SIGNALS_FOR_FOR_YOU = 3;

function key(kind: "show" | "movie", tmdbId: number): string {
  return `${kind}:${tmdbId}`;
}

function tvToItem(t: TvSearchResult): SectionItem {
  return {
    kind: "show",
    tmdbId: t.id,
    name: t.name,
    posterPath: t.poster_path,
    year: t.first_air_date ? Number(t.first_air_date.slice(0, 4)) || null : null,
    overview: t.overview ?? null,
    inLibrary: false,
  };
}

function movieToItem(m: MovieSearchResult): SectionItem {
  return {
    kind: "movie",
    tmdbId: m.id,
    name: m.title,
    posterPath: m.poster_path,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) || null : null,
    overview: m.overview ?? null,
    inLibrary: false,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Shared filter shape derived from the profile.
 *
 * Runtime is deliberately NOT applied to the general recommendation
 * sections. It is a genuine preference but a narrow one, and combined with
 * genre plus language it over-constrains discover to the point of returning
 * the same handful of titles every time. It stays available for callers that
 * want it (the mood path enforces runtime explicitly when asked).
 */
function baseQuery(profile: TasteProfile, genreIds: number[]): DiscoverQuery {
  return {
    genreIds,
    withoutGenreIds: profile.avoidedGenreIds,
    originalLanguages: profile.preferredLanguages.length > 0 ? profile.preferredLanguages : undefined,
    minVoteCount: ESTABLISHED_VOTE_COUNT,
  };
}

interface LibraryState {
  /** Watched, or started for shows. Never recommend. */
  seen: Set<string>;
  /** Owned but unwatched. Fine to recommend, flagged in the UI. */
  owned: Set<string>;
}

function libraryState(shows: Show[], movies: Movie[], watched: WatchedEpisode[]): LibraryState {
  const startedShowIds = new Set(watched.map((w) => w.showId));
  const seen = new Set<string>();
  const owned = new Set<string>();
  for (const s of shows) (startedShowIds.has(s.tmdbId) ? seen : owned).add(key("show", s.tmdbId));
  for (const m of movies) (m.watched ? seen : owned).add(key("movie", m.tmdbId));
  return { seen, owned };
}

/**
 * Shows where a later season aired that the user never started.
 *
 * Purely local, and genuinely not covered by Home: Home's lists only include
 * followed, unarchived shows, so a series you finished and archived drops off
 * the app entirely, and a new season of it is invisible. That is exactly the
 * case this catches.
 */
function newSeasonsSection(
  shows: Show[],
  watched: WatchedEpisode[],
  episodesByShow: Map<number, Episode[]>
): SectionItem[] {
  const watchedByShow = new Map<number, WatchedEpisode[]>();
  for (const w of watched) {
    const list = watchedByShow.get(w.showId);
    if (list) list.push(w);
    else watchedByShow.set(w.showId, [w]);
  }

  const stamp = today();
  const items: SectionItem[] = [];
  for (const show of shows) {
    const mine = watchedByShow.get(show.tmdbId);
    if (!mine || mine.length === 0) continue;
    const episodes = episodesByShow.get(show.tmdbId) ?? [];
    if (episodes.length === 0) continue;

    const maxWatchedSeason = Math.max(...mine.map((w) => w.seasonNumber));
    const watchedKeys = new Set(mine.map((w) => w.key));
    // A LATER season, already aired, with nothing watched in it. Requiring a
    // whole untouched season (rather than any unwatched episode) is what
    // keeps this distinct from Watch Next, which already handles being
    // mid-season.
    const laterSeasons = new Set(
      episodes
        .filter((e) => e.seasonNumber > maxWatchedSeason && e.airDate !== null && e.airDate <= stamp)
        .map((e) => e.seasonNumber)
    );
    const fresh = [...laterSeasons].filter((season) =>
      episodes.filter((e) => e.seasonNumber === season).every((e) => !watchedKeys.has(e.key))
    );
    if (fresh.length === 0) continue;

    const earliest = Math.min(...fresh);
    items.push({
      kind: "show",
      tmdbId: show.tmdbId,
      name: show.name,
      posterPath: show.posterPath,
      year: show.firstAirYear,
      overview: show.overview ?? null,
      inLibrary: true,
      note: `Season ${earliest}`,
    });
  }
  return items;
}

// A "Shows you started and left" section was removed here rather than kept.
// It could not be told apart from "New seasons you've missed" in one glance,
// and more importantly it duplicated Home's "Haven't Watched For a While"
// tab, which is the same query with a shorter threshold. Adding a second
// place to see the same list is the padding this page was meant to avoid.
/**
 * Builds the whole page.
 *
 * Network sections are issued in parallel and settled individually, so a rate
 * limit costs one shelf rather than the page.
 */
export async function buildForYouSections(): Promise<ForYouResult> {
  const [shows, movies, watchedEpisodes, allEpisodes] = await Promise.all([
    db.shows.toArray(),
    db.movies.toArray(),
    db.watchedEpisodes.toArray(),
    db.episodes.toArray(),
  ]);

  const episodesByShow = new Map<number, Episode[]>();
  for (const ep of allEpisodes) {
    const list = episodesByShow.get(ep.showId);
    if (list) list.push(ep);
    else episodesByShow.set(ep.showId, [ep]);
  }

  // Genre names come from TMDB but are tiny and highly cacheable; a failure
  // here degrades to numeric labels rather than blocking the profile.
  let genreNames = new Map<number, string>();
  try {
    const [tv, movie] = await Promise.all([getTvGenres(), getMovieGenres()]);
    genreNames = mergeGenreNames(tv, movie);
  } catch {
    genreNames = new Map();
  }

  const profile = buildTasteProfile(shows, movies, watchedEpisodes, episodesByShow, genreNames);

  if (profile.signalCount < MIN_SIGNALS_FOR_FOR_YOU) {
    return {
      profile,
      sections: [],
      status: "cold-start",
      retrievalFailed: false,
      message:
        `Watch a few more things and this page fills in. It needs at least ` +
        `${MIN_SIGNALS_FOR_FOR_YOU} titles with real watch history to work out what you like.`,
    };
  }

  const library = libraryState(shows, movies, watchedEpisodes);
  const genres = profile.favouriteGenreIds;
  const recent = profile.recentGenreIds.length > 0 ? profile.recentGenreIds : genres;
  const topGenre = profile.genres.find((g) => genres.includes(g.genreId));

  // Local sections first: free, instant, and unaffected by TMDB being down.
  const localNewSeasons = newSeasonsSection(shows, watchedEpisodes, episodesByShow);

  const requests: { id: string; title: string; subtitle?: string; run: () => Promise<SectionItem[]> }[] = [
    {
      id: "shows-for-you",
      title: "Shows we think you'll like",
      subtitle: topGenre ? `Weighted toward ${topGenre.name.toLowerCase()} and what you've finished` : undefined,
      run: async () => (await discoverTvBy(baseQuery(profile, genres))).map(tvToItem),
    },
    {
      id: "movies-for-you",
      title: "Movies we think you'll like",
      subtitle: topGenre ? `Weighted toward ${topGenre.name.toLowerCase()} and what you've finished` : undefined,
      run: async () => (await discoverMoviesBy(baseQuery(profile, genres))).map(movieToItem),
    },
    {
      id: "recent-taste",
      title: "Based on what you've watched lately",
      subtitle: "Weighted to the last few months rather than your whole history",
      run: async () =>
        (await discoverMoviesBy({ ...baseQuery(profile, recent), sortBy: "vote_average.desc", minRating: 7 })).map(
          movieToItem
        ),
    },
    {
      id: "acclaimed",
      title: "Acclaimed and unwatched",
      subtitle: "Highly rated titles in the genres you watch most",
      run: async () =>
        (
          await discoverTvBy({
            ...baseQuery(profile, genres),
            minRating: ACCLAIMED_MIN_RATING,
            sortBy: "vote_average.desc",
            minVoteCount: ESTABLISHED_VOTE_COUNT,
          })
        ).map(tvToItem),
    },
    {
      id: "hidden-gems",
      title: "Hidden gems for your taste",
      subtitle: "Well reviewed, not widely seen",
      run: async () =>
        (
          await discoverMoviesBy({
            ...baseQuery(profile, genres),
            minRating: GEM_MIN_RATING,
            minVoteCount: GEM_MIN_VOTES,
            maxVoteCount: GEM_MAX_VOTES,
            sortBy: "vote_average.desc",
          })
        ).map(movieToItem),
    },
    {
      id: "coming-soon",
      title: "Coming soon you'll probably like",
      subtitle: "Releasing in the next few months in your genres",
      run: async () =>
        (
          await discoverMoviesBy({
            genreIds: genres,
            withoutGenreIds: profile.avoidedGenreIds,
            releasedAfter: today(),
            releasedBefore: daysFromNow(180),
            sortBy: "popularity.desc",
          })
        ).map(movieToItem),
    },
  ];

  const settled = await Promise.allSettled(requests.map((r) => r.run()));
  const retrievalFailed = settled.every((s) => s.status === "rejected");

  // Priority order. Local, personal sections lead: they are about the user's
  // own library, which is more useful and more trustworthy than anything
  // retrieved, and they are the sections that survive TMDB being down.
  const ordered: ForYouSection[] = [
    {
      id: "new-seasons",
      // "Shows you've watched that came back" read as "this show is airing
      // right now", which is not what this detects: the season has already
      // finished airing and is sitting there unwatched. "Already out" is the
      // load-bearing phrase.
      title: "New seasons you've missed",
      subtitle: "Already out, and you haven't started them",
      items: localNewSeasons,
    },
    ...requests.map((r, i) => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      items: settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<SectionItem[]>).value : [],
    })),
  ];

  // One appearance per title, claimed by the highest-priority section.
  const claimed = new Set<string>();
  const sections = ordered
    .map((section) => ({
      ...section,
      items: section.items
        .filter((item) => {
          const k = key(item.kind, item.tmdbId);
          if (library.seen.has(k)) return item.inLibrary; // local sections are about owned titles
          if (claimed.has(k)) return false;
          claimed.add(k);
          return true;
        })
        .map((item) => ({ ...item, inLibrary: item.inLibrary || library.owned.has(key(item.kind, item.tmdbId)) }))
        .slice(0, ITEMS_PER_SECTION),
    }))
    .filter((section) => section.items.length > 0);

  return {
    profile,
    sections,
    status: retrievalFailed && sections.length === 0 ? "offline" : "ok",
    retrievalFailed,
    message: retrievalFailed
      ? "Couldn't reach TMDB, so only sections built from your own library are shown."
      : undefined,
  };
}
