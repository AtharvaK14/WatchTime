import { useState } from "react";
import { runImport, type ImportProgress, type ImportResult } from "../importer/runImport";
import { runJsonImport, type JsonImportProgress, type JsonImportResult } from "../importer/runJsonImport";
import type { DisambiguationCandidate, ResolveAmbiguous } from "../importer/matcher";
import { TMDB_IMAGE_BASE, hasApiKey } from "../tmdb";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";

interface PendingChoice {
  rawTitle: string;
  kind: "show" | "movie";
  candidates: DisambiguationCandidate[];
  resolve: (id: number | null) => void;
}

function MatchBreakdown({ counts }: { counts: Record<string, number> }) {
  return (
    <details open>
      <summary>How matches were resolved</summary>
      <ul className="match-method-list">
        {counts["exact-id"] > 0 && (
          <li>{counts["exact-id"]} matched by exact IMDb/TVDB ID, no ambiguity possible</li>
        )}
        {counts.single > 0 && <li>{counts.single} had only one TMDB result, unambiguous</li>}
        {counts["year-hint"] > 0 && <li>{counts["year-hint"]} resolved by TV Time's own year suffix</li>}
        {counts["exact-title"] > 0 && <li>{counts["exact-title"]} resolved by exact title match</li>}
        {counts["popularity-dominant"] > 0 && (
          <li>
            <strong>{counts["popularity-dominant"]} auto-picked</strong> because one candidate was decisively more
            popular, worth a quick spot check
          </li>
        )}
        {counts["user-picked"] > 0 && <li>{counts["user-picked"]} you picked manually</li>}
        {counts.skipped > 0 && <li>{counts.skipped} skipped, no confident match</li>}
      </ul>
    </details>
  );
}

// Split out from the main component specifically so useLockBodyScroll can be
// called unconditionally here. ImportWizard itself is mounted for as long as
// the Import section of Settings is expanded, not just while this picker is
// showing, so the hook can't live directly in ImportWizard without locking
// scroll the whole time Import is open rather than only while this modal is.
function DisambiguationModal({ pending, onChoose }: { pending: PendingChoice; onChoose: (id: number | null) => void }) {
  useLockBodyScroll();
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Which "{pending.rawTitle}"?</h3>
        <p className="muted small">Couldn't resolve this by ID, so pick the right match.</p>
        <div className="candidate-list">
          {pending.candidates.map((c) => (
            <button key={c.tmdbId} className="candidate" onClick={() => onChoose(c.tmdbId)}>
              {c.posterPath && <img src={`${TMDB_IMAGE_BASE}${c.posterPath}`} alt="" />}
              <span>{c.label}</span>
            </button>
          ))}
        </div>
        <button className="skip" onClick={() => onChoose(null)}>
          Skip this title
        </button>
      </div>
    </div>
  );
}

function JsonImportPanel({ resolveAmbiguous }: { resolveAmbiguous: ResolveAmbiguous }) {
  const [seriesFile, setSeriesFile] = useState<File | null>(null);
  const [moviesFile, setMoviesFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<JsonImportProgress | null>(null);
  const [result, setResult] = useState<JsonImportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setError(null);
    if (!hasApiKey()) {
      setError("Add your TMDB API key above first.");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const seriesJsonText = seriesFile ? await seriesFile.text() : undefined;
      const moviesJsonText = moviesFile ? await moviesFile.text() : undefined;
      if (!seriesJsonText && !moviesJsonText) {
        setError("Choose at least one JSON file.");
        setRunning(false);
        return;
      }
      const res = await runJsonImport({ seriesJsonText, moviesJsonText }, resolveAmbiguous, setProgress);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="panel">
      <p className="muted small">
        Uses a third-party export (e.g. "TV Time Out") that carries exact IMDb/TVDB IDs and TV Time's own watch
        status directly, more reliable than TV Time's raw GDPR CSVs since it doesn't need fuzzy title matching or
        reconstructing watch state from an event log. Files typically named{" "}
        <code>tvtime-series-*.json</code> and <code>tvtime-movies-*.json</code>.
      </p>
      <div className="field-row">
        <label className="file-label">
          Series JSON
          <input type="file" accept=".json" onChange={(e) => setSeriesFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="field-row">
        <label className="file-label">
          Movies JSON
          <input type="file" accept=".json" onChange={(e) => setMoviesFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <button onClick={handleRun} disabled={running || (!seriesFile && !moviesFile)}>
        {running ? "Importing..." : "Start import"}
      </button>

      {error && <p className="status-error">{error}</p>}

      {progress && progress.phase !== "done" && (
        <div className="progress-block">
          <p>
            {progress.phase === "shows" ? "Matching shows" : "Matching movies"}: {progress.current} / {progress.total}
          </p>
          <p className="muted small">Looking up: {progress.currentTitle}</p>
        </div>
      )}

      {result && (
        <div className="result-block">
          <h3>Import complete</h3>
          <p>
            Shows matched: {result.showsMatched} &middot; Episodes imported: {result.episodesImported} &middot;
            Movies matched: {result.moviesMatched}
          </p>
          <MatchBreakdown counts={result.matchMethodCounts} />
          {result.showsSkipped.length > 0 && (
            <details>
              <summary>{result.showsSkipped.length} show title(s) skipped</summary>
              <ul>
                {result.showsSkipped.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          )}
          {result.moviesSkipped.length > 0 && (
            <details>
              <summary>{result.moviesSkipped.length} movie title(s) skipped</summary>
              <ul>
                {result.moviesSkipped.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function CsvImportPanel({ resolveAmbiguous }: { resolveAmbiguous: ResolveAmbiguous }) {
  const [recordsFile, setRecordsFile] = useState<File | null>(null);
  const [recordsV2File, setRecordsV2File] = useState<File | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setError(null);
    if (!hasApiKey()) {
      setError("Add your TMDB API key above first.");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const recordsCsvText = recordsFile ? await recordsFile.text() : undefined;
      const recordsV2CsvText = recordsV2File ? await recordsV2File.text() : undefined;
      if (!recordsCsvText && !recordsV2CsvText) {
        setError("Choose at least one CSV file.");
        setRunning(false);
        return;
      }
      const res = await runImport({ recordsCsvText, recordsV2CsvText }, resolveAmbiguous, setProgress);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="panel">
      <p className="muted small">
        TV Time's own raw GDPR export. Works, but requires fuzzy title matching for everything and reconstructs
        watch history from a flat event log, use the JSON import above instead if you have access to it.
      </p>
      <div className="field-row">
        <label className="file-label">
          <code>tracking-prod-records.csv</code> (movies)
          <input type="file" accept=".csv" onChange={(e) => setRecordsFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="field-row">
        <label className="file-label">
          <code>tracking-prod-records-v2.csv</code> (episode history + follow status)
          <input type="file" accept=".csv" onChange={(e) => setRecordsV2File(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <button onClick={handleRun} disabled={running || (!recordsFile && !recordsV2File)}>
        {running ? "Importing..." : "Start import"}
      </button>

      {error && <p className="status-error">{error}</p>}

      {progress && progress.phase !== "done" && (
        <div className="progress-block">
          <p>
            {progress.phase === "shows" ? "Matching shows" : "Matching movies"}: {progress.current} / {progress.total}
          </p>
          <p className="muted small">Looking up: {progress.currentTitle}</p>
        </div>
      )}

      {result && (
        <div className="result-block">
          <h3>Import complete</h3>
          <p>
            Shows matched: {result.showsMatched} &middot; Episodes imported: {result.episodesImported} &middot;
            Movies matched: {result.moviesMatched}
          </p>
          <MatchBreakdown counts={result.matchMethodCounts} />
          {result.showsSkipped.length > 0 && (
            <details>
              <summary>{result.showsSkipped.length} show title(s) skipped</summary>
              <ul>
                {result.showsSkipped.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          )}
          {result.moviesSkipped.length > 0 && (
            <details>
              <summary>{result.moviesSkipped.length} movie title(s) skipped</summary>
              <ul>
                {result.moviesSkipped.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function ImportWizard() {
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const [source, setSource] = useState<"json" | "csv">("json");

  const resolveAmbiguous: ResolveAmbiguous = (rawTitle, kind, candidates) => {
    return new Promise<number | null>((resolve) => {
      setPending({ rawTitle, kind, candidates, resolve });
    });
  };

  function choose(id: number | null) {
    if (!pending) return;
    pending.resolve(id);
    setPending(null);
  }

  return (
    <div className="panel">
      <h3>Import from TV Time</h3>
      <div className="field-row">
        <select value={source} onChange={(e) => setSource(e.target.value as "json" | "csv")}>
          <option value="json">Third-party JSON export (recommended)</option>
          <option value="csv">TV Time's own raw GDPR CSV export</option>
        </select>
      </div>

      {source === "json" ? (
        <JsonImportPanel resolveAmbiguous={resolveAmbiguous} />
      ) : (
        <CsvImportPanel resolveAmbiguous={resolveAmbiguous} />
      )}

      {pending && <DisambiguationModal pending={pending} onChoose={choose} />}
    </div>
  );
}
