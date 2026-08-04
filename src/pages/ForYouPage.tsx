import { useState } from "react";
import { hasApiKey } from "../tmdb";
import ForYou from "../components/ForYou";
import DetailsPanel from "../components/DetailsPanel";

/**
 * For You, promoted out of the Discover tab into its own destination.
 *
 * It was previously a section at the top of Discover, competing for the same
 * screen as search and the trending rails. The two answer different
 * questions, though: Discover is "let me go find something", For You is
 * "show me what's mine". Splitting them means neither has to be scrolled past
 * to reach the other, and it gives the personalised page room to grow
 * sections without pushing search off the screen.
 */
export default function ForYouPage() {
  const [openDetails, setOpenDetails] = useState<{ kind: "show" | "movie"; tmdbId: number } | null>(null);

  return (
    <div className="panel">
      {/* The page heading lives inside <ForYou> alongside the "Why these?"
          toggle, so the toggle stays co-located with the state it controls. */}
      {!hasApiKey() && (
        <p className="status-error">Add your TMDB API key on the Settings page to see recommendations.</p>
      )}

      <ForYou onOpen={(kind, tmdbId) => setOpenDetails({ kind, tmdbId })} />

      {openDetails && (
        <DetailsPanel kind={openDetails.kind} tmdbId={openDetails.tmdbId} onClose={() => setOpenDetails(null)} />
      )}
    </div>
  );
}
