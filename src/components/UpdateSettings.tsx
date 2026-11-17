import { useEffect, useState } from "react";
import { APP_NAME } from "../appInfo";
import {
  availableUpdate,
  checkForUpdates,
  lastUpdateCheckAt,
  setUpdateNotificationsEnabled,
  UPDATE_STATE_EVENT,
  updateChecksEnabled,
  updateNotificationsEnabled,
} from "../lib/updates";
import { APP_VERSION } from "../lib/updates/appVersion";
import {
  canInstallUpdates,
  downloadUpdate,
  installDownloadedUpdate,
  InstallError,
  installerSupported,
  openInstallSettings,
} from "../lib/updates/installer";
import { displayVersion } from "../lib/updates/version";
import { notificationsSupported } from "../lib/notifications";
import { friendlyTime } from "../lib/friendlyTime";
import { HeadingWithInfo } from "./Sheet";

type CheckMessage = { ok: boolean; text: string };

type InstallStep =
  | { step: "idle" }
  | { step: "downloading"; fraction: number | null }
  /** Downloaded; Android has not been told to allow installs from this app yet. */
  | { step: "blocked" }
  | { step: "ready" }
  | { step: "failed"; text: string };

function megabytes(bytes: number | null): string {
  return bytes ? ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)` : "";
}

/** Version, the manual check, and on Android the download-and-install steps. */
export default function UpdateSettings() {
  const [update, setUpdate] = useState(() => availableUpdate());
  const [lastChecked, setLastChecked] = useState(() => lastUpdateCheckAt());
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<CheckMessage | null>(null);
  const [install, setInstall] = useState<InstallStep>({ step: "idle" });
  const [notify, setNotify] = useState(() => updateNotificationsEnabled());

  useEffect(() => {
    const refresh = () => {
      setUpdate(availableUpdate());
      setLastChecked(lastUpdateCheckAt());
    };
    window.addEventListener(UPDATE_STATE_EVENT, refresh);
    return () => window.removeEventListener(UPDATE_STATE_EVENT, refresh);
  }, []);

  async function check() {
    setChecking(true);
    setMessage(null);
    const result = await checkForUpdates({ force: true });
    setChecking(false);
    if (result.status === "update") {
      setMessage({ ok: true, text: `Version ${displayVersion(result.release.tag)} is available.` });
    } else if (result.status === "current") {
      setMessage({ ok: true, text: "You're up to date. No newer release has been published." });
    } else if (result.status === "error") {
      setMessage({ ok: false, text: result.message });
    } else {
      setMessage({ ok: false, text: "Update checks are off in development builds." });
    }
  }

  /** Moves on from a finished download: straight to the installer, or to the permission step. */
  async function startInstall() {
    if (!(await canInstallUpdates())) {
      setInstall({ step: "blocked" });
      return;
    }
    try {
      await installDownloadedUpdate();
      setInstall({ step: "ready" });
    } catch (e) {
      if (e instanceof InstallError && e.problem === "install-blocked") setInstall({ step: "blocked" });
      else setInstall({ step: "failed", text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function download(url: string) {
    setInstall({ step: "downloading", fraction: 0 });
    try {
      await downloadUpdate(url, (fraction) => setInstall({ step: "downloading", fraction }));
      await startInstall();
    } catch (e) {
      setInstall({ step: "failed", text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function allowInstalls() {
    try {
      await openInstallSettings();
    } catch (e) {
      setInstall({ step: "failed", text: e instanceof Error ? e.message : String(e) });
    }
  }

  const canInstallHere = installerSupported() && !!update?.apkUrl;

  return (
    <div className="panel">
      <div className="settings-block">
        <HeadingWithInfo
          title="Version"
          info={
            <p>
              {APP_NAME} checks GitHub for a newer release once a week when you open it. The check sends nothing
              about you or your library. Update checks are off in development builds.
            </p>
          }
        />
        <p className="muted small">
          {APP_NAME} {APP_VERSION}
          {updateChecksEnabled() ? ` · Checked ${friendlyTime(lastChecked)}` : " · Checks off in this build"}
        </p>
        <div className="field-row">
          <button onClick={check} disabled={checking || !updateChecksEnabled()}>
            {checking ? "Checking..." : "Check for updates"}
          </button>
        </div>
        {message && <p className={message.ok ? "status-ok" : "status-error"}>{message.text}</p>}
      </div>

      {update && (
        <div className="settings-block">
          <h3>Version {displayVersion(update.tag)} is available</h3>
          <div className="field-row">
            {canInstallHere && install.step !== "downloading" && install.step !== "blocked" && (
              <button onClick={() => download(update.apkUrl!)}>
                {install.step === "idle" ? `Download and install${megabytes(update.apkSize)}` : "Download again"}
              </button>
            )}
            <a href={update.pageUrl} target="_blank" rel="noreferrer">
              View release
            </a>
          </div>

          {install.step === "downloading" && (
            <p className="muted small" role="status">
              Downloading{install.fraction === null ? "..." : ` ${Math.round(install.fraction * 100)}%`}
            </p>
          )}
          {install.step === "blocked" && (
            <>
              <p className="status-error">
                The update is downloaded, but Android doesn't yet allow {APP_NAME} to install apps. Turn on "Allow
                from this source" for {APP_NAME}, then come back and press Install.
              </p>
              <div className="field-row">
                <button onClick={allowInstalls}>Open Android settings</button>
                <button onClick={startInstall}>Install</button>
              </div>
            </>
          )}
          {install.step === "ready" && (
            <p className="status-ok">Android's installer has the update. Confirm there to finish.</p>
          )}
          {install.step === "failed" && <p className="status-error">{install.text}</p>}

          {!installerSupported() && (
            <p className="muted small">The web version updates itself. The release page has the Android app.</p>
          )}
          {installerSupported() && !update.apkUrl && (
            <p className="muted small">This release has no Android package attached. See the release page.</p>
          )}
        </div>
      )}

      {notificationsSupported() && (
        <div className="settings-block">
          <h3>Notifications</h3>
          <div className="notif-list">
            <button
              type="button"
              role="switch"
              aria-checked={notify}
              className={`notif-row ${notify ? "on" : ""}`}
              onClick={() => {
                setNotify(!notify);
                setUpdateNotificationsEnabled(!notify);
              }}
            >
              <span className="notif-row-text">
                <span className="notif-row-label">New versions</span>
                <span className="notif-row-detail">Needs notifications on for {APP_NAME}</span>
              </span>
              <span className="notif-switch" aria-hidden="true">
                <span className="notif-switch-knob" />
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
