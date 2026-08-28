// Notification preferences. localStorage rather than db.settings for the
// same reason the TMDB key and the stale-days threshold live there: these
// are device-local app settings, not library data, and they must be readable
// synchronously during render without awaiting Dexie.

import type { NotificationKind } from "./events";

const ENABLED_KEY = "notifications_enabled";
const ASKED_KEY = "notifications_permission_asked";
const HOUR_KEY = "notifications_hour";
const KIND_PREFIX = "notifications_kind_";

/** Local hour of day notifications fire at. 9am is late enough not to wake anyone and early enough to be the day's news. */
export const DEFAULT_NOTIFICATION_HOUR = 9;

export function notificationsEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "true";
}

export function setNotificationsEnabled(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(on));
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

export function getNotificationHour(): number {
  const raw = Number(localStorage.getItem(HOUR_KEY));
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : DEFAULT_NOTIFICATION_HOUR;
}

export function setNotificationHour(hour: number): void {
  localStorage.setItem(HOUR_KEY, String(hour));
}

/** Per-category opt-out. Every category defaults to on once notifications are enabled at all. */
export function kindEnabled(kind: NotificationKind): boolean {
  return localStorage.getItem(KIND_PREFIX + kind) !== "false";
}

export function setKindEnabled(kind: NotificationKind, on: boolean): void {
  localStorage.setItem(KIND_PREFIX + kind, String(on));
}

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  episode: "New episodes",
  "season-premiere": "Season premieres",
  "movie-theatrical": "Movies in cinemas",
  "movie-digital": "Movies available at home",
};
