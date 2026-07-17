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
    },
  },
});
