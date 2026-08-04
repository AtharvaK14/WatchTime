import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  searchMovie,
  searchTvShow,
  TMDB_IMAGE_BASE,
  type MovieSearchResult,
  type TvSearchResult,
} from "../tmdb";
import { looksDescriptive } from "../lib/moodSearch/constraints";
import { discoverByMood, type DiscoveryItem } from "../lib/moodSearch/discover";
import type { IndexProgress } from "../lib/moodSearch/titleIndex";
import { CloseIcon } from "./icons";
import { useIsMobile } from "../lib/useIsMobile";

/**
 * One search box replaces what used to be three (title search, mood
 * discovery, and a separate refine box inside For You).
 *
 * The consolidation rests on one observation: users do not think of "find
 * The Sopranos" and "find me something bleak and slow" as different
 * features, they think of both as searching. So the box accepts either and
 * works out which is which, rather than making the user pick a mode first.
 *
 * The two paths have very different costs, which is why they are triggered
 * differently:
 *
 *   - Title lookup is cheap, so it runs as you type and fills the
 *     autocomplete dropdown.
 *   - Mood search runs a model over a fetched candidate pool, so it only
 *     runs on submit, and only when the query actually reads like a
 *     description rather than a title.
 */

const SUGGESTION_LIMIT = 8;
const DEBOUNCE_MS = 300;

// Two placeholders, not one truncated one.
//
// The full sentence is ~55 characters and the field is ~250px on a 375px
// screen, so on a phone it was cut off mid-word — which taught the user
// nothing and looked like a bug. Shortening it on small screens keeps the
// hint fully readable; the long form still explains the mood capability
// where there is room for it. The aria-label carries the full explanation in
// both cases, so nothing is lost to assistive tech.
const PLACEHOLDER_WIDE = "Search titles, or describe what you're in the mood for";
const PLACEHOLDER_NARROW = "Search or describe a mood";

interface Suggestion {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  year: number | null;
  posterPath: string | null;
  popularity: number;
}

function toSuggestions(shows: TvSearchResult[], movies: MovieSearchResult[]): Suggestion[] {
  const items: Suggestion[] = [
    ...shows.map((s) => ({
      kind: "show" as const,
      tmdbId: s.id,
      name: s.name,
      year: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) || null : null,
      posterPath: s.poster_path,
      popularity: s.popularity ?? 0,
    })),
    ...movies.map((m) => ({
      kind: "movie" as const,
      tmdbId: m.id,
      name: m.title,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) || null : null,
      posterPath: m.poster_path,
      popularity: m.popularity ?? 0,
    })),
  ];
  // Interleaving by popularity rather than grouping by type keeps the most
  // likely match at the top whichever medium it belongs to, which is what
  // makes a single box feel like one search rather than two stapled together.
  return items.sort((a, b) => b.popularity - a.popularity).slice(0, SUGGESTION_LIMIT);
}

export interface SearchResults {
  query: string;
  titles: Suggestion[];
  mood: DiscoveryItem[];
  moodAttempted: boolean;
  moodMessage?: string;
}

export default function UniversalSearch({
  onOpen,
  onResults,
  onClear,
}: {
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
  onResults: (results: SearchResults | null) => void;
  onClear: () => void;
}) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<IndexProgress | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const runId = useRef(0);

  // Debounced autocomplete. Deliberately does not clear existing suggestions
  // while the next request is in flight: blanking the list on every keystroke
  // makes the dropdown flicker and is worse than showing slightly stale rows
  // for 300ms.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const [shows, movies] = await Promise.all([searchTvShow(trimmed), searchMovie(trimmed)]);
        if (cancelled) return;
        const next = toSuggestions(shows, movies);
        setSuggestions(next);
        setOpen(next.length > 0);
        setActiveIndex(-1);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  // Click-away closes the dropdown but leaves the query intact, so the user
  // can dismiss the list without losing what they typed.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(suggestion: Suggestion) {
    setOpen(false);
    onOpen(suggestion.kind, suggestion.tmdbId);
  }

  async function runFullSearch(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const id = ++runId.current;
    const isStale = () => runId.current !== id;

    setOpen(false);
    setBusy(true);
    setProgress(null);

    const descriptive = looksDescriptive(trimmed);
    // Titles are shown for every query, descriptive or not: someone typing a
    // long exact title should still find it, and a mood query occasionally
    // matches a real title worth surfacing.
    let titles: Suggestion[] = [];
    try {
      const [shows, movies] = await Promise.all([searchTvShow(trimmed), searchMovie(trimmed)]);
      titles = toSuggestions(shows, movies);
    } catch {
      titles = [];
    }
    if (isStale()) return;

    if (!descriptive) {
      setBusy(false);
      onResults({ query: trimmed, titles, mood: [], moodAttempted: false });
      return;
    }

    onResults({ query: trimmed, titles, mood: [], moodAttempted: true });
    const outcome = await discoverByMood(
      trimmed,
      (p) => {
        if (!isStale()) setProgress(p);
      },
      isStale
    );
    if (isStale()) return;
    setBusy(false);
    setProgress(null);
    onResults({
      query: trimmed,
      titles,
      mood: outcome.items,
      moodAttempted: true,
      moodMessage: outcome.status === "ok" ? undefined : outcome.message,
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (activeIndex >= 0 && suggestions[activeIndex]) {
      pick(suggestions[activeIndex]);
      return;
    }
    runFullSearch(query);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  function clear() {
    runId.current++;
    setQuery("");
    setSuggestions([]);
    setOpen(false);
    setBusy(false);
    setProgress(null);
    onClear();
  }

  return (
    <div className="usearch" ref={boxRef}>
      <form className="usearch-form" onSubmit={submit} role="search">
        <div className="search-field">
          <input
            type="text"
            className="usearch-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            placeholder={isMobile ? PLACEHOLDER_NARROW : PLACEHOLDER_WIDE}
            aria-label="Search shows and movies, or describe a mood"
            role="combobox"
            aria-expanded={open}
            aria-controls="usearch-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `usearch-option-${activeIndex}` : undefined}
            autoComplete="off"
          />
          {query && (
            <button type="button" className="search-clear" onClick={clear} aria-label="Clear search">
              <CloseIcon size={16} />
            </button>
          )}
        </div>
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? "Searching..." : "Search"}
        </button>

        {open && suggestions.length > 0 && (
          <ul className="usearch-suggestions" id="usearch-suggestions" role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={`${s.kind}:${s.tmdbId}`}
                id={`usearch-option-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                className={`usearch-option ${i === activeIndex ? "active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => e.preventDefault()} // keep focus so the click lands
                onClick={() => pick(s)}
              >
                {s.posterPath ? (
                  <img src={`${TMDB_IMAGE_BASE}${s.posterPath}`} alt="" className="usearch-option-poster" />
                ) : (
                  <div className="poster-placeholder usearch-option-poster" />
                )}
                <span className="usearch-option-name">{s.name}</span>
                <span className="muted small">
                  {s.kind === "show" ? "TV" : "Film"}
                  {s.year ? ` · ${s.year}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </form>

      {progress && (
        <p className="muted small">
          Reading summaries ({progress.done} of {progress.total})...
        </p>
      )}
      {!progress && busy && looksDescriptive(query) && (
        <p className="muted small">Working out what matches that...</p>
      )}
    </div>
  );
}
