import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useBackHandler } from "../lib/backHandler";
import { SearchIcon } from "./icons";

/**
 * The phone's bottom search, shared by Home, Shows, Movies and Discover: a
 * round search button floating above the bottom nav that grows into a field.
 * Each page supplies its own field (children) - live filtering on Shows and
 * Movies, submit-to-search on Home and Discover - and this shell does the
 * rest the same way everywhere:
 *
 *  - "corner": the button sits bottom-right (with an optional filter button
 *    beside it, see `filters`). "home": it sits beside Home's Shows/Movies
 *    switch, which steps aside while the field is open.
 *  - While the keyboard is up the field rides just above it and the nav steps
 *    aside. The keyboard is measured from window.visualViewport: depending on
 *    the device the WebView either shrinks the page above the keyboard (the
 *    dock then simply sits at the new bottom) or lets the keyboard cover it
 *    (the dock is lifted by the covered amount).
 *  - Back (once the keyboard is down) closes it via onCollapse; so does focus
 *    leaving an empty field, when `collapsible`.
 */

/** A drop in visible height this large, while typing, is the keyboard. */
const KEYBOARD_MIN_PX = 120;

export default function SearchDock({
  variant = "corner",
  expanded,
  collapsible,
  onExpand,
  onCollapse,
  label,
  filters,
  children,
}: {
  variant?: "corner" | "home";
  /** The field is showing (controlled by the page: opened, or a search is in force). */
  expanded: boolean;
  /** Nothing would be lost by closing: focus leaving the field closes it. */
  collapsible: boolean;
  onExpand: () => void;
  /** Clear the search and close the field. */
  onCollapse: () => void;
  /** The search button's accessible name, e.g. "Search your shows". */
  label: string;
  /** A round filter button before the search, with a dot while filters are on. */
  filters?: { active: boolean; onOpen: () => void };
  /** The field, shown while expanded. Should contain one text input. */
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [keyboard, setKeyboard] = useState<{ up: boolean; overlap: number }>({ up: false, overlap: 0 });
  const focusOnExpand = useRef(false);

  // Focus the new field in the same tap that opened it, so Android raises
  // the keyboard: a layout effect runs before the tap's task ends.
  useLayoutEffect(() => {
    if (expanded && focusOnExpand.current) {
      focusOnExpand.current = false;
      ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    }
  }, [expanded]);

  useEffect(() => {
    if (!focused) {
      setKeyboard({ up: false, overlap: 0 });
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    // Measured at focus, before the keyboard has risen.
    const baseline = Math.max(vv.height, window.innerHeight);
    let wasUp = false;
    const update = () => {
      const up = baseline - vv.height > KEYBOARD_MIN_PX;
      const overlap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setKeyboard({ up, overlap: up ? overlap : 0 });
      // Back closed the keyboard but left the field focused: let go of the
      // focus too, so the next tap on the field brings the keyboard back.
      if (wasUp && !up && document.activeElement instanceof HTMLElement && ref.current?.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      wasUp = up;
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [focused]);

  useBackHandler(expanded && !keyboard.up, onCollapse);

  const style = keyboard.up ? ({ "--dock-kb": `${keyboard.overlap}px` } as CSSProperties) : undefined;

  return (
    <div
      ref={ref}
      className={`search-dock is-${variant}${expanded ? " is-expanded" : ""}${keyboard.up ? " is-typing" : ""}`}
      style={style}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (ref.current?.contains(e.relatedTarget as Node | null)) return;
        setFocused(false);
        if (collapsible) onCollapse();
      }}
    >
      {filters && (
        <button
          type="button"
          className="search-dock-button"
          onClick={filters.onOpen}
          aria-label={filters.active ? "Filters, some on" : "Filters"}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
            <circle cx="15" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
          </svg>
          {filters.active && <span className="search-dock-dot" aria-hidden="true" />}
        </button>
      )}

      {expanded ? (
        children
      ) : (
        <button
          type="button"
          className="search-dock-button is-search"
          onClick={() => {
            focusOnExpand.current = true;
            onExpand();
          }}
          aria-label={label}
        >
          <SearchIcon size={22} />
        </button>
      )}
    </div>
  );
}

/** The × at the end of a dock field: clears the text, or closes an empty field. Keeps the keyboard up. */
export function SearchDockClear({ hasText, onClear, onClose }: { hasText: boolean; onClear: () => void; onClose: () => void }) {
  return (
    <button
      type="button"
      className="search-dock-clear"
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => (hasText ? onClear() : onClose())}
      aria-label={hasText ? "Clear search" : "Close search"}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}
