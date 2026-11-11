import { useEffect, useMemo, useRef, useState, type AnimationEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { App as CapacitorApp } from "@capacitor/app";
import { db, type Episode, type Movie } from "../db";
import { TMDB_IMAGE_BASE } from "../tmdb";
import { ensureEpisodesCached, IN_FLIGHT_REFRESH_MS } from "../lib/episodeSync";
import {
  buildReleasingThisMonth,
  buildUpcomingEpisodeRows,
  formatUpcomingDate,
  releaseKindLabel,
  releaseStatusLabel,
  type ReleasingThisMonthRow,
  type UpcomingEpisodeRow,
} from "../lib/comingUp";
import { backfillTypedReleaseDates, moviesNeedingTypedDates } from "../lib/releaseDates";
import { getStaleDaysThreshold } from "../lib/showStatus";
import {
  markEpisodesUnwatched,
  markNextEpisodeWatched,
  recordEpisodeRewatch,
  removeLatestEpisodeViewing,
  setEpisodesWatchedOnce,
} from "../lib/watchEvents";
import { titleQuickActionProps } from "../lib/titleQuickActions";
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
import {
  buildWatchNextRows,
  byAddedAt,
  byRecency,
  hasNextAfterWatching,
  type WatchNextRow as Row,
} from "../lib/watchNext";
import { resumeWatchingShow } from "../lib/stoppedWatching";
import { useFlipLayout } from "../lib/useFlipLayout";
import { useWatchedTransitions, type DisplayRow, type WatchedTransition } from "../lib/useWatchedTransitions";
import { libraryKey, removalClass, useRemovalExit, type RemovalPhase } from "../lib/libraryRemoval";
import { markMovieWatchedFromCard, useMovieWatchedExit, watchedClass, type WatchedSlot } from "../lib/movieWatched";
import { isOnWatchlist } from "../lib/watchlist";
import { requestNotificationSync } from "../lib/notifications";
import MovieWatchedOverlay from "../components/MovieWatchedOverlay";
import HomeMediaSwitch from "../components/HomeMediaSwitch";
import type { HomeMedia } from "../lib/homeMedia";
import { CheckIcon } from "../components/icons";
import RatingChip from "../components/RatingChip";
import { backfillMovieRatings, moviesNeedingRating } from "../lib/ratings";

type UpNextTab = "next" | "stale" | "not-started" | "stopped";

/** "S3 E1": the episode code every redesigned Home row uses. */
function episodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${seasonNumber} E${episodeNumber}`;
}

/**
 * The empty state for a whole Home mode: one sentence of what will appear
 * here, and the one place to go to make it appear.
 */
function HomeEmpty({ title, body, onOpenDiscover }: { title: string; body: string; onOpenDiscover: () => void }) {
  return (
    <div className="home-empty">
      <p className="home-empty-title">{title}</p>
      <p className="home-empty-body">{body}</p>
      <button type="button" className="home-empty-action" onClick={onOpenDiscover}>
        Open Discover
      </button>
    </div>
  );
}

/**
 * How long the app can be away before coming back re-syncs episode lists.
 * The same interval episodeSync re-reads a live season at, so a resume after
 * that long is exactly when a re-read can find something new.
 */
const EPISODE_RESYNC_MS = IN_FLIGHT_REFRESH_MS;

// Stable key functions for useRemovalExit, one per list shape on this page.
const watchNextKey = (d: DisplayRow) => libraryKey("show", d.row.showId);
const upcomingKey = (row: UpcomingEpisodeRow) => libraryKey("show", row.showId);
const releasingKey = (row: ReleasingThisMonthRow) => libraryKey("movie", row.movie.tmdbId);
const movieKey = (movie: Movie) => libraryKey("movie", movie.tmdbId);
// The movie lists run the watched hold first and the removal hold over its
// output, so their key functions read through the watched slot.
const releasingSlotKey = (slot: WatchedSlot<ReleasingThisMonthRow>) => releasingKey(slot.item);
const movieSlotKey = (slot: WatchedSlot<Movie>) => movieKey(slot.item);

/**
 * The confirmation a card shows while its watched sequence plays: the card
 * turns translucent green (see .wn-watched-overlay) with a tick in the middle,
 * or with "That's all folks!" when the show has nothing left to watch.
 *
 * Both marks share one shape and one entrance, the white fill of the tick
 * control the user just pressed, so the two outcomes read as one interaction
 * with two endings. role="status" so the outcome is announced as well as drawn.
 */
function WatchedOverlay({ hasNext }: { hasNext: boolean }) {
  return (
    <div className="wn-watched-overlay" role="status">
      {hasNext ? (
        <>
          <span className="wn-watched-mark" aria-hidden="true">
            &#10003;
          </span>
          <span className="sr-only">Marked as watched</span>
        </>
      ) : (
        <>
          <span className="sr-only">Marked as watched. </span>
          <span className="wn-watched-mark wn-watched-folks">That's all folks!</span>
        </>
      )}
    </div>
  );
}

function EpisodeRow({
  row,
  transition,
  removal,
  onOpenShow,
  onOpenEpisode,
  onMarkWatched,
  onResume,
}: {
  row: Row;
  /** Set while this card's watched sequence plays. See useWatchedTransitions. */
  transition?: WatchedTransition;
  /** Set while the show is leaving because it was removed from the library. See useRemovalExit. */
  removal?: RemovalPhase;
  onOpenShow: (id: number) => void;
  onOpenEpisode: (row: Row) => void;
  onMarkWatched: (row: Row) => void;
  /** Stopped rows only: puts the show back into the automatic categories. */
  onResume: (row: Row) => void;
}) {
  const isPremiere = row.nextEpisode?.episodeNumber === 1;
  const stopped = row.category === "stopped";
  const premiere = isPremiere && !stopped ? (row.nextEpisode?.seasonNumber === 1 ? "Series premiere" : "Season premiere") : null;
  const more = row.additionalCount > 0 ? `+${row.additionalCount} more` : "";
  return (
    <div
      className={`watch-next-row${transition ? ` is-${transition.phase}` : ""}${removalClass(removal)}`}
      {...titleQuickActionProps({
        kind: "show",
        tmdbId: row.showId,
        name: row.showName,
        onViewDetails: () => onOpenShow(row.showId),
      })}
    >
      {row.posterPath ? (
        <img src={`${TMDB_IMAGE_BASE}${row.posterPath}`} alt={row.showName} onClick={() => onOpenShow(row.showId)} />
      ) : (
        <div className="poster-placeholder wn-poster" onClick={() => onOpenShow(row.showId)} />
      )}
      <div className="wn-body">
        {/* Plain text in the card's title style, not a capsule: the show name
            is the card's heading. Still a control, and now a real button. */}
        <button type="button" className="wn-show-name" onClick={() => onOpenShow(row.showId)}>
          {row.showName}
        </button>
        {row.nextEpisode ? (
          <>
            {/* The episode block opens the same episode panel the season
                browser uses. A real button, not a click handler on a <p>, so
                it is keyboard reachable and announced as a control. */}
            <button type="button" className="wn-episode-button" onClick={() => onOpenEpisode(row)}>
              <span className="wn-episode-line">
                <span className="wn-episode-code">
                  {episodeCode(row.nextEpisode.seasonNumber, row.nextEpisode.episodeNumber)}
                </span>
                <span className="wn-episode-name">
                  <span aria-hidden="true">· </span>
                  {row.nextEpisode.name}
                </span>
              </span>
              <span className="sr-only">Episode details</span>
            </button>
            {/* One quiet metadata line instead of filled tags. Still two
                different claims and a row can carry both: New describes the
                SHOW (something has been released that the user has not seen),
                the premiere describes the EPISODE being offered (it opens a
                season). They coincide on a premiere that just dropped and
                diverge on a returning series the user had not finished, where
                New is the only thing explaining why the show is back in this
                list at all. Only "New" keeps the accent colour. */}
            {(more || row.newlyAvailable || premiere) && (
              <p className="wn-meta">
                {more}
                {row.newlyAvailable && (
                  <>
                    {more && " · "}
                    <span className="wn-new" title={`Latest release: ${row.newlyAvailableAt}`}>
                      New
                    </span>
                  </>
                )}
                {premiere && (
                  <>
                    {(more || row.newlyAvailable) && " · "}
                    {premiere}
                  </>
                )}
              </p>
            )}
            {/* Why a show with new episodes is not in Watch Next. Without
                this the categorisation looks exactly like the bug it used to
                be — the honest reason is that the user never finished what was
                already out, and the row is pointing at that, not at the new
                episode. */}
            {row.releasedButBehind && (
              <p className="wn-meta wn-behind-note">
                New episodes have aired, but there are earlier ones you haven't watched.
              </p>
            )}
          </>
        ) : (
          <p className="wn-meta">
            {row.category === "not-started"
              ? "Not started yet"
              : "More to watch (couldn't match the exact next episode against TMDB)"}
          </p>
        )}
      </div>
      {/* A stopped show's row offers the one action that makes sense for it.
          Marking an episode watched from here would be resuming it by a side
          effect, which is exactly the kind of state change this state exists
          to stop happening on its own. */}
      {stopped ? (
        <button className="wn-resume-btn" onClick={() => onResume(row)}>
          Resume
        </button>
      ) : (
        <button
          className="watch-toggle-circle"
          onClick={() => onMarkWatched(row)}
          aria-label={row.category === "not-started" ? "Start watching" : "Mark watched"}
          disabled={!row.nextEpisode}
        >
          <CheckIcon size={20} />
        </button>
      )}
      {/* Over the card for the green state and while it flips away. Gone by
          the time the next episode flips in: that side is a fresh card. */}
      {transition && transition.phase !== "flip-in" && <WatchedOverlay hasNext={transition.hasNext} />}
    </div>
  );
}

/**
 * Marks a slot as having played its entrance, so it never plays it again.
 *
 * Needed because the browser restarts a CSS animation whenever its element is
 * moved in the DOM, and reordering keyed rows is exactly that: React moves the
 * nodes around the one that changed. Every row shuffled by a re-sort used to
 * fade in again from nothing, which read as the whole list being rebuilt.
 * A DOM attribute rather than state, because nothing needs to re-render for it.
 */
function markEntered(e: AnimationEvent<HTMLDivElement>) {
  if (e.target === e.currentTarget) e.currentTarget.dataset.entered = "";
}

/** The four Up Next lists, in the order the tabs show them. Short labels so all four fit a phone. */
const UP_NEXT_TABS: { value: UpNextTab; label: string }[] = [
  { value: "next", label: "Watch next" },
  { value: "stale", label: "Lapsed" },
  { value: "not-started", label: "Not started" },
  { value: "stopped", label: "Stopped" },
];

const UP_NEXT_EMPTY: Record<UpNextTab, string> = {
  next: "Nothing queued up. If shows seem to be missing, Settings › Diagnostics can help.",
  stale: "Nothing here. Everything you've started was watched recently.",
  "not-started": "Every show in your library has been started.",
  stopped: "Shows you stop watching appear here and can be resumed.",
};

function ShowsHome({
  onOpenShow,
  filter,
  onOpenDiscover,
}: {
  onOpenShow: (tmdbId: number) => void;
  filter: MoodFilter | null;
  onOpenDiscover: () => void;
}) {
  // Archived shows are deliberately INCLUDED now. They are the Stopped
  // Watching tab, and a state the user set is one they have to be able to see
  // and undo; filtering them out of the query was what made stopping a show a
  // one-way door. categorize() puts them in their own category before any
  // other rule runs, so they cannot leak into the other three lists.
  const shows = useLiveQuery(() => db.shows.filter((s) => s.isFollowed).toArray(), []);
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
  const [tab, setTab] = useState<UpNextTab>("next");
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
  //
  // Keyed on WHICH shows are followed, not on the shows array itself. The
  // array is a new object after every write to the shows table, and marking
  // an episode watched is one (it bumps Show.lastWatchedAt). Keyed on the
  // array, every tick threw away the sync in progress and restarted a full
  // TMDB walk of the library from the first show, and the "Syncing..." line
  // appearing and disappearing above the list shoved every card down and back
  // up again. A watch changes nothing this sync fetches; following or
  // unfollowing a show does, and still restarts it.
  //
  // Also re-run when the app comes back to the foreground after a long time
  // away (resyncTick). On Android, Home stays mounted for as long as the
  // process lives, which can be days in the background, and this effect used
  // to run only on mount - so an episode list TMDB filled in or re-dated in
  // the meantime never reached the cache, and nothing downstream (Coming Up,
  // the release notifications) could know about it.
  const followedIds = shows?.map((s) => s.tmdbId).join(",");
  const showsForSync = useRef(shows);
  showsForSync.current = shows;
  const lastSyncStartedAt = useRef(0);
  const [resyncTick, setResyncTick] = useState(0);
  useEffect(() => {
    const handle = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive && Date.now() - lastSyncStartedAt.current >= EPISODE_RESYNC_MS) setResyncTick((t) => t + 1);
    });
    return () => {
      handle.then((h) => h.remove()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const toSync = showsForSync.current;
    if (!toSync) return;
    let cancelled = false;
    lastSyncStartedAt.current = Date.now();
    async function sync() {
      setSyncing(true);
      setSyncErrors([]);
      const failures: string[] = [];
      for (const show of toSync!) {
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
        // The schedule was built at launch from the cache as it was then. A
        // season this sync just fetched has to reach it now, not at the next
        // resume, which may be after the release.
        requestNotificationSync();
      }
    }
    sync();
    return () => {
      cancelled = true;
    };
  }, [followedIds, resyncTick]);

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

  async function resume(row: Row) {
    // Nothing is recalculated by hand: the live queries re-run, categorize()
    // sees a show that is no longer stopped, and it lands wherever its history
    // and release state now put it — which for a show whose new season arrived
    // while it was stopped is Watch Next.
    await resumeWatchingShow(row.showId);
  }

  // Four MUTUALLY EXCLUSIVE lists (see categorize() in lib/watchNext.ts).
  // Watch Next and the stale list sort by most recent PROGRESSION (rewatches
  // don't reorder them); Haven't Yet Started sorts by most recently added.
  // Stopped sorts by last progression like the other history-bearing lists:
  // the most recently abandoned is the one most likely to be resumed.
  //
  // Memoised, and above the loading return, because the watched sequence
  // below is a hook that takes the active list and reacts to it changing.
  const lists = useMemo<Record<UpNextTab, Row[]>>(
    () => ({
      next: rows.filter((r) => r.category === "watch-next").sort(byRecency),
      stale: rows.filter((r) => r.category === "stale").sort(byRecency),
      "not-started": rows.filter((r) => r.category === "not-started").sort(byAddedAt),
      stopped: rows.filter((r) => r.category === "stopped").sort(byRecency),
    }),
    [rows]
  );

  // Marking an episode watched plays out on the card instead of the list
  // rebuilding under the user's thumb: see useWatchedTransitions for the
  // sequence, and useFlipLayout for how the other cards make room.
  const listRef = useRef<HTMLDivElement>(null);
  const captureLayout = useFlipLayout(listRef);
  const {
    display: watchedDisplay,
    start: startWatchedSequence,
    reset: resetWatchedSequences,
  } = useWatchedTransitions({ list: tab, rows: lists[tab], beforeLayoutChange: captureLayout });
  // A show removed from the library through a panel opened from this list
  // stays on its card until the panel closes, then is highlighted and leaves,
  // with the cards below gliding up. See lib/libraryRemoval.ts.
  const display = useRemovalExit(watchedDisplay, watchNextKey, captureLayout, tab);

  function selectTab(next: UpNextTab) {
    if (next === tab) return;
    // A card mid-sequence belongs to the list it was tapped in. Its watch is
    // already recorded, so the new tab simply shows the result.
    resetWatchedSequences();
    setTab(next);
  }

  function markWatched(row: Row) {
    const episode = row.nextEpisode;
    if (!episode || !allEpisodes || !allWatched) return;
    // Worked out now, from the library as it stands, so the card can say
    // whether there is more to watch before the write has even landed.
    const hasNext = hasNextAfterWatching(allEpisodes, allWatched, row.showId, episode.key);
    // Marks the next UNSEEN episode watched (starts a not-started show, or
    // advances an in-progress one). Never a rewatch: Watch Next only ever
    // points at unseen episodes now, so this always creates a fresh record.
    // It is written immediately; only the card's exit waits.
    startWatchedSequence(row, hasNext, () => markNextEpisodeWatched(row.showId, episode));
  }

  if (!shows || !allEpisodes || !allWatched) return <p className="muted">Loading...</p>;

  if (shows.length === 0) {
    return (
      <HomeEmpty
        title="No shows yet"
        body="Shows you add from Discover appear here with the next episode to watch."
        onOpenDiscover={onOpenDiscover}
      />
    );
  }

  return (
    <>
      {/* This heading is not decoration. .section-title:first-of-type drops the
          divider and top margin from whichever heading comes first, so while
          this section had none, "Coming Up" inherited that treatment and the
          sections ran together with nothing between them. */}
      <h2 className="section-title">Up Next</h2>

      {/* Four answers to one question, in one control. The row scrolls
          sideways if a phone is too narrow for all four. */}
      <div className="pill-tabs" role="group" aria-label="Up Next lists">
        {UP_NEXT_TABS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={`pill-tab ${tab === value ? "active" : ""}`}
            aria-pressed={tab === value}
            onClick={() => selectTab(value)}
          >
            {label}
            {lists[value].length > 0 && <span className="pill-tab-count">{lists[value].length}</span>}
          </button>
        ))}
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

      {/* Counted off what is on screen rather than the live list, so the last
          card in a list does not have "Nothing here" printed above it while it
          is still playing its exit. */}
      {display.length === 0 && !syncing && filter && (
        <p className="muted">Nothing in this list matches that search. Clear it to see everything again.</p>
      )}

      {display.length === 0 && !syncing && !filter && <p className="muted">{UP_NEXT_EMPTY[tab]}</p>}

      <div className="watch-next-list" ref={listRef}>
        {display.map(({ item: { row, transition }, removal }) => (
          // The slot is what the list lays out and glides (data-flip-key); the
          // card inside it is what flips. Split so the two motions are on
          // different elements and can never overwrite each other's transform.
          <div key={row.showId} className="wn-slot" data-flip-key={row.showId} onAnimationEnd={markEntered}>
            <EpisodeRow
              row={row}
              transition={transition}
              removal={removal}
              onOpenShow={onOpenShow}
              onOpenEpisode={(r) => r.nextEpisode && setOpenEpisode({ showId: r.showId, episode: r.nextEpisode })}
              onMarkWatched={markWatched}
              onResume={resume}
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
          // The show-title capsule, same control the widget overlay renders.
          // Here it swaps this layer for the show's own panel; the panel plays
          // its exit on the way out (dismissOnOpenSeries) so the two cross
          // over instead of stacking.
          onOpenSeries={() => onOpenShow(openEpisode.showId)}
          dismissOnOpenSeries
          streamingShowId={openEpisode.showId}
          // Deliberately stays open on toggle, matching the season browser:
          // the panel re-renders from live data so the tick and the rewatch
          // count update in place.
          onToggleWatched={async () => {
            if (openEpisodeWatch) await markEpisodesUnwatched(openEpisode.showId, [openEpisode.episode]);
            else await markNextEpisodeWatched(openEpisode.showId, openEpisode.episode);
          }}
          onWatchAgain={() => recordEpisodeRewatch(openEpisode.showId, [openEpisode.episode])}
          onWatchedOnce={() => setEpisodesWatchedOnce(openEpisode.showId, [openEpisode.episode])}
          onRemoveLatestViewing={() => removeLatestEpisodeViewing(openEpisode.showId, openEpisode.episode)}
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
function ComingUp({ section }: { section: "episodes" | "releases" }) {
  const shows = useLiveQuery(() => db.shows.filter((s) => s.isFollowed && !s.isArchived).toArray(), []);
  const allEpisodes = useLiveQuery(() => db.episodes.toArray(), []);
  // Watch history decides which shows are actively followed: Upcoming
  // episodes uses the same viewing state as the Up Next tabs above it.
  const allWatched = useLiveQuery(() => db.watchedEpisodes.toArray(), []);
  const movies = useLiveQuery(() => db.movies.toArray(), []);
  const [openMovie, setOpenMovie] = useState<number | null>(null);
  // Tapping an upcoming episode opens THAT episode, matching the Coming Up
  // widget. It used to open the show's panel, which made the user hunt for the
  // episode they had just pointed at.
  const [openEpisode, setOpenEpisode] = useState<UpcomingEpisodeRow | null>(null);
  // Where the episode panel's show-title capsule goes. Local to this section
  // rather than lifted to Home: the movie panel below is already opened the
  // same way, and a section that owns its own overlays stays movable.
  const [openShow, setOpenShow] = useState<number | null>(null);

  const upcomingEpisodes = useMemo<UpcomingEpisodeRow[]>(
    () =>
      !shows || !allEpisodes || !allWatched
        ? []
        : buildUpcomingEpisodeRows(shows, allEpisodes, allWatched, getStaleDaysThreshold()),
    [shows, allEpisodes, allWatched]
  );

  // Watchlist movies only, all of them: see buildReleasingThisMonth.
  const releasingThisMonth = useMemo(() => (!movies ? [] : buildReleasingThisMonth(movies)), [movies]);

  // Theatrical vs digital needs TMDB's typed release dates. Looked up here for
  // movies whose release could matter now and whose stored dates are missing
  // or more than a week old (see moviesNeedingTypedDates); the same rule the
  // notification scheduler uses, so the two never disagree about a movie. A
  // visit to Home normally costs no request at all.
  const typedDatesNeeded = movies ? moviesNeedingTypedDates(movies).map((m) => m.tmdbId).join(",") : "";
  const moviesForBackfill = useRef(movies);
  moviesForBackfill.current = movies;
  useEffect(() => {
    // Home mounts one ComingUp per mode; only the one that shows releases
    // looks dates up, so the requests are never made twice.
    if (section !== "releases" || !typedDatesNeeded || !moviesForBackfill.current) return;
    let cancelled = false;
    // A refreshed date can move a release into or out of the notification
    // window as well as this list.
    backfillTypedReleaseDates(moviesForBackfill.current, () => cancelled).then(() => {
      if (!cancelled) requestNotificationSync();
    });
    return () => {
      cancelled = true;
    };
  }, [typedDatesNeeded, section]);

  // Removed titles leave these columns the same way they leave every other
  // list: held until their panel closes, then highlighted and gone. A movie
  // marked watched from its panel leaves Releasing this month the same way,
  // after showing the watched tick.
  const upcomingListRef = useRef<HTMLDivElement>(null);
  const releasingListRef = useRef<HTMLDivElement>(null);
  const captureUpcoming = useFlipLayout(upcomingListRef);
  const captureReleasing = useFlipLayout(releasingListRef);
  const upcomingDisplay = useRemovalExit(upcomingEpisodes, upcomingKey, captureUpcoming);
  const releasingWatched = useMovieWatchedExit(releasingThisMonth, releasingKey, captureReleasing);
  const releasingDisplay = useRemovalExit(releasingWatched, releasingSlotKey, captureReleasing);

  if (!shows || !allEpisodes || !allWatched || !movies) return null;
  // Counted off what is on screen, so the section does not vanish under a
  // last card that is still playing its exit. Each mode shows its own list,
  // and a mode with nothing coming up shows no section at all.
  if ((section === "episodes" ? upcomingDisplay.length : releasingDisplay.length) === 0) return null;

  return (
    <>
      <h2 className="section-title">Coming Up</h2>
      <p className="section-sub">{section === "episodes" ? "Upcoming episodes" : "Releasing this month"}</p>
      {section === "episodes" && (
        <div className="coming-up-list" ref={upcomingListRef}>
          {upcomingDisplay.map(({ item: row, removal }) => (
            <div
              key={row.showId}
              data-flip-key={row.showId}
              className={`up-row${removalClass(removal)}`}
              role="button"
              tabIndex={0}
              {...titleQuickActionProps({
                kind: "show",
                tmdbId: row.showId,
                name: row.showName,
                onViewDetails: () => setOpenShow(row.showId),
              })}
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
                <p className="up-row-code">{episodeCode(row.episode.seasonNumber, row.episode.episodeNumber)}</p>
              </div>
              <span className="up-row-date">{formatUpcomingDate(row.episode.airDate)}</span>
            </div>
          ))}
        </div>
      )}
      {section === "releases" && (
        <div className="coming-up-list" ref={releasingListRef}>
          {releasingDisplay.map(({ item: { item: { movie: m, date, releaseKind }, watched, staying }, removal }) => (
            <div
              key={m.tmdbId}
              data-flip-key={m.tmdbId}
              className={`up-row${removalClass(removal)}${watchedClass(watched, staying)}`}
              role="button"
              tabIndex={0}
              {...titleQuickActionProps({
                kind: "movie",
                tmdbId: m.tmdbId,
                name: m.title,
                onViewDetails: () => setOpenMovie(m.tmdbId),
              })}
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
                {/* The release type rides on the status line rather than the
                    artwork or the title: the poster here is a 34px thumbnail
                    with no room for a label, and the title keeps its single
                    line. No tag at all when the stored dates cannot say which
                    release this is - see releaseThisMonth().

                    Already Watched takes precedence over Want to watch; see
                    releaseStatusLabel. The non-breaking space keeps rows with
                    neither the same height as the rest. */}
                <p className="muted small up-row-meta">
                  {releaseKind && <span className="release-tag">{releaseKindLabel(releaseKind)}</span>}
                  <span className="up-row-status">{releaseStatusLabel(m) ?? "\u00a0"}</span>
                </p>
              </div>
              <span className="up-row-date">{formatUpcomingDate(date)}</span>
              <MovieWatchedOverlay phase={watched} staying={staying} tmdbId={m.tmdbId} />
            </div>
          ))}
        </div>
      )}
      {openMovie !== null && <DetailsPanel kind="movie" tmdbId={openMovie} onClose={() => setOpenMovie(null)} />}
      {openShow !== null && <DetailsPanel kind="show" tmdbId={openShow} onClose={() => setOpenShow(null)} />}

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
          onOpenSeries={() => setOpenShow(openEpisode.showId)}
          dismissOnOpenSeries
          streamingShowId={openEpisode.showId}
          onClose={() => setOpenEpisode(null)}
        />
      )}
    </>
  );
}

/** A stable empty list for while the query loads, so the removal memo is not recomputed every render. */
const NO_MOVIES: Movie[] = [];

// Movies to Watch is two rows of framed poster cards. Phones always fit three
// per row; wider screens fit as many cards of at least MTW_MIN_CARD as the
// grid's measured width allows (the same numbers as .mtw-rail's columns).
const MTW_MIN_CARD = 160;
const MTW_GAP = 16;
const MTW_MOBILE_COLUMNS = 3;
const MTW_ROWS = 2;

function MoviesHome({
  onViewAll,
  filter,
  onOpenDiscover,
}: {
  onViewAll: () => void;
  filter: MoodFilter | null;
  onOpenDiscover: () => void;
}) {
  const wantToWatch = useLiveQuery(() => db.movies.filter(isOnWatchlist).toArray(), []);
  const [openDetails, setOpenDetails] = useState<number | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [fitColumns, setFitColumns] = useState(6); // sensible default before the first real measurement

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

  // Held across the whole sorted list, before the rail is cut to what fits,
  // so a removed card keeps its place while it leaves and the next movie
  // slides in behind it rather than everything shifting under the highlight.
  // The same hold for a movie ticked as watched: it shows the tick on its
  // poster, then leaves the rail, and the rest close up behind it.
  const captureRail = useFlipLayout(railRef);
  const watchedDisplay = useMovieWatchedExit(sorted ?? NO_MOVIES, movieKey, captureRail);
  const display = useRemovalExit(watchedDisplay, movieSlotKey, captureRail);

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
  const railRendered = display.length > 0;
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    function recompute() {
      const width = el!.clientWidth;
      setFitColumns(Math.max(1, Math.floor((width + MTW_GAP) / (MTW_MIN_CARD + MTW_GAP))));
    }
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [railRendered]);

  // Two full rows: every card on screen is a real movie, and "See all" in the
  // header is the way to the rest.
  const visible = display.slice(0, (isMobile ? MTW_MOBILE_COLUMNS : fitColumns) * MTW_ROWS);

  // Ratings for the cards on screen that have never had one looked up (rows
  // from before ratings were stored). Keyed on which ids those are, so a
  // rating landing (a write to db.movies) does not restart the lookup.
  const needRating = moviesNeedingRating(visible.map((d) => d.item.item));
  const needRatingIds = needRating.map((m) => m.tmdbId).join(",");
  const needRatingRef = useRef(needRating);
  needRatingRef.current = needRating;
  useEffect(() => {
    if (!needRatingIds) return;
    let cancelled = false;
    backfillMovieRatings(needRatingRef.current, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [needRatingIds]);

  if (!sorted) return <p className="muted">Loading...</p>;

  async function markWatched(tmdbId: number) {
    setWatchError(null);
    try {
      await markMovieWatchedFromCard(tmdbId);
    } catch (e) {
      // The card has already been put back as the database has it.
      setWatchError(e instanceof Error ? e.message : String(e));
    }
  }

  // Leaving cards (removed, or just watched) are no longer on the watchlist,
  // so "See all" counts without them.
  const isLeaving = (d: (typeof display)[number]) => !!d.removal || (!!d.item.watched && !d.item.staying);
  const watchlistCount = display.filter((d) => !isLeaving(d)).length;

  if (display.length === 0 && !filter) {
    return (
      <HomeEmpty
        title="Your watchlist is empty"
        body="Movies you want to watch appear here, with anything releasing this month."
        onOpenDiscover={onOpenDiscover}
      />
    );
  }

  return (
    <>
      {/* A header row so "See all" sits on the title's line rather than taking
          a card slot. */}
      <div className="section-head">
        <h2 className="section-title">Movies to Watch</h2>
        {watchlistCount > 0 && (
          <button type="button" className="section-link" onClick={onViewAll} aria-label={`See all ${watchlistCount} movies to watch`}>
            See all {watchlistCount} <span aria-hidden="true">&rsaquo;</span>
          </button>
        )}
      </div>

      {watchError && (
        <p className="status-error small" role="alert">
          Couldn't mark that movie watched, so nothing changed. ({watchError})
        </p>
      )}

      {display.length === 0 ? (
        <p className="muted">Nothing on your watchlist matches that search. Clear it to see everything again.</p>
      ) : (
        <div className="mtw-rail" ref={railRef}>
          {visible.map(({ item: { item: m, watched, staying }, removal }) => {
            return (
              <div
                key={m.tmdbId}
                data-flip-key={m.tmdbId}
                className={`mtw-card${removalClass(removal)}${watchedClass(watched, staying)}`}
                {...titleQuickActionProps({
                  kind: "movie",
                  tmdbId: m.tmdbId,
                  name: m.title,
                  onViewDetails: () => setOpenDetails(m.tmdbId),
                })}
              >
                {/* The poster and everything drawn over it share this box, so
                    the rating, the tick and the watched veil line up with the
                    artwork inside the card's frame. */}
                <div className="mtw-poster-wrap">
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
                  <RatingChip rating={m.tmdbRating} />
                  {/* The same overlay control the Movies page uses: one
                      interaction pattern for "mark this watched" across both
                      screens. Top-right, the corner that only ever holds watch
                      state. stopPropagation is kept to match Movies exactly,
                      so neither copy can drift into depending on the other's
                      structure. */}
                  <button
                    className="watched-badge"
                    onClick={(e) => {
                      e.stopPropagation();
                      markWatched(m.tmdbId);
                    }}
                    aria-label={`Mark ${m.title} watched`}
                  >
                    <CheckIcon size={15} />
                  </button>
                  <MovieWatchedOverlay phase={watched} staying={staying} tmdbId={m.tmdbId} />
                </div>
                {/* Single-line ellipsis title (see .mtw-name): keeps every card
                    the same height however long the title is. Full title stays
                    available as a hover tooltip. */}
                <p className="show-name mtw-name" title={m.title} onClick={() => setOpenDetails(m.tmdbId)}>
                  {m.title}
                </p>
              </div>
            );
          })}
        </div>
      )}
      {openDetails !== null && <DetailsPanel kind="movie" tmdbId={openDetails} onClose={() => setOpenDetails(null)} />}
    </>
  );
}

export default function Home({
  media,
  onMediaChange,
  onViewAllMovies,
  onOpenDiscover,
}: {
  /** Shows or Movies: which half of Home is on screen. Owned by App, see HomeMediaSwitch. */
  media: HomeMedia;
  onMediaChange: (media: HomeMedia) => void;
  onViewAllMovies: () => void;
  onOpenDiscover: () => void;
}) {
  const [openShow, setOpenShow] = useState<number | null>(null);
  const mood = useMoodSearch();
  // Set once the user has switched Shows / Movies while Home is open. Only
  // then do the sections slide in: on arriving at Home the tab view's own
  // entrance is already playing, and the two together would be one motion
  // too many. Adjusted while rendering, like App's tab direction.
  const [mountedMedia] = useState(media);
  const [hasSwitched, setHasSwitched] = useState(false);
  if (!hasSwitched && media !== mountedMedia) setHasSwitched(true);
  const mediaClass = hasSwitched ? " is-switching" : "";

  // Mood search spans both lists on this page, so the candidate set is
  // assembled here rather than inside either child. Shows are restricted to
  // the followed/unarchived set that ShowsHome itself renders, so the model
  // never ranks titles that could not appear in the results anyway.
  // Matches what ShowsHome actually renders, stopped shows included: they are
  // a visible tab now, so excluding them here would make the "N results" line
  // undercount rows the user can see.
  const searchableShows = useLiveQuery(() => db.shows.filter((s) => s.isFollowed).toArray(), []);
  const searchableMovies = useLiveQuery(() => db.movies.filter(isOnWatchlist).toArray(), []);

  const candidates = useMemo<MoodCandidate[]>(
    () => [
      ...(searchableShows ?? []).map(showToMoodCandidate),
      ...(searchableMovies ?? []).map(movieToMoodCandidate),
    ],
    [searchableShows, searchableMovies]
  );

  // Counted the same way the two lists below filter, so the summary line
  // never claims a number the user cannot see: only the titles of the half of
  // Home that is showing. The search itself still runs over both, because a
  // semantic filter's scores are relative to the whole candidate set, and a
  // search should not mean something different after switching.
  const resultCount = useMemo(() => {
    const filter = mood.filter;
    if (!filter) return 0;
    const kind = media === "shows" ? "show" : "movie";
    return candidates.filter((c) => c.kind === kind && matchesMoodFilter(c, filter)).length;
  }, [candidates, mood.filter, media]);

  return (
    <div className="panel">
      {/* Every view needs exactly one h1 or the document outline starts at a
          sub-level. Home has no visible page title by design (the header
          carries the mark and the nav shows where you are), so the heading is
          screen-reader-only rather than redundant on screen. */}
      <h1 className="sr-only">Home</h1>

      <div className="home-toolbar">
        <MoodSearch
          setup={mood.setup}
          filter={mood.filter}
          searching={mood.searching}
          dismissed={mood.dismissed}
          resultCount={resultCount}
          placeholder={media === "shows" ? "Search your shows" : "Search your movies"}
          onSearch={(q) => mood.run(q, candidates)}
          onClear={mood.clear}
          onCancelSetup={mood.cancelSetup}
        />
        {/* Wider screens only (CSS). Phones get the copy App docks above the
            bottom nav. */}
        <HomeMediaSwitch value={media} onChange={onMediaChange} placement="inline" />
      </div>

      {/* Both halves stay mounted and the switch only hides one. ShowsHome
          runs the TMDB episode sync that Coming Up and the release
          notifications depend on, and unmounting it in Movies mode would
          cancel that sync and restart it from the first show on every switch.
          Staying mounted also keeps each half's own state (the Up Next tab,
          a card mid-animation) across switches.

          Coming up is calendar data, not recommendations, so a mood filter
          deliberately does not apply to it. */}
      <section className={`home-media is-shows${mediaClass}`} hidden={media !== "shows"} aria-label="Shows">
        <ShowsHome onOpenShow={setOpenShow} filter={mood.filter} onOpenDiscover={onOpenDiscover} />
        <ComingUp section="episodes" />
      </section>

      <section className={`home-media is-movies${mediaClass}`} hidden={media !== "movies"} aria-label="Movies">
        <MoviesHome onViewAll={onViewAllMovies} filter={mood.filter} onOpenDiscover={onOpenDiscover} />
        <ComingUp section="releases" />
      </section>

      {openShow !== null && <DetailsPanel kind="show" tmdbId={openShow} onClose={() => setOpenShow(null)} />}
    </div>
  );
}
