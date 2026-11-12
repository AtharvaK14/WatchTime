import { useEffect, useRef, useState } from "react";
import { db } from "../db";
import { markNextEpisodeWatched } from "../lib/watchEvents";
import { closePanel } from "../lib/widget/panelHost";
import { haptic } from "../lib/haptics";
import { CheckIcon } from "../components/icons";
import { refreshWidgets } from "./refreshWidgets";

/**
 * What an Up Next widget row's tick opens: no panel, just the write.
 *
 * EpisodePanelActivity is the only place outside the app that can write the
 * library (same origin, same IndexedDB), so the tick goes through it with
 * ?quick=1. This marks the episode watched, refreshes the widgets so the row
 * moves on to the next episode, shows one confirmation line over the home
 * screen and closes on its own. The user never leaves their home screen.
 */

/** How long the confirmation stays before the overlay closes. */
const CONFIRM_MS = 1100;

function code(season: number, episode: number): string {
  return `S${season} E${episode}`;
}

export default function QuickMarkWatched({ showId, episodeKey }: { showId: number; episodeKey: string }) {
  const [message, setMessage] = useState<string | null>(null);
  // The write runs once even under StrictMode's double effect: refs survive
  // its simulated remount, so the second run sees the flag and stops.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
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
        } else {
          await markNextEpisodeWatched(showId, episode);
          await refreshWidgets();
          haptic("confirm");
          setMessage(`Watched · ${label}`);
        }
      } catch {
        setMessage("Couldn't mark it watched. Open WatchTime and try again.");
      }
      window.setTimeout(closePanel, CONFIRM_MS);
    })();
  }, [showId, episodeKey]);

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
