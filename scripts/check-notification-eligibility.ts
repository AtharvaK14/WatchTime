/**
 * Scenario check for WHICH shows may produce release notifications, run with
 * `npm run check:notification-eligibility`.
 *
 * The report: new-episode notifications for American Horror Story (TMDB 1413)
 * and Grey's Anatomy (TMDB 1416), neither of which the user had started. Both
 * are mid-season on weekly schedules as of 2026-10-29, read from TMDB:
 * Grey's Anatomy S23 airs Thursdays from 2026-10-15 to 2026-11-19, and
 * American Horror Story S13 ends on 2026-10-29.
 *
 * What it was: the notification builder announced every release of every show
 * in the library that was not archived. It never looked at watch history, so
 * a show the user had never started was announced like one they watch every
 * week. Upcoming episodes had been moved off that rule onto "actively
 * following" on 2026-10-16; notifications had not. Now both read
 * releaseAlertEligibility() / isActivelyFollowing() in lib/watchNext.ts.
 *
 * Same shape as the other scripts: hand-built rows, the app's own pure
 * functions, no framework. Show ids other than the two above are synthetic.
 */

import { readFileSync } from "node:fs";
import type { Episode, Show, WatchedEpisode } from "../src/db";
import { buildUpcomingEpisodeRows } from "../src/lib/comingUp";
import {
  notificationId,
  planNotifications,
  selectForDelivery,
  type NotificationEvent,
  type NotificationPlan,
} from "../src/lib/notifications/events";
import { releaseAlertEligibility } from "../src/lib/watchNext";

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

/** 08:00 local on the day of the report, when Grey's S23E03 and AHS S13E13 come out. */
const NOW = new Date("2026-10-29T08:00:00");
const TODAY = "2026-10-29";
const THRESHOLD = 60;

function day(offset: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function iso(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * 86400000).toISOString();
}

function show(tmdbId: number, name: string, fields: Partial<Show> = {}): Show {
  return {
    tmdbId,
    name,
    posterPath: "/poster.jpg",
    firstAirYear: 2005,
    status: "Returning Series",
    addedAt: "2025-01-01T00:00:00.000Z",
    isFollowed: true,
    isArchived: false,
    lastWatchedAt: null,
    ...fields,
  };
}

function season(showId: number, seasonNumber: number, dates: (string | null)[]): Episode[] {
  return dates.map((airDate, i) => ({
    key: `${showId}-${seasonNumber}-${i + 1}`,
    showId,
    seasonNumber,
    episodeNumber: i + 1,
    name: `S${seasonNumber}E${i + 1}`,
    overview: null,
    airDate,
    tmdbRating: 0,
    stillPath: null,
    runtimeMinutes: 45,
  }));
}

function watched(eps: Episode[], at: string): WatchedEpisode[] {
  return eps.map((ep) => ({
    key: ep.key,
    showId: ep.showId,
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.episodeNumber,
    watchedAt: at,
    watchCount: 1,
    lastWatchedAt: at,
  }));
}

function plan(shows: Show[], episodes: Episode[], history: WatchedEpisode[], now = NOW): NotificationPlan {
  return planNotifications(shows, episodes, history, [], now, THRESHOLD);
}

function forShow(events: NotificationEvent[], id: number): NotificationEvent[] {
  return events.filter((e) => e.eventId.startsWith(`release:${id}:`));
}

function describe(events: NotificationEvent[]): string {
  return events.map((e) => `${e.date} ${e.kind} "${e.body}"`).join("; ") || "none";
}

// ---- Fixtures: TMDB, read 2026-10-29 -----------------------------------------

const GREYS = 1416;
const AHS = 1413;
const greysS22 = season(GREYS, 22, Array(18).fill("2025-10-09"));
const greysS23 = season(GREYS, 23, ["2026-10-15", "2026-10-22", "2026-10-29", "2026-11-05", "2026-11-12", "2026-11-19"]);
const ahsS12 = season(AHS, 12, Array(9).fill("2023-09-20"));
const ahsS13 = season(AHS, 13, [
  "2026-09-24", "2026-09-24", "2026-09-24", "2026-10-01", "2026-10-01", "2026-10-01",
  "2026-10-08", "2026-10-08", "2026-10-15", "2026-10-15", "2026-10-22", "2026-10-22", "2026-10-29",
]);
const reportedEpisodes = [...greysS22, ...greysS23, ...ahsS12, ...ahsS13];

async function main() {
  // 1-3. The report. Both in the library, never watched: nothing announced -
  //      however the show got there, whatever TV Time said about it.
  const greys = show(GREYS, "Grey's Anatomy", { tvTimeStatus: "not_started_yet" });
  const ahs = show(AHS, "American Horror Story", { tvTimeStatus: "watch_later" });
  const reported = plan([greys, ahs], reportedEpisodes, []);
  console.log(`Not started (the report): announced ${describe(reported.events)}`);
  console.log(`  left out: ${reported.excluded.map((x) => `${x.title} ${x.date} (${x.reason})`).join("; ")}`);
  check(reported.events.length === 0, `1. No watch history: expected no events, got ${describe(reported.events)}`);
  check(
    reported.excluded.length === 5 && reported.excluded.every((x) => x.reason === "not-started"),
    `1. The five releases should be found and left out as not-started, got ${reported.excluded.map((x) => x.reason).join(", ")}`
  );
  // An imported "continuing" status is not watch history.
  const claimed = plan([show(GREYS, "Grey's Anatomy", { tvTimeStatus: "continuing" })], greysS23, []);
  check(claimed.events.length === 0, `3. An imported "continuing" status without watches must not be announced`);
  // Episodes cached for a show outside the library (the details panel caches a
  // preview's seasons) must never be announced.
  const preview = plan([], reportedEpisodes, watched(greysS22, iso(-300)));
  check(preview.events.length === 0 && preview.excluded.length === 0, `2. A show not in the library produced ${describe(preview.events)}`);
  // Upcoming episodes already agreed.
  check(buildUpcomingEpisodeRows([greys, ahs], reportedEpisodes, [], THRESHOLD, 50, NOW).length === 0, "Upcoming lists an unstarted show");

  // 4. The same shows, actually watched: announced, weekly, one per episode.
  const greysWatcher = watched([...greysS22, ...greysS23.slice(0, 2)], iso(-6));
  const ahsWatcher = watched([...ahsS12, ...ahsS13.slice(0, 12)], iso(-5));
  const active = plan([greys, ahs], reportedEpisodes, [...greysWatcher, ...ahsWatcher]);
  console.log(`Watching both: announced ${describe(active.events)}`);
  check(
    forShow(active.events, GREYS).map((e) => e.date).join() === "2026-10-29,2026-11-05,2026-11-12,2026-11-19",
    `4. Grey's, watched to E2: expected E3-E6, got ${describe(forShow(active.events, GREYS))}`
  );
  check(
    forShow(active.events, AHS).length === 1 && forShow(active.events, AHS)[0].body === "S13E13 is now available",
    `4. AHS, watched to E12: expected the finale, got ${describe(forShow(active.events, AHS))}`
  );

  // 5. Caught up two years ago, the new season ten days out. A long gap is not
  //    giving up: announced, as one batch.
  const LONG_GAP = 9001;
  const gapS1 = season(LONG_GAP, 1, Array(8).fill(day(-800)));
  const gapS2 = season(LONG_GAP, 2, Array(8).fill(day(10)));
  const gapShow = show(LONG_GAP, "Long Gap");
  const gapHistory = watched(gapS1, iso(-780));
  const gap = plan([gapShow], [...gapS1, ...gapS2], gapHistory);
  console.log(`Caught up, two-year gap: ${describe(gap.events)}`);
  check(
    gap.events.length === 1 && gap.events[0].kind === "season-premiere" && gap.events[0].body === "Season 2 is now available",
    `5. Returning after a long gap: expected one season event, got ${describe(gap.events)}`
  );

  // 6. Stopped, same show: nothing, new season or not.
  const stopped = plan([{ ...gapShow, isArchived: true }], [...gapS1, ...gapS2], gapHistory);
  check(stopped.events.length === 0 && stopped.excluded[0]?.reason === "stopped", `6. Stopped: expected nothing, got ${describe(stopped.events)}`);

  // 7. Resumed, as resumeWatchingShow() writes it: announced again, same id.
  const resumed = plan([{ ...gapShow, isArchived: false, isFollowed: true }], [...gapS1, ...gapS2], gapHistory);
  check(resumed.events[0]?.eventId === gap.events[0]?.eventId, `7. Resumed: expected the release back with its id, got ${describe(resumed.events)}`);

  // 8. A queued notification whose show becomes ineligible before delivery.
  //    (a) By the user: every reschedule replaces the whole native schedule,
  //        so a release dropped from the plan is dropped from the queue.
  const before = selectForDelivery(gap.events, () => true, TODAY, 150).map((e) => e.eventId);
  const after = selectForDelivery(stopped.events, () => true, TODAY, 150).map((e) => e.eventId);
  check(before.length === 1 && after.length === 0, "8a. Stopping a show must take its queued release out of the schedule");
  //    (b) By time alone: watched 50 days ago and behind. Home has it in Watch
  //        Next today; by a release 20 days out it is Haven't Watched For a
  //        While, so that one is not queued. Five days out still is.
  const DRIFT = 9002;
  const driftS1 = season(DRIFT, 1, Array(10).fill("2025-03-01"));
  const driftS2 = season(DRIFT, 2, [day(5), day(20)]);
  const driftShow = show(DRIFT, "Drifting");
  const driftHistory = watched(driftS1.slice(0, 3), iso(-50));
  const drift = plan([driftShow], [...driftS1, ...driftS2], driftHistory);
  const todayState = releaseAlertEligibility(driftShow, [...driftS1, ...driftS2], driftHistory, THRESHOLD, NOW);
  console.log(
    `Drifting (watched 50 days ago, behind): today ${todayState.state}; announced ${describe(drift.events)}; ` +
      `left out ${drift.excluded.map((x) => `${x.date} (${x.reason})`).join("; ")}`
  );
  check(todayState.eligible && todayState.state === "watch-next", `8b. Drifting should be eligible today, got ${todayState.state}`);
  check(drift.events.map((e) => e.date).join() === day(5), `8b. Expected only the release 5 days out, got ${describe(drift.events)}`);
  check(drift.excluded[0]?.date === day(20) && drift.excluded[0]?.reason === "stale", "8b. The release 20 days out should be left out as stale");
  //        Watching again (which reschedules) brings it back.
  const caughtUpAgain = plan([driftShow], [...driftS1, ...driftS2], [...driftHistory, ...watched(driftS1.slice(3, 4), iso(0))]);
  check(caughtUpAgain.events.length === 2, `8b. A new watch should restore the later release, got ${describe(caughtUpAgain.events)}`);
  //    (c) What an older build queued: native only delivers a schedule of the
  //        version this build writes, and the two sides must agree.
  const bridgeVersion = Number(/SCHEDULE_PAYLOAD_VERSION = (\d+)/.exec(readFileSync("src/lib/notifications/bridge.ts", "utf8"))?.[1]);
  const nativeVersion = Number(
    /SUPPORTED_VERSION = (\d+)/.exec(
      readFileSync("android/app/src/main/java/com/indie/watchtime/notify/ReleaseNotifier.java", "utf8")
    )?.[1]
  );
  console.log(`Schedule payload version: web ${bridgeVersion}, native ${nativeVersion}`);
  check(bridgeVersion === nativeVersion, `8c. Web writes version ${bridgeVersion}, native reads ${nativeVersion}`);
  check(bridgeVersion >= 2, "8c. Schedules from builds before this rule (version 1) must not be deliverable");

  // 9. Unknown or incomplete state is never read as eligible.
  const unknownFollow = plan([{ ...gapShow, isFollowed: undefined as unknown as boolean }], [...gapS1, ...gapS2], gapHistory);
  check(unknownFollow.events.length === 0 && unknownFollow.excluded[0]?.reason === "not-followed", "9. A show with no follow flag was announced");
  const undatedWatches = gapHistory.map((w) => ({ ...w, watchedAt: "", lastWatchedAt: "" }));
  // Behind, so neither caught up nor reactivated: only a watch date could make it eligible.
  const undated = plan([driftShow], [...driftS1, ...driftS2], driftHistory.map((w) => ({ ...w, watchedAt: "" })));
  check(undated.events.length === 0 && undated.excluded.every((x) => x.reason === "unknown-progress"), `9. Watches with no date: got ${describe(undated.events)}`);
  // Caught up is established by the episodes alone, so it stays eligible.
  check(plan([gapShow], [...gapS1, ...gapS2], undatedWatches).events.length === 1, "9. Caught up with undated watches should still be announced");

  // 10. Categories. Turning one off removes exactly those.
  const mixed = plan([greys, ahs, gapShow], [...reportedEpisodes, ...gapS1, ...gapS2], [...greysWatcher, ...ahsWatcher, ...gapHistory]).events;
  const noEpisodes = selectForDelivery(mixed, (k) => k !== "episode", TODAY, 150);
  const nothing = selectForDelivery(mixed, () => false, TODAY, 150);
  check(noEpisodes.length === 1 && noEpisodes[0].kind === "season-premiere", `10. "New episodes" off should leave only the season, got ${describe(noEpisodes)}`);
  check(nothing.length === 0, "10. Every category off must deliver nothing");

  // 11. Batch vs weekly: one event per same-day drop, one per week otherwise.
  check(forShow(mixed, LONG_GAP).length === 1 && forShow(mixed, LONG_GAP)[0].target.kind === "show", "11. A batch is one event opening the show");
  check(forShow(mixed, GREYS).every((e) => e.kind === "episode" && e.target.kind === "episode"), "11. A weekly release is per episode");
  const WEEKLY = 9003;
  const weeklyS1 = season(WEEKLY, 1, Array(6).fill("2025-01-01"));
  const weeklyS2 = season(WEEKLY, 2, [day(3), day(10), day(17)]);
  const weekly = plan([show(WEEKLY, "Weekly")], [...weeklyS1, ...weeklyS2], watched(weeklyS1, iso(-200))).events;
  check(
    weekly.length === 3 && weekly[0].body === "Season 2 premieres today" && weekly[1].body === "S02E02 is now available",
    `11. Weekly premiere then episodes, got ${describe(weekly)}`
  );

  // 12. Duplicates. Ids are stable across rebuilds and across an eligibility
  //     round trip, which is what native's posted-id set keys on.
  const again = plan([greys, ahs], reportedEpisodes, [...greysWatcher, ...ahsWatcher]);
  check(
    JSON.stringify(again.events.map((e) => [e.eventId, notificationId(e.eventId)])) ===
      JSON.stringify(active.events.map((e) => [e.eventId, notificationId(e.eventId)])),
    "12. Rebuilding the same library changed event or notification ids"
  );
  check(new Set(active.events.map((e) => e.eventId)).size === active.events.length, "12. Two events share an id");

  console.log();
  if (failures.length === 0) {
    console.log("All scenarios pass.");
  } else {
    for (const f of failures) console.log(`FAIL  ${f}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
