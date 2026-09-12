/**
 * Scenario check for the Home categorisation, run with `npm run check:watch-next`.
 *
 * It exists because the bug it covers is not visible in the code: every rule
 * in lib/watchNext.ts read correctly on its own, and the defect only appeared
 * in the combination of a show whose watch history was years old and whose
 * content was days old. The cases below are the ones that were actually
 * reported, plus the ones that must NOT change as a result of fixing them -
 * a genuinely abandoned show has to stay stale, a show the user has caught up
 * on has to stay off every list, and a show that was never started has to stay
 * in its own tab.
 *
 * Deliberately a script with hand-built rows rather than a test framework: the
 * repo has none, the function under test is pure, and the whole point is to be
 * runnable in one command against real-shaped data.
 */

import type { Episode, Show, WatchedEpisode } from "../src/db";
import { buildWatchNextRows } from "../src/lib/watchNext";

/** Fixed "now", so a scenario cannot pass one week and fail the next. */
const NOW = new Date("2026-09-11T12:00:00Z");
const STALE_THRESHOLD_DAYS = 60;

function iso(daysAgo: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

function day(daysAgo: number): string {
  return iso(daysAgo).slice(0, 10);
}

function show(tmdbId: number, name: string, stopped = false): Show {
  return {
    tmdbId,
    name,
    posterPath: null,
    firstAirYear: 2020,
    status: "Returning Series",
    addedAt: iso(900),
    isFollowed: true,
    // The explicit "I'm done with this" state. See lib/stoppedWatching.ts for
    // why it is this field rather than a new one.
    isArchived: stopped,
    lastWatchedAt: null,
  };
}

/** airDaysAgo negative = still to come; null = TMDB has no date. */
function ep(showId: number, season: number, number: number, airDaysAgo: number | null): Episode {
  return {
    key: `${showId}-${season}-${number}`,
    showId,
    seasonNumber: season,
    episodeNumber: number,
    name: `S${season}E${number}`,
    overview: null,
    airDate: airDaysAgo === null ? null : day(airDaysAgo),
    tmdbRating: 8,
    stillPath: null,
    runtimeMinutes: 45,
  };
}

function watched(showId: number, season: number, number: number, daysAgo: number): WatchedEpisode {
  return {
    key: `${showId}-${season}-${number}`,
    showId,
    seasonNumber: season,
    episodeNumber: number,
    watchedAt: iso(daysAgo),
    watchCount: 1,
    lastWatchedAt: iso(daysAgo),
  };
}

const shows: Show[] = [];
const episodes: Episode[] = [];
const history: WatchedEpisode[] = [];

// 1. Batch release after a long gap. Season 1 finished and watched ~2 years
//    ago; the whole of season 2 landed five days ago.
shows.push(show(1, "Batch Return"));
for (let e = 1; e <= 8; e++) {
  episodes.push(ep(1, 1, e, 620));
  history.push(watched(1, 1, e, 600));
  episodes.push(ep(1, 2, e, 5));
}

// 2. Weekly release after a long gap. Season 3 watched three years ago; season
//    4 is mid-run with two episodes out and a third still ahead.
shows.push(show(2, "Weekly Return"));
for (let e = 1; e <= 12; e++) {
  episodes.push(ep(2, 3, e, 1200));
  history.push(watched(2, 3, e, 1150));
}
episodes.push(ep(2, 4, 1, 37));
episodes.push(ep(2, 4, 2, 30));
episodes.push(ep(2, 4, 3, -7));

// 3. Genuinely stale: started, dropped, and nothing has been released since.
shows.push(show(3, "Abandoned"));
for (let e = 1; e <= 10; e++) episodes.push(ep(3, 1, e, 900));
history.push(watched(3, 1, 1, 800));
history.push(watched(3, 1, 2, 800));

// 4. Actively being watched, nothing newly released.
shows.push(show(4, "Current Binge"));
for (let e = 1; e <= 10; e++) episodes.push(ep(4, 1, e, 400));
for (let e = 1; e <= 4; e++) history.push(watched(4, 1, e, 3));

// 5. Never started, and a new season just dropped. A release must not promote
//    a show the user has never begun out of its own tab.
shows.push(show(5, "Never Begun"));
episodes.push(ep(5, 1, 1, 300));
episodes.push(ep(5, 2, 1, 2));

// 6. Abandoned MID-season-1, then season 2 dropped. Deliberately NOT
//    reactivated: three episodes of season 1 have been sitting unwatched the
//    whole time, so the new season is not a continuation of anything this user
//    was following. It stays stale, which is where it was before any of the
//    release handling existed.
shows.push(show(6, "Dropped Then Returned"));
for (let e = 1; e <= 8; e++) episodes.push(ep(6, 1, e, 700));
for (let e = 1; e <= 5; e++) history.push(watched(6, 1, e, 650));
for (let e = 1; e <= 6; e++) episodes.push(ep(6, 2, e, 3));

// 7. New season released AND already watched. Nothing is waiting, so the show
//    belongs on no list at all.
shows.push(show(7, "Caught Up"));
for (let e = 1; e <= 6; e++) {
  episodes.push(ep(7, 1, e, 700));
  history.push(watched(7, 1, e, 690));
  episodes.push(ep(7, 2, e, 4));
  history.push(watched(7, 2, e, 2));
}

// 8. Returned, but four months ago and still untouched. Past the activation
//    window this is an abandoned show like any other.
shows.push(show(8, "Returned Long Ago"));
for (let e = 1; e <= 6; e++) {
  episodes.push(ep(8, 1, e, 900));
  history.push(watched(8, 1, e, 880));
}
for (let e = 1; e <= 6; e++) episodes.push(ep(8, 2, e, 120));

// 9. A show whose next episode has no air date at all. Unknown is not a
//    release: it must not trigger reactivation.
shows.push(show(9, "Undated"));
for (let e = 1; e <= 4; e++) {
  episodes.push(ep(9, 1, e, 800));
  history.push(watched(9, 1, e, 780));
}
episodes.push(ep(9, 2, 1, null));

// 10. Watched 50 days ago: inside the staleness threshold, so Watch Next, but
//     less recent than either returning show's release. It is here purely to
//     pin the ORDERING - under the old progression-only comparator both
//     returning shows sorted below this one, on watch dates years old.
shows.push(show(10, "Slow Burn"));
for (let e = 1; e <= 10; e++) episodes.push(ep(10, 1, e, 400));
for (let e = 1; e <= 3; e++) history.push(watched(10, 1, e, 50));

// 11. Long-running series the user gave up on years ago and which still airs
//     every week. Availability alone would drag this back into Watch Next
//     every seven days forever; the backlog of seasons they never watched is
//     what says they stopped.
shows.push(show(11, "Still Airing Weekly"));
for (let season = 1; season <= 4; season++) {
  for (let e = 1; e <= 10; e++) {
    episodes.push(ep(11, season, e, 1500 - season * 300));
    // Only the first two seasons were watched.
    if (season <= 2) history.push(watched(11, season, e, 1400 - season * 300));
  }
}
episodes.push(ep(11, 5, 1, 10)); // this week's episode, on top of two unwatched seasons

// 12. Watched season 1, skipped season 2 entirely, and season 3 has just
//     dropped. The new season is not a continuation of anything they were
//     following - season 2 has been sitting there unwatched the whole time.
shows.push(show(12, "Skipped A Season"));
for (let e = 1; e <= 6; e++) {
  episodes.push(ep(12, 1, e, 900));
  history.push(watched(12, 1, e, 880));
  episodes.push(ep(12, 2, e, 400));
}
for (let e = 1; e <= 6; e++) episodes.push(ep(12, 3, e, 4));

// 13. Explicitly stopped, with a season that just dropped. The strongest
//     possible pull toward Watch Next, refused because the user said so.
shows.push(show(13, "Explicitly Stopped", true));
for (let e = 1; e <= 8; e++) {
  episodes.push(ep(13, 1, e, 620));
  history.push(watched(13, 1, e, 600));
  episodes.push(ep(13, 2, e, 5));
}

// 14. Explicitly stopped AND finished - nothing left to watch. Still listed,
//     because the Stopped tab is where the user goes to undo this, and a show
//     they cannot find is a show they cannot resume.
shows.push(show(14, "Stopped And Finished", true));
for (let e = 1; e <= 6; e++) {
  episodes.push(ep(14, 1, e, 700));
  history.push(watched(14, 1, e, 690));
}

const rows = buildWatchNextRows(shows, episodes, history, STALE_THRESHOLD_DAYS, null, NOW);
const sorted = [...rows].sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? ""));

console.log(`Watch Next categorisation, ${STALE_THRESHOLD_DAYS}-day staleness threshold, now = ${day(0)}\n`);
for (const row of sorted) {
  const next = row.nextEpisode ? `S${row.nextEpisode.seasonNumber}E${row.nextEpisode.episodeNumber}` : "none";
  console.log(
    `${row.showName.padEnd(24)} ${row.category.padEnd(12)} next=${next.padEnd(6)} +${String(row.additionalCount).padEnd(3)}` +
      ` new=${(row.newlyAvailable ? row.newlyAvailableAt : "-")!.padEnd(11)} sorts-on=${(row.activityAt ?? "").slice(0, 10)}`
  );
}

/** name -> [expected category, expected next episode]. Sorted order is checked separately. */
const expected: Record<string, [string, string]> = {
  "Batch Return": ["watch-next", "S2E1"],
  "Weekly Return": ["watch-next", "S4E1"],
  Abandoned: ["stale", "S1E3"],
  "Current Binge": ["watch-next", "S1E5"],
  "Never Begun": ["not-started", "S1E1"],
  "Dropped Then Returned": ["stale", "S1E6"],
  "Returned Long Ago": ["stale", "S2E1"],
  Undated: ["stale", "S2E1"],
  "Slow Burn": ["watch-next", "S1E4"],
  // The refinement: a release reaches these two, and must not reactivate them.
  // Both fall back to the ordinary staleness rules, which is exactly where
  // they were before any of this existed.
  "Still Airing Weekly": ["stale", "S3E1"],
  "Skipped A Season": ["stale", "S2E1"],
  // Explicit state beats every automatic rule, including a season that dropped
  // five days ago.
  "Explicitly Stopped": ["stopped", "S2E1"],
  "Stopped And Finished": ["stopped", "none"],
};

const byName = new Map(rows.map((row) => [row.showName, row]));
const failures: string[] = [];

for (const [name, [category, next]] of Object.entries(expected)) {
  const row = byName.get(name);
  const actualNext = row?.nextEpisode
    ? `S${row.nextEpisode.seasonNumber}E${row.nextEpisode.episodeNumber}`
    : "none";
  if (row?.category !== category || actualNext !== next) {
    failures.push(`${name}: expected ${category}/${next}, got ${row?.category ?? "(absent)"}/${actualNext}`);
  }
}

if (byName.has("Caught Up")) {
  failures.push("Caught Up: should appear on no list — every released episode is watched");
}

// The distinction the whole refinement turns on, asserted directly rather than
// left implied by the categories: both of these had an episode released inside
// the activation window, and only the ones the user was caught up on count as
// newly available.
for (const name of ["Batch Return", "Weekly Return"]) {
  if (!byName.get(name)?.newlyAvailable) {
    failures.push(`${name}: should be flagged newlyAvailable — the user was caught up when the new season arrived`);
  }
}
for (const name of ["Still Airing Weekly", "Skipped A Season", "Dropped Then Returned"]) {
  const row = byName.get(name);
  if (row?.newlyAvailable) {
    failures.push(`${name}: must NOT be flagged newlyAvailable — older released episodes are still unwatched`);
  }
  if (!row?.releasedButBehind) {
    failures.push(`${name}: should be flagged releasedButBehind, so the UI can explain why it is not in Watch Next`);
  }
}

// A returning show has to sort by when it RETURNED, not by watch history that
// may be years old. Being present but at the bottom of a long list is barely
// different from being missing, and is what the original report felt like.
// Both returning shows released more recently than "Slow Burn" was watched, so
// both must be above it; under the old progression-only comparator both sorted
// below it, on dates from 2023 and 2024.
// Nothing stopped may appear in either automatic list, however new its
// content or however recently it was watched.
for (const row of sorted) {
  if (row.category === "stopped") continue;
  if (row.showName.startsWith("Stopped") || row.showName === "Explicitly Stopped") {
    failures.push(`${row.showName}: stopped shows must not appear as "${row.category}"`);
  }
}

const watchNextOrder = sorted.filter((row) => row.category === "watch-next").map((row) => row.showName);
const positionOf = (name: string) => watchNextOrder.indexOf(name);
for (const returning of ["Batch Return", "Weekly Return"]) {
  if (positionOf(returning) > positionOf("Slow Burn")) {
    failures.push(
      `Watch Next order: "${returning}" returned more recently than "Slow Burn" was watched, but sorts below it ` +
        `(${watchNextOrder.join(" > ")})`
    );
  }
}

console.log();
if (failures.length === 0) {
  console.log("All scenarios pass.");
} else {
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  process.exitCode = 1;
}
