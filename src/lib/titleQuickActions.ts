// Quick Actions for a show or movie poster/card, wherever it appears: Home,
// Shows, Movies, Discover and For You all spread titleQuickActionProps() on
// their cards and get the same menu. What it offers comes from
// lib/quickActions.ts, worked out from the database when it opens; what each
// entry does is the existing operation for it, unchanged.

import { db } from "../db";
import { availableInProgression } from "./episodeSync";
import { contextActionProps, rectAnchor, type MenuAnchor } from "./contextActions";
import { movieActions, showActions, viewingStatusActions, type QuickActionSpec } from "./quickActions";
import { openQuickMenu, openWatchHistory, type QuickMenuEntry } from "./quickMenu";
import { markShowUnwatched, markShowWatched } from "./watchEvents";
import { movieWatchCount, summarizeShow } from "./watchHistory";
import { isStoppedWatching, resumeWatchingShow, stopWatchingShow } from "./stoppedWatching";
import { cancelRemoval, holdRemoval, playRemoval, removeFromLibrary, type LibraryKind } from "./libraryRemoval";
import {
  cancelMovieWatched,
  holdMovieWatched,
  markMovieUnwatchedFromCard,
  markMovieWatchedFromCard,
  playMovieWatched,
  removeLatestMovieViewingFromCard,
  rewatchMovieFromCard,
  setMovieWatchedOnceFromCard,
} from "./movieWatched";
import { addMovieToLibrary, addShowToLibrary } from "./library";
import { showErrorToast } from "./toast";

export interface TitleTarget {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  /** What a tap on the card does: opens its details panel. */
  onViewDetails: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Removal from a card: the same write and the same exit as the details
 * panel's Remove, played straight away since there is no panel to wait for.
 */
async function removeTitle(kind: LibraryKind, tmdbId: number): Promise<void> {
  holdRemoval(kind, tmdbId);
  try {
    await removeFromLibrary(kind, tmdbId);
  } catch (e) {
    cancelRemoval(kind, tmdbId);
    throw e;
  }
  playRemoval(kind, tmdbId);
}

function toEntries(specs: QuickActionSpec[], runs: Partial<Record<string, QuickMenuEntry["run"]>>, confirms: Partial<Record<string, QuickMenuEntry["confirm"]>> = {}): QuickMenuEntry[] {
  return specs.flatMap((spec) => {
    const run = runs[spec.id];
    if (!run) return [];
    return [
      {
        id: spec.id,
        label: spec.label,
        danger: spec.danger,
        checked: spec.checked,
        confirm: spec.confirm ? confirms[spec.id] : undefined,
        run,
      },
    ];
  });
}

/**
 * Card sequences resolve false when the card was still playing an earlier
 * one and the press was ignored; nothing was written then, so nothing is
 * reported.
 */
async function reportIfDone(done: Promise<boolean>, message: string): Promise<string | void> {
  return (await done) ? message : undefined;
}

async function showMenu(t: TitleTarget): Promise<{ subtitle: string; entries: QuickMenuEntry[] }> {
  const { tmdbId: id, name } = t;
  const show = await db.shows.get(id);
  const common = {
    "view-details": t.onViewDetails,
    add: async () => {
      await addShowToLibrary(id);
      cancelRemoval("show", id);
      return `Added ${name} to Shows.`;
    },
  };
  if (!show) {
    return {
      subtitle: "Not in your Shows",
      entries: toEntries(showActions({ inLibrary: false, stopped: false, watchedEpisodes: 0, releasedUnwatched: null }), common),
    };
  }
  const [episodes, watched] = await Promise.all([
    db.episodes.where("showId").equals(id).toArray(),
    db.watchedEpisodes.where("showId").equals(id).toArray(),
  ]);
  const summary = summarizeShow(episodes, watched);
  const watchedKeys = new Set(watched.map((w) => w.key));
  const releasedUnwatched =
    episodes.length === 0
      ? null
      : availableInProgression(episodes, new Date().toISOString().slice(0, 10)).filter((e) => !watchedKeys.has(e.key)).length;
  const stopped = isStoppedWatching(show);
  const specs = showActions({ inLibrary: true, stopped, watchedEpisodes: watched.length, releasedUnwatched });

  const progress = episodes.length > 0 ? `${summary.uniqueWatched} of ${summary.released} episodes` : plural(summary.uniqueWatched, "episode") + " watched";
  const subtitle = [stopped ? "Stopped watching" : null, progress, summary.views > summary.uniqueWatched ? plural(summary.views, "view") : null]
    .filter(Boolean)
    .join(" · ");

  return {
    subtitle,
    entries: toEntries(
      specs,
      {
        ...common,
        "mark-watched": async () => {
          const n = await markShowWatched(id);
          return n === 0 ? `${name} is already up to date.` : `Marked ${plural(n, "episode")} of ${name} watched.`;
        },
        "mark-unwatched": async () => {
          const rows = await markShowUnwatched(id);
          return `Marked ${plural(rows.length, "episode")} of ${name} unwatched.`;
        },
        resume: async () => {
          await resumeWatchingShow(id);
          return `Resumed ${name}.`;
        },
        stop: async () => {
          await stopWatchingShow(id);
          return `Stopped watching ${name}. Its history is kept.`;
        },
        history: () => openWatchHistory({ kind: "show", tmdbId: id, name }),
        remove: async () => {
          await removeTitle("show", id);
          return `Removed ${name} from Shows.`;
        },
      },
      {
        "mark-unwatched": {
          message: `Mark all ${plural(watched.length, "watched episode")} of ${name} unwatched? Their watch counts are cleared too.`,
          confirmLabel: "Mark unwatched",
        },
        remove: {
          message: `Remove ${name} from Shows? This also deletes its watch history. No undo.`,
          confirmLabel: "Remove",
        },
      }
    ),
  };
}

async function movieMenu(t: TitleTarget): Promise<{ subtitle: string; entries: QuickMenuEntry[] }> {
  const { tmdbId: id, name } = t;
  const movie = await db.movies.get(id);
  const inLibrary = !!movie;
  const watched = !!movie?.watched;
  const count = movie ? movieWatchCount(movie) : 0;
  const subtitle = !movie
    ? "Not in your Movies"
    : watched
      ? count >= 2
        ? `Watched ${count} times`
        : "Watched"
      : movie.wantsToWatch
        ? "On your watchlist"
        : "Not watched";

  return {
    subtitle,
    entries: toEntries(
      movieActions({ inLibrary, watched, watchCount: count }),
      {
        "view-details": t.onViewDetails,
        // The card's own tick (in the library) or the panel's "Add & mark
        // watched" (outside it), with the same watched veil on the card.
        "mark-watched": inLibrary
          ? () => reportIfDone(markMovieWatchedFromCard(id), `Marked ${name} watched.`)
          : async () => {
              holdMovieWatched(id, "saving");
              try {
                await addMovieToLibrary(id, true);
              } catch (e) {
                cancelMovieWatched(id);
                throw e;
              }
              cancelRemoval("movie", id);
              playMovieWatched(id);
              return `Added ${name} and marked it watched.`;
            },
        // The same card sequences as the poster's own indicator, so a change
        // made here plays the same green / -1 / red X acknowledgement.
        "watched-again": () => reportIfDone(rewatchMovieFromCard(id), `Watched ${name} again. ${count + 1} viewings in total.`),
        "remove-last": () =>
          reportIfDone(
            removeLatestMovieViewingFromCard(id),
            `Removed the last viewing of ${name}. ${count - 1 === 1 ? "Watched once" : `Watched ${count - 1} times`} now.`
          ),
        "mark-unwatched": () =>
          reportIfDone(markMovieUnwatchedFromCard(id), `Marked ${name} unwatched. It's still in your Movies, back on your watchlist.`),
        add: async () => {
          await addMovieToLibrary(id, false);
          cancelRemoval("movie", id);
          return `Added ${name} to Movies.`;
        },
        history: () => openWatchHistory({ kind: "movie", tmdbId: id, name }),
        remove: async () => {
          await removeTitle("movie", id);
          return `Removed ${name} from Movies.`;
        },
      },
      {
        remove: {
          message: `Remove ${name} from Movies? Its watched status goes with it. No undo.`,
          confirmLabel: "Remove",
        },
      }
    ),
  };
}

/**
 * The menu behind a watched movie's indicator (its green tick or viewing
 * count): the same choices, and the same rules for which appear, as an
 * episode's green tick (viewingStatusActions). Each one plays its card
 * acknowledgement, which is the feedback; only a failure is reported in words
 * (by the host, from the rejection).
 */
export async function openMovieViewingMenu(tmdbId: number, name: string, target: HTMLElement): Promise<void> {
  let movie;
  try {
    movie = await db.movies.get(tmdbId);
  } catch (e) {
    showErrorToast(e, "open the menu");
    return;
  }
  if (!movie?.watched) return;
  const count = movieWatchCount(movie);
  openQuickMenu({
    anchor: rectAnchor(target),
    target,
    label: `${name}: viewing status`,
    title: name,
    subtitle: count === 1 ? "Watched once" : `Watched ${count} times`,
    entries: toEntries(viewingStatusActions(count), {
      "watched-once": async () => {
        if (count > 1) await setMovieWatchedOnceFromCard(tmdbId);
      },
      "watched-again": async () => void (await rewatchMovieFromCard(tmdbId)),
      "remove-last": async () => void (await removeLatestMovieViewingFromCard(tmdbId)),
      "not-watched": async () => void (await markMovieUnwatchedFromCard(tmdbId)),
    }),
  });
}

let openToken = 0;

/** Builds the menu from the item's current state, then opens it. A later press supersedes one still resolving. */
export async function openTitleQuickActions(t: TitleTarget, anchor: MenuAnchor, target: HTMLElement): Promise<void> {
  const token = ++openToken;
  let built: { subtitle: string; entries: QuickMenuEntry[] };
  try {
    built = t.kind === "show" ? await showMenu(t) : await movieMenu(t);
  } catch (e) {
    showErrorToast(e, "open the menu");
    return;
  }
  if (token !== openToken) return;
  openQuickMenu({ anchor, target, label: `${t.name}: quick actions`, title: t.name, subtitle: built.subtitle, entries: built.entries });
}

/** Spread on a show or movie card to give it Quick Actions. */
export function titleQuickActionProps(t: TitleTarget) {
  return contextActionProps((anchor, el) => {
    void openTitleQuickActions(t, anchor, el);
  });
}
