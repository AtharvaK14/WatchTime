import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "./useAnimatedDismiss";

/**
 * Glides a list's children from where they were to where a change puts them,
 * instead of letting them snap. (The FLIP technique: First, Last, Invert,
 * Play.)
 *
 * Opt-in per change rather than always on. The caller calls the returned
 * `capture` immediately before the one state update it wants animated, and
 * only the commit that follows is animated. Everything else a list does —
 * switching tabs, a search filtering it, a sync adding a row — keeps behaving
 * exactly as it did, because an animation on every change is noise rather
 * than information.
 *
 * Children are matched across the change by a `data-flip-key` attribute.
 * Children present on both sides move from their old position to their new
 * one; children that appear or disappear are left to their own entrance and
 * exit. The container's height is animated as well, which is what keeps the
 * content BELOW the list from jumping the moment a row is removed while the
 * rows themselves are still gliding up.
 *
 * Positions are taken relative to the container, so a page that scrolls
 * between the capture and the commit does not register as movement.
 *
 * Children move by transform (via the Web Animations API, so a CSS entrance on
 * the same element is overridden for the duration rather than replaced). The
 * container's height is the one layout property animated, deliberately: it is
 * a single element for under 300ms, and it is the only way the page below can
 * follow the list instead of jumping ahead of it.
 */

/** Same length and curve as the rest of the motion pass in index.css. */
export const FLIP_LAYOUT_MS = 280;
const FLIP_LAYOUT_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * How long a capture waits for its commit. Capture is called immediately
 * before a state update, so in practice the very next commit is the one it
 * describes; this only stops a capture whose update turned out to change
 * nothing from animating some unrelated change later on.
 */
const CAPTURE_TTL_MS = 500;

interface Layout {
  height: number;
  positions: Map<string, { x: number; y: number }>;
}

function measure(container: HTMLElement): Layout {
  const origin = container.getBoundingClientRect();
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of Array.from(container.children)) {
    const key = (child as HTMLElement).dataset.flipKey;
    if (key === undefined) continue;
    const rect = child.getBoundingClientRect();
    positions.set(key, { x: rect.left - origin.left, y: rect.top - origin.top });
  }
  return { height: origin.height, positions };
}

export function useFlipLayout(containerRef: RefObject<HTMLElement | null>): () => void {
  const captured = useRef<(Layout & { at: number }) | null>(null);
  // Glides still in flight, so a second change can take over from wherever
  // the first one had got to instead of starting from a jump.
  const running = useRef(new Map<Element, Animation>());

  const capture = useCallback(() => {
    const container = containerRef.current;
    // Reduced motion means the change simply applies, same as every other
    // animation in the app.
    if (!container || typeof container.animate !== "function" || prefersReducedMotion()) return;
    // Measured with any in-flight glide still applied, which is exactly what
    // the user is looking at. The next glide starts from there.
    captured.current = { ...measure(container), at: performance.now() };
  }, [containerRef]);

  useLayoutEffect(() => {
    const before = captured.current;
    if (!before) return;
    captured.current = null;
    const container = containerRef.current;
    if (!container || performance.now() - before.at > CAPTURE_TTL_MS) return;

    // Stopped before measuring, so what is read below is the new layout itself
    // rather than a frame of an old animation.
    for (const animation of running.current.values()) animation.cancel();
    running.current.clear();

    const track = (element: Element, animation: Animation) => {
      running.current.set(element, animation);
      const release = () => {
        if (running.current.get(element) === animation) running.current.delete(element);
      };
      animation.addEventListener("finish", release);
      animation.addEventListener("cancel", release);
    };

    const after = measure(container);
    const timing = { duration: FLIP_LAYOUT_MS, easing: FLIP_LAYOUT_EASING };

    for (const child of Array.from(container.children)) {
      const key = (child as HTMLElement).dataset.flipKey;
      const from = key === undefined ? undefined : before.positions.get(key);
      const to = key === undefined ? undefined : after.positions.get(key);
      if (!from || !to) continue;
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      track(
        child,
        child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], timing)
      );
    }

    if (Math.abs(before.height - after.height) >= 0.5) {
      track(
        container,
        container.animate([{ height: `${before.height}px` }, { height: `${after.height}px` }], timing)
      );
    }
  });

  return capture;
}
