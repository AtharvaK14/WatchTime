# WatchTime

A personal, **local-first** TV and movie tracker — a replacement for TV Time
(which shut down July 2026). Track episodes and movies, see what to watch
next, and keep your whole library on your own device. No accounts, no ads,
no server.

Runs as a web app and, wrapped with Capacitor, as a native **Android** app.

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Getting started (development)](#getting-started-development)
- [API keys](#api-keys)
- [Importing from TV Time](#importing-from-tv-time)
- [Backup & restore](#backup--restore)
- [Building the Android app](#building-the-android-app)
- [Hosting the privacy policy (GitHub Pages)](#hosting-the-privacy-policy-github-pages)
- [Publishing to Google Play](#publishing-to-google-play)
- [Project structure](#project-structure)
- [Privacy](#privacy)

---

## Features

- **Watch Next** — the next unwatched, released episode for every show you're mid-way through.
- **Haven't Watched For a While** — shows you started but stopped (configurable threshold, default 60 days).
- **Haven't Yet Started** — shows added to your library but never begun.
- **Rewatch support** — mark episodes/movies watched again; watch time and rewatch counts grow without inflating "episodes watched" or changing your progress.
- **Movies** — watched list and want-to-watch list.
- **Ratings** — IMDb (and Rotten Tomatoes for movies) via OMDb.
- **Stats** — total time watched, episodes, movies.
- **Import** from a TV Time export; **backup/restore** your entire library to a file.
- **Diagnostics** — compare stored data against TMDB to explain any discrepancy.

## Tech stack

- **Vite + React + TypeScript**
- **Dexie.js** (IndexedDB) for all local storage
- **Capacitor** for the Android build
- Data sources: **TMDB** (metadata), **OMDb** (IMDb/RT ratings), **TVmaze** (per-episode runtimes)

Requires **Node 20+** (developed on Node 24).

---

## Getting started (development)

```bash
npm install
npm run dev
```

Open the local URL Vite prints. On first launch a short wizard walks you
through adding API keys (see below).

Other scripts:

| Script | What it does |
|--------|--------------|
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build to `dist/` |
| `npm run lint` | Run oxlint |
| `npm run cap:sync` | Build the web app and sync it into the Android project |
| `npm run cap:open` | Open the Android project in Android Studio |

---

## API keys

Each user supplies their own free keys; nothing is bundled or shared, and
keys are stored only on your device.

- **TMDB** (required) — search, posters, plots, episode lists.
  Get a key at https://www.themoviedb.org/settings/api (v3 auth).
- **OMDb** (optional, for ratings) — IMDb ratings everywhere, Rotten Tomatoes for movies.
  Get a key at https://www.omdbapi.com/apikey.aspx (free tier: 1,000 lookups/day; the app caches results and degrades gracefully when the quota is hit).
- **TVmaze** — no key needed; used automatically for accurate per-episode runtimes.

You can enter/update keys anytime under **Settings → API Keys**.

---

## Importing from TV Time

Settings → **Import from TV Time**. A third-party JSON export (with exact
IMDb/TVDB IDs) is recommended. The raw GDPR CSV export also works — upload
these two files by their exact names:

- `tracking-prod-records.csv` → movies (watched + want-to-watch)
- `tracking-prod-records-v2.csv` → episode history + show follow status

Ambiguous title matches pause the import and ask you to pick, then remember
your choice.

## Backup & restore

Settings → **Backup & Restore**. Export your entire library (shows, movies,
watch history, import matches) **plus your API keys** to a single JSON file,
and restore it on any install.

- On desktop/web the backup downloads as a file.
- On the Android app it opens the system share sheet (Save to Files / Drive / send).
- Keep the file somewhere private — it contains your API keys.

Because everything is local, this is your only recovery path if the device
storage is cleared — back up periodically (the app reminds you).

---

## Building the Android app

The Android project lives in `android/` (Capacitor). This machine needs the
native Android toolchain — the web dev environment alone can't build an APK/AAB.

### Prerequisites

- **Android Studio** (latest) with the Android SDK
- **JDK 17+**
- The `android/` project already targets **Android 16 (API 36)**, min **API 24 (Android 7)**

### Build & run

```bash
npm run cap:sync     # build the web app + copy it into android/
npm run cap:open     # open the project in Android Studio
```

Then in Android Studio: pick a device/emulator and press **Run**, or build a
release bundle (see [Publishing](#publishing-to-google-play)).

App identity (in `capacitor.config.ts`):

- **App ID (package name):** `com.indie.watchtime` — **permanent, never change after release**
- **Display name:** `WatchTime` — also set in `src/appInfo.ts` (change it there to rename the in-app branding)

> **Note on Android Studio's AGP upgrade prompt:** the project is pinned to a
> known-good Android Gradle Plugin. If Android Studio offers to upgrade AGP,
> you can accept it, but if a release build then fails on
> `getDefaultProguardFile('proguard-android.txt')`, that's the AGP-9 change —
> `android/app/build.gradle` already uses the R8-compatible
> `proguard-android-optimize.txt`, so re-sync and rebuild.

### App icon / splash

Source art is in `assets/` and generated by `@capacitor/assets`:

```bash
# after replacing assets/icon.png (1024x1024) etc.
npx @capacitor/assets generate --android
```

`scripts/build-app-icon.mjs` builds the current icon (a TV mark with a coral
"W") from a single vector if you want to tweak it.

---

## Hosting the privacy policy (GitHub Pages)

Google Play requires a **public URL** to a privacy policy. One is already
written at [`docs/privacy.html`](docs/privacy.html) and linked from the app's
**Settings → About** screen. Publish it with GitHub Pages (free):

1. Push this repo to GitHub (branch `main`).
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Set **Branch** = `main` and **folder** = `/docs`, then **Save**.
5. Wait ~1 minute, then open:
   **`https://atharvak14.github.io/tv-time-replacement/privacy.html`**

That URL is already wired into the About screen
(`PRIVACY_POLICY_URL` in `src/components/About.tsx`). If you fork or rename
the repo, update that constant to match your Pages URL.

> Edit the policy text in `docs/privacy.html` (contact email, "last updated"
> date, etc.) before publishing.

---

## Publishing to Google Play

A start-to-finish outline. Budget time for the **closed-testing requirement**
(step 7) — for new personal developer accounts it's mandatory before you can
go to production.

### 1. One-time setup

- Create a **Google Play Console** developer account (one-time **$25** fee): https://play.google.com/console
- Have your **privacy policy URL** ready (see the section above).
- Prepare an **upload keystore** for signing (next step).

### 2. Set the app version

In `android/app/build.gradle`, bump for each release:

```gradle
versionCode 1        // integer, must increase every upload
versionName "1.0"    // human-readable, shown to users
```

### 3. Build a signed Android App Bundle (`.aab`)

Play accepts **App Bundles (.aab)**, not APKs. In Android Studio:

1. **Build → Generate Signed App Bundle / APK → Android App Bundle**.
2. Create a new **keystore** if you don't have one (choose a strong password and **back this file up — losing it means you can't update the app**). Or reuse an existing upload key.
3. Choose the **release** build variant and finish. The `.aab` lands in `android/app/release/`.

Enroll in **Play App Signing** when prompted in the Console — Google manages
the final app-signing key; your keystore is just the *upload* key.

### 4. Create the app in Play Console

- **Create app** → set name (**WatchTime**, or your final name), default language, "App", "Free".
- Complete the **Dashboard** setup tasks (below).

### 5. Store listing

- **App name**, short description, full description.
- **Graphics:** app icon **512×512**, **feature graphic 1024×500**, and **phone screenshots** (at least 2). The in-app icon source is in `assets/`.
- **Privacy policy URL** — paste your GitHub Pages URL.

### 6. Policy & content declarations

- **Data safety form:** this app collects and shares **no** data — declare **"No data collected"** and **"No data shared."** (It makes direct requests to TMDB/OMDb/TVmaze from the device using the user's own keys; there's no developer server.)
- **Content rating** questionnaire.
- **Target audience**, **Ads** (this app has none), **Government apps**, etc. — answer the short questionnaires.

### 7. Testing tracks (required for new accounts)

New personal developer accounts must run a **closed test with at least 12
opted-in testers for 14 consecutive days** before production is unlocked:

1. **Testing → Internal testing** — upload the `.aab`, add yourself, verify the app installs and runs.
2. **Testing → Closed testing** — create a track, add ≥12 testers (email list or Google Group), and keep the test running 14 days.
3. After that, you can **promote to Production**.

### 8. Release to production

- **Production → Create new release** → upload the `.aab` (or promote from closed testing).
- Add **release notes**, review, and **roll out**.
- Google review typically takes a few hours to a few days.

> For each future update: bump `versionCode`/`versionName`, rebuild the signed
> `.aab`, and upload a new release.

---

## Project structure

```
src/
  db.ts                     Dexie schema (IndexedDB), source of truth
  appInfo.ts                App display name (single source)
  tmdb.ts / omdb.ts         API clients (+ key checks, OMDb caching/rate-limit)
  tvmaze.ts                 Per-episode runtimes (no key)
  lib/
    episodeSync.ts          Episode caching + "next unwatched" logic
    watchEvents.ts          Watch/rewatch writes; progression helpers
    showStatus.ts           Staleness threshold (configurable)
    backup.ts               Full export/validate/restore (native + web)
    persistence.ts          Storage-persistence request + backup nudge
    useDraggableSheet.ts    Mobile bottom-sheet drag (capped at 75%)
    native.ts / useOnline.ts / backHandler.ts   Capacitor behaviors
  components/
    DetailsPanel.tsx        Show/movie details + season browser
    EpisodeDetailsPanel.tsx Episode detail (landscape hero, rewatch controls)
    About.tsx               Credits, attribution, privacy link
    BrandMark.tsx           The TV+W logo mark
    icons.tsx               Tab icons
  pages/
    Home.tsx                Watch Next / stale / not-started
    Library.tsx  Movies.tsx  AddTitle.tsx
    Settings.tsx            Backup, import, keys, Watch Next, diagnostics, about
    Stats.tsx  Diagnostics.tsx
android/                    Capacitor Android project
docs/privacy.html          Privacy policy (host via GitHub Pages)
assets/                    App icon / splash source images
```

## Privacy

WatchTime collects nothing. Your library, watch history, and API keys live
only on your device. The only network requests go directly from your device
to TMDB, OMDb, and TVmaze, using your own keys. No accounts, no analytics,
no ads. Full policy: [`docs/privacy.html`](docs/privacy.html).

> This product uses the TMDB API but is not endorsed or certified by TMDB.
