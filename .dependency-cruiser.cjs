// The terminal imports Blindfill only from the kit's public entry (CLAUDE.md, Rules for changes). Blindfill is all of
// packages/ (the kit, the wallets) and contracts/; nothing outside them reaches any of it except the kit's entry. The
// rule holds every module outside packages/ and contracts/, not only the apps, so a relay (a file anywhere else that
// re-exports a kit internal) is refused itself, and no folder is excluded but node_modules.
// Every import is resolved to the file on disk, so a relative path, a package subpath, a re-export, a dynamic
// import(), a require() and an `import type` are all caught by the one path rule. A reach this rule does not see (a
// Worker URL, import.meta.glob, require.resolve, an import() whose path is not a plain string, a JSDoc import, a CSS
// @import or url(), a committed node_modules, a symlink) is scripts/ci/kit-reach.mjs's, the second step of
// check:imports.
const KIT_ENTRY = "^packages/kit/(dist/index\\.(js|d\\.ts)|src/index\\.ts)$";
const OUTSIDE = "^(packages|contracts)/";

module.exports = {
  forbidden: [
    {
      name: "kit-public-entry-only",
      severity: "error",
      from: { pathNot: OUTSIDE },
      to: { path: "^(packages|contracts)/", pathNot: KIT_ENTRY },
    },
    {
      name: "imports-must-resolve",
      severity: "error",
      from: { pathNot: OUTSIDE },
      to: { couldNotResolve: true },
    },
  ],
  required: [
    {
      name: "terminal-uses-kit-entry",
      severity: "error",
      module: { path: "^apps/terminal/src/main\\.tsx?$" },
      to: { path: KIT_ENTRY, reachable: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)node_modules/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "browser", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".d.ts"],
    },
  },
};
