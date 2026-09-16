import type { ReactNode } from "react";

/**
 * The text on a poster card: release year, then the title directly beneath it,
 * in the card's bottom-left corner over the artwork.
 *
 * One component for the Shows, Movies and Discover grids. Those three had each
 * written this caption by hand and drifted apart — the year after the title in
 * brackets on one, on a line below the title on another, absent on the third —
 * which is exactly what a shared piece cannot do.
 *
 * The title is always ONE line with an ellipsis (see .card-title). A long name
 * wrapping onto three or four lines covered the artwork, and cards whose
 * captions differed in height stopped lining up across the row. The full title
 * is in the details panel the card opens, and still reaches screen readers,
 * since truncation is visual only.
 *
 * `children` renders beneath the title, for the rare state a grid needs to add
 * (Shows marks a show the user has stopped watching). Nothing that belongs on
 * every card should go there.
 */
export default function PosterCaption({
  title,
  year,
  children,
}: {
  title: string;
  /** Omitted when unknown, rather than showing a placeholder. */
  year?: number | null;
  children?: ReactNode;
}) {
  return (
    <div className="show-card-body">
      {year ? <p className="card-meta">{year}</p> : null}
      <p className="show-name card-title">{title}</p>
      {children}
    </div>
  );
}
