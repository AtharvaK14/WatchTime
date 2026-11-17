// When a scheduled backup is due. Pure, so scripts/check-backup.ts can run it.

export type BackupCadence = "off" | "daily" | "weekly";

export const DEFAULT_BACKUP_CADENCE: BackupCadence = "daily";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long to leave a failed run alone before trying again.
 *
 * The scheduler is asked "is one due?" on every launch, resume and pause, so
 * without this a failing backup would be retried each time the app changed
 * state. An hour keeps a broken destination from being hammered while still
 * recovering the same day.
 */
export const RETRY_AFTER_FAILURE_MS = HOUR_MS;

export function cadenceIntervalMs(cadence: BackupCadence): number | null {
  if (cadence === "daily") return DAY_MS;
  if (cadence === "weekly") return 7 * DAY_MS;
  return null;
}

export function parseCadence(value: string | null): BackupCadence {
  return value === "off" || value === "daily" || value === "weekly" ? value : DEFAULT_BACKUP_CADENCE;
}

function elapsedSince(iso: string | null, now: number): number {
  if (!iso) return Infinity;
  const then = new Date(iso).getTime();
  // An unreadable timestamp, or one in the future (the clock was set back),
  // says nothing about when the last run was. Treat it as "long ago" so a
  // bad value can never switch backups off.
  if (!Number.isFinite(then) || then > now) return Infinity;
  return now - then;
}

/**
 * Whether a scheduled run should start now.
 *
 * @param lastOkAt      when a run last finished with at least one destination holding the data
 * @param lastAttemptAt when a run last started, whether or not it worked
 */
export function isBackupDue(
  cadence: BackupCadence,
  lastOkAt: string | null,
  lastAttemptAt: string | null,
  now: number
): boolean {
  const interval = cadenceIntervalMs(cadence);
  if (interval === null) return false;
  if (elapsedSince(lastOkAt, now) < interval) return false;
  return elapsedSince(lastAttemptAt, now) >= RETRY_AFTER_FAILURE_MS;
}
