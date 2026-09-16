// What the app knows about streaming services BEYOND what TMDB tells it.
//
// TMDB's /watch/providers gives a name, a logo and an id, and nothing that can
// be tapped: no app identifier, and no URL for the title on the provider's own
// site (the `link` in the response is a JustWatch page). So opening Netflix on
// the title the user is looking at needs a second, local piece of knowledge,
// and this file is all of it - one entry per service, nothing about any
// service anywhere else in the codebase.
//
// Three rules shape it:
//
//  1. It is OPTIONAL. A provider with no entry here still renders, still shows
//     its real name and logo, and still opens somewhere sensible (the
//     JustWatch page TMDB supplied). Adding a service improves a capsule; it
//     is never what makes one work.
//  2. Nothing claims more than it can deliver. Where a service has no
//     title-level address that can be built from what we hold, the entry says
//     so with `precision: "search"` and the UI does not pretend otherwise.
//  3. An entry with no androidPackage is a normal, expected entry, not an
//     incomplete one - several services (Apple TV+ among them) simply have no
//     Android phone app, and sending those users to a store listing that does
//     not exist would be worse than the web player that does.

/** How close to the title the link actually lands. */
export type LinkPrecision =
  /** Straight to the title's own page in the service. */
  | "title"
  /** The service's search, pre-filled with the title. The user taps once more. */
  | "search"
  /** The service, and no further. */
  | "app";

export interface StreamingBrand {
  /** Stable id for this entry, used as a React key and in the launch payload. */
  id: string;
  /**
   * What the capsule says.
   *
   * TMDB's own provider_name is the name of an OFFER, not of a service:
   * "Netflix basic with Ads", "AMC+ Amazon Channel", "Amazon Prime Video with
   * Ads" are all separate entries pointing at the same place to watch. The
   * capsule answers "where can I watch this", so it carries the service's
   * name and nothing about which tier or storefront the licence came through.
   */
  displayName: string;
  /** TMDB provider ids that map here, including regional and ad-tier variants. */
  tmdbProviderIds: number[];
  /**
   * Normalised name fragments that also map here.
   *
   * Matched in addition to the ids because TMDB adds provider ids over time -
   * "Netflix Standard with Ads" and country-specific Prime Video entries are
   * separate ids from the ones known when this file was written, and a user
   * should not lose a working button to a provider id nobody has added yet.
   */
  namePatterns: string[];
  /** Android application id, when the service has an Android phone app. */
  androidPackage?: string;
  /** Where a tap lands. */
  precision: LinkPrecision;
  /**
   * The service's own web address for this title, built from the title's name.
   *
   * A web URL rather than a custom scheme on purpose: on Android these double
   * as App Links, so the installed app handles them and everyone else gets the
   * site - one address that degrades correctly instead of a scheme that fails
   * silently when the app is missing.
   */
  url: (title: string) => string;
}

const q = encodeURIComponent;

/**
 * Every service the app can open directly. Ordering is irrelevant; lookup is
 * by id and by name.
 *
 * Packages are only listed where the app is a phone app and the identifier is
 * the one the service actually ships - a wrong package would send an installed
 * user to a store page for something that does not exist, which is exactly the
 * dead end this feature is supposed to avoid. Omitting one costs nothing but a
 * browser hop.
 */
export const STREAMING_BRANDS: StreamingBrand[] = [
  {
    id: "netflix",
    displayName: "Netflix",
    tmdbProviderIds: [8, 1796, 175],
    namePatterns: ["netflix"],
    androidPackage: "com.netflix.mediaclient",
    precision: "search",
    url: (title) => `https://www.netflix.com/search?q=${q(title)}`,
  },
  {
    id: "prime-video",
    displayName: "Prime Video",
    tmdbProviderIds: [9, 10, 119, 2100],
    namePatterns: ["prime video", "amazon video"],
    androidPackage: "com.amazon.avod.thirdpartyclient",
    precision: "search",
    url: (title) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${q(title)}`,
  },
  {
    id: "apple-tv",
    displayName: "Apple TV",
    tmdbProviderIds: [2, 350],
    namePatterns: ["apple tv"],
    // No Android phone app: Apple TV+ on Android is the web player, so that is
    // the honest destination and there is no store listing to fall back to.
    precision: "search",
    url: (title) => `https://tv.apple.com/search?term=${q(title)}`,
  },
  {
    id: "disney-plus",
    displayName: "Disney+",
    tmdbProviderIds: [337, 390],
    namePatterns: ["disney plus", "disney+"],
    androidPackage: "com.disney.disneyplus",
    precision: "search",
    url: (title) => `https://www.disneyplus.com/search?q=${q(title)}`,
  },
  {
    id: "max",
    displayName: "Max",
    tmdbProviderIds: [384, 1899, 1825],
    namePatterns: ["hbo max", "max"],
    androidPackage: "com.wbd.stream",
    precision: "search",
    url: (title) => `https://play.max.com/search?q=${q(title)}`,
  },
  {
    id: "hulu",
    displayName: "Hulu",
    tmdbProviderIds: [15],
    namePatterns: ["hulu"],
    androidPackage: "com.hulu.plus",
    precision: "search",
    url: (title) => `https://www.hulu.com/search?q=${q(title)}`,
  },
  {
    id: "paramount-plus",
    displayName: "Paramount+",
    tmdbProviderIds: [531, 582, 1770],
    namePatterns: ["paramount"],
    androidPackage: "com.cbs.app",
    precision: "search",
    url: (title) => `https://www.paramountplus.com/search/?q=${q(title)}`,
  },
  {
    id: "peacock",
    displayName: "Peacock",
    tmdbProviderIds: [386, 387],
    namePatterns: ["peacock"],
    androidPackage: "com.peacocktv.peacockandroid",
    precision: "search",
    url: (title) => `https://www.peacocktv.com/search?q=${q(title)}`,
  },
  {
    id: "crunchyroll",
    displayName: "Crunchyroll",
    tmdbProviderIds: [283, 1968],
    namePatterns: ["crunchyroll"],
    androidPackage: "com.crunchyroll.crunchyroid",
    precision: "search",
    url: (title) => `https://www.crunchyroll.com/search?q=${q(title)}`,
  },
  {
    id: "hotstar",
    displayName: "JioHotstar",
    tmdbProviderIds: [122, 2336],
    namePatterns: ["hotstar", "jiohotstar"],
    androidPackage: "in.startv.hotstar",
    precision: "search",
    url: (title) => `https://www.hotstar.com/in/explore?search_query=${q(title)}`,
  },
  {
    id: "sonyliv",
    displayName: "SonyLIV",
    tmdbProviderIds: [237],
    namePatterns: ["sonyliv", "sony liv"],
    androidPackage: "com.sonyliv",
    precision: "app",
    url: () => "https://www.sonyliv.com/",
  },
  {
    id: "zee5",
    displayName: "ZEE5",
    tmdbProviderIds: [232],
    namePatterns: ["zee5"],
    androidPackage: "com.graymatrix.did",
    precision: "search",
    url: (title) => `https://www.zee5.com/search?q=${q(title)}`,
  },
  {
    id: "youtube",
    displayName: "YouTube",
    tmdbProviderIds: [192, 188],
    namePatterns: ["youtube"],
    androidPackage: "com.google.android.youtube",
    precision: "search",
    url: (title) => `https://www.youtube.com/results?search_query=${q(title)}`,
  },
  {
    id: "google-play",
    displayName: "Google Play",
    tmdbProviderIds: [3],
    namePatterns: ["google play", "google tv"],
    androidPackage: "com.google.android.videos",
    precision: "search",
    url: (title) => `https://play.google.com/store/search?c=movies&q=${q(title)}`,
  },
  // The services below are here largely FOR the normalisation: they are
  // distributed as channels inside other storefronts, so TMDB returns three or
  // four entries for one place to watch. Most carry no androidPackage - the
  // web address is a better destination than a guessed package that would send
  // an installed user to a store listing.
  {
    id: "amc-plus",
    displayName: "AMC+",
    tmdbProviderIds: [526],
    namePatterns: ["amc plus", "amc+"],
    precision: "search",
    url: (title) => `https://www.amcplus.com/search?q=${q(title)}`,
  },
  {
    id: "starz",
    displayName: "Starz",
    tmdbProviderIds: [43],
    namePatterns: ["starz"],
    precision: "app",
    url: () => "https://www.starz.com/",
  },
  {
    id: "showtime",
    displayName: "Showtime",
    tmdbProviderIds: [37],
    namePatterns: ["showtime"],
    precision: "app",
    url: () => "https://www.sho.com/",
  },
  {
    id: "mgm-plus",
    displayName: "MGM+",
    tmdbProviderIds: [],
    namePatterns: ["mgm plus", "mgm+", "epix"],
    precision: "app",
    url: () => "https://www.mgmplus.com/",
  },
  {
    id: "discovery-plus",
    displayName: "Discovery+",
    tmdbProviderIds: [520],
    namePatterns: ["discovery plus", "discovery+"],
    precision: "search",
    url: (title) => `https://www.discoveryplus.com/search?q=${q(title)}`,
  },
  {
    id: "britbox",
    displayName: "BritBox",
    tmdbProviderIds: [151],
    namePatterns: ["britbox"],
    precision: "search",
    url: (title) => `https://www.britbox.com/search?q=${q(title)}`,
  },
  {
    id: "shudder",
    displayName: "Shudder",
    tmdbProviderIds: [99],
    namePatterns: ["shudder"],
    precision: "app",
    url: () => "https://www.shudder.com/",
  },
  {
    id: "mubi",
    displayName: "MUBI",
    tmdbProviderIds: [11],
    namePatterns: ["mubi"],
    androidPackage: "com.mubi",
    precision: "search",
    url: (title) => `https://mubi.com/en/search/films?query=${q(title)}`,
  },
];

/** Lowercase, punctuation-free, single-spaced - so "Disney+" and "Disney Plus" compare equal. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Suffixes that describe HOW a service was bought rather than WHICH service it
 * is, stripped from a provider name before anything is matched or compared.
 *
 * Every one of these produced a duplicate capsule in practice: "AMC+", "AMC+
 * Amazon Channel" and "AMC+ Apple TV Channel" are one place to watch sold
 * three ways, and "Netflix" beside "Netflix basic with Ads" is one service
 * listed twice. The list is deliberately explicit and conservative rather than
 * a general "strip trailing words" rule, because over-stripping merges
 * genuinely different services, which is far worse than showing one capsule
 * too many.
 *
 * Note what is NOT here: a bare "Channel". "Hallmark Channel" and "AMC+ Amazon
 * Channel" end the same way and are not the same kind of name, so only an
 * explicitly named distributor is removed.
 */
const OFFER_SUFFIXES: RegExp[] = [
  // Storefront distribution: "<service> Amazon Channel", "… Apple TV Channel".
  /\s*[-–—]?\s*\b(amazon|apple\s*tv|roku|youtube|comcast|verizon|t-?mobile|sky|now)\b\s*(premium\s+)?channel$/i,
  // Ad-supported tiers: "… with Ads", "… Standard with Ads", "… (with Ads)".
  /\s*\(?\b(standard|basic|premium|essential)?\s*with\s+ads\)?$/i,
  /\s*\bad[-\s]?supported$/i,
  // Bare tier names.
  /\s*\b(standard|basic|premium|essential|plus)\s+(tier|plan)$/i,
  // "Prime Video Channels" and friends: the storefront, not a service.
  /\s*\bchannels$/i,
];

/**
 * A provider name with offer/tier wording removed, e.g.
 * "AMC+ Amazon Channel" -> "AMC+", "Netflix basic with Ads" -> "Netflix".
 *
 * Applied to the ORIGINAL string rather than the normalised one so the result
 * is still presentable: it is what the capsule falls back to displaying for a
 * service with no registry entry, and "AMC+" reads better than "amc plus".
 * Runs repeatedly because offers do stack ("… Standard with Ads Amazon
 * Channel"), and never strips down to nothing - a name that is ENTIRELY an
 * offer suffix is left exactly as TMDB gave it.
 */
export function coreProviderName(providerName: string): string {
  let name = providerName.trim();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const suffix of OFFER_SUFFIXES) {
      const stripped = name.replace(suffix, "").trim();
      if (stripped.length > 0 && stripped !== name) {
        name = stripped;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return name;
}

const byId = new Map<number, StreamingBrand>();
for (const brand of STREAMING_BRANDS) {
  for (const id of brand.tmdbProviderIds) byId.set(id, brand);
}

/**
 * Whether `needle` appears in `haystack` as a whole sequence of WORDS.
 *
 * Both sides are already normalised to single-spaced lowercase, so padding
 * each with a space turns a plain substring test into a word-boundary one.
 * That distinction is load-bearing rather than tidy: a bare substring test
 * matches "max" inside "Cinemax", and now that providers are deduplicated by
 * the brand they resolve to, a false match does not merely mislabel a capsule
 * — it merges two entirely different services into one.
 */
function containsWordSequence(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * The entry for a TMDB provider, or null when this service is not one the app
 * knows how to open directly.
 *
 * Id first, then name. The name pass is what keeps a regional or ad-supported
 * variant working without this file having to list every id TMDB will ever
 * mint; it matches a word sequence rather than the whole name precisely
 * because those variants are the base name plus a qualifier ("Netflix basic
 * with Ads", "Prime Video with Ads").
 *
 * Longest pattern wins, so "hbo max" is not shadowed by "max".
 */
export function findBrand(provider: { provider_id: number; provider_name: string }): StreamingBrand | null {
  const direct = byId.get(provider.provider_id);
  if (direct) return direct;

  // Matched on the core name, so a channel or ad-tier variant resolves to the
  // same brand its plain counterpart does even when TMDB has minted a separate
  // id for it that this file has never heard of.
  const name = normaliseName(coreProviderName(provider.provider_name));
  let best: { brand: StreamingBrand; length: number } | null = null;
  for (const brand of STREAMING_BRANDS) {
    for (const pattern of brand.namePatterns) {
      const normalised = normaliseName(pattern);
      if (!containsWordSequence(name, normalised)) continue;
      if (!best || normalised.length > best.length) best = { brand, length: normalised.length };
    }
  }
  return best?.brand ?? null;
}
