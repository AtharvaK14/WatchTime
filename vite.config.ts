import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
