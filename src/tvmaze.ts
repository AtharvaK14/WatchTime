const TVMAZE_BASE = "https://api.tvmaze.com";

// Schema verified against a real example episode payload and TVmaze's own
// documentation (they explicitly state HATEOAS/HAL compliance, hence the
// _embedded wrapper). Not tested against a live call in this environment,
// api.tvmaze.com isn't reachable from this sandbox, so this is built
// directly from their documented behavior, the same transparency standard
// applied to every other unverified integration in this project.

interface TvmazeShow {
  id: number;
}

interface TvmazeEpisode {
  season: number;
  number: number | null; // null for specials
  runtime: number | null; // minutes, null if TVmaze doesn't have it for this episode either
}

interface TvmazeShowWithEpisodes extends TvmazeShow {
  _embedded?: { episodes: TvmazeEpisode[] };
}

/**
 * TVmaze's own show ID for a TVDB ID.
 *
 * null means TVmaze answered and has no such show. undefined means the
 * question went unanswered (offline, a server error), which is a different
 * thing: the caller stores the first and asks again after the second.
 */
export async function lookupTvmazeId(tvdbId: number): Promise<number | null | undefined> {
  try {
    const res = await fetch(`${TVMAZE_BASE}/lookup/shows?thetvdb=${tvdbId}`);
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const data: TvmazeShow = await res.json();
    return data.id ?? null;
  } catch {
    return undefined;
  }
}

/**
 * Real per-episode runtimes for a show, keyed by "season-number" to match
 * this app's own episode key format. Empty map (not a throw) on any
 * failure, since this is a best-effort accuracy improvement, not a hard
 * dependency, a show TVmaze doesn't have shouldn't break anything.
 */
export async function getTvmazeRuntimes(tvmazeId: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(`${TVMAZE_BASE}/shows/${tvmazeId}?embed=episodes`);
    if (!res.ok) return map;
    const data: TvmazeShowWithEpisodes = await res.json();
    for (const ep of data._embedded?.episodes ?? []) {
      if (ep.number === null || ep.runtime === null) continue; // specials or missing data
      map.set(`${ep.season}-${ep.number}`, ep.runtime);
    }
    return map;
  } catch {
    return map;
  }
}
