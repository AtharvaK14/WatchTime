import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Episode } from "../db";
import { TMDB_IMAGE_BASE } from "../tmdb";
import { ensureEpisodesCached } from "../lib/episodeSync";
import {
  buildReleasingThisMonth,
  buildUpcomingEpisodeRows,
  formatUpcomingDate,
  type UpcomingEpisodeRow,
} from "../lib/comingUp";
import { getStaleDaysThreshold } from "../lib/showStatus";
import { markNextEpisodeWatched, recordEpisodeRewatch } from "../lib/watchEvents";
import { useIsMobile } from "../lib/useIsMobile";
import DetailsPanel from "../components/DetailsPanel";
import EpisodeDetailsPanel from "../components/EpisodeDetailsPanel";
import MoodSearch from "../components/MoodSearch";
import { useMoodSearch } from "../lib/moodSearch/useMoodSearch";
import {
  matchesMoodFilter,
  movieToMoodCandidate,
  rankByMoodFilter,
  showToMoodCandidate,
  type MoodCandidate,
  type MoodFilter,
} from "../lib/moodSearch/search";
import { buildWatchNextRows, byAddedAt, byRecency, type WatchNextRow as Row } from "../lib/watchNext";

function EpisodeRow({
  row,
  onOpenShow,
  onOpenEpisode,
  onMarkWatched,
}: {
  row: Row;
  onOpenShow: (id: number) => void;
  onOpenEpisode: (row: Row) => void;
  onMarkWatched: (row: Row) => void;
}) {
  const isPremiere = row.nextEpisode?.episodeNumber === 1;
  return (
    <div className="watch-next-row">
      {row.posterPath ? (
        <img src={`${TMDB_IMAGE_BASE}${row.posterPath}`} alt={row.showName} onClick={() => onOpenShow(row.showId)} />
      ) : (
        <div className="poster-placeholder wn-poster" onClick={() => onOpenShow(row.showId)} />
      )}
      <div className="wn-body">
        <span className="show-pill" onClick={() => onOpenShow(row.showId)}>
          {row.showName} &rsaquo;
        </span>
        {row.nextEpisode ? (
          <>
            {/* The episode block opens the same episode panel the season
                browser uses. A real button, not a click handler on a <p>, so
                it is keyboard reachable and announced as a control. */}
            <button type="button" className="wn-episode-button" onClick={() => onOpenEpisode(row)}>
              <span className="wn-episode-line">
                S{String(row.nextEpisode.seasonNumber).padStart(2, "0")} | E
                {String(row.nextEpisode.episodeNumber).padStart(2, "0")}
                {row.additionalCount > 0 && <span className="muted"> +{row.additionalCount}</span>}
              </span>
              <span className="muted small wn-episode-name">{row.nextEpisode.name}</span>
              <span className="sr-only">Episode details</span>
            </button>
            {isPremiere && <span className="premiere-tag">PREMIERE</span>}
          </>
        ) : (
          <p className="muted small">
            {row.category === "not-started"
              ? "Not started yet"
              : "More to watch (couldn't match the exact next episode against TMDB)"}
          </p>
        )}
      </div>
      <button
        className="watch-toggle-circle"
        onClick={() => onMarkWatched(row)}
        aria-label={row.category === "not-started" ? "Start watching" : "Mark watched"}
        disabled={!row.nextEpisode}
      >
        &#10003;
      </button>
    </div>
  );
}

function ShowsHome({ onOpenShow, filter }: { onOpenShow: (tmdbId: number) => void; filter: MoodFilter | null }) {
  const shows = useLiveQuery(() => db.shows.filter((s) => s.isFollowed && !s.isArchived).toArray(), []);
  // Deliberately simple, single-table, whole-table live queries. Each one is
  // independently and unambiguously reactive to writes on its own table.
  // Combining them in a plain synchronous useMemo below (no async, no
  // Dexie calls inside the memo) removes any uncertainty about how a
  // multi-step async query loop interacts with Dexie's change tracking,
  // which is the more failure-prone pattern the previous version used.
  const allEpisodes = useLiveQuery(() => db.episodes.toArray(), []);
  const allWatched = useLiveQuery(() => db.watchedEpisodes.toArray(), []);
  const [syncing, setSyncing] = useState(false);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [tab, setTab] = useState<"next" | "stale" | "not-started">("next");
  // The episode panel opened from a Watch Next row. Only the show/episode
  // identity is stored; watched state is derived live from allWatched below,
  // so ticking the episode updates the open panel in place rather than
  // showing a stale snapshot.
  const [openEpisode, setOpenEpisode] = useState<{ showId: number; episode: Episode } | null>(null);

  // Network side effect: make sure TMDB episode lists are cached for every
  // followed show. Writes to db.episodes, which allEpisodes above reacts to,
  // so newly-synced seasons flow into the computation below automatically
  // as they arrive, not just once at the end.
  //
  // Each show is wrapped in its own try/catch: ensureEpisodesCached had no
  // error handling before, so a single failure (a TMDB rate limit, a
  // network hiccup, a show TMDB has no data for) threw inside the loop and
  // silently stopped every show queued after it from ever being synced in
  // that session. For a small library that's rarely noticeable, for ~190
  // shows imported at once it meant most of the list could go permanently
  // unsynced from one bad show. Failures are now collected and surfaced
  // instead of aborting the whole batch.
  useEffect(() => {
    if (!shows) return;
    let cancelled = false;
    async function sync() {
      setSyncing(true);
      setSyncErrors([]);
      const failures: string[] = [];
      for (const show of shows!) {
        if (cancelled) return;
        try {
          await ensureEpisodesCached(show.tmdbId);
        } catch (e) {
          failures.push(`${show.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!cancelled) {
        setSyncing(false);
        setSyncErrors(failures);
      }
    }
    sync();
    return () => {
      cancelled = true;
    };
  }, [shows]);

  const rows = useMemo<Row[]>(
    () =>
      !shows || !allEpisodes || !allWatched
        ? []
        : buildWatchNextRows(shows, allEpisodes, allWatched, getStaleDaysThreshold(), filter),
    [shows, allEpisodes, allWatched, filter]
  );

  // Live lookups for the open episode panel. Both read from the same live
  // queries the lists use, so a watch recorded anywhere is reflected here.
  const openEpisodeShow = openEpisode ? shows?.find((sh) => sh.tmdbId === openEpisode.showId) : undefined;
  const openEpisodeWatch = openEpisode ? allWatched?.find((w) => w.key === openEpisode.episode.key) : undefined;

  async function markWatched(row: Row) {
    if (!row.nextEpisode) return;
    // Marks the next UNSEEN episode watched (starts a not-started show, or
    // advances an in-progress one). Never a rewatch: Watch Next only ever
    // points at unseen episodes now, so this always creates a fresh record.
    await markNextEpisodeWatched(row.showId, row.nextEpisode);
  }

  if (!shows || !allEpisodes || !allWatched) return <p className="muted">Loading...</p>;

  // Three MUTUALLY EXCLUSIVE lists (see categorize() in lib/watchNext.ts).
  // Watch Next and the stale list sort by most recent PROGRESSION (rewatches
  // don't reorder them); Haven't Yet Started sorts by most recently added.
  const watchNext = rows.filter((r) => r.category === "watch-next").sort(byRecency);
  const stale = rows.filter((r) => r.category === "stale").sort(byRecency);
  const notStarted = rows.filter((r) => r.category === "not-started").sort(byAddedAt);
  const activeList = tab === "next" ? watchNext : tab === "stale" ? stale : notStarted;

  return (
    <>
      {/* This heading is not decoration. .section-title:first-of-type drops the
          divider and top margin from whichever heading comes first, so while
          this section had none, "Movies to Watch" inherited that treatment and
          the sections ran together with nothing between them. */}
      <h2 className="section-title">Up Next</h2>

      <div className="pill-tabs">
        <button className={`pill-tab ${tab === "next" ? "active" : ""}`} onClick={() => setTab("next")}>
          Watch Next{watchNext.length > 0 ? ` (${watchNext.length})` : ""}
        </button>
        <button className={`pill-tab ${tab === "stale" ? "active" : ""}`} onClick={() => setTab("stale")}>
          Haven't Watched For a While{stale.length > 0 ? ` (${stale.length})` : ""}
        </button>
        <button
          className={`pill-tab ${tab === "not-started" ? "active" : ""}`}
          onClick={() => setTab("not-started")}
        >
          Haven't Yet Started{notStarted.length > 0 ? ` (${notStarted.length})` : ""}
        </button>
      </div>

      {syncing && <p className="muted small">Syncing episode data from TMDB...</p>}

      {!syncing && syncErrors.length > 0 && (
        <details className="status-error" style={{ marginBottom: 10 }}>
          <summary>{syncErrors.length} show(s) failed to sync from TMDB, they may be missing from the lists below</summary>
          <ul>
            {syncErrors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        </details>
      )}

      {activeList.length === 0 && !syncing && filter && (
        <p className="muted">Nothing in this list matches that search. Clear it to see everything again.</p>
      )}

      {activeList.length === 0 && !syncing && !filter && (
        <p className="muted">
          {tab === "next"
            ? "Nothing queued up. If you're sure some shows should be here, check Diagnostics in Settings, or re-import using the newer TV Time export format."
            : tab === "stale"
              ? "Nothing here, everything you've started has been watched recently."
              : "Nothing here, every show in your library has been started."}
        </p>
      )}

      <div className="watch-next-list">
        {activeList.map((row) => (
          <EpisodeRow
            key={row.showId}
            row={row}
            onOpenShow={onOpenShow}
            onOpenEpisode={(r) => r.nextEpisode && setOpenEpisode({ showId: r.showId, episode: r.nextEpisode })}
            onMarkWatched={markWatched}
          />
        ))}
      </div>

      {openEpisodeShow && openEpisode && (
        <EpisodeDetailsPanel
          show={{ name: openEpisodeShow.name, imdbId: openEpisodeShow.imdbId }}
          episode={openEpisode.episode}
          watched={openEpisodeWatch !== undefined}
          watchCount={openEpisodeWatch?.watchCount ?? 0}
          // Deliberately stays open on toggle, matching the season browser:
          // the panel re-renders from live data so the tick and the rewatch
          // count update in place.
          onToggleWatched={async () => {
            if (openEpisodeWatch) await db.watchedEpisodes.delete(openEpisode.episode.key);
            else await markNextEpisodeWatched(openEpisode.showId, openEpisode.episode);
          }}
          onWatchAgain={() => recordEpisodeRewatch(openEpisode.showId, [openEpisode.episode])}
          onClose={() => setOpenEpisode(null)}
        />
      )}
    </>
  );
}

/**
 * Upcoming episodes (confirmed future air_date, across followed shows) and
 * movies releasing this calendar month (from Movie.releaseDate, backfilled
 * by useShowStats/useMovieStats for libraries that predate that field).
 * Deliberately reuses data already loaded elsewhere on Home rather than
 * issuing new network requests, this only reads db.episodes, which
 * ShowsHome's sync effect already keeps populated for every followed show.
 */
function ComingUp() {
  const shows = useLiveQuery(() => db.shows.filter((s) => s.isFollowed && !s.isArchived).toArray(), []);
  const allEpisodes = useLiveQuery(() => db.episodes.toArray(), []);
  const movies = useLiveQuery(() => db.movies.toArray(), []);
  const [openMovie, setOpenMovie] = useState<number | null>(null);
  // Tapping an upcoming episode opens THAT episode, matching the Coming Up
  // widget. It used to open the show's panel, which made the user hunt for the
  // episode they had just pointed at.
  const [openEpisode, setOpenEpisode] = useState<UpcomingEpisodeRow | null>(null);

  const upcomingEpisodes = useMemo<UpcomingEpisodeRow[]>(
    () => (!shows || !allEpisodes ? [] : buildUpcomingEpisodeRows(shows, allEpisodes)),
    [shows, allEpisodes]
  );

  const releasingThisMonth = useMemo(() => (!movies ? [] : buildReleasingThisMonth(movies)), [movies]);

  if (!shows || !allEpisodes || !movies) return null;
  if (upcomingEpisodes.length === 0 && releasingThisMonth.length === 0) return null;

  return (
    <>
      <h2 className="section-title">Coming Up</h2>
      <div className="coming-up-cols">
        <div className="coming-up-col">
          <p className="muted small coming-up-col-label">Upcoming episodes</p>
          {upcomingEpisodes.length === 0 && <p className="muted small">Nothing confirmed yet.</p>}
          {upcomingEpisodes.map((row) => (
            <div
              key={row.showId}
              className="up-row"
              role="button"
              tabIndex={0}
              onClick={() => setOpenEpisode(row)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenEpisode(row);
                }
              }}
            >
              {row.posterPath ? (
                <img src={`${TMDB_IMAGE_BASE}${row.posterPath}`} alt="" className="up-row-poster" />
              ) : (
                <div className="poster-placeholder up-row-poster" />
              )}
              <div className="up-row-body">
                <p className="show-name">{row.showName}</p>
                <p className="muted small">
                  S{String(row.episode.seasonNumber).padStart(2, "0")} | E
                  {String(row.episode.episodeNumber).padStart(2, "0")}
                </p>
              </div>
              <span className="up-row-date">{formatUpcomingDate(row.episode.airDate)}</span>
            </div>
          ))}
        </div>
        <div className="coming-up-col">
          <p className="muted small coming-up-col-label">Releasing this month</p>
          {releasingThisMonth.length === 0 && <p className="muted small">Nothing this month.</p>}
          {releasingThisMonth.map((m) => (
            <div
              key={m.tmdbId}
              className="up-row"
              role="button"
              tabIndex={0}
              onClick={() => setOpenMovie(m.tmdbId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenMovie(m.tmdbId);
                }
              }}
            >
              {m.posterPath ? (
                <img src={`${TMDB_IMAGE_BASE}${m.posterPath}`} alt="" className="up-row-poster" />
              ) : (
                <div className="poster-placeholder up-row-poster" />
              )}
              <div className="up-row-body">
                <p className="show-name">{m.title}</p>
                <p className="muted small">{m.wantsToWatch ? "Want to watch" : "\u00a0"}</p>
              </div>
              <span className="up-row-date">{formatUpcomingDate(m.releaseDate ?? null)}</span>
            </div>
          ))}
        </div>
      </div>
      {openMovie !== null && <DetailsPanel kind="movie" tmdbId={openMovie} onClose={() => setOpenMovie(null)} />}

      {/* The app's own episode panel, same as Watch Next opens. canToggleWatched
          is false because these episodes have not aired: there is nothing to
          mark, and offering it would be a bug rather than a convenience. */}
      {openEpisode && (
        <EpisodeDetailsPanel
          show={{
            name: openEpisode.showName,
            imdbId: shows.find((sh) => sh.tmdbId === openEpisode.showId)?.imdbId,
          }}
          episode={openEpisode.episode}
          watched={false}
          watchCount={0}
          canToggleWatched={false}
          onToggleWatched={() => {}}
          onClose={() => setOpenEpisode(null)}
        />
      )}
    </>
  );
}

const MTW_CARD_WIDTH = 120;
const MTW_GAP = 14;
// Mobile doesn't measure: it shows a capped, horizontally scrollable strip
// of up to 5 movies, with the view-all tile as the 6th card.
const MTW_MOBILE_MAX = 5;

function MoviesHome({ onViewAll, filter }: { onViewAll: () => void; filter: MoodFilter | null }) {
  const wantToWatch = useLiveQuery(() => db.movies.filter((m) => !m.watched && m.wantsToWatch).toArray(), []);
  const [openDetails, setOpenDetails] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [fitCount, setFitCount] = useState(5); // sensible default before the first real measurement

  // Most recently added first, the same comparator as the Movies page's
  // "Recently added" sort: movies from before addedAt existed have it
  // undefined and deliberately sort as oldest.
  //
  // With a mood filter active the order changes to match strength instead,
  // since "how well does this fit what I asked for" is the only ordering
  // that makes sense once the user has stated what they want.
  const sorted = useMemo(() => {
    if (!wantToWatch) return undefined;
    if (filter) {
      const candidates = wantToWatch.map((m) => ({
        movie: m,
        ...movieToMoodCandidate(m),
      }));
      return rankByMoodFilter(candidates, filter).map((c) => c.movie);
    }
    return [...wantToWatch].sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
  }, [wantToWatch, filter]);

  // Real dynamic fit: measure the rail's actual rendered width (which
  // itself depends on the app shell, the side rail, and the viewport, not
  // just the viewport alone) and compute how many fixed-width cards
  // physically fit, no scrollbar needed. Recomputes on any resize via
  // ResizeObserver.
  //
  // The dependency below is the fix for the rail never filling wide
  // screens: the rail div only exists in the DOM once the query has
  // resolved AND is non-empty. With [] deps this effect ran exactly once,
  // on mount, against a still-null ref, so the observer never attached
  // and fitCount sat at its default forever regardless of window width.
  const railRendered = (sorted?.length ?? 0) > 0;
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    function recompute() {
      const width = el!.clientWidth;
      const count = Math.max(1, Math.floor((width + MTW_GAP) / (MTW_CARD_WIDTH + MTW_GAP)));
      setFitCount(count);
    }
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [railRendered]);

  if (!sorted) return <p className="muted">Loading...</p>;

  async function markWatched(tmdbId: number) {
    await db.movies.update(tmdbId, { watched: true, watchedAt: new Date().toISOString() });
  }

  const hasMore = sorted.length > (isMobile ? MTW_MOBILE_MAX : fitCount);
  // Desktop: if there's overflow, the last fitting slot becomes the "View
  // all" tile instead of a movie card, so movies + tile together still
  // exactly fill the measured width. Mobile: fixed cap of 5 movies, the
  // view-all tile rides along as a 6th card in the scrollable strip.
  const visible = isMobile
    ? sorted.slice(0, MTW_MOBILE_MAX)
    : sorted.slice(0, hasMore ? Math.max(1, fitCount - 1) : fitCount);

  return (
    <>
      <h2 className="section-title">Movies to Watch</h2>

      {sorted.length === 0 ? (
        <p className="muted">Nothing on your movie watchlist right now.</p>
      ) : (
        <div className="mtw-rail" ref={railRef}>
          {visible.map((m) => (
            <div key={m.tmdbId} className="mtw-card">
              {m.posterPath ? (
                <img
                  className="mtw-poster"
                  src={`${TMDB_IMAGE_BASE}${m.posterPath}`}
                  alt={m.title}
                  onClick={() => setOpenDetails(m.tmdbId)}
                />
              ) : (
                <div className="poster-placeholder mtw-poster" onClick={() => setOpenDetails(m.tmdbId)} />
              )}
              {/* The same overlay control the Movies page uses, rather than a
                  full-width button under the card: it keeps the rail reading
                  as a wall of posters and makes one interaction pattern for
                  "mark this watched" across both screens.

                  stopPropagation is not strictly required here (the badge is a
                  sibling of the poster, not nested inside its click target) but
                  it is kept to match Movies exactly, so neither copy can drift
                  into depending on the other's structure. */}
              <button
                className="watched-badge"
                onClick={(e) => {
                  e.stopPropagation();
                  markWatched(m.tmdbId);
                }}
                aria-label={`Mark ${m.title} watched`}
              >
                &#10003;
              </button>
              {/* Single-line ellipsis title (see .mtw-name): keeps every card
                  the same height however long the title is. Full title stays
                  available as a hover tooltip. */}
              <p className="show-name mtw-name" title={m.title} onClick={() => setOpenDetails(m.tmdbId)}>
                {m.title}
              </p>
            </div>
          ))}
          {hasMore && (
            <div className="mtw-card">
              <button type="button" className="mtw-view-all-tile" onClick={onViewAll} aria-label="View all movies to watch">
                <span className="mtw-view-all-count">+{sorted.length - visible.length}</span>
                <span>View all</span>
                <span aria-hidden="true">&rsaquo;</span>
              </button>
            </div>
          )}
        </div>
      )}
      {openDetails !== null && <DetailsPanel kind="movie" tmdbId={openDetails} onClose={() => setOpenDetails(null)} />}
    </>
  );
}

export default function Home({ onViewAllMovies }: { onViewAllMovies: () => void }) {
  const [openShow, setOpenShow] = useState<number | null>(null);
  const mood = useMoodSearch();

  // Mood search spans both lists on this page, so the candidate set is
  // assembled here rather than inside either child. Shows are restricted to
  // the followed/unarchived set that ShowsHome itself renders, so the model
  // never ranks titles that could not appear in the results anyway.
  const searchableShows = useLiveQuery(
    () => db.shows.filter((s) => s.isFollowed && !s.isArchived).toArray(),
    []
  );
  const searchableMovies = useLiveQuery(
    () => db.movies.filter((m) => !m.watched && m.wantsToWatch).toArray(),
    []
  );

  const candidates = useMemo<MoodCandidate[]>(
    () => [
      ...(searchableShows ?? []).map(showToMoodCandidate),
      ...(searchableMovies ?? []).map(movieToMoodCandidate),
    ],
    [searchableShows, searchableMovies]
  );

  // Counted the same way the two lists below filter, so the summary line
  // never claims a number the user cannot see.
  const resultCount = useMemo(
    () => (mood.filter ? candidates.filter((c) => matchesMoodFilter(c, mood.filter!)).length : 0),
    [candidates, mood.filter]
  );

  return (
    <div className="panel">
      {/* Every view needs exactly one h1 or the document outline starts at a
          sub-level. Home has no visible page title by design (the header
          carries the mark and the nav shows where you are), so the heading is
          screen-reader-only rather than redundant on screen. */}
      <h1 className="sr-only">Home</h1>

      <MoodSearch
        setup={mood.setup}
        filter={mood.filter}
        searching={mood.searching}
        dismissed={mood.dismissed}
        resultCount={resultCount}
        onSearch={(q) => mood.run(q, candidates)}
        onClear={mood.clear}
        onCancelSetup={mood.cancelSetup}
      />

      <ShowsHome onOpenShow={setOpenShow} filter={mood.filter} />

      <MoviesHome onViewAll={onViewAllMovies} filter={mood.filter} />

      {/* Coming up is calendar data, not recommendations, so a mood filter
          deliberately does not apply to it. */}
      <ComingUp />

      {openShow !== null && <DetailsPanel kind="show" tmdbId={openShow} onClose={() => setOpenShow(null)} />}
    </div>
  );
}
