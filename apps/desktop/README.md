# TupleNest Desktop (Tauri 2 + React)

Initialize with:

    npm create tauri-app@latest .   # choose React + TypeScript + Vite

Frontend module layout (Phase 0/1):

    src/
      app-shell/      window chrome, layout, split panes
      commands/       command registry + palette
      tabs/           tab system, restoration
      settings/       settings UI backed by SQLite store
      theme/          theme system (light/dark/high-contrast)
      connections/    connection manager UI (Phase 1)
      explorer/       database explorer tree (Phase 1)
      editor/         Monaco SQL editor (Phase 1)
      results/        streaming virtualized result grid (Phase 1)
      history/        query history (Phase 1)
      export/         CSV/JSON export UI (Phase 1)
      state/          Zustand stores + TanStack Query wiring
      ipc/            typed Tauri command bindings

Rust-owned state (never in frontend): connections, sessions, transactions,
executions, result streams, secrets, background tasks.
