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
import UniversalSearch, { type SearchResults } from "../components/UniversalSearch";
import { ShowGridSkeleton } from "../components/Skeleton";
import SearchResultsGrid from "../components/SearchResultsGrid";
import { useFullRows } from "../lib/useFullRows";

/**
 * Upper bound on how many titles each Discover grid requests.
 *
 * The grids trim this down to a whole number of rows at the width they
 * actually render at (see useFullRows), so this only caps how much is
 * available to fill those rows — it is not the number displayed. Twelve keeps
 * three full rows on a phone and two on a typical desktop.
 */
const DISCOVER_ROW_COUNT = 12;

function ShowRow({ items, onOpen }: { items: TvSearchResult[]; onOpen: (id: number) => void }) {
  const [gridRef, visible] = useFullRows(items.length);
  return (
    <div className="show-grid" ref={gridRef}>
      {items.slice(0, visible).map((r) => (
        <button key={r.id} className="show-card" onClick={() => onOpen(r.id)}>
          {/* .show-card-media is what clips the poster corners and carries
              the inset hairline and press state; without it these cards
              render differently from the identical grids on Shows/Movies. */}
          <div className="show-card-media">
            {r.poster_path ? (
              <img src={`${TMDB_IMAGE_BASE}${r.poster_path}`} alt={r.name} loading="lazy" decoding="async" />
            ) : (
              <div className="poster-placeholder" />
            )}
            <div className="show-card-body">
              <p className="show-name">{r.name}</p>
              <p className="show-card-meta">{r.first_air_date?.slice(0, 4) ?? "?"}</p>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function MovieRow({ items, onOpen }: { items: MovieSearchResult[]; onOpen: (id: number) => void }) {
  const [gridRef, visible] = useFullRows(items.length);
  return (
    <div className="show-grid" ref={gridRef}>
      {items.slice(0, visible).map((r) => (
        <button key={r.id} className="show-card" onClick={() => onOpen(r.id)}>
          <div className="show-card-media">
            {r.poster_path ? (
              <img src={`${TMDB_IMAGE_BASE}${r.poster_path}`} alt={r.title} loading="lazy" decoding="async" />
            ) : (
              <div className="poster-placeholder" />
            )}
            <div className="show-card-body">
              <p className="show-name">{r.title}</p>
              <p className="show-card-meta">{r.release_date?.slice(0, 4) ?? "?"}</p>
            </div>
          </div>
        </button>
      ))}
    </div>
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
      <h2>Discover</h2>

      <UniversalSearch
        onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })}
        onResults={setResults}
        onClear={() => setResults(null)}
      />

      {!hasApiKey() && <p className="status-error">Add your TMDB API key on the Settings page to search or browse.</p>}

      {searching ? (
        <SearchResultsGrid results={results} onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })} />
      ) : (
        hasApiKey() && (
          <div className="discover-sections">
            {discoverError && <p className="status-error">Couldn't load suggestions: {discoverError}</p>}

            {/* Personalised recommendations now live on their own For You
                tab; this page is search plus the same-for-everyone rails.

                Trending covers two separate grids, so each gets its own
                label — unlabelled they read as one list that inexplicably
                switches from shows to films partway down. */}
            <h3 className="section-title">Trending this week</h3>

            <p className="discover-subhead">TV shows</p>
            {!popularShows ? (
              <ShowGridSkeleton count={DISCOVER_ROW_COUNT} />
            ) : (
              <ShowRow
                items={popularShows.slice(0, DISCOVER_ROW_COUNT)}
                onOpen={(id) => setOpenDetails({ kind: "show", tmdbId: id })}
              />
            )}

            <p className="discover-subhead">Movies</p>
            {!popularMovies ? (
              <ShowGridSkeleton count={DISCOVER_ROW_COUNT} />
            ) : (
              <MovieRow
                items={popularMovies.slice(0, DISCOVER_ROW_COUNT)}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h3 className="section-title">Upcoming movies</h3>
            {!upcomingMovies ? (
              <ShowGridSkeleton count={DISCOVER_ROW_COUNT} />
            ) : (
              <MovieRow
                items={upcomingMovies.slice(0, DISCOVER_ROW_COUNT)}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h3 className="section-title">Recently available at home</h3>
            <p className="muted small">
              TMDB's closest match to Rotten Tomatoes' "movies at home" list: recent US digital releases. Not the
              same curation, an approximation built from TMDB's own release-type data.
            </p>
            {!atHomeMovies ? (
              <ShowGridSkeleton count={DISCOVER_ROW_COUNT} />
            ) : atHomeMovies.length === 0 ? (
              <p className="muted small">Nothing found in the last 45 days.</p>
            ) : (
              <MovieRow
                items={atHomeMovies.slice(0, DISCOVER_ROW_COUNT)}
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
