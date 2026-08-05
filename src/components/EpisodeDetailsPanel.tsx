import { useEffect, useState } from "react";
import type { Episode } from "../db";
import { TMDB_IMAGE_BASE } from "../tmdb";
import { getOmdbEpisodeRating, hasOmdbKey, OMDB_RATE_LIMIT_MESSAGE, type OmdbEpisodeRating } from "../omdb";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { CloseIcon } from "./icons";

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
  onClose,
}: Props) {
  // Same reference-counted lock DetailsPanel uses. This panel is often
  // opened FROM WITHIN an already-open DetailsPanel (both call this hook),
  // the ref-counting in useLockBodyScroll ensures closing this one doesn't
  // prematurely unlock scroll while the parent panel is still open.
  useLockBodyScroll();
  // Stacked on top of DetailsPanel's handler, so Android back closes this
  // episode layer first, then the parent panel on the next press.
  useBackHandler(true, onClose);

  const [rating, setRating] = useState<OmdbEpisodeRating | null | "loading">("loading");
  // Extra watches beyond the first, shown as "+N".
  const rewatches = Math.max(0, watchCount - 1);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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

  const seasonEp = `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;

  return (
    // .is-stacked because this panel is usually opened from INSIDE the show
    // details sheet and is rendered as a sibling of it, within that sheet's
    // backdrop. Without it the sheet's own z-index wins and this panel opens
    // behind the thing that launched it. Harmless when opened standalone from
    // a Watch Next row, where nothing else is competing.
    <div className="modal-backdrop is-stacked" onClick={onClose}>
      <div className="modal episode-detail-modal" onClick={(e) => e.stopPropagation()}>
        <button className="close-x episode-detail-close hit-slop" onClick={onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>

        {/* 1 + 2: landscape thumbnail with the S/E number overlaid bottom-left */}
        <div className="episode-hero">
          {episode.stillPath ? (
            <img src={`${TMDB_IMAGE_BASE}${episode.stillPath}`} alt={episode.name} className="episode-hero-img" />
          ) : (
            <div className="poster-placeholder episode-hero-img" />
          )}
          <span className="episode-hero-badge">{seasonEp}</span>
        </div>

        <div className="episode-detail-body">
          {/* 3: title */}
          <h2 className="episode-detail-title">{episode.name}</h2>

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
    </div>
  );
}
