// One place the app collects "open this thing" requests that originate
// OUTSIDE React: a tapped notification, or a row tapped on a home-screen
// widget. Both arrive through native callbacks that can fire before App has
// mounted (a cold start launched by the tap), so a plain callback
// registration would drop them.
//
// The store therefore LATCHES: a request that arrives with no subscriber is
// held and delivered as soon as one appears. App consumes it and routes to
// the panels that already exist — nothing here renders anything itself.

export type DeepLinkTarget =
  | { kind: "episode"; showId: number; episodeKey: string }
  // seasonNumber is optional and set only by a batch-release notification —
  // "Season 3 is now available" has no single episode to open, so it opens
  // the show with that season already expanded, which is the thing the
  // notification was actually about. Every other show link omits it.
  | { kind: "show"; tmdbId: number; seasonNumber?: number }
  | { kind: "movie"; tmdbId: number };

type Listener = (target: DeepLinkTarget) => void;

let pending: DeepLinkTarget | null = null;
let listener: Listener | null = null;

export function requestDeepLink(target: DeepLinkTarget): void {
  if (listener) listener(target);
  else pending = target; // cold start: hold it until App subscribes
}

/**
 * Subscribes and immediately drains anything that arrived earlier.
 * Returns an unsubscribe function.
 */
export function onDeepLink(fn: Listener): () => void {
  listener = fn;
  if (pending) {
    const target = pending;
    pending = null;
    fn(target);
  }
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Narrow an untyped payload (native extras are `unknown`) into a target. */
export function parseDeepLinkTarget(raw: unknown): DeepLinkTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const showId = Number(data.showId);
  const tmdbId = Number(data.tmdbId);
  if (data.kind === "episode" && Number.isFinite(showId) && typeof data.episodeKey === "string") {
    return { kind: "episode", showId, episodeKey: data.episodeKey };
  }
  if (data.kind === "show") {
    // Two producers spell this differently: notifications send `tmdbId`,
    // matching DeepLinkTarget, while the widget overlay sends `showId`.
    // Accepting both is deliberate rather than lazy — a link the widget
    // queued natively before an app update has to still resolve after it.
    const id = Number.isFinite(tmdbId) ? tmdbId : showId;
    if (!Number.isFinite(id)) return null;
    const seasonNumber = Number(data.seasonNumber);
    return {
      kind: "show",
      tmdbId: id,
      ...(Number.isFinite(seasonNumber) ? { seasonNumber } : {}),
    };
  }
  if (data.kind === "movie" && Number.isFinite(tmdbId)) return { kind: "movie", tmdbId };
  return null;
}
