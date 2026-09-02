import { useEffect, useState } from "react";
import type { Episode } from "../db";
import { TMDB_STILL_BASE } from "../tmdb";
import { getOmdbEpisodeRating, hasOmdbKey, OMDB_RATE_LIMIT_MESSAGE, type OmdbEpisodeRating } from "../omdb";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { useAnimatedDismiss } from "../lib/useAnimatedDismiss";

/**
 * How long the panel's own exit animation runs. Must match the
 * .episode-detail-modal.is-leaving duration in index.css: the panel unmounts
 * on this timer, so a shorter value here cuts the animation off and a longer
 * one leaves a finished panel sitting on screen.
 */
const EPISODE_PANEL_EXIT_MS = 200;

/**
 * A transition the PARENT is driving, overriding the panel's own.
 *
 * Only the widget overlay uses this, for the mark-watched hand-off: the
 * episode that was just watched leaves with a confirmation ("leave-watched"),
 * and the next one arrives ("enter"). Everywhere else this is undefined and
 * the panel animates itself.
 */
export type EpisodePanelTransition = "enter" | "leave-watched";

interface Props {
  show: { name: string; imdbId?: string | null };
  episode: Episode;
  watched: boolean;
  // Total watch events for this episode (1 = watched once, 2+ = rewatched).
  // Drives the visible rewatch count; 0 when unwatched.
  watchCount: number;
  canToggleWatched?: boolean;
  onToggleWatched: () => void;
  // Rewatch support: records one more watch EVENT for an already-watched
  // episode (watchCount + latest date), never a duplicate row. Optional so
  // preview contexts without library membership simply don't offer it.
  onWatchAgain?: () => void;
  /**
   * Widget overlay only. When supplied, the season/episode capsule and the
   * episode title become controls that leave the overlay and open this show's
   * full episode list in the main app.
   *
   * Undefined in the app itself, where the panel is ALREADY on top of that
   * list and there would be nowhere to navigate to.
   */
  onOpenFullEpisodeList?: () => void;
  /** See EpisodePanelTransition. Undefined = the panel animates itself. */
  transition?: EpisodePanelTransition;
  onClose: () => void;
}

export default function EpisodeDetailsPanel({
  show,
  episode,
  watched,
  watchCount,
  canToggleWatched = true,
  onToggleWatched,
  onWatchAgain,
  onOpenFullEpisodeList,
  transition,
  onClose,
}: Props) {
  // Same reference-counted lock DetailsPanel uses. This panel is often
  // opened FROM WITHIN an already-open DetailsPanel (both call this hook),
  // the ref-counting in useLockBodyScroll ensures closing this one doesn't
  // prematurely unlock scroll while the parent panel is still open.
  useLockBodyScroll();
  // The panel plays a short exit before it actually unmounts, so closing it
  // no longer reads as the card being deleted mid-tap. Every close route
  // below goes through requestClose so they all animate identically.
  const { closing, requestClose } = useAnimatedDismiss(onClose, EPISODE_PANEL_EXIT_MS);
  // Stacked on top of DetailsPanel's handler, so Android back closes this
  // episode layer first, then the parent panel on the next press.
  useBackHandler(true, requestClose);

  const [rating, setRating] = useState<OmdbEpisodeRating | null | "loading">("loading");
  // Extra watches beyond the first, shown as "+N".
  const rewatches = Math.max(0, watchCount - 1);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!hasOmdbKey()) {
        setRating(null);
        return;
      }
      setRating("loading");
      const r = await getOmdbEpisodeRating({ title: show.name, imdbId: show.imdbId }, episode.seasonNumber, episode.episodeNumber);
      if (!cancelled) setRating(r);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [show, episode.seasonNumber, episode.episodeNumber]);

  // "S02 | E01", the same wording as the Watch Next rows and the widget's own
  // list (see episodeLabel() in lib/widget/snapshot.ts), so the capsule the
  // user tapped in the widget reads identically in the panel it opened.
  const seasonEp = `S${String(episode.seasonNumber).padStart(2, "0")} | E${String(episode.episodeNumber).padStart(2, "0")}`;
  const openListLabel = `Open the full episode list for ${show.name}`;

  // An explicit dismissal always wins: whatever the parent is orchestrating,
  // a user who asks to close should see the panel close. Otherwise the
  // parent's transition, and otherwise nothing.
  //
  // "Nothing" is deliberately the resting state only BEFORE any transition has
  // run. Once one has, EpisodePanelApp leaves the class in place rather than
  // clearing it, because clearing it changes the computed animation-name back
  // to the base .modal entrance — which the browser treats as a brand new
  // animation and replays, so the panel would fade in a second time straight
  // after arriving. Verified in the running app, not assumed.
  const animationClass = closing ? "is-leaving" : transition ? `is-${transition}` : "";

  return (
    <div className={`modal-backdrop ${closing ? "is-leaving" : ""}`} onClick={requestClose}>
      <div className={`modal episode-detail-modal ${animationClass}`} onClick={(e) => e.stopPropagation()}>
        <button className="close-x episode-detail-close" onClick={requestClose} aria-label="Close">
          &times;
        </button>

        {/* 1 + 2: landscape thumbnail with the S/E number overlaid bottom-left.
            In the widget overlay the capsule is a control that opens the show's
            full episode list in the app; in the app it is plain text, because
            the panel is already on top of that list. */}
        <div className="episode-hero">
          {episode.stillPath ? (
            <img src={`${TMDB_STILL_BASE}${episode.stillPath}`} alt={episode.name} className="episode-hero-img" />
          ) : (
            <div className="poster-placeholder episode-hero-img" />
          )}
          {onOpenFullEpisodeList ? (
            <button
              type="button"
              className="episode-hero-badge episode-open-list"
              onClick={onOpenFullEpisodeList}
              aria-label={openListLabel}
            >
              {seasonEp}
              {/* Same "text ›" vocabulary .show-pill uses on Home for
                  "this takes you somewhere". */}
              <span aria-hidden="true"> &rsaquo;</span>
            </button>
          ) : (
            <span className="episode-hero-badge">{seasonEp}</span>
          )}
        </div>

        <div className="episode-detail-body">
          {/* 3: title, also a route to the full episode list in the overlay. */}
          <h2 className="episode-detail-title">
            {onOpenFullEpisodeList ? (
              <button
                type="button"
                className="episode-open-list episode-title-link"
                onClick={onOpenFullEpisodeList}
                aria-label={openListLabel}
              >
                {episode.name}
                <span aria-hidden="true"> &rsaquo;</span>
              </button>
            ) : (
              episode.name
            )}
          </h2>

          {/* 4: original air date */}
          <p className="muted small">{episode.airDate || "Air date unknown"}</p>

          {/* 5: rating */}
          <div className="ratings-row">
            <span className="rating-pill">TMDB {episode.tmdbRating.toFixed(1)}</span>
            {rating === "loading" && hasOmdbKey() && <span className="muted small">Loading IMDb rating...</span>}
            {rating && rating !== "loading" && rating.imdbRating && (
              <span className="rating-pill">IMDb {rating.imdbRating}</span>
            )}
            {rating && rating !== "loading" && !rating.imdbRating && (
              <span className="muted small">
                {rating.rateLimited
                  ? OMDB_RATE_LIMIT_MESSAGE
                  : rating.error
                    ? `OMDb: ${rating.error}`
                    : "No IMDb rating found for this episode."}
              </span>
            )}
            {!hasOmdbKey() && <span className="muted small">Add an OMDb key in Settings to see IMDb ratings.</span>}
          </div>

          {/* 6: description / synopsis */}
          <p className="overview">
            {episode.overview || (rating !== "loading" && rating?.plot) || "No summary available."}
          </p>

          {/* 7: actions. Separate "Mark watched" toggle and "Watch again",
              the latter shown only once watched. Deliberately plain buttons,
              not a <label>+checkbox (that pattern once caused opening the
              panel to silently toggle watched state). */}
          {canToggleWatched && (
            <>
              <div className="episode-actions">
                <button className="ep-action-btn" onClick={onToggleWatched}>
                  {watched ? "Mark as Unwatched" : "Mark as Watched"}
                </button>
                {watched && onWatchAgain && (
                  <button className="ep-action-btn" onClick={onWatchAgain}>
                    Watch Again
                    {rewatches > 0 && <span className="rewatch-badge">+{rewatches}</span>}
                  </button>
                )}
              </div>
              {watched && rewatches > 0 && (
                <p className="muted small">Watched {watchCount} times.</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* The "it worked" beat of the widget's mark-watched hand-off. Without it
          the panel just leaves and the user has to infer from the widget behind
          it that anything was recorded.

          A sibling of the card, not a child of it: the card scrolls, and an
          absolutely positioned overlay inside a scroller is anchored to the
          content rather than to what is on screen, so a user who had scrolled
          down to reach the button would never see it. Out here it is also
          unaffected by the card's exit transform, so the tick holds still
          while the card lifts away. role="status" so the confirmation is
          announced rather than only drawn. */}
      {transition === "leave-watched" && (
        <div className="episode-watched-flash" role="status">
          <span className="episode-watched-flash-mark" aria-hidden="true">
            &#10003;
          </span>
          <span className="sr-only">Marked as watched</span>
        </div>
      )}
    </div>
  );
}
