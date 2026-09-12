/**
 * Checks provider normalisation, run with `npm run check:streaming`.
 *
 * It exists for the same reason the Watch Next one does: the failure mode is
 * silent. TMDB returns OFFERS, not services — "Netflix" and "Netflix Standard
 * with Ads" and "AMC+ Amazon Channel" are separate entries pointing at the
 * same place to watch — so the app collapses them, and a collapse rule that is
 * a little too eager merges two genuinely different services into one capsule
 * without anything looking broken. "Cinemax" ending in "max" is the exact
 * shape of that bug.
 *
 * So both directions are asserted here: what MUST merge, and what must NOT.
 */

import { coreProviderName, findBrand } from "../src/lib/streaming/registry";

interface Case {
  /** What TMDB returns, as (provider_id, provider_name) pairs. */
  offers: [number, string][];
  /** Expected number of distinct capsules. */
  distinct: number;
  /** Expected display names, in no particular order. */
  names: string[];
}

/**
 * Mirrors coreProviderOf() in lib/streaming/providers.ts: brand first, core
 * name second. Kept here as a few lines rather than exported from that module,
 * which would mean loading Dexie and the TMDB client to test two pure
 * functions.
 */
function resolve(id: number, name: string): { key: string; display: string } {
  const brand = findBrand({ provider_id: id, provider_name: name });
  if (brand) return { key: `brand:${brand.id}`, display: brand.displayName };
  const core = coreProviderName(name);
  return { key: `name:${core.toLowerCase()}`, display: core };
}

const cases: Record<string, Case> = {
  "Netflix ad tier collapses": {
    offers: [
      [8, "Netflix"],
      [1796, "Netflix basic with Ads"],
    ],
    distinct: 1,
    names: ["Netflix"],
  },
  "AMC+ channel variants collapse": {
    offers: [
      [526, "AMC+"],
      [528, "AMC+ Amazon Channel"],
      [1854, "AMC+ Apple TV Channel"],
    ],
    distinct: 1,
    names: ["AMC+"],
  },
  "Prime Video variants collapse": {
    offers: [
      [9, "Amazon Prime Video"],
      [119, "Prime Video"],
      [2100, "Amazon Prime Video with Ads"],
    ],
    distinct: 1,
    names: ["Prime Video"],
  },
  "a service the registry has never heard of still collapses": {
    offers: [
      [90001, "Nebula TV"],
      [90002, "Nebula TV Amazon Channel"],
      [90003, "Nebula TV with Ads"],
    ],
    distinct: 1,
    names: ["Nebula TV"],
  },
  "genuinely different services stay separate": {
    offers: [
      [8, "Netflix"],
      [119, "Prime Video"],
      [15, "Hulu"],
      [350, "Apple TV+"],
      [526, "AMC+"],
    ],
    distinct: 5,
    names: ["Netflix", "Prime Video", "Hulu", "Apple TV", "AMC+"],
  },
  // The substring trap: "Cinemax" contains "max", and "Hallmark Channel" ends
  // in "Channel". Neither may be touched.
  "lookalike names are not merged or truncated": {
    offers: [
      [1899, "Max"],
      [90010, "Cinemax"],
      [90011, "Hallmark Channel"],
    ],
    distinct: 3,
    names: ["Max", "Cinemax", "Hallmark Channel"],
  },
};

const failures: string[] = [];

for (const [label, testCase] of Object.entries(cases)) {
  const seen = new Map<string, string>();
  for (const [id, name] of testCase.offers) {
    const { key, display } = resolve(id, name);
    if (!seen.has(key)) seen.set(key, display);
  }
  const names = [...seen.values()];
  console.log(`${label}\n  ${testCase.offers.map(([, n]) => n).join(" | ")}\n  -> ${names.join(" | ")}`);

  if (seen.size !== testCase.distinct) {
    failures.push(`${label}: expected ${testCase.distinct} capsule(s), got ${seen.size} (${names.join(", ")})`);
  }
  for (const expected of testCase.names) {
    if (!names.includes(expected)) failures.push(`${label}: expected a capsule named "${expected}", got ${names.join(", ")}`);
  }
}

console.log();
if (failures.length === 0) {
  console.log("All provider normalisation cases pass.");
} else {
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  process.exitCode = 1;
}
