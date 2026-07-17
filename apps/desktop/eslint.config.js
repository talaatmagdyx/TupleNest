import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Lint rules for the frontend.
 *
 * There was no config here at all until now: `npm run lint` did not exist, and
 * CI echoed the command rather than running it. So these rules are being
 * applied to the codebase for the first time — expect them to have something
 * to say.
 *
 * Type-aware linting is on. It costs a few seconds per run and is the only way
 * to catch the things worth catching here: floating promises around `invoke`,
 * and misuse of the async IPC boundary.
 */
export default tseslint.config(
  {
    ignores: [
      "dist",
      "coverage",
      "src-tauri",
      // Vite writes these next to its config while resolving it, and they can
      // outlive the run that made them.
      "*.timestamp-*.mjs",
      // This file. The plugins' own rule objects are loosely typed, so
      // type-aware linting reports the config for importing them.
      "eslint.config.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        // `projectService` rather than a fixed `project`: tsconfig.json only
        // includes `src`, so the config files at the root (vite, vitest, this
        // one) are in no project and a fixed list makes them parse errors.
        projectService: {
          // Those root config files still need somewhere to be parsed from.
          allowDefaultProject: ["*.config.ts", "*.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // The rule that matters most in this codebase. A stale closure in a key
      // handler is what froze the completion list while ArrowDown was held.
      "react-hooks/exhaustive-deps": "error",

      // The three below arrive with eslint-plugin-react-hooks v7, which bundles
      // the React Compiler lints. This app is not built with the compiler, and
      // what they flag is ordinary React 18: fetching on mount and calling
      // setState with the answer, mirroring state into a ref to keep a callback
      // stable. Making them pass means adopting compiler-safe patterns
      // throughout — worth doing deliberately, not as a side effect of turning
      // the linter on for the first time.
      //
      // Left as warnings rather than switched off: they are pointing at real
      // cascading-render costs, and the list should stay visible and shrink.
      // Anything genuinely wrong that they caught has already been fixed —
      // `Date.now()` during StatusBar's render is gone.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",

      // `invoke` returns a promise. An unawaited one swallows the rejection,
      // which is exactly how a failed write becomes a silent no-op.
      "@typescript-eslint/no-floating-promises": "error",

      // `onClick={async () => …}` is how React is written: the DOM ignores the
      // handler's return value, and each of these reports its own outcome. The
      // rest of the rule — a promise where a value was wanted, a promise in a
      // condition — still applies.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],

      // Underscore-prefixed args are deliberate signatures, not oversights.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  {
    // Config files run in Node, not the browser, and are outside `src`.
    files: ["*.config.ts", "*.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // Tests reach past the type system on purpose: fixtures are cast to the
    // shapes the backend really returns, and mocks are poked at.
    files: ["**/*.test.ts", "**/*.test.tsx", "src/test/**"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // `it(...)` bodies are async whether or not they await; that is the
      // signature the runner wants, not an oversight.
      "@typescript-eslint/require-await": "off",

      // Tauri rejects with a bare string. The fake backend reproduces that on
      // purpose — it is the contract being tested, not a mistake.
      "@typescript-eslint/prefer-promise-reject-errors": "off",

      // Fixtures are cast to the real payload shapes; the assertion is the
      // point.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
);
