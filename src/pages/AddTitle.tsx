import { useEffect, useState } from "react";
import {
  searchTvShow,
  searchMovie,
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
import MoodDiscover from "../components/MoodDiscover";

function ShowRow({ items, onOpen }: { items: TvSearchResult[]; onOpen: (id: number) => void }) {
  return (
    <div className="show-grid">
      {items.map((r) => (
        <button key={r.id} className="show-card" onClick={() => onOpen(r.id)}>
          {r.poster_path ? (
            <img src={`${TMDB_IMAGE_BASE}${r.poster_path}`} alt={r.name} />
          ) : (
            <div className="poster-placeholder" />
          )}
          <div className="show-card-body">
            <p className="show-name">{r.name}</p>
            <p className="muted small">{r.first_air_date?.slice(0, 4) ?? "?"}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

function MovieRow({ items, onOpen }: { items: MovieSearchResult[]; onOpen: (id: number) => void }) {
  return (
    <div className="show-grid">
      {items.map((r) => (
        <button key={r.id} className="show-card" onClick={() => onOpen(r.id)}>
          {r.poster_path ? (
            <img src={`${TMDB_IMAGE_BASE}${r.poster_path}`} alt={r.title} />
          ) : (
            <div className="poster-placeholder" />
          )}
          <div className="show-card-body">
            <p className="show-name">{r.title}</p>
            <p className="muted small">{r.release_date?.slice(0, 4) ?? "?"}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

export default function AddTitle() {
  const [query, setQuery] = useState("");
  const [showResults, setShowResults] = useState<TvSearchResult[]>([]);
  const [movieResults, setMovieResults] = useState<MovieSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [openDetails, setOpenDetails] = useState<{ kind: "show" | "movie"; tmdbId: number } | null>(null);

  const [popularShows, setPopularShows] = useState<TvSearchResult[] | null>(null);
  const [popularMovies, setPopularMovies] = useState<MovieSearchResult[] | null>(null);
  const [upcomingMovies, setUpcomingMovies] = useState<MovieSearchResult[] | null>(null);
  const [atHomeMovies, setAtHomeMovies] = useState<MovieSearchResult[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const hasSearched = query.trim().length > 0;

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

  // Debounced live search: fires 300ms after the user stops typing, not on
  // every keystroke, and both TV/movie searches run in parallel rather
  // than needing a Show/Movie toggle to pick which one to search.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setShowResults([]);
      setMovieResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const [shows, movies] = await Promise.all([searchTvShow(trimmed), searchMovie(trimmed)]);
        if (cancelled) return;
        setShowResults(shows);
        setMovieResults(movies);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  return (
    <div className="panel">
      <h2>Discover</h2>

      <MoodDiscover onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })} />

      <h3 className="section-title">Search by title</h3>
      <div className="field-row">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a show or movie..."
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>

      {!hasApiKey() && <p className="status-error">Add your TMDB API key on the Settings page to search or browse.</p>}

      {hasSearched ? (
        <>
          {searching && <p className="muted small">Searching...</p>}
          {!searching && showResults.length === 0 && movieResults.length === 0 && (
            <p className="muted">No results for "{query.trim()}".</p>
          )}
          {showResults.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>TV Shows</h3>
              <ShowRow items={showResults} onOpen={(id) => setOpenDetails({ kind: "show", tmdbId: id })} />
            </>
          )}
          {movieResults.length > 0 && (
            <>
              <h3 style={{ marginTop: 20 }}>Movies</h3>
              <MovieRow items={movieResults} onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })} />
            </>
          )}
        </>
      ) : (
        hasApiKey() && (
          <div className="discover-sections">
            {discoverError && <p className="status-error">Couldn't load suggestions: {discoverError}</p>}

            <h3>Trending TV shows this week</h3>
            {!popularShows ? (
              <p className="muted small">Loading...</p>
            ) : (
              <ShowRow items={popularShows.slice(0, 10)} onOpen={(id) => setOpenDetails({ kind: "show", tmdbId: id })} />
            )}

            <h3 style={{ marginTop: 20 }}>Trending movies this week</h3>
            {!popularMovies ? (
              <p className="muted small">Loading...</p>
            ) : (
              <MovieRow
                items={popularMovies.slice(0, 10)}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h3 style={{ marginTop: 20 }}>Upcoming movies</h3>
            {!upcomingMovies ? (
              <p className="muted small">Loading...</p>
            ) : (
              <MovieRow
                items={upcomingMovies.slice(0, 10)}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h3 style={{ marginTop: 20 }}>Recently available at home</h3>
            <p className="muted small">
              TMDB's closest match to Rotten Tomatoes' "movies at home" list: recent US digital releases. Not the
              same curation, an approximation built from TMDB's own release-type data.
            </p>
            {!atHomeMovies ? (
              <p className="muted small">Loading...</p>
            ) : atHomeMovies.length === 0 ? (
              <p className="muted small">Nothing found in the last 45 days.</p>
            ) : (
              <MovieRow
                items={atHomeMovies.slice(0, 10)}
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
