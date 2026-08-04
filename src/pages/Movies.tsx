import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { TMDB_IMAGE_BASE, getMovieGenres, type Genre } from "../tmdb";
import { useMovieStats, toDurationParts } from "../lib/stats";
import DetailsPanel from "../components/DetailsPanel";
import FilterSheet from "../components/FilterSheet";
import SegmentedControl from "../components/SegmentedControl";
import GenreChips from "../components/GenreChips";
import EmptyState from "../components/EmptyState";
import { ShowGridSkeleton, LoadingAnnouncement } from "../components/Skeleton";
import { MoviesIcon, SearchIcon, CheckIcon } from "../components/icons";
import { useIsMobile } from "../lib/useIsMobile";

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
  // Recently added first, same reasoning as the Shows grid.
  const [sortKey, setSortKey] = useState<SortKey>("recentlyAdded");
  const [filterKey, setFilterKey] = useState<FilterKey>("all");
  const [genreFilter, setGenreFilter] = useState<number | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

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

  const visible = useMemo(() => {
    if (!movies) return [];
    let list = movies;

    if (filterKey === "watched") list = list.filter((m) => m.watched);
    if (filterKey === "wantToWatch") list = list.filter((m) => !m.watched && m.wantsToWatch);
    if (genreFilter !== null) list = list.filter((m) => m.genreIds?.includes(genreFilter));

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((m) => m.title.toLowerCase().includes(q));
    }

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
    return sorted;
  }, [movies, query, sortKey, filterKey, genreFilter]);

  if (!movies) {
    return (
      <div className="panel">
        <h2>Movies</h2>
        <LoadingAnnouncement label="Loading your movies" />
        <ShowGridSkeleton />
      </div>
    );
  }

  async function toggleWatched(tmdbId: number, currentlyWatched: boolean) {
    await db.movies.update(tmdbId, {
      watched: !currentlyWatched,
      watchedAt: !currentlyWatched ? new Date().toISOString() : null,
    });
  }

  const duration = toDurationParts(stats.totalMinutes);

  return (
    <div className="panel">
      <h2>Movies</h2>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">
            {duration.months}<span className="stat-unit">mo</span> {duration.days}
            <span className="stat-unit">d</span> {duration.hours}
            <span className="stat-unit">h</span>
          </div>
          <div className="stat-label">Movie time</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.loading ? "..." : stats.moviesWatched.toLocaleString()}</div>
          <div className="stat-label">Movies watched</div>
        </div>
      </div>
      {stats.backfilling && stats.backfillProgress && (
        <p className="muted small">
          Fetching runtime data for movies added before this feature existed: {stats.backfillProgress.done} /{" "}
          {stats.backfillProgress.total}
        </p>
      )}

      {movies.length === 0 ? (
        <EmptyState
          icon={MoviesIcon}
          title="No movies yet"
          body="Import a TV Time export from Settings, or search TMDB from the Discover tab to add your first film."
        />
      ) : (
        <>
          <div className="field-row filters-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your movies..."
            />
            <FilterSheet resultCount={visible.length} open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
              <SegmentedControl options={STATUS_OPTIONS} value={filterKey} onChange={setFilterKey} />
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
              {isMobile ? (
                <SegmentedControl options={SORT_OPTIONS} value={sortKey} onChange={setSortKey} />
              ) : (
                <select className="compact-select" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </FilterSheet>
          </div>

          {visible.length === 0 && (
            <EmptyState
              icon={SearchIcon}
              title="No movies match"
              body="Nothing in your library fits that search and filter combination. Try a shorter search term, or reset the filters."
              action={{
                label: "Clear search and filters",
                onClick: () => {
                  setQuery("");
                  setFilterKey("all");
                  setGenreFilter(null);
                },
              }}
            />
          )}

          <div className="show-grid">
            {visible.map((m) => (
              <div
                key={m.tmdbId}
                className="show-card movie-card"
                role="button"
                tabIndex={0}
                onClick={() => setOpenDetails(m.tmdbId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenDetails(m.tmdbId);
                  }
                }}
              >
                <div className="show-card-media">
                  {m.posterPath ? (
                    <img
                      src={`${TMDB_IMAGE_BASE}${m.posterPath}`}
                      alt={m.title}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="poster-placeholder" />
                  )}
                  <div className="show-card-body">
                    <p className="show-name">
                      {m.title} {m.releaseYear ? `(${m.releaseYear})` : ""}
                    </p>
                  </div>
                </div>
                {/* Outside .show-card-media on purpose: .hit-slop widens the
                    tap target past the badge's painted 30px, and the media
                    wrapper's overflow:hidden would clip that. */}
                <button
                  className={`watched-badge hit-slop ${m.watched ? "on" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleWatched(m.tmdbId, m.watched);
                  }}
                  aria-label={m.watched ? `Mark ${m.title} unwatched` : `Mark ${m.title} watched`}
                  aria-pressed={m.watched}
                >
                  <CheckIcon size={16} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {openDetails !== null && <DetailsPanel kind="movie" tmdbId={openDetails} onClose={() => setOpenDetails(null)} />}
    </div>
  );
}
