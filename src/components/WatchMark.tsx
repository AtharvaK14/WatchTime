/**
 * What a watched indicator shows, wherever one is drawn - an episode's tick in
 * the season list, a movie poster's badge, the episode panel's status button:
 *
 *   unwatched / watched once   the tick (the indicator's colour says which)
 *   watched two or more times  the number of viewings with a "×", in place of
 *                              the tick: "2×", "3×" - the same "×" as the
 *                              season header's "· 3×", so a bare number is
 *                              never left to be read as something else
 *   a viewing just removed     "-1", briefly, before the new count settles
 *
 * One component so the rule cannot differ between surfaces, and so a count
 * never appears as a second badge next to the indicator: it IS the indicator.
 * Decorative to assistive tech; each indicator carries its own aria-label with
 * the count in words.
 */
export default function WatchMark({ count, minus = false }: { count: number; minus?: boolean }) {
  if (minus) {
    return (
      <span className="watch-mark is-minus" aria-hidden="true">
        &minus;1
      </span>
    );
  }
  if (count >= 2) {
    // Past 99 there is no room for the "×" as well; the aria-label still says the exact count.
    return (
      <span className={`watch-mark is-count${count > 9 ? " is-wide" : ""}`} aria-hidden="true">
        {count > 99 ? (
          "99+"
        ) : (
          <>
            {count}
            <span className="watch-mark-x">&times;</span>
          </>
        )}
      </span>
    );
  }
  return (
    <span className="watch-mark" aria-hidden="true">
      &#10003;
    </span>
  );
}
