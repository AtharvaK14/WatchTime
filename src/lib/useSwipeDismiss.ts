import { useEffect, type RefObject } from "react";
import { prefersReducedMotion } from "./useAnimatedDismiss";

/**
 * Swipe down to close a full-screen page, the way a phone's own pages close.
 *
 * Only a drag that starts with the page scrolled to the very top and moves
 * mostly downward is taken over; anything else (scrolling the page, swiping a
 * horizontal rail, dragging up) is left to the browser untouched. While
 * dragging, the page follows the finger. Letting go past DISMISS_DISTANCE, or
 * with a quick flick, closes it; otherwise it springs back.
 *
 * The close itself is the page's normal exit (requestClose and its leaving
 * class). The exit keyframes start from var(--drag-y), which is set here to
 * where the finger left the page, so the page carries on from that point
 * instead of jumping back to the top before sliding away.
 */

const DISMISS_DISTANCE = 120;
const FLICK_VELOCITY = 0.6; // px per ms
/** Movement before deciding whether the gesture is ours. */
const LOCK_SLOP = 8;
const SPRING_BACK_MS = 220;

export function useSwipeDismiss(
  pageRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDismiss: () => void
): void {
  useEffect(() => {
    const page = pageRef.current;
    if (!enabled || !page) return;

    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let state: "idle" | "pending" | "dragging" | "ignored" = "idle";
    let springTimer: number | null = null;

    const setOffset = (y: number) => {
      page.style.transform = y > 0 ? `translateY(${y}px)` : "";
      page.style.setProperty("--drag-y", `${y}px`);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        state = "ignored";
        return;
      }
      const scroller = scrollRef.current;
      // Mid-scroll, a downward drag scrolls back up; it is not a close.
      if (scroller && scroller.scrollTop > 0) {
        state = "ignored";
        return;
      }
      const t = e.touches[0];
      startX = t.clientX;
      startY = lastY = t.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      state = "pending";
    };

    const onMove = (e: TouchEvent) => {
      if (state === "idle" || state === "ignored") return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (state === "pending") {
        if (Math.abs(dx) < LOCK_SLOP && Math.abs(dy) < LOCK_SLOP) return;
        // Sideways (a rail) or upward (scrolling): not ours.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          state = "ignored";
          return;
        }
        state = "dragging";
        if (springTimer !== null) window.clearTimeout(springTimer);
        page.style.transition = "none";
      }

      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - lastT);
      velocity = (t.clientY - lastY) / dt;
      lastY = t.clientY;
      lastT = e.timeStamp;
      setOffset(Math.max(0, dy));
    };

    // A cancelled touch (the system took the gesture over) never closes.
    const finish = (commit: boolean) => {
      if (state !== "dragging") {
        state = "idle";
        return;
      }
      state = "idle";
      const dy = Math.max(0, lastY - startY);
      if (commit && (dy > DISMISS_DISTANCE || (dy > 24 && velocity > FLICK_VELOCITY))) {
        // Hand over to the exit animation, which starts from --drag-y.
        page.style.transition = "";
        onDismiss();
        return;
      }
      page.style.transition = prefersReducedMotion()
        ? "none"
        : `transform ${SPRING_BACK_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`;
      setOffset(0);
      springTimer = window.setTimeout(() => {
        page.style.transition = "";
        springTimer = null;
      }, SPRING_BACK_MS);
    };

    page.addEventListener("touchstart", onStart, { passive: true });
    page.addEventListener("touchmove", onMove, { passive: false });
    const onEnd = () => finish(true);
    const onCancel = () => finish(false);
    page.addEventListener("touchend", onEnd);
    page.addEventListener("touchcancel", onCancel);
    return () => {
      page.removeEventListener("touchstart", onStart);
      page.removeEventListener("touchmove", onMove);
      page.removeEventListener("touchend", onEnd);
      page.removeEventListener("touchcancel", onCancel);
      if (springTimer !== null) window.clearTimeout(springTimer);
    };
  }, [pageRef, scrollRef, enabled, onDismiss]);
}
