// The signing-page client (app.md §2.1 items 2-4, row A1.2, app.md:1435): the app's only way to SIGN_HOST. It mounts
// one hidden iframe of SIGN_HOST's release URL, waits for the page's `ready` and then for that frame's first `state`
// answer (READY: the state is known, BAR-09, app.md:1107), and then sends the seventeen kinds of messages.ts and reads
// their answers. Every message from the page is dropped, with no change, unless its `origin` is SIGN_HOST's exactly,
// its `source` is the current iframe's window, its shape passes the schema of what it claims to be (schema.ts), and an
// answer's id is one this client is waiting for. The app never re-sends a kind on its own (APU-03, app.md:1328).
//
// How a request ends without the page's answer:
//   - `signpage_down`: it was never posted (the client was down, or went down before the handshake it waited for);
//   - `client_timeout`: it was posted and the page may have it. Its timeout passed, or the frame went down or was
//     replaced while it was open. The page may still run it, so a screen reads the outcome from `state` (asked again
//     at the next READY) and never re-taps it as unsent.
// Down: no ready in 5 s, no state answer within 5 s of the ready, an iframe error, the iframe's load with no ready
// within 1 s (a refused, failed or blocked load shows the browser's error page and fires load, not error), or an open
// kind's timeout. While down, a fresh iframe is tried after 1 s, then 2, 4 and 8 s, then every SIGNPAGE_RETRY_MS, and
// at once when the browser is back online or the page is shown again; these tries keep the down state until one
// reaches READY, so the down state clears with no reload when SIGN_HOST returns. A ready
// with an `api` this client does not speak is the update state (CH-146): money off until a reload, no retry.
//
// Parent mode (mode "parent"): the app runs framed inside SIGN_HOST's shell, the top window, since WebKit partitions a
// framed SIGN_HOST's storage by the top origin. The client mounts no iframe: it posts to host.parent with SIGN_HOST's
// origin, and a message counts only from host.parent. The shell posts its ready on each load of the app's frame, so an
// app creates its client in its entry module, before its load ends. Down is the same minus the iframe's error and load.
// A retry has no frame to replace: once the shell's ready has been seen, it asks `state` again and READY is that answer;
// before it, it waits SIGNPAGE_HANDSHAKE_MS for a ready. Everything else is the iframe mode's, so an app sees the same
// snapshots and outcomes in both.
//
// Kit version (card kit-frame-version): before each handshake `state` request the client posts a hello naming
// SIGNPAGE_KIT_VERSION (messages.ts HelloMessage), so the page sends it only what this version reads; a page of an
// earlier release drops the hello unanswered. A state's op this client cannot read is left out, never the whole state.

import { OPEN_KINDS, SIGNPAGE_KIT_VERSION } from "./messages.ts";
import type { BuyRoute, HelloMessage, ErrorCode, SignpageKind, SignpageParams, SignpageRequest, SignpageResults, SignpageState, Stage } from "./messages.ts";
import {
  SIGNPAGE_MAX_REQUEST_BYTES,
  SIGNPAGE_PARAM_SCHEMAS,
  SIGNPAGE_RESULT_SCHEMAS,
  signpageAnswerErrorSchema,
  signpageAnswerOkSchema,
  signpageIsKind,
  signpageIsPlainMessage,
  signpageProgressRouteSchema,
  signpageProgressSchema,
  signpageReadableOps,
  signpageReadySchema,
  signpageStateEventSchema,
} from "./schema.ts";
import { deepFreeze } from "../freeze.ts";

export { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_MAX_ARRAY, SIGNPAGE_MAX_DEPTH, SIGNPAGE_MAX_REQUEST_BYTES } from "./schema.ts";

/** The `api` of messages.ts, the only one this client speaks. */
export const SIGNPAGE_CLIENT_API = 1;
/** No `ready` in this long after the mount, or no `state` answer this long after the ready, and the client is down. */
export const SIGNPAGE_HANDSHAKE_MS = 5_000;
/** While down, a fresh iframe at least this often (the longest wait of the retry backoff). */
export const SIGNPAGE_RETRY_MS = 10_000;
/** The first retry's wait after the client goes down; each next wait doubles, up to the retry option. */
const RETRY_FIRST_MS = 1_000;
/** After the iframe's load, how long a `ready` may still take before the client is down (BAR-09's warm answer, 1 s). */
const LOAD_GRACE_MS = 1_000;

/** How long the client waits for each kind's answer (app.md §2.1 item 3's table); null: no timeout. */
export const SIGNPAGE_TIMEOUT_MS = deepFreeze({
  "deposit.quote": 15_000,
  "deposit.confirm": 15_000,
  arm: 5_000,
  buy: 10_000,
  hop: 10_000,
  "orders.set": 15_000,
  "orders.cancel": 15_000,
  return: 15_000,
  "withdraw.open": 5_000,
  "signin.open": 5_000,
  "backup.open": 5_000,
  "export.open": 5_000,
  signout: 5_000,
  // restore reports `progress` at least every 10 s; a screen shows it stalled, the client never ends it
  restore: null,
  state: 5_000,
  // the shell's (card signpage-shell): answered at once
  nav: 5_000,
  reload: 5_000,
  // the pool kinds (card signpage-pool-kinds): answered once signed and sent, as buy is; the withdraw screen as an open
  "pool.deposit": 10_000,
  "pool.buy": 10_000,
  "pool.sell": 10_000,
  "pool.withdraw": 5_000,
  // the deposit sheet's reads (card kit-deposit-assets-dry): each waits for the helper's 1Click round trips, as
  // deposit.quote does (deposit.assets asks the token list, then one dry quote per asset at once)
  "deposit.assets": 15_000,
  "deposit.dry": 15_000,
} as const satisfies Record<SignpageKind, number | null>);

/** After one of these times out, the client asks `state` again (a new `state` request); the kind itself is never re-sent. */
const REASK_STATE: ReadonlySet<SignpageKind> = new Set(["deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return", "pool.deposit", "pool.buy", "pool.sell"]);

/** The hidden iframe's attributes (app.md §2.1 item 2; AX-06, app.md:1386). */
export const SIGNPAGE_IFRAME_ATTRIBUTES = deepFreeze({
  sandbox: "allow-scripts allow-same-origin",
  allow: "",
  referrerpolicy: "no-referrer",
  "aria-hidden": "true",
  tabindex: "-1",
  width: "0",
  height: "0",
} as const);

/** The codes the client itself answers with, never the page. */
export const SIGNPAGE_CLIENT_CODES = deepFreeze({ timeout: "client_timeout", down: "signpage_down" } as const);

/** "update": the page speaks an `api` this client does not (CH-146); money stays off until a reload. */
export type SignpageClientStatus = "connecting" | "ready" | "down" | "update";
export type SignpageDropReason = "origin" | "source" | "shape" | "id";

export interface SignpageClientSnapshot {
  status: SignpageClientStatus;
  /** The page's release tag from its handshake. */
  release: string | null;
  /** The last state the page sent. */
  state: SignpageState | null;
  /** True when `state` is not this frame's latest: a `state` request timed out, or the frame went down or was replaced. */
  stale: boolean;
}

export type SignpageOutcome<K extends SignpageKind = SignpageKind> =
  | { ok: true; result: SignpageResults[K] }
  | { ok: false; error: { code: ErrorCode } };

/** A request: its id at once (to match `progress` events), its outcome later. */
export interface SignpageRequestHandle<K extends SignpageKind = SignpageKind> {
  id: string;
  outcome: Promise<SignpageOutcome<K>>;
}

/** The parts of the browser the client uses; a test passes its own. */
export interface SignpageClientHost {
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Unused in parent mode. */
  document: Pick<Document, "createElement">;
  /** Where the iframe goes; unused in parent mode. */
  mount: Pick<HTMLElement, "appendChild">;
  /** Parent mode: the shell's window, the app's window.parent. */
  parent?: Pick<Window, "postMessage">;
}

/** "iframe": a hidden iframe of SIGN_HOST (the default). "parent": the app runs inside SIGN_HOST's shell. */
export type SignpageClientMode = "iframe" | "parent";

export interface SignpageClientOptions {
  /** SIGN_HOST's release URL, for example "https://sign.confidential.unrealized.trade/": https, no query, no fragment. */
  url: string;
  host: SignpageClientHost;
  /** 0 turns the retry off. */
  retryMs?: number;
  mode?: SignpageClientMode;
}

export interface SignpageClient {
  snapshot(): SignpageClientSnapshot;
  /** Called on every change of the snapshot; returns the unsubscribe. */
  subscribe(fn: (s: SignpageClientSnapshot) => void): () => void;
  /** Called on every `progress` event; returns the unsubscribe. */
  onProgress(fn: (id: string, stage: Stage) => void): () => void;
  /** Called on every route event of a running buy (messages.ts BuyRoute), by the request's id; returns the unsubscribe.
   *  A page of an earlier release sends none. */
  onRoute(fn: (id: string, route: BuyRoute) => void): () => void;
  /** Sends one request once READY. Throws at once when its params are not exactly its kind's. */
  request<K extends SignpageKind>(kind: K, params: SignpageParams[K]): SignpageRequestHandle<K>;
  /** A fresh iframe (parent mode: none) and a new handshake now. */
  retry(): void;
  /** Messages dropped so far, by why. */
  dropped(): Record<SignpageDropReason, number>;
  destroy(): void;
}

/**
 * The request envelope of a kind, built from exactly its allowed params. Throws on an unknown kind, a bad param or a
 * request over SIGNPAGE_MAX_REQUEST_BYTES.
 */
export function signpageBuildRequest<K extends SignpageKind>(kind: K, params: SignpageParams[K], id: string): SignpageRequest<K> {
  if (!signpageIsKind(kind)) throw new TypeError(`signpage: no such kind ${String(kind)}`);
  if (!SIGNPAGE_PARAM_SCHEMAS[kind](params)) throw new TypeError(`signpage: params are not exactly ${kind}'s`);
  const msg = { ...params, v: 1, id, type: kind } as SignpageRequest<K>;
  if (new TextEncoder().encode(JSON.stringify(msg)).length > SIGNPAGE_MAX_REQUEST_BYTES) {
    throw new TypeError(`signpage: ${kind} is over ${SIGNPAGE_MAX_REQUEST_BYTES} bytes`);
  }
  return msg;
}

/** SIGN_HOST's origin from its release URL; throws on anything but https with no query, fragment or credentials. */
export function signpageOrigin(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password || u.href !== url) {
    throw new TypeError(`signpage: ${url} is not an https release URL with no query`);
  }
  return u.origin;
}

type Timer = ReturnType<typeof setTimeout>;

interface Pending {
  kind: SignpageKind;
  resolve: (o: SignpageOutcome) => void;
  timer: Timer | null;
}

const DOWN = { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } } as const;
const TIMEOUT = { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.timeout } } as const;

export function createSignpageClient(opts: SignpageClientOptions): SignpageClient {
  const origin = signpageOrigin(opts.url);
  const { host } = opts;
  const retryMs = opts.retryMs ?? SIGNPAGE_RETRY_MS;
  const mode: unknown = opts.mode === undefined ? "iframe" : opts.mode;
  if (mode !== "iframe" && mode !== "parent") throw new TypeError(`signpage: no such mode ${String(mode)}`);
  /** Parent mode's shell window; null in the iframe mode. */
  const shell = mode === "parent" ? (host.parent ?? null) : null;
  if (mode === "parent" && (shell === null || shell === (host.window as unknown))) {
    throw new TypeError("signpage: parent mode needs host.parent, a window other than host.window");
  }

  let snap: SignpageClientSnapshot = { status: "connecting", release: null, state: null, stale: false };
  const listeners = new Set<(s: SignpageClientSnapshot) => void>();
  const progressListeners = new Set<(id: string, stage: Stage) => void>();
  const routeListeners = new Set<(id: string, route: BuyRoute) => void>();
  /** Posted requests, by id. */
  const pending = new Map<string, Pending>();
  const drops: Record<SignpageDropReason, number> = { origin: 0, source: 0, shape: 0, id: 0 };
  /** Requests not posted yet, waiting for the handshake to end. */
  let waiters: (() => void)[] = [];
  let frame: HTMLIFrameElement | null = null;
  /** The frame's generation: a handshake answer of an older frame changes nothing. */
  let gen = 0;
  let handshakeTimer: Timer | null = null;
  let retryTimer: Timer | null = null;
  /** The current frame's wait for its ready after its load. */
  let loadTimer: Timer | null = null;
  /** True once the current frame has sent its ready (the iframe mode only). */
  let readySeen = false;
  /** The newest handshake `state` request: only its failure is down (a repeated ready asks again). */
  let ask = 0;
  /** Retries since the client was last READY: the backoff's step. */
  let tries = 0;
  let destroyed = false;

  const set = (patch: Partial<SignpageClientSnapshot>) => {
    snap = { ...snap, ...patch };
    if (snap.status !== "connecting") {
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    }
    for (const f of listeners) f(snap);
  };

  const clearTimer = (t: Timer | null) => {
    if (t !== null) clearTimeout(t);
  };

  /** Where requests go and the only source a message counts from: the shell, or the current iframe's window. */
  const peer = () => shell ?? frame?.contentWindow ?? null;

  const settle = (id: string, outcome: SignpageOutcome) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimer(p.timer);
    p.resolve(outcome);
  };

  /** Every posted request ends as client_timeout: the page may have it, so it is never reported unsent. */
  const endPosted = () => {
    for (const id of [...pending.keys()]) settle(id, TIMEOUT);
  };

  /** The frame is gone or unusable: the state it sent is no longer fresh. */
  const leave = (status: SignpageClientStatus) => {
    clearTimer(handshakeTimer);
    handshakeTimer = null;
    clearTimer(loadTimer);
    loadTimer = null;
    endPosted();
    set({ status, stale: snap.state !== null || snap.stale });
  };

  const down = () => {
    if (destroyed || snap.status === "update") return;
    leave("down");
    if (retryMs > 0 && retryTimer === null) {
      const wait = Math.min(RETRY_FIRST_MS * 2 ** tries, retryMs);
      tries++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        mountFrame(true);
      }, wait);
    }
  };

  /** Back online, or the page shown again: while down, a fresh iframe now and the backoff from its start. */
  const wake = (ev: Event) => {
    if (destroyed || snap.status !== "down") return;
    if (ev.type === "visibilitychange" && (ev.target as Partial<Document> | null)?.visibilityState === "hidden") return;
    tries = 0;
    mountFrame(true);
  };

  const toUpdate = () => {
    clearTimer(retryTimer);
    retryTimer = null;
    leave("update");
  };

  /** No ready within SIGNPAGE_HANDSHAKE_MS from now: down. */
  const waitReady = () => {
    clearTimer(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (snap.status !== "ready") down();
    }, SIGNPAGE_HANDSHAKE_MS);
  };

  /**
   * A fresh iframe and its handshake (parent mode: a `state` request to the same shell at once, which answers at any
   * time; its ready comes only when it loads the frame, so a client made after that load or a slow load must not wait
   * for one); `quiet`: a retry of the client's own, which keeps the down state until READY.
   */
  const mountFrame = (quiet = false) => {
    if (destroyed || snap.status === "update") return;
    clearTimer(retryTimer);
    retryTimer = null;
    // an answer to the old frame can never pass the source check, so its requests end now, as client_timeout (parent
    // mode: they end the same way, so both modes answer alike, and a late answer is dropped by its id)
    endPosted();
    gen++;
    if (shell !== null) {
      if (!(quiet && snap.status === "down")) set({ status: "connecting", stale: snap.state !== null || snap.stale });
      return askState();
    }
    readySeen = false;
    clearTimer(loadTimer);
    loadTimer = null;
    frame?.remove();
    const f = host.document.createElement("iframe");
    for (const [k, v] of Object.entries(SIGNPAGE_IFRAME_ATTRIBUTES)) f.setAttribute(k, v);
    // set through the CSSOM, which a CSP with no 'unsafe-inline' style allows
    f.style.position = "absolute";
    f.style.width = "0";
    f.style.height = "0";
    f.style.border = "0";
    f.style.visibility = "hidden";
    f.addEventListener("error", () => f === frame && down());
    // the page posts its ready as it starts, before its load (the message can land just after the load event); a load
    // with no ready within 1 s is the browser's error page
    f.addEventListener("load", () => {
      if (f !== frame || readySeen || loadTimer !== null) return;
      loadTimer = setTimeout(() => {
        loadTimer = null;
        if (f === frame && !readySeen) down();
      }, LOAD_GRACE_MS);
    });
    f.src = opts.url;
    frame = f;
    waitReady();
    if (!(quiet && snap.status === "down")) set({ status: "connecting", stale: snap.state !== null || snap.stale });
    host.mount.appendChild(f);
  };

  /** Posts a built request to the current frame and waits for its answer, its timeout or the frame's end. */
  const post = <K extends SignpageKind>(msg: SignpageRequest<K>, timeoutMs: number | null, onTimeout: () => void): Promise<SignpageOutcome<K>> => {
    const win = peer();
    if (destroyed || !win) return Promise.resolve(DOWN);
    return new Promise<SignpageOutcome<K>>((resolve) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              if (!pending.has(msg.id)) return;
              settle(msg.id, TIMEOUT);
              onTimeout();
            }, timeoutMs);
      pending.set(msg.id, { kind: msg.type, resolve: resolve as (o: SignpageOutcome) => void, timer });
      win.postMessage(msg, origin);
    });
  };

  /** The kit version, named to the page before each handshake `state` request (messages.ts HelloMessage). */
  const hello = () => {
    const win = peer();
    if (destroyed || !win) return;
    const msg: HelloMessage = { v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION };
    win.postMessage(msg, origin);
  };

  const onReady = (msg: { release: string; api: number }) => {
    if (msg.api !== SIGNPAGE_CLIENT_API) return toUpdate();
    clearTimer(retryTimer);
    retryTimer = null;
    readySeen = true;
    clearTimer(loadTimer);
    loadTimer = null;
    set({ release: msg.release });
    if (snap.status === "ready") {
      // a ready again is a page that started again: it reads this client as kit-v1.4 until told
      hello();
      void client.request("state", {});
      return;
    }
    askState();
  };

  /**
   * READY is this frame's first `state` answer, within SIGNPAGE_HANDSHAKE_MS of its ready (parent mode: of the client's
   * start, a retry or a ready). Any of this frame's asks may bring READY; only the newest one's failure is down.
   */
  const askState = () => {
    clearTimer(handshakeTimer);
    handshakeTimer = null;
    const g = gen;
    const a = ++ask;
    hello();
    const msgState = signpageBuildRequest("state", {}, crypto.randomUUID());
    void post(msgState, SIGNPAGE_HANDSHAKE_MS, () => {}).then((o) => {
      if (g !== gen || destroyed || snap.status === "update") return;
      if (o.ok) {
        tries = 0;
        if (snap.status !== "ready") set({ status: "ready" });
      } else if (a === ask && snap.status !== "ready") down();
    });
  };

  const onMessage = (ev: MessageEvent) => {
    if (ev.origin !== origin) return void drops.origin++;
    const from = peer();
    if (from === null || ev.source !== from) return void drops.source++;
    const data: unknown = ev.data;
    if (!signpageIsPlainMessage(data)) return void drops.shape++;
    const m = data as Record<string, unknown>;
    if (Object.hasOwn(m, "ok")) {
      const p = typeof m.id === "string" ? pending.get(m.id) : undefined;
      if (!p) return void drops.id++;
      // a state's op this client cannot read is left out, never the whole state (card kit-frame-version)
      const result = signpageAnswerOkSchema(m) ? (p.kind === "state" ? signpageReadableOps(m.result) : m.result) : undefined;
      if (result !== undefined && SIGNPAGE_RESULT_SCHEMAS[p.kind](result)) {
        if (p.kind === "state") set({ state: result as SignpageState, stale: false });
        return settle(m.id as string, { ok: true, result: result as SignpageResults[SignpageKind] });
      }
      if (signpageAnswerErrorSchema(m)) return settle(m.id as string, { ok: false, error: m.error as { code: ErrorCode } });
      return void drops.shape++;
    }
    if (signpageReadySchema(m)) return onReady(m as { release: string; api: number });
    if (snap.status !== "ready") return void drops.shape++;
    if (m.type === "state" && Object.hasOwn(m, "state")) {
      const ev = { ...m, state: signpageReadableOps(m.state) };
      if (signpageStateEventSchema(ev)) return set({ state: ev.state as SignpageState, stale: false });
    }
    if (signpageProgressSchema(m)) {
      for (const f of progressListeners) f(m.id as string, m.stage as Stage);
      return;
    }
    if (signpageProgressRouteSchema(m)) {
      const { v: _v, type: _t, id, ...route } = m;
      for (const f of routeListeners) f(id as string, route as BuyRoute);
      return;
    }
    drops.shape++;
  };

  const onTimeout = (kind: SignpageKind) => {
    if ((OPEN_KINDS as readonly SignpageKind[]).includes(kind)) return down();
    if (kind === "state") return set({ stale: true });
    if (REASK_STATE.has(kind)) void client.request("state", {});
  };

  const client: SignpageClient = {
    snapshot: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    onProgress(fn) {
      progressListeners.add(fn);
      return () => void progressListeners.delete(fn);
    },
    onRoute(fn) {
      routeListeners.add(fn);
      return () => void routeListeners.delete(fn);
    },
    request(kind, params) {
      const id = crypto.randomUUID();
      const msg = signpageBuildRequest(kind, params, id);
      const outcome = (async () => {
        if (snap.status === "connecting" && !destroyed) await new Promise<void>((r) => waiters.push(r));
        // parent mode's update state: the shell still answers `reload` (it reloads the top window, shell and app)
        const reloadInUpdate = shell !== null && kind === "reload" && snap.status === "update";
        if (destroyed || (snap.status !== "ready" && !reloadInUpdate)) return DOWN;
        return post(msg, SIGNPAGE_TIMEOUT_MS[kind], () => onTimeout(kind));
      })();
      return { id, outcome };
    },
    retry() {
      tries = 0;
      mountFrame();
    },
    dropped: () => ({ ...drops }),
    destroy() {
      if (destroyed) return;
      clearTimer(retryTimer);
      retryTimer = null;
      leave("down");
      destroyed = true;
      host.window.removeEventListener("message", onMessage);
      host.window.removeEventListener("online", wake);
      host.window.removeEventListener("visibilitychange", wake);
      frame?.remove();
      frame = null;
      listeners.clear();
      progressListeners.clear();
      routeListeners.clear();
    },
  };

  host.window.addEventListener("message", onMessage);
  host.window.addEventListener("online", wake);
  host.window.addEventListener("visibilitychange", wake);
  mountFrame();
  return client;
}
