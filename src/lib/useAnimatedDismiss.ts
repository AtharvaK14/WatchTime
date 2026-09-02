import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Lets an overlay finish an exit animation before it unmounts.
 *
 * Every panel in this app is mounted conditionally (`{open && <Panel/>}`),
 * which makes opening animatable with plain CSS but makes closing impossible:
 * calling onClose removes the element from the tree in the same frame, so
 * there is nothing left to animate. This hook adds the missing half — the
 * caller renders a "leaving" class while `closing` is true, and the real
 * onClose fires once that animation has actually played.
 *
 * Kept as a hook rather than a wrapper component on purpose: the panels have
 * quite different close paths (a backdrop tap, an X, Escape, Android back,
 * a drag-to-dismiss) and all of them just need to call requestClose.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Read at the moment of the interaction rather than subscribed to: this
 * decides how a single dismiss behaves, and the preference changing midway
 * through one is not a case worth re-rendering for.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export interface AnimatedDismiss {
  /** True once the exit has begun. Render the leaving class while it is. */
  closing: boolean;
  /** Starts the exit, then calls onClose when it has finished. Idempotent. */
  requestClose: () => void;
}

export function useAnimatedDismiss(onClose: () => void, durationMs: number): AnimatedDismiss {
  const [closing, setClosing] = useState(false);
  // The latest onClose without re-creating requestClose, so callers can keep
  // passing an inline arrow function.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const requestClose = useCallback(() => {
    if (timer.current !== null) return; // already leaving; a second tap is a no-op
    // The global prefers-reduced-motion block in index.css collapses the CSS
    // duration to ~0, so waiting out the timer here would be a delay with
    // nothing happening in it. Close immediately instead.
    if (prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    timer.current = window.setTimeout(() => onCloseRef.current(), durationMs);
  }, [durationMs]);

  return { closing, requestClose };
}
