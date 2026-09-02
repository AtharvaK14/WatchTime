import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import DetailsPanel from "./DetailsPanel";
import EpisodeDetailsPanel from "./EpisodeDetailsPanel";
import { onDeepLink, type DeepLinkTarget } from "../lib/deepLink";
import { markNextEpisodeWatched, recordEpisodeRewatch } from "../lib/watchEvents";

/**
 * Opens the app's existing detail panels in response to a tapped notification
 * or a tapped widget row.
 *
 * There is deliberately no new UI here. The episode case renders the very
 * same EpisodeDetailsPanel the Watch Next list and the season browser open,
 * with the same live-derived props and the same handlers, so an episode
 * reached from the home screen looks and behaves identically to one reached
 * by tapping through the app - including marking it watched, which goes
 * through the same write path and therefore updates Up Next and the widget.
 *
 * It sits at App level rather than inside Home because a deep link must work
 * whatever tab the user was last on, including a cold start.
 */
export default function DeepLinkHost() {
  const [target, setTarget] = useState<DeepLinkTarget | null>(null);

  useEffect(() => onDeepLink(setTarget), []);

  const episodeTarget = target?.kind === "episode" ? target : null;

  // Both reads are live queries keyed on the target, mirroring how Home
  // derives the open panel's state: ticking the episode re-renders the panel
  // in place instead of leaving a stale snapshot on screen.
  const episode = useLiveQuery(
    async () => (episodeTarget ? await db.episodes.get(episodeTarget.episodeKey) : undefined),
    [episodeTarget?.episodeKey]
  );
  const show = useLiveQuery(
    async () => (episodeTarget ? await db.shows.get(episodeTarget.showId) : undefined),
    [episodeTarget?.showId]
  );
  const watch = useLiveQuery(
    async () => (episodeTarget ? await db.watchedEpisodes.get(episodeTarget.episodeKey) : undefined),
    [episodeTarget?.episodeKey]
  );

  if (!target) return null;

  if (target.kind === "show") {
    // seasonNumber is only present on the widget overlay's "open the full
    // episode list" handoff; every other show link leaves it undefined and
    // opens the panel collapsed, exactly as before.
    return (
      <DetailsPanel
        kind="show"
        tmdbId={target.tmdbId}
        initialSeason={target.seasonNumber}
        onClose={() => setTarget(null)}
      />
    );
  }

  if (target.kind === "movie") {
    return <DetailsPanel kind="movie" tmdbId={target.tmdbId} onClose={() => setTarget(null)} />;
  }

  // The episode row may not be cached yet (a notification for a show whose
  // seasons were never synced on this device). Falling back to the show panel
  // is better than an empty overlay: it is still the right title, and opening
  // it triggers the season fetch that makes the episode available next time.
  if (!episode || !show) {
    return <DetailsPanel kind="show" tmdbId={target.showId} onClose={() => setTarget(null)} />;
  }

  return (
    <EpisodeDetailsPanel
      show={{ name: show.name, imdbId: show.imdbId }}
      episode={episode}
      watched={watch !== undefined}
      watchCount={watch?.watchCount ?? 0}
      // Stays open on toggle, exactly as it does when opened from Watch Next.
      onToggleWatched={async () => {
        if (watch) await db.watchedEpisodes.delete(episode.key);
        else await markNextEpisodeWatched(show.tmdbId, episode);
      }}
      onWatchAgain={() => recordEpisodeRewatch(show.tmdbId, [episode])}
      onClose={() => setTarget(null)}
    />
  );
}
