// Typed proxy for the native release-notification scheduler.
//
// Why there is native code here at all: the notification the user sees has to
// carry the show's poster as its large icon, with the WatchTime mark badged
// into the corner of it — the treatment Android applies automatically when a
// notification has both a large and a small icon. @capacitor/local-notifications
// cannot express that. Its `largeIcon` is resolved with
// `AssetUtil.getResourceID(context, name, "drawable")`, i.e. a compile-time
// drawable resource; there is no path from a poster URL to it. Posting the
// notification ourselves is the only way to put artwork on it.
//
// So the split matches the one the widgets already use: the web layer decides
// WHAT to announce (./events.ts, pure, library-scoped) and hands native a
// payload; native decides WHEN and draws it. Permissions stay with
// @capacitor/local-notifications, which handles POST_NOTIFICATIONS perfectly
// well and is what the Settings screen already talks to.

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { NotificationEvent } from "./events";

/** One scheduled notification, as the native side consumes it. */
export interface ScheduledNotification {
  /** Stable event id; native uses it to avoid ever posting the same event twice. */
  id: string;
  /** Android notification id — a stable hash of `id`, so a repost replaces. */
  notificationId: number;
  /** Epoch millis to fire at. */
  at: number;
  title: string;
  body: string;
  /** Poster URL for the large icon, or null. */
  imageUrl: string | null;
  /** Serialised deep-link target, handed back through the tap. */
  target: string;
}

export interface ReleaseNotificationsPlugin {
  /**
   * Replaces the whole schedule. Native stores it, arms the next alarm and
   * forgets anything not in the new list, which is what makes library changes
   * take effect: unfollow a show and its queued releases simply stop existing.
   */
  schedule(options: { payload: string }): Promise<void>;
  /** Drops the schedule and any armed alarm. */
  cancelAll(): Promise<void>;
}

const ReleaseNotifications = registerPlugin<ReleaseNotificationsPlugin>("ReleaseNotifications");

/** The native scheduler only exists in the Android shell. */
export function releaseNotificationsSupported(): boolean {
  return Capacitor.getPlatform() === "android";
}

export interface SchedulePayload {
  version: number;
  notifications: ScheduledNotification[];
}

/**
 * Bumped if the payload shape changes incompatibly. Native ignores a payload
 * whose version it does not understand rather than half-reading it, so a web
 * update that lands before the native one degrades to "no new notifications"
 * instead of malformed ones.
 */
export const SCHEDULE_PAYLOAD_VERSION = 1;

export function toScheduledNotification(
  event: NotificationEvent,
  at: Date,
  notificationId: number
): ScheduledNotification {
  return {
    id: event.eventId,
    notificationId,
    at: at.getTime(),
    title: event.title,
    body: event.body,
    imageUrl: event.imageUrl,
    target: JSON.stringify(event.target),
  };
}

export async function pushSchedule(notifications: ScheduledNotification[]): Promise<void> {
  if (!releaseNotificationsSupported()) return;
  const payload: SchedulePayload = { version: SCHEDULE_PAYLOAD_VERSION, notifications };
  try {
    await ReleaseNotifications.schedule({ payload: JSON.stringify(payload) });
  } catch {
    // A build without the plugin registered. The previous schedule stays
    // armed, which is stale but valid; failing here must never break the
    // Settings screen or the resume path that triggered it.
  }
}

export async function clearSchedule(): Promise<void> {
  if (!releaseNotificationsSupported()) return;
  try {
    await ReleaseNotifications.cancelAll();
  } catch {
    // Nothing scheduled, or no plugin. Either way there is nothing to clear.
  }
}
