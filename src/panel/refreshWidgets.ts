import { db } from "../db";
import { pushSnapshot } from "../lib/widget/bridge";
import { buildWidgetSnapshot, type WidgetSnapshot } from "../lib/widget/snapshot";

/**
 * Rebuilds the snapshot from the library as it now stands and hands it to
 * native, which stores it and redraws every placed widget.
 *
 * The recompute runs right here, in the overlay process that just did the
 * write, so the widget is correct before the overlay even closes. Nothing
 * waits on the app being launched.
 *
 * It returns the snapshot as well as pushing it, because the overlay needs the
 * very same Up Next list to decide which episode to advance to.
 */
export async function refreshWidgets(): Promise<WidgetSnapshot> {
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
