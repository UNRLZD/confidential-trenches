import { createSignpageClient } from "@blindfill/kit";
import { StrictMode } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import type { RouteId } from "../routes/routes.ts";
import { applyFit } from "./fit.ts";
import { fontsReady } from "./fonts.ts";
import { moveToShell } from "./in-shell.ts";
import { Shell } from "./Shell.tsx";
import { SIGN_HOST_URL } from "./signpage-frame.tsx";
import "./shell.css";

// The app's start. A top-level visit moves to SIGN_HOST's shell and draws nothing (in-shell.ts). Framed in the shell,
// the signing page's client starts here, in the entry module, so it listens before this document's load ends: the
// shell posts its ready on each load of the app's frame. `screen` draws each route (a browser test passes a probe).
export function start(screen?: ComponentType<{ id: RouteId }>): void {
  if (moveToShell(window, new URL(SIGN_HOST_URL).origin)) return;
  applyFit();
  const client = createSignpageClient({
    url: SIGN_HOST_URL,
    mode: "parent",
    host: { window, document, mount: document.body, parent: window.parent },
  });

  // The first paint waits for the shell's fonts (preloaded by index.html), so no text moves when they arrive (BAR-04).
  fontsReady().then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <BrowserRouter>
          <Shell client={client} screen={screen} />
        </BrowserRouter>
      </StrictMode>,
    );
  });
}
