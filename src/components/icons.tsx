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

export function SettingsIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.3M17.6 15.2l2.2 1.3M4.2 16.5l2.2-1.3M17.6 8.8l2.2-1.3M3 12h2.5M18.5 12H21" />
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