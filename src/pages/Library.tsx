import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { TMDB_IMAGE_BASE, getTvGenres, type Genre } from "../tmdb";
import { computeWatchStatus, type ShowWatchStatus } from "../lib/showWatchStatus";
import { useShowStats, toDurationParts } from "../lib/stats";
import DetailsPanel from "../components/DetailsPanel";
import FilterSheet from "../components/FilterSheet";
import SegmentedControl from "../components/SegmentedControl";
import GenreChips from "../components/GenreChips";
import { useIsMobile } from "../lib/useIsMobile";

type SortKey = "name" | "mostWatched" | "recentlyWatched" | "recentlyAdded";
type FilterKey = "all" | "following" | "stopped" | "currentlyWatching";

const STATUS_OPTIONS: { value: FilterKey; label: string }[] = [
  { value: "all", label: "All" },
  { value: "following", label: "Following" },
  { value: "currentlyWatching", label: "Currently Watching" },
  { value: "stopped", label: "Stopped" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name (A-Z)" },
  { value: "mostWatched", label: "Most watched" },
  { value: "recentlyWatched", label: "Recently watched" },
  { value: "recentlyAdded", label: "Recently added" },
];

export default function Library() {
  const isMobile = useIsMobile();
  const shows = useLiveQuery(() => db.shows.toArray(), []);
  const watchedCounts = useLiveQuery(async () => {
    const all = await db.watchedEpisodes.toArray();
    const counts = new Map<number, number>();
    for (const w of all) counts.set(w.showId, (counts.get(w.showId) ?? 0) + 1);
    return counts;
  }, []);
  const [openDetails, setOpenDetails] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // Recently added first: a tracker is used to keep up with what you just
  // started following, and alphabetical buries that under whatever begins
  // with "A". Alphabetical is still one tap away in the sort control.
  const [sortKey, setSortKey] = useState<SortKey>("recentlyAdded");
  const [filterKey, setFilterKey] = useState<FilterKey>("all");
  const [genreFilter, setGenreFilter] = useState<number | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [statusByShow, setStatusByShow] = useState<Map<number, ShowWatchStatus>>(new Map());
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const stats = useShowStats();

  useEffect(() => {
    getTvGenres().then(setGenres).catch(() => setGenres([]));
  }, []);

  // Currently Watching relies on episode data already being cached locally
  // (from having opened the show, or from Home's sync). It intentionally
  // does NOT force a TMDB fetch for every show in a big library just to
  // support this filter, that would mean one or more API calls per show on
  // every visit to this page. Shows not yet cached show as "unknown" and
  // won't match the filter until you've opened them once or visited Home.
  useEffect(() => {
    if (!shows) return;
    const showList = shows;
    let cancelled = false;
    async function compute() {
      const map = new Map<number, ShowWatchStatus>();
      for (const show of showList) {
        map.set(show.tmdbId, await computeWatchStatus(show.tmdbId));
      }
      if (!cancelled) setStatusByShow(map);
    }
    compute();
    return () => {
      cancelled = true;
    };
  }, [shows]);

  const visible = useMemo(() => {
    if (!shows) return [];
    let list = shows;

    if (filterKey === "following") list = list.filter((s) => s.isFollowed && !s.isArchived);
    if (filterKey === "stopped") list = list.filter((s) => s.isArchived);
    if (filterKey === "currentlyWatching") list = list.filter((s) => statusByShow.get(s.tmdbId) === "currently-watching");

    if (genreFilter !== null) list = list.filter((s) => s.genreIds?.includes(genreFilter));

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q));
    }

    const sorted = [...list];
    switch (sortKey) {
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "mostWatched":
        sorted.sort((a, b) => (watchedCounts?.get(b.tmdbId) ?? 0) - (watchedCounts?.get(a.tmdbId) ?? 0));
        break;
      case "recentlyWatched":
        sorted.sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""));
        break;
      case "recentlyAdded":
        sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
        break;
    }
    return sorted;
  }, [shows, query, sortKey, filterKey, genreFilter, watchedCounts, statusByShow]);

  if (!shows) return <p className="muted">Loading...</p>;

  const duration = toDurationParts(stats.totalMinutes);

  return (
    <div className="panel">
      <h1 className="sr-only">Shows</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">
            {duration.months}<span className="stat-unit">mo</span> {duration.days}
            <span className="stat-unit">d</span> {duration.hours}
            <span className="stat-unit">h</span>
          </div>
          <div className="stat-label">TV time</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.loading ? "..." : stats.distinctEpisodesWatched.toLocaleString()}</div>
          <div className="stat-label">Episodes watched</div>
        </div>
      </div>
      {stats.backfilling && stats.backfillProgress && (
        <p className="muted small">
          Fetching runtime data for shows added before this feature existed: {stats.backfillProgress.done} /{" "}
          {stats.backfillProgress.total}
        </p>
      )}

      {shows.length === 0 ? (
        <p className="muted">No shows yet. Import your TV Time export, or search TMDB from Add.</p>
      ) : (
        <>
          <div className="field-row filters-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your shows..."
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

          {visible.length === 0 && <p className="muted">No shows match that search/filter.</p>}

          <div className="show-grid">
            {visible.map((show) => (
              <div
                key={show.tmdbId}
                className="show-card"
                role="button"
                tabIndex={0}
                onClick={() => setOpenDetails(show.tmdbId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenDetails(show.tmdbId);
                  }
                }}
              >
                {show.posterPath ? (
                  <img src={`${TMDB_IMAGE_BASE}${show.posterPath}`} alt={show.name} />
                ) : (
                  <div className="poster-placeholder" />
                )}
                {show.numberOfEpisodes ? (
                  <div className="poster-progress">
                    <span
                      style={{
                        width: `${Math.min(100, ((watchedCounts?.get(show.tmdbId) ?? 0) / show.numberOfEpisodes) * 100)}%`,
                      }}
                    />
                  </div>
                ) : null}
                <div className="show-card-body">
                  <p className="show-name">{show.name}</p>
                  <p className="muted small">{watchedCounts?.get(show.tmdbId) ?? 0} episodes watched</p>
                  {show.isArchived && <p className="muted small">Stopped</p>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {openDetails !== null && <DetailsPanel kind="show" tmdbId={openDetails} onClose={() => setOpenDetails(null)} />}
    </div>
  );
}
