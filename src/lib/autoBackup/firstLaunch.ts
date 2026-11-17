// Bringing the library back after a reinstall.
//
// Android restores the snapshot files (snapshot.ts) when the app is
// installed again, before it first runs. The WebView's database starts out
// empty, so on that first launch this loads the snapshot into it - before
// the app renders, so the user never sees an empty Home or the setup screens
// for a library that is about to appear.
//
// The same path recovers from Android clearing the WebView's storage under
// pressure, which empties the database and localStorage together while
// leaving the app's own files alone.

import { db } from "../../db";
import { parseBackupText, restoreBackup, tableCounts } from "../backup";
import { autoBackupSupported, readSnapshotFiles } from ".";
import { hasLibraryData, parseKeysFile, shouldAutoRestore } from "./snapshot";

/** Set once the check has run on this install. See shouldAutoRestore() for why it lives in localStorage. */
const CHECKED_KEY = "auto_restore_checked";

export type FirstLaunchRestore =
  | { status: "restored"; shows: number; movies: number; keysRestored: boolean }
  | { status: "failed"; message: string };

/**
 * Restores the snapshot into an empty library, once per install.
 *
 * @param onRestoring called when a restore is about to start, so the caller
 *   can show that something is happening.
 * @returns what happened, or null when nothing needed doing.
 */
export async function restoreOnFirstLaunch(onRestoring: () => void): Promise<FirstLaunchRestore | null> {
  if (!autoBackupSupported()) return null;
  if (localStorage.getItem(CHECKED_KEY) === "true") return null;

  // Marked whatever happens next. A snapshot that cannot be restored would
  // otherwise fail again on every launch; it stays listed in Settings for a
  // manual attempt.
  const markChecked = () => localStorage.setItem(CHECKED_KEY, "true");

  try {
    const [shows, movies, watchedEpisodes] = await Promise.all([
      db.shows.count(),
      db.movies.count(),
      db.watchedEpisodes.count(),
    ]);
    const libraryEmpty = !hasLibraryData({ shows, movies, watchedEpisodes });
    const files = libraryEmpty ? await readSnapshotFiles() : { snapshot: null, keys: null };

    if (!shouldAutoRestore({ libraryEmpty, checkedBefore: false, snapshotFound: files.snapshot !== null })) {
      markChecked();
      return null;
    }

    const { backup } = parseBackupText(files.snapshot!);
    const keys = files.keys ? parseKeysFile(files.keys) : null;
    if (keys) backup.apiKeys = keys;

    onRestoring();
    // Merge into an empty database is the same as replace, without the
    // clear: anything written in the moments since launch is kept.
    const result = await restoreBackup(backup, "merge");
    markChecked();
    const counts = tableCounts(backup);
    return {
      status: "restored",
      shows: counts.shows,
      movies: counts.movies,
      keysRestored: result.keys.tmdb === "restored",
    };
  } catch (error) {
    markChecked();
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
