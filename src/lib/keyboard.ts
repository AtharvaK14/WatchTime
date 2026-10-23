// Putting the on-screen keyboard away when a search interaction ends.
//
// The app runs in a WebView, where the soft keyboard belongs to whichever
// editable element has focus: it is shown while a text field is focused and
// hidden when focus leaves it. So dismissing it is focus management, not a
// keyboard API - blur the field and Android's input method goes with it. That
// is the same mechanism a native app uses (clearFocus + hideSoftInputFromWindow
// is what the WebView does on blur), and it needs no plugin and no delay.

import { useEffect } from "react";

function isEditable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  // Only fields that bring up a text keyboard. A checkbox or a button-type
  // input holding focus has no keyboard to dismiss.
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(el.type);
}

/**
 * Blurs the focused text field, which closes the soft keyboard with it. Does
 * nothing when no text field is focused, so it is safe to call from any
 * "the user has picked something" path. The field's value is untouched.
 */
export function dismissKeyboard(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (isEditable(active)) active.blur();
}

/**
 * Dismisses the keyboard when an overlay opens.
 *
 * A details panel opened from a search result covers the field that was being
 * typed into, so the search interaction is over; a keyboard left up would sit
 * on top of the panel the user just asked for. Hooked on mount rather than on
 * each tap that opens a panel, because there are many of those (a dropdown
 * suggestion, a result card, a poster on a filtered list) and one hook covers
 * all of them, including ones added later.
 */
export function useDismissKeyboardOnOpen(): void {
  useEffect(() => {
    dismissKeyboard();
  }, []);
}
