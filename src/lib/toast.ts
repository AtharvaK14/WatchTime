// A short confirmation line at the bottom of the screen, for actions taken
// somewhere the result is not otherwise visible: a Quick Action on a poster
// (the card may not change at all - a rewatch looks exactly like a watch), or
// a season marked watched again. Only ever shown AFTER the write has landed,
// or with tone "error" when it did not, so it never claims a change that
// failed. Rendered once, by ToastHost in App.

import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  message: string;
  tone: "ok" | "error";
}

const OK_MS = 2600;
const ERROR_MS = 5000;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: readonly Toast[]): void {
  toasts = next;
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  emit(toasts.filter((t) => t.id !== id));
}

/** Shows a toast. At most two at once: a third replaces the oldest rather than stacking up the screen. */
export function showToast(message: string, tone: Toast["tone"] = "ok"): void {
  const toast = { id: nextId++, message, tone };
  emit([...toasts.slice(-1), toast]);
  window.setTimeout(() => dismissToast(toast.id), tone === "error" ? ERROR_MS : OK_MS);
}

/** "Couldn't save that, nothing changed (reason)", the wording every failed write in the app uses. */
export function showErrorToast(error: unknown, what = "save that"): void {
  const reason = error instanceof Error ? error.message : String(error);
  showToast(`Couldn't ${what}, so nothing changed. (${reason})`, "error");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
