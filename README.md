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
- [Mood search (on-device)](#mood-search-on-device)
- [Importing from TV Time](#importing-from-tv-time)
- [Backup & restore](#backup--restore)
- [Building the Android app](#building-the-android-app)
- [Hosting the privacy policy (GitHub Pages)](#hosting-the-privacy-policy-github-pages)
- [Publishing to Google Play](#publishing-to-google-play)
- [Project structure](#project-structure)
- [Privacy](#privacy)

---

## Features

- **Mood search**: describe what you feel like watching in plain English ("something slow burn and unsettling, not found footage, under 90 minutes"). Filters your library on Home, and recommends unwatched titles on Discover. Runs entirely on your device; see [Mood search](#mood-search-on-device).
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

## Mood search (on-device)

There are two mood-driven features, in different places, answering different
questions. Both run the same model on your device, and neither ever sends
your query or your library anywhere.

| | Where | What it searches | Answers |
|---|---|---|---|
| **Mood filter** | Home | Titles already in your library | "What should I watch tonight from what I already track?" |
| **Mood discovery** | Discover | TMDB's catalogue plus unwatched library titles | "Find me something new I haven't seen." |

### Mood filter (Home)

The search box on Home takes a plain-English description of what you're in
the mood for and filters Watch Next and your movie watchlist by it. Every
title in your library already has a cached vector, so this is fast: one
embedding for the query, then arithmetic.

### Mood discovery (Discover)

The box at the top of the Discover tab recommends titles you have **not**
watched, including ones that are not in your library at all. Results are a
single ranked list mixing both, with an "In your library" badge on ones you
already own.

Because there is no local copy of TMDB's catalogue, this cannot work the same
way. It uses retrieve-then-rerank:

1. **Retrieve.** TMDB has no semantic search, so the query is converted into
   filters TMDB does understand. Vocabulary tags resolve to TMDB **keyword**
   IDs (which express things genres cannot, like "found footage") and genre
   IDs; parsed runtime bounds become `with_runtime`, enforced by the API
   rather than by discarding results afterwards. Keyword and genre retrieval
   are issued as separate calls and merged, because TMDB ANDs different
   filter types and combining them returns almost nothing.
2. **Re-rank.** The candidates' TMDB summaries are embedded on device and
   ranked against your query, using the same cache as the library index. A
   title discovered today and added tomorrow already has a warm vector.
3. **Exclude.** Anything watched is dropped (for shows, "watched" means any
   logged episode), then unwatched library titles are folded in.

The honest limit of this design: **the model can only reorder what retrieval
returned.** A perfect match that TMDB files under a genre and keyword set your
query never touched is never fetched, and so can never appear. Result quality
is capped by retrieval, not by the model. The UI shows how many candidates
were searched and which keywords were used, so this is visible rather than
mysterious.

Discovery needs your TMDB key. If TMDB can't be reached, it says so plainly
and falls back to ranking only your own unwatched library, rather than
showing a plausible-looking list that quietly stopped recommending anything
new.

### Why an embedding model and not a generative one

This is the part worth explaining, because "use an LLM" is the obvious answer
and it is the wrong one here.

A generative model that could read a query and pick titles needs WebGPU to
run at a tolerable speed in a WebView. WebGPU support across the Android
range this app targets (API 24 through API 36) is inconsistent: it is absent
on older WebViews and unreliable on several that nominally report it. A
generative path would therefore work well on new flagship devices and either
crawl or fail outright on a large share of the rest, which for a feature
positioned as a headline capability is worse than not shipping it.

A small sentence-embedding model has a different performance profile. It runs
once per short piece of text, produces a 384-number vector, and needs no
token-by-token generation, so it is fast enough on the WASM CPU fallback path
that exists everywhere. That makes it the choice that works across the whole
device range rather than the choice that is most capable in the best case.

The tradeoff is real and worth stating plainly: an embedding model matches on
overall semantic similarity. It does not reason. It cannot handle a genuinely
compositional request, and it has no reliable notion of negation, which is why
negation is parsed deterministically with regex before the model sees the text
(see `src/lib/moodSearch/constraints.ts`) rather than being left to the model.

A WebGPU-accelerated generative path is a plausible future addition for
devices that support it, as an upgrade layered on top of this, not a
replacement for it.

### How it works

1. **Deterministic parse first.** Runtime bounds ("under 90 minutes", "one and
   a half hours or less") and negations ("not found footage", "no jump scares")
   are extracted with plain string parsing. Those spans are then stripped from
   the query, so the model only ever embeds what you want *included*, never
   the thing you asked to avoid.
2. **Embed the query** with `all-MiniLM-L6-v2`, int8-quantised (roughly 25MB),
   via Transformers.js.
3. **Match vocabulary tags** against a fixed mood vocabulary whose embeddings
   are precomputed at build time and committed as a static asset. These are
   what the UI shows you as chips, so a result set is explainable rather than
   a black box.
4. **Rank your titles** by cosine similarity between the query and each
   title's stored TMDB summary.
5. **Apply negations** by embedding each negated phrase and excluding titles
   too close to it.

### First run

The model downloads once (roughly 25MB) from the Hugging Face Hub and is
cached by the browser, so it is not re-fetched on later sessions. Your
library is then indexed once: WatchTime fetches each title's TMDB summary and
embeds it locally, caching the vectors in IndexedDB. Both passes are
resumable and both show progress without blocking the UI. You can dismiss the
indicator at any point and use plain title search instead.

If the model cannot be downloaded or run at all (offline, storage full,
unsupported WebView) the search box quietly falls back to plain title
matching, keeps applying the runtime and negation parsing, and says so. The
rest of the app is unaffected.

### Regenerating the vocabulary

Re-run this after editing `MOOD_VOCABULARY` or `EMBEDDING_MODEL_ID` in
`src/lib/moodSearch/vocabulary.ts`:

```bash
npm run build:mood-vocabulary
```

The app validates at runtime that the committed vocabulary file was built
with the same model it embeds queries with, and refuses to use it otherwise,
since mismatched vectors would produce meaningless similarity scores that
nothing downstream could detect.

### Notes and limitations

- **APK size.** The ONNX Runtime WASM binary is bundled with the app (roughly
  23MB uncompressed, considerably less over the wire after Play's
  compression). It is bundled rather than fetched from a CDN so that the only
  thing needing a download is the model itself.
- **Privacy.** Your query and your library are never transmitted. The one
  outbound request the feature makes is fetching the model file from the
  Hugging Face Hub, and it carries no data about you. Nothing is sent on any
  later run.
- **Quality.** A 25MB embedding model is a genuinely small model. It is good
  at broad tone ("scary", "funny", "a real disaster") and weaker at narrow
  sub-genre distinctions. Ranking is relative to the best match for your
  query rather than an absolute cutoff, so a small library will return some
  loose matches near the bottom of the list.
- **Dev-only dependency warning.** `npm audit` reports advisories against
  `onnxruntime-node` and `sharp`. Those are Node-side optional dependencies
  of Transformers.js used only by the build script; the app ships the WASM
  build and does not include them.

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
    watchNext.ts            Home's three-way categorisation (+ optional mood filter)
    moodSearch/
      constraints.ts        Deterministic runtime/negation parsing (no model)
      vocabulary.ts         Mood tag list + calibrated thresholds
      embedder.ts           Lazy Transformers.js pipeline, WASM, shape validation
      titleIndex.ts         Overview backfill + cached per-title embeddings
      search.ts             Query -> filter object; filter application (Home)
      discover.ts           TMDB retrieve-then-rerank recommendations (Discover)
      useMoodSearch.ts      React state for setup/progress/results
    backup.ts               Full export/validate/restore (native + web)
    persistence.ts          Storage-persistence request + backup nudge
    useDraggableSheet.ts    Mobile bottom-sheet drag (capped at 75%)
    native.ts / useOnline.ts / backHandler.ts   Capacitor behaviors
  components/
    MoodSearch.tsx          Home: natural-language library filter
    MoodDiscover.tsx        Discover: natural-language recommendations
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
to TMDB, OMDb, and TVmaze, using your own keys, plus a one-time model
download from the Hugging Face Hub if you use [mood search](#mood-search-on-device)
(that request sends nothing about you). No accounts, no analytics,
no ads. Full policy: [`docs/privacy.html`](docs/privacy.html).

> This product uses the TMDB API but is not endorsed or certified by TMDB.
