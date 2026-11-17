import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// package.json's version is the single source of truth for the app version.
// It is inlined here for the web layer (src/lib/updates/appVersion.ts) and
// read again by android/app/build.gradle for versionName, so the two cannot
// drift apart.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    // The one chunk over Vite's default 500 kB is Transformers.js (mood
    // search), which is only ever fetched by a dynamic import when the
    // on-device model is first used - never at startup. The limit sits just
    // above it so a real regression in the startup chunks still warns.
    chunkSizeWarningLimit: 560,
  },
  server: {
    watch: {
      // Build output, never source. `npm run cap:sync` rewrites
      // android/app/src/main/assets/public with a copy of dist, and watching
      // it made the dev server reload the page mid-copy and then crash with
      // EBUSY on a file Gradle or the copy still had open (Windows locks
      // files that are being written).
      ignored: ['**/android/**', '**/dist/**'],
    },
  },
})
