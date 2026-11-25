import React, { type ReactNode } from "react";

type Props = {
  /** What to show in place of the children once one of them has thrown. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
};

/**
 * Catches an error thrown while rendering its children.
 *
 * Without one, React unmounts the whole tree on any render error: one modal
 * that throws leaves an empty window, with the session, the editor and any
 * unsaved text gone from view and nothing to say why. A boundary keeps the
 * damage to the part that broke.
 *
 * A class because that is still the only way React offers to catch these.
 */
export class ErrorBoundary extends React.Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) return this.props.fallback(error, () => this.setState({ error: null }));
    return this.props.children;
  }
}

/** The last resort, around the whole app: say what happened and offer a way
 *  back. The database session lives in the backend and survives a reload. */
export function Crashed(p: { error: Error; onReload: () => void }) {
  return (
    <div className="crashed" role="alert">
      <h1>TupleNest hit an error it could not recover from</h1>
      <p>
        Nothing was sent to the database by this. Reloading redraws the window; text in the editor that was not saved
        to a file may be lost.
      </p>
      <pre>{p.error.message}</pre>
      <button className="btn primary" onClick={p.onReload}>
        Reload the window
      </button>
    </div>
  );
}
