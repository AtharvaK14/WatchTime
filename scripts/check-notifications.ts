/**
 * Scenario check for release notifications and Releasing this month, run with
 * `npm run check:notifications`.
 *
 * Built around the reported cases, using TMDB's own metadata for them rather
 * than invented shapes:
 *
 *  - The Terminal List (TMDB 120911): Season 2, eight episodes, every one
 *    dated 2026-10-21 - a whole season at once.
 *  - Cyberpunk: Edgerunners (TMDB 105248): Season 2 ("Cyberpunk: Edgerunners
 *    2"), ten episodes, every one dated 2026-10-20.
 *  - Spider-Man: Brand New Day (TMDB 969681): US theatrical 2026-07-31, US
 *    digital 2026-10-06, watched in cinemas.
 *
 * By default the script uses those values as fixtures (read from TMDB on
 * 2026-10-23). Set TMDB_API_KEY to run the same checks against what TMDB
 * returns today instead - the app's own requests, made from Node:
 *
 *   TMDB_API_KEY=... npm run check:notifications
 *
 * Nothing here hardcodes a title into the app: the ids live only in this
 * script, and every check runs the app's own functions (episodeSync's refresh
 * decision, the notification event builder, Home's Releasing this month).
 *
 * What it can and cannot show. It proves which releases the app DETECTS and
 * would hand to Android, and in what form. Delivery - Android posting the
 * notification at the scheduled moment - happens in ReleaseNotifier.java and
 * is outside what a Node script can exercise; that needs a device or an
 * emulator with notifications allowed.
 */

import type { Episode, Movie, Show, WatchedEpisode } from "../src/db";
import { buildReleasingThisMonth } from "../src/lib/comingUp";
import { IN_FLIGHT_REFRESH_MS, seasonsNeedingRefresh } from "../src/lib/episodeSync";
import { buildNotificationEvents, type NotificationEvent } from "../src/lib/notifications/events";

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

// ---- Data ------------------------------------------------------------------

interface SeasonData {
  season_number: number;
  episodes: { episode_number: number; air_date: string | null }[];
}
interface ShowData {
  id: number;
  name: string;
  seasons: SeasonData[];
}

function season(n: number, count: number, airDate: string | null): SeasonData {
  return {
    season_number: n,
    episodes: Array.from({ length: count }, (_, i) => ({ episode_number: i + 1, air_date: airDate })),
  };
}

/**
 * Fixtures from TMDB. Season 1 of each is reduced to its premiere date on
 * every episode: it is only used as the user's watch history, and no check
 * depends on its dates.
 */
const FIXTURE_SHOWS: ShowData[] = [
  { id: 120911, name: "The Terminal List", seasons: [season(1, 8, "2022-07-01"), season(2, 8, "2026-10-21")] },
  { id: 105248, name: "Cyberpunk: Edgerunners", seasons: [season(1, 10, "2022-09-13"), season(2, 10, "2026-10-20")] },
];

const FIXTURE_SPIDER_MAN = { id: 969681, title: "Spider-Man: Brand New Day", theatrical: "2026-07-31", digital: "2026-10-06" };

const apiKey = process.env.TMDB_API_KEY;

async function tmdb<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", apiKey!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
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

async function liveMovieDates(id: number): Promise<{ theatrical: string | null; digital: string | null }> {
  const data = await tmdb<{ release_dates: { results: { iso_3166_1: string; release_dates: { type: number; release_date: string }[] }[] } }>(
    `/movie/${id}`,
    { append_to_response: "release_dates" }
  );
  const us = data.release_dates.results.find((r) => r.iso_3166_1 === "US")?.release_dates ?? [];
  const earliest = (type: number) => us.filter((d) => d.type === type).map((d) => d.release_date.slice(0, 10)).sort()[0] ?? null;
  return { theatrical: earliest(3) ?? earliest(2), digital: earliest(4) };
}

// ---- Helpers -----------------------------------------------------------------

function toShow(data: ShowData, fields: Partial<Show> = {}): Show {
  return {
    tmdbId: data.id,
    name: data.name,
    posterPath: "/poster.jpg",
    firstAirYear: 2022,
    status: "Returning Series",
    addedAt: "2023-01-01T00:00:00.000Z",
    isFollowed: true,
    isArchived: false,
    lastWatchedAt: "2023-01-01T00:00:00.000Z",
    ...fields,
  };
}

function toEpisodes(data: ShowData, override?: (s: number, e: number, date: string | null) => string | null): Episode[] {
  return data.seasons.flatMap((s) =>
    s.episodes.map((e) => ({
      key: `${data.id}-${s.season_number}-${e.episode_number}`,
      showId: data.id,
      seasonNumber: s.season_number,
      episodeNumber: e.episode_number,
      name: `S${s.season_number}E${e.episode_number}`,
      overview: null,
      airDate: override ? override(s.season_number, e.episode_number, e.air_date) : e.air_date,
      tmdbRating: 0,
      stillPath: null,
      runtimeMinutes: 45,
    }))
  );
}

/**
 * The user's history for a show they follow: every episode of seasons
 * 1..`throughSeason`, watched long before anything checked here. Release
 * notifications only go to shows the user is actively following, so a show
 * with no history at all would be announced nothing (see
 * check-notification-eligibility.ts for that side).
 */
function watchedThrough(data: ShowData, throughSeason: number): WatchedEpisode[] {
  return data.seasons
    .filter((s) => s.season_number >= 1 && s.season_number <= throughSeason)
    .flatMap((s) =>
      s.episodes.map((e) => ({
        key: `${data.id}-${s.season_number}-${e.episode_number}`,
        showId: data.id,
        seasonNumber: s.season_number,
        episodeNumber: e.episode_number,
        watchedAt: "2023-01-01T00:00:00.000Z",
        watchCount: 1,
        lastWatchedAt: "2023-01-01T00:00:00.000Z",
      }))
    );
}

function bySeason(episodes: Episode[]): Map<number, Episode[]> {
  const map = new Map<number, Episode[]>();
  for (const ep of episodes) map.set(ep.seasonNumber, [...(map.get(ep.seasonNumber) ?? []), ep]);
  return map;
}

function detailsOf(data: ShowData) {
  return { id: data.id, seasons: data.seasons.map((s) => ({ season_number: s.season_number, episode_count: s.episodes.length, name: "" })) };
}

/** Local noon on a calendar day, the way the app reads "today". */
function at(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

function daysBefore(day: string, n: number): string {
  const d = at(day);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** The rule the app used before this change: re-read a season only for a count change or a dated live episode, once per process. */
function oldRuleRefreshes(cached: Episode[], tmdbCount: number, now: Date, refreshedThisSession: boolean): boolean {
  if (cached.length !== tmdbCount) return true;
  if (refreshedThisSession) return false;
  const today = now.toISOString().slice(0, 10);
  const recent = daysBefore(today, 21);
  return cached.some((ep) => ep.airDate !== null && (ep.airDate > today || ep.airDate >= recent));
}

function describe(e: NotificationEvent): string {
  return `${e.date} ${e.kind.padEnd(16)} "${e.title}: ${e.body}"  [${e.eventId}]`;
}

// ---- Run ---------------------------------------------------------------------

async function main() {
  const shows = apiKey ? await Promise.all(FIXTURE_SHOWS.map((s) => liveShow(s.id))) : FIXTURE_SHOWS;
  const spider = apiKey ? { ...FIXTURE_SPIDER_MAN, ...(await liveMovieDates(FIXTURE_SPIDER_MAN.id)) } : FIXTURE_SPIDER_MAN;
  console.log(apiKey ? "Using live TMDB data.\n" : "Using TMDB fixtures captured 2026-10-23 (set TMDB_API_KEY to use live data).\n");

  for (const data of shows) {
    const latest = data.seasons[data.seasons.length - 1];
    const releaseDays = [...new Set(latest.episodes.map((e) => e.air_date))];
    console.log(`${data.name}: season ${latest.season_number}, ${latest.episodes.length} episodes, dated ${releaseDays.join(", ")}`);
    const releaseDay = latest.episodes[0].air_date;
    if (!releaseDay) {
      failures.push(`${data.name}: TMDB has no date for season ${latest.season_number}, nothing to check`);
      continue;
    }
    const show = toShow(data);
    const episodes = toEpisodes(data);
    // Caught up on everything before the new season, as the user is.
    const history = watchedThrough(data, latest.season_number - 1);

    // 1. Detection with a current cache, five days out. One event for the
    //    whole season, as a season release, opening the show on that season.
    const fiveDaysOut = buildNotificationEvents([show], episodes, history, [], at(daysBefore(releaseDay, 5)));
    console.log("  cache current, 5 days before:");
    for (const e of fiveDaysOut) console.log(`    ${describe(e)}`);
    check(fiveDaysOut.length === 1, `${data.name}: expected 1 event for the batch release, got ${fiveDaysOut.length}`);
    const event = fiveDaysOut[0];
    if (event) {
      check(event.kind === "season-premiere", `${data.name}: batch should be a new-season event, got ${event.kind}`);
      check(event.body === `Season ${latest.season_number} is now available`, `${data.name}: unexpected body "${event.body}"`);
      check(
        event.target.kind === "show" && event.target.seasonNumber === latest.season_number,
        `${data.name}: should open the show on season ${latest.season_number}`
      );
      check(event.imageUrl !== null, `${data.name}: should carry the poster`);
    }

    // 2. The TBA cache. The season was first cached while TMDB listed its
    //    episodes with no dates; TMDB has since dated them. Same count, no
    //    dated episode in the cache.
    const tbaCache = toEpisodes(data, (s, _e, date) => (s === latest.season_number ? null : date));
    const tbaNow = at(daysBefore(releaseDay, 5));
    const oldRefreshes = oldRuleRefreshes(
      tbaCache.filter((e) => e.seasonNumber === latest.season_number),
      latest.episodes.length,
      tbaNow,
      false
    );
    const newRefresh = seasonsNeedingRefresh(detailsOf(data), bySeason(tbaCache), tbaNow, new Map());
    const eventsFromStaleCache = buildNotificationEvents([show], tbaCache, history, [], tbaNow);
    console.log(
      `  season cached while undated: old rule re-reads it: ${oldRefreshes ? "yes" : "NO"}; ` +
        `new rule: ${newRefresh.map((r) => `S${r.seasonNumber} (${r.reason})`).join(", ") || "nothing"}; ` +
        `events from the stale cache: ${eventsFromStaleCache.length}`
    );
    check(!oldRefreshes, `${data.name}: expected the old rule to miss the undated season (the regression this reproduces)`);
    check(eventsFromStaleCache.length === 0, `${data.name}: an undated cache must not produce an event`);
    check(
      newRefresh.some((r) => r.seasonNumber === latest.season_number),
      `${data.name}: the new rule must re-read the undated latest season`
    );

    // 3. A long-lived process. The season was re-read three days ago, which
    //    the old once-per-session rule treated as done for good.
    const lastRead = new Map([[`${data.id}:${latest.season_number}`, tbaNow.getTime() - 3 * 86400000]]);
    const stale = seasonsNeedingRefresh(detailsOf(data), bySeason(tbaCache), tbaNow, lastRead);
    check(stale.some((r) => r.seasonNumber === latest.season_number), `${data.name}: a read three days old must be refreshed`);
    const fresh = new Map([[`${data.id}:${latest.season_number}`, tbaNow.getTime() - IN_FLIGHT_REFRESH_MS / 2]]);
    check(
      seasonsNeedingRefresh(detailsOf(data), bySeason(tbaCache), tbaNow, fresh).length === 0,
      `${data.name}: a read under ${IN_FLIGHT_REFRESH_MS / 3600000}h old must not be repeated`
    );

    // 4. Learned on the day. The dates reached the cache on release day itself.
    //    Strictly-future scheduling dropped it; it is announced now.
    const sameDay = buildNotificationEvents([show], episodes, history, [], at(releaseDay));
    const oldSameDay = sameDay.filter((e) => e.date > releaseDay);
    console.log(`  dates learned on release day: old rule ${oldSameDay.length} events, new rule ${sameDay.length}`);
    check(sameDay.length === 1, `${data.name}: a release learned of on the day should still be announced that day`);
    check(sameDay[0]?.eventId === event?.eventId, `${data.name}: same-day event must keep the release's id`);

    // 5. The day after: not announced (Watch Next carries it as NEW instead).
    const dayAfter = buildNotificationEvents([show], episodes, history, [], at(daysBefore(releaseDay, -1)));
    check(dayAfter.length === 0, `${data.name}: must not announce a release the day after`);

    // 6. Partial, then whole, on the same day: one id, so no second alert.
    const partial = toEpisodes(data, (s, e, date) => (s === latest.season_number && e > 1 ? null : date));
    const partialEvent = buildNotificationEvents([show], partial, history, [], at(releaseDay))[0];
    check(
      partialEvent !== undefined && partialEvent.eventId === sameDay[0]?.eventId,
      `${data.name}: premiere-only and whole-season events on one day must share an id`
    );

    // 7. Respecting the user's choices.
    check(
      buildNotificationEvents([toShow(data, { isArchived: true })], episodes, history, [], tbaNow).length === 0,
      `${data.name}: a stopped show must not notify`
    );
    check(
      buildNotificationEvents([toShow(data, { isFollowed: false })], episodes, history, [], tbaNow).length === 0,
      `${data.name}: an unfollowed show must not notify`
    );
    check(buildNotificationEvents([], episodes, history, [], tbaNow).length === 0, `${data.name}: not in the library, no notification`);
    console.log();
  }

  // ---- Weekly releases keep their per-episode notifications ----------------
  const weekly: ShowData = {
    id: 1,
    name: "Weekly Show",
    seasons: [
      season(1, 6, "2025-01-01"),
      { season_number: 2, episodes: [0, 7, 14, 21].map((d, i) => ({ episode_number: i + 1, air_date: daysBefore("2026-11-01", -d) })) },
    ],
  };
  const weeklyEvents = buildNotificationEvents([toShow(weekly)], toEpisodes(weekly), watchedThrough(weekly, 1), [], at("2026-10-25"));
  console.log("Weekly Show (synthetic), a season airing one episode a week:");
  for (const e of weeklyEvents) console.log(`  ${describe(e)}`);
  check(weeklyEvents.length === 4, `Weekly: expected 4 separate events, got ${weeklyEvents.length}`);
  check(weeklyEvents[0]?.kind === "season-premiere" && weeklyEvents[0]?.body === "Season 2 premieres today", "Weekly: premiere event");
  check(weeklyEvents.slice(1).every((e) => e.kind === "episode" && e.target.kind === "episode"), "Weekly: later weeks are episode events");
  check(new Set(weeklyEvents.map((e) => e.eventId)).size === 4, "Weekly: every week has its own id");

  // ---- Movies ---------------------------------------------------------------
  const spiderMan: Movie = {
    tmdbId: spider.id,
    title: spider.title,
    posterPath: "/poster.jpg",
    releaseYear: 2026,
    watched: true,
    watchedAt: "2026-07-31T23:00:00.000Z",
    wantsToWatch: false,
    releaseDate: spider.theatrical,
    theatricalReleaseDate: spider.theatrical,
    digitalReleaseDate: spider.digital,
    releaseDatesCheckedAt: "2026-10-01T00:00:00.000Z",
  };
  console.log(`\n${spider.title}: theatrical ${spider.theatrical}, digital ${spider.digital}, watched`);
  if (spider.digital) {
    const month = at(spider.digital);
    const listed = buildReleasingThisMonth([spiderMan], month);
    console.log(`  Releasing this month in ${spider.digital.slice(0, 7)}: ${listed.length === 0 ? "not listed" : "LISTED"}`);
    check(listed.length === 0, "Spider-Man: a watched movie must not be listed in Releasing this month");

    const notified = buildNotificationEvents([], [], [], [spiderMan], at(daysBefore(spider.digital, 5)));
    for (const e of notified) console.log(`  ${describe(e)}`);
    check(
      notified.length === 1 && notified[0].kind === "movie-digital",
      "Spider-Man: the digital release must still be announced for a watched movie"
    );
    const unwatched = buildReleasingThisMonth([{ ...spiderMan, watched: false, watchedAt: null, wantsToWatch: true }], month);
    check(unwatched.length === 1 && unwatched[0].releaseKind === "digital", "Spider-Man unwatched: listed as Digital Release");
  }
  if (spider.theatrical) {
    const beforeCinemas = buildNotificationEvents([], [], [], [spiderMan], at(daysBefore(spider.theatrical, 3)));
    check(
      !beforeCinemas.some((e) => e.kind === "movie-theatrical"),
      "Spider-Man: no theatrical notification once it has been watched"
    );
  }

  // A streaming original: no cinema release, its primary date is the
  // streaming premiere. Must never be announced as "in cinemas".
  const original: Movie = {
    tmdbId: 2,
    title: "Streaming Original",
    posterPath: null,
    releaseYear: 2026,
    watched: false,
    watchedAt: null,
    wantsToWatch: true,
    releaseDate: "2026-11-06",
    theatricalReleaseDate: null,
    digitalReleaseDate: "2026-11-06",
  };
  const originalEvents = buildNotificationEvents([], [], [], [original], at("2026-11-01"));
  check(
    originalEvents.length === 1 && originalEvents[0].kind === "movie-digital",
    `Streaming original: expected one digital event, got ${originalEvents.map((e) => e.kind).join(", ") || "none"}`
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
