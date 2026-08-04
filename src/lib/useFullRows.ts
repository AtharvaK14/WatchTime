import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Trims a list to a whole number of grid rows.
 *
 * The Discover grids use `repeat(auto-fill, minmax(170px, 1fr))`, so the
 * column count changes with the viewport — 2 or 3 on a phone, anywhere from 3
 * to 7 across desktop widths. A fixed item count therefore tiles cleanly at
 * some widths and leaves a ragged last row at others: ten items in three
 * columns left one lone card with two empty cells beside it, which is the
 * hole that showed up at the bottom of "Trending this week".
 *
 * Rather than guessing a number that divides nicely and hoping, this measures
 * the column count the browser actually resolved and rounds the item count
 * DOWN to a multiple of it. The last row is then always full, at every width,
 * and the grid is never asked to render a partial row.
 *
 * Returns a ref to attach to the grid element, and the number of items to
 * render. Falls back to the full list until the first measurement lands, so
 * the initial paint is never empty.
 */
export function useFullRows(total: number): [(node: HTMLElement | null) => void, number] {
  const [visible, setVisible] = useState(total);
  const cleanupRef = useRef<(() => void) | null>(null);
  const totalRef = useRef(total);
  totalRef.current = total;

  const ref = useCallback((node: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!node) return;

    const measure = () => {
      // grid-template-columns computes to the resolved track list, e.g.
      // "191.33px 191.33px 191.33px", so its length is the column count.
      const cols = getComputedStyle(node)
        .gridTemplateColumns.split(" ")
        .filter(Boolean).length;
      const count = totalRef.current;
      if (!cols || count === 0) return;
      // Never drop below one full row: with more columns than items, showing
      // every item is already a full (if short) row.
      setVisible(cols > count ? count : Math.floor(count / cols) * cols);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    cleanupRef.current = () => observer.disconnect();
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);

  return [ref, visible];
}
