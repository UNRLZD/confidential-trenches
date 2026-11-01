import { StrictMode } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import type { RouteId } from "../routes/routes.ts";
import { applyFit } from "./fit.ts";
import { fontsReady } from "./fonts.ts";
import { landOnLoad } from "./ReturnHop.tsx";
import { Shell } from "./Shell.tsx";
import "./shell.css";

// The app's start, one sequence for the app (main.tsx) and the browser tests' probe build (test/return-hop/probe.tsx),
// which passes its own screen.
export function start(screen?: ComponentType<{ id: RouteId }>): void {
  applyFit();
  // a return from SIGN_HOST: the URL goes to the route the user left (or the default route) before the router reads it
  landOnLoad();

  // The first paint waits for the shell's fonts (preloaded by index.html), so no text moves when they arrive (BAR-04).
  fontsReady().then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <BrowserRouter>
          <Shell screen={screen} />
        </BrowserRouter>
      </StrictMode>,
    );
  });
}
