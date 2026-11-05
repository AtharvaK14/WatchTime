// The one Quick Actions menu that can be open at a time, and the watch
// history sheet some of its actions open. Module-level stores read through
// useSyncExternalStore, the same pattern as lib/libraryRemoval.ts, so any
// screen can open a menu and the single QuickActionsHost (mounted in App)
// draws it above everything, including an open details panel.
//
// The menu holds no state of its own about the item. Its entries are built
// from the database at the moment it opens (see lib/titleQuickActions.ts and
// the season/episode menus in DetailsPanel) and each one runs the same
// operation the rest of the app uses; the lists then update through their
// own live queries, exactly as if the action had been taken anywhere else.

import { useSyncExternalStore } from "react";
import type { MenuAnchor } from "./contextActions";

export interface QuickMenuEntry {
  id: string;
  label: string;
  danger?: boolean;
  checked?: boolean;
  /** Asks first, inside the menu. */
  confirm?: { message: string; confirmLabel: string };
  /**
   * Performs the action. Resolves once the change has been written; a string
   * is shown as the confirmation toast. Rejects when nothing was saved, and
   * the host shows the error instead.
   */
  run: () => Promise<string | void> | string | void;
}

export interface QuickMenu {
  id: number;
  anchor: MenuAnchor;
  /** The element the menu is for: highlighted while open, and refocused after. */
  target: HTMLElement | null;
  label: string;
  title?: string;
  subtitle?: string;
  entries: QuickMenuEntry[];
}

let menu: QuickMenu | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The open item is marked with a data attribute rather than a class: React
 * owns className and would drop an added class on the next re-render, but it
 * never touches attributes it did not set. See [data-qa-open] in index.css.
 *
 * A menu button (aria-haspopup="menu": a season's kebab, a watched tick, a
 * movie's badge) also says it is expanded while its menu is open. None of
 * those set aria-expanded from React, so it is theirs to set here.
 */
function mark(target: HTMLElement | null, on: boolean): void {
  if (!target) return;
  if (on) target.dataset.qaOpen = "";
  else delete target.dataset.qaOpen;
  if (target.getAttribute("aria-haspopup") === "menu") {
    if (on) target.setAttribute("aria-expanded", "true");
    else target.removeAttribute("aria-expanded");
  }
}

export function openQuickMenu(next: Omit<QuickMenu, "id">): void {
  mark(menu?.target ?? null, false);
  menu = { ...next, id: nextId++ };
  mark(menu.target, true);
  emit();
}

export function closeQuickMenu(): void {
  if (!menu) return;
  mark(menu.target, false);
  menu = null;
  emit();
}

export function useQuickMenu(): QuickMenu | null {
  return useSyncExternalStore(subscribe, () => menu);
}

// ---- Watch history ----------------------------------------------------------

export interface HistoryTarget {
  kind: "show" | "movie";
  tmdbId: number;
  name: string;
}

let history: HistoryTarget | null = null;

export function openWatchHistory(target: HistoryTarget): void {
  history = target;
  emit();
}

export function closeWatchHistory(): void {
  history = null;
  emit();
}

export function useWatchHistoryTarget(): HistoryTarget | null {
  return useSyncExternalStore(subscribe, () => history);
}
