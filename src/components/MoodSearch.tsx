import { useState, type FormEvent } from "react";
import type { SetupPhase } from "../lib/moodSearch/useMoodSearch";
import type { MoodFilter } from "../lib/moodSearch/search";
import { CloseIcon } from "./icons";

const EXAMPLE = "something slow burn and unsettling, not found footage, under 90 minutes";

function setupMessage(setup: SetupPhase): string | null {
  switch (setup.state) {
    case "downloading":
      return setup.progress === null
        ? "Setting up smart search (one-time download)..."
        : `Setting up smart search (one-time download) ${Math.round(setup.progress)}%`;
    case "indexing":
      return setup.phase === "fetching-overviews"
        ? `Reading your library (${setup.done} of ${setup.total})...`
        : `Learning your library (${setup.done} of ${setup.total})...`;
    default:
      return null;
  }
}

/**
 * The mood search box.
 *
 * Submit-on-enter rather than search-as-you-type, deliberately: every query
 * runs the model, so debounced live search would embed a dozen throwaway
 * prefixes of a sentence the user is still typing.
 */
export default function MoodSearch({
  setup,
  filter,
  searching,
  dismissed,
  onSearch,
  onClear,
  onCancelSetup,
  resultCount,
}: {
  setup: SetupPhase;
  filter: MoodFilter | null;
  searching: boolean;
  dismissed: boolean;
  onSearch: (query: string) => void;
  onClear: () => void;
  onCancelSetup: () => void;
  resultCount: number;
}) {
  const [text, setText] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    onSearch(text);
  }

  function clear() {
    setText("");
    onClear();
  }


  const progressMessage = dismissed ? null : setupMessage(setup);

  return (
    <div className="mood-search">
      {/* Same shape as Discover's search: field with an inline clear, then
          one button. Clear moved inside the field so the row is always
          exactly two items and can stay on a single line at any width. */}
      <form className="mood-search-row" onSubmit={submit} role="search">
        <div className="search-field">
          <input
            type="text"
            className="mood-search-input"
            value={text}
            placeholder={`Describe what you're in the mood for, e.g. "${EXAMPLE}"`}
            aria-label="Search by mood"
            onChange={(e) => setText(e.target.value)}
          />
          {(text || filter) && (
            <button type="button" className="search-clear" onClick={clear} aria-label="Clear search">
              <CloseIcon size={16} />
            </button>
          )}
        </div>
        <button type="submit" disabled={searching || !text.trim()}>
          {searching ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Non-blocking by design: the lists below stay interactive and usable
          throughout setup, and dismissing leaves plain search working. */}
      {progressMessage && (
        <div className="mood-search-status">
          <span className="muted small">{progressMessage}</span>
          <button type="button" className="mood-search-dismiss" onClick={onCancelSetup}>
            Use plain search instead
          </button>
        </div>
      )}

      {!dismissed && setup.state === "unavailable" && (
        <p className="muted small">
          Smart search is unavailable on this device, so this box is matching titles by name instead.
          Everything else works as normal.
        </p>
      )}

      {filter && (
        <div className="mood-search-summary">
          <span className="muted small">
            {resultCount === 0
              ? "No matches."
              : `${resultCount} match${resultCount === 1 ? "" : "es"}.`}
            {filter.mode === "keyword" && " Matched by title text."}
          </span>
          {filter.matchedTags.length > 0 && (
            <span className="mood-tags">
              {filter.matchedTags.map((tag) => (
                <span key={tag} className="mood-tag">
                  {tag}
                </span>
              ))}
            </span>
          )}
          {filter.excludedTags.length > 0 && (
            <span className="mood-tags">
              {filter.excludedTags.map((tag) => (
                <span key={tag} className="mood-tag excluded">
                  not {tag}
                </span>
              ))}
            </span>
          )}
          {(filter.runtime.maxMinutes !== null || filter.runtime.minMinutes !== null) && (
            <span className="mood-tags">
              {filter.runtime.maxMinutes !== null && (
                <span className="mood-tag">under {filter.runtime.maxMinutes} min</span>
              )}
              {filter.runtime.minMinutes !== null && (
                <span className="mood-tag">over {filter.runtime.minMinutes} min</span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
