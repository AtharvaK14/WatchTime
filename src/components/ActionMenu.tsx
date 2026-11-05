import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { rectAnchor, type MenuAnchor } from "../lib/contextActions";
import { useBackHandler } from "../lib/backHandler";

/**
 * The compact floating menu behind both the green-tick choices on an episode
 * and every Quick Actions menu. One component, so the two read and behave as
 * one pattern: same surface, same placement rules, same keyboard model.
 *
 * - Placed beside its anchor (below, else above; left-aligned, else right),
 *   then clamped so no edge leaves the viewport.
 * - Open until something CLOSES it on purpose: choosing an item, a tap or
 *   click that starts outside it, Escape, Android back, or a mouse wheel over
 *   the page. Outside taps are consumed, not passed through: closing a menu
 *   must never also press whatever was under it.
 * - Nothing that is merely the END of the gesture that opened it closes it.
 *   On Android, Chrome reports a long press as a contextmenu event hit-tested
 *   at the finger; when the long-press timer has already opened the menu, that
 *   event lands on this layer. It used to count as "outside" and closed the
 *   menu ~50ms after it appeared. A context menu on the layer is now only
 *   suppressed (a right-click outside still closes, by its pointerdown).
 * - A viewport resize moves the menu rather than closing it. Moving focus into
 *   the menu hides an open on-screen keyboard, which resizes the window; that
 *   too used to close the menu the moment it opened.
 * - A press that was already under way when the menu opened (the finger that
 *   long-pressed, still lifting) cannot select an item. Only a press that
 *   starts on the menu, or the keyboard, does.
 * - Arrow keys, Home and End move between items; Enter or Space selects; Tab
 *   leaves (and closes). Focus starts on the first item and returns to the
 *   item the menu was opened from.
 */

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Discards history or library membership: drawn last, after a separator, in the danger colour. */
  danger?: boolean;
  /** The item describes the current state (e.g. "Watched once" when it has been watched once). */
  checked?: boolean;
}

export interface MenuConfirm {
  message: string;
  confirmLabel: string;
}

interface Props {
  anchor: MenuAnchor;
  /** Accessible name of the menu, e.g. the title it acts on. */
  label: string;
  /** Visible header lines. */
  title?: string;
  subtitle?: string;
  items: MenuItem[];
  /** When set, the menu asks this instead of listing items. */
  confirm?: MenuConfirm | null;
  onSelect: (id: string) => void;
  onConfirm?: () => void;
  onCancelConfirm?: () => void;
  onClose: () => void;
  /** Where focus goes back to when the menu closes. */
  returnFocusTo?: HTMLElement | null;
  /** The element a "rect" anchor came from, so the menu can follow it when the viewport changes size. */
  anchorEl?: HTMLElement | null;
}

const EDGE = 8;
const GAP = 6;

function place(anchor: MenuAnchor, w: number, h: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if (anchor.kind === "point") {
    left = anchor.x + 2;
    top = anchor.y + 2;
    if (left + w > vw - EDGE) left = anchor.x - w - 2;
    if (top + h > vh - EDGE) top = anchor.y - h - 2;
  } else {
    // Beside the item, in order: below, above, to its right, to its left. The
    // sides matter for posters: a tall card with a long menu often fits
    // neither above nor below on a phone, and the item the menu is about
    // should stay in view rather than be covered by it.
    const fitsBelow = anchor.bottom + GAP + h <= vh - EDGE;
    const fitsAbove = anchor.top - GAP - h >= EDGE;
    if (fitsBelow || fitsAbove) {
      left = anchor.left;
      if (left + w > vw - EDGE) left = anchor.right - w;
      top = fitsBelow ? anchor.bottom + GAP : anchor.top - GAP - h;
    } else if (anchor.right + GAP + w <= vw - EDGE) {
      left = anchor.right + GAP;
      top = anchor.top;
    } else if (anchor.left - GAP - w >= EDGE) {
      left = anchor.left - GAP - w;
      top = anchor.top;
    } else {
      // No room anywhere around it (a full-width row on a short screen):
      // overlap the item from just inside its top edge.
      left = anchor.left;
      top = anchor.top + GAP;
    }
  }
  return {
    left: Math.max(EDGE, Math.min(left, vw - w - EDGE)),
    top: Math.max(EDGE, Math.min(top, vh - h - EDGE)),
  };
}

export default function ActionMenu({
  anchor,
  label,
  title,
  subtitle,
  items,
  confirm,
  onSelect,
  onConfirm,
  onCancelConfirm,
  onClose,
  returnFocusTo,
  anchorEl,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Bumped on every viewport resize, to re-place the menu (see the class comment).
  const [viewportTick, setViewportTick] = useState(0);
  // See the class comment: only a press that starts on the menu may select.
  const armed = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useBackHandler(true, onClose);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    // After a resize the item may have moved (the keyboard closing reflows
    // the page), so a rect anchor is re-read from the element when there is one.
    const live = viewportTick > 0 && anchor.kind === "rect" && anchorEl?.isConnected ? rectAnchor(anchorEl) : anchor;
    // Layout size, not getBoundingClientRect: the entrance animation starts
    // the menu slightly scaled down, and measuring that would place it a few
    // pixels past the edge it was supposed to clear.
    setPos(place(live, el.offsetWidth, el.offsetHeight));
  }, [anchor, items, confirm, viewportTick, anchorEl]);

  // Focus moves into the menu once it is placed, and back out when it closes.
  useEffect(() => {
    if (!pos) return;
    const first = menuRef.current?.querySelector<HTMLElement>(
      confirm ? "[data-confirm-cancel]" : "[role^='menuitem']:not([disabled])"
    );
    first?.focus({ preventScroll: true });
  }, [pos === null, confirm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const restoreTo = returnFocusTo ?? (document.activeElement as HTMLElement | null);
    return () => {
      if (restoreTo?.isConnected) restoreTo.focus({ preventScroll: true });
    };
    // Captured once, at open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape is taken in the capture phase at the window, before the details
  // panel's own Escape handler: it closes the menu, not the panel beneath it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Immediate as well: a key event whose target IS the window would
      // otherwise still reach the panels' own window listeners.
      e.stopImmediatePropagation();
      e.preventDefault();
      onCloseRef.current();
    }
    function onViewportChange() {
      setViewportTick((t) => t + 1);
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("resize", onViewportChange);
    };
  }, []);

  function moveFocus(e: ReactKeyboardEvent<HTMLDivElement>) {
    const nodes = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not([disabled])") ?? []);
    if (nodes.length === 0) return;
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % nodes.length;
    else if (e.key === "ArrowUp") next = (i - 1 + nodes.length) % nodes.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = nodes.length - 1;
    else if (e.key === "Tab") {
      onClose();
      return;
    }
    if (next === -1) return;
    e.preventDefault();
    nodes[next].focus();
  }

  /** Clicks from a press that began before the menu opened are not selections. Keyboard clicks have detail 0. */
  function guarded(fn: () => void) {
    return (e: MouseEvent) => {
      if (e.detail > 0 && !armed.current) return;
      fn();
    };
  }

  const regular = items.filter((item) => !item.danger);
  const danger = items.filter((item) => item.danger);

  function renderItem(item: MenuItem) {
    return (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className={`action-menu-item${item.danger ? " is-danger" : ""}${item.checked ? " is-checked" : ""}`}
        onClick={guarded(() => onSelect(item.id))}
      >
        <span className="action-menu-icon" aria-hidden="true">
          {item.icon}
        </span>
        <span className="action-menu-label">{item.label}</span>
        {item.checked && (
          <span className="action-menu-check">
            <span aria-hidden="true">&#10003;</span>
            <span className="sr-only">, current</span>
          </span>
        )}
      </button>
    );
  }

  // A portal is outside its parent in the DOM but not in React's tree, so
  // React bubbles events from the menu up through whatever rendered it. Inside
  // the episode panel that is the panel's backdrop, whose onClick closes the
  // panel: choosing an option (or tapping beside the menu) closed the episode
  // panel as well. Nothing that happens in the menu is the parent's business.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return createPortal(
    <div
      className="action-menu-layer"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (menuRef.current?.contains(e.target as Node)) {
          armed.current = true;
          return;
        }
        e.preventDefault();
        onClose();
      }}
      // Suppressed, never a dismissal: this is where Android's own report of
      // the long press that OPENED the menu lands (see the class comment).
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onWheel={onClose}
      onClick={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onPointerCancel={stop}
      onMouseDown={stop}
      onMouseUp={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
      onKeyDown={stop}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        className="action-menu"
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
        onKeyDown={moveFocus}
      >
        {(title || subtitle) && (
          <div className="action-menu-header" aria-hidden="true">
            {title && <span className="action-menu-title">{title}</span>}
            {subtitle && <span className="action-menu-subtitle">{subtitle}</span>}
          </div>
        )}
        {confirm ? (
          <>
            <p className="action-menu-confirm" role="alert">
              {confirm.message}
            </p>
            <div className="action-menu-confirm-row">
              <button
                type="button"
                role="menuitem"
                data-confirm-cancel
                className="action-menu-item"
                onClick={guarded(() => onCancelConfirm?.())}
              >
                <span className="action-menu-label">Cancel</span>
              </button>
              <button type="button" role="menuitem" className="action-menu-item is-danger" onClick={guarded(() => onConfirm?.())}>
                <span className="action-menu-label">{confirm.confirmLabel}</span>
              </button>
            </div>
          </>
        ) : (
          <>
            {regular.map(renderItem)}
            {regular.length > 0 && danger.length > 0 && <div className="action-menu-sep" role="separator" />}
            {danger.map(renderItem)}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
