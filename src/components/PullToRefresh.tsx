import { useEffect, useRef } from "react";
import { haptic } from "../lib/haptics";
import { prefersReducedMotion } from "../lib/useAnimatedDismiss";

/**
 * Pull down from the top of the page to refresh, phone style.
 *
 * A round indicator drops from under the top edge as the finger pulls (with
 * resistance, so it trails the finger), its arrow turning as it goes. Past
 * the threshold it "catches" (a tick of haptic feedback, the arrow flips) and
 * letting go starts the refresh; it then stays put and spins until the
 * caller says the refresh is over.
 *
 * Only a pull that starts with the page scrolled to the very top, moves
 * mostly downward and does not start inside an open overlay (a details page,
 * a dialog or a sheet) is taken over. Everything else scrolls as normal.
 *
 * The indicator is moved by writing its style directly on each touchmove
 * rather than through React state, so a pull costs no re-renders.
 */

/** Pull distance, after resistance, at which letting go refreshes. */
const THRESHOLD = 72;
/** How far the indicator can travel. */
const MAX_PULL = 110;
/** Where it rests while the refresh runs. */
const REST = 64;
const RESISTANCE = 0.5;
const LOCK_SLOP = 8;
const OVERLAY = ".details-page-root, .modal-backdrop, [role='dialog'], [aria-modal='true']";

export default function PullToRefresh({
  enabled,
  refreshing,
  onRefresh,
}: {
  enabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(refreshing);
  refreshingRef.current = refreshing;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  // Settles the indicator: held open while refreshing, tucked away after.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = prefersReducedMotion() ? "none" : "";
    if (refreshing) {
      el.dataset.state = "refreshing";
      el.style.transform = `translate(-50%, ${REST}px)`;
      el.style.opacity = "1";
    } else {
      el.dataset.state = "idle";
      el.style.transform = "";
      el.style.opacity = "";
    }
  }, [refreshing]);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    let state: "idle" | "pending" | "pulling" | "ignored" = "idle";
    let startX = 0;
    let startY = 0;
    let pull = 0;
    let armed = false;

    const render = () => {
      el.style.transform = `translate(-50%, ${pull}px)`;
      el.style.opacity = String(Math.min(1, pull / (THRESHOLD * 0.6)));
      el.style.setProperty("--ptr-turn", `${Math.min(1, pull / THRESHOLD) * 270}deg`);
    };

    const onStart = (e: TouchEvent) => {
      state = "ignored";
      if (refreshingRef.current || e.touches.length !== 1) return;
      if (window.scrollY > 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(OVERLAY)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      state = "pending";
    };

    const onMove = (e: TouchEvent) => {
      if (state !== "pending" && state !== "pulling") return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (state === "pending") {
        if (Math.abs(dx) < LOCK_SLOP && Math.abs(dy) < LOCK_SLOP) return;
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          state = "ignored";
          return;
        }
        state = "pulling";
        armed = false;
        el.style.transition = "none";
        el.dataset.state = "pulling";
      }
      e.preventDefault();
      pull = Math.min(MAX_PULL, Math.max(0, dy * RESISTANCE));
      const nowArmed = pull >= THRESHOLD;
      if (nowArmed !== armed) {
        armed = nowArmed;
        el.dataset.state = armed ? "armed" : "pulling";
        if (armed) haptic("tick");
      }
      render();
    };

    // A cancelled touch (the system took the gesture over) never refreshes.
    const finish = (commit: boolean) => {
      if (state !== "pulling") {
        state = "idle";
        return;
      }
      state = "idle";
      el.style.transition = prefersReducedMotion() ? "none" : "";
      if (armed && commit) {
        el.dataset.state = "refreshing";
        el.style.transform = `translate(-50%, ${REST}px)`;
        el.style.opacity = "1";
        onRefreshRef.current();
      } else {
        el.dataset.state = "idle";
        el.style.transform = "";
        el.style.opacity = "";
      }
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    const onEnd = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onCancel);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onCancel);
    };
  }, [enabled]);

  return (
    <div
      ref={ref}
      className="ptr"
      data-state="idle"
      role="status"
      aria-live="polite"
      aria-label={refreshing ? "Refreshing episode data" : undefined}
    >
      <svg className="ptr-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <path
          className="ptr-arc"
          d="M20 12a8 8 0 1 1-2.34-5.66"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
        />
        <path className="ptr-head" d="M20 4v4.5h-4.5" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
