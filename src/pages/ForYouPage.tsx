import { useState } from "react";
import { hasApiKey } from "../tmdb";
import ForYou from "../components/ForYou";
import DetailsPanel from "../components/DetailsPanel";
import UniversalSearch, { type SearchResults } from "../components/UniversalSearch";
import SearchResultsGrid from "../components/SearchResultsGrid";

/**
 * For You: search, recommendations, discovery.
 *
 * Search lives here rather than on Home. On Home it could only ever filter
 * titles the user already owned, so it behaved like a library filter wearing
 * a search box — typing the name of anything new returned nothing at all.
 * Moving it here puts it next to the recommendations, which is where "find me
 * something" actually belongs, and leaves Home to do one job: tracking what
 * you are already watching.
 *
 * While a search is active the recommendation rails are replaced rather than
 * pushed down the page. Leaving them below a result set makes the page read
 * as two competing answers to the same question.
 */
export default function ForYouPage() {
  const [openDetails, setOpenDetails] = useState<{ kind: "show" | "movie"; tmdbId: number } | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);

  return (
    <div className="panel">
      {!hasApiKey() && (
        <p className="status-error">Add your TMDB API key on the Settings page to search or see recommendations.</p>
      )}

      {hasApiKey() && (
        <UniversalSearch
          onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })}
          onResults={setResults}
          onClear={() => setResults(null)}
        />
      )}

      {results ? (
        <SearchResultsGrid results={results} onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })} />
      ) : (
        // The page heading lives inside <ForYou> alongside the "Why these?"
        // toggle, so the toggle stays co-located with the state it controls.
        <ForYou onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })} />
      )}

      {openDetails && (
        <DetailsPanel kind={openDetails.kind} tmdbId={openDetails.tmdbId} onClose={() => setOpenDetails(null)} />
      )}
    </div>
  );
}
