// Automatic backups: the scheduler, the dated backups, and the snapshot
// Android's own backup carries.
//
// Two things are kept, on Android only:
//
//  - Dated backups in the app-owned folder, on the cadence chosen in
//    Settings, newest 7 kept. They have the API keys and never leave the
//    device; they are for a damaged or cleared library, not a reinstall.
//
//  - One snapshot in internal storage (snapshot.ts), the only thing the
//    backup rules let Android take. It is rewritten whenever the app goes to
//    the background after the library changed, so whatever Android backs up
//    overnight is current. Android restores it when the app is reinstalled,
//    and firstLaunch.ts loads it into the empty database.
//
// There is no background job. The library is in the WebView's IndexedDB,
// which a WorkManager worker cannot read, and it only changes while the app
// is open - so checking on launch, resume and pause misses nothing.
// docs/backup-and-updates.md has the verification behind this.

import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { db } from "../../db";
import { backupFilename, buildBackup, type BackupFile } from "../backup";
import { recordBackupCompleted } from "../persistence";
import {
  describeBackupError,
  EMPTY_TARGET_STATE,
  nextTargetState,
  writeTarget,
  type BackupStore,
  type TargetOutcome,
} from "./pipeline";
import { BACKUP_RETENTION, newestFirst } from "./retention";
import { isBackupDue } from "./schedule";
import {
  getBackupCadence,
  readAutoBackupState,
  targetState,
  writeAutoBackupState,
  type AutoBackupState,
} from "./state";
import { externalFolderStore, internalFolderStore, LOCAL_BACKUP_DIR, removeLegacySystemCopy } from "./localStore";
import { hasLibraryData, KEYS_FILE, prepareSnapshot, SNAPSHOT_DIR, SNAPSHOT_FILE } from "./snapshot";
import { backupEncryptionAvailable } from "./native";

/** Dated backups in the app-owned folder. */
export const LOCAL_TARGET = "local";
/** The snapshot Android's own backup carries. */
export const SYSTEM_TARGET = "system";
/** The API keys beside it, only while Android encrypts the backup end to end. */
const KEYS_TARGET = "system-keys";

export function autoBackupSupported(): boolean {
  return Capacitor.getPlatform() === "android";
}

const localStore = () => externalFolderStore(LOCAL_BACKUP_DIR);
const snapshotStore = () => internalFolderStore(SNAPSHOT_DIR);

/**
 * A stable identity for a file's content.
 *
 * The export time is the only field that differs between two backups of an
 * unchanged library, so it is cut out before hashing. JSON.stringify keeps
 * key order, so equal content gives equal text.
 */
async function fingerprintOf(json: string, exportedAt: string): Promise<string> {
  const stable = json.replace(`"exportedAt":"${exportedAt}",`, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- One writer at a time -----------------------------------------------------

// Every write and every state update goes through this chain. A scheduled
// run and a pause-time snapshot can otherwise overlap, each reading the
// stored state before the other has written it back.
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
}

function withTarget(state: AutoBackupState, id: string, outcome: TargetOutcome, fingerprint: string, at: string): AutoBackupState {
  return {
    ...state,
    targets: { ...state.targets, [id]: nextTargetState(targetState(state, id), outcome, fingerprint, at) },
  };
}

async function removeIfPresent(store: BackupStore, name: string): Promise<void> {
  if (!(await store.list()).includes(name)) return;
  await store.remove(name);
}

// ---- The snapshot ---------------------------------------------------------------

/**
 * Writes the snapshot, and the keys file when allowed. Must run inside
 * serial(). Returns the snapshot's outcome, or null when there was nothing
 * to write.
 *
 * An empty library is never written. If the database has been emptied by
 * something other than the user - Android clearing the WebView's storage,
 * say - writing it out would replace the one good copy with nothing before
 * Android's next backup. Deliberately emptying it goes through Reset Data,
 * which removes the snapshot itself (forgetSnapshot).
 */
async function writeSnapshotLocked(backup: BackupFile): Promise<TargetOutcome | null> {
  const t = backup.tables;
  if (!hasLibraryData({ shows: t.shows.length, movies: t.movies.length, watchedEpisodes: t.watchedEpisodes.length })) {
    return null;
  }

  const prepared = prepareSnapshot(backup);
  const store = snapshotStore();
  let state = readAutoBackupState();

  const fingerprint = await fingerprintOf(prepared.data, backup.exportedAt);
  const outcome = await writeTarget(
    { id: SYSTEM_TARGET, store, filename: SNAPSHOT_FILE, data: prepared.data, fingerprint, keep: null },
    targetState(state, SYSTEM_TARGET)
  );
  state = withTarget(state, SYSTEM_TARGET, outcome, fingerprint, backup.exportedAt);

  // The keys file follows the encryption, checked on every write: a screen
  // lock removed since the last one takes the keys out of the next backup.
  let keysIncluded = false;
  if (prepared.keys && (await backupEncryptionAvailable())) {
    const keysFingerprint = await fingerprintOf(prepared.keys, backup.exportedAt);
    const keysOutcome = await writeTarget(
      { id: KEYS_TARGET, store, filename: KEYS_FILE, data: prepared.keys, fingerprint: keysFingerprint, keep: null },
      targetState(state, KEYS_TARGET)
    );
    state = withTarget(state, KEYS_TARGET, keysOutcome, keysFingerprint, backup.exportedAt);
    keysIncluded = keysOutcome.status !== "failed";
  } else {
    try {
      await removeIfPresent(store, KEYS_FILE);
      state = { ...state, targets: { ...state.targets, [KEYS_TARGET]: EMPTY_TARGET_STATE } };
    } catch {
      // Left for the next write to try again.
    }
  }

  if (outcome.status !== "failed") {
    state = {
      ...state,
      snapshot: {
        at: backup.exportedAt,
        bytes: prepared.bytes,
        droppedEpisodeCache: prepared.droppedEpisodeCache,
        overBudget: prepared.overBudget,
        keysIncluded,
      },
    };
  }
  writeAutoBackupState(state);
  return outcome;
}

/** Set by any write to the library, cleared when a snapshot is taken. True at launch, so each session writes at least once. */
let libraryChanged = true;

/** Rewrites the snapshot if the library changed since the last one. */
function refreshSnapshotIfChanged(): Promise<void> {
  if (!libraryChanged) return Promise.resolve();
  // Cleared before reading, so a write that lands while the snapshot is
  // being built marks it changed again for the next pause.
  libraryChanged = false;
  return serial(async () => {
    await writeSnapshotLocked(await buildBackup());
  }).then(
    () => {},
    () => {
      libraryChanged = true;
    }
  );
}

/**
 * Removes the snapshot and keys file. Called by Reset Data: the user asked
 * for the library to be gone, so the copy that would bring it back after a
 * reinstall goes too.
 */
export function forgetSnapshot(): Promise<void> {
  if (!autoBackupSupported()) return Promise.resolve();
  return serial(async () => {
    const store = snapshotStore();
    await removeIfPresent(store, SNAPSHOT_FILE);
    await removeIfPresent(store, KEYS_FILE);
    const state = readAutoBackupState();
    writeAutoBackupState({
      ...state,
      targets: { ...state.targets, [SYSTEM_TARGET]: EMPTY_TARGET_STATE, [KEYS_TARGET]: EMPTY_TARGET_STATE },
      snapshot: null,
    });
  });
}

// ---- Scheduled runs -------------------------------------------------------------

export interface BackupRunResult {
  outcomes: TargetOutcome[];
  /** True when at least one destination holds the current data. */
  ok: boolean;
}

async function runLocked(): Promise<BackupRunResult> {
  const startedAt = new Date().toISOString();
  // Recorded before any work, so a run that dies partway still counts as an
  // attempt and is not retried on the very next resume.
  writeAutoBackupState({ ...readAutoBackupState(), lastAttemptAt: startedAt });

  const outcomes: TargetOutcome[] = [];
  let exportedAt = startedAt;
  try {
    const backup = await buildBackup();
    exportedAt = backup.exportedAt;
    libraryChanged = false;

    // Compact JSON, as in the manual export: a large library is several MB.
    const full = JSON.stringify(backup);
    const fingerprint = await fingerprintOf(full, backup.exportedAt);
    const local = await writeTarget(
      {
        id: LOCAL_TARGET,
        store: localStore(),
        filename: backupFilename(backup.exportedAt),
        data: full,
        fingerprint,
        keep: BACKUP_RETENTION,
      },
      targetState(readAutoBackupState(), LOCAL_TARGET)
    );
    outcomes.push(local);
    writeAutoBackupState(withTarget(readAutoBackupState(), LOCAL_TARGET, local, fingerprint, exportedAt));

    const snapshot = await writeSnapshotLocked(backup);
    if (snapshot) outcomes.push(snapshot);
  } catch (error) {
    // Reading the database failed, so nothing was attempted anywhere.
    const failed: TargetOutcome = { id: LOCAL_TARGET, status: "failed", error: describeBackupError(error) };
    outcomes.push(failed);
    writeAutoBackupState(withTarget(readAutoBackupState(), LOCAL_TARGET, failed, "", startedAt));
    libraryChanged = true;
  }

  const ok = outcomes.some((o) => o.status !== "failed");
  if (ok) writeAutoBackupState({ ...readAutoBackupState(), lastOkAt: exportedAt });
  // Only once a destination has confirmed it holds the data. "unchanged"
  // counts: the file already there is a backup of the library as it is now.
  if (ok) recordBackupCompleted(exportedAt);
  return { outcomes, ok };
}

let running: Promise<BackupRunResult> | null = null;

/** Runs a full backup now: dated backup and snapshot. One run at a time; a second caller gets the run in progress. */
export function runBackupNow(): Promise<BackupRunResult> {
  if (!autoBackupSupported()) return Promise.resolve({ outcomes: [], ok: false });
  running ??= serial(runLocked).finally(() => {
    running = null;
  });
  return running;
}

function backupDue(): boolean {
  const state = readAutoBackupState();
  return isBackupDue(getBackupCadence(), state.lastOkAt, state.lastAttemptAt, Date.now());
}

/** Called on launch and every app state change. Failures are recorded in the state and shown in Settings. */
function onAppStateChange(isActive: boolean): void {
  if (running) return;
  if (backupDue()) {
    runBackupNow().catch(() => {});
  } else if (!isActive) {
    // Going to the background is the moment the library is as current as it
    // will be until the app is next opened, so that is when the snapshot is
    // brought up to date for Android's overnight backup.
    refreshSnapshotIfChanged().catch(() => {});
  }
}

/** How long after launch the first check waits, so a backup never competes with startup. */
const STARTUP_DELAY_MS = 8000;

/** Tables whose writes make the snapshot stale. The episode cache is left out: it is refetched, not made by the user. */
const WATCHED_TABLES = [db.shows, db.movies, db.watchedEpisodes, db.titleMatches, db.settings] as const;

/** Starts the scheduler. Registered once from App; returns the cleanup. */
export function initAutoBackup(): () => void {
  if (!autoBackupSupported()) return () => {};
  const markChanged = () => {
    libraryChanged = true;
  };
  for (const table of WATCHED_TABLES) {
    table.hook("creating", markChanged);
    table.hook("updating", markChanged);
    table.hook("deleting", markChanged);
  }
  void removeLegacySystemCopy();
  const timer = window.setTimeout(() => onAppStateChange(true), STARTUP_DELAY_MS);
  const handle = CapacitorApp.addListener("appStateChange", ({ isActive }) => onAppStateChange(isActive));
  return () => {
    window.clearTimeout(timer);
    handle.then((h) => h.remove()).catch(() => {});
    for (const table of WATCHED_TABLES) {
      table.hook("creating").unsubscribe(markChanged);
      table.hook("updating").unsubscribe(markChanged);
      table.hook("deleting").unsubscribe(markChanged);
    }
  };
}

// ---- Restoring from the device ------------------------------------------------

export interface LocalBackupEntry {
  /** Which folder it is in. */
  target: typeof LOCAL_TARGET | typeof SYSTEM_TARGET;
  filename: string;
}

/**
 * The backups on this device, newest first, with the snapshot last.
 * Settings lists these itself because Android hides the app-owned folder
 * from file pickers, so the ordinary "choose a file" restore cannot reach it.
 */
export async function listLocalBackups(): Promise<LocalBackupEntry[]> {
  if (!autoBackupSupported()) return [];
  const [dated, snapshot] = await Promise.all([localStore().list(), snapshotStore().list()]);
  const entries: LocalBackupEntry[] = newestFirst(dated).map((filename) => ({ target: LOCAL_TARGET, filename }));
  if (snapshot.includes(SNAPSHOT_FILE)) entries.push({ target: SYSTEM_TARGET, filename: SNAPSHOT_FILE });
  return entries;
}

export function readLocalBackup(entry: LocalBackupEntry): Promise<string> {
  return (entry.target === SYSTEM_TARGET ? snapshotStore() : localStore()).read(entry.filename);
}

/** The snapshot and keys file as Android restored them, for firstLaunch.ts. Null where a file is absent. */
export async function readSnapshotFiles(): Promise<{ snapshot: string | null; keys: string | null }> {
  const store = snapshotStore();
  const names = await store.list();
  return {
    snapshot: names.includes(SNAPSHOT_FILE) ? await store.read(SNAPSHOT_FILE) : null,
    keys: names.includes(KEYS_FILE) ? await store.read(KEYS_FILE) : null,
  };
}
