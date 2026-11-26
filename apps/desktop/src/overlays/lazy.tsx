import { useEffect, useState, type ComponentType } from "react";
import { ErrorBoundary } from "../app-shell/ErrorBoundary";
import { ModalHead, Overlay } from "./Overlays";

/**
 * Modals most sessions never open, split out of the main bundle.
 *
 * Each one is its own chunk, so WebKit parses and holds its code only once it
 * is first opened. Tauri serves the chunks from disk, so "loading" one is a
 * local file read, not a network round trip, and it works offline.
 *
 * Why not `React.lazy`, for two reasons. A lazy component suspends on its
 * first render even when its module is already in memory, so a modal would
 * always appear one tick after the click that opened it: once a chunk has
 * loaded, the wrapper here renders the real component directly. And
 * `React.lazy` keeps a failed load for ever and throws it into the tree,
 * where — with no boundary — it unmounted the whole app: one chunk that
 * could not be read left an empty window. Here a failed load is a small
 * dialog saying so, the next open tries again, and an error thrown by the
 * modal itself is caught the same way.
 *
 * `preloadOverlays()` loads every chunk up front; the test setup calls it so
 * App tests can still assert on a modal synchronously.
 */

/** Shown in place of a modal that could not be loaded or threw. */
function ModalFailed(p: { error: Error; onClose: () => void }) {
  return (
    // alertdialog rather than a role="alert" inside a plain dialog: it is the
    // dialog itself that has to be read out at once.
    <Overlay onClose={p.onClose} center alert>
      <div className="modal dialog">
        <ModalHead title="This panel could not be opened" onClose={p.onClose} />
        <p>The rest of the app is unaffected, and nothing was sent to the database. Close this and try again.</p>
        <pre className="modal-error">{p.error.message}</pre>
      </div>
    </Overlay>
  );
}

const loaders: (() => Promise<unknown>)[] = [];

export function lazyModal<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  const get = () =>
    load().then((m) => {
      loaded = m.default;
      return m;
    });
  loaders.push(get);
  return function LazyModal(props: P) {
    const [Ready, setReady] = useState<ComponentType<P> | null>(() => loaded);
    const [failed, setFailed] = useState<Error | null>(null);
    useEffect(() => {
      if (Ready) return;
      let live = true;
      get().then(
        (m) => live && setReady(() => m.default),
        // Said in words first. What the webview reports for a file it could
        // not load is whatever it tripped over — a missing chunk came back
        // as "Unexpected token '<'", which tells a user nothing.
        (e: unknown) =>
          live &&
          setFailed(new Error(`Its code could not be loaded (${e instanceof Error ? e.message : String(e)}).`)),
      );
      return () => {
        live = false;
      };
    }, [Ready]);
    // Every modal takes `onClose`; without it the dialog can still be read.
    const close = (props as { onClose?: () => void }).onClose ?? (() => {});
    if (failed) return <ModalFailed error={failed} onClose={close} />;
    if (!Ready) return null;
    return (
      <ErrorBoundary fallback={(error) => <ModalFailed error={error} onClose={close} />}>
        <Ready {...props} />
      </ErrorBoundary>
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
