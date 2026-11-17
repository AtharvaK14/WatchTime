// Writing one backup to one destination, safely. Platform-free: the storage
// is behind BackupStore, so scripts/check-backup.ts drives this with an
// in-memory store and injected failures.

import { backupsToPrune } from "./retention";

/** The few file operations a destination has to provide. Names are bare filenames inside the destination's folder. */
export interface BackupStore {
  list(): Promise<string[]>;
  write(name: string, data: string): Promise<void>;
  read(name: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface BackupTarget {
  id: string;
  store: BackupStore;
  /** Final filename. */
  filename: string;
  /** Exact text to write. */
  data: string;
  /** Identifies the content regardless of when it was exported. */
  fingerprint: string;
  /** How many dated backups to keep, or null for a single file that is replaced each time. */
  keep: number | null;
}

/** What is remembered about a destination between runs. */
export interface TargetState {
  lastSuccessAt: string | null;
  lastFile: string | null;
  fingerprint: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export const EMPTY_TARGET_STATE: TargetState = {
  lastSuccessAt: null,
  lastFile: null,
  fingerprint: null,
  lastErrorAt: null,
  lastError: null,
};

export type TargetOutcome =
  | { id: string; status: "written"; file: string }
  | { id: string; status: "unchanged"; file: string }
  | { id: string; status: "failed"; error: string };

const TEMP_SUFFIX = ".tmp";

async function removeQuietly(store: BackupStore, name: string): Promise<void> {
  try {
    await store.remove(name);
  } catch {
    // Already gone, or not removable. Neither changes what the caller does next.
  }
}

/**
 * Turns a thrown value into the one line shown in Settings.
 *
 * The plugin's own messages are precise but written for developers, so the
 * cases a user can act on get plain wording. Nothing in a backup error can
 * carry a secret: the text comes from the filesystem, not from the data.
 */
export function describeBackupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ENOSPC|no space/i.test(raw)) return "This device is out of storage space.";
  if (/EACCES|permission/i.test(raw)) return "Android denied access to the backup folder.";
  if (/not (available|mounted)|unavailable/i.test(raw)) return "The device's storage is not available right now.";
  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
}

/**
 * Writes `target.data` to its destination and prunes old backups.
 *
 * The order is what makes a failure harmless:
 *
 *  1. Write under a temporary name. An interrupted write leaves a .tmp file
 *     and touches nothing else.
 *  2. Read it back and compare. Only a file proven to hold the data goes on.
 *  3. Rename to the final name, then confirm the folder lists it.
 *  4. Only then delete older backups.
 *
 * So an existing backup is never removed unless a newer one is confirmed in
 * place, and a failed run leaves the folder as it found it.
 *
 * When the content matches the last backup and that file is still there, no
 * new file is written. Seven identical copies would otherwise push every
 * older, different backup out of the retention window.
 */
export async function writeTarget(target: BackupTarget, previous: TargetState): Promise<TargetOutcome> {
  const { id, store, filename, data } = target;
  const temp = filename + TEMP_SUFFIX;
  // Set once the temporary file is the only copy of something that used to
  // exist under the final name. From then on it must not be cleaned up.
  let tempIsOnlyCopy = false;
  try {
    const before = await store.list();

    if (previous.lastFile && previous.fingerprint === target.fingerprint && before.includes(previous.lastFile)) {
      return { id, status: "unchanged", file: previous.lastFile };
    }

    // Left behind by a run that was interrupted before it could rename.
    // Cleared only once this run's own file is verified, in case one of
    // them is the last copy of an earlier backup.
    const stale = before.filter((name) => name.endsWith(TEMP_SUFFIX) && name !== temp);

    await store.write(temp, data);
    const readBack = await store.read(temp);
    if (readBack !== data) {
      await removeQuietly(store, temp);
      throw new Error("The backup file did not read back as written, so it was discarded.");
    }

    try {
      await store.rename(temp, filename);
    } catch (renameError) {
      // A file of the same name is in the way: two runs in the same minute,
      // or the single-file destination, on a filesystem whose rename will
      // not replace. The new file is already verified, so the old one can
      // go - but if the second rename then fails, the temporary file is all
      // that is left and is kept rather than cleaned up.
      if (!before.includes(filename)) throw renameError;
      await store.remove(filename);
      tempIsOnlyCopy = true;
      await store.rename(temp, filename);
      tempIsOnlyCopy = false;
    }

    const after = await store.list();
    if (!after.includes(filename)) throw new Error("The backup file was written but is missing from the folder.");

    for (const name of stale) await removeQuietly(store, name);
    if (target.keep !== null) {
      for (const old of backupsToPrune(after, target.keep)) await removeQuietly(store, old);
    }
    return { id, status: "written", file: filename };
  } catch (error) {
    if (!tempIsOnlyCopy) await removeQuietly(store, temp);
    return { id, status: "failed", error: describeBackupError(error) };
  }
}

/** Folds a run's outcome into what is remembered about the destination. */
export function nextTargetState(previous: TargetState, outcome: TargetOutcome, fingerprint: string, at: string): TargetState {
  if (outcome.status === "failed") {
    return { ...previous, lastErrorAt: at, lastError: outcome.error };
  }
  return { lastSuccessAt: at, lastFile: outcome.file, fingerprint, lastErrorAt: null, lastError: null };
}
