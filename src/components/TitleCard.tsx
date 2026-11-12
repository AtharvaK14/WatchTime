import { TMDB_IMAGE_BASE } from "../tmdb";
import PosterCaption from "./PosterCaption";
import RatingChip from "./RatingChip";
import { BookmarkIcon } from "./icons";
import { libraryKey, removalClass, useLibraryRemovals } from "../lib/libraryRemoval";
import { useMovieWatchedPhases, watchedClass } from "../lib/movieWatched";
import MovieWatchedOverlay from "./MovieWatchedOverlay";
import { titleQuickActionProps } from "../lib/titleQuickActions";

/**
 * "Already in your library", shown directly on the artwork so the user no
 * longer has to open a title to find out.
 *
 * A BOOKMARK, not a tick. The first version of this was a tick in a filled
 * accent circle, which was a mistake: a tick on a poster already means WATCHED
 * in this app (.watched-badge on the Movies grid, .watch-toggle on an episode
 * row), so the same mark was carrying two unrelated facts and the badge read
 * as "you have seen this". A bookmark says saved-not-consumed and cannot be
 * confused with either the watched state or the Mark as Watched control.
 *
 * A mark rather than a worded pill because at three cards per row on a phone
 * an "IN LIBRARY" label either covers the poster or is too small to read; the
 * word still reaches screen readers from the .sr-only text each caller
 * renders. White, not the accent: red is the brand and "New", never "yours".
 * Top-RIGHT: these cards carry no watched control, and the top-left is the
 * rating's.
 */
function InLibraryBadge() {
  return (
    <span className="card-in-library" aria-hidden="true">
      <BookmarkIcon size={13} />
    </span>
  );
}

/**
 * One card for a TMDB title: every Discover list (the rails and both kinds of
 * search result) and a cast member's page render through this, so they
 * cannot drift apart.
 *
 * The same framed card the Shows and Movies grids use (artwork with the
 * rating on it, PosterCaption's title and year below), plus what only
 * Discover needs: the library bookmark, and "Series" or "Film" in the caption
 * wherever a list mixes the two. No watched control: marking something
 * watched happens in the details panel the card opens.
 */
export default function TitleCard({
  kind,
  tmdbId,
  name,
  year,
  posterPath,
  rating,
  kindTag,
  inLibrary,
  onOpen,
}: {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
  year: number | null;
  posterPath: string | null;
  /** TMDB vote_average, as the search or list result carried it. */
  rating?: number | null;
  /** "Series" or "Film", only where the list's heading does not already say which. */
  kindTag?: "Series" | "Film";
  inLibrary: boolean;
  onOpen: () => void;
}) {
  // These grids are TMDB's, not the library's, so a removed title's card
  // stays where it is: only the bookmark goes. The highlight is what says
  // which card that happened to once the panel has closed. Only the highlight
  // phase applies here - "held" and "exit" are for cards leaving a library list.
  const removal = useLibraryRemovals().get(libraryKey(kind, tmdbId));
  // Same reasoning for a movie marked watched in that panel: the card stays,
  // and shows the watched tick once the panel has closed, so the user can see
  // which card it happened to. Only ever set for movies.
  const watched = useMovieWatchedPhases().get(libraryKey(kind, tmdbId));
  return (
    <button
      className={`show-card${removal === "highlight" ? removalClass(removal) : ""}${watchedClass(watched, true)}`}
      {...titleQuickActionProps({ kind, tmdbId, name, onViewDetails: onOpen })}
      onClick={onOpen}
    >
      <span className="card-art">
        {posterPath ? (
          <img src={`${TMDB_IMAGE_BASE}${posterPath}`} alt={name} />
        ) : (
          <span className="poster-placeholder" />
        )}
        <RatingChip rating={rating} />
        {inLibrary && <InLibraryBadge />}
        <MovieWatchedOverlay phase={watched} staying tmdbId={tmdbId} />
      </span>
      <PosterCaption title={name} year={year} kindLabel={kindTag} />
      {inLibrary && <span className="sr-only">In your library</span>}
    </button>
  );
}
