import type { MovieWatchedPhase } from "../lib/movieWatched";

/**
 * The acknowledgement a movie card shows once it has been marked watched: a
 * translucent green veil over the poster with a tick in the middle.
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
}: {
  phase: MovieWatchedPhase | undefined;
  /** The card stays in its list, so at "exit" the veil fades instead of the card leaving. */
  staying: boolean | undefined;
}) {
  if (phase !== "confirm" && phase !== "exit") return null;
  // A span, not a div: on Discover and For You the card is a <button>, which
  // may only contain phrasing content. The CSS makes it a flex box either way.
  return (
    <span className={`movie-watched-overlay${phase === "exit" && staying ? " is-fading" : ""}`} role="status">
      <span className="wn-watched-mark" aria-hidden="true">
        &#10003;
      </span>
      <span className="sr-only">Marked as watched</span>
    </span>
  );
}
