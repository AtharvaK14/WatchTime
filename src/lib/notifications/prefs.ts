// Notification preferences. localStorage rather than db.settings for the
// same reason the TMDB key and the stale-days threshold live there: these
// are device-local app settings, not library data, and they must be readable
// synchronously during render without awaiting Dexie.

import type { NotificationKind } from "./events";

const ENABLED_KEY = "notifications_enabled";
const ASKED_KEY = "notifications_permission_asked";
const KIND_PREFIX = "notifications_kind_";

// There is deliberately no delivery-hour preference any more. Notifications
// go out as soon as the thing they are about becomes available, so there is
// no time for anyone to choose. The old "notifications_hour" key is left
// unread in localStorage rather than migrated — nothing consults it, and
// deleting a stranger's stored value buys nothing.

/**
 * The app's own notification preference. Separate from the OS permission,
 * which lives with Android and is read through checkNotificationPermission():
 * this is what the user asked for, that is what Android allows, and nothing
 * is delivered unless both are true.
 *
 * Absent (never answered) reads as off, as it always has. Nobody gets
 * notifications they did not ask for - but "never answered" is no longer
 * left to look like a decision: see notificationChoiceMade().
 */
export function notificationsEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "true";
}

export function setNotificationsEnabled(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(on));
}

/**
 * Whether the user has ever answered the question, either way.
 *
 * Read from the same key rather than a flag of its own, because the key
 * already records exactly this: it is only ever written by an explicit choice
 * (Settings' toggle, or onboarding's yes / not now), so an existing install
 * where someone turned notifications on or off has it, and one where nobody
 * ever did does not. That is what lets onboarding ask the people who were
 * never asked - and only them - without resetting anyone who was.
 */
export function notificationChoiceMade(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== null;
}

/**
 * Whether the OS permission dialog has already been shown once.
 *
 * Android only ever displays the system dialog once; every later request
 * resolves "denied" instantly without any UI. Recording that we asked lets
 * the UI stop offering a button that would silently do nothing and point at
 * system settings instead — which is also the platform guidance: ask once,
 * in context, and never nag.
 */
export function permissionAlreadyRequested(): boolean {
  return localStorage.getItem(ASKED_KEY) === "true";
}

export function markPermissionRequested(): void {
  localStorage.setItem(ASKED_KEY, "true");
}

/** Per-category opt-out. Every category defaults to on once notifications are enabled at all. */
export function kindEnabled(kind: NotificationKind): boolean {
  return localStorage.getItem(KIND_PREFIX + kind) !== "false";
}

export function setKindEnabled(kind: NotificationKind, on: boolean): void {
  localStorage.setItem(KIND_PREFIX + kind, String(on));
}

// The per-category LABELS used to live here too. They moved to
// components/notificationGroups.ts, beside the Settings screen and the
// onboarding step that read them: how a preference is worded is presentation, and the wording is now
// group-relative ("Theatrical releases" under a "Movies" heading), which only
// makes sense next to the layout it is written for. This module keeps to
// storage.
