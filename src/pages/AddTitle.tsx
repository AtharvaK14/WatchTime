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

/** Search results: exact title matches, plus mood matches when the query described one. */
function Results({
  results,
  onOpen,
}: {
  results: SearchResults;
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
}) {
  const nothing = results.titles.length === 0 && results.mood.length === 0;
  return (
    <>
      {results.titles.length > 0 && (
        <>
          <h3 className="section-title">Titles</h3>
          <div className="show-grid">
            {results.titles.map((t) => (
              <button
                key={`${t.kind}:${t.tmdbId}`}
                className="show-card"
                onClick={() => onOpen(t.kind, t.tmdbId)}
              >
                {t.posterPath ? (
                  <img src={`${TMDB_IMAGE_BASE}${t.posterPath}`} alt={t.name} />
                ) : (
                  <div className="poster-placeholder" />
                )}
                <div className="show-card-body">
                  <p className="show-name">{t.name}</p>
                  <p className="muted small">
                    {t.kind === "show" ? "TV" : "Film"}
                    {t.year ? ` · ${t.year}` : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {results.moodAttempted && (
        <>
          <h3 className="section-title">Matching your description</h3>
          {results.moodMessage && <p className="muted small">{results.moodMessage}</p>}
          {results.mood.length === 0 && !results.moodMessage && (
            <p className="muted small">Still looking...</p>
          )}
          {results.mood.length > 0 && (
            <div className="show-grid">
              {results.mood.map((m) => (
                <button
                  key={`${m.kind}:${m.tmdbId}`}
                  className="show-card"
                  onClick={() => onOpen(m.kind, m.tmdbId)}
                >
                  {m.posterPath ? (
                    <img src={`${TMDB_IMAGE_BASE}${m.posterPath}`} alt={m.name} />
                  ) : (
                    <div className="poster-placeholder" />
                  )}
                  <div className="show-card-body">
                    <p className="show-name">{m.name}</p>
                    <p className="muted small">
                      {m.kind === "show" ? "TV" : "Film"}
                      {m.year ? ` · ${m.year}` : ""}
                    </p>
                    {m.inLibrary && <span className="rail-badge">In your library</span>}
                  </div>
                </button>
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
        <Results results={results} onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })} />
      ) : (
        hasApiKey() && (
          <div className="discover-sections">
            {discoverError && <p className="status-error">Couldn't load suggestions: {discoverError}</p>}

            {/* Personalised recommendations now live on their own For You
                tab; this page is search plus the same-for-everyone rails. */}
            <h3 className="section-title">Trending this week</h3>
            {!popularShows ? (
              <p className="muted small">Loading...</p>
            ) : (
              <ShowRow items={popularShows.slice(0, 10)} onOpen={(id) => setOpenDetails({ kind: "show", tmdbId: id })} />
            )}

            {!popularMovies ? (
              <p className="muted small">Loading...</p>
            ) : (
              <MovieRow
                items={popularMovies.slice(0, 10)}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h3 className="section-title">Upcoming movies</h3>
            {!upcomingMovies ? (
              <p className="muted small">Loading...</p>
            ) : (
              <MovieRow
                items={upcomingMovies.slice(0, 10)}
                onOpen={(id) => setOpenDetails({ kind: "movie", tmdbId: id })}
              />
            )}

            <h3 className="section-title">Recently available at home</h3>
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
