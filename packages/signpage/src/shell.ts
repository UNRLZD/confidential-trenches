// SIGN_HOST's shell (card signpage-shell; research docs/drafts/webkit-frame-storage.md §4, D). SIGN_HOST is the top
// window and frames APP_HOST full-size: WebKit keys a framed page's storage by the top window's origin, so only a
// top-level SIGN_HOST reads its own store on every engine. The store, the prover and every signature stay in this
// document and its workers; the frame never reads storage, it asks.
//
// - The frame's src is APP_HOST with this page's path and query, and nothing else is read from them. The src is built
//   by joining strings, then parsed: an origin other than APP_HOST (a path that reads as a host) gives APP_HOST's root.
// - The kit's API (src/api.ts) runs with the frame's window as its only peer: a message counts only when its source
//   is the frame's contentWindow and its origin is APP_HOST; every post goes to that window with targetOrigin APP_HOST.
//   Same messages and answers as the framed page's. `ready` goes out once on each load of the frame, since each APP_HOST
//   document needs its own, and never at start: one posted before the frame holds its document can still reach it (the
//   target origin is checked on delivery; Firefox delivered it), a second ready for one load.
// - The frame is sandboxed to scripts, its own origin and popups that escape the sandbox (links to explorers), with no
//   `allow` (the app copies nothing). SIGN_HOST's CSP frame-src names APP_HOST only, so the frame cannot be sent
//   anywhere else; its frame-ancestors 'none' keeps any page from framing the shell.
// - The screens (sign-in, backup, the words) draw in `layer`, over the frame, in this document: a child frame cannot
//   draw over its parent. The layer is hidden in every state until an open kind asks for it (src/main.ts: signin.open),
//   and closes on signed in or Cancel. While it shows, the frame is out of the document: a frame under it could take
//   the keyboard's focus back and read the 12 words as they are typed. At close a new frame comes, at the top window's
//   address then.
// - nav: the app says where it is, and the shell puts that path and query in the top window's address with
//   history.replaceState (never a navigation), so the address bar, a reload, a new frame and a shared link follow the
//   app. reload: the shell reloads the top window (a reload of the frame alone would keep the old shell).
// - DOM by createElement and the CSSOM only: the CSP allows no inline style and requires Trusted Types for every sink.
import { SIGNPAGE_MAX_NAV_BYTES } from "../../kit/src/signpage/schema.ts";
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

/**
 * How long the frame stays after the layer opens: the answer to the kind that opened it (posted just before) is
 * delivered to the frame as a task of its own, and a frame taken out first never gets it. Taking the frame out is what
 * stops a frame from taking the keyboard's focus; it is inert meanwhile, which narrows this window but does not close
 * it (an APP_HOST page calling focus() every few ms still took keys from an inert frame on two engines, the review
 * measured). So this stays as short as the answer's delivery allows, 100 ms at most (test/shell.test.ts pins it).
 */
export const FRAME_LEAVE_MS = 100;

/**
 * Every path SIGN_HOST's build serves as a file, not as the shell: nav may not put one in the top window's address,
 * where a reload would show that file instead of the shell. The deploy's build output (scripts/deploy.mjs build(),
 * index.html and public/) is the source: test/shell.test.ts fails when a file in it is missing here. A directory in
 * it is listed with a trailing slash and covers every path under it.
 */
export const SERVED_FILES: readonly string[] = ["/_headers", "/app.js", "/assets/", "/index.html", "/licenses/", "/prover-worker.js"];

/** True when `pathname` (as the URL parser gives it) names a file the build serves, in any spelling a server reads as it. */
function servedFile(pathname: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  p = p.toLowerCase().replace(/\/+$/, "");
  return SERVED_FILES.some((f) => (f.endsWith("/") ? `${p}/`.startsWith(f) : p === f));
}

/** No frame: a post goes nowhere, and no message's source is ever this object. */
const NO_FRAME: PostTarget = { postMessage() {} };

/**
 * nav's target in the top window: `path` as APP_HOST's own path and query (appSrc's rule: joined to the origin, then
 * parsed; any other origin is refused, never its root), on `origin`, as an absolute URL; null when refused, and when
 * the path names a file SIGN_HOST's build serves (SERVED_FILES).
 */
export function navUrl(origin: string, path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path[1] === "/" || path[1] === "\\") return null;
  if (new TextEncoder().encode(path).length > SIGNPAGE_MAX_NAV_BYTES) return null;
  try {
    const app = new URL(`${APP_ORIGIN}${path}`);
    if (app.origin !== APP_ORIGIN || servedFile(app.pathname)) return null;
    const top = new URL(`${origin}${app.pathname}${app.search}`);
    return top.origin === origin ? top.href : null;
  } catch {
    return null;
  }
}

/**
 * The kit's API with the frame's window as its peer, read on every post and every message (the shell replaces the
 * frame, and has none while its layer is open), and `ready` once on each load of the frame, never before.
 */
export function wireShell(
  frame: { window(): PostTarget; onLoad(fn: () => void): void },
  host: Omit<ApiHost, "parent" | "readyOnLoad">,
): ReturnType<typeof startApi> {
  const api = startApi({
    ...host,
    readyOnLoad: true,
    get parent() {
      return frame.window();
    },
  });
  frame.onLoad(api.ready);
  return api;
}

export interface Shell {
  /** The screens' layer, over the frame. */
  layer: HTMLElement;
  /**
   * Shows the layer and FRAME_LEAVE_MS later takes the frame out of the document: the removal is what keeps the keys
   * from it. A frame left under the layer takes the keyboard's focus back (an APP_HOST page that calls focus() every
   * few ms gets every key typed after the first, the 12 words included, on every engine; inert, visibility and display
   * each let it through on some engine, the reviews measured), so none is left. The frame is also made inert in the
   * same task the layer shows, which only narrows the FRAME_LEAVE_MS window; it never replaces the removal.
   */
  open(): void;
  /** Hides the layer and puts a new frame in at the top window's address now (which nav keeps as the app's). */
  close(): void;
}

/**
 * Draws the shell into `doc`: the APP_HOST frame filling the window at the top window's path and query, and the layer
 * over it, hidden until open() (an open kind asks for it), then starts the API to the frame. The shell answers nav and
 * reload itself; `host.kinds` adds the screens' own (src/main.ts: signin.open).
 */
export function mountShell(doc: Document, host: Omit<ApiHost, "parent" | "listen" | "readyOnLoad">): Shell {
  const view = doc.defaultView!;
  const layer = doc.createElement("section");
  layer.id = "screen";
  layer.hidden = true;
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "1", overflow: "auto", background: "Canvas", color: "CanvasText" });
  Object.assign(doc.body.style, { margin: "0", background: "Canvas" });
  doc.body.append(layer);

  let frame: HTMLIFrameElement | null = null;
  let peer: PostTarget = NO_FRAME;
  let onLoad: () => void = () => {};
  const add = (): void => {
    const f = doc.createElement("iframe");
    f.id = "app";
    f.setAttribute("sandbox", FRAME_SANDBOX);
    f.setAttribute("referrerpolicy", "no-referrer");
    Object.assign(f.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0", display: "block" });
    // the src before the frame is in the document: it never loads about:blank first, so its one load is APP_HOST's
    f.src = appSrc(view.location);
    f.addEventListener("load", () => frame === f && onLoad());
    doc.body.insertBefore(f, layer);
    // contentWindow exists once the frame is in the document, and stays the same object across its loads
    const win = f.contentWindow;
    if (!win) throw new Error("the APP_HOST frame has no window");
    frame = f;
    peer = win;
  };

  wireShell(
    { window: () => peer, onLoad: (fn) => (onLoad = fn) },
    {
      ...host,
      listen: (fn) => view.addEventListener("message", fn),
      kinds: {
        ...host.kinds,
        nav: (p) => {
          const url = navUrl(view.location.origin, p.path as string);
          if (url === null) return null;
          view.history.replaceState(null, "", url);
          return { result: {} };
        },
        reload: () => ({ result: {}, then: () => view.location.reload() }),
      },
    },
  );
  add();
  let leaving: ReturnType<typeof setTimeout> | null = null;
  return {
    layer,
    open() {
      layer.hidden = false;
      if (!frame) return;
      // inert in the same task the layer shows narrows the window until the removal below, which is what stops a focus
      // thief (inert alone does not, on two engines); a posted message still reaches an inert frame
      frame.inert = true;
      if (leaving !== null) return;
      leaving = setTimeout(() => {
        leaving = null;
        if (layer.hidden || !frame) return;
        frame.remove();
        frame = null;
        peer = NO_FRAME;
      }, FRAME_LEAVE_MS);
    },
    close() {
      layer.hidden = true;
      if (leaving !== null) clearTimeout(leaving);
      leaving = null;
      if (frame) frame.inert = false;
      else add();
    },
  };
}
