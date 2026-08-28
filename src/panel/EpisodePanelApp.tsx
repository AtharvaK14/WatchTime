import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import EpisodeDetailsPanel from "../components/EpisodeDetailsPanel";
import { markNextEpisodeWatched, recordEpisodeRewatch } from "../lib/watchEvents";
import { closePanel } from "../lib/widget/panelHost";
import { pushSnapshot } from "../lib/widget/bridge";
import { buildWidgetSnapshot } from "../lib/widget/snapshot";

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
  const episode = useLiveQuery(() => db.episodes.get(episodeKey), [episodeKey]);
  const show = useLiveQuery(() => db.shows.get(showId), [showId]);
  const watch = useLiveQuery(() => db.watchedEpisodes.get(episodeKey), [episodeKey]);

  /**
   * Rebuilds the snapshot from the library as it now stands and hands it to
   * native, which stores it and redraws every placed widget.
   *
   * This is the fix for the widget not updating after a watch: the recompute
   * runs right here, in the process that just did the write, so the widget is
   * correct before the overlay even closes. Nothing waits on the app being
   * launched.
   */
  async function refreshWidgets() {
    const [shows, episodes, watched, movies] = await Promise.all([
      db.shows.toArray(),
      db.episodes.toArray(),
      db.watchedEpisodes.toArray(),
      db.movies.toArray(),
    ]);
    await pushSnapshot(buildWidgetSnapshot(shows, episodes, watched, movies));
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
      show={{ name: show.name, imdbId: show.imdbId }}
      episode={episode}
      watched={watch !== undefined}
      watchCount={watch?.watchCount ?? 0}
      canToggleWatched={canToggleWatched}
      onToggleWatched={async () => {
        if (watch) await db.watchedEpisodes.delete(episode.key);
        else await markNextEpisodeWatched(show.tmdbId, episode);
        await refreshWidgets();
        // Marking watched is the end of this interaction: the row the user
        // tapped is no longer in Watch Next, so keeping the overlay open on a
        // now-irrelevant episode would be odd. Un-marking deliberately does
        // not close - that is a correction, and the panel updates in place.
        if (!watch) closePanel();
      }}
      onWatchAgain={async () => {
        await recordEpisodeRewatch(show.tmdbId, [episode]);
        await refreshWidgets();
      }}
      onClose={closePanel}
    />
  );
}
