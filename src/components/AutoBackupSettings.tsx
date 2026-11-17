import { useCallback, useEffect, useState } from "react";
import {
  autoBackupSupported,
  listLocalBackups,
  LOCAL_TARGET,
  readLocalBackup,
  runBackupNow,
  SYSTEM_TARGET,
  type BackupRunResult,
  type LocalBackupEntry,
} from "../lib/autoBackup";
import { localBackupFolderPath } from "../lib/autoBackup/localStore";
import { BACKUP_RETENTION, backupTimeFromFilename } from "../lib/autoBackup/retention";
import type { BackupCadence } from "../lib/autoBackup/schedule";
import {
  AUTO_BACKUP_CHANGED_EVENT,
  getBackupCadence,
  readAutoBackupState,
  setBackupCadence,
  targetState,
} from "../lib/autoBackup/state";

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

/** One sentence for the result of a "Back up now" press. */
function describeRun(result: BackupRunResult): { ok: boolean; text: string } {
  const local = result.outcomes.find((o) => o.id === LOCAL_TARGET);
  if (!local || local.status === "failed") {
    return { ok: false, text: `Backup failed: ${local?.status === "failed" ? local.error : "nothing was written."}` };
  }
  return {
    ok: true,
    text:
      local.status === "unchanged"
        ? "Nothing has changed since the last backup, so no new file was needed."
        : `Saved ${local.file}.`,
  };
}

function entryLabel(entry: LocalBackupEntry): string {
  if (entry.target === SYSTEM_TARGET) return "Snapshot for Android backup";
  return backupTimeFromFilename(entry.filename)?.toLocaleString() ?? entry.filename;
}

/**
 * Scheduled backups to the app-owned folder, and restoring from them.
 *
 * `onRestoreText` receives the text of a chosen backup; the caller validates
 * it and runs the same merge-or-replace flow as a file picked by hand.
 */
export default function AutoBackupSettings({ onRestoreText }: { onRestoreText: (text: string) => void }) {
  const supported = autoBackupSupported();
  const [cadence, setCadence] = useState<BackupCadence>(() => getBackupCadence());
  const [state, setState] = useState(() => readAutoBackupState());
  const [entries, setEntries] = useState<LocalBackupEntry[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runMessage, setRunMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const refreshEntries = useCallback(() => {
    listLocalBackups()
      .then(setEntries)
      .catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    if (!supported) return;
    refreshEntries();
    localBackupFolderPath().then(setFolder);
    // A scheduled run can finish while this screen is open.
    const onChanged = () => {
      setState(readAutoBackupState());
      setCadence(getBackupCadence());
      refreshEntries();
    };
    window.addEventListener(AUTO_BACKUP_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AUTO_BACKUP_CHANGED_EVENT, onChanged);
  }, [supported, refreshEntries]);

  if (!supported) {
    return (
      <div className="settings-block">
        <h3>Automatic backups</h3>
        <p className="muted small">
          Scheduled backups run only in the Android app, which has a folder of its own to save them in. A browser
          cannot write files unattended, so here the backup is the export below: run it whenever you want a copy.
        </p>
      </div>
    );
  }

  async function backUpNow() {
    setBusy(true);
    setRunMessage(null);
    try {
      setRunMessage(describeRun(await runBackupNow()));
    } catch (e) {
      setRunMessage({ ok: false, text: `Backup failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function chooseEntry(entry: LocalBackupEntry) {
    setReadError(null);
    try {
      onRestoreText(await readLocalBackup(entry));
    } catch (e) {
      setReadError(`Couldn't read that backup: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const local = targetState(state, LOCAL_TARGET);
  const system = targetState(state, SYSTEM_TARGET);
  const snapshot = state.snapshot;

  return (
    <>
      <div className="settings-block">
        <h3>If you reinstall or change phones</h3>
        <p className="muted small">
          Your library is kept up to date in a snapshot that Android's own backup saves to your Google account,
          usually overnight. Reinstall the app on a phone signed in to the same account and the library comes
          back on its own the first time you open it.
        </p>
        <p className="muted small">
          This needs backup turned on in Android's settings (Settings, then Google or System, then Backup).
          Changes from the last day or so may not have been backed up yet. Your API keys go along only when the
          phone has a screen lock, because only then does Android encrypt the backup so that only your devices
          can read it; otherwise you enter them again after reinstalling.
        </p>
        {snapshot ? (
          <p className="muted small">
            Snapshot updated {when(snapshot.at)}, {(snapshot.bytes / (1024 * 1024)).toFixed(1)} MB. API keys{" "}
            {snapshot.keysIncluded ? "included" : "not included"}.
            {snapshot.droppedEpisodeCache &&
              " Episode details were left out to fit Android's size limit; they are fetched again after a restore."}
          </p>
        ) : (
          <p className="muted small">No snapshot yet. One is saved the next time you leave the app.</p>
        )}
        {snapshot?.overBudget && (
          <p className="status-error">
            Your library is larger than Android's backup allows (25 MB), so Android will not save it. Export a
            backup file below and keep it somewhere safe.
          </p>
        )}
        {system.lastError && (
          <p className="status-error">
            Last snapshot failed ({when(system.lastErrorAt)}): {system.lastError}
          </p>
        )}
      </div>

      <div className="settings-block">
        <h3>Automatic backups</h3>
        <p className="muted small">
          Also saves your library and API keys to a folder on this device and keeps the newest {BACKUP_RETENTION}.
          It runs when you open or leave the app, once the time below has passed, and only writes a new file when
          something has changed.
        </p>
        <div className="field-row">
          <select
            value={cadence}
            aria-label="How often to back up"
            onChange={(e) => {
              const next = e.target.value as BackupCadence;
              setCadence(next);
              setBackupCadence(next);
            }}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="off">Off</option>
          </select>
          <button onClick={backUpNow} disabled={busy}>
            {busy ? "Backing up..." : "Back up now"}
          </button>
        </div>
        {runMessage && <p className={runMessage.ok ? "status-ok" : "status-error"}>{runMessage.text}</p>}

        <p className="muted small">On this device: last backed up {when(local.lastSuccessAt)}.</p>
        {local.lastError && (
          <p className="status-error">
            Last attempt failed ({when(local.lastErrorAt)}): {local.lastError}
          </p>
        )}

        <p className="muted small">
          {folder ? `Folder: ${folder}. ` : ""}
          Android removes this folder when the app is uninstalled, so these backups protect you from a cleared or
          damaged library; the snapshot above is what covers a reinstall. For a copy you control, use the export
          below and keep the file somewhere else.
        </p>
      </div>

      <div className="settings-block">
        <h3>Backups on this device</h3>
        {entries.length === 0 && <p className="muted small">None yet.</p>}
        {entries.map((entry) => (
          <div className="field-row" key={`${entry.target}/${entry.filename}`}>
            <span className="small">{entryLabel(entry)}</span>
            <button onClick={() => chooseEntry(entry)}>Restore...</button>
          </div>
        ))}
        {readError && <p className="status-error">{readError}</p>}
        {entries.length > 0 && (
          <p className="muted small">
            Choosing one shows what it contains under "Restore from backup" below. Nothing changes until you confirm
            there.
          </p>
        )}
      </div>
    </>
  );
}
