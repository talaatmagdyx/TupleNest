/** Inline SVG icons matching the HUD design (1.6–1.8px stroke). */

/** TupleNest brand mark — layered-stack, amber→coral. Scales crisply to any size. */
export const BrandMark = ({ size = 18 }: { size?: number }) => {
  const id = "tnb"; // gradient ids are page-unique enough for a single header/onboard use
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <defs>
        <linearGradient id={`${id}w`} x1="0" y1="150" x2="0" y2="386" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFC24B" />
          <stop offset="0.5" stopColor="#FF7A45" />
          <stop offset="1" stopColor="#FF5560" />
        </linearGradient>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFD07A" />
          <stop offset="1" stopColor="#FF9A45" />
        </linearGradient>
      </defs>
      <rect x="132" y="322" width="248" height="64" rx="22" fill={`url(#${id}w)`} />
      <rect x="132" y="234" width="248" height="64" rx="22" fill={`url(#${id}w)`} />
      <g transform="rotate(-5 256 182)">
        <rect x="146" y="150" width="248" height="64" rx="22" fill={`url(#${id}w)`} />
        <rect x="146" y="150" width="248" height="33" rx="16" fill={`url(#${id}t)`} fillOpacity="0.55" />
        <rect x="160" y="163" width="84" height="9" rx="4" fill="#ffffff" fillOpacity="0.55" />
      </g>
    </svg>
  );
};

const S = (props: { size?: number }) => ({
  width: props.size ?? 15,
  height: props.size ?? 15,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  // Decorative without exception: every icon in this file sits beside a text
  // label or inside a button with its own title. Announcing them would read
  // the same control twice.
  "aria-hidden": true,
});

export const SidebarIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size })}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </svg>
);

export const PlayIcon = ({ size }: { size?: number }) => (
  // Filled rather than stroked, so it doesn't use S().
  <svg width={size ?? 13} height={size ?? 13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5v14l11-7z" />
  </svg>
);

export const DbIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 14 })} strokeWidth={1.6}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);

export const GearIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 16 })} strokeWidth={1.6}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const SearchIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 13 })} strokeWidth={1.8}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export const WarnIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 15 })} strokeWidth={1.8}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

/* — Activity-rail icons (20px, 1.7 stroke) — */
export const ExplorerRailIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 20 })}>
    <ellipse cx="12" cy="5" rx="7.5" ry="2.8" />
    <path d="M4.5 5v14c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V5" />
    <path d="M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8" />
  </svg>
);
export const HistoryRailIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 20 })}>
    <path d="M3 3v5h5" />
    <path d="M3.05 13a9 9 0 1 0 2.6-6.36L3 8" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const MonitorRailIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 20 })}>
    <path d="M3 12h4l2 6 4-14 2 8h6" />
  </svg>
);
export const DiagramRailIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 20 })}>
    <rect x="3" y="3" width="7" height="6" rx="1" />
    <rect x="14" y="15" width="7" height="6" rx="1" />
    <path d="M6.5 9v4a2 2 0 0 0 2 2h5" />
  </svg>
);
