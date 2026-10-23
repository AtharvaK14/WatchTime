import { useEffect, useState } from "react";
import {
  getPopularTvShows,
  getPopularMovies,
  getUpcomingMovies,
  getRecentlyAvailableAtHome,
  TMDB_IMAGE_BASE,
  hasApiKey,
  type TvSearchResult,
  type MovieSearchResult,
} from "../tmdb";
import DetailsPanel from "../components/DetailsPanel";
import PosterCaption from "../components/PosterCaption";
import UniversalSearch, { type SearchResults } from "../components/UniversalSearch";
import { BookmarkIcon } from "../components/icons";
import { useLibraryIds } from "../lib/useLibraryIds";
import { libraryKey, removalClass, useLibraryRemovals } from "../lib/libraryRemoval";
import { useMovieWatchedPhases, watchedClass } from "../lib/movieWatched";
import MovieWatchedOverlay from "../components/MovieWatchedOverlay";

/**
 * "Already in your library", shown directly on the artwork so the user no
 * longer has to open a title to find out.
 *
 * A BOOKMARK, not a tick. The first version of this was a tick in a filled
 * accent circle, which was a mistake: a tick on a poster already means WATCHED
 * in this app (.watched-badge on the Movies grid, .watch-toggle on an episode
 * row), so the same mark was carrying two unrelated facts and the badge read
 * as "you have seen this". A bookmark says saved-not-consumed and cannot be
 * confused with either the watched state or the Mark as Watched control.
 *
 * A mark rather than a worded pill because at three cards per row on a phone
 * an "IN LIBRARY" label either covers the poster or is too small to read; the
 * word still reaches screen readers from the .sr-only text each caller
 * renders. Top-RIGHT, leaving the top-left to .card-kind so the two can never
 * collide.
 */
function InLibraryBadge() {
  return (
    <span className="card-in-library" aria-hidden="true">
      <BookmarkIcon size={13} />
    </span>
  );
}

/** "2026-03-14" -> 2026. Null for a missing or empty TMDB date. */
function yearOf(date: string | null | undefined): number | null {
  return Number(date?.slice(0, 4)) || null;
}

/**
 * One Discover card. Every grid on this page — the rails and both kinds of
 * search result — renders through this, so they cannot drift apart.
 *
 * The same card the Shows and Movies grids use (artwork, and PosterCaption's
 * year-over-title in the bottom-left corner), plus the two markers only
 * Discover needs: the library bookmark, and the TV/Film tag wherever a grid
 * mixes the two. No watched control: marking something watched happens in the
 * details panel the card opens.
 */
function TitleCard({
  kind,
  tmdbId,
  name,
  year,
  posterPath,
  kindTag,
  inLibrary,
  onOpen,
}: {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  year: number | null;
  posterPath: string | null;
  /** "TV" or "Film", only where the grid's heading does not already say which. */
  kindTag?: "TV" | "Film";
  inLibrary: boolean;
  onOpen: () => void;
}) {
  // These grids are TMDB's, not the library's, so a removed title's card
  // stays where it is: only the bookmark goes. The highlight is what says
  // which card that happened to once the panel has closed. Only the highlight
  // phase applies here - "held" and "exit" are for cards leaving a library list.
  const removal = useLibraryRemovals().get(libraryKey(kind, tmdbId));
  // Same reasoning for a movie marked watched in that panel: the card stays,
  // and shows the watched tick once the panel has closed, so the user can see
  // which card it happened to. Only ever set for movies.
  const watched = useMovieWatchedPhases().get(libraryKey(kind, tmdbId));
  return (
    <button
      className={`show-card${removal === "highlight" ? removalClass(removal) : ""}${watchedClass(watched, true)}`}
      onClick={onOpen}
    >
      {posterPath ? (
        <img src={`${TMDB_IMAGE_BASE}${posterPath}`} alt={name} />
      ) : (
        <div className="poster-placeholder" />
      )}
      {/* Sits on the artwork rather than in .show-card-body, because that
          caption is hidden until hover on pointer:fine devices — a type
          label there would be invisible at rest on desktop. */}
      {kindTag && <span className="card-kind">{kindTag}</span>}
      {inLibrary && <InLibraryBadge />}
      <PosterCaption title={name} year={year} />
      {inLibrary && <span className="sr-only">In your library</span>}
      <MovieWatchedOverlay phase={watched} staying />
    </button>
  );
}

function ShowRow({
  items,
  onOpen,
  inLibrary,
  showTypeTag = false,
}: {
  items: TvSearchResult[];
  onOpen: (id: number) => void;
  inLibrary: Set<number>;
  /** Only true in sections whose own heading does not already say what these are. */
  showTypeTag?: boolean;
}) {
  return (
    <div className="show-grid">
      {items.map((r) => (
        <TitleCard
          key={r.id}
          kind="show"
          tmdbId={r.id}
          name={r.name}
          year={yearOf(r.first_air_date)}
          posterPath={r.poster_path}
          kindTag={showTypeTag ? "TV" : undefined}
          inLibrary={inLibrary.has(r.id)}
          onOpen={() => onOpen(r.id)}
        />
      ))}
    </div>
  );
}

function MovieRow({
  items,
  onOpen,
  inLibrary,
  showTypeTag = false,
}: {
  items: MovieSearchResult[];
  onOpen: (id: number) => void;
  inLibrary: Set<number>;
  showTypeTag?: boolean;
}) {
  return (
    <div className="show-grid">
      {items.map((r) => (
        <TitleCard
          key={r.id}
          kind="movie"
          tmdbId={r.id}
          name={r.title}
          year={yearOf(r.release_date)}
          posterPath={r.poster_path}
          kindTag={showTypeTag ? "Film" : undefined}
          inLibrary={inLibrary.has(r.id)}
          onOpen={() => onOpen(r.id)}
        />
      ))}
    </div>
  );
}

/** Search results: exact title matches, plus mood matches when the query described one. */
function Results({
  results,
  onOpen,
  library,
}: {
  results: SearchResults;
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
  library: { shows: Set<number>; movies: Set<number> };
}) {
  const nothing = results.titles.length === 0 && results.mood.length === 0;
  const owned = (kind: "show" | "movie", tmdbId: number) =>
    (kind === "show" ? library.shows : library.movies).has(tmdbId);
  // Search mixes shows and films under one heading, so every result carries
  // the type, exactly as Trending does. It used to be written into the caption
  // ("TV · 2024"); it is the tag on the artwork now, which leaves the caption
  // to the year and title every other card shows and keeps the type visible at
  // rest on desktop, where the caption only appears on hover.
  const kindTag = (kind: "show" | "movie") => (kind === "show" ? "TV" : "Film");
  return (
    <>
      {results.titles.length > 0 && (
        <>
          <h2 className="section-title">Titles</h2>
          <div className="show-grid">
            {results.titles.map((t) => (
              <TitleCard
                key={`${t.kind}:${t.tmdbId}`}
                kind={t.kind}
                tmdbId={t.tmdbId}
                name={t.name}
                year={t.year}
                posterPath={t.posterPath}
                kindTag={kindTag(t.kind)}
                inLibrary={owned(t.kind, t.tmdbId)}
                onOpen={() => onOpen(t.kind, t.tmdbId)}
              />
            ))}
          </div>
        </>
      )}

      {results.moodAttempted && (
        <>
          <h2 className="section-title">Matching your description</h2>
          {results.moodMessage && <p className="muted small">{results.moodMessage}</p>}
          {results.mood.length === 0 && !results.moodMessage && (
            <p className="muted small">Still looking...</p>
          )}
          {results.mood.length > 0 && (
            <div className="show-grid">
              {results.mood.map((m) => (
                <TitleCard
                  key={`${m.kind}:${m.tmdbId}`}
                  kind={m.kind}
                  tmdbId={m.tmdbId}
                  name={m.name}
                  year={m.year}
                  posterPath={m.posterPath}
                  kindTag={kindTag(m.kind)}
                  // The live sets alone, not m.inLibrary as well. That is the
                  // search index's answer from when the search ran, and OR-ing
                  // it in kept a title removed through the panel this page
                  // opens on top of itself marked as owned until the next search.
                  inLibrary={owned(m.kind, m.tmdbId)}
                  onOpen={() => onOpen(m.kind, m.tmdbId)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {nothing && !results.moodAttempted && <p className="muted">No results for "{results.query}".</p>}
    </>
  );
}

export default function AddTitle() {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [openDetails, setOpenDetails] = useState<{ kind: "show" | "movie"; tmdbId: number } | null>(null);

  const [popularShows, setPopularShows] = useState<TvSearchResult[] | null>(null);
  const [popularMovies, setPopularMovies] = useState<MovieSearchResult[] | null>(null);
  const [upcomingMovies, setUpcomingMovies] = useState<MovieSearchResult[] | null>(null);
  const [atHomeMovies, setAtHomeMovies] = useState<MovieSearchResult[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const library = useLibraryIds();

  useEffect(() => {
    if (!hasApiKey()) return;
    let cancelled = false;
    async function loadDiscovery() {
      try {
        const [pop_s, pop_m, up_m, home_m] = await Promise.all([
          getPopularTvShows(),
          getPopularMovies(),
          getUpcomingMovies(),
          getRecentlyAvailableAtHome(),
        ]);
        if (cancelled) return;
        setPopularShows(pop_s);
        setPopularMovies(pop_m);
        setUpcomingMovies(up_m);
        setAtHomeMovies(home_m);
      } catch (e) {
        if (!cancelled) setDiscoverError(e instanceof Error ? e.message : String(e));
      }
    }
    loadDiscovery();
    return () => {
      cancelled = true;
    };
  }, []);

  const searching = results !== null;

  return (
    <div className="panel">
      <h1 className="sr-only">Discover</h1>

      <UniversalSearch
        onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })}
        onResults={setResults}
        onClear={() => setResults(null)}
      />

      {!hasApiKey() && <p className="status-error">Add your TMDB API key on the Settings page to search or browse.</p>}

      {searching ? (
        <Results
          results={results}
          library={library}
          onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })}
        />
      ) : (
        hasApiKey() && (
          <div className="discover-sections">
            {discoverError && <p className="status-error">Couldn't load suggestions: {discoverError}</p>}

            {/* Personalised recommendations now live on their own For You
                tab; this page is search plus the same-for-everyone rails.

                Trending is the ONLY rail that carries the TV/Film tag. It
                renders a grid of shows immediately followed by a grid of
                movies under a single heading, so without a per-card marker
                the two read as one continuous wall of posters. Every rail
                below it is single-type and its heading already says so; a tag
                repeating that on every card is clutter, not context. */}
            <h2 className="section-title">Trending this week</h2>
            {!popularShows ? (
              <p className="muted small">Loading...</p>
            ) : (
              <ShowRow
                items={popularShows.slice(0, 10)}
                inLibrary={library.shows}
                showTypeTag
                onOpen={(id) => setOpenDetails({ kind: "show", tmdbId: id })}
              />
            )}

            {!popularMovies ? (
              <p className="muted small">Loading...</p>
            ) : (
              <MovieRow
                items={popularMovies.slice(0, 10)}
                inLibrary={library.movies}
                showTypeTag
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h2 className="section-title">Upcoming movies</h2>
            {!upcomingMovies ? (
              <p className="muted small">Loading...</p>
            ) : (
              <MovieRow
                items={upcomingMovies.slice(0, 10)}
                inLibrary={library.movies}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h2 className="section-title">Recently available at home</h2>
            {!atHomeMovies ? (
              <p className="muted small">Loading...</p>
            ) : atHomeMovies.length === 0 ? (
              <p className="muted small">Nothing found in the last 45 days.</p>
            ) : (
              <MovieRow
                items={atHomeMovies.slice(0, 10)}
                inLibrary={library.movies}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}
          </div>
        )
      )}

      {openDetails && (
        <DetailsPanel kind={openDetails.kind} tmdbId={openDetails.tmdbId} onClose={() => setOpenDetails(null)} />
      )}
    </div>
  );
}
