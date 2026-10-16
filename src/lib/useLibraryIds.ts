import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";

/**
 * Which TMDB ids are in the library, read live.
 *
 * Live rather than a one-off read on purpose: adding or removing a title
 * happens in DetailsPanel, which Discover and For You open on top of
 * themselves, so their "in your library" markers update the moment that panel
 * writes - without the user closing it, and without either page refetching
 * anything from TMDB. A snapshot taken when the page loaded would keep
 * marking a removed title as owned until the page was left and reopened.
 *
 * primaryKeys() rather than toArray(): the only thing needed here is
 * membership, and a large library should not be materialised into objects to
 * answer that.
 */
export function useLibraryIds() {
  const showIds = useLiveQuery(() => db.shows.toCollection().primaryKeys(), []);
  const movieIds = useLiveQuery(() => db.movies.toCollection().primaryKeys(), []);
  return useMemo(
    () => ({
      shows: new Set<number>((showIds as number[] | undefined) ?? []),
      movies: new Set<number>((movieIds as number[] | undefined) ?? []),
      // False until both reads have landed, when the empty sets above mean
      // "not known yet" rather than "nothing in the library".
      ready: showIds !== undefined && movieIds !== undefined,
    }),
    [showIds, movieIds]
  );
}
