# Automatic backup and update notifications: verification notes and decisions

Checked on 2026-11-17 against the sources linked below. This file records what was verified before any code was written, the decisions that followed, and the planning assumptions that turned out to be wrong, so the context survives between sessions.

## Summary

| # | Item | Result |
|---|---|---|
| 1 | Drive `drive.appdata` for backups | **Blocked.** Google's Drive API terms prohibit this use without express prior written consent. No Drive code was written. |
| 2 | OAuth in the Capacitor WebView | Confirmed blocked in embedded WebViews. Moot while item 1 is blocked. |
| 3 | Web OAuth without a client secret | Possible with the GIS token model, but it cannot renew unattended. Moot while item 1 is blocked. |
| 4 | Scheduled backups on Android | A background job cannot read the app's IndexedDB. The scheduler runs in the web layer instead. No WorkManager. |
| 5 | Writing to the app-owned folder | No permission needed. Already available through `@capacitor/filesystem`. |
| 6 | Installing a downloaded APK | Needs `REQUEST_INSTALL_PACKAGES` and the "install unknown apps" flow. Must be removed for a Play build. |
| 7 | GitHub latest-release check | Endpoint and fields confirmed. ETag does not save quota for unauthenticated requests. |
| 8 | Android Auto Backup | Kept on, restricted by rules to one keyless backup file. |

## 1. Drive scope and the backup restriction (blocker)

**Scope classification.** `drive.appdata` is listed under "Non-sensitive scopes" on [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth). Non-sensitive scopes "only require basic OAuth App Verification". Per [OAuth app verification help](https://support.google.com/cloud/answer/13463073), an app using only non-sensitive scopes does not have to complete verification unless it wants its name and logo on the consent screen. So the scope itself is not the problem.

**The terms are the problem.** The [Google Drive API Terms of Service](https://developers.google.com/drive/api/terms) (last modified July 8, 2022), section "Customer implementation", says the Drive API is not allowed for certain use cases without Google's "express prior written consent". The first listed use case is:

> "Backup of user or app content from a developer's app or project to Drive."

The [Google Workspace API user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) repeats the same sentence in its not-allowed list under "Appropriate access to and use of Google Drive Scopes".

Neither page exempts `drive.appdata`, the `appDataFolder`, or user-initiated backups. Neither names a form, contact or process for requesting consent. The [appDataFolder guide](https://developers.google.com/workspace/drive/api/guides/appdata) describes the folder as storage for files "the user shouldn't directly interact with" with configuration files as the example, and does not mention backups.

**No official answer exists.** The forum thread named in the brief, [Request for Official Contact](https://discuss.google.dev/t/request-for-official-contact-google-drive-api-express-prior-written-consent-for-backup-use-case/408879), returned HTTP 404 when fetched. Related threads from October 2026 ask the same question and have no reply from Google staff:

- [Policy clarification: complete Android app-data recovery using drive.appdata](https://discuss.google.dev/t/policy-clarification-complete-android-app-data-recovery-using-drive-appdata/407046): 0 replies.
- [Clarification on Google Drive API Backup Policy and Prior Written Consent](https://discuss.google.dev/t/clarification-on-google-drive-api-backup-policy-and-prior-written-consent/409735): 0 replies.
- [Official route for prior written consent under Drive API Customer implementation policies](https://discuss.google.dev/t/official-route-for-prior-written-consent-under-drive-api-customer-implementation-policies/401812): 9 replies, all from other developers asking for the same route. One reports that an email to the OAuth support address bounced.

**Decision.** The planned feature (WatchTime writing its library to the user's Drive) is the prohibited use case as written, consent is required, and there is no known way to obtain it. Per the brief, Drive work stopped here. No Drive code, OAuth client or Google dependency was added. This is open question 1 in the brief and needs the owner's decision. Options are listed under "Open questions" below.

## 2. OAuth in the Capacitor WebView

Google's [June 2021 blog post](https://developers.googleblog.com/en/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/) says authorization requests from embedded webviews are blocked from September 30, 2021 with a `disallowed_useragent` error, and that "Embedded webviews implementing or extending Android WebView do not comply". It recommends the system browser or Android Custom Tabs. It also calls a "Web application" client type used inside an Android app a mismatched use.

A sign-in from the Capacitor WebView would therefore need Custom Tabs or a native Google sign-in component. No plugin was evaluated for Capacitor 8, because item 1 blocks the feature that would use it.

## 3. Web OAuth

The [GIS token model guide](https://developers.google.com/identity/oauth2/web/guides/use-token-model) shows `initTokenClient()` taking only a client ID and scope, with no client secret. It issues short-lived access tokens and no refresh token, and says to get a new token "by calling `requestAccessToken()` from a user-driven event such as a button press".

Consequence: even if Drive were allowed, a web build could upload only while the user is present to renew the token. An unattended scheduled upload on the web is not possible with this model. The page does not state the origin configuration; that was not confirmed.

## 4. Scheduled backups on Android

Confirmed facts:

- WorkManager's minimum repeat interval is 15 minutes and timing is not exact ([Define work requests](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)).
- `@capgo/capacitor-background-task` has a v8 line matching Capacitor 8 and uses WorkManager ([docs](https://capgo.app/docs/plugins/background-task/android/)). Its Android page says task runs are "recorded natively before being delivered to JavaScript, so pending events can be drained when the WebView is ready". That is, the JavaScript still runs in the WebView, when the app is next opened.
- The official `@capacitor/background-runner` runs in a separate JS context that "does not execute your Javascript code in a browser or web view" ([docs](https://capacitorjs.com/docs/apis/background-runner)). It has no IndexedDB.

**Wrong assumption.** The brief assumed a background job could run `buildBackup()`. It cannot: the library lives in the WebView's IndexedDB, which only exists while the WebView is running. A native WorkManager worker would have to boot a hidden WebView and load the app to read the data.

**Decision.** The scheduler runs in the web layer. It checks whether a backup is due when the app starts, when it returns to the foreground, and when it goes to the background. This loses nothing, because library data only changes while the app (or the widget's episode panel, which is the same web app) is running. A backup taken as the app goes to the background is at least as fresh as anything a later background job could produce.

A run whose content is identical to the newest backup already in the folder writes no new file. Otherwise opening the app for a week without changing anything would rotate seven identical copies through the 7-file retention window and push out every older, different backup.

This answers open question 2: no periodic-work plugin and no WorkManager worker are needed.

## 5. Writing to the app-owned folder

- `android/app/build.gradle` sets `minSdkVersion 24` and `targetSdkVersion 35`. (`android/variables.gradle` says 36, but the app module hardcodes its own values and does not read it.) This answers open question 3: `minSdkVersion` stays 24.
- `Context.getExternalFilesDir()` returns "the directory on the primary shared/external storage device where the application can place persistent files it owns" ([reference](https://developer.android.com/reference/android/content/Context#getExternalFilesDir(java.lang.String))). The reference page was too large to fetch in full, so the following comes from the platform documentation as recalled, not from a quote captured in this session: no storage permission is needed from API 19, the directory is removed on uninstall, and the call can return null when the storage is unavailable. Confirm on a device.
- No new native code is needed. `@capacitor/filesystem` 8.1.2 is already a dependency and its `Directory.External` maps to `getExternalFilesDir(null)` (`LegacyFilesystemImplementation.kt`). It provides `writeFile`, `rename`, `readdir`, `stat` and `deleteFile`.
- On Android 11 and later the folder (`Android/data/com.indie.watchtime/files/`) is hidden from other apps and from most file pickers. The existing "Restore from backup" file picker therefore cannot reach it, so Settings lists the local backups itself and restores from them directly.

## 6. Installing a downloaded APK

- An app targeting API 26 or later must declare `REQUEST_INSTALL_PACKAGES` to prompt for an install ([Android Developers Blog, 2017](https://android-developers.googleblog.com/2017/08/making-it-safer-to-get-apps-on-android-o.html)).
- `PackageManager.canRequestPackageInstalls()` "checks whether the calling package is allowed to request package installs through package installer" ([reference](https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls())).
- `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` opens the "install unknown apps" screen and accepts a `package:` data URI to go straight to this app's switch ([reference](https://developer.android.com/reference/android/provider/Settings#ACTION_MANAGE_UNKNOWN_APP_SOURCES)).
- `Intent.ACTION_INSTALL_PACKAGE` was deprecated in API 29. The installer is started with `ACTION_VIEW`, a `content:` URI from the existing `FileProvider`, the APK MIME type and `FLAG_GRANT_READ_URI_PERMISSION`.
- `android/app/src/main/res/xml/file_paths.xml` already declares `<cache-path path="." />`, which covers the download location (`cacheDir/updates/`). No change was needed.
- The system always shows its own confirmation. Android also refuses an update whose signing certificate differs from the installed app's, which is what protects against a tampered download.

**Google Play.** [Play's policy](https://support.google.com/googleplay/android-developer/answer/12085295) limits `REQUEST_INSTALL_PACKAGES` to apps whose core purpose is sending or receiving packages, and says Google protects users "from apps that self update using any method other than Google Play's update mechanism". The permission and the in-app installer must be removed before a Play release. The update banner and the link to the release page can stay.

## 7. GitHub latest-release check

From the [releases reference](https://docs.github.com/en/rest/releases/releases), [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) and [CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests) pages:

- Endpoint: `GET /repos/{owner}/{repo}/releases/latest`. It returns "the most recent non-prerelease, non-draft release, sorted by the created_at attribute". Documented statuses are 200 and 404.
- The response has `tag_name`, `html_url`, `name`, `body`, `published_at`, `prerelease`, `draft`, and `assets[]` with `name`, `size`, `content_type` and `browser_download_url`.
- Unauthenticated requests are limited to 60 per hour per IP address. Over the limit the API answers 403 or 429 with `x-ratelimit-remaining: 0` and a reset time in `x-ratelimit-reset`.
- The API allows cross-origin requests from any origin and exposes `ETag` to scripts, so the web build can call it directly.
- The repository `AtharvaK14/WatchTime` is public, so no token is needed.

**Wrong assumption.** The brief said to use `ETag` "to save quota". A 304 is free only when "the request was made while correctly authorized with an `Authorization` header". This app sends no token, so a 304 still counts against the 60 per hour. The conditional request is kept because it saves the response body, but it saves no quota. One check a week per device is nowhere near the limit either way.

**Existing tags are not `v*` and not semantic versions.** The two releases so far are tagged `1.0` and `1.01`, each with one asset named `WatchTime-release.apk`. The comparison therefore accepts an optional leading `v` and compares numeric parts, so `1.01` reads as 1.1.0. The next release has to be higher than that. `package.json` is set to 1.2.0 for this reason.

## 8. Android Auto Backup

From [Back up user data with Auto Backup](https://developer.android.com/identity/data/autobackup):

- With `allowBackup="true"` and no rules (the state before this work), Auto Backup includes shared preferences, `getFilesDir()`, `getDir()`, databases and `getExternalFilesDir()`. It excludes the cache directories.
- The limit is 25 MB per app. Over it, the system "doesn't back up data to the cloud" at all.
- The backup goes to a private folder in the user's Google account, keeps only the most recent copy, does not count against Drive quota, and is end-to-end encrypted on Android 9 and later when a screen lock is set.
- Apps targeting API 31 or later use `android:dataExtractionRules`; `android:fullBackupContent` is still needed for Android 11 and earlier.

**What that meant before this work.** The WebView's data directory was in scope. It holds localStorage, which contains the TMDB and OMDb keys, so the keys were eligible to leave the device. It also holds the on-device mood-search model, which is far larger than 25 MB once downloaded, at which point the whole backup silently stops. Either outcome is wrong.

**Decision.** Keep `allowBackup` on, with explicit rules that include exactly one file: `system-backup/watchtime-latest.json` in the app's external files directory. The backup pipeline writes it on every run as a copy of the library with the API keys removed. Everything else is excluded: the WebView data, the dated local backups (which do contain keys), and the widget and notification preferences.

This makes Android's own backup the one copy that can survive a reinstall, without the app talking to any Google API itself. It only works if the user has Android backup turned on, it stops if the file exceeds 25 MB, and Android decides when it runs. After a reinstall the restored file appears in Settings under the local backups. This has not been tested on a device.

## Decisions

**Versioning and releases.** `package.json` `version` is the single source of truth and must be set in the tag commit. `android/app/build.gradle` reads it for `versionName` and derives `versionCode` as `major * 10000 + minor * 100 + patch`. Vite exposes the same value to the web layer as `__APP_VERSION__`, which the update check compares against. The release workflow fails if the tag is not `v` plus that version, and again if the built APK's `versionName` does not match the tag.

**Signing.** `build.gradle` reads `WATCHTIME_KEYSTORE_FILE`, `WATCHTIME_KEYSTORE_PASSWORD`, `WATCHTIME_KEY_ALIAS` and `WATCHTIME_KEY_PASSWORD` from the environment and falls back to the untracked `android/keystore.properties` for local builds. CI decodes the keystore from the `ANDROID_KEYSTORE_BASE64` secret into the runner's temp directory.

**Backup files.** Dated backups keep the existing format, API keys included, and go to `backups/` in the app-owned folder. Each is written to a `.tmp` name, read back and checked, then renamed. Pruning runs only after that, and only removes files matching the backup naming pattern.

**Tokens.** No OAuth token exists, because Drive was not built. Nothing new is stored that needs a secure store.

## Assumptions that turned out to be wrong

1. A `drive.appdata` backup only needed a scope check. The scope is non-sensitive, but the Drive API terms prohibit the use case itself.
2. A background job can run `buildBackup()`. It cannot reach IndexedDB without the WebView.
3. `ETag` saves rate-limit quota. Not for unauthenticated requests.
4. Release tags look like `v1.2.0`. The existing ones are `1.0` and `1.01`.
5. `android/variables.gradle` sets the SDK levels. The app module hardcodes its own.
6. Auto Backup was a harmless safety net. With no rules it could carry the API keys off the device, or silently do nothing once the app data passed 25 MB.

## Open questions for the owner

1. **Drive.** Choose one:
   - Drop Drive. Rely on the Android Auto Backup copy for reinstalls and the manual export for everything else.
   - Ask Google for consent. There is no published route; the forum threads above are the only known place to ask, and nobody has had an answer.
   - Use a different mechanism for an off-device copy that needs no Drive API, such as letting the user pick a folder through Android's Storage Access Framework. A folder inside the Drive app chosen that way is written by Android's document provider, not by this app calling the Drive API. This contradicts the "no folder picker" decision in the brief, so it needs a decision.
2. **The backup reminder.** `recordBackupCompleted()` is called when the local backup succeeds, as the brief specifies. Without Drive, that local copy is on the same device as the library, and it silences the 30-day reminder to export a copy elsewhere. Decide whether the reminder should track off-device copies only.
3. **Play release.** Remove `REQUEST_INSTALL_PACKAGES` and the in-app installer before submitting to Play.

## Manual test matrix (not run in this session)

None of these can be run without a device. They remain to be done:

- Scheduled backup runs after the cadence elapses; no new file when nothing changed.
- "Back up now" writes a file; the eighth backup removes the oldest.
- Restore from a listed local backup, merge and replace.
- Reinstall with Android backup on: `watchtime-latest.json` returns and restores without API keys.
- Update banner appears for an older installed version; dismissal hides it for that version only.
- Update notification is posted once per version and respects the notification setting.
- APK download and install with "install unknown apps" off, then on.
- Web: the "scheduled local backups are Android-only" message, the update banner, and no install button.
