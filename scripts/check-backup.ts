/**
 * Scenario check for automatic backups, run with `npm run check:backup`.
 *
 * Covers what can be exercised without a device: which files retention
 * deletes, when a scheduled run is due, that a failed write never costs an
 * existing backup, that the keyless copy really has no keys, and a full
 * export -> validate -> restore round trip against a real (in-memory)
 * IndexedDB, using the app's own buildBackup / validateBackup /
 * restoreBackup.
 *
 * It also covers the snapshot Android's own backup carries: no keys in it, the
 * keys file beside it, the size budget, when the launch-time restore runs,
 * and restoring from those files into a fresh install.
 *
 * What it cannot show: the Capacitor filesystem calls, Android's Auto Backup
 * taking the files and restoring them on reinstall, or the scheduler's app-state triggers. Those
 * need a device; docs/backup-and-updates.md lists them.
 */

import "fake-indexeddb/auto";
import "./lib/browser-shims";
import { db, type Episode, type Movie, type Show, type TitleMatch, type WatchedEpisode } from "../src/db";
import { backupFilename, buildBackup, parseBackupText, restoreBackup, withoutApiKeys } from "../src/lib/backup";
import { TMDB_API_KEY_STORAGE } from "../src/tmdb";
import { OMDB_API_KEY_STORAGE } from "../src/omdb";
import {
  EMPTY_TARGET_STATE,
  nextTargetState,
  writeTarget,
  type BackupStore,
  type BackupTarget,
  type TargetState,
} from "../src/lib/autoBackup/pipeline";
import {
  BACKUP_RETENTION,
  backupsToPrune,
  backupTimeFromFilename,
  isBackupFilename,
  newestFirst,
} from "../src/lib/autoBackup/retention";
import { isBackupDue, parseCadence, RETRY_AFTER_FAILURE_MS } from "../src/lib/autoBackup/schedule";
import {
  hasLibraryData,
  parseKeysFile,
  prepareSnapshot,
  shouldAutoRestore,
  SNAPSHOT_BUDGET_BYTES,
} from "../src/lib/autoBackup/snapshot";

let checks = 0;
const failures: string[] = [];
function expect(label: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(`${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

// ---- Retention -----------------------------------------------------------------

/** A backup name for day `d` of November 2026, 09:00 UTC. */
const day = (d: number) => `tv-tracker-backup-2026-11-${String(d).padStart(2, "0")}-0900.json`;

console.log("Retention");
{
  const nine = [5, 1, 9, 3, 7, 2, 8, 4, 6].map(day);
  expect("Keeps the newest 7 of 9, whatever order the folder lists them in", backupsToPrune(nine).sort(), [day(1), day(2)]);
  expect("Deletes nothing at or under the limit", backupsToPrune([1, 2, 3, 4, 5, 6, 7].map(day)), []);
  expect(
    "Never offers a file that is not a backup, or a temporary file",
    backupsToPrune([...nine, "notes.txt", `${day(10)}.tmp`, "tv-tracker-backup-old.json"]).sort(),
    [day(1), day(2)]
  );
  expect("A limit of 0 still keeps one", backupsToPrune([day(1), day(2)], 0), [day(1)]);
  expect("Newest first", newestFirst([day(2), "x.json", day(11), day(4)]), [day(11), day(4), day(2)]);
  expect("The app's own export name is recognised", isBackupFilename(backupFilename("2026-11-17T08:05:59.123Z")), true);
  expect(
    "The time in a name is read as UTC",
    backupTimeFromFilename("tv-tracker-backup-2026-11-17-0805.json")?.toISOString(),
    "2026-11-17T08:05:00.000Z"
  );
  expect("The retention limit is 7", BACKUP_RETENTION, 7);
}

// ---- Schedule --------------------------------------------------------------------

console.log("Schedule");
{
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const ago = (hours: number) => new Date(now - hours * 3600_000).toISOString();
  expect("Never backed up: due", isBackupDue("daily", null, null, now), true);
  expect("Daily, 23h since the last: not due", isBackupDue("daily", ago(23), ago(23), now), false);
  expect("Daily, 25h since the last: due", isBackupDue("daily", ago(25), ago(25), now), true);
  expect("Weekly, 6 days since the last: not due", isBackupDue("weekly", ago(6 * 24), ago(6 * 24), now), false);
  expect("Weekly, 8 days since the last: due", isBackupDue("weekly", ago(8 * 24), ago(8 * 24), now), true);
  expect("Off: never due", isBackupDue("off", null, null, now), false);
  expect("Overdue, but a run failed 10 minutes ago: wait", isBackupDue("daily", ago(72), ago(10 / 60), now), false);
  expect("Overdue, and the failed run was 2 hours ago: retry", isBackupDue("daily", ago(72), ago(2), now), true);
  expect("The retry gap is an hour", RETRY_AFTER_FAILURE_MS, 3600_000);
  expect(
    "A last-backup time in the future (clock set back) does not switch backups off",
    isBackupDue("daily", new Date(now + 86_400_000 * 30).toISOString(), null, now),
    true
  );
  expect("An unreadable timestamp counts as never", isBackupDue("daily", "garbage", null, now), true);
  expect("An unknown stored cadence falls back to daily", parseCadence("hourly"), "daily");
  expect("No stored cadence is daily", parseCadence(null), "daily");
}

// ---- Writing to a destination ------------------------------------------------------

type Fault = "write" | "corrupt" | "rename" | "rename-over-existing";

/** A folder in memory, with the failure modes of a real one. */
class MemoryStore implements BackupStore {
  files = new Map<string, string>();
  fault: Fault | null = null;
  async list() {
    return [...this.files.keys()];
  }
  async write(name: string, data: string) {
    if (this.fault === "write") {
      // A write that dies partway leaves a truncated file behind.
      this.files.set(name, data.slice(0, 3));
      throw new Error("ENOSPC: no space left on device");
    }
    this.files.set(name, this.fault === "corrupt" ? data.slice(0, -1) : data);
  }
  async read(name: string) {
    const data = this.files.get(name);
    if (data === undefined) throw new Error("File does not exist");
    return data;
  }
  async rename(from: string, to: string) {
    if (this.fault === "rename") throw new Error("rename failed");
    // The filesystem that refuses to rename onto an existing file.
    if (this.fault === "rename-over-existing" && this.files.has(to)) throw new Error("destination exists");
    const data = this.files.get(from);
    if (data === undefined) throw new Error("File does not exist");
    this.files.delete(from);
    this.files.set(to, data);
  }
  async remove(name: string) {
    if (!this.files.delete(name)) throw new Error("File does not exist");
  }
  names() {
    return [...this.files.keys()].sort();
  }
}

function dated(store: BackupStore, d: number, data = `library as of day ${d}`): BackupTarget {
  return { id: "local", store, filename: day(d), data, fingerprint: `fp:${data}`, keep: BACKUP_RETENTION };
}

console.log("Writing a backup");
{
  const store = new MemoryStore();
  let state: TargetState = EMPTY_TARGET_STATE;
  const run = async (target: BackupTarget) => {
    const outcome = await writeTarget(target, state);
    state = nextTargetState(state, outcome, target.fingerprint, "2026-11-17T09:00:00.000Z");
    return outcome;
  };

  expect("First backup is written", await run(dated(store, 1)), { id: "local", status: "written", file: day(1) });
  expect("...under its final name, with no temporary file left", store.names(), [day(1)]);
  expect("...holding exactly the data", store.files.get(day(1)), "library as of day 1");

  for (let d = 2; d <= 7; d++) await run(dated(store, d));
  expect("Seven backups: all kept", store.names().length, 7);
  await run(dated(store, 8));
  expect("The eighth removes only the oldest", store.names(), [2, 3, 4, 5, 6, 7, 8].map(day));

  store.files.set("my-notes.txt", "not a backup");
  await run(dated(store, 9));
  expect("A foreign file in the folder is left alone", store.files.has("my-notes.txt"), true);
  expect("...and retention still holds at 7 backups", store.names().filter(isBackupFilename).length, 7);
  store.files.delete("my-notes.txt");

  const before = store.names();
  const okState = state;

  store.fault = "write";
  const failedWrite = await run(dated(store, 10));
  expect("A write that fails is reported, in plain words", failedWrite, {
    id: "local",
    status: "failed",
    error: "This device is out of storage space.",
  });
  expect("...and leaves every existing backup, and no partial file", store.names(), before);
  expect(
    "...the last success is still remembered",
    [state.lastSuccessAt, state.lastFile],
    [okState.lastSuccessAt, okState.lastFile]
  );
  expect("...alongside the error", state.lastError, "This device is out of storage space.");

  store.fault = "corrupt";
  const corrupt = await run(dated(store, 10));
  expect("A file that does not read back as written is discarded", corrupt.status, "failed");
  expect("...again without touching existing backups", store.names(), before);

  store.fault = "rename";
  expect("A rename that fails is reported", (await run(dated(store, 10))).status, "failed");
  expect("...and nothing was pruned for a backup that never landed", store.names(), before);

  store.fault = null;
  expect("The next run succeeds", (await run(dated(store, 10))).status, "written");
  expect("...and clears the error", state.lastError, null);
  expect("...pruning only now", store.names(), [4, 5, 6, 7, 8, 9, 10].map(day));

  const sameAsDay10 = { ...dated(store, 11), data: "library as of day 10", fingerprint: "fp:library as of day 10" };
  expect("Unchanged content writes no new file", await run(sameAsDay10), { id: "local", status: "unchanged", file: day(10) });
  expect("...so older backups are not rotated out by copies", store.names(), [4, 5, 6, 7, 8, 9, 10].map(day));

  store.files.delete(day(10));
  expect("Unchanged content is written again if its file has gone", (await run(sameAsDay10)).status, "written");

  store.files.set(`${day(3)}.tmp`, "left by an interrupted run");
  await run(dated(store, 12));
  expect(
    "A stale temporary file is cleaned up by the next good run",
    store.names().some((n) => n.endsWith(".tmp")),
    false
  );
}

console.log("The single-file copy");
{
  const store = new MemoryStore();
  const single = (data: string): BackupTarget => ({
    id: "system",
    store,
    filename: "watchtime-latest.json",
    data,
    fingerprint: `fp:${data}`,
    keep: null,
  });
  await writeTarget(single("v1"), EMPTY_TARGET_STATE);
  await writeTarget(single("v2"), EMPTY_TARGET_STATE);
  expect("Is replaced, not accumulated", store.names(), ["watchtime-latest.json"]);
  expect("...with the newer content", store.files.get("watchtime-latest.json"), "v2");

  store.fault = "rename-over-existing";
  const replaced = await writeTarget(single("v3"), EMPTY_TARGET_STATE);
  expect("Still replaced where rename will not overwrite", replaced.status, "written");
  expect(
    "...with the newer content, and nothing else left behind",
    [store.names(), store.files.get("watchtime-latest.json")],
    [["watchtime-latest.json"], "v3"]
  );

  store.fault = "write";
  await writeTarget(single("v4"), EMPTY_TARGET_STATE);
  expect("A failed replacement keeps the previous copy", store.files.get("watchtime-latest.json"), "v3");
}

// ---- API keys and the round trip -----------------------------------------------------

const TMDB_KEY = "tmdb-secret-0123456789abcdef";
const OMDB_KEY = "omdb-secret-fedcba98";

// Only the fields the tables index, plus enough to tell rows apart: the
// backup code copies rows whole and never looks inside them.
const shows = [
  { tmdbId: 1, name: "Show One" },
  { tmdbId: 2, name: "Show Two" },
] as Show[];
const episodes = [{ key: "1-1-1", showId: 1, seasonNumber: 1, episodeNumber: 1, name: "Pilot" }] as Episode[];
const watched = [{ key: "1-1-1", showId: 1, watchedAt: "2026-11-01T20:00:00.000Z" }] as WatchedEpisode[];
const movies = [{ tmdbId: 10, title: "Movie Ten" }] as Movie[];
const matches = [{ rawTitle: "show one", tmdbId: 1 }] as TitleMatch[];

async function seed(): Promise<void> {
  await db.shows.bulkPut(shows);
  await db.episodes.bulkPut(episodes);
  await db.watchedEpisodes.bulkPut(watched);
  await db.movies.bulkPut(movies);
  await db.titleMatches.bulkPut(matches);
  await db.settings.put({ key: "example", value: "1" });
}

async function wipe(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
}

async function snapshot() {
  return {
    shows: await db.shows.toArray(),
    episodes: await db.episodes.toArray(),
    watchedEpisodes: await db.watchedEpisodes.toArray(),
    movies: await db.movies.toArray(),
    titleMatches: await db.titleMatches.toArray(),
    settings: await db.settings.toArray(),
  };
}

function storedKeys(): (string | null)[] {
  return [localStorage.getItem(TMDB_API_KEY_STORAGE), localStorage.getItem(OMDB_API_KEY_STORAGE)];
}

console.log("API keys");
await seed();
localStorage.setItem(TMDB_API_KEY_STORAGE, TMDB_KEY);
localStorage.setItem(OMDB_API_KEY_STORAGE, OMDB_KEY);
const original = await snapshot();
const backup = await buildBackup();
const keyless = withoutApiKeys(backup);
const localText = JSON.stringify(backup);
const keylessText = JSON.stringify(keyless);
{
  expect("The library was seeded", [original.shows.length, original.movies.length], [2, 1]);
  expect("The local format still carries both keys", backup.apiKeys, { tmdb: TMDB_KEY, omdb: OMDB_KEY });
  expect("The keyless copy has neither", keyless.apiKeys, { tmdb: null, omdb: null });
  expect("...anywhere in its text", [keylessText.includes(TMDB_KEY), keylessText.includes(OMDB_KEY)], [false, false]);
  expect("...and the same library", keyless.tables, backup.tables);
  expect("Stripping does not alter the backup it was made from", backup.apiKeys.tmdb, TMDB_KEY);
  expect("Everything else is unchanged", { ...keyless, apiKeys: null }, { ...backup, apiKeys: null });
}

console.log("Round trip: keyless copy into a fresh install");
{
  await wipe();
  localStorage.removeItem(TMDB_API_KEY_STORAGE);
  localStorage.removeItem(OMDB_API_KEY_STORAGE);
  expect("The install is empty before restoring", (await snapshot()).shows, []);
  const { backup: parsed, warnings } = parseBackupText(keylessText);
  expect("Validates with no warnings", warnings, []);
  const result = await restoreBackup(parsed, "replace");
  expect("Restores every table", await snapshot(), original);
  expect("Reports the keys as not in the backup", result.keys, { tmdb: "absent", omdb: "absent" });
  expect("Leaves no key behind", storedKeys(), [null, null]);
  expect("Counts what it restored", [result.counts.shows, result.counts.movies, result.counts.watchedEpisodes], [2, 1, 1]);
}

console.log("Round trip: keyless copy over an install that has keys");
{
  localStorage.setItem(TMDB_API_KEY_STORAGE, "current-tmdb-key");
  await restoreBackup(parseBackupText(keylessText).backup, "replace");
  expect("A current key is never removed by a backup without one", storedKeys(), ["current-tmdb-key", null]);
}

console.log("Round trip: local format");
{
  await wipe();
  localStorage.removeItem(TMDB_API_KEY_STORAGE);
  localStorage.removeItem(OMDB_API_KEY_STORAGE);
  const result = await restoreBackup(parseBackupText(localText).backup, "replace");
  expect("Restores every table", await snapshot(), original);
  expect("Restores both keys", result.keys, { tmdb: "restored", omdb: "restored" });
  expect("...into storage", storedKeys(), [TMDB_KEY, OMDB_KEY]);
}

console.log("The snapshot for Android backup");
{
  const prepared = prepareSnapshot(backup);
  expect("Holds no API key anywhere in its text", [prepared.data.includes(TMDB_KEY), prepared.data.includes(OMDB_KEY)], [false, false]);
  expect("Keeps the episode cache while it fits", JSON.parse(prepared.data).tables.episodes.length, 1);
  expect("...and says so", [prepared.droppedEpisodeCache, prepared.overBudget], [false, false]);
  expect("Measures its size in bytes", prepared.bytes, new TextEncoder().encode(prepared.data).length);
  expect("The keys go in their own file", parseKeysFile(prepared.keys!), { tmdb: TMDB_KEY, omdb: OMDB_KEY });

  const withoutCache = JSON.parse(prepared.data);
  withoutCache.tables.episodes = [];
  const fitsWithoutCache = new TextEncoder().encode(JSON.stringify(withoutCache)).length + 1;
  const squeezed = prepareSnapshot(backup, fitsWithoutCache);
  expect("Over the budget, the episode cache is dropped", JSON.parse(squeezed.data).tables.episodes, []);
  expect("...and nothing the user made", JSON.parse(squeezed.data).tables.watchedEpisodes.length, 1);
  expect("...which then fits", [squeezed.droppedEpisodeCache, squeezed.overBudget], [true, false]);
  expect("Still over even without it: flagged for Settings", prepareSnapshot(backup, 10).overBudget, true);
  expect("The budget leaves room under Android's 25 MB", SNAPSHOT_BUDGET_BYTES <= 25 * 1024 * 1024 - 1024 * 1024, true);

  expect("No keys set: no keys file", prepareSnapshot(withoutApiKeys(backup)).keys, null);
  expect("A keys file from elsewhere is ignored", parseKeysFile('{"app":"other","tmdb":"x"}'), null);
  expect("A keys file holding no key is ignored", parseKeysFile('{"app":"tv-tracker-backup-keys","tmdb":null}'), null);
  expect("A damaged keys file is ignored", parseKeysFile('{"app":"tv-tracker'), null);
  expect("One key alone is kept", parseKeysFile('{"app":"tv-tracker-backup-keys","tmdb":"k"}'), { tmdb: "k", omdb: null });
}

console.log("Restoring automatically at launch");
{
  const decide = (libraryEmpty: boolean, checkedBefore: boolean, snapshotFound: boolean) =>
    shouldAutoRestore({ libraryEmpty, checkedBefore, snapshotFound });
  expect("Fresh install with a snapshot from Android: restore", decide(true, false, true), true);
  expect("Fresh install with no snapshot: nothing to do", decide(true, false, false), false);
  expect("A library already here is never overwritten", decide(false, false, true), false);
  expect("Emptied by Reset Data on this install: not undone", decide(true, true, true), false);
  expect("Only a watched-episode row still counts as a library", hasLibraryData({ shows: 0, movies: 0, watchedEpisodes: 1 }), true);
  expect("An empty library is empty", hasLibraryData({ shows: 0, movies: 0, watchedEpisodes: 0 }), false);
}

console.log("Round trip: snapshot and keys file into a fresh install");
{
  // What firstLaunch.ts does with the two files Android restored.
  const prepared = prepareSnapshot(backup);
  await wipe();
  localStorage.removeItem(TMDB_API_KEY_STORAGE);
  localStorage.removeItem(OMDB_API_KEY_STORAGE);
  const restored = parseBackupText(prepared.data).backup;
  const keys = parseKeysFile(prepared.keys!);
  if (keys) restored.apiKeys = keys;
  const result = await restoreBackup(restored, "merge");
  expect("Restores every table", await snapshot(), original);
  expect("Restores both keys from the keys file", [result.keys, storedKeys()], [{ tmdb: "restored", omdb: "restored" }, [TMDB_KEY, OMDB_KEY]]);
}

console.log("Round trip: snapshot without its keys file");
{
  const prepared = prepareSnapshot(backup);
  await wipe();
  localStorage.removeItem(TMDB_API_KEY_STORAGE);
  localStorage.removeItem(OMDB_API_KEY_STORAGE);
  const result = await restoreBackup(parseBackupText(prepared.data).backup, "merge");
  expect("Restores every table", await snapshot(), original);
  expect("Leaves the keys to be entered again", [result.keys.tmdb, storedKeys()], ["absent", [null, null]]);
}

console.log("Round trip: snapshot that dropped the episode cache");
{
  const withoutCache = JSON.parse(prepareSnapshot(backup).data);
  withoutCache.tables.episodes = [];
  const fits = new TextEncoder().encode(JSON.stringify(withoutCache)).length + 1;
  await wipe();
  await restoreBackup(parseBackupText(prepareSnapshot(backup, fits).data).backup, "merge");
  const after = await snapshot();
  expect("Everything but the cache comes back", { ...after, episodes: null }, { ...original, episodes: null });
  expect("...and the cache is empty, to be fetched again", after.episodes, []);
}

console.log("Rejecting what is not a backup");
{
  const message = (text: string) => {
    try {
      parseBackupText(text);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message.slice(0, 27) : String(e);
    }
  };
  expect("Text that is not JSON", message("not json"), "That file isn't valid JSON.");
  expect("JSON from somewhere else", message('{"hello":1}'), "This isn't a backup file fr");
  expect("A truncated backup", message(localText.slice(0, localText.length / 2)), "That file isn't valid JSON.");
}

db.close();
console.log();
if (failures.length === 0) {
  console.log(`All ${checks} checks pass.`);
} else {
  console.log(`${failures.length} of ${checks} checks FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
