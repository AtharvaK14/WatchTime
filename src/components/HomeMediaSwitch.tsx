import type { CSSProperties } from "react";
import { haptic } from "../lib/haptics";
import type { HomeMedia } from "../lib/homeMedia";

const OPTIONS: { value: HomeMedia; label: string }[] = [
  { value: "shows", label: "Shows" },
  { value: "movies", label: "Movies" },
];

/**
 * Home's Shows / Movies switch. A filter on Home, never navigation: it does not
 * change tabs, and the bottom nav stays the app's primary navigation.
 *
 * Two placements of the same control, chosen by CSS at the mobile breakpoint:
 *
 *   docked   phones: fixed just above the floating bottom nav, in the nav's
 *            own material. Rendered by App, OUTSIDE .tab-view, because that
 *            wrapper animates a transform on every tab switch, and a
 *            transformed ancestor would carry a position:fixed child along
 *            with it for the length of the animation.
 *   inline   wider screens, where there is no bottom nav: beside Home's
 *            search field.
 *
 * Each option is a full 44px tall hit area. The selected capsule is one
 * element (.media-switch-indicator) that slides between the two options, the
 * same motion as the bottom nav's capsule.
 */
export default function HomeMediaSwitch({
  value,
  onChange,
  placement,
}: {
  value: HomeMedia;
  onChange: (value: HomeMedia) => void;
  placement: "docked" | "inline";
}) {
  const index = OPTIONS.findIndex((opt) => opt.value === value);
  return (
    <div
      className={`media-switch is-${placement}`}
      role="group"
      aria-label="Show on Home"
      style={{ "--switch-index": index } as CSSProperties}
    >
      <span className="media-switch-indicator" aria-hidden="true" />
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`media-switch-option${value === opt.value ? " active" : ""}`}
          aria-pressed={value === opt.value}
          onClick={() => {
            if (value === opt.value) return;
            haptic("toggle");
            onChange(opt.value);
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
