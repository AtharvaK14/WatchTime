import type { CSSProperties } from "react";

/**
 * Loading placeholders.
 *
 * Every skeleton here is sized to the real thing it stands in for — a poster
 * keeps the 2:3 aspect ratio, a Continue Watching placeholder keeps the row
 * height. That is the whole point: the layout that appears during the fetch
 * is the layout that stays once the data lands, so nothing jumps underneath
 * a finger that is already reaching for it.
 *
 * The shimmer itself is a transform on a pseudo-element (see .skeleton in
 * index.css) and is switched off entirely under prefers-reduced-motion.
 */

export function SkeletonText({ width = "100%", style }: { width?: string; style?: CSSProperties }) {
  return <div className="skeleton skeleton-text" style={{ width, ...style }} />;
}

/** Placeholder for the poster wall on Shows and Movies. */
export function ShowGridSkeleton({ count = 9 }: { count?: number }) {
  return (
    <div className="show-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton skeleton-poster" />
      ))}
    </div>
  );
}

/** Placeholder for Home's Continue Watching list. */
export function WatchNextSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="watch-next-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row">
          <div className="skeleton skeleton-row-poster" />
          <div className="skeleton-row-body">
            <SkeletonText width="38%" />
            <SkeletonText width="62%" style={{ height: "1em" }} />
            <SkeletonText width="80%" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Placeholder for the horizontal Movies to Watch rail. */
export function MovieRailSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="mtw-rail" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="mtw-card">
          <div className="skeleton skeleton-poster" />
          <SkeletonText width="75%" style={{ marginTop: 10 }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Placeholder for the details sheet / dialog while TMDB is queried. Mirrors
 * the hero-then-body composition so the sheet does not visibly reflow when
 * the response lands.
 */
export function DetailsSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="skeleton details-skeleton-hero" />
      <div className="details-skeleton-body">
        <SkeletonText width="45%" />
        <SkeletonText width="100%" />
        <SkeletonText width="92%" />
        <SkeletonText width="66%" />
      </div>
    </div>
  );
}

/**
 * Screen-reader announcement to pair with any of the above. The visual
 * skeletons are aria-hidden (a grid of empty boxes is noise to a screen
 * reader), so the status has to be stated in text instead.
 */
export function LoadingAnnouncement({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </p>
  );
}
