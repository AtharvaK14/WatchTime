import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { TMDB_IMAGE_BASE } from "../tmdb";
import type { SearchResults } from "./UniversalSearch";
import EmptyState from "./EmptyState";
import { ShowGridSkeleton } from "./Skeleton";
import { SearchIcon } from "./icons";

interface LibraryEntry {
  inLibrary: boolean;
  watched: boolean;
}

/**
 * Library membership for every title the user tracks, keyed by TMDB id.
 *
 * Title results come from TMDB, so they carry no knowledge of what the user
 * already has. This supplies that, live — adding a title from a result card
 * updates the badge without a refetch. (Recommendation results already carry
 * their own inLibrary flag from the discovery pipeline, which computes it
 * against the same tables.)
 *
 * A show counts as "watched" only when it is archived. Shows are ongoing by
 * nature; a part-watched series is still something you are tracking, so it
 * keeps the badge. Movies are binary.
 */
function useLibraryIndex(): Map<string, LibraryEntry> {
  const shows = useLiveQuery(() => db.shows.toArray(), []);
  const movies = useLiveQuery(() => db.movies.toArray(), []);
  const index = new Map<string, LibraryEntry>();
  for (const s of shows ?? []) index.set(`show:${s.tmdbId}`, { inLibrary: true, watched: !!s.isArchived });
  for (const m of movies ?? []) index.set(`movie:${m.tmdbId}`, { inLibrary: true, watched: !!m.watched });
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
  badge,
  onOpen,
}: {
  item: Card;
  badge: boolean;
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
}) {
  return (
    <button className="show-card" onClick={() => onOpen(item.kind, item.tmdbId)}>
      <div className="show-card-media">
        {item.posterPath ? (
          <img src={`${TMDB_IMAGE_BASE}${item.posterPath}`} alt={item.name} loading="lazy" decoding="async" />
        ) : (
          <div className="poster-placeholder" />
        )}
        {badge && <span className="library-badge">In library</span>}
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

function Grid({
  items,
  badge,
  onOpen,
}: {
  items: Card[];
  badge: boolean;
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
}) {
  return (
    <div className="show-grid">
      {items.map((i) => (
        <ResultCard key={`${i.kind}:${i.tmdbId}`} item={i} badge={badge} onOpen={onOpen} />
      ))}
    </div>
  );
}

/**
 * Renders the output of UniversalSearch.
 *
 * Ordering depends on what the query WAS, which is the whole point of the
 * recommendation-vs-lookup split:
 *
 *   - A description ("something scary") leads with recommendations, and
 *     within those, with titles already in the library. Somebody asking for
 *     something scary is best served by the horror film they already own and
 *     have not watched. Literal title matches for that text are almost always
 *     noise, so they go last under a heading that says what they are.
 *   - A title lookup ("Silo") leads with titles, because that is what was
 *     asked for.
 *
 * Results are never sourced FROM the library — TMDB is always the source, and
 * library membership only reorders and annotates. That is the difference
 * between a search and a filter, and it is what Home's old mood box got
 * wrong: it could only ever return titles already owned.
 */
export default function SearchResultsGrid({
  results,
  onOpen,
}: {
  results: SearchResults;
  onOpen: (kind: "show" | "movie", tmdbId: number) => void;
}) {
  const library = useLibraryIndex();

  // Anything already watched is dropped from recommendations: re-suggesting
  // something you finished is the one case where library state should remove
  // a result rather than annotate it. (discoverByMood already excludes these;
  // this also covers the movie you marked watched since the search ran.)
  const recommendations = results.mood.filter((m) => !library.get(`${m.kind}:${m.tmdbId}`)?.watched);
  const fromLibrary = recommendations.filter((m) => m.inLibrary);
  const fromCatalog = recommendations.filter((m) => !m.inLibrary);

  const searching = results.moodAttempted && recommendations.length === 0 && !results.moodMessage;
  const nothing = results.titles.length === 0 && recommendations.length === 0;

  // A query can be routed to the recommender AND be an exact title — any
  // title of four or more words trips the word-count fallback in
  // looksDescriptive ("Margo's Got Money Troubles"). When the text names a
  // real title outright, that title is the answer, so titles lead regardless.
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const exactTitleMatch = results.titles.some((t) => normalise(t.name) === normalise(results.query));

  const titlesBlock = results.titles.length > 0 && (
    <>
      <h3 className="section-title">{results.moodAttempted ? "Titles matching that text" : "Titles"}</h3>
      <Grid
        items={results.titles}
        badge={false}
        onOpen={onOpen}
      />
    </>
  );

  if (!results.moodAttempted || exactTitleMatch) {
    return (
      <>
        {titlesBlock}
        {exactTitleMatch && recommendations.length > 0 && (
          <>
            <h3 className="section-title">You might also like</h3>
            <Grid items={recommendations} badge={false} onOpen={onOpen} />
          </>
        )}
        {nothing && (
          <EmptyState
            icon={SearchIcon}
            title="No results"
            body={`Nothing on TMDB matched "${results.query}". Try describing what you're in the mood for instead — "something scary", "slow burn mystery", "feel good movies".`}
          />
        )}
      </>
    );
  }

  return (
    <>
      {fromLibrary.length > 0 && (
        <>
          <h3 className="section-title">
            From your library
            <span className="section-count">{fromLibrary.length}</span>
          </h3>
          <p className="discover-subhead">Unwatched titles you already have that fit</p>
          <Grid items={fromLibrary} badge onOpen={onOpen} />
        </>
      )}

      {fromCatalog.length > 0 && (
        <>
          <h3 className="section-title">
            {fromLibrary.length > 0 ? "More to add" : "Recommended for you"}
            <span className="section-count">{fromCatalog.length}</span>
          </h3>
          {fromLibrary.length > 0 && (
            <p className="discover-subhead">Not in your library yet — open one to add it</p>
          )}
          <Grid items={fromCatalog} badge={false} onOpen={onOpen} />
        </>
      )}

      {searching && (
        <>
          <h3 className="section-title">Finding matches</h3>
          <ShowGridSkeleton count={6} />
        </>
      )}

      {results.moodMessage && recommendations.length === 0 && (
        <EmptyState icon={SearchIcon} title="No matches for that" body={results.moodMessage} />
      )}

      {titlesBlock}
    </>
  );
}
