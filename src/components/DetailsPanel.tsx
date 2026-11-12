import { useEffect, useRef, useState } from "react";
import { haptic } from "../lib/haptics";
import { db, type Episode, type WatchedEpisode } from "../db";
import { getTvShowDetails, getMovieDetails, getCredits, TMDB_IMAGE_BASE, TMDB_BACKDROP_BASE, type CastMember, type TitleCredits } from "../tmdb";
import { formatRating } from "../lib/ratings";
import { getOmdbRatings, hasOmdbKey, OMDB_RATE_LIMIT_MESSAGE, type OmdbRatings } from "../omdb";
import { averageRuntime } from "../lib/runtime";
import { getSeasonNumbers, ensureSeasonCached, totalEpisodeCount, unconfirmedSeasons } from "../lib/episodeSync";
import {
  ensureEpisodesWatched,
  markEpisodesUnwatched,
  recordEpisodeRewatch,
  recordMovieRewatch,
  removeLatestEpisodeViewing,
  removeLatestMovieViewing,
  setEpisodesWatchedOnce,
  setMovieWatchedOnce,
} from "../lib/watchEvents";
import { episodeWatchCount, movieWatchCount, repeatLabel, summarize, summarizeShow, viewingsInWords } from "../lib/watchHistory";
import { movieRecord, showRecord } from "../lib/library";
import { contextActionProps, rectAnchor, type MenuAnchor } from "../lib/contextActions";
import { episodeActions, seasonActions, viewingStatusActions, type QuickActionSpec } from "../lib/quickActions";
import { openQuickMenu, type QuickMenuEntry } from "../lib/quickMenu";
import { showErrorToast } from "../lib/toast";
import { isStoppedWatching, resumeWatchingShow, stopWatchingShow } from "../lib/stoppedWatching";
import { cancelRemoval, holdRemoval, playRemoval, removeFromLibrary } from "../lib/libraryRemoval";
// Aliased: this component's own movieWatched state setter has the same name.
import {
  cancelMovieWatched,
  holdMovieWatched,
  playMovieWatched,
  setMovieWatched as writeMovieWatched,
  type MovieMark,
} from "../lib/movieWatched";
import { requestNotificationSync } from "../lib/notifications";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useDismissKeyboardOnOpen } from "../lib/keyboard";
import { useIsMobile } from "../lib/useIsMobile";
import { useBackHandler } from "../lib/backHandler";
import { prefersReducedMotion, useAnimatedDismiss } from "../lib/useAnimatedDismiss";
import { useSwipeDismiss } from "../lib/useSwipeDismiss";
import EpisodeDetailsPanel from "./EpisodeDetailsPanel";
import ExpandableText from "./ExpandableText";
import StreamingCapsules from "./StreamingCapsules";
import { KebabIcon, StarIcon } from "./icons";
import WatchMark from "./WatchMark";
import { DetailsSkeleton } from "./Skeleton";
import PersonPage from "./PersonPage";

/** Matches the reverse of the desktop-modal-in keyframes in index.css. */
const DESKTOP_MODAL_EXIT_MS = 180;
/** The phone page's exit: it slides back down, a little faster than it came in. */
const PAGE_EXIT_MS = 240;
/** Matches .watch-toggle.is-confirmed in index.css. */
const WATCH_CONFIRM_MS = 420;
/** How long a removed viewing's "-1" stays in the tick before the new count. */
const WATCH_MINUS_MS = 900;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const episodeCode = (ep: Pick<Episode, "seasonNumber" | "episodeNumber">) => `S${ep.seasonNumber} E${ep.episodeNumber}`;

/** Quick-action specs to menu entries, keeping only the ones this context can run. */
function toEntries(specs: QuickActionSpec[], runs: Partial<Record<string, QuickMenuEntry["run"]>>): QuickMenuEntry[] {
  return specs.flatMap((spec) => {
    const run = runs[spec.id];
    return run ? [{ id: spec.id, label: spec.label, danger: spec.danger, checked: spec.checked, run }] : [];
  });
}

interface Props {
  kind: "show" | "movie";
  tmdbId: number;
  /**
   * Shows only. Opens with this season already expanded (and fetched if it
   * was never cached), instead of a fully collapsed accordion.
   *
   * Set by a batch-release notification — "Season 3 is now available" has no
   * single episode to open, so it opens the show ON that season; landing the
   * user on a closed accordion would lose the one thing the notification was
   * about. Undefined everywhere else, which is the collapsed default.
   */
  initialSeason?: number;
  onClose: () => void;
}

interface CoreDetails {
  name: string;
  posterPath: string | null;
  backdropPath: string | null; // horizontal image, used unblurred in the mobile hero when TMDB has one
  releaseDate: string | null;
  overview: string | null;
  status?: string; // shows only
  numberOfSeasons?: number; // shows only
  numberOfEpisodes?: number; // shows only, sum of episode_count across real seasons
  episodeRuntimeMinutes?: number | null; // shows only
  runtimeMinutes?: number | null; // movies only
  imdbId?: string | null;
  genres: string[];
  tmdbRating?: number | null; // stored on the library row when this title is added
}

/** "2h 35m" from minutes; "45m" under an hour. */
function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * The line under the title: for a movie the year, its director and its
 * length ("2021 · Denis Villeneuve · 2h 35m"), for a show the year, its season
 * count and its status. Genres are not here: they are the chips below.
 * Shared by the phone sheet and the desktop dialog so the two never differ.
 */
function subtitleFor(kind: "show" | "movie", details: CoreDetails, director: string | null): string {
  const year = details.releaseDate ? details.releaseDate.slice(0, 4) : "Release date unknown";
  const parts =
    kind === "movie"
      ? [year, director, details.runtimeMinutes ? formatRuntime(details.runtimeMinutes) : null]
      : [
          year,
          details.numberOfSeasons ? `${details.numberOfSeasons} season${details.numberOfSeasons === 1 ? "" : "s"}` : null,
          details.status || null,
        ];
  return parts.filter(Boolean).join(" · ");
}

export default function DetailsPanel({ kind, tmdbId, initialSeason, onClose }: Props) {
  // This component is only ever mounted while its modal is open (callers
  // use `{openDetails !== null && <DetailsPanel .../>}`), so it's safe to
  // call these unconditionally, they mount/unmount together with the panel.
  // useLockBodyScroll applies on BOTH mobile and desktop, that bug wasn't
  // mobile-specific.
  useLockBodyScroll();
  // Opened from a search result or a filtered list, the keyboard would
  // otherwise stay up over this panel.
  useDismissKeyboardOnOpen();
  const isMobile = useIsMobile();
  // Every way of closing (the X, the backdrop, Escape, Android back) plays the
  // exit first: on a phone the page slides back down, on desktop the dialog
  // fades. The durations differ because the two exits are different motions.
  const { closing, requestClose } = useAnimatedDismiss(
    onClose,
    isMobile ? PAGE_EXIT_MS : DESKTOP_MODAL_EXIT_MS
  );
  // Android back closes this panel instead of the app. A stacked episode
  // panel registers its own handler on top, so back closes that first.
  useBackHandler(true, requestClose);

  const [details, setDetails] = useState<CoreDetails | null>(null);
  const [ratings, setRatings] = useState<OmdbRatings | null | "loading">("loading");
  // Cast and director, for the Cast row and a movie's subtitle. Loaded on its
  // own, after the panel has what it needs to draw, so a slow or failed
  // credits request never holds up the panel: the row simply does not appear.
  const [credits, setCredits] = useState<TitleCredits | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCredits(null);
    getCredits(kind, tmdbId)
      .then((c) => {
        if (!cancelled) setCredits(c);
      })
      .catch(() => {
        if (!cancelled) setCredits({ cast: [], director: null });
      });
    return () => {
      cancelled = true;
    };
  }, [kind, tmdbId]);
  const [inLibrary, setInLibrary] = useState(false);
  // Shows only. The viewing state, not a library state: a stopped show is
  // still in the library with all of its history.
  const [stopped, setStopped] = useState(false);
  const [movieWatched, setMovieWatched] = useState(false); // movies only
  const [movieRewatchCount, setMovieRewatchCount] = useState(0); // movies only, extra watches beyond the first
  const [savingWatched, setSavingWatched] = useState(false); // movies only
  const [watchError, setWatchError] = useState<string | null>(null); // movies only
  const [added, setAdded] = useState(false);
  const [removeConfirming, setRemoveConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Removed from the library while this panel was open. Drives the
  // confirmation line, and the card's exit once the panel closes.
  const [justRemoved, setJustRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [seasonNumbers, setSeasonNumbers] = useState<number[] | null>(null);
  // TMDB's own season titles, from the details response this panel already
  // loads. Shown beside "Season N" only when they say something more.
  const [seasonNames, setSeasonNames] = useState<ReadonlyMap<number, string>>(new Map());
  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);
  const [loadingSeason, setLoadingSeason] = useState<number | null>(null);
  const [episodesInDb, setEpisodesInDb] = useState<Episode[]>([]);
  const [watchedKeys, setWatchedKeys] = useState<Set<string>>(new Set());
  // Total watch events per episode key, so the episode panel can show a live
  // rewatch count (+N) as "Watch again" is pressed.
  const [watchCountByKey, setWatchCountByKey] = useState<Map<string, number>>(new Map());
  // The rows themselves, for the show-level counts (lib/watchHistory.ts).
  const [watchedRows, setWatchedRows] = useState<WatchedEpisode[]>([]);
  const [openEpisode, setOpenEpisode] = useState<Episode | null>(null);
  // A cast member's page, opened from the Cast row.
  const [openPerson, setOpenPerson] = useState<CastMember | null>(null);
  // Episodes with a write in flight. A second tap on the same tick (or a menu
  // choice for it) while the first is still saving is ignored, so a double tap
  // can never record two viewings or race a "Not watched" against a rewatch.
  // A ref, not state: it is checked synchronously by the very next tap.
  const busyKeys = useRef(new Set<string>());
  // Ticks acknowledging a change made from the tick menu: "pop" plays the
  // "it saved" pop, "minus" shows "-1" in place of the count for a moment
  // after a viewing is removed.
  const [confirmedKeys, setConfirmedKeys] = useState<ReadonlyMap<string, "pop" | "minus">>(new Map());
  const confirmTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    []
  );

  // The page's scroller, for bringing the Remove confirmation into view.
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // On a phone the page closes with a swipe down from the top, as well as the X.
  useSwipeDismiss(pageRef, scrollAreaRef, isMobile, requestClose);

  // The removed card's highlight and exit play when this panel goes away, not
  // when the delete lands: until then the card is underneath the panel, and
  // an animation nobody can see is not feedback. Unmount is the one point
  // every close path shares - X, backdrop, drag, Escape, Android back, and a
  // tab switch that takes the panel with it - so it is hooked here rather
  // than on each of them.
  //
  // A movie marked watched here is the same story (lib/movieWatched.ts): its
  // card waits under the panel, then shows the watched tick and leaves the
  // lists it no longer belongs on once the panel is gone.
  const removedHere = useRef(false);
  const watchedHere = useRef(false);
  // What the held card shows when the panel closes: the green tick or count,
  // "-1", or the red X for a movie unmarked here. The last change made in the
  // panel decides it.
  const heldMark = useRef<MovieMark>({ kind: "watched", count: 1 });
  useEffect(() => {
    return () => {
      if (removedHere.current) playRemoval(kind, tmdbId);
      if (watchedHere.current) playMovieWatched(tmdbId, heldMark.current);
      removedHere.current = false;
      watchedHere.current = false;
    };
  }, [kind, tmdbId]);

  // Brings the removal confirmation into view. Remove is chosen from the ⋯
  // menu at the top of the page, and the confirmation appears with the
  // page's other actions, which may be scrolled out of view.
  const removeConfirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!removeConfirming) return;
    const el = removeConfirmRef.current;
    if (!el) return;
    // Focus follows the replaced button into the confirmation, onto Cancel:
    // the safe default for a step that deletes history.
    el.querySelector<HTMLButtonElement>("[data-remove-cancel]")?.focus({ preventScroll: true });
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    el.scrollIntoView({ block: "center", behavior });
  }, [removeConfirming]);

  // Escape closes this panel, unless the episode panel is stacked on top
  // of it (openEpisode set), in which case that panel's own Escape
  // handler (added alongside it in EpisodeDetailsPanel.tsx) should close
  // just that top layer first, not both at once.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !openEpisode && !openPerson) requestClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestClose, openEpisode, openPerson]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (kind === "show") {
          const d = await getTvShowDetails(tmdbId);
          if (cancelled) return;
          setDetails({
            name: d.name,
            posterPath: d.poster_path,
            backdropPath: d.backdrop_path,
            releaseDate: d.first_air_date,
            overview: d.overview,
            status: d.status,
            numberOfSeasons: d.number_of_seasons,
            numberOfEpisodes: totalEpisodeCount(d.seasons),
            episodeRuntimeMinutes: averageRuntime(d.episode_run_time),
            imdbId: d.external_ids?.imdb_id ?? null,
            genres: d.genres.map((g) => g.name),
            tmdbRating: d.vote_average ?? null,
          });
          setSeasonNames(new Map(d.seasons.map((season) => [season.season_number, season.name])));
          // Checked after every await, not just the first: a load superseded by
          // another title must not go on to write this show's library state,
          // seasons or episodes into the panel now showing the other one.
          const existing = await db.shows.get(tmdbId);
          if (cancelled) return;
          setInLibrary(!!existing);
          setStopped(!!existing && isStoppedWatching(existing));
          const nums = await getSeasonNumbers(tmdbId);
          if (cancelled) return;
          setSeasonNumbers(nums);
          if (existing) {
            await refreshWatchedAndEpisodes();
          }
          if (hasOmdbKey()) {
            const r = await getOmdbRatings({
              imdbId: d.external_ids?.imdb_id,
              title: d.name,
              year: d.first_air_date ? Number(d.first_air_date.slice(0, 4)) : null,
            });
            if (!cancelled) setRatings(r);
          } else {
            setRatings(null);
          }
        } else {
          const d = await getMovieDetails(tmdbId);
          if (cancelled) return;
          setDetails({
            name: d.title,
            posterPath: d.poster_path,
            backdropPath: d.backdrop_path,
            releaseDate: d.release_date,
            overview: d.overview,
            runtimeMinutes: d.runtime,
            imdbId: d.external_ids?.imdb_id ?? null,
            genres: d.genres.map((g) => g.name),
            tmdbRating: d.vote_average ?? null,
          });
          const existing = await db.movies.get(tmdbId);
          setInLibrary(!!existing);
          setMovieWatched(existing?.watched ?? false);
          setMovieRewatchCount(existing?.rewatchCount ?? 0);
          if (hasOmdbKey()) {
            const r = await getOmdbRatings({
              imdbId: d.external_ids?.imdb_id,
              title: d.title,
              year: d.release_date ? Number(d.release_date.slice(0, 4)) : null,
            });
            if (!cancelled) setRatings(r);
          } else {
            setRatings(null);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, tmdbId]);

  async function refreshWatchedAndEpisodes() {
    const [eps, watched] = await Promise.all([
      db.episodes.where("showId").equals(tmdbId).toArray(),
      db.watchedEpisodes.where("showId").equals(tmdbId).toArray(),
    ]);
    setEpisodesInDb(eps);
    setWatchedKeys(new Set(watched.map((w) => w.key)));
    setWatchCountByKey(new Map(watched.map((w) => [w.key, episodeWatchCount(w)])));
    setWatchedRows(watched);
  }

  async function toggleExpand(seasonNumber: number) {
    if (expandedSeason === seasonNumber) {
      setExpandedSeason(null);
      return;
    }
    setExpandedSeason(seasonNumber);
    if (!episodesInDb.some((e) => e.seasonNumber === seasonNumber)) {
      setLoadingSeason(seasonNumber);
      await ensureSeasonCached(tmdbId, seasonNumber);
      await refreshWatchedAndEpisodes();
      setLoadingSeason(null);
    }
  }

  /**
   * Applies `initialSeason` once the season list is known.
   *
   * Guarded on the season actually existing for this show, so a stale link
   * opens a normal collapsed panel rather than an accordion pointing at a
   * season that is not there. The ref makes it strictly one-shot: after this,
   * expanding and collapsing seasons is entirely the user's, and a re-render
   * must not re-open what they just closed.
   */
  const appliedInitialSeason = useRef(false);
  useEffect(() => {
    if (appliedInitialSeason.current) return;
    if (initialSeason === undefined || seasonNumbers === null) return;
    appliedInitialSeason.current = true;
    if (!seasonNumbers.includes(initialSeason)) return;
    toggleExpand(initialSeason);
    // toggleExpand is recreated every render and would re-run this on each
    // one; the ref above is what actually bounds it to a single application.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSeason, seasonNumbers]);

  const [catchUpOffer, setCatchUpOffer] = useState<{ episodesInSeason: Episode[]; earlierSeasonNumbers: number[] } | null>(
    null
  );

  /**
   * Every episode write in this panel goes through here: skipped (resolving
   * undefined) while any of the same episodes is already saving, and followed
   * by a re-read, so what the panel shows is always what the database holds -
   * after a failure as much as after a success. Rejects when the write failed;
   * nothing is drawn as saved before it has been.
   */
  async function episodeWrite<T>(eps: { key: string }[], write: () => Promise<T>): Promise<T | undefined> {
    if (eps.length === 0 || eps.some((e) => busyKeys.current.has(e.key))) return undefined;
    for (const e of eps) busyKeys.current.add(e.key);
    try {
      return await write();
    } finally {
      for (const e of eps) busyKeys.current.delete(e.key);
      await refreshWatchedAndEpisodes().catch(() => {});
    }
  }

  /**
   * The tick's acknowledgement, for changes that would otherwise be easy to
   * miss: the "it saved" pop, or "-1" for a removed viewing (held a little
   * longer, so it can be read before the new count replaces it). Only called
   * after a write lands.
   */
  function confirmVisually(keys: string[], how: "pop" | "minus" = "pop") {
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    setConfirmedKeys(new Map(keys.map((k) => [k, how])));
    confirmTimer.current = window.setTimeout(
      () => {
        confirmTimer.current = null;
        setConfirmedKeys(new Map());
      },
      how === "minus" ? WATCH_MINUS_MS : WATCH_CONFIRM_MS
    );
  }

  // Idempotent "make these count as watched" via the shared write path:
  // already-watched rows keep their history (the old inline bulkPut reset
  // imported watchCounts back to 1), and Show.lastWatchedAt gets bumped so
  // panel-marked activity counts as activity for the Watch Next split
  // (previously only Home's checkmark did that).
  function markEpisodesWatched(eps: Episode[]) {
    return episodeWrite(eps, () => ensureEpisodesWatched(tmdbId, eps));
  }

  // One more watch EVENT for already-watched episodes: watchCount + latest
  // date bump, one row per episode forever.
  function rewatchEpisodes(eps: Episode[]) {
    return episodeWrite(eps, () => recordEpisodeRewatch(tmdbId, eps));
  }

  /** Back to one viewing each, keeping the original viewing date. */
  function setWatchedOnce(eps: Episode[]) {
    return episodeWrite(eps, () => setEpisodesWatchedOnce(tmdbId, eps));
  }

  /** Remove last viewing: undoes the most recent rewatch only; the episode stays watched (see removeLatestEpisodeViewing). */
  async function removeLastViewing(ep: Episode) {
    const count = await episodeWrite([ep], () => removeLatestEpisodeViewing(tmdbId, ep));
    if (count !== undefined) confirmVisually([ep.key], "minus");
    return count;
  }

  /** Not watched: the rows go, which is what unwatched is in this data model (see markEpisodesUnwatched). */
  async function unmarkEpisodes(eps: Episode[]) {
    const removed = await episodeWrite(eps, () => markEpisodesUnwatched(tmdbId, eps));
    if (removed !== undefined) setCatchUpOffer(null);
    return removed;
  }

  /**
   * Which season numbers strictly before `beforeSeason` still need
   * catching up. A season already fully watched (verifiable because it's
   * cached) is excluded, so accepting an already-caught-up show doesn't
   * nag about seasons you've already marked. A season that's never been
   * opened/cached at all is included rather than skipped: we can't verify
   * it's already watched, and the common real case (per the exact
   * scenario this was reported against) is jumping straight to marking an
   * episode deep in the series without ever having opened Season 1, so
   * silently excluding uncached seasons would recreate the original bug.
   */
  function earlierSeasonsNeedingCatchUp(beforeSeason: number): number[] {
    return (seasonNumbers ?? []).filter((n) => {
      if (n >= beforeSeason) return false;
      const eps = episodesBySeason.get(n);
      if (!eps || eps.length === 0) return true;
      return eps.some((e) => !watchedKeys.has(e.key));
    });
  }

  /**
   * The episode panel's Mark as Watched / Mark as Unwatched, and the first
   * tap on an unwatched tick. A first watch keeps the catch-up offer it has
   * always had. Rejects if the write failed.
   */
  async function toggleEpisodeWatched(ep: Episode): Promise<boolean> {
    if (!inLibrary) return false;
    if (watchedKeys.has(ep.key)) {
      return (await unmarkEpisodes([ep])) !== undefined;
    }
    haptic("confirm");
    if ((await markEpisodesWatched([ep])) === undefined) return false;

    const seasonEps = episodesBySeason.get(ep.seasonNumber) ?? [];
    const episodesInSeason = seasonEps.filter((e) => e.episodeNumber < ep.episodeNumber && !watchedKeys.has(e.key));
    const earlierSeasonNumbers = earlierSeasonsNeedingCatchUp(ep.seasonNumber);
    setCatchUpOffer(
      episodesInSeason.length > 0 || earlierSeasonNumbers.length > 0
        ? { episodesInSeason, earlierSeasonNumbers }
        : null
    );
    return true;
  }

  /** Rejects if the write failed; resolves false if it was skipped because the season was already saving. */
  async function toggleSeasonWatched(seasonEpisodes: Episode[], markWatched: boolean): Promise<boolean> {
    if (!inLibrary) return false;
    if (markWatched) {
      haptic("confirm");
      if ((await markEpisodesWatched(seasonEpisodes)) === undefined) return false;
      const thisSeason = seasonEpisodes[0]?.seasonNumber;
      const earlierSeasonNumbers = thisSeason === undefined ? [] : earlierSeasonsNeedingCatchUp(thisSeason);
      setCatchUpOffer(earlierSeasonNumbers.length > 0 ? { episodesInSeason: [], earlierSeasonNumbers } : null);
      return true;
    }
    return (await unmarkEpisodes(seasonEpisodes)) !== undefined;
  }

  /**
   * The season's "Watch again": one more viewing of every episode in it, so
   * its season watch count goes up by exactly one. Only offered once the
   * whole season has been watched. Returns the confirmation, or undefined if
   * the season was already saving.
   */
  async function rewatchSeason(seasonNumber: number, seasonEpisodes: Episode[]): Promise<string | undefined> {
    const before = summarize(seasonEpisodes, new Map(watchedRows.map((w) => [w.key, w])));
    if ((await rewatchEpisodes(seasonEpisodes)) === undefined) return undefined;
    confirmVisually(seasonEpisodes.map((e) => e.key));
    return `Season ${seasonNumber} marked as watched again. Watched ${before.completions + 1}× in total.`;
  }

  /**
   * The indicator on a watched episode (its green tick, or its viewing count):
   * the viewing-status choices instead of an instant unmark - the same list a
   * watched movie's indicator offers (viewingStatusActions). Opening or
   * dismissing the menu changes nothing; only a choice writes, and the tick
   * acknowledges it only once that write has landed.
   */
  function openTickMenu(ep: Episode, el: HTMLElement) {
    const count = watchCountByKey.get(ep.key) ?? 0;
    openQuickMenu({
      anchor: rectAnchor(el),
      target: el,
      label: `${episodeCode(ep)} ${ep.name}: viewing status`,
      title: ep.name,
      subtitle: `${episodeCode(ep)} · ${viewingsInWords(count)}`,
      entries: toEntries(viewingStatusActions(count), {
        "watched-once": async () => {
          if (count === 1) return; // already the case: nothing to write
          if ((await setWatchedOnce([ep])) !== undefined) confirmVisually([ep.key]);
        },
        "watched-again": async () => {
          if ((await rewatchEpisodes([ep])) !== undefined) confirmVisually([ep.key]);
        },
        "remove-last": async () => void (await removeLastViewing(ep)),
        "not-watched": async () => void (await unmarkEpisodes([ep])),
      }),
    });
  }

  /** Quick Actions on an episode row: the same operations as its tick and its panel. */
  function openEpisodeMenu(ep: Episode, anchor: MenuAnchor, el: HTMLElement) {
    const count = watchCountByKey.get(ep.key) ?? 0;
    openQuickMenu({
      anchor,
      target: el,
      label: `${episodeCode(ep)} ${ep.name}: quick actions`,
      title: ep.name,
      subtitle: `${episodeCode(ep)}${inLibrary ? ` · ${viewingsInWords(count)}` : ""}`,
      entries: toEntries(episodeActions({ inLibrary, watchCount: count }), {
        "mark-watched": async () => {
          if (!(await toggleEpisodeWatched(ep))) return;
          return `${episodeCode(ep)} marked as watched.`;
        },
        "watched-again": async () => {
          if ((await rewatchEpisodes([ep])) === undefined) return;
          confirmVisually([ep.key]);
          return `${episodeCode(ep)} watched again. ${count + 1}× in total.`;
        },
        "remove-last": async () => {
          const now = await removeLastViewing(ep);
          if (now === undefined) return;
          return `Removed the last viewing of ${episodeCode(ep)}. ${viewingsInWords(now)} now.`;
        },
        "mark-unwatched": async () => {
          if ((await unmarkEpisodes([ep])) === undefined) return;
          return `${episodeCode(ep)} marked as unwatched.`;
        },
        "episode-details": () => setOpenEpisode(ep),
      }),
    });
  }

  /**
   * Quick Actions on a season header. Its episodes are read (and fetched, the
   * first time) when the menu opens, so the choices match the season as it
   * is, including one that has never been expanded.
   */
  async function openSeasonMenu(seasonNumber: number, anchor: MenuAnchor, el: HTMLElement) {
    let eps: Episode[] = [];
    let watched: (WatchedEpisode | undefined)[] = [];
    try {
      if (inLibrary) {
        await ensureSeasonCached(tmdbId, seasonNumber);
        eps = (await db.episodes.where("[showId+seasonNumber]").equals([tmdbId, seasonNumber]).toArray()).sort(
          (a, b) => a.episodeNumber - b.episodeNumber
        );
        watched = await db.watchedEpisodes.bulkGet(eps.map((e) => e.key));
      }
    } catch (e) {
      showErrorToast(e, "open the menu");
      return;
    }
    const watchedCount = watched.filter(Boolean).length;
    const viewOpen = () => {
      if (expandedSeason !== seasonNumber) void toggleExpand(seasonNumber);
      el.scrollIntoView({ block: "nearest" });
    };
    openQuickMenu({
      anchor,
      target: el,
      label: `Season ${seasonNumber}: quick actions`,
      title: `Season ${seasonNumber}`,
      subtitle: inLibrary && eps.length > 0 ? `${watchedCount} of ${plural(eps.length, "episode")} watched` : undefined,
      entries: toEntries(seasonActions({ inLibrary, total: eps.length, watched: watchedCount }), {
        "mark-watched": async () => {
          if (!(await toggleSeasonWatched(eps, true))) return;
          return `Season ${seasonNumber} marked as watched.`;
        },
        "watched-again": () => rewatchSeason(seasonNumber, eps),
        "mark-unwatched": async () => {
          if (!(await toggleSeasonWatched(eps, false))) return;
          return `Season ${seasonNumber} marked as unwatched.`;
        },
        "season-details": viewOpen,
      }),
    });
  }

  async function acceptCatchUp() {
    if (!catchUpOffer) return;
    try {
      for (const seasonNumber of catchUpOffer.earlierSeasonNumbers) {
        await ensureSeasonCached(tmdbId, seasonNumber);
      }
      const freshEpisodes =
        catchUpOffer.earlierSeasonNumbers.length > 0
          ? await db.episodes.where("showId").equals(tmdbId).toArray()
          : [];
      const fromEarlierSeasons = freshEpisodes.filter((e) => catchUpOffer.earlierSeasonNumbers.includes(e.seasonNumber));
      if ((await markEpisodesWatched([...catchUpOffer.episodesInSeason, ...fromEarlierSeasons])) === undefined) return;
    } catch (e) {
      showErrorToast(e);
      return;
    }
    setCatchUpOffer(null);
  }

  async function handleAdd() {
    if (!details) return;
    // The record shapes live in lib/library.ts, shared with Quick Actions'
    // Add on a Discover or For You card, so the two adds cannot drift apart.
    if (kind === "show") {
      await db.shows.put(showRecord(tmdbId, details));
      await refreshWatchedAndEpisodes();
      setStopped(false);
    } else {
      await db.movies.put(movieRecord(tmdbId, false, details));
    }
    setInLibrary(true);
    setAdded(true);
    keepInLibrary();
  }

  /** Added back after being removed in this same panel: the card it was leaving is staying after all. */
  function keepInLibrary() {
    removedHere.current = false;
    setJustRemoved(false);
    cancelRemoval(kind, tmdbId);
  }

  /**
   * One tap from the panel instead of add -> switch to Movies -> find it
   * -> mark watched. Not in the library yet: adds it already marked
   * watched. Already in: toggles. Unmarking puts the movie back on the
   * want-to-watch list (wantsToWatch: true) rather than stranding it in
   * the library on neither list, mirroring the Home rail round trip.
   */
  async function toggleMovieWatched() {
    if (kind !== "movie" || !details) return;
    const marking = !inLibrary || !movieWatched;
    if (marking) haptic("confirm");
    const wasInLibrary = inLibrary;
    const done = await moviePanelWrite(async () => {
      if (!wasInLibrary) {
        await db.movies.put(movieRecord(tmdbId, true, details));
        requestNotificationSync();
        return { kind: "watched", count: 1 };
      }
      // The shared write path, so this and the card ticks cannot disagree
      // about what "watched" does to the watchlist.
      await writeMovieWatched(tmdbId, marking);
      if (!marking) return { kind: "unwatched" };
      const stored = await db.movies.get(tmdbId);
      return { kind: "watched", count: stored ? movieWatchCount(stored) : 1 };
    });
    if (done && !wasInLibrary) {
      setInLibrary(true);
      setAdded(true);
      keepInLibrary();
    }
  }

  // Where the movie stood when this panel first changed it, so changing it
  // and changing it back before closing plays nothing on the card.
  const movieStart = useRef<{ watched: boolean; count: number } | null>(null);

  /**
   * Every change to a movie's viewings made in this panel: watched, not
   * watched, watched again, remove last viewing, watched once.
   *
   * The movie's card is under the panel, so it is held from BEFORE the write
   * (the lists can re-render without it before the write's promise resolves)
   * and plays the acknowledgement the last change earned - the green tick or
   * count, "-1", or the red X - once the panel closes. A failed write releases
   * a hold it started and says why; nothing animates for a change that did
   * not happen. The panel's own state is re-read from the database after.
   */
  async function moviePanelWrite(write: () => Promise<MovieMark>): Promise<boolean> {
    if (kind !== "movie" || savingWatched) return false;
    setSavingWatched(true);
    setWatchError(null);
    const alreadyHeld = watchedHere.current;
    if (!alreadyHeld) {
      movieStart.current = { watched: inLibrary && movieWatched, count: inLibrary && movieWatched ? movieRewatchCount + 1 : 0 };
      holdMovieWatched(tmdbId);
    }
    try {
      const mark = await write();
      const stored = await db.movies.get(tmdbId);
      const now = { watched: !!stored?.watched, count: stored ? movieWatchCount(stored) : 0 };
      setMovieWatched(now.watched);
      setMovieRewatchCount(stored?.rewatchCount ?? 0);
      const start = movieStart.current;
      if (start && start.watched === now.watched && start.count === now.count) {
        // Changed and changed back before closing: nothing to show.
        cancelMovieWatched(tmdbId);
        watchedHere.current = false;
      } else {
        heldMark.current = mark;
        watchedHere.current = true;
      }
      return true;
    } catch (e) {
      if (!alreadyHeld) cancelMovieWatched(tmdbId);
      setWatchError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSavingWatched(false);
    }
  }

  /** The watched movie's indicator in this panel: the same viewing-status choices as its poster's. */
  function openMovieStatusMenu(el: HTMLElement) {
    if (!details) return;
    const count = movieRewatchCount + 1;
    openQuickMenu({
      anchor: rectAnchor(el),
      target: el,
      label: `${details.name}: viewing status`,
      title: details.name,
      subtitle: viewingsInWords(count),
      entries: toEntries(viewingStatusActions(count), {
        "watched-once": async () => {
          if (count > 1) await moviePanelWrite(async () => ({ kind: "watched", count: await setMovieWatchedOnce(tmdbId) }));
        },
        "watched-again": async () => void (await movieWatchAgain()),
        "remove-last": async () =>
          void (await moviePanelWrite(async () => ({ kind: "decrement", count: await removeLatestMovieViewing(tmdbId) }))),
        "not-watched": async () => void (await toggleMovieWatched()),
      }),
    });
  }

  /**
   * "I'm done with this" / "I'm watching it again", as an explicit state.
   *
   * The one thing a user could not previously tell the app. Without it the
   * only ways to stop a long-running show reappearing were to delete it (and
   * its history with it) or to keep dismissing it, and the automatic rules had
   * to guess — which is precisely the guessing that put a show someone gave up
   * on years ago back in front of them every time a new episode aired.
   *
   * Neither direction touches watch history, ratings or library membership.
   */
  async function toggleStopped() {
    if (kind !== "show" || !inLibrary) return;
    if (stopped) await resumeWatchingShow(tmdbId);
    else await stopWatchingShow(tmdbId);
    setStopped(!stopped);
  }

  /**
   * The confirmed removal. See lib/libraryRemoval.ts for what is deleted and
   * how the card leaves its list.
   *
   * Nothing here claims success until the write has actually landed: a
   * failure leaves the library exactly as it was (the delete is one
   * transaction), keeps the confirmation open with the reason, and releases
   * the card it was holding, so no list animates a removal that did not
   * happen.
   */
  async function handleRemove() {
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    holdRemoval(kind, tmdbId);
    try {
      await removeFromLibrary(kind, tmdbId);
    } catch (e) {
      cancelRemoval(kind, tmdbId);
      setRemoveError(e instanceof Error ? e.message : String(e));
      setRemoving(false);
      return;
    }
    removedHere.current = true;
    // Marked watched and then removed in the same panel: the removal is the
    // one to show. Released only now, after the removal hold has the card.
    if (watchedHere.current) {
      cancelMovieWatched(tmdbId);
      watchedHere.current = false;
    }
    setJustRemoved(true);
    setInLibrary(false);
    setAdded(false);
    setRemoveConfirming(false);
    setRemoving(false);
    // The panel stays open on the title, now as a preview, so nothing on it may
    // still describe it as tracked: the stopped note and the episode ticks
    // belonged to history that no longer exists.
    setStopped(false);
    setMovieWatched(false);
    setMovieRewatchCount(0);
    setWatchedKeys(new Set());
    setWatchCountByKey(new Map());
    setWatchedRows([]);
    setCatchUpOffer(null);
  }

  /**
   * The movie's "Watch again". Shows the count the database now holds, not a
   * locally incremented one, and says so when the write fails instead of
   * counting a viewing that was never saved.
   */
  function movieWatchAgain() {
    return moviePanelWrite(async () => ({ kind: "watched", count: await recordMovieRewatch(tmdbId) }));
  }

  function cancelRemove() {
    setRemoveConfirming(false);
    setRemoveError(null);
  }

  // The ⋯ menu in the panel's top bar. Removing a title is the one action
  // here that discards history, so it lives behind the menu rather than in
  // the row of everyday actions; choosing it opens the same confirmation the
  // Remove button used to, in the same place, so the removal itself (the
  // write, its error, the card's exit) is unchanged.
  function openTitleMenu(el: HTMLElement) {
    if (!details) return;
    openQuickMenu({
      anchor: rectAnchor(el),
      target: el,
      label: `${details.name}: more actions`,
      title: details.name,
      entries: [
        {
          id: "remove",
          label: `Remove from ${kind === "show" ? "Shows" : "Movies"}`,
          danger: true,
          run: () => {
            setRemoveError(null);
            setRemoveConfirming(true);
          },
        },
      ],
    });
  }
  const titleMenuButton = (className: string) =>
    details && inLibrary ? (
      <button
        type="button"
        className={className}
        aria-label={`More actions for ${details.name}`}
        aria-haspopup="menu"
        onClick={(e) => openTitleMenu(e.currentTarget)}
      >
        <KebabIcon size={20} />
      </button>
    ) : null;

  const episodesBySeason = new Map<number, Episode[]>();
  for (const ep of episodesInDb) {
    const list = episodesBySeason.get(ep.seasonNumber);
    if (list) list.push(ep);
    else episodesBySeason.set(ep.seasonNumber, [ep]);
  }
  for (const list of episodesBySeason.values()) list.sort((a, b) => a.episodeNumber - b.episodeNumber);
  // The same rule Up Next uses to leave these seasons out, so the panel can say
  // why a listed season is not being offered as something to watch.
  const unconfirmed = unconfirmedSeasons(episodesInDb);

  const showsSeasonBrowser = kind === "show" && seasonNumbers !== null;

  /** TMDB's title for a season, when it is more than "Season N" (e.g. "Book One: Water"); otherwise null. */
  function seasonTitle(n: number): string | null {
    const name = seasonNames.get(n)?.trim();
    if (!name || /^season\s*\d+$/i.test(name)) return null;
    return name;
  }

  // The show's own counts, derived from the same rows as everything else (see
  // lib/watchHistory.ts). "Watched in full" needs every season's episode list
  // to know what "every episode" is, so it is only claimed once all are cached
  // here; until then the total comes from TMDB's episode count instead.
  const watchedByKey = new Map(watchedRows.map((w) => [w.key, w]));
  const allSeasonsCached =
    seasonNumbers !== null && seasonNumbers.length > 0 && seasonNumbers.every((n) => episodesBySeason.has(n));
  let showWatchLine: string | null = null;
  if (kind === "show" && inLibrary && watchedRows.length > 0) {
    const s = summarizeShow(episodesInDb, watchedRows);
    const outOf = allSeasonsCached ? s.released : details?.numberOfEpisodes;
    showWatchLine = [
      outOf ? `${s.uniqueWatched} of ${plural(outOf, "episode")} watched` : `${plural(s.uniqueWatched, "episode")} watched`,
      plural(s.views, "view"),
      allSeasonsCached && s.completions >= 2 ? `watched in full ${s.completions}×` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const ratingsRowContent = details && (
    <div className="ratings-row">
      {ratings === "loading" && hasOmdbKey() && <span className="muted small">Loading ratings...</span>}
      {ratings && ratings !== "loading" && (
        <>
          {ratings.imdbRating && <span className="rating-pill">IMDb {ratings.imdbRating}</span>}
          {ratings.rottenTomatoes && <span className="rating-pill">RT {ratings.rottenTomatoes}</span>}
          {!ratings.imdbRating && !ratings.rottenTomatoes && (
            <span className="muted small">
              {ratings.rateLimited
                ? OMDB_RATE_LIMIT_MESSAGE
                : ratings.error
                  ? `OMDb: ${ratings.error}`
                  : "No ratings found for this title on OMDb."}
            </span>
          )}
        </>
      )}
      {!hasOmdbKey() && <span className="muted small">Add an OMDb key in Settings to see IMDb/RT ratings.</span>}
    </div>
  );

  // What the panel says about the title's place in the library: plain
  // statements, in the body.
  const statusContent =
    details &&
    (inLibrary ? (
      <>
        <p className="library-status">
          {added ? `Added to your ${kind === "show" ? "Shows" : "Movies"}.` : `Already in your ${kind === "show" ? "Shows" : "Movies"}.`}
          {kind === "movie" && movieWatched
            ? movieRewatchCount > 0
              ? ` Watched ${movieRewatchCount + 1} times.`
              : " Marked as watched."
            : ""}
        </p>
        {showWatchLine && <p className="muted small watch-summary">{showWatchLine}</p>}
        {/* Says what the state actually does, because "stopped" could
            otherwise be read as something that removed or hid the show. */}
        {kind === "show" && stopped && (
          <p className="muted small">
            Stopped watching. It stays in your library with all of its history, and new episodes won't bring it
            back to Watch Next until you resume.
          </p>
        )}
      </>
    ) : (
      // Said in words as well as by the Add button reappearing, since the
      // list the card is leaving is still behind this panel.
      justRemoved && (
        <p className="muted small" role="status">
          Removed from your {kind === "show" ? "Shows" : "Movies"}.
        </p>
      )
    ));

  // The one main action, as the floating button at the bottom of the page
  // (the reference's "Watch now"): adding the title, or for a movie in the
  // library, marking it watched or watching it again. A show already in the
  // library has none; its everyday actions are the season list.
  const primaryAction: { label: string; onClick: () => void; disabled?: boolean } | null = !details
    ? null
    : !inLibrary
      ? { label: kind === "show" ? "Add to Shows" : "Add to Movies", onClick: handleAdd }
      : kind === "movie"
        ? movieWatched
          ? { label: "Watch again", onClick: movieWatchAgain, disabled: savingWatched }
          : { label: "Mark as watched", onClick: toggleMovieWatched, disabled: savingWatched }
        : null;

  // Everything else you can do, quieter, in the body under the status line;
  // and the Remove confirmation, which takes this row's place when it is open
  // (Remove itself is in the ⋯ menu).
  const secondaryContent = details && (
    <>
      {removeConfirming ? (
      <div className="remove-confirm" ref={removeConfirmRef}>
        <div className="field-row">
          <button className="danger-button" onClick={handleRemove} disabled={removing}>
            {removing ? "Removing..." : "Confirm remove"}
          </button>
          <button data-remove-cancel onClick={cancelRemove} disabled={removing}>
            Cancel
          </button>
        </div>
        <span className="muted small">
          Also deletes {kind === "show" ? "its watch history" : "its watched status"}. No undo.
        </span>
        {removeError && (
          <p className="status-error small" role="alert">
            Couldn't remove it, so nothing in your library has changed. ({removeError})
          </p>
        )}
      </div>
      ) : (
        (kind === "show" ? inLibrary : true) && (
          <div className="field-row details-secondary">
            {kind === "movie" && !inLibrary && (
              <button onClick={toggleMovieWatched} disabled={savingWatched}>
                Add as watched
              </button>
            )}
            {kind === "movie" && inLibrary && movieWatched && (
              <button
                className="movie-watched-status"
                onClick={(e) => openMovieStatusMenu(e.currentTarget)}
                aria-haspopup="menu"
                aria-label={`${viewingsInWords(movieRewatchCount + 1)}. Change viewing status`}
                aria-disabled={savingWatched}
              >
                <span className="watch-indicator on" aria-hidden="true">
                  <WatchMark count={movieRewatchCount + 1} />
                </span>
                Watched
              </button>
            )}
            {kind === "show" && inLibrary && (
              <button onClick={toggleStopped}>{stopped ? "Resume watching" : "Stop watching"}</button>
            )}
          </div>
        )
      )}
      {watchError && (
        <p className="status-error small" role="alert">
          Couldn't save that, so nothing has changed. ({watchError})
        </p>
      )}
    </>
  );

  // The header, as in the reference: a large title with the rating on the
  // same line, one subtitle line, and the genres as chips.
  const ratingText = details ? formatRating(details.tmdbRating) : null;
  const titleBlock = details && (
    <>
      <div className="details-title-row">
        <h2 className="details-title">{details.name}</h2>
        {ratingText && (
          <span className="details-rating">
            <span className="sr-only">TMDB rating </span>
            {ratingText}
            <StarIcon size={16} />
          </span>
        )}
      </div>
      <p className="details-subtitle">{subtitleFor(kind, details, credits?.director ?? null)}</p>
    </>
  );
  const genreChips = details && details.genres.length > 0 && (
    <ul className="genre-chip-row" aria-label="Genres">
      {details.genres.map((g) => (
        <li key={g} className="genre-chip">
          {g}
        </li>
      ))}
    </ul>
  );

  // Cast, as photo cards in a row that scrolls sideways. Hidden until the
  // credits arrive, and entirely when TMDB lists nobody.
  const castContent = credits && credits.cast.length > 0 && (
    <section className="cast-section" aria-label="Cast">
      <h3 className="details-section-title">Cast</h3>
      <ul className="cast-rail">
        {credits.cast.map((person) => (
          <li key={person.id} className="cast-card">
            <button type="button" className="cast-open" onClick={() => setOpenPerson(person)}>
              {person.profilePath ? (
                <img src={`${TMDB_IMAGE_BASE}${person.profilePath}`} alt="" className="cast-photo" loading="lazy" />
              ) : (
                <span className="cast-photo cast-photo-empty" aria-hidden="true" />
              )}
              <span className="cast-name">{person.name}</span>
              {person.character && <span className="cast-role">{person.character}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  // Clamped to a few lines with Read more / Show less: a long synopsis used to
  // push the streaming row and the season list a screen further down. The
  // text itself is untouched; this is presentation only.
  const overviewContent = details && (
    <ExpandableText
      className="overview"
      lines={3}
      inlineToggle
      text={details.overview || (ratings !== "loading" && ratings?.plot) || "No summary available."}
    />
  );

  // Where to watch it. Composed once here, like the three blocks above it, so
  // the mobile sheet and the desktop dialog place the same element rather than
  // each rendering their own. Shows and movies both get it; the episode panel
  // renders the identical component from the show's id.
  const streamingContent = details && <StreamingCapsules kind={kind} tmdbId={tmdbId} title={details.name} />;


  const seasonBrowserBlock = showsSeasonBrowser && (
    <div className="season-browser">
      {!inLibrary && (
        <p className="muted small" style={{ marginBottom: 10 }}>
          Previewing seasons and episodes. Add this show to your Shows to start tracking what you've watched.
        </p>
      )}
      {catchUpOffer && (
        <div className="catch-up-offer">
          <span>
            Also mark{" "}
            {catchUpOffer.episodesInSeason.length > 0 &&
              `the ${catchUpOffer.episodesInSeason.length} episode${catchUpOffer.episodesInSeason.length === 1 ? "" : "s"} before this one in this season`}
            {catchUpOffer.episodesInSeason.length > 0 && catchUpOffer.earlierSeasonNumbers.length > 0 && " and "}
            {catchUpOffer.earlierSeasonNumbers.length > 0 &&
              `${catchUpOffer.earlierSeasonNumbers.length} earlier season${catchUpOffer.earlierSeasonNumbers.length === 1 ? "" : "s"}`}
            {" "}as watched?
          </span>
          <div className="field-row">
            <button onClick={acceptCatchUp}>Yes, catch up</button>
            <button onClick={() => setCatchUpOffer(null)}>No, just this one</button>
          </div>
        </div>
      )}
      {seasonNumbers!.map((seasonNumber) => {
        const isExpanded = expandedSeason === seasonNumber;
        const eps = episodesBySeason.get(seasonNumber) ?? [];
        const watchedCount = eps.filter((e) => watchedKeys.has(e.key)).length;
        // How many times the whole season has been watched: the lowest count
        // among its episodes. Shown from the second time on, so watching it
        // again visibly registers; a few rewatched episodes do not move it.
        const seasonRepeat = inLibrary ? repeatLabel(summarize(eps, watchedByKey).completions) : null;

        return (
          <div key={seasonNumber} className="season-block">
            <div
              className="season-header season-toggle"
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              {...contextActionProps((anchor, el) => void openSeasonMenu(seasonNumber, anchor, el))}
              onClick={() => toggleExpand(seasonNumber)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleExpand(seasonNumber);
                }
              }}
            >
              {/* Left: the season, in the app's "Season N" form, with TMDB's
                  own title beside it when the season has a real one (not just
                  "Season N" again). */}
              <h3 className="season-title">
                <span className={`season-caret ${isExpanded ? "open" : ""}`} aria-hidden="true">
                  &#9656;
                </span>{" "}
                Season {seasonNumber}
                {seasonTitle(seasonNumber) && <span className="season-name"> &middot; {seasonTitle(seasonNumber)}</span>}
              </h3>
              {/* Right: progress, how many times the whole season has been
                  watched (from the second time on), and a menu holding the
                  season's actions. The Mark watched / Mark unwatched / Watch
                  again links that used to sit here are in that menu: the same
                  season menu a long-press or right-click on this header opens,
                  offering only what the season's state allows. */}
              <div className="season-header-right">
                {unconfirmed.has(seasonNumber) && (
                  <span
                    className="muted small"
                    title="TMDB lists this season without any air dates, so it isn't treated as released."
                  >
                    No air dates
                  </span>
                )}
                {inLibrary && eps.length > 0 && (
                  <span className="muted small season-count">
                    {watchedCount}/{eps.length}
                    {seasonRepeat && (
                      <span className="season-times" title={`Whole season watched ${seasonRepeat}`}>
                        {" "}&middot; {seasonRepeat}
                        <span className="sr-only"> watched</span>
                      </span>
                    )}
                  </span>
                )}
                {inLibrary && (
                  <button
                    type="button"
                    className="season-kebab"
                    aria-label={`Season ${seasonNumber} actions`}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      const el = e.currentTarget;
                      void openSeasonMenu(seasonNumber, rectAnchor(el), el);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <KebabIcon size={18} />
                  </button>
                )}
              </div>
            </div>

            {inLibrary && eps.length > 0 && (
              <div className="season-progress">
                <span style={{ width: `${(watchedCount / eps.length) * 100}%` }} />
              </div>
            )}

            {isExpanded && (
              <>
                {loadingSeason === seasonNumber && <p className="muted small">Fetching episodes...</p>}
                <ul className="episode-list">
                  {eps.map((ep) => {
                    const watched = watchedKeys.has(ep.key);
                    const count = watchCountByKey.get(ep.key) ?? 0;
                    const flash = confirmedKeys.get(ep.key);
                    return (
                      <li
                        key={ep.key}
                        className={`episode-row ${watched ? "watched" : ""}`}
                        {...contextActionProps((anchor, el) => openEpisodeMenu(ep, anchor, el))}
                      >
                        {ep.stillPath ? (
                          <img
                            src={`${TMDB_IMAGE_BASE}${ep.stillPath}`}
                            alt=""
                            aria-hidden="true"
                            className="episode-thumb"
                            onClick={() => setOpenEpisode(ep)}
                          />
                        ) : (
                          <div
                            className="episode-thumb poster-placeholder"
                            aria-hidden="true"
                            onClick={() => setOpenEpisode(ep)}
                          />
                        )}
                        <div
                          className="episode-row-body"
                          role="button"
                          tabIndex={0}
                          onClick={() => setOpenEpisode(ep)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setOpenEpisode(ep);
                            }
                          }}
                        >
                          <span className="ep-number">
                            S{ep.seasonNumber} E{ep.episodeNumber}
                          </span>
                          <span className="ep-name">{ep.name}</span>
                        </div>
                        {/* Unwatched: one tap marks it watched, exactly as before
                            (same fill transition, same catch-up offer). Watched
                            once: the green tick. Watched more: the number of
                            viewings in the tick's place - no separate badge.
                            Either way, tapping it opens the viewing-status
                            choices instead of unmarking on the spot. */}
                        {inLibrary && (
                          <button
                            className={`watch-toggle ${watched ? "on" : ""}${flash === "pop" ? " is-confirmed" : ""}${
                              flash === "minus" ? " is-minus" : ""
                            }`}
                            onClick={(e) => {
                              if (watched) openTickMenu(ep, e.currentTarget);
                              else toggleEpisodeWatched(ep).catch((err) => showErrorToast(err));
                            }}
                            aria-haspopup={watched ? "menu" : undefined}
                            aria-label={watched ? `${viewingsInWords(count)}. Change viewing status` : "Mark watched"}
                          >
                            <WatchMark count={count} minus={flash === "minus"} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  const episodeDetailsModal = openEpisode && details && (
    <EpisodeDetailsPanel
      show={{ name: details.name, imdbId: details.imdbId }}
      episode={openEpisode}
      watched={watchedKeys.has(openEpisode.key)}
      watchCount={watchCountByKey.get(openEpisode.key) ?? 0}
      canToggleWatched={inLibrary}
      // The show-title capsule. This panel IS the show's detail panel, sitting
      // directly beneath the episode layer, so "open the show" is simply
      // getting out of the way — done through the episode panel's own exit
      // (dismissOnOpenSeries) rather than by yanking it off screen.
      onOpenSeries={() => {}}
      dismissOnOpenSeries
      // Shows only: a movie panel has no episode layer to open in the first
      // place, and kind is checked rather than assumed because this JSX is
      // shared by both.
      streamingShowId={kind === "show" ? tmdbId : undefined}
      // Deliberately do NOT close on these: the panel stays open so the
      // watched toggle and the live rewatch count (+N) update in place.
      onToggleWatched={() => toggleEpisodeWatched(openEpisode)}
      onWatchAgain={() => rewatchEpisodes([openEpisode])}
      onWatchedOnce={() => setWatchedOnce([openEpisode])}
      onRemoveLatestViewing={() => removeLastViewing(openEpisode)}
      onClose={() => setOpenEpisode(null)}
    />
  );

  // The artwork at the top. On a phone, the portrait poster, as in the
  // reference: it is the title's own key art and fills a phone's width far
  // better than a letterboxed backdrop. In the wider desktop dialog, the
  // backdrop. Each falls back to the other.
  const heroPath = details ? (isMobile ? details.posterPath ?? details.backdropPath : details.backdropPath ?? details.posterPath) : null;
  const heroIsPoster = !!details && heroPath === details.posterPath;

  return (
    <div
      className={`details-page-root${isMobile ? " is-page" : " is-dialog"}${closing ? " is-leaving" : ""}`}
      onClick={isMobile ? undefined : requestClose}
    >
      <div
        ref={pageRef}
        className={`details-page${primaryAction && !removeConfirming ? " has-cta" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={details?.name ?? "Details"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="details-page-scroll" ref={scrollAreaRef}>
          <div className={`details-page-hero${heroIsPoster ? " is-poster" : ""}`}>
            {heroPath ? (
              <img src={`${TMDB_BACKDROP_BASE}${heroPath}`} alt="" className="details-page-hero-img" />
            ) : (
              <div className="details-page-hero-img details-page-hero-empty" />
            )}
            <div className="details-page-hero-fade" />
          </div>

          <div className="details-page-body">
            {error && <p className="status-error">{error}</p>}
            {!details && !error && <DetailsSkeleton />}
            {details && (
              <>
                <div className="details-page-head">
                  {titleBlock}
                  {genreChips}
                </div>
                {ratingsRowContent}
                {statusContent}
                {overviewContent}
                {secondaryContent}
                {castContent}
                {streamingContent}
                {seasonBrowserBlock}
              </>
            )}
          </div>
        </div>

        {/* Floating over the artwork, out of the content's way: close on
            the left, the ⋯ menu (Remove) on the right. */}
        <div className="details-page-topbar">
          <button className="details-page-icon" onClick={requestClose} aria-label="Close">
            &times;
          </button>
          {titleMenuButton("details-page-icon")}
        </div>

        {/* The main action, floating over the bottom of the page, always in
            reach however far down it has been scrolled. */}
        {primaryAction && !removeConfirming && (
          <div className="details-page-cta">
            <button
              type="button"
              className="details-page-cta-button"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
            >
              {primaryAction.label}
            </button>
          </div>
        )}
      </div>

      {episodeDetailsModal}
      {openPerson && (
        <PersonPage
          key={openPerson.id}
          personId={openPerson.id}
          name={openPerson.name}
          profilePath={openPerson.profilePath}
          onClose={() => setOpenPerson(null)}
        />
      )}
    </div>
  );
}