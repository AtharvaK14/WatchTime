// Turns the library into the list of things worth notifying about.
//
// Deliberately a pure function over rows already in Dexie: the same
// db.episodes cache Home's Watch Next and Coming Up read, plus db.shows,
// db.watchedEpisodes and db.movies. It issues no network requests of its own
// and, critically, has no access to any TMDB discovery endpoint, so it is
// structurally incapable of producing a notification for something outside
// the user's library. That scoping guarantee is the point of keeping this
// separate from the scheduler in index.ts, which handles permissions and
// platform plumbing.
//
// Being in the library is necessary, not sufficient: which shows may be
// announced is releaseAlertEligibility() in lib/watchNext.ts, the same
// viewing states Home's tabs and Upcoming episodes are built from.

import type { Episode, Movie, Show, WatchedEpisode } from "../../db";
import { TMDB_IMAGE_BASE } from "../../tmdb";
import { hasConfirmedAirDate, todayIso } from "../releaseState";
import { DEFAULT_STALE_DAYS_THRESHOLD } from "../showStatus";
import { groupByShow, releaseAlertEligibility, type ReleaseAlertExclusion } from "../watchNext";

// Re-exported rather than redefined: release state now has one home
// (lib/releaseState.ts) so a notification and Home's Watch Next cannot end up
// with different ideas of what day it is or of what counts as a real air
// date - which is exactly how "Season 2 is now available" and "Haven't
// Watched For a While" managed to be true of the same show at the same time.
export { todayIso };

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
  library: Map<number, Show>,
  episodes: Episode[],
  today: string,
  horizon: string
): ReleaseCluster[] {
  // Counted over EVERY cached episode of the season, not just the upcoming
  // ones, so "did the whole season land at once" can be answered.
  const seasonSize = new Map<string, number>();
  for (const ep of episodes) {
    if (ep.seasonNumber <= 0 || !library.has(ep.showId)) continue;
    const key = `${ep.showId}:${ep.seasonNumber}`;
    seasonSize.set(key, (seasonSize.get(key) ?? 0) + 1);
  }

  const clusters = new Map<string, ReleaseCluster>();
  for (const ep of episodes) {
    const show = library.get(ep.showId);
    if (!show) continue; // not in the library — never notify. Whether it may be is decided per release, later.
    if (ep.seasonNumber <= 0) continue; // specials aren't part of the run
    if (!hasConfirmedAirDate(ep)) continue; // unknown is not "upcoming"
    // Today or later, never earlier. This is what stops a freshly synced back
    // catalogue from announcing episodes that came out years ago: newly
    // CACHED is not newly AVAILABLE.
    //
    // Today is included on purpose. It used to be strictly future, which
    // silently dropped any release the app first learned the date of on the
    // day itself - common for streaming drops, whose episode lists are often
    // only filled in on TMDB around release, and for anyone who simply had not
    // opened the app since the date was added. Such a release is still news
    // that day; the native side posts it as soon as it is handed over (it is
    // already past its midnight moment) and remembers it as posted for as
    // long as it stays in the schedule, which is the rest of that day, so a
    // later sync cannot announce it twice. Yesterday's are not included: by
    // then Watch Next is already showing them as NEW, and "now available" a
    // day late is not worth an alert.
    if (ep.airDate < today || ep.airDate > horizon) continue;

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
  // One id per release event - show, season, day - whatever the cluster
  // currently holds. It used to differ between a single episode and a batch
  // ("episode:..." vs "batch:..."), so a premiere TMDB listed as one dated
  // episode, and then filled in as the whole season on the same day, became a
  // second event with a second id: a duplicate alert once same-day releases
  // could be announced. With one id the native already-posted record covers
  // it, and a repost would replace rather than add.
  const eventId = `release:${show.tmdbId}:${seasonNumber}:${date}`;

  if (episodes.length === 1) {
    const ep = episodes[0];
    return {
      eventId,
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
    eventId,
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

/** A release that was found and deliberately not announced, and why. */
export interface ExcludedRelease {
  /** The id the event would have had. */
  eventId: string;
  showId: number;
  title: string;
  date: string;
  reason: ReleaseAlertExclusion;
}

export interface NotificationPlan {
  /** What may be delivered, sorted by date. */
  events: NotificationEvent[];
  /** Episode releases found for library shows that are not eligible, kept so an exclusion can be explained. */
  excluded: ExcludedRelease[];
}

/** An exclusion in the words the app uses for it. */
export function exclusionLabel(reason: ReleaseAlertExclusion): string {
  switch (reason) {
    case "not-followed":
      return "not followed";
    case "stopped":
      return "Stopped Watching";
    case "not-started":
      return "Haven't Yet Started";
    case "stale":
      return "Haven't Watched For a While";
    case "unknown-progress":
      return "watch history has no usable date";
  }
}

/**
 * When a release on `date` would be delivered: midnight local on the day, or
 * now for a release dated today, which native posts as soon as it has it.
 */
function deliveryMoment(date: string, now: Date): Date {
  const midnight = new Date(`${date}T00:00:00`);
  return midnight.getTime() > now.getTime() ? midnight : now;
}

/**
 * Every notifiable event in [today, today + HORIZON_DAYS], sorted by date,
 * plus the episode releases left out and why.
 *
 * Episodes: only episodes with a CONFIRMED air date of today or later, of
 * library shows that releaseAlertEligibility() accepts AT THE RELEASE - the
 * moment the notification would arrive, not the moment it is scheduled. That
 * is what keeps a queued notification honest: a show that will have gone
 * stale by its release date is left out now, rather than announced on a day
 * Home would no longer offer it. `watched` is every show's watch history and
 * is required for this: without it every show reads as never started, and
 * nothing is announced.
 *
 * A missing air date is not a confirmed date and never produces a
 * notification — the same reasoning as findNextUpcoming(), and the opposite of
 * isAvailableToWatch(), which is about not HIDING things rather than about
 * claiming something is happening.
 *
 * Movies: only movies already in the library, and the two releases are
 * judged separately:
 *
 *  - Theatrical: unwatched movies only. Someone who has already seen it has
 *    no use for "now playing in cinemas".
 *  - Digital: watched or not. Seeing a film in cinemas is exactly when
 *    "available to watch at home" is worth knowing, and the user asked for it.
 *    This is deliberately independent of Home's Releasing this month, which
 *    leaves watched movies out: one is a watchlist, the other is release news,
 *    and neither decision is allowed to stand in for the other.
 */
export function planNotifications(
  shows: Show[],
  episodes: Episode[],
  watched: WatchedEpisode[],
  movies: Movie[],
  now = new Date(),
  staleThreshold = DEFAULT_STALE_DAYS_THRESHOLD
): NotificationPlan {
  const today = todayIso(now);
  const horizon = addDays(today, HORIZON_DAYS);
  const events: NotificationEvent[] = [];
  const excluded: ExcludedRelease[] = [];

  const library = new Map<number, Show>();
  for (const show of shows) library.set(show.tmdbId, show);
  const episodesByShow = groupByShow(episodes);
  const watchedByShow = groupByShow(watched);

  for (const cluster of clusterEpisodeReleases(library, episodes, today, horizon)) {
    const event = eventForCluster(cluster);
    const { tmdbId } = cluster.show;
    const verdict = releaseAlertEligibility(
      cluster.show,
      episodesByShow.get(tmdbId) ?? [],
      watchedByShow.get(tmdbId) ?? [],
      staleThreshold,
      deliveryMoment(cluster.date, now)
    );
    if (verdict.eligible) {
      events.push(event);
    } else {
      excluded.push({ eventId: event.eventId, showId: tmdbId, title: event.title, date: event.date, reason: verdict.reason! });
    }
  }

  for (const movie of movies) {
    const image = posterUrl(movie.posterPath);

    // The typed theatrical date once it has been looked up, null included:
    // null means TMDB lists no cinema release, and then releaseDate is the
    // streaming premiere, which must not be announced as "in cinemas". Only a
    // movie never looked up falls back to releaseDate, as before.
    const theatrical =
      movie.theatricalReleaseDate !== undefined ? movie.theatricalReleaseDate : (movie.releaseDate ?? null);
    if (!movie.watched && theatrical && theatrical >= today && theatrical <= horizon) {
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
    if (digital && digital !== theatrical && digital >= today && digital <= horizon) {
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
  excluded.sort((a, b) => a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId));
  return { events, excluded };
}

/** planNotifications() without the exclusions. */
export function buildNotificationEvents(
  shows: Show[],
  episodes: Episode[],
  watched: WatchedEpisode[],
  movies: Movie[],
  now = new Date(),
  staleThreshold = DEFAULT_STALE_DAYS_THRESHOLD
): NotificationEvent[] {
  return planNotifications(shows, episodes, watched, movies, now, staleThreshold).events;
}

/**
 * The events actually handed to native: the categories the user has left on,
 * dated today or later, capped at `limit`.
 *
 * The date check is belt and braces - planNotifications() already emits only
 * today and later - against a run that straddles midnight handing native a
 * release from yesterday, which it would post.
 */
export function selectForDelivery(
  events: NotificationEvent[],
  isKindEnabled: (kind: NotificationKind) => boolean,
  today: string,
  limit: number
): NotificationEvent[] {
  return events.filter((e) => isKindEnabled(e.kind) && e.date >= today).slice(0, limit);
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
