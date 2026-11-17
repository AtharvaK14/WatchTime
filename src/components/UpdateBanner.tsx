import { useEffect, useState } from "react";
import { APP_NAME } from "../appInfo";
import { dismissUpdate, UPDATE_STATE_EVENT, updateForBanner } from "../lib/updates";
import { installerSupported } from "../lib/updates/installer";
import { displayVersion } from "../lib/updates/version";

/**
 * Shown when the last update check found a newer release.
 *
 * Dismissing hides it for that release only; the next one brings it back.
 * "View release" opens the GitHub release page on every platform. The
 * Android app also offers "Update", which goes to Settings, where the
 * download and install steps live. The web build never offers an install.
 */
export default function UpdateBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [release, setRelease] = useState(() => updateForBanner());

  useEffect(() => {
    const refresh = () => setRelease(updateForBanner());
    window.addEventListener(UPDATE_STATE_EVENT, refresh);
    return () => window.removeEventListener(UPDATE_STATE_EVENT, refresh);
  }, []);

  if (!release) return null;

  return (
    <div className="backup-nudge" role="status">
      <span className="backup-nudge-text">
        {APP_NAME} {displayVersion(release.tag)} is available.
      </span>
      <span className="backup-nudge-actions">
        {installerSupported() && release.apkUrl && (
          <button className="backup-nudge-cta" onClick={onOpenSettings}>
            Update
          </button>
        )}
        <a className="update-banner-link" href={release.pageUrl} target="_blank" rel="noreferrer">
          View release
        </a>
        <button
          className="backup-nudge-dismiss"
          onClick={() => dismissUpdate(release.tag)}
          aria-label={`Dismiss the notice about version ${displayVersion(release.tag)}`}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
