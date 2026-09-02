import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Episode, type Show } from "../db";
import EpisodeDetailsPanel, { type EpisodePanelTransition } from "../components/EpisodeDetailsPanel";
import { markNextEpisodeWatched, recordEpisodeRewatch } from "../lib/watchEvents";
import { canOpenInApp, closePanel, openShowEpisodeListInApp } from "../lib/widget/panelHost";
import { pushSnapshot } from "../lib/widget/bridge";
import { buildWidgetSnapshot, type WidgetSnapshot } from "../lib/widget/snapshot";
import { prefersReducedMotion } from "../lib/useAnimatedDismiss";

/**
 * The episode overlay a widget row opens.
 *
 * This is the whole document when the app is loaded with ?wtpanel=episode - it
 * deliberately does NOT mount App, so tapping a widget row never lands the user
 * on the app's home screen. EpisodePanelActivity renders it in a transparent,
 * dialog-sized window, so what the user sees is a pop-up over their home
 * screen.
 *
 * It renders the app's own EpisodeDetailsPanel, with the same live-derived
 * props Home passes it. There is no second episode panel in this codebase.
 *
 * Because the overlay's WebView is same-origin with the app, these queries hit
 * the real IndexedDB: marking watched here is a genuine write to the library,
 * not a queued intention.
 */

/**
 * How long the "watched" confirmation plays before the panel advances or
 * closes. Must match the .episode-detail-modal.is-leave-watched animation in
 * index.css - short enough that a binge is not slowed down, long enough that
 * the tick is actually seen.
 */
const WATCHED_TRANSITION_MS = 420;

/** How long the incoming panel's entrance runs; matches .is-enter in index.css. */
const ENTER_TRANSITION_MS = 260;

interface Target {
  showId: number;
  episodeKey: string;
}

/**
 * Where the overlay goes after an episode has been marked watched, chosen from
 * the SAME recomputed snapshot the widgets are about to render.
 *
 * Deriving it from the snapshot rather than querying separately is what
 * guarantees the panel and the widget behind it agree: the user cannot be
 * advanced onto an episode the widget is not showing, or left on one it has
 * dropped.
 *
 * The show just watched comes first when it still has a row - having finished
 * an episode, the natural next thing is the next episode of that same show,
 * and it is genuinely in Up Next. Otherwise (the show is now caught up) the
 * top of the list is the honest answer. Null means Up Next is empty and there
 * is nothing to advance to, which is the "close gracefully" case.
 */
function pickNextTarget(
  snapshot: WidgetSnapshot,
  justWatched: Target
): Target | null {
  const rows = snapshot.watchNext.filter((r) => r.episodeKey !== justWatched.episodeKey);
  const sameShow = rows.find((r) => r.showId === justWatched.showId);
  const row = sameShow ?? rows[0];
  return row ? { showId: row.showId, episodeKey: row.episodeKey } : null;
}

export default function EpisodePanelApp({
  showId,
  episodeKey,
  canToggleWatched,
}: {
  showId: number;
  episodeKey: string;
  /** False for Coming Up rows: an episode that has not aired cannot be watched. */
  canToggleWatched: boolean;
}) {
  // The episode currently on screen. Starts as the row the user tapped and
  // then walks forward through Up Next as episodes are marked watched, so a
  // second episode never needs a second trip to the widget.
  const [target, setTarget] = useState<Target>({ showId, episodeKey });
  const [transition, setTransition] = useState<EpisodePanelTransition | undefined>(undefined);
  // Whether a hand-off is mid-flight, so a double tap cannot start a second
  // one over the first. Deliberately NOT derived from `transition`: that stays
  // at "enter" once an advance has happened (see setTransition below), so
  // using it as the guard would silently block every mark after the first -
  // which is exactly what a binge does.
  const handingOff = useRef(false);
  // Everything in flight is cancelled on unmount; without this a pending
  // advance could call setState after the activity has torn the WebView down.
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
    };
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    // Reduced motion means the CSS durations are ~0, so waiting them out would
    // just be dead time between the tap and the result.
    if (prefersReducedMotion()) {
      fn();
      return;
    }
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  /**
   * The next episode's records, read once before the hand-off starts.
   *
   * useLiveQuery resets to undefined while it re-runs for a changed key, and
   * this component renders nothing when it has no episode - which on a
   * transparent overlay window means the panel visibly blinks out and back in
   * mid-transition, the exact abruptness this hand-off exists to remove. The
   * seed covers only that gap: live data wins the moment it arrives, and the
   * seed is dropped as soon as the entrance finishes.
   */
  const seedRef = useRef<{ key: string; episode: Episode; show: Show } | null>(null);

  const liveEpisode = useLiveQuery(() => db.episodes.get(target.episodeKey), [target.episodeKey]);
  const liveShow = useLiveQuery(() => db.shows.get(target.showId), [target.showId]);
  const watch = useLiveQuery(() => db.watchedEpisodes.get(target.episodeKey), [target.episodeKey]);

  const seed = seedRef.current?.key === target.episodeKey ? seedRef.current : null;
  const episode = liveEpisode ?? seed?.episode;
  const show = liveShow ?? seed?.show;

  /**
   * Rebuilds the snapshot from the library as it now stands and hands it to
   * native, which stores it and redraws every placed widget.
   *
   * This is the fix for the widget not updating after a watch: the recompute
   * runs right here, in the process that just did the write, so the widget is
   * correct before the overlay even closes. Nothing waits on the app being
   * launched.
   *
   * It returns the snapshot as well as pushing it, because the overlay needs
   * the very same Up Next list to decide which episode to advance to.
   */
  async function refreshWidgets(): Promise<WidgetSnapshot> {
    const [shows, episodes, watched, movies] = await Promise.all([
      db.shows.toArray(),
      db.episodes.toArray(),
      db.watchedEpisodes.toArray(),
      db.movies.toArray(),
    ]);
    const snapshot = buildWidgetSnapshot(shows, episodes, watched, movies);
    await pushSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Marking watched, as a sequence rather than a write followed by a
   * disappearing window:
   *
   *   confirm the watch -> this episode leaves -> the next one arrives
   *
   * and when Up Next has nothing left, the same confirmation followed by a
   * close. The panel used to vanish the instant the write landed, which gave
   * the user nothing to read the outcome from and meant a second episode
   * needed a second trip to the widget.
   */
  async function handleMarkWatched(current: Target, ep: Episode) {
    if (handingOff.current) return; // one is already playing
    handingOff.current = true;
    await markNextEpisodeWatched(current.showId, ep);
    const snapshot = await refreshWidgets();
    const next = pickNextTarget(snapshot, current);

    // Read the next episode's records now, while the confirmation is playing,
    // so the swap itself has no asynchronous gap in it. A row that came out of
    // the snapshot we just built is in the database by definition, so a miss
    // here means something removed it in the last few milliseconds - treated
    // as "nothing to advance to" rather than advancing onto a blank panel.
    const seeded =
      next &&
      (await (async () => {
        const [nextEpisode, nextShow] = await Promise.all([
          db.episodes.get(next.episodeKey),
          db.shows.get(next.showId),
        ]);
        return nextEpisode && nextShow
          ? { key: next.episodeKey, episode: nextEpisode, show: nextShow }
          : null;
      })());

    setTransition("leave-watched");
    after(WATCHED_TRANSITION_MS, () => {
      if (!next || !seeded) {
        // Nothing left in Up Next: close, rather than sit on an episode the
        // widget no longer lists.
        closePanel();
        return;
      }
      // Released here rather than after the entrance: the next episode is on
      // screen and its button is live, so a fast second tap should be taken.
      handingOff.current = false;
      seedRef.current = seeded;
      setTarget(next);
      // Left set, never cleared back to undefined: clearing it would change
      // the panel's computed animation-name back to the base entrance, which
      // the browser starts as a new animation - so the panel would arrive and
      // then immediately fade in again. Holding "enter" is also what makes the
      // NEXT hand-off animate, since "enter" -> "leave-watched" -> "enter" is
      // a real change each time.
      setTransition("enter");
      // The seed exists only to cover the gap before Dexie answers for the new
      // key, so it is dropped as soon as the entrance is over.
      after(ENTER_TRANSITION_MS, () => {
        seedRef.current = null;
      });
    });
  }

  // Dexie has not answered yet. Rendering nothing keeps the window fully
  // transparent for the moment it takes, rather than flashing an empty card.
  if (episode === undefined || show === undefined) return null;

  // The episode or show is gone (removed from the library while the widget
  // still listed it). Closing is the honest outcome; the widget will drop the
  // row on its next snapshot.
  if (!episode || !show) {
    closePanel();
    return null;
  }

  return (
    <EpisodeDetailsPanel
      // Deliberately NO key: the panel keeps its DOM node across an advance,
      // so the entrance animates the same card filling with the next episode
      // rather than one card being destroyed and another created. The class
      // change from "leave-watched" to "enter" is what restarts the animation,
      // and the panel's own effects re-run on the new episode regardless.
      show={{ name: show.name, imdbId: show.imdbId }}
      episode={episode}
      watched={watch !== undefined}
      watchCount={watch?.watchCount ?? 0}
      canToggleWatched={canToggleWatched}
      transition={transition}
      // The one deliberate route out of the overlay and into the app. Offered
      // only when the host actually supports it, so an older APK shows plain
      // text rather than a control that would do nothing.
      onOpenFullEpisodeList={
        canOpenInApp()
          ? () => openShowEpisodeListInApp(show.tmdbId, episode.seasonNumber)
          : undefined
      }
      onToggleWatched={async () => {
        if (watch) {
          // Un-marking is a correction, not the end of the interaction: the
          // panel stays open and updates in place, exactly as before.
          await db.watchedEpisodes.delete(episode.key);
          await refreshWidgets();
          return;
        }
        await handleMarkWatched(target, episode);
      }}
      onWatchAgain={async () => {
        await recordEpisodeRewatch(show.tmdbId, [episode]);
        await refreshWidgets();
      }}
      onClose={closePanel}
    />
  );
}
