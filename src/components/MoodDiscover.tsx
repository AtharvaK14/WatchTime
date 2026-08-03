import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { TMDB_IMAGE_BASE, hasApiKey } from "../tmdb";
import { discoverByMood, type DiscoveryItem, type DiscoveryOutcome } from "../lib/moodSearch/discover";
import { subscribeToEmbedderStatus, cancelEmbedderLoad } from "../lib/moodSearch/embedder";
import type { IndexProgress } from "../lib/moodSearch/titleIndex";

const EXAMPLE = "a slow burn mystery that gets under your skin, nothing gory";

type Phase =
  | { state: "idle" }
  | { state: "downloading"; progress: number | null }
  | { state: "retrieving" }
  | { state: "ranking"; done: number; total: number };

function phaseMessage(phase: Phase): string | null {
  switch (phase.state) {
    case "downloading":
      return phase.progress === null
        ? "Setting up smart search (one-time download)..."
        : `Setting up smart search (one-time download) ${Math.round(phase.progress)}%`;
    case "retrieving":
      return "Finding candidates...";
    case "ranking":
      return `Reading summaries (${phase.done} of ${phase.total})...`;
    default:
      return null;
  }
}

function ResultCard({ item, onOpen }: { item: DiscoveryItem; onOpen: (item: DiscoveryItem) => void }) {
  return (
    <button className="show-card" onClick={() => onOpen(item)}>
      {item.posterPath ? (
        <img src={`${TMDB_IMAGE_BASE}${item.posterPath}`} alt={item.name} />
      ) : (
        <div className="poster-placeholder" />
      )}
      <div className="show-card-body">
        <p className="show-name">{item.name}</p>
        <p className="muted small">
          {item.kind === "show" ? "TV" : "Film"}
          {item.year ? ` · ${item.year}` : ""}
        </p>
        {item.inLibrary && <span className="mood-tag in-library">In your library</span>}
      </div>
    </button>
  );
}

/**
 * Mood-based discovery.
 *
 * Deliberately submit-on-enter rather than the debounced live search the
 * title box below it uses: each run costs TMDB calls plus an embedding pass
 * over the candidate pool, so firing on every keystroke would be both slow
 * and wasteful of the user's API quota.
 */
export default function MoodDiscover({ onOpen }: { onOpen: (kind: "show" | "movie", tmdbId: number) => void }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [outcome, setOutcome] = useState<DiscoveryOutcome | null>(null);
  const [running, setRunning] = useState(false);

  const mounted = useRef(true);
  const runId = useRef(0);
  const cancelled = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Download progress comes from the shared module-level embedder, so it
  // reports correctly even if Home already started the same load.
  useEffect(
    () =>
      subscribeToEmbedderStatus((status) => {
        if (!mounted.current) return;
        if (status.state === "loading") setPhase({ state: "downloading", progress: status.progress });
      }),
    []
  );

  const cancel = useCallback(() => {
    cancelled.current = true;
    cancelEmbedderLoad();
    setRunning(false);
    setPhase({ state: "idle" });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const query = text.trim();
    if (!query) return;

    const id = ++runId.current;
    cancelled.current = false;
    setRunning(true);
    setOutcome(null);
    setPhase({ state: "retrieving" });

    const isStale = () => !mounted.current || runId.current !== id || cancelled.current;
    const onProgress = (p: IndexProgress) => {
      if (!isStale()) setPhase({ state: "ranking", done: p.done, total: p.total });
    };

    const result = await discoverByMood(query, onProgress, isStale);
    if (isStale()) return;
    setOutcome(result);
    setPhase({ state: "idle" });
    setRunning(false);
  }

  const progress = phaseMessage(phase);

  return (
    <div className="mood-discover">
      <h3>In the mood for something?</h3>
      <p className="muted small">
        Describe what you feel like watching. Suggests titles you haven't watched, including ones not in your
        library yet.
      </p>

      <form className="mood-search-row" onSubmit={submit}>
        <input
          type="text"
          className="mood-search-input"
          value={text}
          placeholder={`e.g. "${EXAMPLE}"`}
          aria-label="Describe what you're in the mood for"
          onChange={(e) => setText(e.target.value)}
          disabled={!hasApiKey()}
        />
        <button type="submit" disabled={running || !text.trim() || !hasApiKey()}>
          {running ? "Working..." : "Suggest"}
        </button>
        {outcome && !running && (
          <button
            type="button"
            onClick={() => {
              setOutcome(null);
              setText("");
            }}
          >
            Clear
          </button>
        )}
      </form>

      {progress && (
        <div className="mood-search-status">
          <span className="muted small">{progress}</span>
          <button type="button" className="mood-search-dismiss" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}

      {outcome && outcome.status !== "ok" && <p className="muted small">{outcome.message}</p>}

      {outcome && outcome.status === "ok" && (
        <>
          <div className="mood-search-summary">
            <span className="muted small">
              {outcome.items.length === 0
                ? "Nothing matched closely enough."
                : `${outcome.items.length} suggestion${outcome.items.length === 1 ? "" : "s"}.`}
            </span>
            {outcome.matchedTags.length > 0 && (
              <span className="mood-tags">
                {outcome.matchedTags.map((tag) => (
                  <span key={tag} className="mood-tag">
                    {tag}
                  </span>
                ))}
              </span>
            )}
            {outcome.excludedTags.length > 0 && (
              <span className="mood-tags">
                {outcome.excludedTags.map((tag) => (
                  <span key={tag} className="mood-tag excluded">
                    not {tag}
                  </span>
                ))}
              </span>
            )}
          </div>

          {/* Retrieval is the ceiling on result quality (the model can only
              reorder what TMDB returned), so what it actually searched on is
              surfaced rather than hidden. */}
          {outcome.retrievalFailed ? (
            <p className="status-error small">
              Couldn't reach TMDB, so these are only titles already in your library. Check your API key and
              connection to get suggestions for things you don't own yet.
            </p>
          ) : (
            <p className="muted small">
              Searched {outcome.pooled} candidate{outcome.pooled === 1 ? "" : "s"}
              {outcome.usedKeywords.length > 0
                ? ` using TMDB keywords: ${outcome.usedKeywords.join(", ")}.`
                : " using genres only (no matching TMDB keywords)."}
            </p>
          )}

          {outcome.items.length > 0 && (
            <div className="show-grid">
              {outcome.items.slice(0, 24).map((item) => (
                <ResultCard
                  key={`${item.kind}:${item.tmdbId}`}
                  item={item}
                  onOpen={(i) => onOpen(i.kind, i.tmdbId)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
