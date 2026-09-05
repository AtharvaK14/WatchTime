import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

// The sheet's height is capped at this fraction of the viewport (its
// maximum expansion). Bounding the HEIGHT — rather than translating a
// full-height sheet down — keeps the whole sheet on screen when expanded,
// so all of its content stays scrollable. It also leaves part of the
// underlying screen visible, keeps the drag handle reachable, and avoids
// starting a drag-down right under the system notification/quick-settings
// pull zone.
const SHEET_VISIBLE_FRACTION = 0.75;

// How much of the viewport is visible in the sheet's default (collapsed,
// not dragged) state. A judgment call, not a spec.
const COLLAPSED_VISIBLE_FRACTION = 0.55;

const SNAP_TRANSITION = "transform 320ms cubic-bezier(0.32, 0.72, 0, 1)";
// Must match the transition duration above: after triggering a dismiss we
// wait this long before actually calling onDismiss, so the panel closes
// (and unmounts) only once it has visibly finished sliding away, not
// mid-animation.
//
// Exported because a sheet can also be dismissed WITHOUT a drag — the close
// button, the backdrop, Escape, Android back — and those paths animate the
// same slide by overriding the transform while reusing this transition, so
// they must wait exactly as long before unmounting.
export const DISMISS_ANIMATION_MS = 320;

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

// How far a finger must travel on the sheet's CONTENT before the gesture is
// classified as a sheet drag or a content scroll. Below this, it is still a
// possible tap and nothing is hijacked — which is what stops a tap on a
// poster or a button from being swallowed as a drag.
const GESTURE_DECISION_PX = 8;

// Movement under this, released quickly, counts as a tap on the grab area
// rather than a drag, and toggles collapsed/expanded.
const TAP_SLOP_PX = 6;
const TAP_MAX_MS = 400;

interface DragState {
  startClientY: number;
  startTranslateY: number;
  lastClientY: number;
  lastTimestamp: number;
  velocity: number; // px/ms, positive = moving down
}

/**
 * A gesture that began on the sheet's scrollable content, before it is known
 * whether it means "move the sheet" or "scroll the content".
 */
interface ContentGesture {
  startClientY: number;
  startTimestamp: number;
  /** Whether the scroller was already at its top when the finger went down. */
  atTop: boolean;
  intent: "undecided" | "sheet" | "scroll";
}

type PointerHandlers = {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
};

export interface DraggableSheetHandle {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  isDragging: boolean;
  sheetStyle: CSSProperties;
  /** For the grab area in the sheet's top bar. Every pointer press there is a drag (or a tap). */
  handleProps: PointerHandlers;
  /**
   * For the scrollable content region. The same gesture has to serve two
   * jobs there, so these handlers decide per gesture whether it moves the
   * sheet or scrolls the content — see the comment on onContentPointerMove.
   */
  contentProps: PointerHandlers;
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
 * path handles mouse, touch, and pen.
 *
 * TWO gesture surfaces, because a bottom sheet whose only draggable part is
 * a 40x4px grabber is a sheet most people never expand:
 *
 *  - handleProps: the grab area in the top bar. Every press is a drag, and a
 *    press that barely moves is a tap that toggles the two snap points.
 *  - contentProps: the scrollable body. The same finger movement has to mean
 *    "scroll the list" in one state and "move the sheet" in another, so the
 *    intent is resolved once per gesture (see onContentPointerMove) and then
 *    held for the rest of it — never re-decided mid-swipe, which is what
 *    makes a sheet feel like it is fighting the finger.
 */
export function useDraggableSheet(onDismiss: () => void): DraggableSheetHandle {
  const [expanded, setExpanded] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(() => window.innerHeight * SHEET_VISIBLE_FRACTION);
  const [collapsedOffset, setCollapsedOffset] = useState(() => collapsedFor(window.innerHeight * SHEET_VISIBLE_FRACTION));
  // Fully off-screen = translated down by the sheet's own height, so its top
  // edge lands at the bottom of the viewport.
  const [dismissOffset, setDismissOffset] = useState(() => window.innerHeight * SHEET_VISIBLE_FRACTION);
  // Mirrored in a ref because endDrag has to read the position the finger
  // actually left the sheet at, and React state is only guaranteed current on
  // the next render. Pointer events usually arrive in separate tasks, so the
  // state is usually fine — but "usually" is not a basis for deciding whether
  // a panel closes. When a move and the release land in one batch (coalesced
  // events, a synchronous dispatch, concurrent rendering deferring the
  // update), the stale read makes endDrag bail out of its snap decision
  // entirely and strand the sheet mid-drag. The ref cannot be stale.
  const [liveTranslateY, setLiveTranslateY] = useState<number | null>(null);
  const liveTranslateRef = useRef<number | null>(null);
  const setLiveTranslate = useCallback((value: number | null) => {
    liveTranslateRef.current = value;
    setLiveTranslateY(value);
  }, []);
  const [isDragging, setIsDragging] = useState(false);
  // The sheet mounts fully off-screen and slides up to its resting point on
  // the very next frame, so opening a panel is the same motion as closing one
  // in reverse. Before this it simply materialised at the collapsed position,
  // which made every panel in the app appear out of nowhere and then animate
  // beautifully only on the way out.
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

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current !== null) window.clearTimeout(dismissTimeoutRef.current);
    };
  }, []);

  // Two frames, not one: the first guarantees the browser has painted the
  // off-screen position, the second changes it. Flipping in the same frame as
  // the mount gives the transition no start value and the sheet just appears.
  //
  // The timeout is a safety net, not a duplicate. requestAnimationFrame does
  // not run at all while a document is hidden, and a WebView can be considered
  // hidden at moments the app does not control. Without the fallback the sheet
  // would then sit off-screen forever — an invisible panel is a far worse
  // failure than an entrance that occasionally skips its animation, so
  // whichever fires first wins.
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntering(false));
    });
    const fallback = window.setTimeout(() => setEntering(false), 100);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(fallback);
    };
  }, []);

  /**
   * Starts moving the sheet with the finger. Shared by both surfaces so the
   * grab area and a swipe on the content produce identical motion — the sheet
   * must not feel different depending on where it was grabbed.
   */
  const beginDrag = useCallback(
    (clientY: number, timeStamp: number) => {
      // Grabbing mid-entrance hands control straight to the finger rather
      // than fighting the slide-up for the rest of its duration.
      setEntering(false);
      const startTranslateY = expanded ? 0 : collapsedOffset;
      dragState.current = {
        startClientY: clientY,
        startTranslateY,
        lastClientY: clientY,
        lastTimestamp: timeStamp,
        velocity: 0,
      };
      setIsDragging(true);
      setLiveTranslate(startTranslateY);
    },
    [expanded, collapsedOffset, setLiveTranslate]
  );

  const applyDrag = useCallback(
    (clientY: number, timeStamp: number) => {
      const drag = dragState.current;
      if (!drag) return;
      const deltaY = clientY - drag.startClientY;
      const raw = drag.startTranslateY + deltaY;

      let next: number;
      if (raw <= collapsedOffset) {
        next = Math.max(0, raw); // normal expand<->collapse range, 1:1
      } else {
        // Past the resting point: damped, see DISMISS_DRAG_RESISTANCE.
        const overshoot = raw - collapsedOffset;
        next = collapsedOffset + Math.min(overshoot * DISMISS_DRAG_RESISTANCE, dismissOffset - collapsedOffset);
      }

      const dt = timeStamp - drag.lastTimestamp;
      if (dt > 0) {
        drag.velocity = (clientY - drag.lastClientY) / dt;
      }
      drag.lastClientY = clientY;
      drag.lastTimestamp = timeStamp;
      setLiveTranslate(next);
    },
    [collapsedOffset, dismissOffset, setLiveTranslate]
  );

  const endDrag = useCallback(() => {
    const drag = dragState.current;
    const releasedAt = liveTranslateRef.current;
    if (!drag || releasedAt === null) {
      dragState.current = null;
      setIsDragging(false);
      return;
    }

    const pastCollapseBy = releasedAt - collapsedOffset; // >0 once at/below the resting point
    let outcome: "expand" | "collapse" | "dismiss";

    if (pastCollapseBy > 0) {
      outcome = drag.velocity > VELOCITY_FLICK_THRESHOLD || pastCollapseBy > DISMISS_DISTANCE_PX ? "dismiss" : "collapse";
    } else if (drag.velocity < -VELOCITY_FLICK_THRESHOLD) {
      outcome = "expand";
    } else if (drag.velocity > VELOCITY_FLICK_THRESHOLD) {
      outcome = "collapse";
    } else {
      outcome = releasedAt < collapsedOffset / 2 ? "expand" : "collapse";
    }

    dragState.current = null;
    setIsDragging(false);

    if (outcome === "dismiss") {
      setLiveTranslate(dismissOffset); // let the transition slide it the rest of the way off-screen
      dismissTimeoutRef.current = window.setTimeout(() => onDismissRef.current(), DISMISS_ANIMATION_MS);
    } else {
      setExpanded(outcome === "expand");
      setLiveTranslate(null); // hand control back to the expanded/collapsed CSS value
    }
  }, [collapsedOffset, dismissOffset, setLiveTranslate]);

  // ---- Surface 1: the grab area in the top bar ---------------------------
  // Every press here is a drag, and a press that hardly moves is a tap that
  // toggles the snap points. The tap is not decoration: it is the one
  // affordance that expands the sheet without the user knowing they can
  // swipe, which is the state the half-open sheet was previously stuck in.

  const tapCandidate = useRef<{ startClientY: number; startTimestamp: number } | null>(null);

  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      tapCandidate.current = { startClientY: e.clientY, startTimestamp: e.timeStamp };
      beginDrag(e.clientY, e.timeStamp);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [beginDrag]
  );

  const onHandlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;
      e.preventDefault();
      applyDrag(e.clientY, e.timeStamp);
    },
    [applyDrag]
  );

  const onHandlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const tap = tapCandidate.current;
      tapCandidate.current = null;
      if (
        tap &&
        Math.abs(e.clientY - tap.startClientY) < TAP_SLOP_PX &&
        e.timeStamp - tap.startTimestamp < TAP_MAX_MS
      ) {
        // A tap, not a drag: settle to the OTHER snap point and skip the
        // velocity maths entirely (a tap has no meaningful velocity, and
        // feeding it to endDrag would just spring back to where it started).
        dragState.current = null;
        setIsDragging(false);
        setLiveTranslate(null);
        setExpanded((current) => !current);
        return;
      }
      endDrag();
    },
    [endDrag, setLiveTranslate]
  );

  // ---- Surface 2: the scrollable content ---------------------------------

  const contentGesture = useRef<ContentGesture | null>(null);

  const onContentPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    contentGesture.current = {
      startClientY: e.clientY,
      startTimestamp: e.timeStamp,
      // Captured once, at the start. Deliberately not re-read during the
      // gesture: a swipe that scrolls the list up to its top must not
      // suddenly start dragging the sheet the moment it gets there.
      atTop: e.currentTarget.scrollTop <= 0,
      intent: "undecided",
    };
  }, []);

  /**
   * Resolves, once per gesture, whether the finger is moving the sheet or
   * scrolling the content.
   *
   *  - Collapsed: always the sheet. The content is not scrollable in this
   *    state (the consumer sets overflow: hidden), so the whole half-open
   *    panel is one big "swipe up for more" target.
   *  - Expanded, pulling down from the very top: the sheet, so the panel can
   *    be put away from anywhere rather than only from its grabber.
   *  - Anything else: the content scrolls, natively and untouched.
   *
   * Nothing is claimed until the finger has travelled GESTURE_DECISION_PX, so
   * taps on posters, rows and buttons still land as taps.
   */
  const onContentPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = contentGesture.current;
      if (!gesture) return;

      if (gesture.intent === "undecided") {
        const delta = e.clientY - gesture.startClientY;
        if (Math.abs(delta) < GESTURE_DECISION_PX) return;
        const movesSheet = !expanded || (gesture.atTop && delta > 0);
        gesture.intent = movesSheet ? "sheet" : "scroll";
        if (movesSheet) {
          beginDrag(gesture.startClientY, gesture.startTimestamp);
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Capture can be refused if the browser already claimed the
            // gesture for a native scroll. The drag simply does not start;
            // the content scrolls instead, which is the safe outcome.
          }
        }
      }

      if (gesture.intent === "sheet") applyDrag(e.clientY, e.timeStamp);
    },
    [expanded, beginDrag, applyDrag]
  );

  const onContentPointerEnd = useCallback(() => {
    const gesture = contentGesture.current;
    contentGesture.current = null;
    if (gesture?.intent === "sheet") endDrag();
  }, [endDrag]);

  // The entrance is the outermost case but yields immediately to a live drag,
  // so a fast grab is never overridden by the opening animation.
  const currentTranslateY =
    entering && liveTranslateY === null
      ? dismissOffset
      : liveTranslateY !== null
        ? liveTranslateY
        : expanded
          ? 0
          : collapsedOffset;

  return {
    expanded,
    setExpanded,
    isDragging,
    sheetStyle: {
      height: `${sheetHeight}px`,
      transform: `translateY(${currentTranslateY}px)`,
      transition: isDragging ? "none" : SNAP_TRANSITION,
    },
    handleProps: {
      onPointerDown: onHandlePointerDown,
      onPointerMove: onHandlePointerMove,
      onPointerUp: onHandlePointerUp,
      onPointerCancel: onHandlePointerUp,
    },
    contentProps: {
      onPointerDown: onContentPointerDown,
      onPointerMove: onContentPointerMove,
      onPointerUp: onContentPointerEnd,
      onPointerCancel: onContentPointerEnd,
    },
  };
}
