// Reading GitHub's "latest release" response, and deciding when to ask for
// it. Pure, so scripts/check-updates.ts can run it.

/** Where releases are published. Public, so the check needs no token. */
export const RELEASES_REPO = "AtharvaK14/WatchTime";

export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

const RELEASE_PAGE_PREFIX = `https://github.com/${RELEASES_REPO}/releases/`;
const ASSET_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`;

export interface ReleaseInfo {
  /** The release tag as published, e.g. "v1.2.0". */
  tag: string;
  /** The release page, for "View release". */
  pageUrl: string;
  /** Direct download of the APK asset, or null if the release has none. */
  apkUrl: string | null;
  apkSize: number | null;
  publishedAt: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Picks the fields the app uses out of the API response, or null if it is
 * not a usable release.
 *
 * The two URLs are only accepted when they point into this repository's own
 * releases. They end up behind a "View release" link and handed to the
 * system installer, so a response that names anywhere else is treated as no
 * release at all rather than followed.
 */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.tag_name !== "string" || !raw.tag_name) return null;
  if (raw.draft === true || raw.prerelease === true) return null;
  if (typeof raw.html_url !== "string" || !raw.html_url.startsWith(RELEASE_PAGE_PREFIX)) return null;

  let apkUrl: string | null = null;
  let apkSize: number | null = null;
  if (Array.isArray(raw.assets)) {
    for (const asset of raw.assets) {
      if (!isRecord(asset)) continue;
      const { name, browser_download_url: url, size } = asset;
      if (typeof name !== "string" || !name.toLowerCase().endsWith(".apk")) continue;
      if (typeof url !== "string" || !url.startsWith(ASSET_PREFIX)) continue;
      apkUrl = url;
      apkSize = typeof size === "number" ? size : null;
      break;
    }
  }

  return {
    tag: raw.tag_name,
    pageUrl: raw.html_url,
    apkUrl,
    apkSize,
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
  };
}

const HOUR_MS = 60 * 60 * 1000;

/** The automatic check runs at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * HOUR_MS;

/** After a check that could not complete (offline, rate-limited), how long before the next automatic try. */
export const UPDATE_CHECK_RETRY_MS = 6 * HOUR_MS;

function elapsedSince(iso: string | null, now: number): number {
  if (!iso) return Infinity;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then) || then > now) return Infinity;
  return now - then;
}

/**
 * Whether the automatic check should make a network request now.
 *
 * @param lastCheckedAt when GitHub last answered
 * @param lastAttemptAt when a request was last sent, answered or not
 */
export function isUpdateCheckDue(lastCheckedAt: string | null, lastAttemptAt: string | null, now: number): boolean {
  if (elapsedSince(lastCheckedAt, now) < UPDATE_CHECK_INTERVAL_MS) return false;
  return elapsedSince(lastAttemptAt, now) >= UPDATE_CHECK_RETRY_MS;
}
