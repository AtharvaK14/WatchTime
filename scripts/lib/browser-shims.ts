/**
 * The few browser globals the app's storage code touches, for check scripts
 * that run it under Node. Import this before anything from src/.
 *
 * Deliberately minimal: an in-memory localStorage and a window that accepts
 * the events the app dispatches. Anything else a module reaches for should
 * fail loudly rather than be quietly faked here.
 */
const store = new Map<string, string>();

const localStorageShim = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
};

const target = new EventTarget();
const windowShim = {
  dispatchEvent: (event: Event) => target.dispatchEvent(event),
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
};

Object.assign(globalThis, { localStorage: localStorageShim, window: windowShim });

export {};
