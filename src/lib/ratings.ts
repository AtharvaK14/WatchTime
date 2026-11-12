// TMDB star ratings for library titles (Show.tmdbRating / Movie.tmdbRating).
//
// New titles get theirs when they are added (lib/library.ts and the
// importers). Rows from before the field existed have none, so the cards that
// show a rating fill in exactly the ones they are about to display, one request
// each, the same way Home fills typed release dates for Releasing this month.

import { useEffect, useRef } from "react";
import { db, type Movie, type Show } from "../db";
import { fetchMetadataPatch, fillTitleMetadata } from "./titleMetadata";

/** The rating as a card shows it ("7.4"), or null when there is nothing worth showing. */
export function formatRating(rating: number | null | undefined): string | null {
  // TMDB reports 0 for a title nobody has voted on yet; that is "no rating",
  // not a terrible one.
  if (rating === null || rating === undefined || !(rating > 0)) return null;
  return rating.toFixed(1);
}

/** How many ratings a library backfill fetches before saving them in one write. */
const RATING_BATCH = 20;

/** Movies whose rating has never been looked up. */
export function moviesNeedingRating(movies: Movie[]): Movie[] {
  return movies.filter((m) => m.tmdbRating === undefined);
}

/**
 * Looks up and stores the rating of each movie given, in order, one request at
 * a time. Stops at the first failure (offline, a rate limit) and leaves the
 * rest undefined, so they are tried again on the next visit rather than being
 * recorded as having no rating.
 */
export async function backfillMovieRatings(movies: Movie[], shouldStop: () => boolean): Promise<void> {
  for (const movie of movies) {
    if (shouldStop()) return;
    try {
      // The rating, and whatever else the row is missing from the same
      // response (see lib/titleMetadata.ts).
      await fillTitleMetadata("movie", movie.tmdbId);
    } catch {
      return;
    }
  }
}

/**
 * Fills in missing ratings for a library grid while it is on screen, in the
 * order the grid shows them, so the cards at the top get theirs first.
 *
 * One request at a time, starting when the grid mounts and stopping when it
 * unmounts; the next visit carries on from wherever this one got to, since
 * only rows still undefined are picked. Reads the grid's current order from a
 * ref on each step rather than restarting whenever it changes: every rating
 * written is a library change, and restarting on each would re-scan the list
 * hundreds of times. Stops at the first failure (offline, a rate limit) and
 * leaves the rest for a later visit, never recording "no rating" for them.
 */
export function useRatingBackfill(
  kind: "show" | "movie",
  items: readonly { tmdbId: number; tmdbRating?: number | null }[] | undefined
): void {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Whether anything on the grid still needs a rating. A dependency of the
  // effect, so a pass that found nothing to do (an empty filter, say) starts
  // again when unrated titles come into the grid, while a pass in progress is
  // never restarted: this stays true until it has filled them all.
  const pending = items?.some((i) => i.tmdbRating === undefined) ?? false;
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const tried = new Set<number>();
    // Saved in batches: every write to the table re-runs every live query on
    // it, and the grid re-renders with it. One write per title meant several
    // hundred re-renders of a large library in a row; one per batch is a
    // handful. Whatever was fetched is still saved when the pass stops early.
    const toSave: { tmdbId: number; patch: Partial<Show> | Partial<Movie> }[] = [];
    const flush = async () => {
      if (toSave.length === 0) return;
      const batch = toSave.splice(0);
      if (kind === "show") {
        await db.transaction("rw", db.shows, async () => {
          for (const { tmdbId, patch } of batch) await db.shows.update(tmdbId, patch as Partial<Show>);
        });
      } else {
        await db.transaction("rw", db.movies, async () => {
          for (const { tmdbId, patch } of batch) await db.movies.update(tmdbId, patch as Partial<Movie>);
        });
      }
    };
    (async () => {
      try {
        while (!cancelled) {
          const next = itemsRef.current?.find((i) => i.tmdbRating === undefined && !tried.has(i.tmdbId));
          if (!next) return;
          tried.add(next.tmdbId);
          // The rating, plus anything else the row is missing that arrived in
          // the same response, so no other backfill asks for it again.
          let patch: Partial<Show> | Partial<Movie> | null;
          try {
            patch = await fetchMetadataPatch(kind, next.tmdbId);
          } catch {
            return;
          }
          if (!patch || Object.keys(patch).length === 0) continue;
          toSave.push({ tmdbId: next.tmdbId, patch });
          if (toSave.length >= RATING_BATCH) await flush();
        }
      } finally {
        await flush();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, pending]);
}
