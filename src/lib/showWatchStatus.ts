import { db, type Episode, type Show, type WatchedEpisode } from "../db";
import { ensureEpisodesCached, findNextUnwatched } from "./episodeSync";

export type ShowWatchStatus = "not-started" | "currently-watching" | "up-to-date" | "unknown";

function fromTvTimeStatus(status: NonNullable<Show["tvTimeStatus"]>): ShowWatchStatus {
  switch (status) {
    case "continuing":
      return "currently-watching";
    case "up_to_date":
      return "up-to-date";
    case "not_started_yet":
    case "watch_later":
      return "not-started";
    case "stopped":
      return "unknown"; // archived shows are filtered elsewhere; status here is moot
  }
}

/**
 * Requires episodes to already be cached (call ensureEpisodesCached first
 * if you need this to be reliable rather than "unknown"). Deliberately
 * doesn't fetch here itself, callers decide whether the cost of a fetch is
 * worth it for their view (Home always syncs; a big Library grid might not
 * want to force a TMDB fetch per show just to compute a filter).
 *
 * Combines TV Time's own tvTimeStatus (a snapshot from whenever you last
 * imported) with a live comparison against watched episodes, rather than
 * trusting the imported field exclusively. tvTimeStatus goes stale the
 * moment you mark anything watched or unwatched directly in this app, so
 * always checking live data too means a show doesn't get permanently stuck
 * on whatever status it happened to have at import time.
 */
export async function computeWatchStatus(tmdbId: number): Promise<ShowWatchStatus> {
  const show = await db.shows.get(tmdbId);
  const episodes = await db.episodes.where("showId").equals(tmdbId).toArray();
  const watched = await db.watchedEpisodes.where("showId").equals(tmdbId).toArray();
  return watchStatusOf(show, episodes, watched);
}

/**
 * The status itself, from rows already in hand. Pure: the Shows grid works
 * every show's status out from the tables it already holds in memory, in one
 * pass, rather than asking the database three questions per show.
 */
export function watchStatusOf(
  show: Pick<Show, "tvTimeStatus"> | undefined,
  episodes: Episode[],
  watched: Pick<WatchedEpisode, "key">[]
): ShowWatchStatus {
  let liveStatus: ShowWatchStatus = "unknown";
  if (episodes.length > 0) {
    if (watched.length === 0) {
      liveStatus = "not-started";
    } else {
      const watchedKeys = new Set(watched.map((w) => w.key));
      const next = findNextUnwatched(episodes, watchedKeys);
      liveStatus = next ? "currently-watching" : "up-to-date";
    }
  }

  if (!show?.tvTimeStatus) return liveStatus;

  const imported = fromTvTimeStatus(show.tvTimeStatus);
  // If either signal says "currently watching," trust that, it means
  // there's real evidence of something to watch even if the other signal
  // (usually the stale imported one) disagrees.
  if (imported === "currently-watching" || liveStatus === "currently-watching") return "currently-watching";
  // Otherwise prefer the live signal when we actually have episode data to
  // base it on, falling back to the import snapshot only when we don't.
  return liveStatus !== "unknown" ? liveStatus : imported;
}

/** Every show's status at once, from whole tables. Rows are grouped by show in one pass each. */
export function watchStatusByShow(
  shows: readonly Show[],
  episodes: readonly Episode[],
  watched: readonly WatchedEpisode[]
): Map<number, ShowWatchStatus> {
  const episodesByShow = new Map<number, Episode[]>();
  for (const ep of episodes) {
    const list = episodesByShow.get(ep.showId);
    if (list) list.push(ep);
    else episodesByShow.set(ep.showId, [ep]);
  }
  const watchedByShow = new Map<number, WatchedEpisode[]>();
  for (const w of watched) {
    const list = watchedByShow.get(w.showId);
    if (list) list.push(w);
    else watchedByShow.set(w.showId, [w]);
  }
  const statuses = new Map<number, ShowWatchStatus>();
  for (const show of shows) {
    statuses.set(
      show.tmdbId,
      watchStatusOf(show, episodesByShow.get(show.tmdbId) ?? [], watchedByShow.get(show.tmdbId) ?? [])
    );
  }
  return statuses;
}

/** Same as computeWatchStatus, but forces an episode-list sync first so the TMDB-comparison fallback is reliable. */
export async function computeWatchStatusFresh(tmdbId: number): Promise<ShowWatchStatus> {
  await ensureEpisodesCached(tmdbId);
  return computeWatchStatus(tmdbId);
}
