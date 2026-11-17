// The copy of the library Android's own backup carries, and the decisions
// around it. Platform-free, so scripts/check-backup.ts can run it.
//
// Two files, both in the app's internal files directory (getFilesDir()):
//
//   backup/watchtime-snapshot.json  the library, without API keys
//   backup/watchtime-keys.json      the TMDB and OMDb keys, written only
//                                   while Android can encrypt the backup
//                                   end to end (see index.ts)
//
// They are the only two files the backup rules let leave the device
// (res/xml*/backup_rules.xml, res/xml/data_extraction_rules.xml - keep the
// names in step). Android restores them when the app is installed again, and
// restoreOnFirstLaunch() in firstLaunch.ts loads them into the empty database.

import { BACKUP_APP_MARKER_FOR_KEYS, withoutApiKeys, type BackupFile } from "../backup";

export const SNAPSHOT_DIR = "backup";
export const SNAPSHOT_FILE = "watchtime-snapshot.json";
export const KEYS_FILE = "watchtime-keys.json";

/**
 * Android stops backing up the app entirely above 25 MB. The snapshot is
 * kept under 20 MB so the keys file and any rounding never tip it over.
 */
export const SNAPSHOT_BUDGET_BYTES = 20 * 1024 * 1024;

export interface PreparedSnapshot {
  /** The snapshot file's text. */
  data: string;
  /** Its size in bytes as written (UTF-8). */
  bytes: number;
  /** True when the episode cache was left out to fit the budget. */
  droppedEpisodeCache: boolean;
  /** True when even without the cache it is over budget: Android will not back it up. */
  overBudget: boolean;
  /** The keys file's text, or null when neither key is set. */
  keys: string | null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Builds the snapshot from a backup.
 *
 * The episode cache is the one part that can be dropped: it is metadata
 * fetched from TMDB, and Home's episode sync fetches it again after a
 * restore. Everything the user created - shows, movies, watch history,
 * import matches, settings - is always kept.
 */
export function prepareSnapshot(backup: BackupFile, budget: number = SNAPSHOT_BUDGET_BYTES): PreparedSnapshot {
  const keyless = withoutApiKeys(backup);
  let data = JSON.stringify(keyless);
  let bytes = byteLength(data);
  let droppedEpisodeCache = false;
  if (bytes > budget && keyless.tables.episodes.length > 0) {
    data = JSON.stringify({ ...keyless, tables: { ...keyless.tables, episodes: [] } });
    bytes = byteLength(data);
    droppedEpisodeCache = true;
  }
  const { tmdb, omdb } = backup.apiKeys;
  const keys = tmdb || omdb ? JSON.stringify({ app: BACKUP_APP_MARKER_FOR_KEYS, tmdb, omdb }) : null;
  return { data, bytes, droppedEpisodeCache, overBudget: bytes > budget, keys };
}

/** Reads the keys file. Null if it is not one, or holds no key. */
export function parseKeysFile(text: string): { tmdb: string | null; omdb: string | null } | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const { app, tmdb, omdb } = raw as Record<string, unknown>;
    if (app !== BACKUP_APP_MARKER_FOR_KEYS) return null;
    const keys = {
      tmdb: typeof tmdb === "string" && tmdb ? tmdb : null,
      omdb: typeof omdb === "string" && omdb ? omdb : null,
    };
    return keys.tmdb || keys.omdb ? keys : null;
  } catch {
    return null;
  }
}

/** Whether the library holds anything the user made. The episode cache alone does not count. */
export function hasLibraryData(counts: { shows: number; movies: number; watchedEpisodes: number }): boolean {
  return counts.shows > 0 || counts.movies > 0 || counts.watchedEpisodes > 0;
}

/**
 * Whether to load the snapshot into the database at launch.
 *
 * Only into an empty library, so nothing is ever overwritten. And only when
 * this install has never run the check: `checkedBefore` lives in
 * localStorage, which a fresh install or Android clearing the WebView's
 * storage wipes along with the database - exactly the two cases this is for.
 * Settings' "Reset Data" empties the library but leaves it set, so a reset
 * is not undone by the next launch.
 */
export function shouldAutoRestore(input: {
  libraryEmpty: boolean;
  checkedBefore: boolean;
  snapshotFound: boolean;
}): boolean {
  return input.libraryEmpty && !input.checkedBefore && input.snapshotFound;
}
