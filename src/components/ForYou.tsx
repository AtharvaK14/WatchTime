import { useEffect, useRef, useState } from "react";
import { TMDB_IMAGE_BASE, hasApiKey } from "../tmdb";
import { buildForYouSections, type ForYouResult, type SectionItem } from "../lib/recommend/sections";
import type { TasteProfile } from "../lib/recommend/tasteProfile";

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
 * A rail card: poster, then title, and nothing else below it.
 *
 * Everything that used to sit under the title (year/type, season note, an
 * "In your library" badge) moved onto the poster or was dropped. The reason
 * is alignment: those lines sat AFTER a title that wraps to one or two lines
 * depending on its length, so they landed at different heights on every card
 * and the rail read as ragged. Anything that has to line up across cards
 * cannot live below a variable-height element.
 *
 * The title itself now reserves two lines whether it needs them or not, so
 * card heights are identical regardless of title length.
 */
function Poster({ item, onOpen }: { item: SectionItem; onOpen: (item: SectionItem) => void }) {
  // note is only ever set by the library-derived sections, where every item
  // is by definition already owned, so an "in library" marker there would be
  // on every single card and therefore tell the user nothing.
  const showOwnedMarker = item.inLibrary && !item.note;
  return (
    <button className="rail-card" onClick={() => onOpen(item)} title={item.name}>
      <span className="rail-poster-wrap">
        {item.posterPath ? (
          <img src={`${TMDB_IMAGE_BASE}${item.posterPath}`} alt="" className="rail-poster" loading="lazy" />
        ) : (
          <span className="poster-placeholder rail-poster" />
        )}
        {item.note && <span className="rail-pill">{item.note}</span>}
        {showOwnedMarker && <span className="rail-owned" aria-hidden="true" />}
      </span>
      <span className="rail-name">{item.name}</span>
      {/* The visual markers above are decorative; the same facts go to
          assistive tech as text, since a coloured dot conveys nothing. */}
      <span className="sr-only">
        {item.kind === "show" ? "TV series" : "Film"}
        {item.year ? `, ${item.year}` : ""}
        {item.note ? `, ${item.note}` : ""}
        {item.inLibrary ? ", in your library" : ""}
      </span>
    </button>
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
  if (loading) return <p className="muted small">Working out what you might like...</p>;
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
        <section key={section.id} className="rail-section">
          <div className="rail-head">
            <h4>{section.title}</h4>
            {section.subtitle && <span className="muted small">{section.subtitle}</span>}
          </div>
          <div className="rail">
            {section.items.map((item) => (
              <Poster key={`${item.kind}:${item.tmdbId}`} item={item} onOpen={(i) => onOpen(i.kind, i.tmdbId)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
