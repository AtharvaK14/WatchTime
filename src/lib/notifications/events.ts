// Turns the library into the list of things worth notifying about.
//
// Deliberately a pure function over rows already in Dexie: the same
// db.episodes cache Home's Watch Next and Coming Up read, plus db.shows and
// db.movies. It issues no network requests of its own and, critically, has
// no access to any TMDB discovery endpoint, so it is structurally incapable
// of producing a notification for something outside the user's library.
// That scoping guarantee is the point of keeping this separate from the
// scheduler in index.ts, which handles permissions and platform plumbing.

import type { Episode, Movie, Show } from "../../db";
import { TMDB_IMAGE_BASE } from "../../tmdb";

export type NotificationKind = "episode" | "season-premiere" | "movie-theatrical" | "movie-digital";

/**
 * Where tapping the notification should land. Mirrors the shapes the app
 * can already open: a show's details panel, a specific episode's details
 * panel, or a movie's details panel. Consumed by lib/deepLink.ts.
 *
 * A batch release points at the SHOW rather than any one episode — there is
 * no single episode the notification is about — and carries the season so the
 * panel opens on the episodes that just arrived.
 */
export type NotificationTarget =
  | { kind: "episode"; showId: number; episodeKey: string }
  | { kind: "show"; tmdbId: number; seasonNumber?: number }
  | { kind: "movie"; tmdbId: number };

export interface NotificationEvent {
  /** Stable across rebuilds, so re-running the scheduler never duplicates. */
  eventId: string;
  kind: NotificationKind;
  /** Calendar day (YYYY-MM-DD) the event happens on. */
  date: string;
  title: string;
  body: string;
  /**
   * Artwork for the notification's large icon — the show or movie poster.
   * Null when the title has no poster, which the native side renders as a
   * plain branded notification rather than a broken image.
   */
  imageUrl: string | null;
  target: NotificationTarget;
}

/**
 * How far ahead events are collected. Anything beyond the horizon is picked
 * up by a later run — the scheduler re-runs on every app resume.
 */
export const HORIZON_DAYS = 45;

export function todayIso(now = new Date()): string {
  // Local calendar day, not UTC: an episode airing "today" must read as today
  // for a user in UTC-5 at 9pm, which toISOString() would call tomorrow.
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

function seasonEpisodeLabel(ep: { seasonNumber: number; episodeNumber: number }): string {
  return `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`;
}

function posterUrl(path: string | null | undefined): string | null {
  return path ? `${TMDB_IMAGE_BASE}${path}` : null;
}

/**
 * Episodes of ONE season that all become available on the SAME day — a single
 * release event, however many episodes it contains.
 */
interface ReleaseCluster {
  show: Show;
  seasonNumber: number;
  date: string;
  /** Sorted by episode number. One entry means a normal weekly release. */
  episodes: Episode[];
  /** Episodes of this season held locally, used to tell a full season from a partial drop. */
  seasonSize: number;
}

/**
 * Groups upcoming episodes into release events.
 *
 * The unit of grouping is (show, season, air date), and the tolerance is a
 * whole calendar day — deliberately, not a tunable window. TMDB's air_date
 * carries no time component, so a day IS the precision of the data; anything
 * finer would be inventing accuracy the source does not have. A wider window
 * is worse than useless: it would chain across consecutive days, so a daily
 * series would collapse into one event spanning its whole run, while a weekly
 * series (7-day gaps) gains nothing from it. Same day, or separate events.
 *
 * This is what distinguishes a batch drop from a weekly schedule without
 * knowing anything about the show: ten episodes sharing one date is one
 * cluster of ten, ten episodes a week apart is ten clusters of one.
 */
function clusterEpisodeReleases(
  followed: Map<number, Show>,
  episodes: Episode[],
  today: string,
  horizon: string
): ReleaseCluster[] {
  // Counted over EVERY cached episode of the season, not just the upcoming
  // ones, so "did the whole season land at once" can be answered.
  const seasonSize = new Map<string, number>();
  for (const ep of episodes) {
    if (ep.seasonNumber <= 0 || !followed.has(ep.showId)) continue;
    const key = `${ep.showId}:${ep.seasonNumber}`;
    seasonSize.set(key, (seasonSize.get(key) ?? 0) + 1);
  }

  const clusters = new Map<string, ReleaseCluster>();
  for (const ep of episodes) {
    const show = followed.get(ep.showId);
    if (!show) continue; // not in the library, or archived — never notify
    if (ep.seasonNumber <= 0) continue; // specials aren't part of the run
    if (!ep.airDate) continue; // unknown is not "upcoming"
    // Strictly future only. This is what stops a freshly synced back
    // catalogue from announcing episodes that came out years ago: newly
    // CACHED is not newly AVAILABLE.
    if (ep.airDate <= today || ep.airDate > horizon) continue;

    const key = `${ep.showId}:${ep.seasonNumber}:${ep.airDate}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.episodes.push(ep);
    } else {
      clusters.set(key, {
        show,
        seasonNumber: ep.seasonNumber,
        date: ep.airDate,
        episodes: [ep],
        seasonSize: seasonSize.get(`${ep.showId}:${ep.seasonNumber}`) ?? 1,
      });
    }
  }

  for (const cluster of clusters.values()) {
    cluster.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
  }
  return [...clusters.values()];
}

/**
 * One notification per release event.
 *
 * The `kind` stays within the four categories the user can toggle in
 * Settings: a batch that opens a season is still a "season premiere", and a
 * batch that lands mid-season is still "new episodes". Batching changes how
 * MANY notifications an event produces, never which category it belongs to,
 * so nobody's existing per-category opt-out changes meaning.
 *
 * Wording is graded by what can actually be claimed. "Season 3 is now
 * available" is only used when the cluster accounts for every episode of the
 * season held locally; a partial drop says how many episodes arrived instead
 * of overstating it.
 */
function eventForCluster(cluster: ReleaseCluster): NotificationEvent {
  const { show, seasonNumber, date, episodes, seasonSize } = cluster;
  const image = posterUrl(show.posterPath);
  const opensSeason = episodes[0].episodeNumber === 1;

  if (episodes.length === 1) {
    const ep = episodes[0];
    return {
      eventId: `episode:${ep.key}:${date}`,
      kind: opensSeason ? "season-premiere" : "episode",
      date,
      title: show.name,
      body: opensSeason
        ? seasonNumber === 1
          ? "Premieres today"
          : `Season ${seasonNumber} premieres today`
        : `${seasonEpisodeLabel(ep)} is now available`,
      imageUrl: image,
      target: { kind: "episode", showId: show.tmdbId, episodeKey: ep.key },
    };
  }

  // >= means "as many as we hold", not "more than exists": a season is only
  // ever cached whole (see ensureEpisodesCached), so this is the honest test,
  // and when the local copy is incomplete it fails safe into the partial
  // wording rather than announcing a season that has not fully landed.
  const wholeSeason = episodes.length >= seasonSize;
  return {
    eventId: `batch:${show.tmdbId}:${seasonNumber}:${date}`,
    kind: opensSeason ? "season-premiere" : "episode",
    date,
    title: show.name,
    body: wholeSeason
      ? `Season ${seasonNumber} is now available`
      : opensSeason
        ? `Season ${seasonNumber} premieres with ${episodes.length} episodes`
        : `${episodes.length} new episodes are now available`,
    imageUrl: image,
    target: { kind: "show", tmdbId: show.tmdbId, seasonNumber },
  };
}

/**
 * Every notifiable event in [today, today + HORIZON_DAYS], sorted by date.
 *
 * Episodes: only for followed, unarchived shows (the exact same predicate
 * Home uses), and only episodes with a CONFIRMED future air date. A missing
 * air date is not a confirmed date and never produces a notification — the
 * same reasoning as findNextUpcoming(), and the opposite of
 * isAvailableToWatch(), which is about not HIDING things rather than about
 * claiming something is happening.
 *
 * Movies: only unwatched movies already in the library. A watched movie
 * getting a late digital date is not news.
 */
export function buildNotificationEvents(
  shows: Show[],
  episodes: Episode[],
  movies: Movie[],
  now = new Date()
): NotificationEvent[] {
  const today = todayIso(now);
  const horizon = addDays(today, HORIZON_DAYS);
  const events: NotificationEvent[] = [];

  const followed = new Map<number, Show>();
  for (const show of shows) {
    if (show.isFollowed && !show.isArchived) followed.set(show.tmdbId, show);
  }

  for (const cluster of clusterEpisodeReleases(followed, episodes, today, horizon)) {
    events.push(eventForCluster(cluster));
  }

  for (const movie of movies) {
    if (movie.watched) continue;
    const image = posterUrl(movie.posterPath);

    const theatrical = movie.releaseDate ?? null;
    if (theatrical && theatrical > today && theatrical <= horizon) {
      events.push({
        eventId: `movie-theatrical:${movie.tmdbId}:${theatrical}`,
        kind: "movie-theatrical",
        date: theatrical,
        title: movie.title,
        body: "Now playing in cinemas",
        imageUrl: image,
        target: { kind: "movie", tmdbId: movie.tmdbId },
      });
    }

    const digital = movie.digitalReleaseDate ?? null;
    // Guarded against a digital date that merely equals the theatrical one
    // (TMDB sometimes carries the same day for both on straight-to-streaming
    // titles): two identical notifications on one day for one movie is noise.
    if (digital && digital !== theatrical && digital > today && digital <= horizon) {
      events.push({
        eventId: `movie-digital:${movie.tmdbId}:${digital}`,
        kind: "movie-digital",
        date: digital,
        title: movie.title,
        body: "Now available to watch",
        imageUrl: image,
        target: { kind: "movie", tmdbId: movie.tmdbId },
      });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId));
  return events;
}

/**
 * Deterministic positive 31-bit id for a notification, derived from eventId.
 *
 * Android identifies a posted notification by int id, so the mapping must be
 * stable: re-running the scheduler has to REPLACE the entry for an event, not
 * add a second one. FNV-1a is used rather than a running counter precisely
 * because a counter would renumber everything whenever the event list changed
 * shape, which is exactly when duplicates would appear.
 */
export function notificationId(eventId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < eventId.length; i++) {
    hash ^= eventId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7fffffff;
}
