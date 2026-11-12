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
// - The screens (sign-in, backup, the words, sign-out, the withdraw forms) draw in one sheet (src/sheet.ts), over the
//   frame, in this document: a child frame cannot draw over its parent. The sheet is hidden in every state until an
//   open kind asks for it (src/main.ts: signin.open, signout, backup.open, withdraw.open, pool.withdraw), and closes on
//   signed in, a sign out the signout kind opened, Cancel, or the user's own Esc, close tap or scrim tap where the
//   screen may be left (card signing-views-open-over-the-app). While it shows, the frame stays in the page under the
//   scrim, inert, with its state, and every message from it is dropped: it cannot open, redraw, move, close or reload
//   the sheet, nor change the address, until the sheet closes; the shell's own posts to it go on (the state it shows).
//   A screen with a field typed into (the 12 words, the withdraw forms) takes the frame out of the document first: a
//   frame left in the page takes the keyboard's focus back and reads what is typed or pasted (open(typed), seal()).
//   At close a kept frame is live again as it was; a frame taken out comes back new, at the top window's address.
// - nav: the app says where it is, and the shell puts that path and query in the top window's address with
//   history.replaceState (never a navigation), so the address bar, a reload, a new frame and a shared link follow the
//   app. reload: the shell reloads the top window (a reload of the frame alone would keep the old shell).
// - DOM by createElement and the CSSOM only: the CSP allows no inline style and requires Trusted Types for every sink.
import { SIGNPAGE_MAX_NAV_BYTES } from "../../kit/src/signpage/schema.ts";
import { APP_ORIGIN, startApi, type ApiHost, type PostTarget } from "./api.ts";
import { PROTECT_MS } from "./guard.ts";
import { drawSheet } from "./sheet.ts";

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

/** How long the sheet's dim may wait over a new frame for its painted before it fades all the same (src/shell.ts close). */
export const VEIL_CAP_MS = 2_000;

/**
 * Every path SIGN_HOST's build serves as a file, not as the shell: nav may not put one in the top window's address,
 * where a reload would show that file instead of the shell. The deploy's build output (scripts/deploy.mjs build(),
 * index.html and public/) is the source: test/shell.test.ts fails when a file in it is missing here. A directory in
 * it is listed with a trailing slash and covers every path under it.
 */
export const SERVED_FILES: readonly string[] = ["/_headers", "/app.js", "/assets/", "/index.html", "/licenses/", "/prover-thread.js", "/prover-worker.js"];

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

/** True when `m` is exactly the kit's painted ({ v: 1, type: "painted" }, messages.ts PaintedMessage). */
function isPainted(m: unknown): boolean {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return false;
  const proto: unknown = Object.getPrototypeOf(m);
  if (proto !== Object.prototype && proto !== null) return false;
  const p = m as Record<string, unknown>;
  return Reflect.ownKeys(p).length === 2 && p.v === 1 && p.type === "painted";
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
  /** The sheet's layer, over the frame: the scrim and the sheet (src/sheet.ts). */
  layer: HTMLElement;
  /** Where the screens draw, in the sheet. */
  body: HTMLElement;
  /**
   * Shows the sheet over the frame, which stays in the page, inert, under the scrim, its messages dropped until close.
   * With `typed` (a screen with a field typed into), FRAME_LEAVE_MS later the frame is taken out of the document, as
   * seal(): the removal is what keeps typed keys from it. A frame left under the sheet takes the keyboard's focus back
   * (an APP_HOST page that calls focus() every few ms gets every key typed after the first, the 12 words included, on
   * every engine; inert, visibility and display each let it through on some engine, the reviews measured), so none is
   * left under a typed screen.
   */
  open(typed?: boolean): void;
  /** A screen with a typed field is drawn on the open sheet: the frame leaves, FRAME_LEAVE_MS after the open at most. */
  seal(): void;
  /**
   * Runs `draw` once no APP_HOST frame is in the page: now when none is, or in the task that takes it out. A sealed
   * screen draws its fields through this, so no field exists while the frame does (the sheet itself shows at once). A
   * close before the frame leaves drops it, as does the next call.
   */
  whenOut(draw: () => void): void;
  /** Hides the sheet: a kept frame is live again as it was; a frame taken out comes back new at the top window's address. */
  close(): void;
  /** Called on the user's own Esc, close tap or scrim tap (trusted events only); set by the screens. */
  onDismiss: (() => void) | null;
  /** Whether the screen on the sheet may be left: the close control shows, and Esc and the scrim act, only then. */
  dismissible(may: boolean): void;
}

/**
 * Draws the shell into `doc`: the APP_HOST frame filling the window at the top window's path and query, and the layer
 * over it, hidden until open() (an open kind asks for it), then starts the API to the frame. The shell answers nav and
 * reload itself (once `host.settle` does); `host.kinds` adds the screens' own (src/main.ts: signin.open, signout, backup.open).
 */
export function mountShell(doc: Document, host: Omit<ApiHost, "parent" | "listen" | "readyOnLoad"> & { settle?: () => Promise<void> }): Shell {
  const view = doc.defaultView!;
  const sheet = drawSheet(doc);
  const layer = sheet.layer;
  Object.assign(doc.body.style, { margin: "0", background: "#0a0a0a" });
  doc.body.append(layer);
  // the sheet's dim, kept over a new frame after a typed screen closes until that frame's document reports its first
  // content paint (the kit's painted, messages.ts PaintedMessage), then faded: the close shows no undimmed backdrop between
  // the sheet and the app's first screen. The frame's load is not its paint: an APP_HOST frame in a process of its own
  // paints on its own frames, after this document's (the e2e measured a fade 1-7 ms before the frame's first paint when
  // the fade waited for the load and two of this window's frames). It takes no tap (pointer-events none).
  const veil = doc.createElement("div");
  veil.dataset.sheet = "veil";
  Object.assign(veil.style, { position: "fixed", inset: "0", zIndex: "1", pointerEvents: "none", transition: "opacity 160ms ease-out" });
  veil.hidden = true;
  doc.body.insertBefore(veil, layer);

  let frame: HTMLIFrameElement | null = null;
  let peer: PostTarget = NO_FRAME;
  let onLoad: () => void = () => {};
  let veiled: HTMLIFrameElement | null = null;
  let veilCap: ReturnType<typeof setTimeout> | null = null;
  // the veil fades: the new frame's document has painted, or VEIL_CAP_MS passed with no painted (a frame that never
  // loads or never says so is shown as it is, undimmed, rather than dimmed for good over an app that takes taps)
  const lift = (f: HTMLIFrameElement): void => {
    if (veiled !== f) return;
    veiled = null;
    if (veilCap !== null) clearTimeout(veilCap);
    veilCap = null;
    if (frame !== f || !layer.hidden) return;
    veil.style.opacity = "0";
    setTimeout(() => layer.hidden && (veil.hidden = true), 200);
  };
  const add = (): void => {
    const f = doc.createElement("iframe");
    f.id = "app";
    f.setAttribute("sandbox", FRAME_SANDBOX);
    f.setAttribute("referrerpolicy", "no-referrer");
    Object.assign(f.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0", display: "block" });
    // the src before the frame is in the document: it never loads about:blank first, so its one load is APP_HOST's
    f.src = appSrc(view.location);
    f.addEventListener("load", () => {
      if (frame !== f) return;
      onLoad();
    });
    doc.body.insertBefore(f, layer);
    // contentWindow exists once the frame is in the document, and stays the same object across its loads
    const win = f.contentWindow;
    if (!win) throw new Error("the APP_HOST frame has no window");
    frame = f;
    peer = win;
  };

  // the painted of the frame made at a typed screen's close: from that frame's window and APP_HOST only, exactly the kit's
  view.addEventListener("message", (e: MessageEvent) => {
    const f = veiled;
    if (f !== null && e.origin === APP_ORIGIN && e.source === f.contentWindow && isPainted(e.data)) lift(f);
  });
  wireShell(
    { window: () => peer, onLoad: (fn) => (onLoad = fn) },
    {
      ...host,
      // while the sheet shows, nothing the frame sends is read: no kind, nav or reload until the sheet closes
      listen: (fn) => view.addEventListener("message", (e) => layer.hidden && fn(e)),
      kinds: {
        ...host.kinds,
        // nav and reload, as every kind, only while no sheet shows (one the frame sent before it opened included)
        nav: (p) => {
          if (!layer.hidden) return null;
          const url = navUrl(view.location.origin, p.path as string);
          if (url === null) return null;
          view.history.replaceState(null, "", url);
          return { result: {} };
        },
        // a running trade settles first (src/trade.ts idle): its marks are written either way, but no reload cuts it
        // ...and a reload answered before a sheet opened does not fire under it
        reload: () => (!layer.hidden ? null : { result: {}, then: () => void (host.settle?.() ?? Promise.resolve()).then(() => layer.hidden && view.location.reload()) }),
      },
    },
  );
  add();
  let leaving: ReturnType<typeof setTimeout> | null = null;
  let waking: ReturnType<typeof setTimeout> | null = null;
  let openedAt = 0;
  // the draw waiting for the frame to leave (whenOut)
  let pending: (() => void) | null = null;
  const leave = (): void => {
    if (layer.hidden || !frame) return;
    frame.remove();
    frame = null;
    peer = NO_FRAME;
    const draw = pending;
    pending = null;
    draw?.();
  };
  const shell: Shell = {
    layer,
    body: sheet.body,
    onDismiss: null,
    open(typed = false) {
      layer.hidden = false;
      veil.hidden = true;
      if (waking !== null) clearTimeout(waking);
      waking = null;
      openedAt = view.performance?.now?.() ?? Date.now();
      sheet.box.focus?.();
      if (!frame) return;
      // inert in the same task the sheet shows: the frame takes no tap, no focus by the user, and leaves the a11y tree
      frame.inert = true;
      if (typed) shell.seal();
    },
    seal() {
      if (layer.hidden || !frame || leaving !== null) return;
      // the answer to the kind that opened the sheet is delivered to the frame as a task of its own: the frame stays
      // until FRAME_LEAVE_MS after the open, never longer
      const wait = FRAME_LEAVE_MS - ((view.performance?.now?.() ?? Date.now()) - openedAt);
      // a typed screen drawn on a sheet open longer than that (Recovery code on the sign-in sheet): out in this task
      if (wait <= 0) return leave();
      leaving = setTimeout(() => {
        leaving = null;
        leave();
      }, wait);
    },
    whenOut(draw) {
      pending = null;
      if (!frame) draw();
      else pending = draw;
    },
    close() {
      layer.hidden = true;
      if (leaving !== null) clearTimeout(leaving);
      leaving = null;
      pending = null;
      // a kept frame stays inert for PROTECT_MS after the close (the second tap of a double tap on Cancel, Saved, the x or
      // the scrim lands on no app control there), then is live again and takes the keyboard's focus back; a frame taken
      // out comes back new, as inert for the same time, under the sheet's dim until it has painted
      if (!frame) {
        veil.style.background = sheet.scrim.style.background;
        veil.style.opacity = "1";
        veil.hidden = false;
        add();
        const f = frame as unknown as HTMLIFrameElement;
        veiled = f;
        veilCap = setTimeout(() => lift(f), VEIL_CAP_MS);
      }
      const f = frame as unknown as HTMLIFrameElement;
      f.inert = true;
      if (waking !== null) clearTimeout(waking);
      waking = setTimeout(() => {
        waking = null;
        if (frame !== f || !layer.hidden) return;
        f.inert = false;
        f.focus?.();
      }, PROTECT_MS);
    },
    dismissible(may) {
      sheet.close.hidden = !may;
      sheet.close.style.visibility = may ? "visible" : "hidden";
      dismissOk = may;
    },
  };
  let dismissOk = false;
  const dismiss = (e: Event): void => {
    if (!e.isTrusted || layer.hidden || !dismissOk) return;
    // a tap or key that comes with the open (the second tap of a double tap that opened it, a key held down) is not the
    // user's close: the activation guard's window (src/guard.ts), on the event's own clock
    const at = typeof e.timeStamp === "number" && e.timeStamp > 0 ? e.timeStamp : (view.performance?.now?.() ?? Date.now());
    if (at - openedAt < PROTECT_MS) return;
    shell.onDismiss?.();
  };
  sheet.close.addEventListener("click", dismiss);
  sheet.scrim.addEventListener("click", dismiss);
  // a key held down repeats: only a press of its own is the user's Esc
  view.addEventListener("keydown", (e: Event) => (e as KeyboardEvent).key === "Escape" && !(e as KeyboardEvent).repeat && dismiss(e));
  // while a sheet shows over a kept frame, the frame does not keep the keyboard's focus: focus that went into it (a
  // frame calling focus() under an inert attribute some engine lets through) comes back to the sheet in the next task
  view.addEventListener("blur", () => {
    if (layer.hidden || !frame) return;
    setTimeout(() => {
      if (!layer.hidden && frame && doc.activeElement === frame) sheet.box.focus?.();
    }, 0);
  });
  shell.dismissible(false);
  return shell;
}
