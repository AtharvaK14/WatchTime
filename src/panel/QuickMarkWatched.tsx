import { useEffect, useRef, useState } from "react";
import { db } from "../db";
import { markNextEpisodeWatched } from "../lib/watchEvents";
import { setMovieWatched } from "../lib/movieWatched";
import { closePanel } from "../lib/widget/panelHost";
import { haptic } from "../lib/haptics";
import { CheckIcon } from "../components/icons";
import { pushSnapshot } from "../lib/widget/bridge";
import { refreshWidgets, snapshotNow } from "./refreshWidgets";

/**
 * What an Up Next or Movies to Watch widget row's tick opens: no panel,
 * just the write.
 *
 * EpisodePanelActivity is the only place outside the app that can write the
 * library (same origin, same IndexedDB), so the tick goes through it with
 * ?quick=1. This marks the episode watched and shows one confirmation line
 * over the home screen, while the widget behind plays the app's Up Next
 * sequence in two redraws: first the row under the app's green veil with the
 * white tick (or "That's all folks!" when the show has nothing left), then,
 * WIDGET_HOLD_MS later, the real Up Next with the row moved on. A widget
 * cannot run animations of its own, so the confirmation is a held state
 * rather than a transition; without it the row just vanished. The overlay
 * then closes by itself, and the user never leaves their home screen.
 */

/** How long the widget row shows the watched veil before moving on. */
const WIDGET_HOLD_MS = 1100;
/** How long the confirmation line stays after the row has moved on. */
const CLOSE_AFTER_MS = 450;

function code(season: number, episode: number): string {
  return `S${season} E${episode}`;
}

/** An Up Next row's tick (an episode), or a Movies to Watch row's (a movie). */
type QuickTarget = { kind: "episode"; showId: number; episodeKey: string } | { kind: "movie"; tmdbId: number };

export default function QuickMarkWatched({ target }: { target: QuickTarget }) {
  const [message, setMessage] = useState<string | null>(null);
  // The write runs once even under StrictMode's double effect: refs survive
  // its simulated remount, so the second run sees the flag and stops.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        if (target.kind === "movie") {
          await markMovie(target.tmdbId);
          return;
        }
        const { showId, episodeKey } = target;
        const [episode, show, watched] = await Promise.all([
          db.episodes.get(episodeKey),
          db.shows.get(showId),
          db.watchedEpisodes.get(episodeKey),
        ]);
        if (!episode || !show) {
          // Removed from the library since the widget last drew: just redraw.
          await refreshWidgets();
          closePanel();
          return;
        }
        const label = `${show.name} · ${code(episode.seasonNumber, episode.episodeNumber)}`;
        if (watched) {
          // The widget was behind the library (watched in the app a moment
          // ago). Tapping again must not quietly count a rewatch.
          await refreshWidgets();
          setMessage(`Already watched · ${label}`);
          window.setTimeout(closePanel, WIDGET_HOLD_MS);
          return;
        }
        // The row as the widget shows it now, read before the write.
        const before = await snapshotNow();
        await markNextEpisodeWatched(showId, episode);
        const after = await snapshotNow();
        const hasNext = after.watchNext.some((r) => r.showId === showId);
        haptic("confirm");
        setMessage(hasNext ? `Watched · ${label}` : `Watched · ${label} · All caught up`);
        if (before.watchNext.some((r) => r.episodeKey === episodeKey)) {
          await pushSnapshot({
            ...before,
            watchNext: before.watchNext.map((r) =>
              r.episodeKey === episodeKey ? { ...r, watchedPhase: hasNext ? "next" : "done" } : r
            ),
          });
          await new Promise((r) => window.setTimeout(r, WIDGET_HOLD_MS));
        }
        await pushSnapshot(after);
        window.setTimeout(closePanel, CLOSE_AFTER_MS);
      } catch {
        setMessage("Couldn't mark it watched. Open WatchTime and try again.");
        window.setTimeout(closePanel, WIDGET_HOLD_MS);
      }
    })();

    /** The movie version: the row takes the veil with the tick, then leaves the list. */
    async function markMovie(tmdbId: number) {
      const movie = await db.movies.get(tmdbId);
      if (!movie) {
        await refreshWidgets();
        closePanel();
        return;
      }
      if (movie.watched) {
        await refreshWidgets();
        setMessage(`Already watched · ${movie.title}`);
        window.setTimeout(closePanel, WIDGET_HOLD_MS);
        return;
      }
      const before = await snapshotNow();
      await setMovieWatched(tmdbId, true);
      const after = await snapshotNow();
      haptic("confirm");
      setMessage(`Watched · ${movie.title}`);
      if (before.moviesToWatch.some((r) => r.tmdbId === tmdbId)) {
        await pushSnapshot({
          ...before,
          moviesToWatch: before.moviesToWatch.map((r) => (r.tmdbId === tmdbId ? { ...r, watchedPhase: "next" } : r)),
        });
        await new Promise((r) => window.setTimeout(r, WIDGET_HOLD_MS));
      }
      await pushSnapshot(after);
      window.setTimeout(closePanel, CLOSE_AFTER_MS);
    }
  }, [target]);

  if (!message) return null;
  return (
    <div className="quick-watched" role="status">
      <span className="quick-watched-tick" aria-hidden="true">
        <CheckIcon />
      </span>
      <span className="quick-watched-text">{message}</span>
    </div>
  );
}
