import { useCallback, useEffect, useRef, useState } from "react";

// How close to the bottom counts as "at the end". A couple of pixels of
// slack absorbs sub-pixel scroll heights, which otherwise leave the flag
// stuck false at the very bottom on fractional-DPI screens.
const END_SLACK_PX = 4;

/**
 * Tracks whether a scrollable element is scrolled to its bottom.
 *
 * Used to fade out the bottom gradient on the details sheet: the gradient is
 * there to say "there is more below", so it has to stop saying that once
 * there isn't. Also reports true when the content is short enough not to
 * scroll at all, since a non-scrolling panel has no hidden content either.
 *
 * Returns a callback ref — attach it to the scrolling element. Using a
 * callback ref rather than an object ref means the listener is attached the
 * moment the node mounts, which matters here because the element appears
 * only after the panel's data has loaded.
 */
export function useScrollAtEnd(): [(node: HTMLElement | null) => void, boolean] {
  const [atEnd, setAtEnd] = useState(true);
  const nodeRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    nodeRef.current = node;
    if (!node) return;

    const measure = () => {
      const { scrollTop, scrollHeight, clientHeight } = node;
      setAtEnd(scrollTop + clientHeight >= scrollHeight - END_SLACK_PX);
    };

    // Content changes have to be measured AFTER layout has been recalculated.
    // MutationObserver fires before that, so measuring synchronously in the
    // callback reads the previous scrollHeight and lands one change behind.
    let raf = 0;
    const measureAfterLayout = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    measure();
    node.addEventListener("scroll", measure, { passive: true });

    // Two observers, because they catch different things and neither is
    // sufficient alone:
    //
    // - ResizeObserver on the container catches the viewport/sheet resizing.
    //   It does NOT fire when only the content inside grows, because the
    //   scroll container's own box is unchanged — just its scrollHeight.
    // - MutationObserver catches that content growth: the panel fills in
    //   asynchronously (TMDB details, then a season's episodes on expand),
    //   so scrollHeight changes long after mount.
    //
    // The first version observed the container plus whichever children
    // happened to exist at attach time, which missed every subsequent change
    // — the flag stayed stuck at its initial value for the life of the panel.
    const resize = new ResizeObserver(measureAfterLayout);
    resize.observe(node);
    const mutation = new MutationObserver(measureAfterLayout);
    mutation.observe(node, { childList: true, subtree: true, characterData: true });

    cleanupRef.current = () => {
      cancelAnimationFrame(raf);
      node.removeEventListener("scroll", measure);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);

  return [ref, atEnd];
}
