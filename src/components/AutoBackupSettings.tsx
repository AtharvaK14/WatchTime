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
import { friendlyTime } from "../lib/friendlyTime";
import { ChoiceRow, HeadingWithInfo } from "./Sheet";

const CADENCE_OPTIONS: { value: BackupCadence; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "off", label: "Off" },
];

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
        : "Backed up.",
  };
}

function entryLabel(entry: LocalBackupEntry): string {
  if (entry.target === SYSTEM_TARGET) return "Reinstall snapshot";
  const time = backupTimeFromFilename(entry.filename);
  return time ? friendlyTime(time.toISOString()) : entry.filename;
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
        <HeadingWithInfo
          title="Automatic backups"
          info={
            <p>
              Scheduled backups run only in the Android app, which has a folder of its own to save them in. A
              browser cannot write files unattended, so here the backup is the export below: run it whenever you
              want a copy.
            </p>
          }
        />
        <p className="muted small">Android app only. Here, use Export below.</p>
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
        <HeadingWithInfo
          title="Reinstall protection"
          infoTitle="If you reinstall or change phones"
          info={
            <>
              <p>
                Your library is kept up to date in a snapshot that Android's own backup saves to your Google
                account, usually overnight. Reinstall the app on a phone signed in to the same account and the
                library comes back on its own the first time you open it.
              </p>
              <p>
                This needs backup turned on in Android's settings (Settings, then Google or System, then Backup).
                Changes from the last day or so may not have been backed up yet.
              </p>
              <p>
                Your API keys go along only when the phone has a screen lock, because only then does Android
                encrypt the backup so that only your devices can read it. Otherwise you enter them again after
                reinstalling.
              </p>
              {snapshot?.droppedEpisodeCache && (
                <p>
                  Episode details were left out to fit Android's size limit. They are fetched again after a
                  restore.
                </p>
              )}
            </>
          }
        />
        <p className="muted small">
          {snapshot
            ? `Updated ${friendlyTime(snapshot.at)} · API keys ${snapshot.keysIncluded ? "included" : "not included"}`
            : "Saved the next time you leave the app."}
        </p>
        {snapshot?.overBudget && (
          <p className="status-error">Too large for Android's backup (25 MB). Export a backup file instead.</p>
        )}
        {system.lastError && (
          <p className="status-error">
            Last snapshot failed ({friendlyTime(system.lastErrorAt)}): {system.lastError}
          </p>
        )}
      </div>

      <div className="settings-block">
        <HeadingWithInfo
          title="Automatic backups"
          info={
            <>
              <p>
                Saves your library and API keys to a folder on this device and keeps the newest {BACKUP_RETENTION}.
                It runs when you open or leave the app, once the chosen time has passed, and only writes a new file
                when something has changed.
              </p>
              <p>
                Android deletes this folder when the app is uninstalled, so these backups protect you from a
                cleared or damaged library. Reinstall protection is what covers a reinstall. For a copy you
                control, export a backup file and keep it somewhere else.
              </p>
              {folder && <p className="info-sheet-path">{folder}</p>}
            </>
          }
        />
        <ChoiceRow
          label="Frequency"
          value={cadence}
          options={CADENCE_OPTIONS}
          onChange={(next) => {
            setCadence(next);
            setBackupCadence(next);
          }}
        />
        <div className="field-row">
          <button onClick={backUpNow} disabled={busy}>
            {busy ? "Backing up..." : "Back up now"}
          </button>
          <span className="muted small">Last: {friendlyTime(local.lastSuccessAt)}</span>
        </div>
        {runMessage && <p className={runMessage.ok ? "status-ok" : "status-error"}>{runMessage.text}</p>}
        {local.lastError && (
          <p className="status-error">
            Last attempt failed ({friendlyTime(local.lastErrorAt)}): {local.lastError}
          </p>
        )}
      </div>

      {entries.length > 0 && (
        <div className="settings-block">
          <HeadingWithInfo
            title="Backups on this device"
            info={
              <p>
                Choosing one shows what it contains under "Restore from backup", where you pick merge or replace.
                Nothing changes until you confirm there.
              </p>
            }
          />
          <div className="backup-list">
            {entries.map((entry) => (
              <div className="backup-list-row" key={`${entry.target}/${entry.filename}`}>
                <span>{entryLabel(entry)}</span>
                <button onClick={() => chooseEntry(entry)}>Restore</button>
              </div>
            ))}
          </div>
          {readError && <p className="status-error">{readError}</p>}
        </div>
      )}
    </>
  );
}
