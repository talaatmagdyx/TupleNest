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
       */
      thresholds: {
        lines: 99,
        statements: 99,
        functions: 98,
        branches: 93,
      },
    },
  },
});
