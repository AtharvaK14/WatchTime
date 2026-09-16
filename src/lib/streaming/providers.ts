// Streaming availability for one title: fetched from TMDB, cached in Dexie,
// and reduced to the short list a details panel can actually show.
//
// The whole feature reads from the content source the app already uses. No
// second provider, no second API key, and no new field on Show or Movie:
// availability is the one piece of title metadata that expires on its own
// (a series moves from one service to another without the title changing at
// all), so it lives in a cache with a TTL rather than in the library.

import { db, type WatchProviderCacheEntry } from "../../db";
import {
  getWatchProviders,
  TMDB_LOGO_BASE,
  type TmdbWatchProvider,
  type TmdbWatchProviderRegion,
} from "../../tmdb";
import { coreProviderName, findBrand, normaliseName, type StreamingBrand } from "./registry";

/** localStorage key for the region override. Exported so Settings and this module agree on it. */
export const WATCH_REGION_STORAGE = "watch_region";

/**
 * How long a cached availability answer is trusted, in hours.
 *
 * Licensing windows move on the scale of weeks, so a week is generous without
 * being wrong for long: the cost of being a few days stale is a capsule
 * pointing at a service the title just left, and the cost of a shorter TTL is
 * a TMDB request every time a panel opens. Same reasoning, and the same shape,
 * as the OMDb cache.
 */
const CACHE_TTL_HOURS = 24 * 7;

/**
 * How a title is available, in the order a viewer cares about.
 *
 * "Where can I watch this" overwhelmingly means "what does my subscription
 * already cover", so included-with-subscription and free tiers are shown and
 * rent/buy is a fallback for titles with no streaming home at all rather than
 * a peer of it. Showing both together would bury a real Netflix badge under
 * four storefronts selling the same film.
 */
export type StreamingAccess = "flatrate" | "free" | "ads" | "rent" | "buy";

const STREAMING_ACCESS: StreamingAccess[] = ["flatrate", "free", "ads"];
const PURCHASE_ACCESS: StreamingAccess[] = ["rent", "buy"];

export interface StreamingOption {
  /**
   * Identity of the CORE provider, stable across the offers that collapse into
   * it. React key and deduplication key both; not a TMDB provider id, because
   * the whole point is that several of those are one of these.
   */
  key: string;
  /** TMDB provider id of the offer chosen to represent this provider. */
  providerId: number;
  /** The service's name, with tier and channel wording removed. See coreProviderName(). */
  name: string;
  /** Fully-qualified logo URL, or null when TMDB has no logo for this provider. */
  logoUrl: string | null;
  access: StreamingAccess;
  /** The registry entry, when the app knows how to open this service directly. */
  brand: StreamingBrand | null;
}

export interface StreamingAvailability {
  /** The region these answers are for. */
  region: string;
  options: StreamingOption[];
  /**
   * JustWatch's page for this title and region, straight from TMDB.
   *
   * The catch-all destination: it is where a provider with no registry entry
   * goes, and where the "more" affordance goes when a title is on more
   * services than a capsule row should carry.
   */
  link: string | null;
  /** True when TMDB has availability data for this title, but not in this region. */
  availableElsewhere: boolean;
}

/**
 * The region to ask about.
 *
 * Availability is regional, so this is part of the question rather than a
 * setting bolted onto it - a title on Netflix in one country can be on a
 * different service, or on none, in another, and an app that quietly assumed
 * the US would be confidently wrong for everyone else. The device's own locale
 * is the default because it is right far more often than any fixed choice, and
 * Settings can override it for anyone whose subscriptions do not match where
 * their phone thinks it is.
 */
export function getWatchRegion(): string {
  const stored = localStorage.getItem(WATCH_REGION_STORAGE);
  if (stored && /^[A-Z]{2}$/.test(stored)) return stored;
  return deviceRegion();
}

export function setWatchRegion(region: string | null): void {
  if (region === null) localStorage.removeItem(WATCH_REGION_STORAGE);
  else localStorage.setItem(WATCH_REGION_STORAGE, region.toUpperCase());
}

/** Whether the region is being taken from the device rather than a stored choice. */
export function watchRegionIsAutomatic(): boolean {
  return !localStorage.getItem(WATCH_REGION_STORAGE);
}

/**
 * The device's country, from the browser's own locale.
 *
 * Intl.Locale's region is tried first because it understands the whole BCP 47
 * shape ("zh-Hans-SG" is Singapore, which splitting on "-" would read as
 * "Hans"); the split is the fallback for engines that do not have it. US only
 * when neither yields anything, which is also what TMDB's own examples assume.
 */
export function deviceRegion(): string {
  const locales = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const locale of locales) {
    if (!locale) continue;
    try {
      const region = new Intl.Locale(locale).region;
      if (region) return region.toUpperCase();
    } catch {
      // Not a locale this engine can parse; fall through to the split below.
    }
    const parts = locale.split("-");
    const tail = parts[parts.length - 1];
    if (parts.length > 1 && /^[A-Za-z]{2}$/.test(tail)) return tail.toUpperCase();
  }
  return "US";
}

function cacheKey(kind: "show" | "movie", tmdbId: number): string {
  return `${kind}:${tmdbId}`;
}

function isFresh(entry: WatchProviderCacheEntry, now: Date): boolean {
  const age = now.getTime() - new Date(entry.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_HOURS * 3600_000;
}

function logoUrl(path: string | null | undefined): string | null {
  return path ? `${TMDB_LOGO_BASE}${path}` : null;
}

/**
 * The core provider an offer belongs to: a stable key, the name to show, and
 * the registry entry when there is one.
 *
 * TMDB returns OFFERS, not services. One place to watch routinely arrives as
 * three or four entries with their own provider ids - "AMC+", "AMC+ Amazon
 * Channel", "AMC+ Apple TV Channel"; "Netflix" and "Netflix basic with Ads" -
 * and each of those is a separate provider_id, so the obvious key (the id)
 * deduplicates nothing. Resolving to a brand first, and to the offer's core
 * name when no brand is known, is what makes one capsule per service possible
 * without a hand-written list of every service that exists.
 */
function coreProviderOf(provider: TmdbWatchProvider): {
  key: string;
  name: string;
  brand: StreamingBrand | null;
} {
  const brand = findBrand(provider);
  // A brand is the strongest key available: it already gathers the ids AND the
  // name variants that mean one service, so every offer that resolves to it
  // collapses together whatever TMDB called them.
  if (brand) return { key: `brand:${brand.id}`, name: brand.displayName, brand };
  // Nothing known about this service, so fall back to its own name with the
  // tier/channel wording removed. Two offers of an unknown service still
  // collapse, and the capsule shows the service rather than the package.
  const name = coreProviderName(provider.provider_name);
  return { key: `name:${normaliseName(name)}`, name, brand: null };
}

/**
 * TMDB's per-access-type lists flattened into one ordered list of core
 * providers - the "where can I watch this" answer, one entry per service.
 *
 * Deduplication happens HERE, in the data layer, rather than by hiding
 * repeats in the UI: what reaches a component is already the list of distinct
 * places to watch, so the capsule row, any future sorting of it, and anything
 * else that ever consumes availability all see the same deduplicated set and
 * cannot disagree about how many services a title is on.
 *
 * First appearance wins. The access types are walked in preference order and
 * TMDB's display_priority orders each one (it is the ordering JustWatch itself
 * uses in that region), so the offer that represents a service is the most
 * favourable way to watch it: a title included with Prime AND sold by it shows
 * as included, once.
 */
function toOptions(region: TmdbWatchProviderRegion, accessTypes: StreamingAccess[]): StreamingOption[] {
  const seen = new Set<string>();
  const options: StreamingOption[] = [];
  for (const access of accessTypes) {
    const list = (region[access] ?? []) as TmdbWatchProvider[];
    const sorted = [...list].sort((a, b) => (a.display_priority ?? 0) - (b.display_priority ?? 0));
    for (const provider of sorted) {
      const core = coreProviderOf(provider);
      if (seen.has(core.key)) continue;
      seen.add(core.key);
      options.push({
        key: core.key,
        providerId: provider.provider_id,
        name: core.name,
        logoUrl: logoUrl(provider.logo_path),
        access,
        brand: core.brand,
      });
    }
  }
  return options;
}

/** Reads the stored region map for a title, fetching and caching it when needed. */
async function loadRegions(
  kind: "show" | "movie",
  tmdbId: number,
  now: Date
): Promise<Record<string, TmdbWatchProviderRegion>> {
  const key = cacheKey(kind, tmdbId);
  const cached = await db.watchProviders.get(key);
  if (cached && isFresh(cached, now)) {
    return (cached.regions ?? {}) as Record<string, TmdbWatchProviderRegion>;
  }

  const response = await getWatchProviders(kind, tmdbId);
  const regions = response.results ?? {};
  // Stored whole rather than per region: it is one document either way, so
  // keeping all of it means changing region in Settings costs no new requests
  // for titles already looked at.
  await db.watchProviders.put({
    cacheKey: key,
    kind,
    tmdbId,
    fetchedAt: now.toISOString(),
    regions,
  });
  return regions;
}

/**
 * Where a title can be watched, for the current region.
 *
 * Throws only what the TMDB client throws (a missing or rejected key, or a
 * network failure). Callers render availability as an enhancement and treat a
 * failure as "nothing to show" rather than an error state — a details panel
 * that cannot reach TMDB has bigger problems to report than this row.
 */
export async function getStreamingAvailability(
  kind: "show" | "movie",
  tmdbId: number,
  region = getWatchRegion(),
  now = new Date()
): Promise<StreamingAvailability> {
  const regions = await loadRegions(kind, tmdbId, now);
  const entry = regions[region];
  if (!entry) {
    return {
      region,
      options: [],
      link: null,
      // TMDB knows the title is streaming SOMEWHERE, just not here. Worth
      // distinguishing from "nobody streams this": the two deserve different
      // wording, and conflating them would tell a user in one country that a
      // title has no home at all.
      availableElsewhere: Object.keys(regions).length > 0,
    };
  }

  const streaming = toOptions(entry, STREAMING_ACCESS);
  // Rent/buy only when nothing includes the title: a storefront is the answer
  // to "where can I watch this" only when there is no better one.
  const options = streaming.length > 0 ? streaming : toOptions(entry, PURCHASE_ACCESS);
  return { region, options, link: entry.link ?? null, availableElsewhere: false };
}

/** Drops every cached availability answer. For Settings' region change, and for tests. */
export async function clearStreamingCache(): Promise<void> {
  await db.watchProviders.clear();
}
