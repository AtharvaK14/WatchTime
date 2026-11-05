import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { toDurationParts } from "../lib/stats";

/**
 * The headline statistics at the top of the Shows and Movies tabs: two tiles,
 * each a value over its label, that open the detailed statistics dialog.
 *
 * Every tile is exactly two lines - the value on one, the label on the other -
 * whatever the screen width or the phone's text size. In order of preference:
 *
 *  1. Width goes where the text is. The columns are sized by their content
 *     (index.css, .stats-grid): equal halves when both fit, otherwise the
 *     tile with the longer value ("2mo 19d 15h") takes what it needs and the
 *     other ("864") the rest.
 *  2. Narrow phones get tighter tile padding (index.css).
 *  3. Only if the values still cannot fit side by side - a narrow phone with a
 *     large system text size, or a long TV time like "18mo 29d 23h" - are the
 *     values scaled down, all by the same factor so they stay one size, and
 *     only as far as needed. Measured, not guessed from breakpoints: Android
 *     scales text by the user's font size, which no CSS width can predict.
 */

/** TV time / movie time as months, days and hours, units in the quieter style. */
export function DurationValue({ minutes }: { minutes: number }) {
  const d = toDurationParts(minutes);
  return (
    <>
      {d.months}
      <span className="stat-unit">mo</span> {d.days}
      <span className="stat-unit">d</span> {d.hours}
      <span className="stat-unit">h</span>
    </>
  );
}

export interface StatTile {
  label: string;
  value: ReactNode;
}

/** Smallest the values may be scaled to. */
const MIN_FIT = 0.6;
/** Smallest the labels may be scaled to, once the values are at MIN_FIT. */
const MIN_LABEL_FIT = 0.8;

function textWidth(el: Element | null, range: Range): number {
  if (!el) return 0;
  range.selectNodeContents(el);
  return range.getBoundingClientRect().width;
}

/** The largest scale in [min, 1] at which `fits` holds, or null if not even `min` does. */
function largestFit(min: number, fits: (scale: number) => boolean): number | null {
  if (fits(1)) return 1;
  if (!fits(min)) return null;
  let lo = min;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 100) / 100;
}

function setScale(grid: HTMLElement, name: string, scale: number): void {
  if (scale === 1) grid.style.removeProperty(name);
  else grid.style.setProperty(name, String(scale));
}

/**
 * Sets the grid's scales so every tile's value and label fit on their own
 * lines side by side:
 *
 *   --stat-fit        the values, down to MIN_FIT
 *   --stat-label-fit  then the labels, down to MIN_LABEL_FIT
 *   data-cramped      and past both, the tiles take equal halves and a label
 *                     that still does not fit ends in "..." rather than
 *                     pushing the page sideways (a very narrow phone at the
 *                     largest system text size)
 */
function fitStatValues(grid: HTMLElement): void {
  const tiles = Array.from(grid.children).filter((el) => el.classList.contains("stat-card"));
  if (tiles.length === 0) return;
  const current = Number.parseFloat(grid.style.getPropertyValue("--stat-fit")) || 1;
  const currentLabel = Number.parseFloat(grid.style.getPropertyValue("--stat-label-fit")) || 1;
  const gridStyle = getComputedStyle(grid);
  const gap = Number.parseFloat(gridStyle.columnGap) || 0;
  const available =
    grid.clientWidth - (Number.parseFloat(gridStyle.paddingLeft) || 0) - (Number.parseFloat(gridStyle.paddingRight) || 0);
  if (available <= 0) return;

  const range = document.createRange();
  const parts = tiles.map((tile) => {
    const s = getComputedStyle(tile);
    const chrome =
      Number.parseFloat(s.paddingLeft) +
      Number.parseFloat(s.paddingRight) +
      Number.parseFloat(s.borderLeftWidth) +
      Number.parseFloat(s.borderRightWidth);
    return {
      // Natural width at scale 1: what is measured now, at the current scale.
      value: textWidth(tile.querySelector(".stat-value"), range) / current,
      label: textWidth(tile.querySelector(".stat-label"), range) / currentLabel,
      chrome,
    };
  });
  range.detach();

  // +1px per tile for sub-pixel rounding, so a fit that is exact on paper
  // does not wrap in practice.
  const need = (valueScale: number, labelScale: number) =>
    parts.reduce((sum, p) => sum + Math.max(p.value * valueScale, p.label * labelScale) + p.chrome + 1, 0) +
    gap * (parts.length - 1);

  let valueScale = largestFit(MIN_FIT, (s) => need(s, 1) <= available);
  let labelScale: number | null = 1;
  if (valueScale === null) {
    valueScale = MIN_FIT;
    labelScale = largestFit(MIN_LABEL_FIT, (s) => need(MIN_FIT, s) <= available);
  }
  const cramped = labelScale === null;
  setScale(grid, "--stat-fit", valueScale);
  setScale(grid, "--stat-label-fit", labelScale ?? MIN_LABEL_FIT);
  // An attribute, not a class: React owns className and would drop it.
  if (cramped) grid.dataset.cramped = "";
  else delete grid.dataset.cramped;
}

export default function StatTiles({
  tiles,
  label,
  onOpen,
}: {
  tiles: StatTile[];
  /** The whole group's accessible name: what the numbers are, and that it opens the details. */
  label: string;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fittedText = useRef<string | null>(null);

  // Refit when a value changes (a movie marked watched adds to its time),
  // before paint, so a value never shows wrapped for a frame. Unchanged text
  // costs nothing: no measuring happens.
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || grid.textContent === fittedText.current) return;
    fittedText.current = grid.textContent;
    fitStatValues(grid);
  });

  // And when the width changes (rotation, window resize, the side rail
  // appearing), or once the display font has loaded and the text has its
  // real width.
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const refit = () => fitStatValues(grid);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(refit) : null;
    observer?.observe(grid);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) refit();
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <div
      ref={ref}
      className="stats-grid is-clickable"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={label}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      {tiles.map((t) => (
        <div key={t.label} className="stat-card">
          <div className="stat-value">{t.value}</div>
          <div className="stat-label">{t.label}</div>
        </div>
      ))}
    </div>
  );
}
