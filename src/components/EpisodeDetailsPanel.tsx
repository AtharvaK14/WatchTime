import { useEffect, useState } from "react";
import type { Episode } from "../db";
import { TMDB_STILL_BASE } from "../tmdb";
import { getOmdbEpisodeRating, hasOmdbKey, OMDB_RATE_LIMIT_MESSAGE, type OmdbEpisodeRating } from "../omdb";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { useAnimatedDismiss } from "../lib/useAnimatedDismiss";
import StreamingCapsules from "./StreamingCapsules";

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
   * Widget overlay only. When supplied, the episode title becomes a control
   * that leaves the overlay and opens THIS EPISODE's own detail panel in the
   * main app — not the show's, which is what the capsule beside it is for.
   *
   * Undefined in the app itself, where this panel IS that destination and
   * there would be nowhere to navigate to.
   */
  onOpenEpisodeInApp?: () => void;
  /**
   * Opens the SERIES detail panel — the show as a whole, which is the one
   * thing the episode title does not go to.
   *
   * Supplied in BOTH contexts, unlike onOpenEpisodeInApp above. The capsule
   * is the show-title element of this design and it navigates somewhere real
   * from either side: out of the overlay and into the app's show panel from
   * the widget, and from this layer to the show's panel inside the app. Only
   * where there is genuinely nowhere to go is it omitted, and then the show
   * name simply is not rendered as a capsule.
   */
  onOpenSeries?: () => void;
  /**
   * Whether this panel should play its own exit after handing off to
   * onOpenSeries.
   *
   * True in the app, where the capsule swaps this layer for the show's panel
   * and leaving it stacked on top would bury what the user just asked for.
   * False (the default) in the widget overlay, where the handoff closes the
   * whole window natively and an exit animation would only delay it.
   */
  dismissOnOpenSeries?: boolean;
  /**
   * The SHOW's TMDB id, which turns on the "Available on" row.
   *
   * An episode is not licensed separately from its series, so the row asks
   * about the show and the episode inherits the answer — the same data the
   * show's own panel displays, normalised the same way, not a second lookup
   * with its own opinion.
   *
   * Supplied at every call site, the widget overlay included: "where can I
   * watch this" is at its most useful in the overlay, which is the surface
   * someone reaches from their home screen when they are about to watch
   * something. The overlay gets the identical component and the identical
   * data — it has no list of its own — and the capsules degrade to plain
   * information there if its host cannot launch apps (see canLaunchStreaming).
   *
   * Optional only because a panel with no show id has nothing to ask about.
   */
  streamingShowId?: number;
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
  onOpenEpisodeInApp,
  onOpenSeries,
  dismissOnOpenSeries = false,
  streamingShowId,
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
  const openEpisodeLabel = `Open ${episode.name} in the app`;
  // "in the app" only when that is what actually happens. From inside the app
  // the capsule opens a panel, and saying otherwise would mislead exactly the
  // users who depend on the label.
  const openSeriesLabel = dismissOnOpenSeries ? `Open ${show.name}` : `Open ${show.name} in the app`;

  function handleOpenSeries() {
    onOpenSeries?.();
    // The destination is already opening; this layer follows it out so the two
    // cross over rather than stacking. See dismissOnOpenSeries in Props.
    if (dismissOnOpenSeries) requestClose();
  }

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

        {/* 1 + 2: landscape thumbnail with two capsules along its bottom edge.

            LEFT is the show, RIGHT is the season/episode, and the split is the
            interaction hierarchy made visible: the show capsule NAVIGATES (to
            the series panel in the app) and carries the "text ›" affordance
            .show-pill uses on Home for exactly that; the S/E capsule is
            INFORMATION and is always a plain span, never a control, in either
            context. The route to this EPISODE in the app is its title below,
            so each control goes to the thing it names. */}
        <div className="episode-hero">
          {episode.stillPath ? (
            <img src={`${TMDB_STILL_BASE}${episode.stillPath}`} alt={episode.name} className="episode-hero-img" />
          ) : (
            <div className="poster-placeholder episode-hero-img" />
          )}
          <div className="episode-hero-capsules">
            {/* The show-title capsule, in both contexts. Where it goes differs
                (out to the app from the overlay, down to the show's panel from
                inside it) but what it means does not, which is the whole point
                of the app and the widget sharing this component rather than
                each drawing an episode card of its own. */}
            {onOpenSeries && (
              <button
                type="button"
                className="episode-hero-badge episode-show-badge episode-open-list"
                onClick={handleOpenSeries}
                aria-label={openSeriesLabel}
              >
                <span className="episode-show-badge-name">{show.name}</span>
                <span aria-hidden="true">&rsaquo;</span>
              </button>
            )}
            <span className="episode-hero-badge episode-number-badge">{seasonEp}</span>
          </div>
        </div>

        <div className="episode-detail-body">
          {/* 3: title. A CONTROL only in the widget overlay, where it is the
              route into the app's own episode page. Inside the app this panel
              IS that page, so the title is plain text: there is nowhere for it
              to go, and a tappable heading that re-opened what is already on
              screen was navigation for its own sake. onOpenEpisodeInApp is
              undefined at every in-app call site, which is what enforces
              that — the app cannot accidentally acquire the behaviour by
              rendering this panel somewhere new. */}
          <h2 className="episode-detail-title">
            {onOpenEpisodeInApp ? (
              <button
                type="button"
                className="episode-open-list episode-title-link"
                onClick={onOpenEpisodeInApp}
                aria-label={openEpisodeLabel}
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

          {/* 7: where to watch it. Below the synopsis and above the actions,
              the same position it takes in the show and movie panels. */}
          {streamingShowId !== undefined && (
            <StreamingCapsules kind="show" tmdbId={streamingShowId} title={show.name} />
          )}

          {/* 8: actions. Separate "Mark watched" toggle and "Watch again",
              the latter shown only once watched. Deliberately plain buttons,
              not a <label>+checkbox (that pattern once caused opening the
              panel to silently toggle watched state).

              ep-action-primary is applied only while UNWATCHED, so the one
              thing the panel most expects you to do is the one filled control
              on screen — clearly an action, and clearly not another of the
              navigation capsules above it. Once watched, marking it back is a
              correction rather than the main path, so it drops to the outlined
              treatment it shares with "Watch Again". */}
          {canToggleWatched && (
            <>
              <div className="episode-actions">
                <button
                  className={`ep-action-btn ${watched ? "" : "ep-action-primary"}`}
                  onClick={onToggleWatched}
                >
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
