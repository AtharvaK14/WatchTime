import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { TMDB_IMAGE_BASE } from "../tmdb";
import type { SearchResults } from "./UniversalSearch";
import EmptyState from "./EmptyState";
import { SearchIcon } from "./icons";

interface LibraryEntry {
  inLibrary: boolean;
  watched: boolean;
}

/**
 * Library membership for every title the user tracks, keyed by TMDB id.
 *
 * Search results come from TMDB, so they carry no knowledge of what the user
 * already has. This supplies that, live — adding a title from a result card
 * updates the badge without a refetch.
 *
 * A show counts as "watched" only when it is archived (the user stopped it).
 * Shows are ongoing by nature; a part-watched series is still something you
 * are tracking, so it keeps the badge. Movies are binary.
 */
function useLibraryIndex(): Map<string, LibraryEntry> {
  const shows = useLiveQuery(() => db.shows.toArray(), []);
  const movies = useLiveQuery(() => db.movies.toArray(), []);
  const index = new Map<string, LibraryEntry>();
  for (const s of shows ?? []) {
    index.set(`show:${s.tmdbId}`, { inLibrary: true, watched: !!s.isArchived });
  }
  for (const m of movies ?? []) {
    index.set(`movie:${m.tmdbId}`, { inLibrary: true, watched: !!m.watched });
  }
  return index;
}

interface Card {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  year: number | null;
  posterPath: string | null;
}

function ResultCard({
  item,
  entry,
  onOpen,
}: {
  item: Card;
  entry: LibraryEntry | undefined;
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
}) {
  // Only unwatched library titles are badged. A title you have already
  // finished does not need "you own this" attached to it — that is noise on a
  // result you searched for deliberately.
  const showBadge = entry?.inLibrary && !entry.watched;
  return (
    <button className="show-card" onClick={() => onOpen(item.kind, item.tmdbId)}>
      <div className="show-card-media">
        {item.posterPath ? (
          <img src={`${TMDB_IMAGE_BASE}${item.posterPath}`} alt={item.name} loading="lazy" decoding="async" />
        ) : (
          <div className="poster-placeholder" />
        )}
        {showBadge && <span className="library-badge">From library</span>}
        <div className="show-card-body">
          <p className="show-name">{item.name}</p>
          <p className="show-card-meta">
            {item.kind === "show" ? "TV" : "Film"}
            {item.year ? ` · ${item.year}` : ""}
          </p>
        </div>
      </div>
    </button>
  );
}

/**
 * Renders the output of UniversalSearch.
 *
 * Results are whatever TMDB returned for the query — the user's library is
 * never the source of the list, only an annotation on it. That is the
 * difference between a search and a filter, and it is the behaviour Home's
 * old mood box got wrong: it could only ever return titles already owned, so
 * searching for anything new came back empty.
 */
export default function SearchResultsGrid({
  results,
  onOpen,
}: {
  results: SearchResults;
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
}) {
  const library = useLibraryIndex();

  // Mood matches are suggestions rather than a requested title, so anything
  // already watched is dropped from them: re-recommending something you have
  // finished is the one case where library state should remove a result
  // rather than annotate it. Title matches are left alone — if you typed the
  // name, you want the title, watched or not.
  const mood = results.mood.filter((m) => !library.get(`${m.kind}:${m.tmdbId}`)?.watched);
  const nothing = results.titles.length === 0 && mood.length === 0;

  return (
    <>
      {results.titles.length > 0 && (
        <>
          <h3 className="section-title">Titles</h3>
          <div className="show-grid">
            {results.titles.map((t) => (
              <ResultCard
                key={`${t.kind}:${t.tmdbId}`}
                item={t}
                entry={library.get(`${t.kind}:${t.tmdbId}`)}
                onOpen={onOpen}
              />
            ))}
          </div>
        </>
      )}

      {results.moodAttempted && (
        <>
          <h3 className="section-title">Matching your description</h3>
          {results.moodMessage && <p className="muted small">{results.moodMessage}</p>}
          {mood.length === 0 && !results.moodMessage && <p className="muted small">Still looking...</p>}
          {mood.length > 0 && (
            <div className="show-grid">
              {mood.map((m) => (
                <ResultCard
                  key={`${m.kind}:${m.tmdbId}`}
                  item={m}
                  entry={library.get(`${m.kind}:${m.tmdbId}`)}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </>
      )}

      {nothing && !results.moodAttempted && (
        <EmptyState
          icon={SearchIcon}
          title="No results"
          body={`Nothing on TMDB matched "${results.query}". Try fewer words, or describe what you're in the mood for instead of naming a title.`}
        />
      )}
    </>
  );
}
