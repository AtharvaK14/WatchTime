/**
 * Scenario check for which show a season belongs to, run with
 * `npm run check:season-association`.
 *
 * The report: with The Terminal List (TMDB 120911) and its spin-off The
 * Terminal List: Dark Wolf (TMDB 219760) both in the library, the original's
 * new Season 2 also appeared under Dark Wolf.
 *
 * What it turned out to be. The two shows never share an identifier anywhere
 * in the app - every episode, watch record and notification is keyed by TMDB
 * id, and nothing matches titles. TMDB itself lists a "Season 2" under Dark
 * Wolf: eight episodes named "Episode 1".."Episode 8", no dates, created on
 * 2026-10-21 (the day the original's season came out) with the original's
 * synopsis as its overview. The app's part was reading that undated season as
 * released, so it was offered in Up Next as "S02 | E01 +7" right beside the
 * real one. See unconfirmedSeasons() in lib/episodeSync.ts.
 *
 * By default this uses TMDB's data as read on 2026-10-28. Set TMDB_API_KEY to
 * run the same checks against what TMDB returns today:
 *
 *   TMDB_API_KEY=... npm run check:season-association
 *
 * Every check runs the app's own functions (Up Next, Upcoming episodes, the
 * notification builder, the widget snapshot, the sync decisions); the ids live
 * only in this script.
 */

import type { Episode, Show, WatchedEpisode } from "../src/db";
import { buildUpcomingEpisodeRows } from "../src/lib/comingUp";
import {
  episodeTotalToStore,
  findNextUnwatched,
  isAvailableToWatch,
  seasonsNeedingRefresh,
  seasonsNoLongerListed,
  totalEpisodeCount,
  unconfirmedSeasons,
} from "../src/lib/episodeSync";
import { buildNotificationEvents } from "../src/lib/notifications/events";
import { buildWidgetSnapshot } from "../src/lib/widget/snapshot";
import { buildWatchNextRows, classifyShow, groupByShow, hasNextAfterWatching } from "../src/lib/watchNext";

// The widget snapshot reads the staleness threshold from localStorage, which
// Node does not have. Empty storage is the app's default of 60 days.
(globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => {} };

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

// ---- Data ------------------------------------------------------------------

interface SeasonData {
  season_number: number;
  episodes: { episode_number: number; name: string; air_date: string | null }[];
}
interface ShowData {
  id: number;
  name: string;
  seasons: SeasonData[];
}

function season(n: number, dates: (string | null)[], names?: string[]): SeasonData {
  return {
    season_number: n,
    episodes: dates.map((air_date, i) => ({
      episode_number: i + 1,
      name: names?.[i] ?? `Episode ${i + 1}`,
      air_date,
    })),
  };
}

const TERMINAL_LIST = 120911;
const DARK_WOLF = 219760;

const FIXTURES: ShowData[] = [
  {
    id: TERMINAL_LIST,
    name: "The Terminal List",
    seasons: [season(1, Array(8).fill("2022-06-30")), season(2, Array(8).fill("2026-10-21"))],
  },
  {
    id: DARK_WOLF,
    name: "The Terminal List: Dark Wolf",
    seasons: [
      season(1, ["2025-08-27", "2025-08-27", "2025-08-27", "2025-09-03", "2025-09-10", "2025-09-17", "2025-09-24"]),
      // The season TMDB lists under the spin-off: no names, no dates.
      season(2, Array(8).fill(null)),
    ],
  },
];

const apiKey = process.env.TMDB_API_KEY;

async function tmdb<T>(path: string): Promise<T> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", apiKey!);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function liveShow(id: number): Promise<ShowData> {
  const details = await tmdb<{ name: string; seasons: { season_number: number }[] }>(`/tv/${id}`);
  const seasons: SeasonData[] = [];
  for (const s of details.seasons.filter((s) => s.season_number > 0)) {
    seasons.push(await tmdb<SeasonData>(`/tv/${id}/season/${s.season_number}`));
  }
  return { id, name: details.name, seasons };
}

// ---- Helpers -----------------------------------------------------------------

function toShow(data: ShowData): Show {
  return {
    tmdbId: data.id,
    name: data.name,
    posterPath: "/poster.jpg",
    firstAirYear: 2022,
    status: "Returning Series",
    addedAt: "2025-01-01T00:00:00.000Z",
    isFollowed: true,
    isArchived: false,
    lastWatchedAt: null,
  };
}

/** Rows exactly as toEpisodeRecords() writes them: keyed by the show's TMDB id. */
function toEpisodes(data: ShowData): Episode[] {
  return data.seasons.flatMap((s) =>
    s.episodes.map((e) => ({
      key: `${data.id}-${s.season_number}-${e.episode_number}`,
      showId: data.id,
      seasonNumber: s.season_number,
      episodeNumber: e.episode_number,
      name: e.name,
      overview: null,
      airDate: e.air_date,
      tmdbRating: 0,
      stillPath: null,
      runtimeMinutes: 50,
    }))
  );
}

/** The show details response's season summaries; air_date is the season premiere. */
function detailsOf(data: ShowData) {
  return {
    id: data.id,
    seasons: data.seasons.map((s) => ({
      season_number: s.season_number,
      episode_count: s.episodes.length,
      name: `Season ${s.season_number}`,
      air_date: s.episodes.map((e) => e.air_date).filter((d): d is string => !!d).sort()[0] ?? null,
    })),
  };
}

function watchedSeason(data: ShowData, seasonNumber: number, at: string): WatchedEpisode[] {
  const s = data.seasons.find((x) => x.season_number === seasonNumber)!;
  return s.episodes.map((e) => ({
    key: `${data.id}-${seasonNumber}-${e.episode_number}`,
    showId: data.id,
    seasonNumber,
    episodeNumber: e.episode_number,
    watchedAt: at,
    watchCount: 1,
    lastWatchedAt: at,
  }));
}

function bySeason(episodes: Episode[]): Map<number, Episode[]> {
  const map = new Map<number, Episode[]>();
  for (const ep of episodes) map.set(ep.seasonNumber, [...(map.get(ep.seasonNumber) ?? []), ep]);
  return map;
}

/** Local noon on a calendar day, the way the app reads "today". */
function at(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

function label(ep: { seasonNumber: number; episodeNumber: number } | null | undefined): string {
  return ep ? `S${ep.seasonNumber}E${ep.episodeNumber}` : "none";
}

/** findNextUnwatched() as it was before this change: an undated episode was available unless an unaired one came first. */
function oldNextUnwatched(episodes: Episode[], watchedKeys: Set<string>, today: string): Episode | null {
  const sorted = [...episodes].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  let afterAnUnairedEpisode = false;
  for (const ep of sorted) {
    if (!isAvailableToWatch(ep.airDate, today)) {
      afterAnUnairedEpisode = true;
      continue;
    }
    if (!ep.airDate && afterAnUnairedEpisode) continue;
    if (!watchedKeys.has(ep.key)) return ep;
  }
  return null;
}

// ---- Run ---------------------------------------------------------------------

async function main() {
  const data = apiKey ? await Promise.all(FIXTURES.map((s) => liveShow(s.id))) : FIXTURES;
  console.log(apiKey ? "Using live TMDB data.\n" : "Using TMDB data read 2026-10-28 (set TMDB_API_KEY to use live data).\n");

  const [tl, dw] = data;
  const shows = data.map(toShow);
  const episodes = data.flatMap(toEpisodes);
  const NOW = at("2026-10-28");
  const today = "2026-10-28";

  for (const d of data) {
    const unconfirmed = unconfirmedSeasons(toEpisodes(d));
    console.log(
      `${d.name} (${d.id}): ` +
        d.seasons
          .map((s) => {
            const dates = [...new Set(s.episodes.map((e) => e.air_date ?? "undated"))];
            return `S${s.season_number} ${s.episodes.length} eps [${dates.length > 2 ? `${dates[0]}..${dates[dates.length - 1]}` : dates.join(", ")}]`;
          })
          .join("; ") +
        (unconfirmed.size > 0 ? `  unconfirmed: ${[...unconfirmed].map((n) => `S${n}`).join(", ")}` : "")
    );
  }
  const dwHasUnconfirmedSeason = unconfirmedSeasons(toEpisodes(dw)).size > 0;
  console.log();

  // 1. Identity. Every row is keyed by the show it belongs to, and the two
  //    shows have no key in common.
  for (const d of data) {
    for (const ep of toEpisodes(d)) {
      check(ep.showId === d.id && ep.key.startsWith(`${d.id}-`), `Identity: ${ep.key} is not keyed by ${d.name}'s id`);
    }
  }
  const tlKeys = new Set(toEpisodes(tl).map((e) => e.key));
  check(!toEpisodes(dw).some((e) => tlKeys.has(e.key)), "Identity: the two shows share an episode key");
  const grouped = groupByShow(episodes);
  check(
    grouped.get(TERMINAL_LIST)?.length === toEpisodes(tl).length && grouped.get(DARK_WOLF)?.length === toEpisodes(dw).length,
    "Identity: grouping by show mixed the two shows' episodes"
  );

  // 2. Up Next. Both first seasons watched; only the original has anything new.
  //    Dark Wolf is checked having been finished recently (where the old rule
  //    put it in Watch Next next to the original) and long ago (stale).
  for (const [when, dwWatchedAt] of [
    ["recently", "2026-10-18T20:00:00.000Z"],
    ["long ago", "2025-09-25T20:00:00.000Z"],
  ] as const) {
    const history = [...watchedSeason(tl, 1, "2022-07-10T20:00:00.000Z"), ...watchedSeason(dw, 1, dwWatchedAt)];
    const rows = buildWatchNextRows(shows, episodes, history, 60, null, NOW);
    const tlRow = rows.find((r) => r.showId === TERMINAL_LIST);
    const dwRow = rows.find((r) => r.showId === DARK_WOLF);
    const dwOld = oldNextUnwatched(toEpisodes(dw), new Set(history.map((w) => w.key)), today);
    console.log(
      `Up Next, Dark Wolf finished ${when}: The Terminal List ${tlRow ? `${tlRow.category} ${label(tlRow.nextEpisode)} +${tlRow.additionalCount}${tlRow.newlyAvailable ? " NEW" : ""}` : "absent"}; ` +
        `Dark Wolf ${dwRow ? `${dwRow.category} ${label(dwRow.nextEpisode)}` : "on no list (caught up)"}; old rule offered Dark Wolf ${label(dwOld)}`
    );
    check(tlRow?.category === "watch-next", `Up Next (${when}): The Terminal List should be in Watch Next, got ${tlRow?.category ?? "absent"}`);
    check(label(tlRow?.nextEpisode) === "S2E1", `Up Next (${when}): The Terminal List should offer S2E1, got ${label(tlRow?.nextEpisode)}`);
    check(tlRow?.additionalCount === 7, `Up Next (${when}): The Terminal List should be +7, got +${tlRow?.additionalCount}`);
    check(tlRow?.newlyAvailable === true, `Up Next (${when}): The Terminal List's season should be NEW`);
    check(!dwRow, `Up Next (${when}): Dark Wolf should be on no list, got ${dwRow?.category} offering ${label(dwRow?.nextEpisode)}`);
    if (dwHasUnconfirmedSeason) {
      check(dwOld?.seasonNumber === 2, `Up Next (${when}): expected the old rule to offer Dark Wolf's undated season (the bug this reproduces)`);
    }
    for (const row of rows) {
      check(!row.nextEpisode || row.nextEpisode.showId === row.showId, `Up Next: ${row.showName} offered another show's episode`);
    }

    // Upcoming episodes: nothing dated is ahead for either show.
    const upcoming = buildUpcomingEpisodeRows(shows, episodes, history, 60, 50, NOW);
    check(!upcoming.some((r) => r.showId === DARK_WOLF), `Upcoming (${when}): Dark Wolf listed with ${label(upcoming[0]?.episode)}`);

    // The widget is built from the same lists, so it must agree.
    const snapshot = buildWidgetSnapshot(shows, episodes, history, [], NOW);
    check(
      !snapshot.watchNext.some((r) => r.showId === DARK_WOLF) && !snapshot.comingUp.some((r) => r.showId === DARK_WOLF),
      `Widget (${when}): Dark Wolf appears in the widget`
    );
    check(
      snapshot.watchNext.every((r) => r.episodeKey.startsWith(`${r.showId}-`)),
      `Widget (${when}): a row points at another show's episode`
    );
  }

  // 3. Notifications, on release day. One event, for the original only. Both
  //    first seasons watched, so both shows are ones the user follows.
  const followedHistory = [...watchedSeason(tl, 1, "2022-07-10T20:00:00.000Z"), ...watchedSeason(dw, 1, "2025-09-25T20:00:00.000Z")];
  const releaseDay = buildNotificationEvents(shows, episodes, followedHistory, [], at("2026-10-21"));
  console.log(`\nNotifications on 2026-10-21: ${releaseDay.map((e) => `"${e.title}: ${e.body}" [${e.eventId}]`).join("; ") || "none"}`);
  check(releaseDay.length === 1, `Notifications: expected 1 event on release day, got ${releaseDay.length}`);
  const event = releaseDay[0];
  check(event?.eventId === `release:${TERMINAL_LIST}:2:2026-10-21`, `Notifications: unexpected event id ${event?.eventId}`);
  check(event?.title === tl.name && event?.body === "Season 2 is now available", `Notifications: unexpected text "${event?.title}: ${event?.body}"`);
  check(
    event?.target.kind === "show" && event.target.tmdbId === TERMINAL_LIST && event.target.seasonNumber === 2,
    "Notifications: the event must open The Terminal List on Season 2"
  );
  check(
    !buildNotificationEvents(shows, episodes, followedHistory, [], NOW).some((e) => e.eventId.includes(`:${DARK_WOLF}:`)),
    "Notifications: Dark Wolf must never produce an event"
  );

  // 4. Watch state stays per show. Marking one show's episodes changes nothing
  //    about the other, and finishing Dark Wolf's only real season is the end.
  const base = [...watchedSeason(tl, 1, "2022-07-10T20:00:00.000Z"), ...watchedSeason(dw, 1, "2026-10-18T20:00:00.000Z")];
  const plusTl = [...base, ...watchedSeason(tl, 2, "2026-10-27T20:00:00.000Z")];
  const dwEpisodes = toEpisodes(dw);
  const dwBefore = classifyShow(shows[1], dwEpisodes, base.filter((w) => w.showId === DARK_WOLF), 60, NOW);
  const dwAfter = classifyShow(shows[1], dwEpisodes, plusTl.filter((w) => w.showId === DARK_WOLF), 60, NOW);
  check(
    dwBefore.state === dwAfter.state && label(dwBefore.next) === label(dwAfter.next) && dwBefore.watchedKeys.size === dwAfter.watchedKeys.size,
    "Watch state: watching The Terminal List's season 2 changed Dark Wolf"
  );
  check(dwBefore.state === "caught-up", `Watch state: Dark Wolf should be caught up, got ${dwBefore.state}`);
  const tlAfter = classifyShow(shows[0], toEpisodes(tl), plusTl.filter((w) => w.showId === TERMINAL_LIST), 60, NOW);
  check(tlAfter.state === "caught-up", `Watch state: The Terminal List should be caught up after its season 2, got ${tlAfter.state}`);
  const dwFinale = `${DARK_WOLF}-1-${dw.seasons[0].episodes.length}`;
  const almost = base.filter((w) => w.key !== dwFinale);
  check(
    !hasNextAfterWatching(episodes, almost, DARK_WOLF, dwFinale),
    "Watch state: marking Dark Wolf's season 1 finale should end the show (That's all folks!), not lead into the undated season"
  );
  check(
    hasNextAfterWatching(episodes, base, TERMINAL_LIST, `${TERMINAL_LIST}-2-1`),
    "Watch state: marking The Terminal List S2E1 should leave S2E2 next"
  );

  // 5. Sync decisions are per show, and a season TMDB withdraws leaves the cache.
  for (const d of data) {
    for (const r of seasonsNeedingRefresh(detailsOf(d), bySeason(toEpisodes(d)), NOW, new Map())) {
      check(d.seasons.some((s) => s.season_number === r.seasonNumber), `Sync: ${d.name} asked to refresh a season it does not have`);
    }
    check(seasonsNoLongerListed(detailsOf(d), bySeason(toEpisodes(d))).length === 0, `Sync: ${d.name} pruned a season TMDB still lists`);
  }
  const corrected = { ...dw, seasons: dw.seasons.filter((s) => s.season_number === 1) };
  const withdrawn = seasonsNoLongerListed(detailsOf(corrected), bySeason(toEpisodes(dw)));
  console.log(`Sync, once TMDB lists Dark Wolf with season 1 only: cached seasons dropped: ${withdrawn.map((n) => `S${n}`).join(", ") || "none"}`);
  if (dwHasUnconfirmedSeason) check(withdrawn.join() === "2", `Sync: expected Dark Wolf's withdrawn season 2 to be dropped, got ${withdrawn.join() || "none"}`);
  check(
    seasonsNoLongerListed({ seasons: [] }, bySeason(toEpisodes(dw))).length === 0,
    "Sync: an empty season list must not wipe the cache"
  );
  check(
    seasonsNoLongerListed({ seasons: [{ season_number: 0, episode_count: 3, name: "Specials" }] }, bySeason(toEpisodes(dw))).length === 0,
    "Sync: a list of specials only must not wipe the cache"
  );

  // 6. The show's episode total, which the Shows grid's progress bar divides by.
  console.log(`Episode totals: ${tl.name} ${totalEpisodeCount(detailsOf(tl).seasons)}, ${dw.name} ${totalEpisodeCount(detailsOf(dw).seasons)}`);
  check(totalEpisodeCount(detailsOf(tl).seasons) === 16, `Totals: The Terminal List should count 16, got ${totalEpisodeCount(detailsOf(tl).seasons)}`);
  check(totalEpisodeCount(detailsOf(dw).seasons) === 7 || !dwHasUnconfirmedSeason, `Totals: Dark Wolf's undated season must not be counted, got ${totalEpisodeCount(detailsOf(dw).seasons)}`);

  // The stored total is kept current by each sync. Each show's from its own
  // details only, written only when it changed, and never from a bad response.
  const tlTotal = totalEpisodeCount(detailsOf(tl).seasons);
  const dwTotal = totalEpisodeCount(detailsOf(dw).seasons);
  const totalCases: [string, number | null | undefined, ReturnType<typeof detailsOf> | { seasons: [] }, number | null][] = [
    // Added before its second season existed: the grid read 8 of 8.
    ["The Terminal List, stored before S2", 8, detailsOf(tl), tlTotal],
    ["The Terminal List, already current", tlTotal, detailsOf(tl), null],
    // Stored while the undated season was still being counted.
    ["Dark Wolf, stored with the undated season", 15, detailsOf(dw), dwTotal === 15 ? null : dwTotal],
    ["Dark Wolf, already current", dwTotal, detailsOf(dw), null],
    ["Never stored", undefined, detailsOf(tl), tlTotal],
    ["Failed backfill (null)", null, detailsOf(dw), dwTotal],
    ["Empty season list", tlTotal, { seasons: [] }, null],
  ];
  for (const [name, stored, details, expected] of totalCases) {
    const actual = episodeTotalToStore(stored, details);
    console.log(`  stored ${String(stored).padEnd(9)} -> ${actual === null ? "unchanged" : `write ${actual}`}  (${name})`);
    check(actual === expected, `Stored total, ${name}: expected ${expected === null ? "unchanged" : expected}, got ${actual === null ? "unchanged" : actual}`);
  }
  check(
    episodeTotalToStore(tlTotal, { seasons: [{ season_number: 0, episode_count: 3, name: "Specials" }] }) === null,
    "Stored total: a list of specials only must not overwrite the total"
  );

  // 7. Legitimate shapes keep working. Synthetic ids, dated relative to the
  //    real clock because findNextUnwatched() reads it.
  const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const synthetic = (id: number, seasons: SeasonData[]): ShowData => ({ id, name: `Show ${id}`, seasons });
  const cases: { name: string; show: ShowData; watched: [number, number][]; next: string; total: number }[] = [
    // A whole new season, released last week.
    { name: "Season dropped", show: synthetic(1, [season(1, [day(-400), day(-400)]), season(2, [day(-7), day(-7)])]), watched: [[1, 1], [1, 2]], next: "S2E1", total: 4 },
    // Weekly: this week's episode out, next week's dated ahead.
    { name: "Weekly", show: synthetic(2, [season(1, [day(-14), day(-7), day(7)])]), watched: [[1, 1]], next: "S1E2", total: 3 },
    // A season that has started, with TMDB missing the later dates (the Spider-Noir reading).
    { name: "Started, later dates missing", show: synthetic(3, [season(1, [day(-400)]), season(2, [day(-10), null, null])]), watched: [[1, 1], [2, 1]], next: "S2E2", total: 4 },
    // An undated season with an aired season after it has aired itself.
    { name: "Undated middle season", show: synthetic(4, [season(1, [day(-900)]), season(2, [null, null]), season(3, [day(-30)])]), watched: [[1, 1]], next: "S2E1", total: 4 },
    // No dates anywhere: no evidence either way, so the old reading stands.
    { name: "No dates at all", show: synthetic(5, [season(1, [null, null])]), watched: [[1, 1]], next: "S1E2", total: 2 },
    // Announced with a dated premiere: confirmed, upcoming, counted.
    { name: "Premiere dated ahead", show: synthetic(6, [season(1, [day(-400)]), season(2, [day(30), null])]), watched: [[1, 1]], next: "none", total: 3 },
    // Announced, nothing dated: listed, not offered, not counted.
    { name: "Announced, undated", show: synthetic(7, [season(1, [day(-400)]), season(2, [null, null, null])]), watched: [[1, 1]], next: "none", total: 1 },
  ];
  console.log();
  for (const c of cases) {
    const eps = toEpisodes(c.show);
    const keys = new Set(c.watched.map(([s, e]) => `${c.show.id}-${s}-${e}`));
    const next = label(findNextUnwatched(eps, keys));
    const total = totalEpisodeCount(detailsOf(c.show).seasons);
    console.log(`${c.name.padEnd(30)} next=${next.padEnd(5)} total=${total}`);
    check(next === c.next, `${c.name}: expected next ${c.next}, got ${next}`);
    check(total === c.total, `${c.name}: expected total ${c.total}, got ${total}`);
  }

  // 8. Two shows with the very same name stay two shows.
  const twinA = { ...synthetic(9001, [season(1, [day(-300), day(-300)]), season(2, [day(-3), day(-3)])]), name: "Same Name" };
  const twinB = { ...synthetic(9002, [season(1, [day(-20), day(-20)])]), name: "Same Name" };
  const twinRows = buildWatchNextRows(
    [toShow(twinA), toShow(twinB)],
    [...toEpisodes(twinA), ...toEpisodes(twinB)],
    watchedSeason(twinA, 1, new Date(Date.now() - 200 * 86400000).toISOString()),
    60,
    null,
    new Date()
  );
  const a = twinRows.find((r) => r.showId === 9001);
  const b = twinRows.find((r) => r.showId === 9002);
  check(
    a?.category === "watch-next" && label(a.nextEpisode) === "S2E1" && a.nextEpisode?.showId === 9001,
    `Same name: the watched one should offer its own S2E1, got ${a?.category} ${label(a?.nextEpisode)}`
  );
  check(
    b?.category === "not-started" && b.nextEpisode?.showId === 9002,
    `Same name: the other should be not-started with its own S1E1, got ${b?.category} ${label(b?.nextEpisode)}`
  );

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
