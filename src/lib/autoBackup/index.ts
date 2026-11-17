// Automatic backups: the scheduler and the run itself.
//
// The scheduler lives here in the web layer, not in a background job. The
// library is in the WebView's IndexedDB, which a WorkManager worker cannot
// read without starting a WebView of its own - and there would be nothing
// for it to find, because the library only changes while the app is open.
// So a run is considered whenever the app starts, comes to the foreground or
// goes to the background, and happens when the chosen cadence has elapsed.
// docs/backup-and-updates.md has the verification behind this.
//
// Android only. The browser build has no folder it can write to unattended;
// there the manual export in Settings is the backup.

import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { backupFilename, buildBackup, withoutApiKeys, type BackupFile } from "../backup";
import { recordBackupCompleted } from "../persistence";
import {
  describeBackupError,
  nextTargetState,
  writeTarget,
  type BackupTarget,
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
import { externalFolderStore, LOCAL_BACKUP_DIR, SYSTEM_BACKUP_DIR, SYSTEM_BACKUP_FILE } from "./localStore";

/** Dated backups in the app-owned folder. */
export const LOCAL_TARGET = "local";
/** The keyless copy Android's own backup is allowed to take. */
export const SYSTEM_TARGET = "system";

export function autoBackupSupported(): boolean {
  return Capacitor.getPlatform() === "android";
}

/**
 * A stable identity for a backup's content.
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

async function targetsFor(backup: BackupFile): Promise<BackupTarget[]> {
  // Compact JSON, as in the manual export: a large library is several MB.
  const full = JSON.stringify(backup);
  const keyless = JSON.stringify(withoutApiKeys(backup));
  return [
    {
      id: LOCAL_TARGET,
      store: externalFolderStore(LOCAL_BACKUP_DIR),
      filename: backupFilename(backup.exportedAt),
      data: full,
      fingerprint: await fingerprintOf(full, backup.exportedAt),
      keep: BACKUP_RETENTION,
    },
    {
      id: SYSTEM_TARGET,
      store: externalFolderStore(SYSTEM_BACKUP_DIR),
      filename: SYSTEM_BACKUP_FILE,
      data: keyless,
      fingerprint: await fingerprintOf(keyless, backup.exportedAt),
      keep: null,
    },
  ];
}

export interface BackupRunResult {
  outcomes: TargetOutcome[];
  /** True when at least one destination holds the current data. */
  ok: boolean;
}

let running: Promise<BackupRunResult> | null = null;

async function run(): Promise<BackupRunResult> {
  const startedAt = new Date().toISOString();
  let state: AutoBackupState = { ...readAutoBackupState(), lastAttemptAt: startedAt };
  // Recorded before any work, so a run that dies partway still counts as an
  // attempt and is not retried on the very next resume.
  writeAutoBackupState(state);

  let outcomes: TargetOutcome[];
  let exportedAt = startedAt;
  try {
    const backup = await buildBackup();
    exportedAt = backup.exportedAt;
    const targets = await targetsFor(backup);
    outcomes = [];
    // One at a time: each write sends several MB across the native bridge.
    for (const target of targets) {
      const outcome = await writeTarget(target, targetState(state, target.id));
      outcomes.push(outcome);
      state = {
        ...state,
        targets: {
          ...state.targets,
          [target.id]: nextTargetState(targetState(state, target.id), outcome, target.fingerprint, exportedAt),
        },
      };
    }
  } catch (error) {
    // Reading the database failed, so nothing was attempted anywhere.
    const message = describeBackupError(error);
    outcomes = [LOCAL_TARGET, SYSTEM_TARGET].map((id) => ({ id, status: "failed" as const, error: message }));
    for (const outcome of outcomes) {
      state = {
        ...state,
        targets: { ...state.targets, [outcome.id]: nextTargetState(targetState(state, outcome.id), outcome, "", startedAt) },
      };
    }
  }

  const ok = outcomes.some((o) => o.status !== "failed");
  if (ok) state = { ...state, lastOkAt: exportedAt };
  writeAutoBackupState(state);
  // Only once a destination has confirmed it holds the data. "unchanged"
  // counts: the file already there is a backup of the library as it is now.
  if (ok) recordBackupCompleted(exportedAt);
  return { outcomes, ok };
}

/** Runs the backup pipeline now. One run at a time; a second caller gets the run in progress. */
export function runBackupNow(): Promise<BackupRunResult> {
  if (!autoBackupSupported()) return Promise.resolve({ outcomes: [], ok: false });
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}

function runIfDue(): void {
  if (running) return;
  const state = readAutoBackupState();
  if (!isBackupDue(getBackupCadence(), state.lastOkAt, state.lastAttemptAt, Date.now())) return;
  // A failure is recorded in the state and shown in Settings; there is
  // nobody to report it to here.
  runBackupNow().catch(() => {});
}

/** How long after launch the first check waits, so a backup never competes with startup. */
const STARTUP_DELAY_MS = 8000;

/**
 * Starts the scheduler. Registered once from App; returns the cleanup.
 *
 * Going to the background is a trigger as well as coming forward: that is
 * the moment the library is as current as it will be until the app is next
 * opened. If Android stops the app mid-write, a .tmp file is left and the
 * existing backups are untouched.
 */
export function initAutoBackup(): () => void {
  if (!autoBackupSupported()) return () => {};
  const timer = window.setTimeout(runIfDue, STARTUP_DELAY_MS);
  const handle = CapacitorApp.addListener("appStateChange", runIfDue);
  return () => {
    window.clearTimeout(timer);
    handle.then((h) => h.remove()).catch(() => {});
  };
}

// ---- Restoring from the folder ------------------------------------------------

export interface LocalBackupEntry {
  /** Which folder it is in. */
  target: typeof LOCAL_TARGET | typeof SYSTEM_TARGET;
  filename: string;
}

/**
 * The backups in the app-owned folder, newest first, with the keyless copy
 * last. Settings lists these itself because Android hides this folder from
 * file pickers, so the ordinary "choose a file" restore cannot reach it.
 */
export async function listLocalBackups(): Promise<LocalBackupEntry[]> {
  if (!autoBackupSupported()) return [];
  const [dated, system] = await Promise.all([
    externalFolderStore(LOCAL_BACKUP_DIR).list(),
    externalFolderStore(SYSTEM_BACKUP_DIR).list(),
  ]);
  const entries: LocalBackupEntry[] = newestFirst(dated).map((filename) => ({ target: LOCAL_TARGET, filename }));
  if (system.includes(SYSTEM_BACKUP_FILE)) entries.push({ target: SYSTEM_TARGET, filename: SYSTEM_BACKUP_FILE });
  return entries;
}

export function readLocalBackup(entry: LocalBackupEntry): Promise<string> {
  const folder = entry.target === SYSTEM_TARGET ? SYSTEM_BACKUP_DIR : LOCAL_BACKUP_DIR;
  return externalFolderStore(folder).read(entry.filename);
}
