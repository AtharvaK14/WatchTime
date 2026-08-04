export interface IconProps {
  size?: number;
  className?: string;
}

function baseProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

export function HomeIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <path d="M4 11.5L12 4l8 7.5" />
      <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
      <path d="M10 20v-6h4v6" />
    </svg>
  );
}

export function ShowsIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M9 21h6" />
      <path d="M12 17v4" />
    </svg>
  );
}

export function MoviesIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DiscoverIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.8 8l-2 6-6 2 2-6z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// A true cog. The previous version was a circle with radial spokes, which
// reads as a sun or a brightness control rather than settings; the teeth are
// what make the shape unambiguous at nav size.
export function SettingsIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/* Check and close were previously the literal glyphs U+2713 and U+00D7.
   U+2713 sits outside both Inter subsets the app bundles, so it always
   rendered from whatever fallback face the device happened to supply —
   a different weight and optical size from everything around it. As SVG
   they match the rest of this family exactly and cannot fall back. */

export function CheckIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CloseIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/* Icons below are used to anchor empty states. Same 24px grid, same 2px
   stroke and round caps as the nav icons above, so they read as one family. */

export function CheckCircleIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.2l2.4 2.4 4.6-4.9" />
    </svg>
  );
}

export function SearchIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20 20" />
    </svg>
  );
}

export function StackIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <path d="M12 3.5l8 4.2-8 4.2-8-4.2z" />
      <path d="M4 12l8 4.2 8-4.2" />
      <path d="M4 16.2l8 4.2 8-4.2" />
    </svg>
  );
}
// For You: a sparkle, the common shorthand for "personalised / picked for
// you". Deliberately not a heart (that reads as favourites/likes, which this
// app has no concept of) and not a star (too close to ratings).
export function ForYouIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
      <path d="M18 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
    </svg>
  );
}
