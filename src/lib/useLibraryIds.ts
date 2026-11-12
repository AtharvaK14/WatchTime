import { useMemo } from "react";
import { useAllMovies, useAllShows } from "./libraryStore";

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
 * Read from the tables the app already keeps in memory (lib/libraryStore.ts)
 * rather than with a query of its own: the answer is then known on a page's
 * first render, so "in your library" markers do not appear a beat after the
 * posters they sit on.
 */
export function useLibraryIds() {
  const allShows = useAllShows();
  const allMovies = useAllMovies();
  const showIds = useMemo(() => allShows?.map((s) => s.tmdbId), [allShows]);
  const movieIds = useMemo(() => allMovies?.map((m) => m.tmdbId), [allMovies]);
  return useMemo(
    () => ({
      shows: new Set<number>(showIds ?? []),
      movies: new Set<number>(movieIds ?? []),
      // False until both reads have landed, when the empty sets above mean
      // "not known yet" rather than "nothing in the library".
      ready: showIds !== undefined && movieIds !== undefined,
    }),
    [showIds, movieIds]
  );
}
