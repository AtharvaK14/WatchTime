// Which backup files to keep. Pure, so scripts/check-backup.ts can run it.

/** How many dated backups each destination keeps. */
export const BACKUP_RETENTION = 7;

// Matches backupFilename() in ../backup.ts: tv-tracker-backup-YYYY-MM-DD-HHMM.json.
// The timestamp is UTC and zero-padded, so sorting the names sorts by time.
const BACKUP_FILENAME = /^tv-tracker-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/;

export function isBackupFilename(name: string): boolean {
  return BACKUP_FILENAME.test(name);
}

/** Dated backups among `names`, newest first. Anything else in the folder is ignored. */
export function newestFirst(names: string[]): string[] {
  return names.filter(isBackupFilename).sort().reverse();
}

/**
 * The files to delete so that only the newest `keep` remain.
 *
 * Only names matching the backup pattern are ever returned: a file the user
 * dropped into the folder, or a temporary file from a run in progress, is
 * not ours to delete.
 */
export function backupsToPrune(names: string[], keep: number = BACKUP_RETENTION): string[] {
  return newestFirst(names).slice(Math.max(keep, 1));
}

/** When a dated backup was made, read from its name (the timestamp in it is UTC). Null for any other file. */
export function backupTimeFromFilename(name: string): Date | null {
  const m = /^tv-tracker-backup-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.json$/.exec(name);
  if (!m) return null;
  const time = new Date(`${m[1]}T${m[2]}:${m[3]}:00.000Z`);
  return Number.isNaN(time.getTime()) ? null : time;
}
