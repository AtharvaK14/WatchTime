// Permission handling and scheduling for library notifications.
//
// These are LOCAL notifications, not push. The app has no server and no FCM
// project, and it does not need one: everything worth announcing (episode air
// dates, movie release dates) is already in the local database, fetched from
// TMDB by the same sync Home relies on. Local scheduling also keeps the
// library on the device, which push would not.
//
// Event selection lives in ./events.ts and is deliberately pure. Delivery
// lives natively (./bridge.ts explains why). This file is the join: it
// decides whether it is allowed to fire anything, turns events into a
// schedule, and hands that to native.

import { Capacitor } from "@capacitor/core";
import { LocalNotifications, type PermissionStatus } from "@capacitor/local-notifications";
import { db } from "../../db";
import { backfillTypedReleaseDates } from "../releaseDates";
import { requestDeepLink, parseDeepLinkTarget } from "../deepLink";
import { getStaleDaysThreshold } from "../showStatus";
import {
  notificationId,
  planNotifications,
  selectForDelivery,
  todayIso,
  type ExcludedRelease,
  type NotificationEvent,
} from "./events";
import { clearSchedule, openSystemNotificationSettings, pushSchedule, toScheduledNotification } from "./bridge";
import { watchEligibilityInputs } from "./triggers";
import {
  kindEnabled,
  markPermissionRequested,
  notificationsEnabled,
  permissionAlreadyRequested,
  setNotificationsEnabled,
} from "./prefs";

/**
 * Upper bound on the schedule handed to native.
 *
 * This is no longer about the OS: delivery runs off a single rolling alarm
 * rather than one alarm per event, so the platform's pending-alarm limit is
 * not in play any more. It only bounds how much JSON is parked in
 * SharedPreferences. Anything trimmed is picked back up on a later run —
 * the scheduler re-runs on every resume, long before those dates arrive.
 */
const MAX_SCHEDULED = 150;

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
 * Requests the OS permission. Only ever called from an explicit user action -
 * "Turn on notifications" in onboarding or the Settings toggle - never on
 * launch: Android 13+ requires POST_NOTIFICATIONS at runtime and the platform
 * guidance is to ask in context, once, after the user has shown they want the
 * feature. Onboarding explains what notifications are for first and asks
 * only if the user says yes, so the system dialog is never the first thing
 * they hear about it.
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

/**
 * The user said yes to notifications - in onboarding or in Settings.
 *
 * Two separate things happen, in this order, and the app keeps them apart:
 *
 *  1. The APP preference is recorded as on. That is the user's answer, and it
 *     stands whatever Android says next.
 *  2. The OS permission is requested (a no-op when already granted). Only a
 *     grant actually lets anything be delivered.
 *
 * So a user who said yes and then denied the system dialog is "on in
 * WatchTime, blocked by Android" - and the screens say exactly that, with a
 * route to the system setting, rather than claiming notifications are on.
 * Recording the preference is also what lets a later grant in system settings
 * take effect on its own: the next resume finds both halves true and
 * schedules, without the user having to come back and flip the toggle again.
 *
 * Returns the permission state after asking, for the caller to explain.
 */
export async function enableNotifications(): Promise<NotificationAvailability> {
  setNotificationsEnabled(true);
  const availability = await requestNotificationPermission();
  if (availability === "granted") await syncScheduledNotifications();
  return availability;
}

/** The user said no, or turned them off. Recorded as an answer, so they are not asked again. */
export async function disableNotifications(): Promise<void> {
  setNotificationsEnabled(false);
  await cancelAllNotifications();
}

/**
 * Opens Android's notification settings for this app, for a permission the
 * system dialog can no longer grant. False when there is nowhere to send the
 * user (the browser build, or a native build without the method), so the
 * caller can fall back to telling them where to look.
 */
export async function openNotificationSettings(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  return openSystemNotificationSettings();
}

/**
 * Cancels anything still queued with @capacitor/local-notifications.
 *
 * Purely a migration path. Earlier builds scheduled through that plugin, so
 * an install updating to this one can have its alarms already pending; left
 * alone they would fire alongside the native ones and double every release.
 * Cheap, idempotent, and self-healing once those queues are empty.
 */
async function dropLegacyCapacitorSchedule(): Promise<void> {
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
  } catch {
    // No permission to enumerate, or nothing there. Nothing to undo.
  }
}

/**
 * Lookups the scheduler spends per run on typed movie release dates.
 *
 * Which movies need one is decided by lib/releaseDates.ts, the same rule
 * Home's Releasing this month uses: missing or older than a week, within the
 * window where a release can still matter, watched movies included (their
 * digital release is still announced). It used to be a separate rule here -
 * unwatched only, and looked up exactly once - so a digital date TMDB added
 * after the first lookup was never seen, and a film watched in cinemas could
 * never get its digital date at all.
 */
const RELEASE_DATE_LOOKUPS_PER_RUN = 12;

/**
 * The moment a release actually becomes available.
 *
 * Midnight local on its date, because that IS the moment at the precision the
 * data has: TMDB's air_date and release dates carry no time of day, so a
 * calendar day is all anyone knows. Anything later would be a delay this app
 * invented, which is exactly what the removed "deliver at" preference was.
 *
 * Local, not UTC, for the same reason todayIso() is: a release on the 10th
 * should announce itself when the user's own 10th starts. For a release dated
 * today this moment has already passed, and the native side posts it as soon
 * as it receives the schedule (ReleaseNotifier.arm() fires overdue entries a
 * moment later, and anything under a day old is still delivered).
 */
function releaseMomentFor(event: NotificationEvent): Date {
  return new Date(`${event.date}T00:00:00`);
}

/** The run in progress, and whether another was asked for while it ran. See syncScheduledNotifications. */
let running: Promise<number> | null = null;
let rerunRequested = false;

/**
 * Releases the last run found and left out, with the reason for each. Kept
 * for Diagnostics, so "why was I not told about X" (or the reverse) has an
 * answer from the run that actually decided it. Empty until a run happens,
 * which on the browser build is never.
 */
let lastExcluded: ExcludedRelease[] = [];

export function lastExcludedReleases(): readonly ExcludedRelease[] {
  return lastExcluded;
}

/**
 * Reconciles the native schedule with what the library currently implies.
 *
 * Idempotent by construction: the payload REPLACES whatever was stored, and
 * ids are a stable hash of the event id, so re-running never duplicates. The
 * replacement is also what makes the feature respect library changes —
 * unfollow a show or mark a movie watched and its queued releases stop
 * existing, instead of firing days later for something no longer in the
 * library. Native additionally remembers which ids it has already posted, so
 * running this on every resume cannot re-announce anything.
 */
export async function syncScheduledNotifications(): Promise<number> {
  // One run at a time. Runs are requested from several places now (launch,
  // resume, the end of Home's episode sync, a movie marked watched), and two
  // overlapping runs could finish out of order, the older library state
  // overwriting the newer schedule. A request that arrives mid-run is folded
  // into one more pass after it, which reads the library as it is by then.
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      let count = 0;
      do {
        rerunRequested = false;
        count = await reconcileSchedule();
      } while (rerunRequested);
      return count;
    } finally {
      running = null;
    }
  })();
  return running;
}

async function reconcileSchedule(): Promise<number> {
  if (!notificationsSupported() || !notificationsEnabled()) return 0;
  if ((await checkNotificationPermission()) !== "granted") return 0;

  await dropLegacyCapacitorSchedule();
  // Shared with Home's release-type tags, which read the theatrical date this
  // stores alongside the digital one from the same response.
  await backfillTypedReleaseDates(await db.movies.toArray(), undefined, undefined, RELEASE_DATE_LOOKUPS_PER_RUN).catch(
    () => {}
  );

  const [shows, episodes, watched, movies] = await Promise.all([
    db.shows.toArray(),
    db.episodes.toArray(),
    db.watchedEpisodes.toArray(),
    db.movies.toArray(),
  ]);

  // Watch history is read on every run, not cached between them: eligibility
  // is decided here, from the library as it is now, and the result replaces
  // the whole native schedule - so nothing queued by an earlier run, or by an
  // earlier build, outlives the rule it was decided under.
  const plan = planNotifications(shows, episodes, watched, movies, new Date(), getStaleDaysThreshold());
  lastExcluded = plan.excluded;
  const wanted = selectForDelivery(plan.events, kindEnabled, todayIso(), MAX_SCHEDULED);

  await pushSchedule(
    wanted.map((event) =>
      toScheduledNotification(event, releaseMomentFor(event), notificationId(event.eventId))
    )
  );

  return wanted.length;
}

/** How long requestNotificationSync() waits for a burst of library writes to settle. */
const RESYNC_DEBOUNCE_MS = 1500;
let resyncTimer: number | null = null;

/**
 * Asks for the schedule to be rebuilt shortly, from wherever the library has
 * just changed in a way that matters to it.
 *
 * Launch and resume were the only triggers before, and the launch run reads
 * the episode cache before Home's sync has refreshed it. A new season Home
 * fetched a minute later therefore reached the schedule only at the next
 * resume - and a user who opened the app the evening before a release and
 * did not come back until after it was never told. Home's sync calls this when
 * it finishes, so a release learned of is a release scheduled.
 *
 * Debounced, because the callers write in bursts, and cheap when the feature
 * is off: the run itself returns before reading anything.
 */
export function requestNotificationSync(): void {
  if (!notificationsSupported() || !notificationsEnabled()) return;
  if (resyncTimer !== null) window.clearTimeout(resyncTimer);
  resyncTimer = window.setTimeout(() => {
    resyncTimer = null;
    syncScheduledNotifications().catch(() => {});
  }, RESYNC_DEBOUNCE_MS);
}

/**
 * Reschedules after any library write that can change which shows may be
 * announced: a watch recorded or removed, a show stopped, resumed, added or
 * removed, an import or a restore. See ./triggers.ts.
 *
 * Without it the schedule only caught up at the next resume, so a show the
 * user had just stopped could still be announced by what was already queued.
 * Registered once from App; only on the native build, where there is a
 * schedule to keep current. Returns the cleanup.
 */
export function initNotificationRescheduling(): () => void {
  if (!notificationsSupported()) return () => {};
  return watchEligibilityInputs(requestNotificationSync);
}

/** Drops every queued notification. Called when the user turns the feature off. */
export async function cancelAllNotifications(): Promise<void> {
  if (!notificationsSupported()) return;
  await clearSchedule();
  await dropLegacyCapacitorSchedule();
}

/**
 * Wires taps to the deep-link store. Registered once from App; the returned
 * cleanup removes the listener.
 *
 * Taps on notifications this build posts do NOT come through here — those are
 * opened by MainActivity, which parks the target in the same pending slot a
 * widget tap uses, and the web layer drains it at mount and on resume. This
 * listener remains for the notifications an OLDER build may still have queued
 * with @capacitor/local-notifications: until those have fired or been
 * cancelled, a tap on one has to keep working.
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
