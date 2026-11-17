// What automatic backup remembers between runs: the chosen cadence and the
// outcome per destination. localStorage, like the other device-local
// settings, so it is readable synchronously and is not itself part of a
// backup (a restored library should not inherit another install's "last
// backed up" claims).

import { EMPTY_TARGET_STATE, type TargetState } from "./pipeline";
import { parseCadence, type BackupCadence } from "./schedule";

const CADENCE_KEY = "auto_backup_cadence";
const STATE_KEY = "auto_backup_state";

/** Fired on window whenever the stored state or cadence changes, so Settings can re-read it. */
export const AUTO_BACKUP_CHANGED_EVENT = "auto-backup-changed";

export interface AutoBackupState {
  /** When a run last started, whether or not it worked. */
  lastAttemptAt: string | null;
  /** When a run last ended with at least one destination holding the data. */
  lastOkAt: string | null;
  targets: Record<string, TargetState>;
}

const EMPTY_STATE: AutoBackupState = { lastAttemptAt: null, lastOkAt: null, targets: {} };

export function getBackupCadence(): BackupCadence {
  return parseCadence(localStorage.getItem(CADENCE_KEY));
}

export function setBackupCadence(cadence: BackupCadence): void {
  localStorage.setItem(CADENCE_KEY, cadence);
  window.dispatchEvent(new Event(AUTO_BACKUP_CHANGED_EVENT));
}

export function readAutoBackupState(): AutoBackupState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
    const stored = raw as Partial<AutoBackupState>;
    return {
      lastAttemptAt: typeof stored.lastAttemptAt === "string" ? stored.lastAttemptAt : null,
      lastOkAt: typeof stored.lastOkAt === "string" ? stored.lastOkAt : null,
      targets: typeof stored.targets === "object" && stored.targets !== null ? stored.targets : {},
    };
  } catch {
    // Unreadable state is the same as no state: the next run is simply due.
    return EMPTY_STATE;
  }
}

export function writeAutoBackupState(state: AutoBackupState): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event(AUTO_BACKUP_CHANGED_EVENT));
}

export function targetState(state: AutoBackupState, id: string): TargetState {
  return { ...EMPTY_TARGET_STATE, ...state.targets[id] };
}
