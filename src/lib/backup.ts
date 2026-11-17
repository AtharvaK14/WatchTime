import {
  db,
  type Show,
  type Episode,
  type WatchedEpisode,
  type Movie,
  type TitleMatch,
  type Setting,
} from "../db";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { TMDB_API_KEY_STORAGE } from "../tmdb";
import { OMDB_API_KEY_STORAGE } from "../omdb";
import { recordBackupCompleted, API_KEYS_CHANGED_EVENT } from "./persistence";

// The marker and format version are frozen forever, independent of whatever
// the app's display name ends up being. They deliberately match the equally
// frozen IndexedDB database name ("tv-tracker") rather than a brand name.
const BACKUP_APP_MARKER = "tv-tracker-backup";
export const BACKUP_FORMAT_VERSION = 1;

export const BACKUP_TABLE_NAMES = [
  "shows",
  "episodes",
  "watchedEpisodes",
  "movies",
  "titleMatches",
  "settings",
] as const;
export type BackupTableName = (typeof BACKUP_TABLE_NAMES)[number];

export interface BackupTables {
  shows: Show[];
  episodes: Episode[];
  watchedEpisodes: WatchedEpisode[];
  movies: Movie[];
  titleMatches: TitleMatch[];
  settings: Setting[];
}

export interface BackupFile {
  app: string;
  formatVersion: number;
  exportedAt: string; // ISO timestamp
  dbVersion: number; // Dexie schema version (db.verno) at export time
  // null = that key wasn't set when this backup was made. Restore treats
  // null as "nothing to restore", never as "delete the current key".
  apiKeys: { tmdb: string | null; omdb: string | null };
  tables: BackupTables;
}

export function tableCounts(backup: BackupFile): Record<BackupTableName, number> {
  return {
    shows: backup.tables.shows.length,
    episodes: backup.tables.episodes.length,
    watchedEpisodes: backup.tables.watchedEpisodes.length,
    movies: backup.tables.movies.length,
    titleMatches: backup.tables.titleMatches.length,
    settings: backup.tables.settings.length,
  };
}

/**
 * Serializes the entire database plus the localStorage API keys. All six
 * table reads run in a single read transaction so the snapshot is
 * consistent even if something writes concurrently (e.g. a backfill).
 * The episodes cache is included on purpose: it's re-fetchable from TMDB,
 * but including it makes a restore complete and instant while offline.
 */
export async function buildBackup(): Promise<BackupFile> {
  const [shows, episodes, watchedEpisodes, movies, titleMatches, settings] = await db.transaction(
    "r",
    db.tables,
    () =>
      Promise.all([
        db.shows.toArray(),
        db.episodes.toArray(),
        db.watchedEpisodes.toArray(),
        db.movies.toArray(),
        db.titleMatches.toArray(),
        db.settings.toArray(),
      ])
  );

  return {
    app: BACKUP_APP_MARKER,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    dbVersion: db.verno,
    apiKeys: {
      tmdb: localStorage.getItem(TMDB_API_KEY_STORAGE),
      omdb: localStorage.getItem(OMDB_API_KEY_STORAGE),
    },
    tables: { shows, episodes, watchedEpisodes, movies, titleMatches, settings },
  };
}

/**
 * The same backup with the API keys removed, for any copy that leaves the
 * device without the user choosing where it goes.
 *
 * The keys are null rather than absent, which is exactly what a backup made
 * on an install with no keys looks like - so validateBackup and
 * restoreBackup need no special case, and restore's "null never deletes a
 * current key" rule applies unchanged.
 */
export function withoutApiKeys(backup: BackupFile): BackupFile {
  return { ...backup, apiKeys: { tmdb: null, omdb: null } };
}

/** Includes the time, not just the date, so multiple same-day exports don't collide in Downloads. */
export function backupFilename(exportedAt: string): string {
  const date = exportedAt.slice(0, 10);
  const hhmm = exportedAt.slice(11, 16).replace(":", "");
  return `tv-tracker-backup-${date}-${hhmm}.json`;
}

export interface ExportResult {
  counts: Record<BackupTableName, number>;
  filename: string;
  exportedAt: string;
}

/** Raised when the user dismisses the native share sheet — a cancel, not a failure. */
export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled — no file was saved.");
    this.name = "ExportCancelledError";
  }
}

/**
 * Desktop/web: Blob + <a download>. Android WebView can't download blob:
 * URLs, so on a native platform we write the JSON to a file and hand it to
 * the system share sheet (Save to Files / Drive / send anywhere).
 */
export async function exportAndDownloadBackup(): Promise<ExportResult> {
  const backup = await buildBackup();
  // Compact JSON on purpose: a large library is multiple MB, and pretty-
  // printing roughly doubles it for no reader benefit.
  const json = JSON.stringify(backup);
  const filename = backupFilename(backup.exportedAt);

  if (Capacitor.isNativePlatform()) {
    // Stage the file in the app's cache, then let the OS share sheet move
    // it wherever the user wants. Cache needs no storage permission; the
    // share target handles the real destination.
    const { uri } = await Filesystem.writeFile({
      path: filename,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await Share.share({
        title: "WatchTime backup",
        text: filename,
        url: uri,
        dialogTitle: "Save or share your WatchTime backup",
      });
    } catch {
      // The plugin rejects when the user dismisses the sheet without
      // picking a target. Nothing was saved, so don't count it as a backup.
      throw new ExportCancelledError();
    }
  } else {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); // Firefox needs the anchor in the DOM
    a.click();
    a.remove();
    // Revoking immediately can abort an in-flight download in some browsers;
    // a delayed revoke is the standard safe pattern.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  recordBackupCompleted(backup.exportedAt);
  return { counts: tableCounts(backup), filename, exportedAt: backup.exportedAt };
}

// ---- Validation ---------------------------------------------------------------

export interface ValidatedBackup {
  backup: BackupFile;
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Spot-checks the first row of a table for its primary key with the right
// type. Deliberately shallow: full row-by-row validation of thousands of
// rows buys little once the marker, version, and key fields check out, and
// bulkPut would surface truly malformed rows anyway.
function firstRowLooksValid(name: BackupTableName, rows: unknown[]): boolean {
  if (rows.length === 0) return true;
  const row = rows[0];
  if (!isPlainObject(row)) return false;
  switch (name) {
    case "shows":
    case "movies":
      return typeof row.tmdbId === "number";
    case "episodes":
    case "watchedEpisodes":
      return typeof row.key === "string";
    case "titleMatches":
      return typeof row.rawTitle === "string";
    case "settings":
      return typeof row.key === "string";
  }
}

/**
 * Structural validation with specific, actionable errors (throws), plus
 * non-fatal warnings (returned). Callers should JSON.parse first and map
 * SyntaxError to their own "not valid JSON" message.
 */
export function validateBackup(raw: unknown): ValidatedBackup {
  if (!isPlainObject(raw)) {
    throw new Error("Not a backup file: expected a JSON object at the top level.");
  }
  if (raw.app !== BACKUP_APP_MARKER) {
    throw new Error("This isn't a backup file from this app (its identifying marker is missing or different).");
  }
  if (typeof raw.formatVersion !== "number" || raw.formatVersion < 1) {
    throw new Error("This backup file has a missing or invalid format version.");
  }
  if (raw.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup uses format v${raw.formatVersion}, but this app only understands up to v${BACKUP_FORMAT_VERSION}. ` +
        "Update the app first, then restore."
    );
  }
  if (typeof raw.exportedAt !== "string" || !raw.exportedAt) {
    throw new Error("This backup file is missing its export timestamp.");
  }
  if (!isPlainObject(raw.tables)) {
    throw new Error('This backup file is missing its "tables" section.');
  }
  for (const name of BACKUP_TABLE_NAMES) {
    const rows = raw.tables[name];
    if (!Array.isArray(rows)) {
      throw new Error(`Backup is missing the "${name}" table (or it isn't a list).`);
    }
    if (!firstRowLooksValid(name, rows)) {
      throw new Error(`The "${name}" table in this backup contains rows that don't match the expected shape.`);
    }
  }

  const warnings: string[] = [];
  if (typeof raw.dbVersion === "number" && raw.dbVersion > db.verno) {
    warnings.push(
      `This backup was made by a newer version of the app (database v${raw.dbVersion}, this app has v${db.verno}). ` +
        "Restoring should still work, unknown fields are kept as-is, but updating the app first is safer."
    );
  }

  // Normalize apiKeys defensively (a hand-edited file might drop it).
  const apiKeys = isPlainObject(raw.apiKeys)
    ? {
        tmdb: typeof raw.apiKeys.tmdb === "string" ? raw.apiKeys.tmdb : null,
        omdb: typeof raw.apiKeys.omdb === "string" ? raw.apiKeys.omdb : null,
      }
    : { tmdb: null, omdb: null };

  // Table contents were validated shallowly above (documented tradeoff),
  // so this cast is the trust boundary, not a hidden assumption.
  const backup: BackupFile = {
    app: BACKUP_APP_MARKER,
    formatVersion: raw.formatVersion,
    exportedAt: raw.exportedAt,
    dbVersion: typeof raw.dbVersion === "number" ? raw.dbVersion : 0,
    apiKeys,
    tables: raw.tables as unknown as BackupTables,
  };
  return { backup, warnings };
}

/** Parses and validates the text of a backup file. Throws with a message fit to show the user. */
export function parseBackupText(text: string): ValidatedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON. Choose a backup file exported by this app.");
  }
  return validateBackup(raw);
}

// ---- Restore --------------------------------------------------------------------

export type RestoreMode = "replace" | "merge";

export type KeyRestoreOutcome = "restored" | "kept-existing" | "absent";

export interface RestoreResult {
  counts: Record<BackupTableName, number>;
  keys: { tmdb: KeyRestoreOutcome; omdb: KeyRestoreOutcome };
}

// Never delete a currently working key just because the backup predates it:
// null/absent in the file means "no key was set when this was exported",
// not "remove the key". Merge additionally refuses to overwrite an existing
// key, since the local one may be newer than the backup's.
function applyRestoredKey(storageKey: string, value: string | null, mode: RestoreMode): KeyRestoreOutcome {
  if (!value) return "absent";
  if (mode === "merge" && localStorage.getItem(storageKey)) return "kept-existing";
  localStorage.setItem(storageKey, value);
  return "restored";
}

/**
 * Repopulates the database (and API keys) from a validated backup.
 *
 * replace: clears every table first, then loads the file exactly.
 * merge: bulkPut only, which is insert-or-overwrite by primary key, the
 * same last-write-wins semantics the importers already use.
 *
 * Rows exported under an older schema simply lack newer optional fields;
 * the existing `== null` backfills (stats.ts) self-heal those after
 * restore, so no per-version migration of backup files is needed.
 */
export async function restoreBackup(backup: BackupFile, mode: RestoreMode): Promise<RestoreResult> {
  const t = backup.tables;
  await db.transaction("rw", db.tables, async () => {
    if (mode === "replace") {
      await Promise.all([
        db.shows.clear(),
        db.episodes.clear(),
        db.watchedEpisodes.clear(),
        db.movies.clear(),
        db.titleMatches.clear(),
        db.settings.clear(),
      ]);
    }
    await db.shows.bulkPut(t.shows);
    await db.episodes.bulkPut(t.episodes);
    await db.watchedEpisodes.bulkPut(t.watchedEpisodes);
    await db.movies.bulkPut(t.movies);
    await db.titleMatches.bulkPut(t.titleMatches);
    await db.settings.bulkPut(t.settings);
  });

  const keys = {
    tmdb: applyRestoredKey(TMDB_API_KEY_STORAGE, backup.apiKeys.tmdb, mode),
    omdb: applyRestoredKey(OMDB_API_KEY_STORAGE, backup.apiKeys.omdb, mode),
  };
  window.dispatchEvent(new Event(API_KEYS_CHANGED_EVENT));

  // The file this data just came from is itself a valid backup of the
  // now-current state.
  recordBackupCompleted(backup.exportedAt);

  return { counts: tableCounts(backup), keys };
}
