import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  root: "/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop",
  resolve: { alias: { "@app": "/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop/src" } },
  server: { fs: { strict: false } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop/src/test/setup.ts"],
    dir: "docs/audits/2026-11-24/evidence/audit-fe",
    include: ["docs/audits/2026-11-24/evidence/audit-fe/**/*.audit.test.{ts,tsx}"],
    testTimeout: 30000,
  },
});
