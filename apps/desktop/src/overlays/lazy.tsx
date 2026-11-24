import { lazy, Suspense, useState, type ComponentType } from "react";

/**
 * Modals most sessions never open, split out of the main bundle.
 *
 * Each one is its own chunk, so WebKit parses and holds its code only once it
 * is first opened. Tauri serves the chunks from disk, so "loading" one is a
 * local file read, not a network round trip, and it works offline.
 *
 * Why not bare `React.lazy`: a lazy component suspends on its first render
 * even when its module is already in memory, so a modal would always appear
 * one tick after the click that opened it. Once a chunk has loaded, the
 * wrapper here renders the real component directly, with no Suspense in
 * between. `preloadOverlays()` loads every chunk up front; the test setup
 * calls it so App tests can still assert on a modal synchronously.
 */

const loaders: (() => Promise<unknown>)[] = [];

export function lazyModal<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  const get = () =>
    load().then((m) => {
      loaded = m.default;
      return m;
    });
  loaders.push(get);
  const Lazy = lazy(get) as unknown as ComponentType<P>;
  return function LazyModal(props: P) {
    // Decided once per mount: switching from the lazy path to the direct one
    // mid-life would change the element type and remount the modal, losing
    // whatever the user had typed into it.
    const [Ready] = useState(() => loaded);
    if (Ready) return <Ready {...props} />;
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

/** Load every split modal now. Used by the test setup; the app never calls it. */
export function preloadOverlays(): Promise<unknown> {
  return Promise.all(loaders.map((f) => f()));
}

export const AuditModal = lazyModal(() => import("./AuditModal"));
export const DetailsModal = lazyModal(() => import("./DetailsModal"));
export const DiagramModal = lazyModal(() => import("./DiagramModal"));
export const EditReviewModal = lazyModal(() => import("./EditReviewModal"));
export const ExplainModal = lazyModal(() => import("./ExplainModal"));
export const HealthModal = lazyModal(() => import("./HealthModal"));
export const ImportModal = lazyModal(() => import("./ImportModal"));
export const IntelModal = lazyModal(() => import("./IntelModal"));
export const MonitorModal = lazyModal(() => import("./MonitorModal"));
export const PartitionsModal = lazyModal(() => import("./PartitionsModal"));
export const PastePlanModal = lazyModal(() => import("./PastePlanModal"));
export const SchemaModal = lazyModal(() => import("./SchemaModal"));
export const SearchModal = lazyModal(() => import("./SearchModal"));
