import { useId, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../lib/useAnimatedDismiss";

/** Lines shown before the text is cut off with an ellipsis. */
const COLLAPSED_LINES = 4;
/** Same length and curve family as the rest of the motion pass in index.css. */
const TOGGLE_MS = 220;
const TOGGLE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * A paragraph clamped to a few lines, with Read more / Show less.
 *
 * Presentation only: the full text is always in the DOM (screen readers and
 * find-in-page get all of it), and the clamp is a CSS line-clamp, so nothing
 * is shortened or rewritten.
 *
 * The control only appears when the clamp is actually cutting something off,
 * measured rather than guessed from a character count - a short synopsis on a
 * wide desktop dialog and the same synopsis on a narrow phone can need
 * different answers, and a "Read more" that reveals nothing is noise.
 *
 * Expanding and collapsing animate the paragraph's height, so the content
 * below moves smoothly rather than jumping. Collapsing keeps the text
 * unclamped while it closes and only clamps at the end, so the ellipsis
 * arrives with the final height instead of the text being cut first and the
 * box shrinking around a gap.
 */
export default function ExpandableText({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  // `expanded` is what the control says; `clamped` is what the paragraph
  // looks like. They differ only while a collapse is playing.
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(true);
  const [truncates, setTruncates] = useState(false);
  const expandFrom = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);

  // Whether the clamp is cutting anything off. Re-measured on resize (a
  // rotated phone, a resized window) and once web fonts have loaded, since
  // either can change how many lines the same text needs.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !clamped) return;
    let active = true;
    const measure = () => {
      if (active) setTruncates(el.scrollHeight - el.clientHeight > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [text, clamped]);

  // Expanding: the clamp came off in this commit, so the paragraph is already
  // at its full height. Play it open from the height it had a frame ago.
  useLayoutEffect(() => {
    const el = ref.current;
    const from = expandFrom.current;
    expandFrom.current = null;
    if (!el || from === null || !expanded) return;
    // A collapse still playing holds the height; drop it before measuring,
    // or a quick reopen would "expand" to the height it was collapsing to.
    animation.current?.cancel();
    animation.current = null;
    play(el, from, el.getBoundingClientRect().height);
  }, [expanded]);

  // Collapsing finished: the clamp now produces the height the animation was
  // holding, so the held frame can be let go without a visible change.
  useLayoutEffect(() => {
    if (clamped) {
      animation.current?.cancel();
      animation.current = null;
    }
  }, [clamped]);

  function play(el: HTMLElement, from: number, to: number, onFinish?: () => void) {
    animation.current?.cancel();
    el.style.overflow = "hidden";
    const run = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: TOGGLE_MS,
      easing: TOGGLE_EASING,
      fill: "forwards",
    });
    animation.current = run;
    run.onfinish = () => {
      el.style.overflow = "";
      if (onFinish) onFinish();
      else if (animation.current === run) {
        run.cancel();
        animation.current = null;
      }
    };
    run.oncancel = () => {
      el.style.overflow = "";
    };
  }

  function toggle() {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || typeof el.animate !== "function") {
      setExpanded(!expanded);
      setClamped(expanded);
      return;
    }
    const from = el.getBoundingClientRect().height;
    if (!expanded) {
      expandFrom.current = from;
      setClamped(false);
      setExpanded(true);
    } else {
      const to = parseFloat(getComputedStyle(el).lineHeight) * COLLAPSED_LINES;
      setExpanded(false);
      play(el, from, Math.min(from, to), () => setClamped(true));
    }
  }

  return (
    <div className="expandable-text">
      <p
        id={id}
        ref={ref}
        className={`${className}${clamped ? " is-clamped" : ""}`}
        style={clamped ? { WebkitLineClamp: COLLAPSED_LINES } : undefined}
      >
        {text}
      </p>
      {truncates && (
        <button
          type="button"
          className="link-button expandable-text-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={toggle}
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
