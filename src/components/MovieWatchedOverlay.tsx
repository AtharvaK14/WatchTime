import { movieMarkFor, type MovieWatchedPhase } from "../lib/movieWatched";

/**
 * The acknowledgement a movie card shows once a change to its viewings has
 * landed, over the poster:
 *
 *   watched    translucent green veil, the tick in the middle - or the
 *              viewing count, for a movie now watched more than once
 *   decrement  "-1" on a dark veil: one viewing removed, the movie still
 *              watched; the card's own indicator then shows the new count
 *   unwatched  translucent red veil and a red X: back to unwatched (the movie
 *              stays in the library)
 *
 * The same mark as an Up Next episode card's (.wn-watched-mark: the white fill
 * of the tick control, popped into the middle), so a watched movie and a
 * watched episode read as one interaction. No flip: an episode card flips to
 * reveal the next episode, and a movie has nothing behind it to reveal. The
 * veil is lighter than the episode card's, because here it sits on artwork the
 * user should still recognise through it.
 *
 * Rendered only once the write has landed (confirm and exit), never while it
 * is in flight. role="status" so the outcome is announced as well as drawn.
 */
export default function MovieWatchedOverlay({
  phase,
  staying,
  tmdbId,
}: {
  phase: MovieWatchedPhase | undefined;
  /** The card stays in its list, so at "exit" the veil fades instead of the card leaving. */
  staying: boolean | undefined;
  /** Which movie, to read what the acknowledgement says. Without it the plain tick is shown. */
  tmdbId?: number;
}) {
  if (phase !== "confirm" && phase !== "exit") return null;
  const mark = tmdbId === undefined ? undefined : movieMarkFor(tmdbId);
  const kind = mark?.kind ?? "watched";
  let glyph: string;
  let words: string;
  if (mark?.kind === "unwatched") {
    glyph = "✕";
    words = "Marked as not watched";
  } else if (mark?.kind === "decrement") {
    glyph = "−1";
    words = mark.count === 1 ? "Viewing removed. Watched once" : `Viewing removed. Watched ${mark.count} times`;
  } else {
    const count = mark?.count ?? 1;
    // The same "N×" as the poster's own indicator (WatchMark).
    glyph = count >= 2 ? `${count > 99 ? "99+" : count}×` : "✓";
    words = count >= 2 ? `Marked as watched. Watched ${count} times` : "Marked as watched";
  }
  const wide = glyph.length > 2;
  // A span, not a div: on Discover and For You the card is a <button>, which
  // may only contain phrasing content. The CSS makes it a flex box either way.
  return (
    <span
      className={`movie-watched-overlay is-${kind}${phase === "exit" && staying ? " is-fading" : ""}`}
      role="status"
    >
      <span className={`wn-watched-mark is-${kind}${wide ? " is-wide" : ""}`} aria-hidden="true">
        {glyph}
      </span>
      <span className="sr-only">{words}</span>
    </span>
  );
}
