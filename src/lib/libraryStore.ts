// The library's four tables, read once and kept in memory for the life of the
// app, for every screen that needs a whole table.
//
// Each page used to open its own live query on mount. Pages are rebuilt on
// every tab switch, so every switch began with nothing: the page drew a
// skeleton (or "Working out which shows you're currently watching..."), read
// the whole table out of IndexedDB again - several thousand episodes and
// watch records for a large library - and only then drew the list. The data
// had not changed; it had just been thrown away with the page.
//
// One live query per table now outlives the pages. It starts the first time
// anything asks for the table, stays subscribed, and re-reads only when the
// table is written to, exactly as each page's own query did. A page mounting
// later gets the current rows on its very first render, so there is nothing
// to wait for and nothing to flash.
//
// The arrays are shared between every reader and must be treated as read
// only: copy before sorting. Development builds freeze them, so a mutation
// throws where it happens rather than quietly reordering another screen.

import { useSyncExternalStore } from "react";
import { liveQuery } from "dexie";
import { db, type Episode, type Movie, type Show, type WatchedEpisode } from "../db";

interface LiveStore<T> {
  subscribe: (listener: () => void) => () => void;
  get: () => T[] | undefined;
}

function createLiveStore<T>(read: () => Promise<T[]>): LiveStore<T> {
  let rows: T[] | undefined;
  let started = false;
  const listeners = new Set<() => void>();

  function start() {
    if (started) return;
    started = true;
    liveQuery(read).subscribe({
      next: (value) => {
        rows = import.meta.env?.DEV ? Object.freeze(value) as T[] : value;
        for (const listener of listeners) listener();
      },
      // A failed read leaves the last good rows in place; the query stays
      // subscribed and delivers again on the next write.
      error: () => {},
    });
  }

  return {
    subscribe(listener) {
      start();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => rows,
  };
}

const showsStore = createLiveStore<Show>(() => db.shows.toArray());
const episodesStore = createLiveStore<Episode>(() => db.episodes.toArray());
const watchedStore = createLiveStore<WatchedEpisode>(() => db.watchedEpisodes.toArray());
const moviesStore = createLiveStore<Movie>(() => db.movies.toArray());

function useStore<T>(store: LiveStore<T>): T[] | undefined {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Every show in the library. Undefined only until the first read of this launch. */
export const useAllShows = () => useStore(showsStore);
/** Every cached episode. */
export const useAllEpisodes = () => useStore(episodesStore);
/** Every watch record. */
export const useAllWatchedEpisodes = () => useStore(watchedStore);
/** Every movie in the library. */
export const useAllMovies = () => useStore(moviesStore);
