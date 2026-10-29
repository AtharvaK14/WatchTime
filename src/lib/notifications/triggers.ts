// Which library writes can change what may be announced.
//
// Notification eligibility (releaseAlertEligibility in lib/watchNext.ts) is
// read from watch history and two show flags. The native schedule is a
// snapshot of it, so any write to those has to reach the scheduler: stopping
// a show must take its queued releases out of the schedule now, not at the
// next app resume, and starting one has to put them in.
//
// Those writes come from a dozen places - the details panel, Home's cards, the
// widget's episode panel, deep links, both importers, backup restore, library
// removal - so the triggers are table hooks rather than calls sprinkled at
// each site. A write path added later is covered without anyone remembering.

import { db, type Show, type WatchedEpisode } from "../../db";

/**
 * Show fields eligibility reads. Everything else a sync or backfill writes
 * (episode totals, overviews, runtimes) changes nothing about it, and would
 * otherwise reschedule once per show on every sync.
 */
const SHOW_FIELDS: readonly (keyof Show)[] = ["isFollowed", "isArchived"];

/**
 * Watch fields eligibility reads: watchedAt is the progression date the stale
 * rule measures. A rewatch only moves watchCount and lastWatchedAt, which it
 * ignores.
 */
const WATCH_FIELDS: readonly (keyof WatchedEpisode)[] = ["watchedAt", "showId"];

/**
 * Calls `onChange` after any write that can change a show's eligibility.
 * Returns the unsubscribe. `onChange` runs inside the writing transaction, so
 * it must only schedule work (requestNotificationSync() debounces), never do
 * it.
 */
export function watchEligibilityInputs(onChange: () => void): () => void {
  const changed = () => {
    onChange();
  };
  const showUpdated = (mods: object) => {
    if (SHOW_FIELDS.some((f) => f in mods)) onChange();
  };
  const watchUpdated = (mods: object) => {
    if (WATCH_FIELDS.some((f) => f in mods)) onChange();
  };

  db.shows.hook("creating", changed);
  db.shows.hook("updating", showUpdated);
  db.shows.hook("deleting", changed);
  db.watchedEpisodes.hook("creating", changed);
  db.watchedEpisodes.hook("updating", watchUpdated);
  db.watchedEpisodes.hook("deleting", changed);

  return () => {
    db.shows.hook("creating").unsubscribe(changed);
    db.shows.hook("updating").unsubscribe(showUpdated);
    db.shows.hook("deleting").unsubscribe(changed);
    db.watchedEpisodes.hook("creating").unsubscribe(changed);
    db.watchedEpisodes.hook("updating").unsubscribe(watchUpdated);
    db.watchedEpisodes.hook("deleting").unsubscribe(changed);
  };
}
