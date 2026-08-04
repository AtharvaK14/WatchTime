// Deterministic, non-ML parsing of a mood-search query.
//
// Everything in this file is a pure function of its input string. No model,
// no Dexie, no DOM, no clock. That is deliberate: the embedding half of
// mood search is inherently fuzzy and hard to assert on, so the half that
// CAN be pinned down exactly (numbers and negation) is kept fully isolated
// and directly testable.
//
// Scope note: this parses English only. A query in another language yields
// an empty result here, which the caller treats as "no structured signal"
// and falls back accordingly, rather than as an error.

/** Upper and/or lower bound on runtime, in minutes. */
export interface RuntimeConstraint {
  maxMinutes: number | null;
  minMinutes: number | null;
}

export interface ParsedConstraints {
  runtime: RuntimeConstraint;
  /** Phrases the user explicitly excluded, lowercased, e.g. ["found footage"]. */
  negatedPhrases: string[];
  /**
   * The query with the runtime clauses and negated spans removed, so the
   * embedding step sees only what the user wants INCLUDED. Without this,
   * embedding the raw text would push the query vector toward exactly the
   * thing being excluded, since sentence embeddings do not reliably encode
   * negation.
   */
  positiveText: string;
}

// Word-number support is limited to the small set that actually shows up in
// runtime phrasing. Anything larger is written as digits in practice.
const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  half: 0.5,
  ninety: 90,
  sixty: 60,
  forty: 40,
  thirty: 30,
  twenty: 20,
};

const MINUTES_PER_HOUR = 60;

/** Longest phrase (in words) a single negation cue is allowed to swallow. */
const MAX_NEGATED_PHRASE_WORDS = 4;

// Tokens that end a negated span. A negation applies to the phrase right
// after it, not to the rest of the sentence: in "not found footage, under 90
// minutes" the runtime clause is a separate positive requirement, and in
// "no jump scares but genuinely scary" the second half is wanted, not
// excluded. Without these boundaries a single "not" would silently negate
// every remaining term in the query.
const NEGATION_BOUNDARY = new Set([
  "and",
  "but",
  "or",
  "with",
  "that",
  "just",
  "under",
  "over",
  "less",
  "more",
  "at",
  "nothing",
  "no",
  "not",
  "without",
]);

const NEGATION_CUES = ["not", "no", "without", "nothing", "none of", "excluding", "except"];

function toNumber(token: string): number | null {
  const digits = Number(token);
  if (Number.isFinite(digits)) return digits;
  return WORD_NUMBERS[token] ?? null;
}

/**
 * Matches "<comparator> <amount> <unit>", e.g. "under 90 minutes",
 * "less than 2 hours", "at least 30 min", "over an hour".
 *
 * Also handles the trailing form "90 minutes or less" / "2 hours or under",
 * which reads naturally enough that users write it and a leading-comparator
 * regex alone would miss it entirely.
 */
const LEADING_COMPARATOR =
  /\b(under|below|less than|shorter than|at most|no longer than|over|above|more than|longer than|at least)\s+(?:about\s+|around\s+|roughly\s+)?([\d.]+|[a-z]+)(?:\s+and\s+a\s+(half))?\s*(hours?|hrs?|h|minutes?|mins?|m)\b/g;

// The "and a half" group is repeated here rather than shared with the
// leading pattern: without it "one and a half hours or less" matches on the
// bare word "half" and resolves to 30 minutes instead of 90, silently
// producing a bound three times tighter than the user asked for.
const TRAILING_COMPARATOR =
  /\b([\d.]+|[a-z]+)(?:\s+and\s+a\s+(half))?\s*(hours?|hrs?|h|minutes?|mins?|m)\s+or\s+(less|under|shorter|fewer|more|over|longer)\b/g;

const UPPER_BOUND_WORDS = new Set([
  "under",
  "below",
  "less than",
  "shorter than",
  "at most",
  "no longer than",
  "less",
  "shorter",
  "fewer",
]);

function isHourUnit(unit: string): boolean {
  return unit.startsWith("h");
}

function tighten(current: number | null, candidate: number, keep: "min" | "max"): number {
  if (current === null) return candidate;
  // Two bounds of the same direction in one query ("under 2 hours, under 90
  // minutes") are combined to the stricter one rather than last-wins, so the
  // result never contradicts something the user actually typed.
  return keep === "max" ? Math.min(current, candidate) : Math.max(current, candidate);
}

/**
 * Extracts runtime bounds, and returns the query with the matched clauses
 * blanked out so they do not also feed the embedding step ("under 90
 * minutes" carries no mood signal, but it is not nothing to a sentence
 * encoder either).
 */
export function parseRuntime(query: string): { constraint: RuntimeConstraint; rest: string } {
  const lower = query.toLowerCase();
  let maxMinutes: number | null = null;
  let minMinutes: number | null = null;
  const spans: [number, number][] = [];

  for (const match of lower.matchAll(LEADING_COMPARATOR)) {
    const [full, comparator, amountToken, halfToken, unit] = match;
    let amount = toNumber(amountToken);
    if (amount === null) continue;
    if (halfToken) amount += 0.5;
    const minutes = Math.round(isHourUnit(unit) ? amount * MINUTES_PER_HOUR : amount);
    if (minutes <= 0) continue;
    if (UPPER_BOUND_WORDS.has(comparator)) maxMinutes = tighten(maxMinutes, minutes, "max");
    else minMinutes = tighten(minMinutes, minutes, "min");
    spans.push([match.index, match.index + full.length]);
  }

  for (const match of lower.matchAll(TRAILING_COMPARATOR)) {
    const [full, amountToken, halfToken, unit, direction] = match;
    let amount = toNumber(amountToken);
    if (amount === null) continue;
    if (halfToken) amount += 0.5;
    const minutes = Math.round(isHourUnit(unit) ? amount * MINUTES_PER_HOUR : amount);
    if (minutes <= 0) continue;
    if (UPPER_BOUND_WORDS.has(direction)) maxMinutes = tighten(maxMinutes, minutes, "max");
    else minMinutes = tighten(minMinutes, minutes, "min");
    spans.push([match.index, match.index + full.length]);
  }

  return { constraint: { maxMinutes, minMinutes }, rest: blankOut(query, spans) };
}

/** Replaces the given ranges with spaces, preserving offsets of everything else. */
function blankOut(text: string, spans: [number, number][]): string {
  if (spans.length === 0) return text;
  const chars = [...text];
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = " ";
  }
  return chars.join("");
}

/**
 * Extracts explicitly excluded phrases, and returns the query with those
 * spans removed.
 *
 * A cue claims the following words up to MAX_NEGATED_PHRASE_WORDS, stopping
 * early at punctuation or a boundary word. "no" is only treated as a cue
 * when something follows it, so a bare trailing "no" is ignored instead of
 * producing an empty exclusion that would match everything.
 */
export function parseNegations(query: string): { negatedPhrases: string[]; rest: string } {
  const lower = query.toLowerCase();
  const negatedPhrases: string[] = [];
  const spans: [number, number][] = [];

  // Tokenise with offsets so spans can be blanked out of the ORIGINAL text.
  const tokens: { text: string; start: number; end: number; endsClause: boolean }[] = [];
  for (const m of lower.matchAll(/[a-z0-9'-]+([,.;!?]*)/g)) {
    const raw = m[0];
    const word = raw.replace(/[,.;!?]+$/, "");
    if (!word) continue;
    tokens.push({
      text: word,
      start: m.index,
      end: m.index + word.length,
      endsClause: raw.length > word.length,
    });
  }

  for (let i = 0; i < tokens.length; i++) {
    const isCue =
      NEGATION_CUES.includes(tokens[i].text) ||
      (tokens[i].text === "none" && tokens[i + 1]?.text === "of");
    if (!isCue) continue;

    let cursor = i + 1;
    if (tokens[i].text === "none" && tokens[cursor]?.text === "of") cursor++;

    const phrase: string[] = [];
    let spanEnd = tokens[i].end;
    while (cursor < tokens.length && phrase.length < MAX_NEGATED_PHRASE_WORDS) {
      const token = tokens[cursor];
      if (NEGATION_BOUNDARY.has(token.text)) break;
      phrase.push(token.text);
      spanEnd = token.end;
      cursor++;
      if (token.endsClause) break; // comma or full stop closes the phrase
    }

    if (phrase.length === 0) continue; // bare cue with nothing to exclude
    negatedPhrases.push(phrase.join(" "));
    spans.push([tokens[i].start, spanEnd]);
    i = cursor - 1;
  }

  return { negatedPhrases, rest: blankOut(query, spans) };
}

/**
 * Collapses whitespace and removes the debris that blanking leaves behind.
 *
 * The connective strip matters more than it looks: removing a clause from
 * the middle of a sentence strands its conjunction, so "not found footage
 * and no gore" would otherwise hand the embedding step the single word
 * "and". That is not harmless, it is a real vector pointing somewhere
 * arbitrary, and it would be treated as if the user had meant it.
 */
const STRAY_CONNECTIVES = /^(?:and|but|or|with|that|just|then|so)\b\s*|\s*\b(?:and|but|or|with|that|just|then|so)$/g;

function tidy(text: string): string {
  let out = text
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .replace(/^[\s,;.]+|[\s,;.]+$/g, "")
    .trim();
  // Looped because stripping one connective can expose another
  // ("... and just" -> "... and" -> "...").
  let previous: string;
  do {
    previous = out;
    out = out.replace(STRAY_CONNECTIVES, "").replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
  } while (out !== previous);
  return out;
}

/**
 * Full deterministic pass. Runtime is parsed first so that a phrase like
 * "no longer than 90 minutes" is consumed as a runtime bound rather than
 * being mistaken for a negation of the word "than".
 */
export function parseConstraints(query: string): ParsedConstraints {
  const { constraint: runtime, rest: afterRuntime } = parseRuntime(query);
  const { negatedPhrases, rest } = parseNegations(afterRuntime);
  return { runtime, negatedPhrases, positiveText: tidy(rest) };
}

/** True when the parse found nothing at all to act on. */
export function isEmptyConstraints(parsed: ParsedConstraints): boolean {
  return (
    parsed.runtime.maxMinutes === null &&
    parsed.runtime.minMinutes === null &&
    parsed.negatedPhrases.length === 0
  );
}

/**
 * Word count at or above which a query reads as a description rather than a
 * title. Four is deliberately conservative: real titles routinely run three
 * words ("Better Call Saul"), and misreading a title as a mood query is the
 * more annoying error, since title results are shown for every query anyway.
 */
const DESCRIPTIVE_WORD_COUNT = 4;

/**
 * Whether a query should also run the (expensive) mood pipeline, or is just
 * a title lookup. Lives here rather than in the search component because it
 * is pure query analysis, and because it needs to be testable without a DOM.
 */
export function looksDescriptive(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  const parsed = parseConstraints(trimmed);
  // An explicit constraint ("under 90 minutes", "not found footage") is
  // conclusive on its own: no title contains one.
  if (parsed.runtime.maxMinutes !== null || parsed.runtime.minMinutes !== null) return true;
  if (parsed.negatedPhrases.length > 0) return true;
  return trimmed.split(/\s+/).length >= DESCRIPTIVE_WORD_COUNT;
}

/** Applies the runtime bounds. A title with unknown runtime is never excluded. */
export function satisfiesRuntime(runtimeMinutes: number | null | undefined, c: RuntimeConstraint): boolean {
  // Unknown runtime passes deliberately. Show.episodeRuntimeMinutes and
  // Movie.runtimeMinutes are both backfilled lazily and are undefined for
  // plenty of real rows; excluding those would make a runtime filter
  // quietly hide titles that might well have matched.
  if (runtimeMinutes == null) return true;
  if (c.maxMinutes !== null && runtimeMinutes > c.maxMinutes) return false;
  if (c.minMinutes !== null && runtimeMinutes < c.minMinutes) return false;
  return true;
}
