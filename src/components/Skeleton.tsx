/**
 * Loading placeholders: grey shapes with a slow shimmer, standing in for the
 * real cards while the library or TMDB answers.
 *
 * Each one reuses the real card's frame class (.show-card, .watch-next-row,
 * .card-rail, .show-grid), so the placeholder has exactly the size and spacing
 * of what replaces it and nothing jumps when the content arrives. They are
 * hidden from assistive tech; the container says "Loading" once instead.
 * The shimmer stops under reduced motion (index.css).
 */

function PosterCardSkeleton() {
  return (
    <div className="show-card skeleton-card" aria-hidden="true">
      <span className="skeleton skeleton-poster" />
      <span className="skeleton-caption">
        <span className="skeleton skeleton-line" style={{ width: "80%" }} />
        <span className="skeleton skeleton-line is-small" style={{ width: "45%" }} />
      </span>
    </div>
  );
}

/** A poster grid (Shows, Movies, Home's Movies to Watch). */
export function PosterGridSkeleton({ count = 9 }: { count?: number }) {
  return (
    <div className="show-grid" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <PosterCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** One sideways rail of posters (Discover, For You). */
export function PosterRailSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="card-rail skeleton-rail" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <PosterCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Home's Up Next cards. */
export function UpNextSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="watch-next-list" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="watch-next-row skeleton-card" aria-hidden="true">
          <span className="skeleton skeleton-wn-poster" />
          <span className="skeleton-wn-body">
            <span className="skeleton skeleton-line is-title" style={{ width: "55%" }} />
            <span className="skeleton skeleton-line" style={{ width: "75%" }} />
            <span className="skeleton skeleton-line is-small" style={{ width: "35%" }} />
          </span>
          <span className="skeleton skeleton-tick" />
        </div>
      ))}
    </div>
  );
}

/** The details page body while TMDB answers: title, subtitle, chips, synopsis. */
export function DetailsSkeleton() {
  return (
    <div className="details-skeleton" role="status" aria-label="Loading">
      <span className="skeleton skeleton-line is-heading" style={{ width: "70%" }} />
      <span className="skeleton skeleton-line" style={{ width: "45%" }} />
      <span className="skeleton-chip-row" aria-hidden="true">
        <span className="skeleton skeleton-chip" />
        <span className="skeleton skeleton-chip" />
        <span className="skeleton skeleton-chip" />
      </span>
      <span className="skeleton skeleton-line" style={{ width: "100%" }} />
      <span className="skeleton skeleton-line" style={{ width: "96%" }} />
      <span className="skeleton skeleton-line" style={{ width: "60%" }} />
    </div>
  );
}
