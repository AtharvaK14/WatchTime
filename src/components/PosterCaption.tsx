import type { ReactNode } from "react";

/**
 * The text of a poster card: the title on one line, then a quiet metadata line
 * (the year, and "Series" or "Film" where a grid mixes the two), BELOW the
 * artwork inside the card's frame.
 *
 * One component for the Shows, Movies and Discover grids, so they cannot drift
 * apart. It used to sit over the bottom of the artwork behind a dark gradient
 * and, on desktop, only appear on hover; below the artwork it is readable at
 * rest everywhere and covers nothing.
 *
 * The title is always ONE line with an ellipsis (see .card-title), so every
 * card in a row is the same height. The full title is in the details panel the
 * card opens, and still reaches screen readers, since truncation is visual only.
 *
 * `children` renders beneath, for the rare state a grid needs to add (Shows
 * marks a show the user has stopped watching). Nothing that belongs on every
 * card should go there.
 */
export default function PosterCaption({
  title,
  year,
  kindLabel,
  children,
}: {
  title: string;
  /** Omitted when unknown, rather than showing a placeholder. */
  year?: number | null;
  /** "Series" or "Film", only where the grid's heading does not already say which. */
  kindLabel?: string;
  children?: ReactNode;
}) {
  const meta = [year || null, kindLabel || null].filter(Boolean).join(" · ");
  return (
    <div className="show-card-body">
      <p className="show-name card-title">{title}</p>
      {meta ? <p className="card-meta">{meta}</p> : null}
      {children}
    </div>
  );
}
