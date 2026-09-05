import { useState, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { checkTmdbKey, TMDB_API_KEY_STORAGE } from "../tmdb";
import { checkOmdbKey, OMDB_API_KEY_STORAGE, isOmdbRateLimited, omdbQuotaResumeTime } from "../omdb";
import { db } from "../db";
import {
  exportAndDownloadBackup,
  validateBackup,
  restoreBackup,
  tableCounts,
  ExportCancelledError,
  type ValidatedBackup,
  type ExportResult,
  type RestoreResult,
  type RestoreMode,
} from "../lib/backup";
import {
  getStoredPersistStatus,
  getStorageEstimate,
  getLastBackupAt,
  API_KEYS_CHANGED_EVENT,
} from "../lib/persistence";
import { getStaleDaysThreshold, setStaleDaysThreshold, DEFAULT_STALE_DAYS_THRESHOLD } from "../lib/showStatus";
import ImportWizard from "./ImportWizard";
import Diagnostics from "./Diagnostics";
import About from "../components/About";
import NotificationSettings from "../components/NotificationSettings";

type KeyStatus = "idle" | "checking" | "valid" | "invalid";

// Same specific messaging as the first-run wizard (Settings parity): a
// wrong key, an unactivated key, and an unreachable service each need
// different advice.
const TMDB_SETTINGS_ERRORS: Record<string, string> = {
  invalid:
    'TMDB rejected this key. Paste the "API Key" (v3 auth) from your TMDB settings page, not the longer read access token.',
  "network-error": "Couldn't reach TMDB. Check your connection, or try again in a minute if TMDB itself is down.",
};

const OMDB_SETTINGS_ERRORS: Record<string, string> = {
  invalid:
    "OMDb rejected this key. If you just created it, click the activation link in the email OMDb sent you first.",
  "network-error": "Couldn't reach OMDb. Check your connection, or try again in a minute.",
};

function ApiKeys() {
  const [tmdbKey, setTmdbKey] = useState("");
  const [tmdbStatus, setTmdbStatus] = useState<KeyStatus>("idle");
  const [tmdbError, setTmdbError] = useState<string | null>(null);
  const [tmdbVisible, setTmdbVisible] = useState(false);
  const [omdbKey, setOmdbKey] = useState("");
  const [omdbStatus, setOmdbStatus] = useState<KeyStatus>("idle");
  const [omdbError, setOmdbError] = useState<string | null>(null);
  const [omdbNote, setOmdbNote] = useState<string | null>(null);
  const [omdbVisible, setOmdbVisible] = useState(false);

  useEffect(() => {
    // Re-read on the restore event too: this component stays mounted inside
    // its <details> while a backup restore rewrites localStorage, so mount-
    // time state alone would go stale.
    function loadSavedKeys() {
      const savedTmdb = localStorage.getItem(TMDB_API_KEY_STORAGE);
      setTmdbKey(savedTmdb ?? "");
      setTmdbStatus(savedTmdb ? "valid" : "idle");
      const savedOmdb = localStorage.getItem(OMDB_API_KEY_STORAGE);
      setOmdbKey(savedOmdb ?? "");
      setOmdbStatus(savedOmdb ? "valid" : "idle");
    }
    loadSavedKeys();
    window.addEventListener(API_KEYS_CHANGED_EVENT, loadSavedKeys);
    return () => window.removeEventListener(API_KEYS_CHANGED_EVENT, loadSavedKeys);
  }, []);

  async function saveTmdb() {
    setTmdbStatus("checking");
    setTmdbError(null);
    const result = await checkTmdbKey(tmdbKey.trim());
    if (result === "valid") {
      localStorage.setItem(TMDB_API_KEY_STORAGE, tmdbKey.trim());
      setTmdbStatus("valid");
    } else {
      setTmdbStatus("invalid");
      setTmdbError(TMDB_SETTINGS_ERRORS[result]);
    }
  }

  async function saveOmdb() {
    setOmdbStatus("checking");
    setOmdbError(null);
    setOmdbNote(null);
    const result = await checkOmdbKey(omdbKey.trim());
    if (result === "valid" || result === "rate-limited") {
      // rate-limited proves the key is real (OMDb recognized it and counted
      // it against a quota), so save it rather than bouncing the user.
      localStorage.setItem(OMDB_API_KEY_STORAGE, omdbKey.trim());
      setOmdbStatus("valid");
      if (result === "rate-limited") {
        setOmdbNote("Key saved. It already hit its 1,000-requests-per-day limit today, so ratings resume tomorrow.");
      }
    } else {
      setOmdbStatus("invalid");
      setOmdbError(OMDB_SETTINGS_ERRORS[result]);
    }
  }

  return (
    <div className="panel">
      <div className="settings-block">
        <h3>TMDB (required)</h3>
        <p className="muted small">
          Powers show/movie search, posters, plots, and episode lists. Free key at{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
            themoviedb.org/settings/api
          </a>{" "}
          under non-commercial terms.
        </p>
        <div className="field-row">
          <input
            type={tmdbVisible ? "text" : "password"}
            value={tmdbKey}
            onChange={(e) => setTmdbKey(e.target.value)}
            placeholder="TMDB API key (v3)"
            autoComplete="off"
          />
          <button onClick={() => setTmdbVisible((v) => !v)} aria-label={tmdbVisible ? "Hide key" : "Show key"}>
            {tmdbVisible ? "Hide" : "Show"}
          </button>
          <button onClick={saveTmdb} disabled={!tmdbKey.trim() || tmdbStatus === "checking"}>
            {tmdbStatus === "checking" ? "Checking..." : "Save"}
          </button>
        </div>
        {tmdbStatus === "valid" && <p className="status-ok">Key verified and saved.</p>}
        {tmdbStatus === "invalid" && tmdbError && <p className="status-error">{tmdbError}</p>}
      </div>

      <div className="settings-block">
        <h3>OMDb (optional, for IMDb / Rotten Tomatoes ratings)</h3>
        <p className="muted small">
          There is no free official IMDb or Rotten Tomatoes API. OMDb is the legitimate free aggregator, 1,000
          requests/day, non-commercial license. Get a key at{" "}
          <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer">
            omdbapi.com/apikey.aspx
          </a>
          . Rotten Tomatoes scores are typically only available for movies, not TV shows, that's an OMDb data
          limitation, not a bug here.
        </p>
        <div className="field-row">
          <input
            type={omdbVisible ? "text" : "password"}
            value={omdbKey}
            onChange={(e) => setOmdbKey(e.target.value)}
            placeholder="OMDb API key"
            autoComplete="off"
          />
          <button onClick={() => setOmdbVisible((v) => !v)} aria-label={omdbVisible ? "Hide key" : "Show key"}>
            {omdbVisible ? "Hide" : "Show"}
          </button>
          <button onClick={saveOmdb} disabled={!omdbKey.trim() || omdbStatus === "checking"}>
            {omdbStatus === "checking" ? "Checking..." : "Save"}
          </button>
        </div>
        {omdbStatus === "valid" && <p className="status-ok">{omdbNote ?? "Key verified and saved."}</p>}
        {omdbStatus === "invalid" && omdbError && <p className="status-error">{omdbError}</p>}
        {isOmdbRateLimited() && (
          <p className="muted small">
            This key has hit OMDb's daily lookup limit. Ratings resume automatically
            {omdbQuotaResumeTime() ? ` after ${new Date(omdbQuotaResumeTime()!).toLocaleString()}` : " tomorrow"}. Cached
            ratings still show in the meantime.
          </p>
        )}
      </div>

      <hr />
      <p className="muted small">
        Attribution, per TMDB's terms: "This product uses the TMDB API but is not endorsed or certified by TMDB."
        OMDb content is CC BY-NC 4.0, non-commercial use only, same as this app. Full credits are under About below.
      </p>
    </div>
  );
}

const PERSIST_STATUS_COPY: Record<string, string> = {
  granted:
    "Protected: the system agreed not to auto-clear this app's data under storage pressure. That still doesn't survive \"Clear data\" or uninstalling, so keep backups.",
  denied:
    "Not guaranteed: the system may clear this app's data if device storage runs low. Browsers usually grant protection after regular use; until then, export backups.",
  unsupported:
    "This browser doesn't support persistent-storage requests, so data may be cleared under storage pressure. Export backups regularly.",
};

function formatCounts(counts: Record<string, number>): string {
  return (
    `${counts.shows.toLocaleString()} shows · ${counts.movies.toLocaleString()} movies · ` +
    `${counts.watchedEpisodes.toLocaleString()} watched episodes · ${counts.episodes.toLocaleString()} cached episodes · ` +
    `${counts.titleMatches.toLocaleString()} import matches`
  );
}

function keyOutcomeLabel(outcome: "restored" | "kept-existing" | "absent"): string {
  if (outcome === "restored") return "restored";
  if (outcome === "kept-existing") return "kept your existing key";
  return "not in this backup";
}

function BackupRestore() {
  const persistStatus = getStoredPersistStatus();
  const [estimate, setEstimate] = useState<{ usageMB: number; quotaMB: number } | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(() => getLastBackupAt());

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [pending, setPending] = useState<ValidatedBackup | null>(null);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Whether the merge-or-replace question is even needed: restoring into an
  // empty database has nothing to destroy, so it gets a single button.
  const hasExistingData = useLiveQuery(
    async () =>
      (await db.shows.count()) > 0 || (await db.movies.count()) > 0 || (await db.watchedEpisodes.count()) > 0,
    []
  );

  useEffect(() => {
    getStorageEstimate().then(setEstimate);
  }, []);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    try {
      const res = await exportAndDownloadBackup();
      setExportResult(res);
      setLastBackup(getLastBackupAt());
    } catch (e) {
      // Dismissing the native share sheet is a choice, not a failure — stay quiet.
      if (!(e instanceof ExportCancelledError)) {
        setExportError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setExporting(false);
    }
  }

  async function handleFileChosen(file: File | null) {
    setPending(null);
    setConfirmingReplace(false);
    setRestoreResult(null);
    setRestoreError(null);
    if (!file) return;
    try {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("That file isn't valid JSON. Choose a backup file exported by this app.");
      }
      setPending(validateBackup(raw));
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRestore(mode: RestoreMode) {
    if (!pending) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const res = await restoreBackup(pending.backup, mode);
      setRestoreResult(res);
      setPending(null);
      setConfirmingReplace(false);
      setLastBackup(getLastBackupAt());
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="panel">
      <div className="settings-block">
        <h3>Storage status</h3>
        <p className="muted small">
          {persistStatus ? PERSIST_STATUS_COPY[persistStatus] : "Checking storage protection..."}
          {estimate && ` Currently using ${estimate.usageMB.toFixed(1)} MB of local storage.`}
        </p>
        <p className="muted small">
          Last backup: {lastBackup ? new Date(lastBackup).toLocaleString() : "never"}
        </p>
      </div>

      <div className="settings-block">
        <h3>Export backup</h3>
        <p className="muted small">
          Saves your entire library (shows, movies, watch history, import matches) plus your API keys to a single
          JSON file. Keep it somewhere outside this device, e.g. your cloud drive.
        </p>
        <button onClick={handleExport} disabled={exporting}>
          {exporting ? "Exporting..." : "Export backup file"}
        </button>
        {exportResult && (
          <p className="status-ok">
            Saved {exportResult.filename}: {formatCounts(exportResult.counts)}.
          </p>
        )}
        {exportError && <p className="status-error">Export failed: {exportError}</p>}
      </div>

      <div className="settings-block">
        <h3>Restore from backup</h3>
        <div className="field-row">
          <label className="file-label">
            Backup JSON file
            <input
              type="file"
              // Android file pickers often report a .json backup as
              // octet-stream/plain and would hide it under a strict
              // application/json filter, so the accepted types are broadened
              // (the file contents are validated on read regardless).
              accept=".json,application/json,application/octet-stream,text/plain"
              onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        {restoreError && <p className="status-error">{restoreError}</p>}

        {pending && (
          <div className="settings-block">
            <p>
              Backup from {new Date(pending.backup.exportedAt).toLocaleString()}:{" "}
              {formatCounts(tableCounts(pending.backup))}.
            </p>
            <p className="muted small">
              API keys in file: TMDB {pending.backup.apiKeys.tmdb ? "yes" : "no"} · OMDb{" "}
              {pending.backup.apiKeys.omdb ? "yes" : "no"}
            </p>
            {pending.warnings.map((w) => (
              <p key={w} className="muted small">
                ⚠ {w}
              </p>
            ))}

            {hasExistingData === true && !confirmingReplace && (
              <>
                <p>You already have data in this app. Choose how to restore:</p>
                <div className="field-row">
                  <button onClick={() => handleRestore("merge")} disabled={restoring}>
                    {restoring ? "Restoring..." : "Merge into existing"}
                  </button>
                  <button className="danger-button" onClick={() => setConfirmingReplace(true)} disabled={restoring}>
                    Replace everything...
                  </button>
                </div>
                <p className="muted small">
                  Merge adds and overwrites items from the file by ID and keeps everything else you have. Replace
                  deletes all current data first, then loads the file exactly.
                </p>
              </>
            )}

            {hasExistingData === true && confirmingReplace && (
              <div className="settings-block">
                <p className="status-error">
                  This permanently deletes ALL current shows, movies, and watch history first, then loads the
                  file. There is no undo.
                </p>
                <div className="field-row">
                  <button className="danger-button" onClick={() => handleRestore("replace")} disabled={restoring}>
                    {restoring ? "Restoring..." : "Yes, replace everything"}
                  </button>
                  <button onClick={() => setConfirmingReplace(false)} disabled={restoring}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {hasExistingData === false && (
              <div className="field-row">
                <button onClick={() => handleRestore("replace")} disabled={restoring}>
                  {restoring ? "Restoring..." : "Restore backup"}
                </button>
              </div>
            )}
          </div>
        )}

        {restoreResult && (
          <p className="status-ok">
            Restored {formatCounts(restoreResult.counts)}. API keys: TMDB {keyOutcomeLabel(restoreResult.keys.tmdb)},
            OMDb {keyOutcomeLabel(restoreResult.keys.omdb)}.
          </p>
        )}
      </div>
    </div>
  );
}

function WatchNextPreferences() {
  const [days, setDays] = useState(() => String(getStaleDaysThreshold()));
  const [saved, setSaved] = useState(false);

  const parsed = Number(days);
  const valid = Number.isFinite(parsed) && parsed >= 1;

  function save() {
    if (!valid) return;
    setStaleDaysThreshold(parsed);
    setSaved(true);
  }

  return (
    <div className="panel">
      <div className="settings-block">
        <h3>"Haven't Watched For a While" threshold</h3>
        <p className="muted small">
          Days without watch activity before a show moves off Watch Next into "Haven't Watched For a While". The
          two lists never overlap; watching the next episode moves the show straight back. Default:{" "}
          {DEFAULT_STALE_DAYS_THRESHOLD} days.
        </p>
        <div className="field-row">
          <input
            type="number"
            min={1}
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              setSaved(false);
            }}
            style={{ minWidth: 100, width: 100 }}
          />
          <button onClick={save} disabled={!valid}>
            Save
          </button>
        </div>
        {saved && <p className="status-ok">Saved. Takes effect next time Home loads.</p>}
        {!valid && days !== "" && <p className="status-error">Enter a number of days, 1 or higher.</p>}
      </div>
    </div>
  );
}

function ResetData() {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  async function handleReset() {
    await Promise.all([
      db.shows.clear(),
      db.episodes.clear(),
      db.watchedEpisodes.clear(),
      db.movies.clear(),
      db.titleMatches.clear(),
    ]);
    setConfirming(false);
    setDone(true);
  }

  return (
    <div className="panel">
      <p className="muted small">
        Clears all shows, movies, episodes, and watch history from this browser. Your TMDB/OMDb API keys are not
        affected, they're stored separately and won't need re-entering. Useful for a clean re-import after schema
        or import-logic changes, rather than leaving stale or partially-backfilled data around indefinitely.
      </p>
      {!confirming && !done && (
        <button className="danger-button" onClick={() => setConfirming(true)}>
          Reset all show/movie data
        </button>
      )}
      {confirming && (
        <div className="settings-block">
          <p className="status-error">
            This permanently deletes everything in Shows, Movies, and watch history from this browser. There is no
            undo. Re-import afterward to rebuild it.
          </p>
          <div className="field-row">
            <button className="danger-button" onClick={handleReset}>
              Yes, delete everything
            </button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}
      {done && <p className="status-ok">Cleared. Go to Import above to rebuild your library.</p>}
    </div>
  );
}

export default function Settings() {
  return (
    <div className="panel">
      <h1>Settings</h1>

      {/* Deliberately NOT `open`. Backup & Restore used to expand itself on
          every visit to Settings, which made the page open mid-scroll into a
          section most visits are not about and left every other section
          looking secondary to it. All eight are collapsed now, so the page
          opens as a list of destinations. */}
      <details>
        <summary>
          <span className="settings-row-text">
            <h2>Backup &amp; Restore</h2>
            <p className="muted small settings-row-sub">Export your library to a file, restore it anywhere</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <BackupRestore />
        </div>
      </details>

      <details>
        <summary>
          <span className="settings-row-text">
            <h2>Import from TV Time</h2>
            <p className="muted small settings-row-sub">JSON export recommended, CSV fallback available</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <ImportWizard />
        </div>
      </details>

      <details>
        <summary>
          <span className="settings-row-text">
            <h2>Notifications</h2>
            <p className="muted small settings-row-sub">New episodes and releases from your library only</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <NotificationSettings />
        </div>
      </details>

      <details>
        <summary>
          <span className="settings-row-text">
            <h2>API Keys</h2>
            <p className="muted small settings-row-sub">TMDB required, OMDb optional for ratings</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <ApiKeys />
        </div>
      </details>

      <details>
        <summary>
          <span className="settings-row-text">
            <h2>Watch Next</h2>
            <p className="muted small settings-row-sub">When shows count as "haven't watched for a while"</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <WatchNextPreferences />
        </div>
      </details>

      <details>
        <summary>
          <span className="settings-row-text">
            <h2>Diagnostics</h2>
            <p className="muted small settings-row-sub">Compare stored data against TMDB for a show</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <Diagnostics />
        </div>
      </details>

      <details>
        <summary>
          <span className="settings-row-text">
            <h2>About</h2>
            <p className="muted small settings-row-sub">Credits, data sources, and privacy</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <About />
        </div>
      </details>

      <details>
        <summary>
          <span className="settings-row-text settings-row-danger">
            <h3>Reset Data</h3>
            <p className="small settings-row-sub">Deletes shows, movies, and watch history</p>
          </span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <ResetData />
        </div>
      </details>
    </div>
  );
}
