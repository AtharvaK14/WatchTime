import { useState, useEffect, useRef, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { checkTmdbKey, TMDB_API_KEY_STORAGE } from "../tmdb";
import { checkOmdbKey, OMDB_API_KEY_STORAGE, isOmdbRateLimited, omdbQuotaResumeTime } from "../omdb";
import { db } from "../db";
import {
  exportAndDownloadBackup,
  parseBackupText,
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
import { RELEASE_ACTIVATION_DAYS } from "../lib/releaseState";
import { getWatchProviderRegions, type TmdbWatchRegion } from "../tmdb";
import {
  clearStreamingCache,
  deviceRegion,
  getWatchRegion,
  setWatchRegion,
  watchRegionIsAutomatic,
} from "../lib/streaming/providers";
import ImportWizard from "./ImportWizard";
import Diagnostics from "./Diagnostics";
import About from "../components/About";
import { OmdbKeySteps, TmdbKeySteps } from "../components/KeySetupGuide";
import NotificationSettings from "../components/NotificationSettings";
import AutoBackupSettings from "../components/AutoBackupSettings";
import UpdateSettings from "../components/UpdateSettings";
import { ChoiceRow, HeadingWithInfo, InfoButton } from "../components/Sheet";
import { friendlyTime } from "../lib/friendlyTime";
import { autoBackupSupported } from "../lib/autoBackup";
import { forgetSnapshot } from "../lib/autoBackup";
import { requestNotificationSync } from "../lib/notifications";

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
  const [tmdbSavedNow, setTmdbSavedNow] = useState(false);
  const [omdbSavedNow, setOmdbSavedNow] = useState(false);

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
      setTmdbSavedNow(true);
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
      setOmdbSavedNow(true);
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
        <HeadingWithInfo
          title="TMDB"
          infoTitle="TMDB key"
          info={
            <>
              <p>
                Powers search, posters, plots and episode lists. The key is free under TMDB's non-commercial terms.
              </p>
              <TmdbKeySteps />
            </>
          }
        />
        <p className="muted small">Required · {tmdbStatus === "valid" ? "Saved" : "Not set"}</p>
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
        {tmdbStatus === "valid" && tmdbSavedNow && <p className="status-ok">Key verified and saved.</p>}
        {tmdbStatus === "invalid" && tmdbError && <p className="status-error">{tmdbError}</p>}
      </div>

      <div className="settings-block">
        <HeadingWithInfo
          title="OMDb"
          infoTitle="OMDb key"
          info={
            <>
              <p>
                There is no free official IMDb or Rotten Tomatoes API. OMDb is the free aggregator: 1,000 requests a
                day, non-commercial licence. Rotten Tomatoes scores are usually only there for movies, not TV
                shows; that is a gap in OMDb's data.
              </p>
              <OmdbKeySteps />
            </>
          }
        />
        <p className="muted small">
          Optional, for ratings · {omdbStatus === "valid" ? "Saved" : "Not set"}
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
        {omdbStatus === "valid" && omdbSavedNow && <p className="status-ok">{omdbNote ?? "Key verified and saved."}</p>}
        {omdbStatus === "invalid" && omdbError && <p className="status-error">{omdbError}</p>}
        {isOmdbRateLimited() && (
          <p className="muted small">
            Daily limit reached. New ratings resume{" "}
            {omdbQuotaResumeTime() ? friendlyTime(new Date(omdbQuotaResumeTime()!).toISOString()) : "tomorrow"}.
          </p>
        )}
      </div>

      <p className="muted small">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
  );
}

/** One line for the section; the full explanation is behind its ⓘ. */
const PERSIST_STATUS_SHORT: Record<string, string> = {
  granted: "Protected",
  denied: "Not guaranteed",
  unsupported: "Not guaranteed",
};

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

/** What a backup holds, in the words a person would use: "1 show · 3 movies · 2 episodes watched". */
function librarySummary(counts: Record<string, number>): string {
  const n = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
  return [
    n(counts.shows, "show", "shows"),
    n(counts.movies, "movie", "movies"),
    n(counts.watchedEpisodes, "episode watched", "episodes watched"),
  ].join(" · ");
}

function keysSummary(keys: { tmdb: string | null; omdb: string | null }): string {
  if (keys.tmdb && keys.omdb) return "API keys included";
  if (keys.tmdb) return "TMDB key included";
  if (keys.omdb) return "OMDb key only";
  return "No API keys";
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
  // A backup chosen from the device list is offered further down the page;
  // the offer is scrolled to so the choice visibly did something.
  const restoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending || restoreError) restoreRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pending, restoreError]);

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

  function resetRestore() {
    setPending(null);
    setConfirmingReplace(false);
    setRestoreResult(null);
    setRestoreError(null);
  }

  /** Shared by the file picker and the list of backups on this device. */
  function offerRestore(text: string) {
    resetRestore();
    try {
      setPending(parseBackupText(text));
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleFileChosen(file: File | null) {
    resetRestore();
    if (!file) return;
    try {
      offerRestore(await file.text());
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
        <HeadingWithInfo
          title="Storage"
          info={
            <>
              <p>{persistStatus ? PERSIST_STATUS_COPY[persistStatus] : "Checking storage protection..."}</p>
              {estimate && <p>The library uses {estimate.usageMB.toFixed(1)} MB on this device.</p>}
            </>
          }
        />
        <p className="muted small">
          {persistStatus ? PERSIST_STATUS_SHORT[persistStatus] : "Checking..."}
          {estimate && ` · ${estimate.usageMB.toFixed(1)} MB`}
          {!autoBackupSupported() && ` · Last backup: ${friendlyTime(lastBackup)}`}
        </p>
      </div>

      <AutoBackupSettings onRestoreText={offerRestore} />

      <div className="settings-block">
        <HeadingWithInfo
          title="Export backup"
          info={
            <p>
              Saves your entire library (shows, movies, watch history, import matches) plus your API keys to a
              single JSON file. Keep it somewhere outside this device, for example your cloud drive.
            </p>
          }
        />
        <p className="muted small">Your library and API keys in one file.</p>
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

      <div className="settings-block restore-block" ref={restoreRef}>
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
            <p className="restore-offer-title">Backup from {friendlyTime(pending.backup.exportedAt)}</p>
            <p className="muted small">
              {librarySummary(tableCounts(pending.backup))} · {keysSummary(pending.backup.apiKeys)}
            </p>
            {!pending.backup.apiKeys.tmdb && !pending.backup.apiKeys.omdb && (
              <p className="muted small">Keys already saved here are kept.</p>
            )}
            {pending.warnings.map((w) => (
              <p key={w} className="muted small">
                ⚠ {w}
              </p>
            ))}

            {hasExistingData === true && !confirmingReplace && (
              <>
                <div className="heading-with-info">
                  <p className="restore-offer-question">You already have a library here.</p>
                  <InfoButton title="Merge or replace">
                    <p>
                      Merge adds the items in the backup and updates the ones you already have, matched by ID.
                      Everything else you have stays.
                    </p>
                    <p>Replace deletes your current library first, then loads the backup exactly as it is.</p>
                  </InfoButton>
                </div>
                <div className="field-row">
                  <button onClick={() => handleRestore("merge")} disabled={restoring}>
                    {restoring ? "Restoring..." : "Merge into existing"}
                  </button>
                  <button className="danger-button" onClick={() => setConfirmingReplace(true)} disabled={restoring}>
                    Replace everything...
                  </button>
                </div>
              </>
            )}

            {hasExistingData === true && confirmingReplace && (
              <div className="settings-block">
                <p className="status-error">
                  This deletes all your current shows, movies and watch history, then loads the backup. There is no
                  undo.
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
    // The threshold decides which shows count as Lapsed,
    // and so which releases may be announced.
    requestNotificationSync();
    setSaved(true);
  }

  return (
    <div className="panel">
      <div className="settings-block">
        <HeadingWithInfo
          title="Lapsed after"
          infoTitle="When a show counts as lapsed"
          info={
            <>
              <p>
                Days without watching before a show moves off Watch next into Lapsed. The two lists never overlap;
                watching the next episode moves the show straight back. Default: {DEFAULT_STALE_DAYS_THRESHOLD} days.
              </p>
              <p>
                A new release wins over this for a show you were keeping up with. If an episode arrived in the last{" "}
                {RELEASE_ACTIVATION_DAYS} days and you had watched everything released before it, the show stays in
                Watch next however long ago that was, so a series returning after years off is not filed as
                abandoned. It still offers the next episode in order.
              </p>
              <p>
                A show with older episodes still unwatched is not brought back this way: new episodes on top of a
                backlog say you stopped, not that you were waiting. Anything marked as stopped watching leaves both
                lists.
              </p>
            </>
          }
        />
        <p className="muted small">Days without watching before a show moves to Lapsed.</p>
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
            aria-label="Days"
          />
          <span className="muted small">days</span>
          <button onClick={save} disabled={!valid}>
            Save
          </button>
        </div>
        {saved && <p className="status-ok">Saved. Home uses it next time it loads.</p>}
        {!valid && days !== "" && <p className="status-error">Enter a number of days, 1 or higher.</p>}
      </div>
    </div>
  );
}

/**
 * Which country's streaming availability the details panels answer for.
 *
 * A setting at all because availability genuinely differs by region - the same
 * series is on different services in different countries, and on none in some -
 * so there is no single correct answer to bake in. The device's own locale is
 * the default and is right for most people; this is for the rest, and for
 * anyone whose subscriptions do not match where their phone thinks it is.
 */
function StreamingPreferences() {
  const [region, setRegion] = useState(() => getWatchRegion());
  const [automatic, setAutomatic] = useState(() => watchRegionIsAutomatic());
  const [regions, setRegions] = useState<TmdbWatchRegion[] | null>(null);
  const [refreshed, setRefreshed] = useState(false);

  // One request, on the one screen that needs it, and entirely optional: if it
  // fails the picker falls back to a plain two-letter entry rather than
  // blocking the setting behind a network call.
  useEffect(() => {
    let cancelled = false;
    getWatchProviderRegions()
      .then((list) => {
        if (!cancelled) {
          setRegions([...list].sort((a, b) => a.english_name.localeCompare(b.english_name)));
        }
      })
      .catch(() => {
        if (!cancelled) setRegions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function apply(next: string) {
    // "" is the automatic option: clearing the stored value puts the device
    // back in charge rather than freezing today's locale as a choice.
    if (next === "") {
      setWatchRegion(null);
      setAutomatic(true);
      setRegion(deviceRegion());
    } else {
      setWatchRegion(next);
      setAutomatic(false);
      setRegion(next);
    }
    setRefreshed(false);
  }

  async function refresh() {
    await clearStreamingCache();
    setRefreshed(true);
  }

  return (
    <div className="panel">
      <div className="settings-block">
        <HeadingWithInfo
          title="Region"
          info={
            <>
              <p>
                Where "Available on" checks. Streaming rights are sold by country, so a show on one service here can
                be on another, or on none, somewhere else.
              </p>
              <p>Auto follows this device's language settings. Availability comes from TMDB, sourced from JustWatch.</p>
            </>
          }
        />
        <div className="field-row">
          {regions === null || regions.length === 0 ? (
            <input
              type="text"
              value={automatic ? "" : region}
              placeholder={`Auto (${deviceRegion()})`}
              maxLength={2}
              onChange={(e) => apply(e.target.value.toUpperCase())}
              style={{ minWidth: 120, width: 120 }}
              aria-label="Two-letter country code"
            />
          ) : (
            <ChoiceRow
              label="Country"
              value={automatic ? "" : region}
              searchable
              options={[
                { value: "", label: `Auto (${deviceRegion()})` },
                ...regions.map((r) => ({ value: r.iso_3166_1, label: r.english_name })),
              ]}
              onChange={apply}
            />
          )}
        </div>
      </div>

      <div className="settings-block">
        <HeadingWithInfo
          title="Saved availability"
          info={
            <p>
              Availability is kept for a week, so opening a title twice does not spend two TMDB requests on
              something that changes at the pace of licensing deals. Clear it if a service has just added or dropped
              something and you want to see it now. Your library is not affected.
            </p>
          }
        />
        <p className="muted small">Kept for a week.</p>
        <div className="field-row">
          <button onClick={refresh}>Clear</button>
        </div>
        {refreshed && <p className="status-ok">Cleared. Titles check again as you open them.</p>}
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
    // The copy Android's backup carries would otherwise bring the library
    // back after a reinstall. Dated backups on the device are kept: they are
    // listed under Backup & Restore and can be deleted with the app.
    await forgetSnapshot().catch(() => {});
    setConfirming(false);
    setDone(true);
  }

  return (
    <div className="panel">
      {/* No heading: the row above already says Reset Data. */}
      <div className="about-credit">
        <p className="muted small">Deletes your library. API keys stay.</p>
        <InfoButton title="Reset data">
          <p>
            Clears all shows, movies, episodes and watch history from this device. Your API keys are kept, so you
            won't need to enter them again.
          </p>
          <p>
            Useful for a clean re-import. On Android it also removes the copy kept for Android's backup, so a
            reinstall won't bring the library back. Backups on the device are kept.
          </p>
        </InfoButton>
      </div>
      {!confirming && !done && (
        <button className="danger-button" onClick={() => setConfirming(true)}>
          Reset library
        </button>
      )}
      {confirming && (
        <div className="settings-block">
          <p className="status-error">Deletes everything in Shows, Movies and watch history. There is no undo.</p>
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

/** One row of a settings group: a collapsible section, closed by default. */
function SettingsRow({
  title,
  sub,
  danger = false,
  children,
}: {
  title: string;
  sub: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <details>
      <summary>
        <span className={`settings-row-text${danger ? " settings-row-danger" : ""}`}>
          <h3>{title}</h3>
          <p className="muted small settings-row-sub">{sub}</p>
        </span>
      </summary>
      <div className="settings-row-body">{children}</div>
    </details>
  );
}

/** A labelled group of rows in one rounded container, One UI's settings layout. */
function SettingsGroup({ label, danger = false, children }: { label: string; danger?: boolean; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h2 className="settings-group-label">{label}</h2>
      <div className={`settings-list${danger ? " is-danger" : ""}`}>{children}</div>
    </section>
  );
}

export default function Settings() {
  return (
    <div className="panel settings-page">
      <h1>Settings</h1>

      {/* Every section is collapsed on arrival, so the page opens as a list
          of destinations rather than mid-scroll into one of them (Backup &
          Restore used to open itself on every visit). Grouped by what the
          user is there to do; the one destructive action sits alone at the
          end, in its own group, away from everything else. */}
      <SettingsGroup label="Your library">
        <SettingsRow title="Backup & Restore" sub="Backups, export and restore">
          <BackupRestore />
        </SettingsRow>
        <SettingsRow title="Import from TV Time" sub="Bring in a TV Time export">
          <ImportWizard />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="Preferences">
        <SettingsRow title="Notifications" sub="New episodes and releases">
          <NotificationSettings />
        </SettingsRow>
        <SettingsRow title="Watch Next" sub="When a show counts as lapsed">
          <WatchNextPreferences />
        </SettingsRow>
        <SettingsRow title="Streaming" sub={'Region for "Available on"'}>
          <StreamingPreferences />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="Connections">
        <SettingsRow title="API Keys" sub="TMDB and OMDb">
          <ApiKeys />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="Help">
        <SettingsRow title="Diagnostics" sub="Check stored data against TMDB">
          <Diagnostics />
        </SettingsRow>
        <SettingsRow title="App updates" sub="Version and updates">
          <UpdateSettings />
        </SettingsRow>
        <SettingsRow title="About" sub="Credits and privacy">
          <About />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="Danger zone" danger>
        <SettingsRow title="Reset Data" sub="Delete your library" danger>
          <ResetData />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
