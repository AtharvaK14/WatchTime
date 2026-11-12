import { useEffect, useMemo, useRef, useState } from "react";
import { type Show } from "../db";
import { useAllEpisodes, useAllShows, useAllWatchedEpisodes } from "../lib/libraryStore";
import { TMDB_IMAGE_BASE, getTvGenres, type Genre } from "../tmdb";
import { watchStatusByShow, type ShowWatchStatus } from "../lib/showWatchStatus";
import { isStoppedWatching } from "../lib/stoppedWatching";
import { useShowStats } from "../lib/stats";
import StatTiles, { DurationValue } from "../components/StatTiles";
import { libraryKey, removalClass, useRemovalExit } from "../lib/libraryRemoval";
import { useFlipLayout } from "../lib/useFlipLayout";
import DetailsPanel from "../components/DetailsPanel";
import PosterCaption from "../components/PosterCaption";
import RatingChip from "../components/RatingChip";
import { useRatingBackfill } from "../lib/ratings";
import SearchFilterDock from "../components/SearchFilterDock";
import FilterSheet, { FilterGroup } from "../components/FilterSheet";
import SegmentedControl from "../components/SegmentedControl";
import GenreChips from "../components/GenreChips";
import { useIsMobile } from "../lib/useIsMobile";
import { titleQuickActionProps } from "../lib/titleQuickActions";
import { episodeWatchCount } from "../lib/watchHistory";
import { searchOrBrowse } from "../lib/librarySearch";
import { ShowStatsDialog } from "../components/StatsDialog";
import { PosterGridSkeleton } from "../components/Skeleton";

type SortKey = "name" | "mostWatched" | "recentlyWatched" | "recentlyAdded";
type FilterKey = "all" | "following" | "stopped" | "currentlyWatching";

// "Stopped Watching" rather than the previous bare "Stopped", so this filter
// and Home's fourth tab are visibly the same state rather than two similar
// words for it. The control wraps, so the longer label costs no layout.
const STATUS_OPTIONS: { value: FilterKey; label: string }[] = [
  { value: "all", label: "All" },
  { value: "following", label: "Following" },
  { value: "currentlyWatching", label: "Currently Watching" },
  { value: "stopped", label: "Stopped Watching" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name (A-Z)" },
  { value: "mostWatched", label: "Most watched" },
  { value: "recentlyWatched", label: "Recently watched" },
  { value: "recentlyAdded", label: "Recently added" },
];

const showKey = (show: Show) => libraryKey("show", show.tmdbId);

export default function Library() {
  const isMobile = useIsMobile();
  // Whole tables, from the store that outlives this page (lib/libraryStore.ts):
  // coming back to this tab finds them already loaded, so the grid is drawn
  // on the first render instead of after a skeleton and a re-read.
  const shows = useAllShows();
  const allEpisodes = useAllEpisodes();
  const allWatched = useAllWatchedEpisodes();
  // Per show: unique episodes watched (the progress bar: how far through the
  // show you are) and viewing events (Most watched: rewatches count, since a
  // show watched twice has been watched more than one watched once).
  const watchedCounts = useMemo(() => {
    if (!allWatched) return undefined;
    const unique = new Map<number, number>();
    const views = new Map<number, number>();
    for (const w of allWatched) {
      unique.set(w.showId, (unique.get(w.showId) ?? 0) + 1);
      views.set(w.showId, (views.get(w.showId) ?? 0) + episodeWatchCount(w));
    }
    return { unique, views };
  }, [allWatched]);
  const [openDetails, setOpenDetails] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // Defaults: Currently Watching, most recently watched first. A tracker is
  // opened to answer "what am I in the middle of", and that question is
  // answered by the shows with unwatched episodes and recent activity — not
  // by whatever happens to begin with "A", nor by everything ever added.
  // Both are one tap from being widened again in the Status group.
  const [sortKey, setSortKey] = useState<SortKey>("recentlyWatched");
  const [filterKey, setFilterKey] = useState<FilterKey>("currentlyWatching");
  const [genreFilter, setGenreFilter] = useState<number | null>(null);
  // Any filter off its default: Reset is offered, and the dock's filter button carries a dot.
  const filtersChanged = filterKey !== "currentlyWatching" || genreFilter !== null || sortKey !== "recentlyWatched";
  const [genres, setGenres] = useState<Genre[]>([]);
  // Currently Watching relies on episode data already being cached locally
  // (from having opened the show, or from Home's sync). It intentionally
  // does NOT force a TMDB fetch for every show in a big library just to
  // support this filter, that would mean one or more API calls per show on
  // every visit to this page. Shows not yet cached show as "unknown" and
  // won't match the filter until you've opened them once or visited Home.
  //
  // Worked out here, while rendering, from the tables already in memory. It
  // used to be a pass of three database reads per show, started again on
  // every visit to this tab and after every change to the library, and the
  // page could only say "Working out which shows you're currently watching..."
  // until it finished - about a second for a large library, every time.
  const statusesReady = !!shows && !!allEpisodes && !!allWatched;
  const statusByShow = useMemo<Map<number, ShowWatchStatus>>(
    () => (shows && allEpisodes && allWatched ? watchStatusByShow(shows, allEpisodes, allWatched) : new Map()),
    [shows, allEpisodes, allWatched]
  );
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

  const stats = useShowStats();

  useEffect(() => {
    getTvGenres().then(setGenres).catch(() => setGenres([]));
  }, []);

  const { visible, searching } = useMemo(() => {
    if (!shows) return { visible: [], searching: false };

    // The browsing filters. A search sets these aside instead of narrowing
    // them further (see lib/librarySearch.ts): the selection is kept, and
    // applies again when the search is cleared.
    const browse = (s: Show) => {
      if (filterKey === "following" && !(s.isFollowed && !isStoppedWatching(s))) return false;
      if (filterKey === "stopped" && !isStoppedWatching(s)) return false;
      // Stopped shows are excluded rather than merely not-preferred: computeWatchStatus
      // only knows about episodes, so a stopped show with a backlog looks exactly
      // like one in progress to it, and two filters claiming the same show say
      // different things about what the user is doing.
      if (
        filterKey === "currentlyWatching" &&
        !(!isStoppedWatching(s) && statusByShow.get(s.tmdbId) === "currently-watching")
      ) {
        return false;
      }
      if (genreFilter !== null && !s.genreIds?.includes(genreFilter)) return false;
      return true;
    };
    const { items: list, searching } = searchOrBrowse(shows, query, (s) => s.name, browse);

    const sorted = [...list];
    switch (sortKey) {
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "mostWatched":
        sorted.sort((a, b) => (watchedCounts?.views.get(b.tmdbId) ?? 0) - (watchedCounts?.views.get(a.tmdbId) ?? 0));
        break;
      case "recentlyWatched":
        sorted.sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""));
        break;
      case "recentlyAdded":
        sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
        break;
    }
    return { visible: sorted, searching };
  }, [shows, query, sortKey, filterKey, genreFilter, watchedCounts, statusByShow]);
  const filtersSetAside = searching && (filterKey !== "all" || genreFilter !== null);

  // A show removed through the panel this page opens keeps its card until the
  // panel closes; the card is then highlighted, leaves, and the grid closes
  // the gap. See lib/libraryRemoval.ts.
  const gridRef = useRef<HTMLDivElement>(null);
  const captureGrid = useFlipLayout(gridRef);
  const display = useRemovalExit(visible, showKey, captureGrid);
  // Ratings for shows stored before ratings were, top of the grid first.
  useRatingBackfill("show", shows ? visible : undefined);

  if (!shows) return <PosterGridSkeleton />;

  return (
    <div className="panel">
      <h1 className="sr-only">Shows</h1>

      {/* The two headline numbers; everything else (unique episodes,
          rewatches, show states, seasons, most watched, by month) is one tap
          away in the statistics dialog, from the same calculations. Episodes
          watched counts viewing events, rewatches included - the same count
          TV time is built from; the unique figure is in the dialog. */}
      <StatTiles
        label="Show statistics: TV time and episodes watched. Open for details"
        onOpen={() => setStatsOpen(true)}
        tiles={[
          { label: "TV time", value: <DurationValue minutes={stats.totalMinutes} /> },
          {
            label: "Episodes watched",
            value: stats.loading ? "..." : stats.episodeWatchEvents.toLocaleString(),
          },
        ]}
      />
      {statsOpen && (
        <ShowStatsDialog
          totalMinutes={stats.totalMinutes}
          statusByShow={statusByShow}
          statusesReady={statusesReady}
          onClose={() => setStatsOpen(false)}
        />
      )}
      {stats.backfilling && stats.backfillProgress && (
        <p className="muted small">
          Fetching runtime data for shows added before this feature existed: {stats.backfillProgress.done} /{" "}
          {stats.backfillProgress.total}
        </p>
      )}

      {shows.length === 0 && display.length === 0 ? (
        <p className="muted">No shows yet. Import your TV Time export, or search TMDB from Add.</p>
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
                placeholder="Search your shows..."
              />
            )}
            {/* Three categories, in the order the questions are actually
                asked: which shows, narrowed how, in what order. The controls
                inside each group are exactly the ones that were here before —
                FilterGroup only labels and separates them. */}
            <FilterSheet
              resultCount={visible.length}
              noun="show"
              open={filterSheetOpen}
              onOpenChange={setFilterSheetOpen}
              canReset={filtersChanged}
              showTrigger={!isMobile}
              onReset={() => {
                setFilterKey("currentlyWatching");
                setGenreFilter(null);
                setSortKey("recentlyWatched");
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
              placeholder="Search your shows"
              filtersActive={filtersChanged}
              onOpenFilters={() => setFilterSheetOpen(true)}
            />
          )}

          {/* Said once, quietly, so a search that finds a stopped or finished
              show does not look like the filter stopped working. */}
          {filtersSetAside && (
            <p className="muted small search-scope-note">
              Searching all your shows. Your filters apply again when you clear the search.
            </p>
          )}

          {display.length === 0 &&
            (searching ? (
              <p className="muted">No shows in your library match &ldquo;{query.trim()}&rdquo;.</p>
            ) : filterKey === "currentlyWatching" && !statusesReady ? (
              <p className="muted">Working out which shows you're currently watching...</p>
            ) : (
              <p className="muted">No shows match that search/filter.</p>
            ))}

          <div className="show-grid" ref={gridRef}>
            {display.map(({ item: show, removal }) => (
              <div
                key={show.tmdbId}
                data-flip-key={show.tmdbId}
                className={`show-card${removalClass(removal)}`}
                role="button"
                tabIndex={0}
                {...titleQuickActionProps({
                  kind: "show",
                  tmdbId: show.tmdbId,
                  name: show.name,
                  onViewDetails: () => setOpenDetails(show.tmdbId),
                })}
                onClick={() => setOpenDetails(show.tmdbId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenDetails(show.tmdbId);
                  }
                }}
              >
                {/* The artwork and everything drawn on it: the rating in the
                    top-left, and the progress bar along the bottom edge. */}
                <div className="card-art">
                  {show.posterPath ? (
                    <img src={`${TMDB_IMAGE_BASE}${show.posterPath}`} alt={show.name} />
                  ) : (
                    <div className="poster-placeholder" />
                  )}
                  <RatingChip rating={show.tmdbRating} />
                  {/* The progress bar is the card's only statement of progress.
                      The "N episodes watched" line that used to sit in the
                      caption said the same thing again in words; the count
                      behind both is unchanged and still drives this bar and the
                      Most watched sort. */}
                  {show.numberOfEpisodes ? (
                    <div className="poster-progress">
                      <span
                        style={{
                          width: `${Math.min(100, ((watchedCounts?.unique.get(show.tmdbId) ?? 0) / show.numberOfEpisodes) * 100)}%`,
                        }}
                      />
                    </div>
                  ) : null}
                </div>
                <PosterCaption title={show.name} year={show.firstAirYear}>
                  {/* Kept: under "All" it is the only thing telling a stopped
                      show apart from one in progress. */}
                  {isStoppedWatching(show) && <p className="card-meta">Stopped watching</p>}
                </PosterCaption>
              </div>
            ))}
          </div>
        </>
      )}

      {openDetails !== null && <DetailsPanel kind="show" tmdbId={openDetails} onClose={() => setOpenDetails(null)} />}
    </div>
  );
}
