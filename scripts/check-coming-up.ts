/**
 * Scenario check for Home's Coming Up section, run with `npm run check:coming-up`.
 *
 * Two halves, matching the section's two columns:
 *
 *  - Upcoming episodes: only shows the user is ACTIVELY FOLLOWING, decided by
 *    the same classifyShow() the Up Next tabs use. The cases are the reported
 *    ones (an unstarted show and an abandoned one appearing with their next
 *    episode), the states that must stay excluded however much is scheduled
 *    (Stopped Watching above all), and the caught-up edge case that must not
 *    regress: a show the user has watched everything of, waiting out a long
 *    break, is the clearest example of a show they are following.
 *
 *  - Releasing this month: the In Theaters / Digital Release tag, which is
 *    only ever claimed from TMDB's typed release dates, never guessed from
 *    the single primary release date.
 *
 * Same shape as check-watch-next.ts: hand-built rows, pure functions, no
 * framework. Episode air dates are relative to the real clock, because
 * findNextUnwatched()/findNextUpcoming() judge availability against it; that
 * keeps every case the same distance from "today" whenever this is run.
 */

import type { Episode, Movie, Show, WatchedEpisode } from "../src/db";
import { buildReleasingThisMonth, buildUpcomingEpisodeRows, releaseThisMonth } from "../src/lib/comingUp";
import { moviesNeedingTypedDates } from "../src/lib/releaseDates";
import { buildWatchNextRows, classifyShow, groupByShow } from "../src/lib/watchNext";

const NOW = new Date();
const STALE_THRESHOLD_DAYS = 60;
const failures: string[] = [];

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86400000).toISOString();
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

// ---- Upcoming episodes -----------------------------------------------------

const shows: Show[] = [];
const episodes: Episode[] = [];
const history: WatchedEpisode[] = [];

// 1. Watching it week to week: last week's episode is out and unwatched, the
//    next one airs in five days.
shows.push(show(1, "Watching Weekly"));
for (let e = 1; e <= 5; e++) episodes.push(ep(1, 1, e, 40 - e * 7));
episodes.push(ep(1, 1, 6, -5));
for (let e = 1; e <= 4; e++) history.push(watched(1, 1, e, 3));

// 2. THE EDGE CASE. Watched everything out so far, most of a year ago; the
//    next season is two months off. Caught up is not inactive.
shows.push(show(2, "Caught Up, Long Break"));
for (let e = 1; e <= 6; e++) {
  episodes.push(ep(2, 1, e, 400 - e * 7));
  history.push(watched(2, 1, e, 300));
}
episodes.push(ep(2, 2, 1, -60));

// 3. Same, but TMDB lists the coming season as a dated premiere followed by
//    undated episodes - its usual shape for an announced season. Those
//    episodes cannot have aired before the premiere has, so the user is still
//    caught up, not part-way through a show they have not touched in 300 days.
shows.push(show(3, "Caught Up, Season TBA"));
for (let e = 1; e <= 6; e++) {
  episodes.push(ep(3, 1, e, 400 - e * 7));
  history.push(watched(3, 1, e, 300));
}
episodes.push(ep(3, 2, 1, -30));
for (let e = 2; e <= 6; e++) episodes.push(ep(3, 2, e, null));

// 4. Reported: in the library, never started, next season scheduled.
//    Haven't Yet Started, so no upcoming episodes.
shows.push(show(4, "Never Started"));
for (let e = 1; e <= 10; e++) episodes.push(ep(4, 1, e, 500 - e * 7));
episodes.push(ep(4, 2, 1, -10));

// 5. Reported: started long ago, a backlog of released episodes never
//    watched, and the show keeps airing. Haven't Watched For a While; this
//    week's release does not change that (the backlog says they stopped).
shows.push(show(5, "Haven't Watched In Ages"));
for (let e = 1; e <= 10; e++) episodes.push(ep(5, 1, e, 700 - e * 7));
history.push(watched(5, 1, 1, 400));
history.push(watched(5, 1, 2, 400));
episodes.push(ep(5, 2, 1, 3));
episodes.push(ep(5, 2, 2, -4));

// 6. Explicitly stopped, though caught up and with more scheduled.
shows.push(show(6, "Stopped, Still Airing", true));
for (let e = 1; e <= 4; e++) {
  episodes.push(ep(6, 1, e, 200 - e * 7));
  history.push(watched(6, 1, e, 150));
}
episodes.push(ep(6, 2, 1, -12));

// 7. Stopped, and a new season has just dropped - the strongest pull back
//    into the active lists there is. Stopped still wins.
shows.push(show(7, "Stopped, Season Dropped", true));
for (let e = 1; e <= 4; e++) {
  episodes.push(ep(7, 1, e, 600 - e * 7));
  history.push(watched(7, 1, e, 500));
}
episodes.push(ep(7, 2, 1, 4));
episodes.push(ep(7, 2, 2, -3));

// 8. Caught up when the new season arrived last week: the release
//    reactivates it (Watch Next), so its next episode is upcoming here too.
shows.push(show(8, "Returned Last Week"));
for (let e = 1; e <= 6; e++) {
  episodes.push(ep(8, 1, e, 700 - e * 7));
  history.push(watched(8, 1, e, 600));
}
episodes.push(ep(8, 2, 1, 5));
episodes.push(ep(8, 2, 2, -2));

// 9. Mid-way through a finished first season this week, second season
//    announced. Behind on released episodes, but actively watching.
shows.push(show(9, "Binging, Season 2 Announced"));
for (let e = 1; e <= 10; e++) episodes.push(ep(9, 1, e, 300 - e * 7));
for (let e = 1; e <= 3; e++) history.push(watched(9, 1, e, 2));
episodes.push(ep(9, 2, 1, -7));

const upcoming = buildUpcomingEpisodeRows(shows, episodes, history, STALE_THRESHOLD_DAYS, 50, NOW);
const upcomingNames = new Set(upcoming.map((r) => r.showName));
const episodesByShow = groupByShow(episodes);
const watchedByShow = groupByShow(history);

console.log(`Upcoming episodes, ${STALE_THRESHOLD_DAYS}-day staleness threshold, today = ${day(0)}\n`);
for (const s of shows) {
  const { state } = classifyShow(s, episodesByShow.get(s.tmdbId) ?? [], watchedByShow.get(s.tmdbId) ?? [], STALE_THRESHOLD_DAYS, NOW);
  const row = upcoming.find((r) => r.showId === s.tmdbId);
  const label = row ? `S${row.episode.seasonNumber}E${row.episode.episodeNumber} ${row.episode.airDate}` : "-";
  console.log(`${s.name.padEnd(30)} ${state.padEnd(12)} upcoming=${label}`);
}

const expectedUpcoming: Record<string, string | null> = {
  "Watching Weekly": "S1E6",
  "Caught Up, Long Break": "S2E1",
  "Caught Up, Season TBA": "S2E1",
  "Never Started": null,
  "Haven't Watched In Ages": null,
  "Stopped, Still Airing": null,
  "Stopped, Season Dropped": null,
  "Returned Last Week": "S2E2",
  "Binging, Season 2 Announced": "S2E1",
};
for (const [name, expected] of Object.entries(expectedUpcoming)) {
  const row = upcoming.find((r) => r.showName === name);
  const actual = row ? `S${row.episode.seasonNumber}E${row.episode.episodeNumber}` : null;
  if (actual !== expected) failures.push(`Upcoming: ${name} expected ${expected ?? "absent"}, got ${actual ?? "absent"}`);
}

// The two columns of Home must agree: anything in Upcoming is on Watch Next
// or caught up (on no Up Next list), and nothing in Upcoming is on the
// stale, not-started or stopped tabs.
const watchNextRows = buildWatchNextRows(shows, episodes, history, STALE_THRESHOLD_DAYS, null, NOW);
for (const row of watchNextRows) {
  if (row.category !== "watch-next" && upcomingNames.has(row.showName)) {
    failures.push(`Upcoming: ${row.showName} is on the "${row.category}" tab but still listed as upcoming`);
  }
}

// The TBA fix, seen from Watch Next: a caught-up show must not be offered an
// unaired, undated episode as its "next".
const tba = watchNextRows.find((r) => r.showName === "Caught Up, Season TBA");
if (tba) {
  const next = tba.nextEpisode ? `S${tba.nextEpisode.seasonNumber}E${tba.nextEpisode.episodeNumber}` : "none";
  failures.push(`Watch Next: "Caught Up, Season TBA" should be on no list, got ${tba.category} offering ${next}`);
}

// ---- Releasing this month ---------------------------------------------------

/** A fixed mid-month day, in local time like the section itself. */
const MID_MONTH = new Date(2026, 9, 16, 12);

function movie(tmdbId: number, title: string, fields: Partial<Movie>): Movie {
  return {
    tmdbId,
    title,
    posterPath: null,
    releaseYear: 2026,
    watched: false,
    watchedAt: null,
    wantsToWatch: true,
    ...fields,
  };
}

const movies: Movie[] = [
  movie(1, "Cinema Release", { releaseDate: "2026-10-24", theatricalReleaseDate: "2026-10-24", digitalReleaseDate: "2026-12-05" }),
  // Theatrical in August, at home this month: listed under its DIGITAL date.
  movie(2, "Home Release", { releaseDate: "2026-08-01", theatricalReleaseDate: "2026-08-01", digitalReleaseDate: "2026-10-20" }),
  // Never in cinemas. Its primary date is the streaming premiere.
  movie(3, "Streaming Original", { releaseDate: "2026-10-09", theatricalReleaseDate: null, digitalReleaseDate: "2026-10-09" }),
  // Looked up, and TMDB has no typed date: listed, untagged.
  movie(4, "Premiere Only", { releaseDate: "2026-10-28", theatricalReleaseDate: null, digitalReleaseDate: null }),
  // Never looked up: listed by its primary date, untagged rather than guessed.
  movie(5, "Not Looked Up", { releaseDate: "2026-10-05" }),
  // Both this month: the one still to come is the relevant one.
  movie(6, "Both This Month", { releaseDate: "2026-10-03", theatricalReleaseDate: "2026-10-03", digitalReleaseDate: "2026-10-28" }),
  // Same day for both, as TMDB sometimes records a day-and-date release.
  movie(7, "Day And Date", { releaseDate: "2026-10-09", theatricalReleaseDate: "2026-10-09", digitalReleaseDate: "2026-10-09" }),
  // In cinemas last month, digital date unknown: not "available digitally" just
  // because the theatrical run has started.
  movie(8, "Cinemas Last Month", { releaseDate: "2026-09-25", theatricalReleaseDate: "2026-09-25" }),
  // Watched: still listed, still tagged; the status line says Already Watched.
  movie(9, "Seen It", { releaseDate: "2026-10-02", theatricalReleaseDate: "2026-10-02", digitalReleaseDate: null, watched: true, wantsToWatch: false }),
  movie(10, "Back Catalogue", { releaseDate: "2019-05-01", theatricalReleaseDate: "2019-05-01", digitalReleaseDate: "2019-08-01" }),
];

const releasing = buildReleasingThisMonth(movies, MID_MONTH, 50);
console.log(`\nReleasing this month, today = 2026-10-16\n`);
for (const row of releasing) {
  console.log(`${row.movie.title.padEnd(22)} ${row.date}  ${row.releaseKind ?? "(no tag)"}`);
}

const expectedReleasing: Record<string, [string, string | null] | null> = {
  "Cinema Release": ["2026-10-24", "theatrical"],
  "Home Release": ["2026-10-20", "digital"],
  "Streaming Original": ["2026-10-09", "digital"],
  "Premiere Only": ["2026-10-28", null],
  "Not Looked Up": ["2026-10-05", null],
  "Both This Month": ["2026-10-28", "digital"],
  "Day And Date": ["2026-10-09", "theatrical"],
  "Cinemas Last Month": null,
  "Seen It": ["2026-10-02", "theatrical"],
  "Back Catalogue": null,
};
for (const [title, expected] of Object.entries(expectedReleasing)) {
  const row = releasing.find((r) => r.movie.title === title);
  const actual = row ? [row.date, row.releaseKind] : null;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`Releasing: ${title} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const order = releasing.map((r) => r.date);
if (order.join() !== [...order].sort().join()) failures.push(`Releasing: not sorted by date (${order.join(", ")})`);

// Which release counts when both fall in the month depends on the day.
const both = movies.find((m) => m.title === "Both This Month")!;
const early = releaseThisMonth(both, new Date(2026, 9, 1, 12));
const late = releaseThisMonth(both, new Date(2026, 9, 30, 12));
if (early?.releaseKind !== "theatrical") failures.push(`Releasing: before both dates should be theatrical, got ${early?.releaseKind}`);
if (late?.releaseKind !== "digital") failures.push(`Releasing: after both dates should be the later (digital), got ${late?.releaseKind}`);

// Lookups are spent only on movies that could be releasing this month and
// have never been asked about.
const needing = moviesNeedingTypedDates(movies, MID_MONTH).map((m) => m.title);
const expectedNeeding = ["Not Looked Up", "Cinemas Last Month"];
if (needing.join() !== expectedNeeding.join()) {
  failures.push(`Typed-date lookups: expected ${expectedNeeding.join(", ")}, got ${needing.join(", ") || "none"}`);
}

console.log();
if (failures.length === 0) {
  console.log("All scenarios pass.");
} else {
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  process.exitCode = 1;
}
