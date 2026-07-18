import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Type-only: erased at compile time, so there is no code to execute.
        // Counting it would measure nothing and "covering" it would mean
        // writing a test that imports types to satisfy a number.
        "src/ipc/types.ts",
        // Vite entrypoint: mounts React onto a real DOM node at startup.
        "src/main.tsx",
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
      ],
      /*
       * A floor, not a target. The suite sits at 100% lines and statements,
       * 99.3% functions and ~95% branches; these are set just under that.
       *
       * The gap is deliberate. Chasing the last few branches means testing
       * defensive fallbacks that cannot be reached — writing a test that
       * asserts an `if` nobody can enter proves nothing and has to be
       * maintained forever. What this catches is the real failure: a hundred
       * lines of new code arriving with no tests at all, which drags the whole
       * number down and fails here rather than in review.
       *
       * If a legitimate change lowers these, move the number and say why in
       * the commit. Do not delete the block.
       *
       * Re-baselined for vitest 4 / @vitest/coverage-v8 4. v4 remaps coverage
       * through the AST rather than v8's raw byte ranges, so it counts more
       * statements and branches and reads ~2 points stricter than v3 measured
       * on the SAME suite — 97.4/92.0/98.0/98.9 here, where v3 showed
       * 99.7/94.3/98.7/99.7. No tests were removed; the suite is unchanged.
       * These floors sit just under the v4 measurement so the ratchet still
       * catches a real regression, now against a more accurate baseline.
       */
      thresholds: {
        lines: 98,
        statements: 97,
        functions: 97,
        branches: 91,
      },
    },
  },
});
