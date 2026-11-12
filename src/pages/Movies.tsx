import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Movie } from "../db";
import { TMDB_IMAGE_BASE, getMovieGenres, type Genre } from "../tmdb";
import { useMovieStats } from "../lib/stats";
import StatTiles, { DurationValue } from "../components/StatTiles";
import { libraryKey, removalClass, useRemovalExit, type RemovalPhase } from "../lib/libraryRemoval";
import {
  markMovieWatchedFromCard,
  useMovieWatchedExit,
  watchedClass,
  type MovieWatchedPhase,
  type WatchedSlot,
} from "../lib/movieWatched";
import { isOnWatchlist } from "../lib/watchlist";
import { useFlipLayout } from "../lib/useFlipLayout";
import DetailsPanel from "../components/DetailsPanel";
import MovieWatchedOverlay from "../components/MovieWatchedOverlay";
import PosterCaption from "../components/PosterCaption";
import RatingChip from "../components/RatingChip";
import { useRatingBackfill } from "../lib/ratings";
import SearchFilterDock from "../components/SearchFilterDock";
import FilterSheet, { FilterGroup } from "../components/FilterSheet";
import SegmentedControl from "../components/SegmentedControl";
import GenreChips from "../components/GenreChips";
import { useIsMobile } from "../lib/useIsMobile";
import { openMovieViewingMenu, titleQuickActionProps } from "../lib/titleQuickActions";
import { movieWatchCount, viewingsInWords } from "../lib/watchHistory";
import WatchMark from "../components/WatchMark";
import { searchOrBrowse } from "../lib/librarySearch";
import { MovieStatsDialog } from "../components/StatsDialog";
import { PosterGridSkeleton } from "../components/Skeleton";

type SortKey = "title" | "releaseYear" | "recentlyWatched" | "recentlyAdded" | "rating";
type FilterKey = "all" | "watched" | "wantToWatch";

const STATUS_OPTIONS: { value: FilterKey; label: string }[] = [
  { value: "all", label: "All" },
  { value: "watched", label: "Watched" },
  { value: "wantToWatch", label: "Want to watch" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "title", label: "Title (A-Z)" },
  { value: "releaseYear", label: "Release year" },
  { value: "recentlyWatched", label: "Recently watched" },
  { value: "recentlyAdded", label: "Recently added" },
];

const movieKey = (movie: Movie) => libraryKey("movie", movie.tmdbId);
const movieSlotKey = (slot: WatchedSlot<Movie>) => movieKey(slot.item);

export default function Movies({
  initialFilter,
  onInitialFilterConsumed,
}: {
  initialFilter?: FilterKey | null;
  onInitialFilterConsumed?: () => void;
}) {
  const movies = useLiveQuery(() => db.movies.toArray(), []);
  const isMobile = useIsMobile();
  const [openDetails, setOpenDetails] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // Defaults: the watchlist, newest first. A movie library is mostly a queue
  // of things not yet seen, so "what could I put on tonight" is the question
  // this page opens on; the watched back-catalogue is one tap away under
  // Watch status. Recently added is also what Home's "View all" rail shows,
  // so arriving from there no longer reorders the grid under the user.
  const [sortKey, setSortKey] = useState<SortKey>("recentlyAdded");
  const [filterKey, setFilterKey] = useState<FilterKey>("wantToWatch");
  const [genreFilter, setGenreFilter] = useState<number | null>(null);
  // Any filter off its default: Reset is offered, and the dock's filter button carries a dot.
  const filtersChanged = filterKey !== "wantToWatch" || genreFilter !== null || sortKey !== "recentlyAdded";
  const [genres, setGenres] = useState<Genre[]>([]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

  // One-shot: applies the filter Home's "View all" link requested, then
  // tells App.tsx it's been consumed so navigating back here later
  // (e.g. via the tab bar) doesn't keep forcing the same filter.
  useEffect(() => {
    if (initialFilter) {
      setFilterKey(initialFilter);
      onInitialFilterConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilter]);

  const stats = useMovieStats();

  useEffect(() => {
    getMovieGenres().then(setGenres).catch(() => setGenres([]));
  }, []);

  const { visible, searching } = useMemo(() => {
    if (!movies) return { visible: [], searching: false };

    // The browsing filters, which a search sets aside rather than narrowing
    // (see lib/librarySearch.ts): a watched movie is found by name even on
    // the Want to watch filter, and the filter is still selected afterwards.
    const browse = (m: Movie) => {
      if (filterKey === "watched" && !m.watched) return false;
      if (filterKey === "wantToWatch" && !isOnWatchlist(m)) return false;
      if (genreFilter !== null && !m.genreIds?.includes(genreFilter)) return false;
      return true;
    };
    const { items: list, searching } = searchOrBrowse(movies, query, (m) => m.title, browse);

    const sorted = [...list];
    switch (sortKey) {
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "releaseYear":
        sorted.sort((a, b) => (b.releaseYear ?? 0) - (a.releaseYear ?? 0));
        break;
      case "recentlyWatched":
        sorted.sort((a, b) => (b.watchedAt ?? "").localeCompare(a.watchedAt ?? ""));
        break;
      case "recentlyAdded":
        // Movies added before this field existed have no addedAt at all
        // (not backfilled, there's no true original add date to recover),
        // "" sorts before any real ISO timestamp, so they correctly land
        // at the end rather than the front.
        sorted.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
        break;
      case "rating":
        // No per-title rating cached locally (ratings come from OMDb live,
        // not stored), so this falls back to title order. Noted rather than
        // silently pretending to sort by something it can't.
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }
    return { visible: sorted, searching };
  }, [movies, query, sortKey, filterKey, genreFilter]);
  const filtersSetAside = searching && (filterKey !== "all" || genreFilter !== null);

  // Same exit as the Shows grid: see lib/libraryRemoval.ts. Under it, the
  // watched hold (lib/movieWatched.ts): a movie ticked on the Want to watch
  // filter shows the tick, then leaves; on All it shows the tick and stays.
  const gridRef = useRef<HTMLDivElement>(null);
  const captureGrid = useFlipLayout(gridRef);
  const watchedDisplay = useMovieWatchedExit(visible, movieKey, captureGrid, filterKey);
  const display = useRemovalExit(watchedDisplay, movieSlotKey, captureGrid);
  // Ratings for movies stored before ratings were, top of the grid first.
  useRatingBackfill("movie", movies ? visible : undefined);
  const [watchError, setWatchError] = useState<string | null>(null);

  /**
   * The poster's indicator. Unwatched, one tap marks it watched, as before.
   * Watched, it opens the viewing-status menu (Watched again, Remove last
   * viewing, Watched once, Not watched) instead of unmarking on the spot - the
   * same choices an episode's green tick offers - and each choice plays its
   * own acknowledgement on the card.
   *
   * Stable (it only uses a state setter and module functions), so the
   * memoised cards below are not re-rendered just because this page was.
   */
  const onIndicator = useCallback(async (movie: Movie, el: HTMLElement) => {
    setWatchError(null);
    if (movie.watched) {
      void openMovieViewingMenu(movie.tmdbId, movie.title, el);
      return;
    }
    try {
      await markMovieWatchedFromCard(movie.tmdbId);
    } catch (e) {
      setWatchError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (!movies) return <PosterGridSkeleton />;

  return (
    <div className="panel">
      <h1 className="sr-only">Movies</h1>

      {/* The two headline numbers; viewings, rewatches, unwatched and most
          rewatched are one tap away in the statistics dialog. */}
      <StatTiles
        label="Movie statistics: movie time and movies watched. Open for details"
        onOpen={() => setStatsOpen(true)}
        tiles={[
          { label: "Movie time", value: <DurationValue minutes={stats.totalMinutes} /> },
          { label: "Movies watched", value: stats.loading ? "..." : stats.moviesWatched.toLocaleString() },
        ]}
      />
      {statsOpen && <MovieStatsDialog totalMinutes={stats.totalMinutes} onClose={() => setStatsOpen(false)} />}
      {stats.backfilling && stats.backfillProgress && (
        <p className="muted small">
          Fetching runtime data for movies added before this feature existed: {stats.backfillProgress.done} /{" "}
          {stats.backfillProgress.total}
        </p>
      )}

      {movies.length === 0 && display.length === 0 ? (
        <p className="muted">No movies yet. Import your TV Time export, or add one below.</p>
      ) : (
        <>
          {/* On a phone the search and the filter button live in the bottom
              dock (SearchFilterDock) instead; the sheet itself is shared. */}
          <div className={`field-row filters-row${isMobile ? " is-docked" : ""}`}>
            {!isMobile && (
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your movies..."
              />
            )}
            {/* Same three categories, in the same order, as the Shows filter
                menu — the two pages are the same job on different content and
                should not need to be learned twice. */}
            <FilterSheet
              resultCount={visible.length}
              noun="movie"
              open={filterSheetOpen}
              onOpenChange={setFilterSheetOpen}
              canReset={filtersChanged}
              showTrigger={!isMobile}
              onReset={() => {
                setFilterKey("wantToWatch");
                setGenreFilter(null);
                setSortKey("recentlyAdded");
              }}
            >
              <FilterGroup title="Watch status">
                <SegmentedControl options={STATUS_OPTIONS} value={filterKey} onChange={setFilterKey} />
              </FilterGroup>
              <FilterGroup title="Genre">
                {isMobile ? (
                  <GenreChips genres={genres} value={genreFilter} onChange={setGenreFilter} />
                ) : (
                  <select
                    className="compact-select"
                    value={genreFilter ?? ""}
                    onChange={(e) => setGenreFilter(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">All genres</option>
                    {genres.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
              </FilterGroup>
              <FilterGroup title="Sort by">
                {isMobile ? (
                  <SegmentedControl options={SORT_OPTIONS} value={sortKey} onChange={setSortKey} />
                ) : (
                  <select
                    className="compact-select"
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                  >
                    {SORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </FilterGroup>
            </FilterSheet>
          </div>
          {isMobile && (
            <SearchFilterDock
              query={query}
              onQueryChange={setQuery}
              placeholder="Search your movies"
              filtersActive={filtersChanged}
              onOpenFilters={() => setFilterSheetOpen(true)}
            />
          )}

          {filtersSetAside && (
            <p className="muted small search-scope-note">
              Searching all your movies. Your filters apply again when you clear the search.
            </p>
          )}

          {display.length === 0 &&
            (searching ? (
              <p className="muted">No movies in your library match &ldquo;{query.trim()}&rdquo;.</p>
            ) : (
              <p className="muted">No movies match that search/filter.</p>
            ))}

          {watchError && (
            <p className="status-error small" role="alert">
              Couldn't update that movie, so nothing changed. ({watchError})
            </p>
          )}

          <div className="show-grid" ref={gridRef}>
            {display.map(({ item: { item: m, watched, staying }, removal }) => (
              <MovieGridCard
                key={m.tmdbId}
                movie={m}
                watched={watched}
                staying={staying}
                removal={removal}
                onOpen={setOpenDetails}
                onIndicator={onIndicator}
              />
            ))}
          </div>
        </>
      )}

      {openDetails !== null && <DetailsPanel kind="movie" tmdbId={openDetails} onClose={() => setOpenDetails(null)} />}
    </div>
  );
}

/**
 * One poster in the grid. Memoised: a watched sequence or a removal changes
 * one card's phase several times in under a second (saving, confirm, exit,
 * gone), and each change re-renders this page. Re-rendering every poster for
 * each of those - a few hundred on a long watchlist - is what a phone could
 * not do inside the 460ms the green veil is on screen, so the acknowledgement
 * arrived late and the exit was cut short. Now only the card whose phase
 * changed re-renders; the rest compare props and stop.
 */
const MovieGridCard = memo(function MovieGridCard({
  movie: m,
  watched,
  staying,
  removal,
  onOpen,
  onIndicator,
}: {
  movie: Movie;
  watched: MovieWatchedPhase | undefined;
  staying: boolean | undefined;
  removal: RemovalPhase | undefined;
  onOpen: (tmdbId: number) => void;
  onIndicator: (movie: Movie, el: HTMLElement) => void;
}) {
  const count = movieWatchCount(m);
  return (
    <div
      data-flip-key={m.tmdbId}
      className={`show-card movie-card${removalClass(removal)}${watchedClass(watched, staying)}`}
      role="button"
      tabIndex={0}
      {...titleQuickActionProps({
        kind: "movie",
        tmdbId: m.tmdbId,
        name: m.title,
        onViewDetails: () => onOpen(m.tmdbId),
      })}
      onClick={() => onOpen(m.tmdbId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(m.tmdbId);
        }
      }}
    >
      {/* The artwork and everything drawn on it: the rating top-left, the
          watch state top-right, and the watched veil over the whole poster. */}
      <div className="card-art">
        {m.posterPath ? (
          <img src={`${TMDB_IMAGE_BASE}${m.posterPath}`} alt={m.title} />
        ) : (
          <div className="poster-placeholder" />
        )}
        <RatingChip rating={m.tmdbRating} />
        <button
          className={`watched-badge ${m.watched ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            void onIndicator(m, e.currentTarget);
          }}
          aria-haspopup={m.watched ? "menu" : undefined}
          aria-label={m.watched ? `${viewingsInWords(count)}. Change viewing status` : `Mark ${m.title} watched`}
        >
          <WatchMark count={count} />
        </button>
        <MovieWatchedOverlay phase={watched} staying={staying} tmdbId={m.tmdbId} />
      </div>
      <PosterCaption title={m.title} year={m.releaseYear} />
    </div>
  );
});
