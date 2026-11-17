// Update checks against GitHub Releases.
//
// One unauthenticated GET to the repository's "latest release" endpoint, at
// most once a week on app open, plus whenever the user presses "Check for
// updates". It sends nothing about the user or the library - no token, no
// identifier, only the request itself. docs/backup-and-updates.md has the
// endpoint, the rate limits and why the conditional request is still worth
// sending.
//
// Never in a development build: `npm run dev` would otherwise ask GitHub on
// every reload.

import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { APP_NAME } from "../../appInfo";
import { checkNotificationPermission } from "../notifications";
import { notificationsEnabled } from "../notifications/prefs";
import { APP_VERSION } from "./appVersion";
import { isUpdateCheckDue, LATEST_RELEASE_URL, parseRelease, type ReleaseInfo } from "./release";
import { displayVersion, isNewerVersion } from "./version";

const STATE_KEY = "update_check_state";
const NOTIFY_PREF_KEY = "notifications_app_updates";

/** Fired on window when the stored update state changes, so the banner and Settings re-read it. */
export const UPDATE_STATE_EVENT = "update-state-changed";

/** Every request gives up after this long. */
const REQUEST_TIMEOUT_MS = 10_000;

/** One fixed id, so a notification about a newer version replaces the older one. */
const UPDATE_NOTIFICATION_ID = 770_001;

interface UpdateState {
  /** When GitHub last answered. */
  lastCheckedAt: string | null;
  /** When a request was last sent, answered or not. */
  lastAttemptAt: string | null;
  /** ETag of the cached release, for a conditional request. */
  etag: string | null;
  /** The latest release GitHub reported, whether or not it is newer than this build. */
  release: ReleaseInfo | null;
  /** The release tag whose banner the user dismissed. */
  dismissedTag: string | null;
  /** The release tag a notification was already posted for. */
  notifiedTag: string | null;
}

const EMPTY_STATE: UpdateState = {
  lastCheckedAt: null,
  lastAttemptAt: null,
  etag: null,
  release: null,
  dismissedTag: null,
  notifiedTag: null,
};

function readState(): UpdateState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
    return typeof raw === "object" && raw !== null ? { ...EMPTY_STATE, ...(raw as Partial<UpdateState>) } : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

function writeState(state: UpdateState): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event(UPDATE_STATE_EVENT));
}

/** Development builds never check. */
export function updateChecksEnabled(): boolean {
  return !import.meta.env.DEV;
}

/**
 * The newer release, if the last check found one.
 *
 * Compared against the running version every time rather than stored as a
 * verdict, so installing the update makes it stop counting on its own.
 */
export function availableUpdate(): ReleaseInfo | null {
  const { release } = readState();
  return release && isNewerVersion(release.tag, APP_VERSION) ? release : null;
}

/** The update to show a banner for: a newer release the user has not dismissed. */
export function updateForBanner(): ReleaseInfo | null {
  const update = availableUpdate();
  return update && update.tag !== readState().dismissedTag ? update : null;
}

/** Hides the banner for this release only. The next release shows it again. */
export function dismissUpdate(tag: string): void {
  writeState({ ...readState(), dismissedTag: tag });
}

export function lastUpdateCheckAt(): string | null {
  return readState().lastCheckedAt;
}

/** Per-feature opt-out, under the app's main notification switch. On by default. */
export function updateNotificationsEnabled(): boolean {
  return localStorage.getItem(NOTIFY_PREF_KEY) !== "false";
}

export function setUpdateNotificationsEnabled(on: boolean): void {
  localStorage.setItem(NOTIFY_PREF_KEY, String(on));
}

export type UpdateCheckResult =
  | { status: "update"; release: ReleaseInfo }
  | { status: "current" }
  /** The automatic check was not due, or the device is offline. No request was made. */
  | { status: "skipped" }
  /** A development build. */
  | { status: "disabled" }
  | { status: "error"; message: string };

function resultFor(release: ReleaseInfo | null): UpdateCheckResult {
  return release && isNewerVersion(release.tag, APP_VERSION) ? { status: "update", release } : { status: "current" };
}

function rateLimitMessage(response: Response): string {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const at = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toLocaleTimeString()}` : " later";
  return `GitHub's request limit for this network is used up. Try again${at}.`;
}

async function fetchLatest(state: UpdateState): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Only Accept and If-None-Match: both are on the API's CORS allow-list, so
  // the browser build can make this request without it being refused.
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  // Only when there is a cached release for a 304 to stand for.
  if (state.etag && state.release) headers["If-None-Match"] = state.etag;

  let response: Response;
  try {
    response = await fetch(LATEST_RELEASE_URL, { headers, signal: controller.signal, cache: "no-store" });
  } catch {
    writeState({ ...state });
    return {
      status: "error",
      message: controller.signal.aborted
        ? "GitHub took too long to answer. Try again in a moment."
        : "Couldn't reach GitHub. Check your connection and try again.",
    };
  } finally {
    clearTimeout(timeout);
  }

  const checkedAt = new Date().toISOString();

  if (response.status === 304 && state.release) {
    writeState({ ...state, lastCheckedAt: checkedAt });
    return resultFor(state.release);
  }
  if (response.status === 404) {
    // The documented answer for a repository with no published release.
    writeState({ ...state, lastCheckedAt: checkedAt, release: null, etag: null });
    return { status: "current" };
  }
  if (response.status === 403 || response.status === 429) {
    writeState({ ...state });
    return { status: "error", message: rateLimitMessage(response) };
  }
  if (!response.ok) {
    writeState({ ...state });
    return { status: "error", message: `GitHub returned an error (${response.status}). Try again later.` };
  }

  let release: ReleaseInfo | null;
  try {
    release = parseRelease(await response.json());
  } catch {
    release = null;
  }
  if (!release) {
    writeState({ ...state });
    return { status: "error", message: "GitHub's answer wasn't a release this app can read." };
  }
  writeState({ ...state, lastCheckedAt: checkedAt, release, etag: response.headers.get("etag") });
  return resultFor(release);
}

let inFlight: Promise<UpdateCheckResult> | null = null;

/**
 * Asks GitHub for the latest release.
 *
 * @param force true for the Settings button: check now, whatever the
 *   schedule says. Otherwise the request is only made when a week has passed
 *   since GitHub last answered, and never while offline.
 */
export function checkForUpdates({ force = false }: { force?: boolean } = {}): Promise<UpdateCheckResult> {
  if (!updateChecksEnabled()) return Promise.resolve({ status: "disabled" });
  if (inFlight) return inFlight;

  const state = readState();
  if (!force) {
    if (!navigator.onLine) return Promise.resolve({ status: "skipped" });
    if (!isUpdateCheckDue(state.lastCheckedAt, state.lastAttemptAt, Date.now())) {
      return Promise.resolve({ status: "skipped" });
    }
  }

  inFlight = fetchLatest({ ...state, lastAttemptAt: new Date().toISOString() })
    .then(async (result) => {
      if (result.status === "update") await notifyOnce(result.release);
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Posts one notification per new version, and only if the user has
 * notifications on in the app, has not turned this kind off, and Android
 * allows them. Never asks for permission: that only happens from the
 * explicit switches in onboarding and Settings.
 */
async function notifyOnce(release: ReleaseInfo): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (readState().notifiedTag === release.tag) return;
  if (!notificationsEnabled() || !updateNotificationsEnabled()) return;
  try {
    if ((await checkNotificationPermission()) !== "granted") return;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: UPDATE_NOTIFICATION_ID,
          title: `${APP_NAME} ${displayVersion(release.tag)} is available`,
          body: `Open ${APP_NAME} to see what's new and update.`,
        },
      ],
    });
    // Recorded only once it was actually posted, so a version announced
    // while notifications were off is announced when they come back on.
    writeState({ ...readState(), notifiedTag: release.tag });
  } catch {
    // The banner still shows; a notification that could not be posted is
    // not worth surfacing as an error.
  }
}

/** How long after launch the automatic check waits, so it never competes with startup. */
const STARTUP_DELAY_MS = 5000;

/** Runs the weekly check shortly after launch. Registered once from App; returns the cleanup. */
export function initUpdateChecks(): () => void {
  if (!updateChecksEnabled()) return () => {};
  const timer = window.setTimeout(() => {
    checkForUpdates().catch(() => {});
  }, STARTUP_DELAY_MS);
  return () => window.clearTimeout(timer);
}
