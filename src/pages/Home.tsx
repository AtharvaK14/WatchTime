import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Episode } from "../db";
import { TMDB_IMAGE_BASE } from "../tmdb";
import { ensureEpisodesCached, findNextUpcoming } from "../lib/episodeSync";
import { getStaleDaysThreshold } from "../lib/showStatus";
import { markNextEpisodeWatched, recordEpisodeRewatch } from "../lib/watchEvents";
import { useIsMobile } from "../lib/useIsMobile";
import DetailsPanel from "../components/DetailsPanel";
import EmptyState from "../components/EmptyState";
import { WatchNextSkeleton, MovieRailSkeleton, LoadingAnnouncement } from "../components/Skeleton";
import { CheckCircleIcon, StackIcon, MoviesIcon, CheckIcon, SearchIcon } from "../components/icons";
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

// Beats in the mark-watched sequence. CONFIRM_MS matches the circle's
// fill/pulse in CSS; LEAVE_MS matches .wn-item's collapse. Keep them in sync
// with --dur-slow if that changes — they are timing, not easing, so they live
// here rather than being read back out of the stylesheet.
const CONFIRM_MS = 340;
const LEAVE_MS = 300;

/**
 * Sleeps, unless the user has asked for reduced motion — in which case every
 * beat collapses to zero and the write happens immediately. The CSS has its
 * own reduced-motion block; this keeps the JS timing honest alongside it, so
 * the sequence does not sit there waiting for animations that never play.
 */
function wait(ms: number): Promise<void> {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function EpisodeRow({
  row,
  confirming,
  onOpenShow,
  onOpenEpisode,
  onMarkWatched,
}: {
  row: Row;
  /** True between the tap and the row advancing: fills the circle green. */
  confirming: boolean;
  onOpenShow: (id: number) => void;
  onOpenEpisode: (row: Row) => void;
  onMarkWatched: (row: Row) => void;
}) {
  const isPremiere = row.nextEpisode?.episodeNumber === 1;
  const episodeCode = row.nextEpisode
    ? `S${String(row.nextEpisode.seasonNumber).padStart(2, "0")} · E${String(row.nextEpisode.episodeNumber).padStart(2, "0")}`
    : null;
  return (
    <div className="watch-next-row">
      {row.posterPath ? (
        <img
          src={`${TMDB_IMAGE_BASE}${row.posterPath}`}
          alt=""
          loading="lazy"
          decoding="async"
          onClick={() => onOpenShow(row.showId)}
        />
      ) : (
        <div className="poster-placeholder wn-poster" onClick={() => onOpenShow(row.showId)} />
      )}
      <div className="wn-body">
        {/* A real button, not a styled span, so it is keyboard reachable.
            Deliberately NOT .hit-slop: the episode block directly beneath is
            now its own button, and an overlaid slop area would sit on top of
            it and swallow those taps. The label is small, but WCAG 2.5.8's
            equivalent-control exception covers it — the 62x93 poster beside
            it opens exactly the same show. */}
        <button type="button" className="show-pill" onClick={() => onOpenShow(row.showId)}>
          {row.showName} &rsaquo;
        </button>
        {row.nextEpisode ? (
          // Keyed on the episode so React remounts this block when the row
          // advances, replaying .wn-episode-swap's entrance. Marking one
          // episode watched usually does not remove the row — it moves it on
          // to the next episode — so without this the text would simply
          // change underneath the finger with no indication anything moved.
          <div className="wn-episode-swap" key={row.nextEpisode.key}>
            {/* The episode block opens the same episode panel the season
                browser uses. A real button, not a click handler on a <p>, so
                it is keyboard reachable and announced as a control. */}
            <button type="button" className="wn-episode-button" onClick={() => onOpenEpisode(row)}>
              <span className="wn-episode-line">
                {episodeCode}
                {row.additionalCount > 0 && <span className="muted"> +{row.additionalCount}</span>}
              </span>
              <span className="wn-episode-name">{row.nextEpisode.name}</span>
              <span className="sr-only">Episode details</span>
            </button>
            {isPremiere && <span className="premiere-tag">Premiere</span>}
          </div>
        ) : (
          <p className="muted small">
            {row.category === "not-started"
              ? "Not started yet"
              : "More to watch (couldn't match the exact next episode against TMDB)"}
          </p>
        )}
      </div>
      <button
        className={`watch-toggle-circle hit-slop ${confirming ? "is-confirming" : ""}`}
        onClick={() => onMarkWatched(row)}
        aria-label={
          row.nextEpisode
            ? `${row.category === "not-started" ? "Start" : "Mark watched"}: ${row.showName} ${episodeCode}`
            : `No next episode available for ${row.showName}`
        }
        // Blocks a second tap landing while the first is still animating,
        // which would otherwise mark two episodes from one visible row.
        disabled={!row.nextEpisode || confirming}
      >
        <CheckIcon size={20} />
      </button>
    </div>
  );
}

function ShowsHome({
  onOpenShow,
  filter,
  onClearFilter,
}: {
  onOpenShow: (tmdbId: number) => void;
  filter: MoodFilter | null;
  // Lets the "no matches" empty state offer the action that resolves it,
  // rather than telling the user to go and find the control themselves.
  onClearFilter?: () => void;
}) {
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
  // Show ids currently mid-animation in the mark-watched sequence. Separate
  // states because a row can be confirming without ever leaving (the common
  // case, where the show still has episodes left).
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [leavingId, setLeavingId] = useState<number | null>(null);

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

  /**
   * Marks the next UNSEEN episode watched (starts a not-started show, or
   * advances an in-progress one). Never a rewatch: Watch Next only ever
   * points at unseen episodes, so this always creates a fresh record.
   *
   * The write is deliberately deferred behind two short animation beats:
   *
   *   1. CONFIRM — the circle fills green and pulses, so the tap is
   *      acknowledged before anything moves.
   *   2. LEAVE — only when this was the show's LAST unwatched episode, so
   *      the row is about to disappear. Collapsing its height first means
   *      the rows below glide up during the collapse, and by the time the
   *      record lands and the live query drops the row it is already at zero
   *      height — no jump. When more episodes remain the row stays put and
   *      the episode block cross-fades instead (see .wn-episode-swap).
   *
   * The write itself is never skipped: if the component unmounts mid-sequence
   * the timers are cleared but the awaited write still runs to completion.
   */
  async function markWatched(row: Row) {
    if (!row.nextEpisode || confirmingId !== null) return;

    const isLastEpisode = row.additionalCount === 0;
    setConfirmingId(row.showId);
    await wait(CONFIRM_MS);

    if (isLastEpisode) {
      setLeavingId(row.showId);
      await wait(LEAVE_MS);
    }

    await markNextEpisodeWatched(row.showId, row.nextEpisode);
    setConfirmingId(null);
    setLeavingId(null);
  }

  if (!shows || !allEpisodes || !allWatched) {
    return (
      <>
        <h3 className="section-title">Up next</h3>
        <LoadingAnnouncement label="Loading your shows" />
        <WatchNextSkeleton />
      </>
    );
  }

  // Three MUTUALLY EXCLUSIVE lists (see categorize() in lib/watchNext.ts).
  // Watch Next and the stale list sort by most recent PROGRESSION (rewatches
  // don't reorder them); Haven't Yet Started sorts by most recently added.
  const watchNext = rows.filter((r) => r.category === "watch-next").sort(byRecency);
  const stale = rows.filter((r) => r.category === "stale").sort(byRecency);
  const notStarted = rows.filter((r) => r.category === "not-started").sort(byAddedAt);
  const activeList = tab === "next" ? watchNext : tab === "stale" ? stale : notStarted;

  const TABS = [
    { key: "next" as const, label: "Watch next", count: watchNext.length },
    { key: "stale" as const, label: "Paused a while", count: stale.length },
    { key: "not-started" as const, label: "Not started", count: notStarted.length },
  ];

  return (
    <>
      <h3 className="section-title">
        Up next
        {activeList.length > 0 && <span className="section-count">{activeList.length}</span>}
      </h3>

      {/* role="tablist" was missing entirely before: these read as three
          unrelated buttons to a screen reader rather than as one control
          with a current selection. */}
      <div className="pill-tabs" role="tablist" aria-label="Show categories">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`pill-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count > 0 && <span className="pill-tab-count"> {t.count}</span>}
          </button>
        ))}
      </div>

      {syncing && (
        <>
          <p className="muted small" role="status">
            Syncing episode data from TMDB...
          </p>
          {activeList.length === 0 && <WatchNextSkeleton count={2} />}
        </>
      )}

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
        <EmptyState
          icon={SearchIcon}
          title="No matches in this list"
          body="Nothing you're partway through fits that search. The other tabs may still have results."
          action={onClearFilter ? { label: "Clear search", onClick: onClearFilter } : undefined}
        />
      )}

      {activeList.length === 0 && !syncing && !filter && (
        <EmptyState
          icon={tab === "next" ? CheckCircleIcon : StackIcon}
          title={
            tab === "next"
              ? "Nothing queued up"
              : tab === "stale"
                ? "Nothing paused"
                : "Everything's been started"
          }
          body={
            tab === "next"
              ? "You're caught up on everything you're partway through. If you expected shows here, check Diagnostics in Settings, or re-import using the newer TV Time export format."
              : tab === "stale"
                ? "Everything you've started has been watched recently."
                : "Every show in your library is already underway."
          }
        />
      )}

      <div className="watch-next-list">
        {activeList.map((row) => (
          // .wn-item is the collapse wrapper; the row keeps its own padding
          // and border inside it so nothing about the card changes as it
          // closes, only its height.
          <div key={row.showId} className={`wn-item ${leavingId === row.showId ? "is-leaving" : ""}`}>
            <EpisodeRow
              row={row}
              confirming={confirmingId === row.showId}
              onOpenShow={onOpenShow}
              onOpenEpisode={(r) => r.nextEpisode && setOpenEpisode({ showId: r.showId, episode: r.nextEpisode })}
              onMarkWatched={markWatched}
            />
          </div>
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

function formatUpcomingDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((date.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface UpcomingEpisodeRow {
  showId: number;
  showName: string;
  posterPath: string | null;
  episode: Episode;
}

/**
 * Upcoming episodes (confirmed future air_date, across followed shows) and
 * movies releasing this calendar month (from Movie.releaseDate, backfilled
 * by useShowStats/useMovieStats for libraries that predate that field).
 * Deliberately reuses data already loaded elsewhere on Home rather than
 * issuing new network requests, this only reads db.episodes, which
 * ShowsHome's sync effect already keeps populated for every followed show.
 */
function ComingUp({ onOpenShow }: { onOpenShow: (tmdbId: number) => void }) {
  const shows = useLiveQuery(() => db.shows.filter((s) => s.isFollowed && !s.isArchived).toArray(), []);
  const allEpisodes = useLiveQuery(() => db.episodes.toArray(), []);
  const movies = useLiveQuery(() => db.movies.toArray(), []);
  const [openMovie, setOpenMovie] = useState<number | null>(null);

  const upcomingEpisodes = useMemo<UpcomingEpisodeRow[]>(() => {
    if (!shows || !allEpisodes) return [];
    const episodesByShow = new Map<number, Episode[]>();
    for (const ep of allEpisodes) {
      const list = episodesByShow.get(ep.showId);
      if (list) list.push(ep);
      else episodesByShow.set(ep.showId, [ep]);
    }
    const rows: UpcomingEpisodeRow[] = [];
    for (const show of shows) {
      const next = findNextUpcoming(episodesByShow.get(show.tmdbId) ?? []);
      if (next) rows.push({ showId: show.tmdbId, showName: show.name, posterPath: show.posterPath, episode: next });
    }
    rows.sort((a, b) => (a.episode.airDate as string).localeCompare(b.episode.airDate as string));
    return rows.slice(0, 6);
  }, [shows, allEpisodes]);

  const releasingThisMonth = useMemo(() => {
    if (!movies) return [];
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthEndExclusive = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
    return movies
      .filter((m) => m.releaseDate && m.releaseDate >= monthStart && m.releaseDate < monthEndExclusive)
      .sort((a, b) => (a.releaseDate as string).localeCompare(b.releaseDate as string))
      .slice(0, 6);
  }, [movies]);

  if (!shows || !allEpisodes || !movies) return null;
  if (upcomingEpisodes.length === 0 && releasingThisMonth.length === 0) return null;

  return (
    <>
      <h3 className="section-title">Coming up</h3>
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
              onClick={() => onOpenShow(row.showId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenShow(row.showId);
                }
              }}
            >
              {row.posterPath ? (
                <img
                  src={`${TMDB_IMAGE_BASE}${row.posterPath}`}
                  alt=""
                  className="up-row-poster"
                  loading="lazy"
                  decoding="async"
                />
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
                <img
                  src={`${TMDB_IMAGE_BASE}${m.posterPath}`}
                  alt=""
                  className="up-row-poster"
                  loading="lazy"
                  decoding="async"
                />
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

  if (!sorted) {
    return (
      <>
        <h3 className="section-title">Movies to watch</h3>
        <MovieRailSkeleton />
      </>
    );
  }

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
      <h3 className="section-title">
        Movies to watch
        {sorted.length > 0 && <span className="section-count">{sorted.length}</span>}
      </h3>

      {sorted.length === 0 ? (
        <EmptyState
          icon={MoviesIcon}
          title="Watchlist is empty"
          body="Films you mark as want-to-watch show up here, newest first."
          action={{ label: "Browse your movies", onClick: onViewAll }}
        />
      ) : (
        <div className="mtw-rail" ref={railRef}>
          {visible.map((m) => (
            <div key={m.tmdbId} className="mtw-card">
              {m.posterPath ? (
                <img
                  className="mtw-poster"
                  src={`${TMDB_IMAGE_BASE}${m.posterPath}`}
                  alt={m.title}
                  loading="lazy"
                  decoding="async"
                  onClick={() => setOpenDetails(m.tmdbId)}
                />
              ) : (
                <div className="poster-placeholder mtw-poster" onClick={() => setOpenDetails(m.tmdbId)} />
              )}
              {/* Single-line ellipsis title (see .mtw-name), so the button
                  below sits at the same height on every card; the full
                  title is still available as a hover tooltip. */}
              <p className="show-name mtw-name" title={m.title} onClick={() => setOpenDetails(m.tmdbId)}>
                {m.title}
              </p>
              {/* "Watched", not "Mark watched": at 124px of card width the
                  longer label renders ~109px wide, which fills the row and
                  makes the bottom-right anchoring invisible. The short label
                  leaves real space beside it so the button reads as anchored.
                  aria-label keeps the full action clear to screen readers.
                  .hit-slop restores the 44px target without changing the
                  painted size. */}
              <button
                className="hit-slop"
                onClick={() => markWatched(m.tmdbId)}
                aria-label={`Mark ${m.title} watched`}
              >
                Watched
              </button>
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

      <ShowsHome onOpenShow={setOpenShow} filter={mood.filter} onClearFilter={mood.clear} />

      <MoviesHome onViewAll={onViewAllMovies} filter={mood.filter} />

      {/* Coming up is calendar data, not recommendations, so a mood filter
          deliberately does not apply to it. */}
      <ComingUp onOpenShow={setOpenShow} />

      {openShow !== null && <DetailsPanel kind="show" tmdbId={openShow} onClose={() => setOpenShow(null)} />}
    </div>
  );
}
