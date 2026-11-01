import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sri } from "./build/sri.mjs";

// One script file and one stylesheet, nothing inlined and no module preload: every script the page runs is a tag with
// its integrity (build/sri.mjs), which a split chunk loaded by import() could not carry.
export default defineConfig({
  plugins: [react(), sri()],
  build: {
    target: "es2023",
    assetsInlineLimit: 0,
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
