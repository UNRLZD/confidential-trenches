import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nearNetwork } from "./build/network.mjs";
import { sri } from "./build/sri.mjs";

// One script file and one stylesheet, nothing inlined and no module preload: every script the page runs is a tag with
// its integrity (build/sri.mjs), which a split chunk loaded by import() could not carry.
export default defineConfig({
  plugins: [react(), sri(), nearNetwork()],
  build: {
    target: "es2023",
    assetsInlineLimit: 0,
    modulePreload: false,
    cssCodeSplit: false,
    // keep every legal comment (`@license`, `@preserve`, `/*!`) the minifier would drop: the licences' notices ship with
    // the code they cover (Apache-2.0 §4(d) for klinecharts' NOTICE, MIT for React's header). Vite 8 sets
    // `comments.legal` to `!minify` and spreads this object over it (vite 8.3.5 dist/node/chunks/node.js:34787-34792);
    // rolldown 1.2.15's OutputOptions.comments.legal keeps "Comments that contain `@license`, `@preserve` or start with
    // `//!` or `/*!`" (dist/shared/define-config-BoIay7tU.d.mts:352-356; `legalComments` is deprecated for it, :893).
    // Held by test/legal-comments.test.ts.
    rolldownOptions: { output: { codeSplitting: false, comments: { legal: true } } },
  },
});
