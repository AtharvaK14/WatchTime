// How a Quick Actions menu is summoned on an item: right-click (or the
// keyboard's context-menu key, Shift+F10) on desktop, a long press on touch.
//
// A props factory rather than a hook, so it can be spread on items rendered
// in a loop (season headers, episode rows) without a component per item.
// Only one press can be in progress at a time, so its state is module-level.
//
// The rules that keep it from getting in the way of ordinary use:
//
//  - A tap is a tap. The menu needs LONG_PRESS_MS of holding still; lifting
//    sooner cancels it and the tap does what it always did.
//  - Scrolling is not a hold. Moving more than MOVE_TOLERANCE_PX cancels, and
//    so does the browser's pointercancel when it takes over to scroll.
//  - A hold never also activates the item. The click a touch browser may send
//    when the finger lifts after a long press is swallowed, so holding a card
//    does not open its details panel underneath the menu.
//  - The browser's own menu (image save, text selection, the iOS callout) is
//    suppressed on these items only: contextmenu is prevented here, and
//    [data-quick-actions] turns off selection and the callout in index.css.
//  - The mouse never long-presses: right-click is the desktop gesture, and a
//    slow left click must stay a click.

import type { MouseEvent, PointerEvent } from "react";

/** Where a menu should appear: at a point (mouse), or beside an element (touch, keyboard). */
export type MenuAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; top: number; left: number; right: number; bottom: number };

/** Holding for this long opens the menu. Long enough that a slow tap does not, short enough not to feel stuck. */
export const LONG_PRESS_MS = 500;
/** Further than this from where the press started, it is a scroll or a drag, not a hold. */
export const MOVE_TOLERANCE_PX = 10;
/** How long after a long press its trailing click is still swallowed. */
const SWALLOW_CLICK_MS = 1200;

export function rectAnchor(el: Element): MenuAnchor {
  const r = el.getBoundingClientRect();
  return { kind: "rect", top: r.top, left: r.left, right: r.right, bottom: r.bottom };
}

let press: { pointerId: number; x: number; y: number; timer: number } | null = null;
let lastPointerType = "mouse";
let swallow: { el: Element; until: number } | null = null;

function cancelPress(): void {
  if (press) window.clearTimeout(press.timer);
  press = null;
}

function swallowNextClick(el: Element): void {
  swallow = { el, until: Date.now() + SWALLOW_CLICK_MS };
}

export type OpenContextActions = (anchor: MenuAnchor, target: HTMLElement) => void;

/**
 * Spread on the element that should have Quick Actions. `open` is called with
 * where to put the menu and the element it is for (which the menu marks while
 * it is open).
 */
export function contextActionProps(open: OpenContextActions) {
  return {
    "data-quick-actions": "",
    onPointerDown(e: PointerEvent<HTMLElement>) {
      lastPointerType = e.pointerType;
      // A new interaction: whatever an earlier long press left behind no longer applies.
      swallow = null;
      cancelPress();
      if (e.pointerType === "mouse" || !e.isPrimary || e.button !== 0) return;
      const el = e.currentTarget;
      press = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          press = null;
          swallowNextClick(el);
          // A tick of haptic feedback where the platform offers it; harmless where it does not.
          try {
            navigator.vibrate?.(8);
          } catch {
            // ignored
          }
          open(rectAnchor(el), el);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      if (!press || e.pointerId !== press.pointerId) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE_PX) cancelPress();
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      if (press && e.pointerId === press.pointerId) cancelPress();
    },
    onPointerCancel(e: PointerEvent<HTMLElement>) {
      if (press && e.pointerId === press.pointerId) cancelPress();
    },
    onContextMenu(e: MouseEvent<HTMLElement>) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      // Android also reports a long press as contextmenu. When the timer has
      // already opened the menu for this press, this is that same hold.
      if (swallow && swallow.el === el && Date.now() < swallow.until) return;
      cancelPress();
      const touch = lastPointerType === "touch" || lastPointerType === "pen";
      if (touch) swallowNextClick(el);
      // The keyboard's context-menu key reports no pointer position (0,0) or
      // one outside the element; the menu goes beside the item then, as it
      // does for touch, where a finger would cover a menu at the point.
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const atPoint = !touch && inside && (e.clientX !== 0 || e.clientY !== 0);
      open(atPoint ? { kind: "point", x: e.clientX, y: e.clientY } : rectAnchor(el), el);
    },
    onClickCapture(e: MouseEvent<HTMLElement>) {
      // Only a pointer's click can be the tail of a long press. A keyboard
      // click (Enter or Space, detail 0) is always a deliberate activation.
      if (e.detail === 0) return;
      if (!swallow || swallow.el !== e.currentTarget) return;
      const live = Date.now() < swallow.until;
      swallow = null;
      if (!live) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
