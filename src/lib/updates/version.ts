// Comparing release versions. Pure, so scripts/check-updates.ts can run it.
//
// Semantic-version precedence, read tolerantly, because the tags already on
// GitHub are not strict semver: the first two releases are tagged "1.0" and
// "1.01". So a leading "v" is optional, missing parts count as 0, and each
// part is compared as a number - "1.01" is 1.1.0, and "1.10" is newer than
// "1.9", which a string comparison gets backwards.

export interface ParsedVersion {
  /** major, minor, patch, and any further numeric parts. */
  parts: number[];
  /** Pre-release identifiers ("beta", "2"), empty for a full release. */
  pre: string[];
}

export function parseVersion(input: string): ParsedVersion | null {
  // Build metadata (after "+") never affects precedence.
  const text = input.trim().replace(/^v/i, "").split("+")[0];
  const dash = text.indexOf("-");
  const core = dash === -1 ? text : text.slice(0, dash);
  const pre = dash === -1 ? [] : text.slice(dash + 1).split(".");
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  if (pre.some((id) => !/^[0-9A-Za-z-]+$/.test(id))) return null;
  return { parts: core.split(".").map(Number), pre };
}

function comparePre(a: string[], b: string[]): number {
  // A full release outranks any pre-release of the same version.
  if (a.length === 0 || b.length === 0) return a.length === 0 ? (b.length === 0 ? 0 : 1) : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    // Fewer identifiers ranks lower when everything before matches.
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (an !== bn) {
      // Numeric identifiers rank below alphanumeric ones.
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** -1 if a is older than b, 1 if newer, 0 if equal, null if either cannot be read as a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre) as -1 | 0 | 1;
}

/**
 * Whether `candidate` is a newer version than `installed`.
 *
 * False when either cannot be parsed: a tag this code does not understand is
 * not a reason to tell someone to update.
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) === 1;
}

/** "v1.2.0" and "1.2.0" as the same thing to show: no leading v. */
export function displayVersion(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}
