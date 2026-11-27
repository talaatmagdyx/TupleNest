/** Inline SVG icons matching the HUD design (1.6–1.8px stroke). */

/** TupleNest brand mark — an accent tile with three horizontal lines in the
 *  on-accent colour. Both come from the theme tokens, so the mark follows the
 *  light and dark palettes. Decorative: it always sits beside the wordmark. */
export const BrandMark = ({ size = 18 }: { size?: number }) => (
  <span className="brand-mark" style={{ width: size, height: size, borderRadius: Math.round(size * 0.29) }} aria-hidden>
    <svg
      width={Math.round(size * 0.58)}
      height={Math.round(size * 0.58)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 7h16M4 12h10M4 17h6" />
    </svg>
  </span>
);

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

export const OfflineIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 15 })} strokeWidth={2}>
    <path d="M2 8.8a15 15 0 0 1 20 0M5 12.6a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M3 3l18 18" />
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
/** A clipboard holding a branch — "a plan from somewhere else".
 *
 *  The first draft drew three stepped bars, which at the rail's 20px collapsed
 *  into a generic notes glyph: a 2px indent is invisible at that size. A single
 *  elbow survives the downscale and still says hierarchy, which is what a plan
 *  is. A bar chart also read well but sits directly under the monitor icon,
 *  which is already a chart. */
/** Four tiles of unequal size: a page of charts. */
export const DashboardRailIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 20 })}>
    <rect x="3" y="3" width="10" height="8" rx="1.5" />
    <rect x="15" y="3" width="6" height="8" rx="1.5" />
    <rect x="3" y="13" width="6" height="8" rx="1.5" />
    <rect x="11" y="13" width="10" height="8" rx="1.5" />
  </svg>
);
/** A page with a bent corner and lines: a document of cells. */
export const NotebookRailIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 20 })}>
    <path d="M6 2.5h8.5L19 7v14.5H6z" />
    <path d="M9 11h7M9 14.5h7M9 18h4" />
  </svg>
);
export const PastePlanRailIcon = ({ size }: { size?: number }) => (
  <svg {...S({ size: size ?? 20 })}>
    <rect x="4" y="5" width="16" height="16" rx="2.5" />
    <rect x="9" y="2.5" width="6" height="4" rx="1.5" />
    <path d="M8 10.5h8" />
    <path d="M9.5 10.5v5.5h6.5" />
  </svg>
);
