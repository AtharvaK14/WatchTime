/**
 * Scenario check for update notifications, run with `npm run check:updates`.
 *
 * Covers the decisions: which version is newer, what counts as a usable
 * release in GitHub's response, and when the weekly check is due. The tags
 * used are the real ones on the repository ("1.0", "1.01") alongside the
 * "v1.2.0" form the release workflow produces.
 *
 * What it cannot show: the request itself, the banner, the notification, or
 * the Android download and install. Those need the app running;
 * docs/backup-and-updates.md lists them.
 */

import { compareVersions, displayVersion, isNewerVersion, parseVersion } from "../src/lib/updates/version";
import {
  isUpdateCheckDue,
  LATEST_RELEASE_URL,
  parseRelease,
  UPDATE_CHECK_INTERVAL_MS,
} from "../src/lib/updates/release";

let checks = 0;
const failures: string[] = [];
function expect(label: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(`${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

console.log("Comparing versions");
{
  expect("1.2.0 is newer than 1.1.9", compareVersions("1.2.0", "1.1.9"), 1);
  expect("1.10.0 is newer than 1.9.0 (a string comparison says the opposite)", compareVersions("1.10.0", "1.9.0"), 1);
  expect("...and the string comparison really does get it wrong", "1.10.0" > "1.9.0", false);
  expect("2.0.0 is newer than 1.99.99", compareVersions("2.0.0", "1.99.99"), 1);
  expect("Equal versions are equal", compareVersions("1.2.0", "1.2.0"), 0);
  expect("A leading v is ignored", compareVersions("v1.2.0", "1.2.0"), 0);
  expect("Missing parts count as zero", compareVersions("1.2", "1.2.0"), 0);
  expect("Older is older", compareVersions("1.1.0", "1.2.0"), -1);
  expect("A pre-release is older than its release", compareVersions("1.2.0-beta.1", "1.2.0"), -1);
  expect("Pre-releases order numerically", compareVersions("1.2.0-beta.10", "1.2.0-beta.2"), 1);
  expect("A numeric pre-release part ranks below a word", compareVersions("1.2.0-1", "1.2.0-alpha"), -1);
  expect("A longer pre-release ranks above its prefix", compareVersions("1.2.0-alpha.1", "1.2.0-alpha"), 1);
  expect("Build metadata is ignored", compareVersions("1.2.0+build.7", "1.2.0"), 0);
  expect("Not a version: no verdict", compareVersions("latest", "1.2.0"), null);
  expect("Not a version: no verdict (empty)", compareVersions("", "1.2.0"), null);
  expect("Not a version: no verdict (trailing dot)", compareVersions("1.2.", "1.2.0"), null);
  expect("Parsed parts are numbers", parseVersion("v1.02.3")?.parts, [1, 2, 3]);
}

console.log("The tags already on GitHub");
{
  expect('"1.01" reads as 1.1.0', compareVersions("1.01", "1.1.0"), 0);
  expect('"1.01" is newer than "1.0"', isNewerVersion("1.01", "1.0"), true);
  expect("1.2.0 installed: the existing 1.01 release is not an update", isNewerVersion("1.01", "1.2.0"), false);
  expect("1.2.0 installed: v1.2.0 is not an update", isNewerVersion("v1.2.0", "1.2.0"), false);
  expect("1.2.0 installed: v1.2.1 is an update", isNewerVersion("v1.2.1", "1.2.0"), true);
  expect("1.2.0 installed: v1.3.0 is an update", isNewerVersion("v1.3.0", "1.2.0"), true);
  expect("An unreadable tag is never an update", isNewerVersion("nightly", "1.2.0"), false);
  expect("Shown without the v", displayVersion("v1.3.0"), "1.3.0");
}

console.log("Reading GitHub's response");
{
  const page = "https://github.com/AtharvaK14/WatchTime/releases/tag/v1.3.0";
  const apk = "https://github.com/AtharvaK14/WatchTime/releases/download/v1.3.0/WatchTime-release.apk";
  const response = {
    tag_name: "v1.3.0",
    name: "WatchTime v1.3.0",
    html_url: page,
    draft: false,
    prerelease: false,
    published_at: "2026-12-01T10:00:00Z",
    body: "notes",
    assets: [
      { name: "checksums.txt", size: 90, browser_download_url: apk.replace("WatchTime-release.apk", "checksums.txt") },
      { name: "WatchTime-release.apk", size: 8945249, content_type: "application/vnd.android.package-archive", browser_download_url: apk },
    ],
  };
  expect("Takes the tag, the page and the APK asset", parseRelease(response), {
    tag: "v1.3.0",
    pageUrl: page,
    apkUrl: apk,
    apkSize: 8945249,
    publishedAt: "2026-12-01T10:00:00Z",
  });
  expect("A release with no APK still counts, without a download", parseRelease({ ...response, assets: [] })?.apkUrl, null);
  expect("A draft is not a release", parseRelease({ ...response, draft: true }), null);
  expect("A pre-release is not offered", parseRelease({ ...response, prerelease: true }), null);
  expect("No tag: not a release", parseRelease({ ...response, tag_name: "" }), null);
  expect("An error body is not a release", parseRelease({ message: "Not Found" }), null);
  expect("Not an object: not a release", parseRelease("<html>"), null);
  expect(
    "A release page on another site is refused",
    parseRelease({ ...response, html_url: "https://example.com/AtharvaK14/WatchTime/releases/tag/v1.3.0" }),
    null
  );
  expect(
    "An APK hosted anywhere else is not offered for install",
    parseRelease({
      ...response,
      assets: [{ name: "WatchTime-release.apk", size: 1, browser_download_url: "https://example.com/WatchTime-release.apk" }],
    })?.apkUrl,
    null
  );
  expect(
    "...nor one from another repository on GitHub",
    parseRelease({
      ...response,
      assets: [
        {
          name: "WatchTime-release.apk",
          size: 1,
          browser_download_url: "https://github.com/someone-else/WatchTime/releases/download/v1.3.0/WatchTime-release.apk",
        },
      ],
    })?.apkUrl,
    null
  );
  expect(
    "The endpoint is the repository's latest release",
    LATEST_RELEASE_URL,
    "https://api.github.com/repos/AtharvaK14/WatchTime/releases/latest"
  );
}

console.log("When the weekly check is due");
{
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const ago = (hours: number) => new Date(now - hours * 3600_000).toISOString();
  expect("Never checked: due", isUpdateCheckDue(null, null, now), true);
  expect("Checked 6 days ago: not due", isUpdateCheckDue(ago(6 * 24), ago(6 * 24), now), false);
  expect("Checked 8 days ago: due", isUpdateCheckDue(ago(8 * 24), ago(8 * 24), now), true);
  expect("Overdue, but a request failed an hour ago: wait", isUpdateCheckDue(ago(8 * 24), ago(1), now), false);
  expect("Overdue, and the failed request was 7 hours ago: try again", isUpdateCheckDue(ago(8 * 24), ago(7), now), true);
  expect("Never answered, failed an hour ago: wait", isUpdateCheckDue(null, ago(1), now), false);
  expect("A timestamp in the future does not switch checks off", isUpdateCheckDue(new Date(now + 1e10).toISOString(), null, now), true);
  expect("The interval is 7 days", UPDATE_CHECK_INTERVAL_MS, 7 * 24 * 3600_000);
}

console.log();
if (failures.length === 0) {
  console.log(`All ${checks} checks pass.`);
} else {
  console.log(`${failures.length} of ${checks} checks FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
