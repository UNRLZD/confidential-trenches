// The terminal's entry. Blindfill is reached only through the kit's public entry (CLAUDE.md, Rules for changes); the
// import below is what CI's terminal-uses-kit-entry rule reads (.dependency-cruiser.cjs, required).
import "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { applyFit } from "./shell/fit.ts";
import { fontsReady } from "./shell/fonts.ts";
import { Shell } from "./shell/Shell.tsx";
import "./shell/shell.css";

applyFit();

// The first paint waits for the shell's fonts (preloaded by index.html), so no text moves when they arrive (BAR-04).
fontsReady().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </StrictMode>,
  );
});
