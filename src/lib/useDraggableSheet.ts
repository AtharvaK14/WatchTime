import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

// The sheet's height is capped at this fraction of the viewport (its
// maximum expansion). Bounding the HEIGHT — rather than translating a
// full-height sheet down — keeps the whole sheet on screen when expanded,
// so all of its content stays scrollable. It also leaves part of the
// underlying screen visible, keeps the drag handle reachable, and avoids
// starting a drag-down right under the system notification/quick-settings
// pull zone.
const SHEET_VISIBLE_FRACTION = 0.85;

// How much of the viewport is visible in the COLLAPSED state — the peek you
// get by dragging the sheet down one notch. Judgment call, not a spec.
const COLLAPSED_VISIBLE_FRACTION = 0.55;

// The sheet now opens EXPANDED rather than collapsed. Opening at ~55% put
// the seasons list, ratings and description below the fold on every single
// title, so the first interaction after opening was always a scroll or a
// drag. Opening at 85% shows all of that immediately while still leaving a
// strip of the page behind visible, which is what keeps it reading as a
// sheet over the app rather than a new screen. Collapsed is still there as
// the first drag-down stop.
const OPENS_EXPANDED = true;

// Entrance: the sheet mounts fully off-screen and is released to its resting
// position on the next frame, so the browser has a start value to animate
// FROM. Without the two-frame wait the initial and final transforms land in
// the same style recalculation and no transition runs at all.
const ENTER_TRANSITION =
  "transform 380ms cubic-bezier(0.32, 0.72, 0, 1), opacity 240ms ease-out";

const SNAP_TRANSITION = "transform 320ms cubic-bezier(0.32, 0.72, 0, 1)";
// Must match the transition duration above: after triggering a dismiss we
// wait this long before actually calling onDismiss, so the panel closes
// (and unmounts) only once it has visibly finished sliding away, not
// mid-animation.
const DISMISS_ANIMATION_MS = 320;

// A fast flick snaps to the direction of the flick even if the release
// position is closer to the OTHER snap point, matching native bottom-sheet
// feel (e.g. iOS). Units: px per ms. Judgment call, not a platform constant.
const VELOCITY_FLICK_THRESHOLD = 0.5;

// Once dragged below the collapsed resting point, further finger movement
// only moves the sheet by this fraction, "rubber band" resistance so
// pulling past collapsed reads as deliberate, not an accidental free-fall
// toward closing. Judgment call, not a platform constant.
const DISMISS_DRAG_RESISTANCE = 0.55;

// How far past collapsed (in already-damped px, i.e. what's actually on
// screen, not raw finger travel) a slow release needs to be before it's
// treated as "let go to close" rather than "spring back to collapsed".
// Judgment call, not a spec.
const DISMISS_DISTANCE_PX = 70;

interface DragState {
  startClientY: number;
  startTranslateY: number;
  lastClientY: number;
  lastTimestamp: number;
  velocity: number; // px/ms, positive = moving down
}

export interface DraggableSheetHandle {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  isDragging: boolean;
  sheetStyle: CSSProperties;
  handleProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  };
}

const collapsedFor = (height: number) => Math.max(0, height - window.innerHeight * COLLAPSED_VISIBLE_FRACTION);

/**
 * Drives a bottom-sheet-style panel with two snap points (collapsed and
 * expanded) plus drag-to-dismiss. The sheet is bottom-anchored with a fixed
 * height (SHEET_VISIBLE_FRACTION of the viewport, set via sheetStyle.height):
 * expanded is translateY(0) — fully on screen, all content scrollable —
 * and collapsed translates it partway down to a peek. Dragging down past
 * the collapsed resting point, or a fast downward flick once already at or
 * below it, closes the panel by calling `onDismiss` after the slide-away
 * animation finishes.
 *
 * Deliberately gated on "already at or below collapsed": a fast downward
 * flick starting from the fully-expanded position collapses rather than
 * closes, you have to actually reach the resting point first before
 * letting go dismisses it. Otherwise one enthusiastic flick from expanded
 * could close the whole panel when the person only meant to collapse it.
 *
 * Uses Pointer Events (not separate touch/mouse handlers) so the same code
 * path handles mouse, touch, and pen. The consumer spreads `handleProps`
 * onto a dedicated drag-handle element only, not the whole panel, so
 * normal scrolling/clicking elsewhere in the panel is unaffected.
 */
export function useDraggableSheet(onDismiss: () => void): DraggableSheetHandle {
  const [expanded, setExpanded] = useState(OPENS_EXPANDED);
  const [sheetHeight, setSheetHeight] = useState(() => window.innerHeight * SHEET_VISIBLE_FRACTION);
  const [collapsedOffset, setCollapsedOffset] = useState(() => collapsedFor(window.innerHeight * SHEET_VISIBLE_FRACTION));
  // Fully off-screen = translated down by the sheet's own height, so its top
  // edge lands at the bottom of the viewport.
  const [dismissOffset, setDismissOffset] = useState(() => window.innerHeight * SHEET_VISIBLE_FRACTION);
  const [liveTranslateY, setLiveTranslateY] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // True only for the first two frames after mount, while the sheet is parked
  // off-screen waiting to be released into its slide-up.
  const [entering, setEntering] = useState(true);
  const dragState = useRef<DragState | null>(null);
  const dismissTimeoutRef = useRef<number | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    function computeOffsets() {
      const height = window.innerHeight * SHEET_VISIBLE_FRACTION;
      setSheetHeight(height);
      setCollapsedOffset(collapsedFor(height));
      setDismissOffset(height);
    }
    computeOffsets();
    window.addEventListener("resize", computeOffsets);
    return () => window.removeEventListener("resize", computeOffsets);
  }, []);

  // Release the entrance on the second animation frame. One frame is not
  // reliably enough: React can commit the initial style and the follow-up in
  // the same paint, in which case there is no start value to animate from and
  // the sheet simply appears. Two frames guarantees the off-screen transform
  // has been rendered before the resting value replaces it.
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntering(false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current !== null) window.clearTimeout(dismissTimeoutRef.current);
    };
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const startTranslateY = expanded ? 0 : collapsedOffset;
      dragState.current = {
        startClientY: e.clientY,
        startTranslateY,
        lastClientY: e.clientY,
        lastTimestamp: e.timeStamp,
        velocity: 0,
      };
      setIsDragging(true);
      setLiveTranslateY(startTranslateY);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [expanded, collapsedOffset]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragState.current;
      if (!drag) return;
      e.preventDefault();
      const deltaY = e.clientY - drag.startClientY;
      const raw = drag.startTranslateY + deltaY;

      let next: number;
      if (raw <= collapsedOffset) {
        next = Math.max(0, raw); // normal expand<->collapse range, 1:1
      } else {
        // Past the resting point: damped, see DISMISS_DRAG_RESISTANCE.
        const overshoot = raw - collapsedOffset;
        next = collapsedOffset + Math.min(overshoot * DISMISS_DRAG_RESISTANCE, dismissOffset - collapsedOffset);
      }

      const dt = e.timeStamp - drag.lastTimestamp;
      if (dt > 0) {
        drag.velocity = (e.clientY - drag.lastClientY) / dt;
      }
      drag.lastClientY = e.clientY;
      drag.lastTimestamp = e.timeStamp;
      setLiveTranslateY(next);
    },
    [collapsedOffset, dismissOffset]
  );

  const endDrag = useCallback(() => {
    const drag = dragState.current;
    if (!drag || liveTranslateY === null) {
      dragState.current = null;
      setIsDragging(false);
      return;
    }

    const pastCollapseBy = liveTranslateY - collapsedOffset; // >0 once at/below the resting point
    let outcome: "expand" | "collapse" | "dismiss";

    if (pastCollapseBy > 0) {
      outcome = drag.velocity > VELOCITY_FLICK_THRESHOLD || pastCollapseBy > DISMISS_DISTANCE_PX ? "dismiss" : "collapse";
    } else if (drag.velocity < -VELOCITY_FLICK_THRESHOLD) {
      outcome = "expand";
    } else if (drag.velocity > VELOCITY_FLICK_THRESHOLD) {
      outcome = "collapse";
    } else {
      outcome = liveTranslateY < collapsedOffset / 2 ? "expand" : "collapse";
    }

    dragState.current = null;
    setIsDragging(false);

    if (outcome === "dismiss") {
      setLiveTranslateY(dismissOffset); // let the transition slide it the rest of the way off-screen
      dismissTimeoutRef.current = window.setTimeout(() => onDismissRef.current(), DISMISS_ANIMATION_MS);
    } else {
      setExpanded(outcome === "expand");
      setLiveTranslateY(null); // hand control back to the expanded/collapsed CSS value
    }
  }, [liveTranslateY, collapsedOffset, dismissOffset]);

  const restingTranslateY = liveTranslateY !== null ? liveTranslateY : expanded ? 0 : collapsedOffset;
  // While entering, the sheet is pinned fully off-screen; the moment
  // `entering` flips it animates to its resting position under
  // ENTER_TRANSITION, which is what produces the slide-up.
  const currentTranslateY = entering ? dismissOffset : restingTranslateY;

  return {
    expanded,
    setExpanded,
    isDragging,
    sheetStyle: {
      height: `${sheetHeight}px`,
      transform: `translateY(${currentTranslateY}px)`,
      opacity: entering ? 0 : 1,
      transition: isDragging ? "none" : entering ? "none" : ENTER_TRANSITION,
      // The drag path swaps back to the shorter snap curve once the entrance
      // is over, so dragging stays responsive rather than inheriting the
      // longer, softer entrance timing.
      ...(liveTranslateY !== null && !isDragging ? { transition: SNAP_TRANSITION } : null),
    },
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
