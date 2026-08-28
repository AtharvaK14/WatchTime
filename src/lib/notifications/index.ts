// Permission handling and OS scheduling for library notifications.
//
// These are LOCAL notifications, not push. The app has no server and no FCM
// project, and it does not need one: everything worth announcing (episode air
// dates, movie release dates) is already in the local database, fetched from
// TMDB by the same sync Home relies on. Local scheduling also keeps the
// library on the device, which push would not.
//
// Event selection lives in ./events.ts and is deliberately pure. This file
// only decides whether it is allowed to fire anything, converts events into
// OS alarms, and routes taps back into the app.

import { Capacitor } from "@capacitor/core";
import { LocalNotifications, type PermissionStatus } from "@capacitor/local-notifications";
import { db } from "../../db";
import { getMovieReleaseDates } from "../../tmdb";
import { requestDeepLink, parseDeepLinkTarget } from "../deepLink";
import { buildNotificationEvents, notificationId, todayIso, type NotificationEvent } from "./events";
import {
  getNotificationHour,
  kindEnabled,
  markPermissionRequested,
  notificationsEnabled,
  permissionAlreadyRequested,
} from "./prefs";

const CHANNEL_ID = "library_releases";

/**
 * Upper bound on alarms held at once. Android's own limit on pending alarms
 * per app is finite, and a large library of returning shows can generate
 * hundreds of events inside the horizon. Taking the soonest N is correct
 * rather than merely safe: the scheduler re-runs on every resume, so anything
 * trimmed is picked back up long before its date.
 */
const MAX_SCHEDULED = 60;

export type NotificationAvailability = "unsupported" | "granted" | "denied" | "prompt";

/** Local notifications need the native shell; the browser build has no scheduler. */
export function notificationsSupported(): boolean {
  return Capacitor.isNativePlatform();
}

function toAvailability(status: PermissionStatus): NotificationAvailability {
  if (status.display === "granted") return "granted";
  if (status.display === "denied") return "denied";
  return "prompt";
}

export async function checkNotificationPermission(): Promise<NotificationAvailability> {
  if (!notificationsSupported()) return "unsupported";
  try {
    return toAvailability(await LocalNotifications.checkPermissions());
  } catch {
    return "unsupported";
  }
}

/**
 * Requests the OS permission. Only ever called from an explicit user action
 * (the Settings toggle), never on launch - Android 13+ requires
 * POST_NOTIFICATIONS at runtime and the platform guidance is to ask in
 * context, once, after the user has shown they want the feature.
 *
 * The one-shot nature of the system dialog is why permissionAlreadyRequested()
 * is recorded here: a second request would resolve "denied" with no UI at all,
 * so the caller must be able to tell "the user said no" from "we never asked"
 * and send them to system settings instead of re-prompting into a void.
 */
export async function requestNotificationPermission(): Promise<NotificationAvailability> {
  if (!notificationsSupported()) return "unsupported";
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === "granted") return "granted";
    markPermissionRequested();
    return toAvailability(await LocalNotifications.requestPermissions());
  } catch {
    return "unsupported";
  }
}

/** True when asking again would show no dialog, so the UI must point at system settings. */
export function mustUseSystemSettings(availability: NotificationAvailability): boolean {
  return availability === "denied" && permissionAlreadyRequested();
}

async function ensureChannel(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return;
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: "Releases from your library",
      description: "New episodes, season premieres and movie releases for titles you follow.",
      importance: 3, // DEFAULT: shows in the shade and makes a sound, never interrupts full-screen
      visibility: 1, // public lock-screen visibility; nothing here is sensitive
    });
  } catch {
    // A channel that already exists, or an OS that predates channels. Neither
    // is a failure - scheduling still works, so this must not abort the run.
  }
}

/**
 * Fills in Movie.digitalReleaseDate for the small set of movies a digital
 * notification could plausibly be about.
 *
 * Scoped hard on purpose: unwatched movies only, and only those whose
 * theatrical date is recent or still ahead (a film from 2011 is not about to
 * get a digital release announcement). An unbounded backfill would spend one
 * TMDB request per movie across an imported library of hundreds, for a field
 * almost none of them need. `undefined` means never looked up and `null`
 * means looked up and absent, so a null is never retried.
 */
async function backfillDigitalReleaseDates(limit = 12): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 120);
  const earliestRelevant = todayIso(cutoff);

  const movies = await db.movies.toArray();
  const candidates = movies
    .filter(
      (m) =>
        !m.watched &&
        m.digitalReleaseDate === undefined &&
        m.releaseDate !== undefined &&
        m.releaseDate !== null &&
        m.releaseDate >= earliestRelevant
    )
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    .slice(0, limit);

  for (const movie of candidates) {
    try {
      const dates = await getMovieReleaseDates(movie.tmdbId);
      await db.movies.update(movie.tmdbId, {
        digitalReleaseDate: dates.digital,
        // The typed theatrical date is more precise than TMDB's generic
        // release_date when both exist, but a missing one must never wipe
        // the value already stored.
        ...(dates.theatrical ? { releaseDate: dates.theatrical } : {}),
      });
    } catch {
      // Rate limit, offline, or a movie TMDB has no release data for. Left
      // undefined so a later run retries, the same way Home's episode sync
      // collects failures instead of aborting the batch.
    }
  }
}

function scheduleTimeFor(event: NotificationEvent, hour: number): Date {
  const at = new Date(`${event.date}T00:00:00`);
  at.setHours(hour, 0, 0, 0);
  return at;
}

/**
 * Reconciles the OS's pending alarms with what the library currently implies.
 *
 * Idempotent by construction: ids are a stable hash of the event id, so
 * re-running replaces rather than duplicates, and anything pending that no
 * longer corresponds to a wanted event is cancelled. That cancellation is
 * what makes the feature respect library changes - unfollow a show or mark a
 * movie watched and its queued notifications disappear on the next run,
 * instead of firing days later for something no longer in the library.
 */
export async function syncScheduledNotifications(): Promise<number> {
  if (!notificationsSupported() || !notificationsEnabled()) return 0;
  if ((await checkNotificationPermission()) !== "granted") return 0;

  await ensureChannel();
  await backfillDigitalReleaseDates().catch(() => {});

  const [shows, episodes, movies] = await Promise.all([
    db.shows.toArray(),
    db.episodes.toArray(),
    db.movies.toArray(),
  ]);

  const hour = getNotificationHour();
  const now = Date.now();
  const wanted = buildNotificationEvents(shows, episodes, movies)
    .filter((e) => kindEnabled(e.kind))
    // An event whose fire time has already passed today would be delivered
    // immediately by the OS, which is wrong: the user would get a burst of
    // "airs today" alerts every time they opened the app after 9am.
    .filter((e) => scheduleTimeFor(e, hour).getTime() > now)
    .slice(0, MAX_SCHEDULED);

  const wantedIds = new Set(wanted.map((e) => notificationId(e.eventId)));

  const pending = await LocalNotifications.getPending();
  const stale = pending.notifications.filter((n) => !wantedIds.has(n.id));
  if (stale.length > 0) {
    await LocalNotifications.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
  }

  if (wanted.length > 0) {
    await LocalNotifications.schedule({
      notifications: wanted.map((event) => ({
        id: notificationId(event.eventId),
        title: event.title,
        body: event.body,
        channelId: CHANNEL_ID,
        schedule: { at: scheduleTimeFor(event, hour), allowWhileIdle: true },
        // Carried through the tap so the app can open the exact title.
        extra: { ...event.target, eventKind: event.kind },
      })),
    });
  }

  return wanted.length;
}

/** Drops every queued notification. Called when the user turns the feature off. */
export async function cancelAllNotifications(): Promise<void> {
  if (!notificationsSupported()) return;
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
  } catch {
    // Nothing pending, or no permission to enumerate. Either way there is
    // nothing left to cancel.
  }
}

/**
 * Wires taps to the deep-link store. Registered once from App; the returned
 * cleanup removes the listener.
 */
export function initNotificationTapHandling(): () => void {
  if (!notificationsSupported()) return () => {};
  const handle = LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
    const target = parseDeepLinkTarget(action.notification.extra);
    if (target) requestDeepLink(target);
  });
  return () => {
    handle.then((h) => h.remove()).catch(() => {});
  };
}
