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
| 8 | Android Auto Backup | Kept on, restricted to a library snapshot (plus the API keys where the backup is end-to-end encrypted). This is what restores the library after a reinstall. |

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
- "Data is restored whenever the app is installed, whether from the Play Store, during device setup ... or by running `adb` install. The restore operation occurs after the APK is installed but before the app is available to be launched by the user." Neither this page nor [Test backup and restore](https://developer.android.com/identity/data/testingbackup) says anything about an APK installed by hand from a file, which is how GitHub releases are installed.
- `domain="file"` is `getFilesDir()`. A `path` naming a directory applies to everything under it.
- `requireFlags="clientSideEncryption"` on an `<include>` keeps a file out of any backup that is not end-to-end encrypted. It exists only in the Android 9 to 11 format (`full-backup-content`), from API 28; the page says to "provide alternate resources" for older versions. The Android 12+ format has no per-file condition, only `disableIfNoEncryptionCapabilities` on the whole `<cloud-backup>`, which would stop the library snapshot too on a phone without a screen lock.

**What that meant before this work.** The WebView's data directory was in scope. It holds localStorage, which contains the TMDB and OMDb keys, so the keys were eligible to leave the device. It also holds the on-device mood-search model, which is far larger than 25 MB once downloaded, at which point the whole backup silently stops. Either outcome is wrong.

**Decision.** Keep `allowBackup` on. Android's own backup is the copy that survives a reinstall, and the app never talks to a Google API itself. The rules include exactly two files in internal storage (`getFilesDir()`), and nothing else:

- `backup/watchtime-snapshot.json`: the library without API keys, in the same format as an exported backup.
- `backup/watchtime-keys.json`: the TMDB and OMDb keys. It is written only while Android can encrypt the backup end to end (Android 9+ with a screen lock, checked by `BackupSupportPlugin` through `KeyguardManager.isDeviceSecure()`) and deleted when it cannot. On Android 9 to 11 the rules also put `requireFlags="clientSideEncryption"` on it (`res/xml-v28/backup_rules.xml`); on Android 7 and 8 it is not in the rules at all.

Excluded: the WebView data (IndexedDB copied file by file can restore corrupt, and localStorage holds the keys), the dated local backups, and the widget and notification preferences.

How it works:

- **Kept current.** The snapshot is rewritten whenever the app goes to the background after a library write (table hooks on shows, movies, watch history, import matches and settings), and on every scheduled backup. Identical content is not rewritten. Android uploads only when a file changed, roughly nightly.
- **Never emptied by accident.** An empty library is not written over the snapshot. If Android clears the WebView storage, the snapshot keeps the library until the restore below puts it back. Reset Data deletes the snapshot and keys file on purpose.
- **Size.** The snapshot is kept under 20 MB. Over that, the episode cache (metadata fetched from TMDB) is left out, and Home's sync fetches it again. If it is still over, Settings says Android will not back it up.
- **Restored at first launch.** `firstLaunch.ts` runs before the app renders. If the library is empty, the snapshot is present, and this install has never run the check (a localStorage marker, which a reinstall or WebView eviction wipes and Reset Data does not), it restores the snapshot with the keys file merged in, shows "Restoring your library..." meanwhile, then a toast with the count. With the keys restored, first-run setup is skipped.

Limits that remain: the user must have Android backup on and be signed in to the same Google account; changes since Android's last backup are lost; Android keeps only the latest backup; and restore for an APK installed by hand from GitHub is unconfirmed until tested on a device. Settings explains the first two. Settings preferences kept in localStorage (backup cadence, region, notification choice) are not in the snapshot and return to their defaults.

## Decisions

**Versioning and releases.** `package.json` `version` is the single source of truth and must be set in the tag commit. `android/app/build.gradle` reads it for `versionName` and derives `versionCode` as `major * 10000 + minor * 100 + patch`. Vite exposes the same value to the web layer as `__APP_VERSION__`, which the update check compares against. The release workflow fails if the tag is not `v` plus that version, and again if the built APK's `versionName` does not match the tag.

**Signing.** `build.gradle` reads `WATCHTIME_KEYSTORE_FILE`, `WATCHTIME_KEYSTORE_PASSWORD`, `WATCHTIME_KEY_ALIAS` and `WATCHTIME_KEY_PASSWORD` from the environment and falls back to the untracked `android/keystore.properties` for local builds. CI decodes the keystore from the `ANDROID_KEYSTORE_BASE64` secret into the runner's temp directory.

**Backup files.** Dated backups keep the existing format, API keys included, and go to `backups/` in the app-owned folder. Each is written to a `.tmp` name, read back and checked, then renamed. Pruning runs only after that, and only removes files matching the backup naming pattern.

**Tokens.** No OAuth token exists, because Drive was not built. Nothing new is stored that needs a secure store.

## Release pipeline

`.github/workflows/release.yml` runs on tags matching `v*`. To release, set `"version"` in `package.json`, commit, tag that commit `v` plus the version, and push the tag. The existing tags `1.0` and `1.01` do not match the pattern and are not rebuilt.

Repository secrets it needs:

| Secret | Contents |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The release keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ANDROID_KEY_ALIAS` | The key's alias |
| `ANDROID_KEY_PASSWORD` | The key password |

The keystore has to be the one releases 1.0 and 1.01 were signed with. Android refuses to install an update signed with a different key, so a new key would strand every existing install. To guard against that, set the repository variable `ANDROID_CERT_SHA256` to the release certificate's SHA-256 digest (`apksigner verify --print-certs` prints it); the workflow then fails if the APK is signed by anything else.

The workflow fails, and publishes nothing, when the tag does not equal `v` plus the `package.json` version, when no signed APK is produced, when the APK's `versionName` differs from the tag, or when the signature does not verify. The APK is attached as `WatchTime-release.apk`, the same name as the earlier releases.

The workflow has not run yet. It first runs when a `v*` tag is pushed.

## What was checked in this session

- `npm run build` and `npm run lint` pass.
- `npm run check:backup` (95 checks) and `npm run check:updates` (44 checks) pass. The backup check includes an export, validate and restore round trip against an in-memory IndexedDB, for both the keyless copy and the local format.
- A release APK built locally from this branch reports `versionName` 1.2.0 and `versionCode` 10200, is signed, declares `REQUEST_INSTALL_PACKAGES`, and its manifest references both backup rule files.
- The production web build was opened in a browser. The update check reached GitHub and read the real latest release (`1.01`), correctly reporting no update for 1.2.0. With a newer release placed in the stored state, the banner appeared with "View release" and no install button, dismissal hid it for that version only, and a later version brought it back. The backup section showed the "Android only" message.

Nothing was run on an Android device or emulator. See the manual test matrix at the end.

## Assumptions that turned out to be wrong

1. A `drive.appdata` backup only needed a scope check. The scope is non-sensitive, but the Drive API terms prohibit the use case itself.
2. A background job can run `buildBackup()`. It cannot reach IndexedDB without the WebView.
3. `ETag` saves rate-limit quota. Not for unauthenticated requests.
4. Release tags look like `v1.2.0`. The existing ones are `1.0` and `1.01`.
5. `android/variables.gradle` sets the SDK levels. The app module hardcodes its own.
6. Auto Backup was a harmless safety net. With no rules it could carry the API keys off the device, or silently do nothing once the app data passed 25 MB.

## Open questions for the owner

1. **Drive.** Choose one:
   - Drop Drive. Rely on Android Auto Backup for reinstalls and the manual export for everything else. (This is what the code now does.)
   - Ask Google for consent. There is no published route; the forum threads above are the only known place to ask, and nobody has had an answer.
   - Use a different mechanism for an off-device copy that needs no Drive API, such as letting the user pick a folder through Android's Storage Access Framework. The app would then write through whichever storage app owns that folder instead of calling a cloud API itself. Not investigated: which cloud apps offer their folders to that picker (the Drive app may not), and it contradicts the "no folder picker" decision in the brief.

   The manual export already reaches Drive today: the Android share sheet lets the user send the backup file to the Drive app themselves.
2. **The backup reminder.** `recordBackupCompleted()` is called when the local backup succeeds, as the brief specifies. Without Drive, that local copy is on the same device as the library, and it silences the 30-day reminder to export a copy elsewhere. Decide whether the reminder should track off-device copies only.
3. **Play release.** Remove `REQUEST_INSTALL_PACKAGES` and the in-app installer before submitting to Play.

## Manual test matrix (not run in this session)

None of these can be run without a device. They remain to be done:

- Scheduled backup runs after the cadence elapses; no new file when nothing changed.
- "Back up now" writes a file; the eighth backup removes the oldest.
- Restore from a listed local backup, merge and replace.
- Reinstall with Android backup on, using the `adb` script on the testing page (`bmgr backupnow com.indie.watchtime`, uninstall, reinstall): the "Restoring your library" screen appears, the library returns, and with a screen lock set the API keys return too so setup is skipped. **Done 17 November 2026 on a Galaxy S24 (Android 17), local transport:** Android restored the files at install (`restoreAtInstall`, signatures matched), and the library and keys came back. The first run hung on the restoring screen (the wait timer fired at once and the restore drew over the app); fixed in `startup.ts`, then a replayed first launch showed the app after about a second and the scheduled backup ran.
- The same with no screen lock: the library returns, setup asks for the TMDB key.
- Reinstall from the GitHub APK through the phone's installer, after a real overnight backup: does Android restore at all? This decides whether sideloaded users get this before the Play release.
- Reset Data, then reopen the app: the library stays empty and is not restored.
- Settings shows the snapshot size and whether keys are included; removing the screen lock and leaving the app changes "included" to "not included".
- Update banner appears for an older installed version; dismissal hides it for that version only.
- Update notification is posted once per version and respects the notification setting.
- APK download and install with "install unknown apps" off, then on.
- Web: the "scheduled local backups are Android-only" message, the update banner, and no install button.
