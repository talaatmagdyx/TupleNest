export default {
  root: "docs/audits/2026-11-24/evidence/audit-pg/fe",
  server: { fs: { strict: false, allow: ["/"] } },
  test: { environment: "node", globals: true, include: ["**/*.test.ts"] },
};
