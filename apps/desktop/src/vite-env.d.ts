/// <reference types="vite/client" />
/// <reference types="node" />

// Two ambient references the build had been getting by accident.
//
// `vite/client` is what declares a side-effect import of a stylesheet, so
// `import "./styles.css"` in main.tsx has a type. TypeScript 5.9 let that
// import through undeclared; 7.0 does not (TS2882), and it was right to ask —
// nothing in the project said what importing a .css file means.
//
// `node` covers the `node:fs` / `node:path` / `process` used by the shortcut
// test, which reads App.tsx off disk to prove no key comparison lives there.
// @types/node was already a dependency; nothing had ever pulled it into the
// program (TS2591).
//
// Triple-slash references rather than a `types` array in tsconfig on purpose:
// setting `types` switches off automatic @types inclusion for everything else,
// which would silently drop the testing-library matchers and vitest's own
// declarations. This adds without taking away.
