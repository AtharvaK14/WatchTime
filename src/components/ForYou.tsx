import { useEffect, useMemo, useRef, useState } from "react";
import { TMDB_IMAGE_BASE, hasApiKey } from "../tmdb";
import {
  buildForYouSections,
  type ForYouResult,
  type ForYouSection,
  type SectionItem,
} from "../lib/recommend/sections";
import type { TasteProfile } from "../lib/recommend/tasteProfile";
import { useLibraryIds } from "../lib/useLibraryIds";
import { libraryKey, removalClass, useRemovalExit, type RemovalPhase } from "../lib/libraryRemoval";
import { useMovieWatchedPhases, watchedClass } from "../lib/movieWatched";
import { useFlipLayout } from "../lib/useFlipLayout";
import MovieWatchedOverlay from "./MovieWatchedOverlay";
import RatingChip from "./RatingChip";
import { BookmarkIcon } from "./icons";
import { titleQuickActionProps } from "../lib/titleQuickActions";
import { PosterRailSkeleton } from "./Skeleton";

const itemKey = (item: SectionItem) => libraryKey(item.kind, item.tmdbId);

/**
 * The For You page.
 *
 * Structure is a compact insights strip followed by horizontal rails. Rails
 * rather than grids on purpose: a grid of 14 posters per section makes six
 * sections an endless page, while a rail keeps each section one screen-row
 * tall so the whole page is scannable by section heading. That is the
 * difference between "a page about me" and "a wall of posters", and it is
 * what keeps the layout scaling as sections are added.
 */

/**
 * A rail card: the same framed card as Discover and the library grids, with
 * the artwork and its markers on top, then a one-line title and the year.
 *
 * The title is one line with an ellipsis, so the year beneath it lands at the
 * same height on every card and the rail reads flush. The season note and the
 * library bookmark live on the artwork; the rating is top-left, the bookmark
 * top-right.
 */
function Poster({
  item,
  inLibrary,
  removal,
  onOpen,
}: {
  item: SectionItem;
  /** Read live, not from when the page was built: see RailSection. */
  inLibrary: boolean;
  removal?: RemovalPhase;
  onOpen: (item: SectionItem) => void;
}) {
  // note is only ever set by the library-derived sections, where every item
  // is by definition already owned, so an "in library" marker there would be
  // on every single card and therefore tell the user nothing.
  const showOwnedMarker = inLibrary && !item.note;
  // A movie marked watched in the panel this card opened. Recommendations are
  // not a watchlist, so the card stays; it shows the tick on its poster once
  // the panel has closed. Only ever set for movies.
  const watched = useMovieWatchedPhases().get(itemKey(item));
  return (
    <button
      className={`rail-card${removalClass(removal)}${watchedClass(watched, true)}`}
      data-flip-key={itemKey(item)}
      {...titleQuickActionProps({
        kind: item.kind,
        tmdbId: item.tmdbId,
        name: item.name,
        onViewDetails: () => onOpen(item),
      })}
      onClick={() => onOpen(item)}
      title={item.name}
    >
      <span className="rail-poster-wrap">
        {item.posterPath ? (
          <img src={`${TMDB_IMAGE_BASE}${item.posterPath}`} alt="" className="rail-poster" loading="lazy" />
        ) : (
          <span className="poster-placeholder rail-poster" />
        )}
        <RatingChip rating={item.rating} />
        {item.note && <span className="rail-pill">{item.note}</span>}
        {showOwnedMarker && (
          <span className="card-in-library" aria-hidden="true">
            <BookmarkIcon size={13} />
          </span>
        )}
        <MovieWatchedOverlay phase={watched} staying tmdbId={item.tmdbId} />
      </span>
      <span className="rail-name">{item.name}</span>
      {/* Always rendered, a non-breaking space when there is no year, so
          every card in the rail keeps the same height. */}
      <span className="rail-meta" aria-hidden="true">
        {item.year ?? " "}
      </span>
      {/* The visual markers above are decorative; the same facts go to
          assistive tech as text, since a coloured dot conveys nothing. */}
      <span className="sr-only">
        {item.kind === "show" ? "TV series" : "Film"}
        {item.year ? `, ${item.year}` : ""}
        {item.note ? `, ${item.note}` : ""}
        {inLibrary ? ", in your library" : ""}
      </span>
    </button>
  );
}

/**
 * One rail.
 *
 * The page is built once, when it opens, but library membership can change
 * under it: every card opens DetailsPanel, which can add or remove the title.
 * So ownership is read live here rather than taken from the build. Cards in a
 * library-derived section (the ones carrying a note, like "New seasons you've
 * missed") are only there BECAUSE the title is in the library, so a removed
 * one leaves the rail - held until its panel closes, like every other list.
 * A recommendation stays where it is and just loses its owned marker.
 */
function RailSection({
  section,
  library,
  onOpen,
}: {
  section: ForYouSection;
  library: ReturnType<typeof useLibraryIds>;
  onOpen: (item: SectionItem) => void;
}) {
  const owned = (item: SectionItem) =>
    library.ready ? (item.kind === "show" ? library.shows : library.movies).has(item.tmdbId) : item.inLibrary;
  const items = useMemo(
    () =>
      library.ready
        ? section.items.filter(
            (item) => !item.note || (item.kind === "show" ? library.shows : library.movies).has(item.tmdbId)
          )
        : section.items,
    [section.items, library]
  );
  const railRef = useRef<HTMLDivElement>(null);
  const capture = useFlipLayout(railRef);
  const display = useRemovalExit(items, itemKey, capture);
  if (display.length === 0) return null;

  return (
    <section className="rail-section">
      <div className="rail-head">
        <h4>{section.title}</h4>
        {section.subtitle && <span className="muted small">{section.subtitle}</span>}
      </div>
      <div className="rail" ref={railRef}>
        {display.map(({ item, removal }) => (
          <Poster key={itemKey(item)} item={item} inLibrary={owned(item)} removal={removal} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

/**
 * A compact, honest summary of what the app thinks the user likes.
 *
 * Included because a recommendation page that only shows results is
 * unfalsifiable: when a suggestion looks wrong there is no way to tell
 * whether the taste model is wrong or the retrieval was unlucky. Showing the
 * profile makes the system's belief about the user visible and therefore
 * arguable.
 */
function Insights({ profile }: { profile: TasteProfile }) {
  const top = profile.genres.slice(0, 5);
  if (top.length === 0) return null;

  const completion = profile.completionRate === null ? null : Math.round(profile.completionRate * 100);

  return (
    <div className="insights">
      <div className="insights-genres">
        {top.map((g) => (
          <div key={g.genreId} className="insights-genre">
            <div className="insights-genre-head">
              <span>{g.name}</span>
              <span className="muted small">{Math.round(g.share * 100)}%</span>
            </div>
            {/* Width is share relative to the top genre, not absolute share:
                against absolute values every bar looks tiny once a library
                spans a dozen genres, which hides the ranking the bars exist
                to show. */}
            <div className="insights-bar">
              <div className="insights-bar-fill" style={{ width: `${(g.share / top[0].share) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="insights-facts">
        {completion !== null && (
          <span className="muted small">
            You finish <strong>{completion}%</strong> of the series you start
          </span>
        )}
        {profile.averageEpisodeRating !== null && (
          <span className="muted small">
            Average TMDB score of what you watch: <strong>{profile.averageEpisodeRating.toFixed(1)}</strong>
          </span>
        )}
        {profile.episodeRuntime && (
          <span className="muted small">
            You mostly watch <strong>{profile.episodeRuntime.min}-{profile.episodeRuntime.max} min</strong> episodes
          </span>
        )}
        {profile.preferredLanguages.length > 0 && (
          <span className="muted small">
            Mostly <strong>{profile.preferredLanguages.join(", ").toUpperCase()}</strong> titles
          </span>
        )}
        <span className="muted small">
          Based on <strong>{profile.signalCount}</strong> watched titles ({profile.confidence} confidence)
        </span>
      </div>
    </div>
  );
}

export default function ForYou({ onOpen }: { onOpen: (kind: "show" | "movie", tmdbId: number) => void }) {
  const [result, setResult] = useState<ForYouResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showInsights, setShowInsights] = useState(false);
  const library = useLibraryIds();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasApiKey()) {
      setLoading(false);
      return;
    }
    (async () => {
      const built = await buildForYouSections();
      if (!mounted.current) return;
      setResult(built);
      setLoading(false);
    })();
  }, []);

  if (!hasApiKey()) return null;
  if (loading) {
    return (
      <div className="for-you" aria-busy="true">
        <div className="for-you-head">
          <h2>For you</h2>
        </div>
        {[0, 1, 2].map((i) => (
          <section className="rail-section" key={i}>
            <div className="rail-head">
              <span className="skeleton skeleton-line is-title" style={{ width: 160 }} />
            </div>
            <PosterRailSkeleton count={5} />
          </section>
        ))}
      </div>
    );
  }
  if (!result) return null;

  if (result.status === "cold-start") {
    return (
      <div className="for-you">
        <h2>For you</h2>
        <p className="muted">{result.message}</p>
      </div>
    );
  }

  return (
    <div className="for-you">
      <div className="for-you-head">
        <h2>For you</h2>
        <button type="button" className="link-button" onClick={() => setShowInsights((v) => !v)}>
          {showInsights ? "Hide your taste profile" : "Why these?"}
        </button>
      </div>

      {showInsights && <Insights profile={result.profile} />}

      {result.retrievalFailed && <p className="status-error small">{result.message}</p>}

      {result.sections.map((section) => (
        <RailSection
          key={section.id}
          section={section}
          library={library}
          onOpen={(i) => onOpen(i.kind, i.tmdbId)}
        />
      ))}
    </div>
  );
}
