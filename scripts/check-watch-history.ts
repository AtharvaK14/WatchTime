/**
 * Scenario check for viewing history and Quick Actions availability, run with
 * `npm run check:watch-history`.
 *
 * It covers the rules behind "Watched again": what a first viewing, a rewatch,
 * "Watched once" and "Not watched" do to an episode's record, and how the
 * season, show and library counts are derived from those records. The
 * reported bug was that a season watched again changed nothing anyone could
 * see; the cases below pin down what it must change (episode counts, season
 * and show watch counts, total episodes watched) and what it must NOT (unique
 * episodes watched, the original viewing dates, seasons only partly rewatched).
 *
 * The database writes in lib/watchEvents.ts apply exactly these transforms
 * inside a transaction; their persistence is checked in the running app (see
 * the PR notes), since this repo has no IndexedDB outside a browser.
 *
 * Same shape as the other check scripts: hand-built rows, pure functions, one
 * command, non-zero exit on any failure.
 */

import type { Episode, Movie, WatchedEpisode } from "../src/db";
import {
  episodeWatchCount,
  firstWatchRecord,
  movieFirstWatchedAt,
  movieWatchCount,
  summarize,
  summarizeShow,
  withMovieRewatch,
  withMovieWatchedOnce,
  withoutLatestMovieViewing,
  withoutLatestViewing,
  withRewatch,
  withWatchedOnce,
} from "../src/lib/watchHistory";
import {
  episodeActions,
  movieActions,
  seasonActions,
  showActions,
  viewingStatusActions,
  type QuickActionSpec,
} from "../src/lib/quickActions";
import { searchOrBrowse } from "../src/lib/librarySearch";
import { movieLibraryStats, showLibraryStats } from "../src/lib/libraryStats";
import type { Show } from "../src/db";
import type { ShowWatchStatus } from "../src/lib/showWatchStatus";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : `  (expected ${e}, got ${a})`}`);
  if (!ok) failures.push(name);
}

const T1 = "2025-01-10T20:00:00.000Z"; // the original viewing
const T2 = "2026-11-01T21:00:00.000Z"; // a rewatch
const T3 = "2026-11-05T21:00:00.000Z"; // another

function ep(season: number, n: number, airDate: string | null = "2024-01-01"): Episode {
  return {
    key: `1-${season}-${n}`,
    showId: 1,
    seasonNumber: season,
    episodeNumber: n,
    name: `S${season}E${n}`,
    overview: null,
    airDate,
    tmdbRating: 0,
    stillPath: null,
    runtimeMinutes: null,
  };
}

/** A library of rows keyed like the watchedEpisodes table, with the same write semantics as watchEvents.ts. */
class Library {
  rows = new Map<string, WatchedEpisode>();
  watch(eps: Episode[], when: string) {
    for (const e of eps) if (!this.rows.has(e.key)) this.rows.set(e.key, firstWatchRecord(1, e, when));
  }
  rewatch(eps: Episode[], when: string) {
    for (const e of eps) {
      const prior = this.rows.get(e.key);
      this.rows.set(e.key, prior ? withRewatch(prior, when) : firstWatchRecord(1, e, when));
    }
  }
  once(eps: Episode[]) {
    for (const e of eps) {
      const prior = this.rows.get(e.key);
      if (prior) this.rows.set(e.key, withWatchedOnce(prior));
    }
  }
  unwatch(eps: Episode[]) {
    for (const e of eps) this.rows.delete(e.key);
  }
  get list() {
    return [...this.rows.values()];
  }
  count(e: Episode) {
    return episodeWatchCount(this.rows.get(e.key));
  }
  totals() {
    const list = this.list;
    return { unique: list.length, views: list.reduce((s, w) => s + episodeWatchCount(w), 0) };
  }
}

const season1 = Array.from({ length: 10 }, (_, i) => ep(1, i + 1));
const season2 = Array.from({ length: 4 }, (_, i) => ep(2, i + 1));
const unaired = [ep(3, 1, "2099-01-01"), ep(3, 2, "2099-01-08")];
const allEpisodes = [...season1, ...season2, ...unaired];

console.log("Episode records");
{
  const lib = new Library();
  const e = season1[0];
  lib.watch([e], T1);
  expect("1. First watch creates one viewing event", lib.count(e), 1);
  expect("   ...dated as both first and latest viewing", [lib.rows.get(e.key)!.watchedAt, lib.rows.get(e.key)!.lastWatchedAt], [T1, T1]);
  lib.rewatch([e], T2);
  expect("2. Watched again makes it a second viewing event", lib.count(e), 2);
  lib.rewatch([e], T3);
  lib.rewatch([e], T3);
  expect("3. Each further rewatch adds exactly one", lib.count(e), 4);
  expect("10. Original date kept, latest date is the rewatch", [lib.rows.get(e.key)!.watchedAt, lib.rows.get(e.key)!.lastWatchedAt], [T1, T3]);
  lib.watch([e], T3);
  expect("   Mark watched again on a watched episode changes nothing", lib.count(e), 4);
  lib.once([e]);
  expect("4. Watched once resets the count to one", lib.count(e), 1);
  expect("   ...keeping the original viewing date", [lib.rows.get(e.key)!.watchedAt, lib.rows.get(e.key)!.lastWatchedAt], [T1, T1]);
  lib.unwatch([e]);
  expect("5. Not watched leaves the episode unwatched", lib.count(e), 0);
  // A replayed widget tap can carry an older time than a rewatch since.
  const r = withRewatch({ ...firstWatchRecord(1, e, T1), lastWatchedAt: T3, watchCount: 2 }, T2);
  expect("   An older replayed rewatch never moves the latest date back", r.lastWatchedAt, T3);
  expect("   A pre-v5 row with no watchCount counts as one watch", episodeWatchCount({ watchCount: undefined as unknown as number }), 1);
}

console.log("\nSeasons, shows and totals");
{
  const lib = new Library();
  lib.watch([...season1, ...season2], T1);
  const byKey = () => lib.rows;
  expect("   Season watched through once", summarize(season1, byKey()).completions, 1);
  expect("   Show watched through once (unaired season 3 does not count)", summarizeShow(allEpisodes, lib.list).completions, 1);
  const before = lib.totals();

  lib.rewatch([season1[1], season1[3], season1[6]], T2); // episodes 2, 4 and 7
  const partial = summarize(season1, byKey());
  expect("6. Rewatching 3 of 10 episodes does not add a season viewing", partial.completions, 1);
  expect("   ...but does count as three more episode views", partial.views, 13);
  expect("   ...and each rewatched episode is at 2", [lib.count(season1[1]), lib.count(season1[3]), lib.count(season1[6])], [2, 2, 2]);
  expect("   ...and an untouched episode stays at 1", lib.count(season1[0]), 1);
  const afterPartial = lib.totals();
  expect("8. Total episodes watched grows by the rewatch events (3)", afterPartial.views - before.views, 3);
  expect("9. Unique episodes watched does not grow on a rewatch", afterPartial.unique, before.unique);

  lib.rewatch(season1, T3);
  const full = summarize(season1, byKey());
  expect("7. Rewatching the whole season adds exactly one season viewing", full.completions, 2);
  expect("   ...and ten more episode views", lib.totals().views - afterPartial.views, 10);
  expect("   Season 2 is untouched by season 1's rewatch", summarize(season2, byKey()).completions, 1);
  expect("   Show is watched through twice only once every season is", summarizeShow(allEpisodes, lib.list).completions, 1);
  lib.rewatch(season2, T3);
  expect("   ...which it is after season 2 is watched again too", summarizeShow(allEpisodes, lib.list).completions, 2);
  const show = summarizeShow(allEpisodes, lib.list);
  expect("   Show counts: unique, views, released", [show.uniqueWatched, show.views, show.released], [14, 31, 14]);

  lib.unwatch([season1[0]]);
  expect("   A season with an unwatched episode has been watched through 0 times", summarize(season1, byKey()).completions, 0);
  expect("   ...and so has the show", summarizeShow(allEpisodes, lib.list).completions, 0);
  expect("   An empty season has no viewings", summarize([], byKey()).completions, 0);
}

console.log("\nMovies");
{
  const movie: Movie = {
    tmdbId: 9,
    title: "M",
    posterPath: null,
    releaseYear: 2020,
    watched: true,
    watchedAt: T1,
    wantsToWatch: false,
    rewatchCount: 0,
  };
  const once = { ...movie, ...withMovieRewatch(movie, T2) };
  expect("   Movie rewatch counts one more viewing", movieWatchCount(once), 2);
  expect("   ...keeps the first viewing date", movieFirstWatchedAt(once), T1);
  expect("   ...and moves the latest to the rewatch", once.watchedAt, T2);
  const twice = { ...once, ...withMovieRewatch(once, T3) };
  expect("   A second rewatch still keeps the first date", [movieWatchCount(twice), movieFirstWatchedAt(twice)], [3, T1]);
  const legacy: Movie = { ...movie, rewatchCount: 2, watchedAt: T2 };
  expect("   A rewatch recorded before the first date was kept reports it unknown", movieFirstWatchedAt(legacy), null);
  expect("   An unwatched movie has no viewings", movieWatchCount({ watched: false, rewatchCount: 3 }), 0);
}

console.log("\nQuick Actions availability");
{
  const ids = (specs: QuickActionSpec[]) => specs.map((s) => s.id);
  expect("   Unwatched episode: Mark as watched, not Watched again", ids(episodeActions({ inLibrary: true, watchCount: 0 })), [
    "mark-watched",
    "episode-details",
  ]);
  expect("   Watched episode: Watched again and Mark as unwatched", ids(episodeActions({ inLibrary: true, watchCount: 1 })), [
    "watched-again",
    "episode-details",
    "mark-unwatched",
  ]);
  expect("   Rewatched episode: Remove last viewing as well", ids(episodeActions({ inLibrary: true, watchCount: 2 })), [
    "watched-again",
    "remove-last",
    "episode-details",
    "mark-unwatched",
  ]);
  expect("   Unwatched season: Mark season as watched", ids(seasonActions({ inLibrary: true, total: 8, watched: 0 })), [
    "mark-watched",
    "season-details",
  ]);
  expect(
    "   Partially watched season is not offered Watched again",
    ids(seasonActions({ inLibrary: true, total: 8, watched: 6 })),
    ["mark-watched", "season-details", "mark-unwatched"]
  );
  expect("   Fully watched season: Watched again", ids(seasonActions({ inLibrary: true, total: 8, watched: 8 })), [
    "watched-again",
    "season-details",
    "mark-unwatched",
  ]);
  expect("   Season preview outside the library: details only", ids(seasonActions({ inLibrary: false, total: 8, watched: 0 })), [
    "season-details",
  ]);
  expect(
    "   Stopped show offers Resume, not Stop",
    ids(showActions({ inLibrary: true, stopped: true, watchedEpisodes: 3, releasedUnwatched: 5 })).filter((i) => i === "resume" || i === "stop"),
    ["resume"]
  );
  expect(
    "   Followed show offers Stop, not Resume",
    ids(showActions({ inLibrary: true, stopped: false, watchedEpisodes: 3, releasedUnwatched: 5 })).filter((i) => i === "resume" || i === "stop"),
    ["stop"]
  );
  expect(
    "   Caught-up show is not offered Mark as watched",
    ids(showActions({ inLibrary: true, stopped: false, watchedEpisodes: 14, releasedUnwatched: 0 })).includes("mark-watched"),
    false
  );
  expect(
    "   Show in the library: Remove, not Add",
    ids(showActions({ inLibrary: true, stopped: false, watchedEpisodes: 0, releasedUnwatched: null })).filter((i) => i === "add" || i === "remove"),
    ["remove"]
  );
  expect("   Show outside the library: View details and Add", ids(showActions({ inLibrary: false, stopped: false, watchedEpisodes: 0, releasedUnwatched: null })), [
    "view-details",
    "add",
  ]);
  expect(
    "   Unwatched show: no Mark as unwatched or history",
    ids(showActions({ inLibrary: true, stopped: false, watchedEpisodes: 0, releasedUnwatched: 4 })).some((i) => i === "mark-unwatched" || i === "history"),
    false
  );
  expect("   Watched movie: Watched again, Mark as unwatched", ids(movieActions({ inLibrary: true, watched: true })), [
    "view-details",
    "watched-again",
    "history",
    "mark-unwatched",
    "remove",
  ]);
  expect("   Unwatched movie: Mark as watched, no Watched again", ids(movieActions({ inLibrary: true, watched: false })), [
    "view-details",
    "mark-watched",
    "remove",
  ]);
  expect("   Movie outside the library: Mark as watched and Add", ids(movieActions({ inLibrary: false, watched: false })), [
    "view-details",
    "mark-watched",
    "add",
  ]);
  const showSpecs = showActions({ inLibrary: true, stopped: false, watchedEpisodes: 3, releasedUnwatched: 2 });
  expect(
    "   Bulk history removals ask first",
    showSpecs.filter((s) => s.confirm).map((s) => s.id),
    ["mark-unwatched", "remove"]
  );
}

console.log("\nRemoving the last viewing");
{
  const e = season1[0];
  const T4 = "2026-11-10T21:00:00.000Z";
  let row = firstWatchRecord(1, e, T1);
  row = withRewatch(row, T2);
  row = withRewatch(row, T3);
  row = withRewatch(row, T4);
  expect("   Three rewatches: 4 viewings, latest the third rewatch", [row.watchCount, row.lastWatchedAt], [4, T4]);
  row = withoutLatestViewing(row);
  expect("   Remove one: 3 viewings, latest back to the rewatch before it", [row.watchCount, row.lastWatchedAt], [3, T3]);
  expect("   ...the first viewing date is untouched", row.watchedAt, T1);
  row = withoutLatestViewing(row);
  expect("   Remove another: 2 viewings, latest the first rewatch", [row.watchCount, row.lastWatchedAt], [2, T2]);
  row = withoutLatestViewing(row);
  expect("   Down to one: latest is the first viewing again", [row.watchCount, row.lastWatchedAt, row.watchedAt], [1, T1, T1]);
  let threw = false;
  try {
    withoutLatestViewing(row);
  } catch {
    threw = true;
  }
  expect("   Removing the only viewing is refused (that is Not watched)", threw, true);
  // An imported row: a count from TV Time with no per-viewing dates.
  const imported: WatchedEpisode = { ...firstWatchRecord(1, e, T1), watchCount: 3, lastWatchedAt: T2 };
  const importedAgain = withRewatch(imported, T4);
  const undo = withoutLatestViewing(importedAgain);
  expect("   An in-app rewatch on an imported row is undone exactly", [undo.watchCount, undo.lastWatchedAt], [3, T2]);
  const undated = withoutLatestViewing(undo);
  expect("   An imported (undated) viewing keeps the best known latest date", [undated.watchCount, undated.lastWatchedAt], [2, T2]);
  expect("   ...and back at one, the first date", withoutLatestViewing(undated).lastWatchedAt, T1);
  const reset = withWatchedOnce(withRewatch(withRewatch(firstWatchRecord(1, e, T1), T2), T3));
  expect("   Watched once clears the saved rewatch dates", [reset.watchCount, reset.lastWatchedAt, reset.latestBeforeRewatch], [1, T1, undefined]);

  const movie: Movie = { tmdbId: 9, title: "M", posterPath: null, releaseYear: 2020, watched: true, watchedAt: T1, wantsToWatch: false, rewatchCount: 0 };
  let m: Movie = { ...movie, ...withMovieRewatch(movie, T2) };
  m = { ...m, ...withMovieRewatch(m, T3) };
  expect("   Movie watched 3 times", movieWatchCount(m), 3);
  m = { ...m, ...withoutLatestMovieViewing(m) };
  expect("   Movie 3 -> 2: latest back to the previous viewing", [movieWatchCount(m), m.watchedAt, movieFirstWatchedAt(m)], [2, T2, T1]);
  m = { ...m, ...withoutLatestMovieViewing(m) };
  expect("   Movie 2 -> 1: dated at its first viewing, still watched", [movieWatchCount(m), m.watchedAt, m.watched], [1, T1, true]);
  let movieThrew = false;
  try {
    withoutLatestMovieViewing(m);
  } catch {
    movieThrew = true;
  }
  expect("   A movie's only viewing cannot be 'removed' (that is Not watched)", movieThrew, true);
  let w: Movie = { ...movie, ...withMovieRewatch(movie, T2) };
  w = { ...w, ...withMovieRewatch(w, T3) };
  w = { ...w, ...withMovieWatchedOnce(w) };
  expect("   Movie watched once: one viewing, at the first date", [movieWatchCount(w), w.watchedAt], [1, T1]);
}

console.log("\nViewing-status menu (episodes and movies)");
{
  const ids = (n: number) => viewingStatusActions(n).map((a) => (a.checked ? `${a.id}*` : a.id));
  expect("   Watched once: once (current), again, not watched", ids(1), ["watched-once*", "watched-again", "not-watched"]);
  expect("   Watched twice: again, remove last, not watched", ids(2), ["watched-again", "remove-last", "not-watched"]);
  expect("   Watched 3+: once, again, remove last, not watched", ids(3), ["watched-once", "watched-again", "remove-last", "not-watched"]);
  expect(
    "   Episode quick actions offer Remove last viewing from 2 viewings",
    episodeActions({ inLibrary: true, watchCount: 2 }).map((a) => a.id).includes("remove-last"),
    true
  );
  expect(
    "   ...but not at 1",
    episodeActions({ inLibrary: true, watchCount: 1 }).map((a) => a.id).includes("remove-last"),
    false
  );
  expect(
    "   Movie quick actions offer Remove last viewing from 2 viewings",
    movieActions({ inLibrary: true, watched: true, watchCount: 3 }).map((a) => a.id).includes("remove-last"),
    true
  );
}

console.log("\nSearch versus browsing filters");
{
  type T = { name: string; watched: boolean; stopped: boolean };
  const lib: T[] = [
    { name: "Loki", watched: true, stopped: false },
    { name: "Andor", watched: false, stopped: false },
    { name: "Lost", watched: true, stopped: true },
  ];
  const unwatchedOnly = (t: T) => !t.watched;
  const names = (r: { items: T[] }) => r.items.map((t) => t.name);
  expect("   No query: the filter applies as before", names(searchOrBrowse(lib, "", (t) => t.name, unwatchedOnly)), ["Andor"]);
  expect("   Searching finds a watched show the filter hides", names(searchOrBrowse(lib, "loki", (t) => t.name, unwatchedOnly)), ["Loki"]);
  expect("   ...and a stopped one", names(searchOrBrowse(lib, "lo", (t) => t.name, (t) => !t.stopped && !t.watched)), ["Loki", "Lost"]);
  expect("   Whitespace-only query is not a search", searchOrBrowse(lib, "   ", (t) => t.name, unwatchedOnly).searching, false);
  expect("   Clearing the query restores the filter", names(searchOrBrowse(lib, "", (t) => t.name, unwatchedOnly)), ["Andor"]);
}

console.log("\nStatistics");
{
  const show = (id: number, name: string, stopped = false): Show => ({
    tmdbId: id,
    name,
    posterPath: null,
    firstAirYear: 2024,
    status: "Ended",
    addedAt: T1,
    isFollowed: true,
    isArchived: stopped,
    lastWatchedAt: null,
  });
  const shows = [show(1, "Watching"), show(2, "Done"), show(3, "Stopped", true), show(4, "Fresh"), show(5, "Unsynced")];
  const status = new Map<number, ShowWatchStatus>([
    [1, "currently-watching"],
    [2, "up-to-date"],
    [3, "currently-watching"],
    [4, "not-started"],
  ]);
  const epOf = (showId: number, season: number, n: number): Episode => ({ ...ep(season, n), key: `${showId}-${season}-${n}`, showId });
  const episodes = [epOf(1, 1, 1), epOf(1, 1, 2), epOf(1, 2, 1), epOf(2, 1, 1), epOf(2, 1, 2)];
  const watchedRows: WatchedEpisode[] = [
    { ...firstWatchRecord(1, epOf(1, 1, 1), "2026-10-02T00:00:00.000Z"), watchCount: 3 },
    firstWatchRecord(1, epOf(1, 1, 2), "2026-11-02T00:00:00.000Z"),
    firstWatchRecord(2, epOf(2, 1, 1), "2026-11-03T00:00:00.000Z"),
    { ...firstWatchRecord(2, epOf(2, 1, 2), "2025-01-01T00:00:00.000Z"), watchCount: 2 },
  ];
  const s = showLibraryStats(shows, episodes, watchedRows, status, new Date("2026-11-05T12:00:00Z"));
  expect(
    "   Show states use the Shows filter's rule; stopped beats status",
    [s.totalShows, s.currentlyWatching, s.caughtUp, s.notStarted, s.stopped, s.unknown],
    [5, 1, 1, 1, 1, 1]
  );
  expect("   Unique episodes and viewing events are separate", [s.uniqueEpisodes, s.episodeViews, s.rewatchViews], [4, 7, 3]);
  expect("   Seasons watched through (cached seasons only)", s.seasonsCompleted, 2);
  expect("   Most watched ranks by viewings", s.mostWatched.map((t) => [t.name, t.views, t.unique]), [
    ["Watching", 4, 2],
    ["Done", 3, 2],
  ]);
  expect(
    "   First-time viewings by month (rewatches not dated, not counted)",
    s.firstWatchesByMonth.slice(-2),
    [
      { month: "2026-10", count: 1 },
      { month: "2026-11", count: 2 },
    ]
  );
  const mv = (id: number, watched: boolean, rewatchCount = 0): Movie => ({
    tmdbId: id,
    title: `Movie ${id}`,
    posterPath: null,
    releaseYear: 2020,
    watched,
    watchedAt: watched ? T1 : null,
    wantsToWatch: !watched,
    rewatchCount,
  });
  const ms = movieLibraryStats([mv(1, true, 2), mv(2, true), mv(3, false, 4), mv(4, false)]);
  expect(
    "   Movies: 3 viewings of one movie = 1 movie watched, 3 viewings",
    [ms.totalMovies, ms.watched, ms.unwatched, ms.views, ms.rewatchViews],
    [4, 2, 2, 4, 2]
  );
  expect("   An unwatched movie's kept rewatches do not count", ms.mostRewatched.map((t) => [t.name, t.views]), [["Movie 1", 3]]);
}

console.log();
if (failures.length === 0) {
  console.log(`All ${checks} checks pass.`);
} else {
  console.log(`${failures.length} of ${checks} checks FAILED.`);
  process.exitCode = 1;
}
