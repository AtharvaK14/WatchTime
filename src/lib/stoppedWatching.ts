// "I'm not watching this any more", as a first-class state.
//
// It reads and writes Show.isArchived rather than introducing a second flag
// beside it, because that field already IS this state everywhere else in the
// app and has been since the first TV Time import:
//
//   - pages/Library.tsx offers it as the "Stopped" watch-status filter and
//     labels those cards "Stopped"
//   - lib/recommend/signals.ts reads it as "stopped watching" when deciding
//     which titles may seed recommendations
//   - lib/notifications/events.ts and lib/widget/snapshot.ts both already
//     exclude it, so neither a notification nor a widget row can come from a
//     stopped show
//   - the JSON importer sets it from TV Time's own "stopped" status
//
// A parallel `stoppedWatching` column would have meant two sources of truth
// for one idea, a migration to reconcile them, and an imported "stopped" show
// landing in a state the new column knew nothing about. What was actually
// missing was not the field: it was any way for the user to SET it, and
// anywhere in the app that showed them what they had set.
//
// The one thing this deliberately does not do is infer the state. Time alone
// is not consent: a long break is not the same as giving up, and a show that
// is merely stale must stay stale (and stay visible) rather than being quietly
// filed away. The automatic half of the problem - a release that should not
// reactivate an abandoned show - is handled in lib/releaseState.ts by looking
// at unwatched backlog, and that never writes anything.

import { db, type Show } from "../db";

/** Whether the user has said they are done with this show. */
export function isStoppedWatching(show: Pick<Show, "isArchived">): boolean {
  return show.isArchived;
}

/**
 * Marks a show stopped. Watch history, ratings and library membership are all
 * untouched - this changes how the show is TREATED, and nothing about what is
 * recorded against it, so resuming restores the show exactly as it was.
 */
export async function stopWatchingShow(tmdbId: number): Promise<void> {
  await db.shows.update(tmdbId, { isArchived: true });
}

/**
 * Undoes it.
 *
 * There is nothing to recalculate here: every category is derived on each
 * render from watch history and release state (see lib/watchNext.ts), so
 * clearing the flag is enough for the show to land wherever it now belongs -
 * including straight into Watch Next when a new season arrived while it was
 * stopped and the user was caught up before that.
 *
 * isFollowed is set alongside it for the case where a show was imported
 * unfollowed AND archived: resuming a show the user cannot then see in any
 * list would be a dead end, and "I am watching this again" implies following
 * it. It is already true for everything that reaches the Home lists, so for
 * those this writes the value it already had.
 */
export async function resumeWatchingShow(tmdbId: number): Promise<void> {
  await db.shows.update(tmdbId, { isArchived: false, isFollowed: true });
}
