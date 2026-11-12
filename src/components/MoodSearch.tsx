import { useState, type FormEvent } from "react";
import type { SetupPhase } from "../lib/moodSearch/useMoodSearch";
import type { MoodFilter } from "../lib/moodSearch/search";
import SearchField from "./SearchField";
import SearchDock, { SearchDockClear } from "./SearchDock";
import { SearchIcon } from "./icons";

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
  placeholder = "Search shows & movies",
  docked = false,
}: {
  setup: SetupPhase;
  filter: MoodFilter | null;
  searching: boolean;
  dismissed: boolean;
  onSearch: (query: string) => void;
  onClear: () => void;
  onCancelSetup: () => void;
  resultCount: number;
  /** What the box searches, in the page's own words: Home says "your shows" or "your movies". */
  placeholder?: string;
  /**
   * Phones: the field lives in the bottom dock beside Home's Shows/Movies
   * switch (SearchDock, "home"); the setup progress and the match summary
   * stay here at the top of the page, above the lists they describe.
   */
  docked?: boolean;
}) {
  const [text, setText] = useState("");
  const [dockOpen, setDockOpen] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSearch(text);
    // Docked: the keyboard goes, so the results it was covering show.
    if (docked && document.activeElement instanceof HTMLElement) document.activeElement.blur();
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
      {docked ? (
        <SearchDock
          variant="home"
          expanded={dockOpen || text !== "" || filter !== null}
          collapsible={text === "" && filter === null}
          onExpand={() => setDockOpen(true)}
          onCollapse={() => {
            clear();
            setDockOpen(false);
          }}
          label={placeholder}
        >
          <form className="search-dock-field" onSubmit={submit} role="search">
            <SearchIcon size={20} />
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeholder}
              aria-label={placeholder}
              enterKeyHint="search"
              autoComplete="off"
            />
            {text.trim() !== "" && (
              <button
                type="submit"
                className="search-dock-go"
                onPointerDown={(e) => e.preventDefault()}
                disabled={searching}
                aria-label={searching ? "Searching" : "Search"}
              >
                {searching ? (
                  <span className="search-dock-spinner" aria-hidden="true" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                )}
              </button>
            )}
            <SearchDockClear
              hasText={text !== "" || filter !== null}
              onClear={clear}
              onClose={() => {
                clear();
                setDockOpen(false);
              }}
            />
          </form>
        </SearchDock>
      ) : (
      <form className="mood-search-row" onSubmit={submit} role="search">
        {/* The placeholder says what this box searches, and only that. It used
            to open with "Describe what you're in the mood for", which read as
            a recommendations box; recommendations are For You. What it
            actually searches is the shows and movies on this page (Up Next and
            Movies to Watch), by title or by description. It does not search
            episodes, so it does not claim to. */}
        <SearchField
          className="mood-search-input"
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setText(e.target.value)}
          clearable={Boolean(text || filter)}
          onClear={clear}
        />
        <button type="submit" disabled={searching || !text.trim()}>
          {searching ? "Searching..." : "Search"}
        </button>
      </form>
      )}

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
