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

export type NotificationKind = "episode" | "season-premiere" | "movie-theatrical" | "movie-digital";

/**
 * Where tapping the notification should land. Mirrors the shapes the app
 * can already open: a show's details panel, a specific episode's details
 * panel, or a movie's details panel. Consumed by lib/deepLink.ts.
 */
export type NotificationTarget =
  | { kind: "episode"; showId: number; episodeKey: string }
  | { kind: "movie"; tmdbId: number };

export interface NotificationEvent {
  /** Stable across rebuilds, so re-running the scheduler never duplicates. */
  eventId: string;
  kind: NotificationKind;
  /** Calendar day (YYYY-MM-DD) the event happens on. */
  date: string;
  title: string;
  body: string;
  target: NotificationTarget;
}

/**
 * How far ahead events are collected. The OS caps how many alarms an app may
 * have pending, and a large library with many returning shows can easily
 * exceed that, so the horizon plus the per-run cap in index.ts keep the
 * scheduled set bounded. Anything beyond the horizon is picked up by a later
 * run — the scheduler re-runs on every app resume.
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
 * Episode 1 of a season becomes a "season premiere" event rather than a
 * plain new-episode one; a first season is worded as a series premiere.
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

  for (const ep of episodes) {
    const show = followed.get(ep.showId);
    if (!show) continue; // not in the library, or archived — never notify
    if (!ep.airDate) continue; // unknown is not "upcoming"
    if (ep.airDate <= today || ep.airDate > horizon) continue;
    if (ep.seasonNumber <= 0) continue; // specials aren't part of the run

    const isPremiere = ep.episodeNumber === 1;
    events.push({
      eventId: `episode:${ep.key}:${ep.airDate}`,
      kind: isPremiere ? "season-premiere" : "episode",
      date: ep.airDate,
      title: isPremiere
        ? ep.seasonNumber === 1
          ? `${show.name} premieres today`
          : `${show.name} — Season ${ep.seasonNumber} premieres today`
        : `New episode of ${show.name}`,
      body: `${seasonEpisodeLabel(ep)}${ep.name ? ` · ${ep.name}` : ""}`,
      target: { kind: "episode", showId: show.tmdbId, episodeKey: ep.key },
    });
  }

  for (const movie of movies) {
    if (movie.watched) continue;

    const theatrical = movie.releaseDate ?? null;
    if (theatrical && theatrical > today && theatrical <= horizon) {
      events.push({
        eventId: `movie-theatrical:${movie.tmdbId}:${theatrical}`,
        kind: "movie-theatrical",
        date: theatrical,
        title: `${movie.title} is in cinemas today`,
        body: "Released in theatres — it's on your list.",
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
        title: `${movie.title} is available at home`,
        body: "Out digitally today — it's on your list.",
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
 * Android identifies a pending notification by int id, so the mapping must be
 * stable: re-running the scheduler has to REPLACE the alarm for an event, not
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
