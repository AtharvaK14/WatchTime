// Search versus browsing filters on the Shows and Movies pages.
//
// The two used to stack: the status and genre filters ran first and the title
// search ran over what was left, so searching for a show you had finished
// (or stopped, or rewatched) found nothing while the default "Currently
// Watching" filter was on, and the only way to find it was to change the
// filter first. A search is an explicit request for a title, so while there is
// a query it is matched against the WHOLE library, and the browsing filters
// are set aside rather than reset: they are still selected, and apply again
// the moment the search is cleared. Sorting is unaffected either way.

/** Case-insensitive substring match, the rule both pages have always used. */
export function titleMatches(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || title.toLowerCase().includes(q);
}

export interface SearchOrBrowseResult<T> {
  items: T[];
  /** A query is active, so the browsing filters are not being applied. */
  searching: boolean;
}

/**
 * The items a library page shows: every title matching the query while one is
 * typed, otherwise the items the browsing filters let through.
 */
export function searchOrBrowse<T>(
  items: readonly T[],
  query: string,
  titleOf: (item: T) => string,
  browse: (item: T) => boolean
): SearchOrBrowseResult<T> {
  if (query.trim() !== "") {
    return { items: items.filter((item) => titleMatches(titleOf(item), query)), searching: true };
  }
  return { items: items.filter(browse), searching: false };
}
