// SIGN_HOST's shell (card signpage-shell; research docs/drafts/webkit-frame-storage.md §4, D). SIGN_HOST is the top
// window and frames APP_HOST full-size: WebKit keys a framed page's storage by the top window's origin, so only a
// top-level SIGN_HOST reads its own store on every engine. The store, the prover and every signature stay in this
// document and its workers; the frame never reads storage, it asks.
//
// - The frame's src is APP_HOST with this page's path and query, and nothing else is read from them. The src is built
//   by joining strings, then parsed: an origin other than APP_HOST (a path that reads as a host) gives APP_HOST's root.
// - The kit's API (src/api.ts) runs with the frame's window as its only peer: a message counts only when its source
//   is the frame's contentWindow and its origin is APP_HOST; every post goes to that window with targetOrigin APP_HOST.
//   Same messages and answers as the framed page's. `ready` goes out again on each load of the frame, since each APP_HOST
//   document needs its own (the first, posted while the frame is still about:blank, reaches no one).
// - The frame is sandboxed to scripts, its own origin and popups that escape the sandbox (links to explorers), with no
//   `allow` (the app copies nothing). SIGN_HOST's CSP frame-src names APP_HOST only, so the frame cannot be sent
//   anywhere else; its frame-ancestors 'none' keeps any page from framing the shell.
// - The screens (sign-in, backup, the words) draw in `layer`, over the frame, in this document: a child frame cannot
//   draw over its parent. src/main.ts decides when the layer shows.
// - DOM by createElement and the CSSOM only: the CSP allows no inline style and requires Trusted Types for every sink.
import { APP_ORIGIN, startApi, type ApiHost, type PostTarget } from "./api.ts";

export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** The frame's src: APP_HOST with `loc`'s path and query, or APP_HOST's root when that is not on APP_HOST. */
export function appSrc(loc: { pathname: string; search: string }): string {
  const root = `${APP_ORIGIN}/`;
  if (!loc.pathname.startsWith("/")) return root;
  const src = `${APP_ORIGIN}${loc.pathname}${loc.search}`;
  try {
    return new URL(src).origin === APP_ORIGIN ? src : root;
  } catch {
    return root;
  }
}

/** The kit's API with the frame's window as its peer, and `ready` again on each load of the frame. */
export function wireShell(
  frame: { window: PostTarget; onLoad(fn: () => void): void },
  host: Omit<ApiHost, "parent">,
): ReturnType<typeof startApi> {
  const api = startApi({ ...host, parent: frame.window });
  frame.onLoad(api.ready);
  return api;
}

/**
 * Draws the shell into `doc`: the APP_HOST frame filling the window and the layer over it (hidden until shown), then
 * starts the API to the frame. Returns the layer.
 */
export function mountShell(doc: Document, loc: { pathname: string; search: string }, host: Omit<ApiHost, "parent" | "listen">): HTMLElement {
  const frame = doc.createElement("iframe");
  frame.id = "app";
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  Object.assign(frame.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0", display: "block" });
  const layer = doc.createElement("section");
  layer.id = "screen";
  layer.hidden = true;
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "1", overflow: "auto", background: "Canvas", color: "CanvasText" });
  Object.assign(doc.body.style, { margin: "0", background: "Canvas" });
  // the src before the frame is in the document: it never loads about:blank first, so its one load is APP_HOST's
  frame.src = appSrc(loc);
  doc.body.append(frame, layer);
  // contentWindow exists once the frame is in the document, and stays the same object across its loads
  const win = frame.contentWindow;
  if (!win) throw new Error("the APP_HOST frame has no window");
  wireShell(
    { window: win, onLoad: (fn) => frame.addEventListener("load", fn) },
    { ...host, listen: (fn) => doc.defaultView!.addEventListener("message", fn) },
  );
  return layer;
}
