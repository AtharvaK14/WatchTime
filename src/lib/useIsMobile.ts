import { useEffect, useState } from "react";

// Same breakpoint as the bottom-nav switch in index.css. Kept identical on
// purpose, a screen that gets the mobile bottom-tab-bar should also get the
// mobile drag-sheet details panel, not a mismatched combination of the two.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 640px)";

/**
 * Reactive, not a one-time check: uses matchMedia's change event so it
 * updates live if the window is resized or, more relevantly while
 * developing, if you toggle device emulation in devtools without a full
 * page reload.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT_QUERY);
}

// Which layout the details panel should use.
//
// Deliberately NOT the 640px mobile breakpoint. That breakpoint answers "is
// this a phone-sized screen", which is the right question for the tab bar and
// the filter sheet, but the wrong one for this panel: at 875x1400 — a phone
// mockup, a tablet held upright, a half-width browser window — the 640px rule
// fell through to the centred desktop dialog, which floats with a large gap
// above and below and reads as broken when everything around it is behaving
// like a mobile app.
//
// The real question is whether the viewport is TALL, because that is what
// makes a bottom sheet the right shape: it rises from the edge nearest the
// thumb and leaves the context above visible. So portrait gets the sheet at
// any width, and landscape only gets it when genuinely narrow. A wide
// landscape window still gets the centred dialog, where a full-width sheet
// would be absurd.
const BOTTOM_SHEET_QUERY = "(max-width: 640px), (orientation: portrait)";

export function usePrefersBottomSheet(): boolean {
  return useMediaQuery(BOTTOM_SHEET_QUERY);
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    // Re-read on subscribe: the query can have changed between the initial
    // useState and this effect running.
    setMatches(mq.matches);
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [query]);

  return matches;
}