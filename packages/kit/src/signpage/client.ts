// The signing-page client (app.md §2.1 items 2-4, row A1.2, app.md:1435): the app's only way to SIGN_HOST. It mounts
// one hidden iframe of SIGN_HOST's release URL, waits for the page's `ready` handshake, and then sends the fifteen
// kinds of messages.ts and reads their answers. Every message from the page is dropped, with no change, unless its
// `origin` is SIGN_HOST's exactly, its `source` is this client's iframe's window, its shape passes the schema of what it
// claims to be (schema.ts), and an answer's id is one this client is waiting for. Each request has its timeout; the
// app never re-sends a kind on its own (APU-03, app.md:1328). With no handshake in 5 s, an iframe error, or an `api`
// this client does not speak, the client is "down": every request answers `signpage_down` without being sent, and a
// fresh iframe is tried every SIGNPAGE_RETRY_MS, so the down state clears with no reload when SIGN_HOST returns.

import { OPEN_KINDS } from "./messages.ts";
import type { ErrorCode, SignpageKind, SignpageParams, SignpageRequest, SignpageResults, SignpageState, Stage } from "./messages.ts";
import {
  SIGNPAGE_PARAM_SCHEMAS,
  SIGNPAGE_RESULT_SCHEMAS,
  signpageAnswerErrorSchema,
  signpageAnswerOkSchema,
  signpageIsKind,
  signpageIsPlainMessage,
  signpageProgressSchema,
  signpageReadySchema,
  signpageStateEventSchema,
} from "./schema.ts";

/** The `api` of messages.ts, the only one this client speaks. */
export const SIGNPAGE_CLIENT_API = 1;
/** No `ready` in this long and the client is down (BAR-09, app.md:1107). */
export const SIGNPAGE_HANDSHAKE_MS = 5_000;
/** While down, a fresh iframe this often. */
export const SIGNPAGE_RETRY_MS = 10_000;

/** How long the client waits for each kind's answer (app.md §2.1 item 3's table). */
export const SIGNPAGE_TIMEOUT_MS = {
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
  restore: 10_000,
  state: 5_000,
} as const satisfies Record<SignpageKind, number>;

/** After one of these times out, the client asks `state` again (a new `state` request); the kind itself is never re-sent. */
const REASK_STATE: ReadonlySet<SignpageKind> = new Set(["deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return"]);

/** The hidden iframe's attributes (app.md §2.1 item 2; AX-06, app.md:1386). */
export const SIGNPAGE_IFRAME_ATTRIBUTES = {
  sandbox: "allow-scripts allow-same-origin",
  allow: "",
  referrerpolicy: "no-referrer",
  "aria-hidden": "true",
  tabindex: "-1",
  width: "0",
  height: "0",
} as const;

/** The codes the client itself answers with, never the page. */
export const SIGNPAGE_CLIENT_CODES = { timeout: "client_timeout", down: "signpage_down" } as const;

export type SignpageClientStatus = "connecting" | "ready" | "down";
export type SignpageDropReason = "origin" | "source" | "shape" | "id";

export interface SignpageClientSnapshot {
  status: SignpageClientStatus;
  /** The page's release tag from its handshake. */
  release: string | null;
  /** The last state the page sent. */
  state: SignpageState | null;
  /** True when the last `state` request timed out: `state` is the one before. */
  stale: boolean;
}

export type SignpageOutcome<K extends SignpageKind = SignpageKind> =
  | { ok: true; result: SignpageResults[K] }
  | { ok: false; error: { code: ErrorCode } };

/** The parts of the browser the client uses; a test passes its own. */
export interface SignpageClientHost {
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<Document, "createElement">;
  /** Where the iframe goes. */
  mount: Pick<HTMLElement, "appendChild">;
}

export interface SignpageClientOptions {
  /** SIGN_HOST's release URL, for example "https://sign.confidential.unrealized.trade/": https, no query, no fragment. */
  url: string;
  host: SignpageClientHost;
  /** 0 turns the retry off. */
  retryMs?: number;
}

export interface SignpageClient {
  snapshot(): SignpageClientSnapshot;
  /** Called on every change of the snapshot; returns the unsubscribe. */
  subscribe(fn: (s: SignpageClientSnapshot) => void): () => void;
  /** Called on every `progress` event; returns the unsubscribe. */
  onProgress(fn: (id: string, stage: Stage) => void): () => void;
  /** Sends one request. Throws when its params are not exactly its kind's. */
  request<K extends SignpageKind>(kind: K, params: SignpageParams[K]): Promise<SignpageOutcome<K>>;
  /** A fresh iframe and a new handshake now. */
  retry(): void;
  /** Messages dropped so far, by why. */
  dropped(): Record<SignpageDropReason, number>;
  destroy(): void;
}

/** The request envelope of a kind, built from exactly its allowed params. Throws on an unknown kind or a bad param. */
export function signpageBuildRequest<K extends SignpageKind>(kind: K, params: SignpageParams[K], id: string): SignpageRequest<K> {
  if (!signpageIsKind(kind)) throw new TypeError(`signpage: no such kind ${String(kind)}`);
  if (!SIGNPAGE_PARAM_SCHEMAS[kind](params)) throw new TypeError(`signpage: params are not exactly ${kind}'s`);
  return { ...params, v: 1, id, type: kind } as SignpageRequest<K>;
}

/** SIGN_HOST's origin from its release URL; throws on anything but https with no query, fragment or credentials. */
export function signpageOrigin(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password || u.href !== url) {
    throw new TypeError(`signpage: ${url} is not an https release URL with no query`);
  }
  return u.origin;
}

interface Pending {
  kind: SignpageKind;
  resolve: (o: SignpageOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createSignpageClient(opts: SignpageClientOptions): SignpageClient {
  const origin = signpageOrigin(opts.url);
  const { host } = opts;
  const retryMs = opts.retryMs ?? SIGNPAGE_RETRY_MS;

  let snap: SignpageClientSnapshot = { status: "connecting", release: null, state: null, stale: false };
  const listeners = new Set<(s: SignpageClientSnapshot) => void>();
  const progressListeners = new Set<(id: string, stage: Stage) => void>();
  const pending = new Map<string, Pending>();
  const drops: Record<SignpageDropReason, number> = { origin: 0, source: 0, shape: 0, id: 0 };
  let waiters: (() => void)[] = [];
  let frame: HTMLIFrameElement | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
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

  const clearTimer = (t: ReturnType<typeof setTimeout> | null) => {
    if (t !== null) clearTimeout(t);
  };

  const settle = (id: string, outcome: SignpageOutcome) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimer(p.timer);
    p.resolve(outcome);
  };

  const down = () => {
    if (destroyed) return;
    clearTimer(handshakeTimer);
    handshakeTimer = null;
    for (const id of [...pending.keys()]) settle(id, { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } });
    if (snap.status !== "down") set({ status: "down" });
    if (retryMs > 0 && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        mountFrame();
      }, retryMs);
    }
  };

  const mountFrame = () => {
    if (destroyed) return;
    clearTimer(retryTimer);
    retryTimer = null;
    // an answer to the old frame's requests can never pass the source check, so they end now
    for (const id of [...pending.keys()]) settle(id, { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } });
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
    f.src = opts.url;
    frame = f;
    clearTimer(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (snap.status !== "ready") down();
    }, SIGNPAGE_HANDSHAKE_MS);
    if (snap.status !== "connecting") set({ status: "connecting" });
    host.mount.appendChild(f);
  };

  const onReady = (msg: { release: string; api: number }) => {
    if (msg.api !== SIGNPAGE_CLIENT_API) return down();
    clearTimer(handshakeTimer);
    handshakeTimer = null;
    clearTimer(retryTimer);
    retryTimer = null;
    set({ status: "ready", release: msg.release });
    void client.request("state", {});
  };

  const onMessage = (ev: MessageEvent) => {
    if (ev.origin !== origin) return void drops.origin++;
    if (frame === null || ev.source === null || ev.source !== frame.contentWindow) return void drops.source++;
    const data: unknown = ev.data;
    if (!signpageIsPlainMessage(data)) return void drops.shape++;
    const m = data as Record<string, unknown>;
    if (Object.hasOwn(m, "ok")) {
      const p = typeof m.id === "string" ? pending.get(m.id) : undefined;
      if (!p) return void drops.id++;
      if (signpageAnswerOkSchema(m) && SIGNPAGE_RESULT_SCHEMAS[p.kind](m.result)) {
        if (p.kind === "state") set({ state: m.result as SignpageState, stale: false });
        return settle(m.id as string, { ok: true, result: m.result as SignpageResults[SignpageKind] });
      }
      if (signpageAnswerErrorSchema(m)) return settle(m.id as string, { ok: false, error: m.error as { code: ErrorCode } });
      return void drops.shape++;
    }
    if (signpageReadySchema(m)) return onReady(m as { release: string; api: number });
    if (snap.status !== "ready") return void drops.shape++;
    if (signpageStateEventSchema(m)) return set({ state: m.state as SignpageState, stale: false });
    if (signpageProgressSchema(m)) {
      for (const f of progressListeners) f(m.id as string, m.stage as Stage);
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
    async request(kind, params) {
      const id = crypto.randomUUID();
      const msg = signpageBuildRequest(kind, params, id);
      if (snap.status === "connecting") await new Promise<void>((r) => waiters.push(r));
      const win = frame?.contentWindow;
      if (destroyed || snap.status !== "ready" || !win) return { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } };
      return new Promise<SignpageOutcome<typeof kind>>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve({ ok: false, error: { code: SIGNPAGE_CLIENT_CODES.timeout } });
          onTimeout(kind);
        }, SIGNPAGE_TIMEOUT_MS[kind]);
        pending.set(id, { kind, resolve: resolve as (o: SignpageOutcome) => void, timer });
        win.postMessage(msg, origin);
      });
    },
    retry: () => mountFrame(),
    dropped: () => ({ ...drops }),
    destroy() {
      if (destroyed) return;
      down();
      destroyed = true;
      clearTimer(retryTimer);
      host.window.removeEventListener("message", onMessage);
      frame?.remove();
      frame = null;
      listeners.clear();
      progressListeners.clear();
    },
  };

  host.window.addEventListener("message", onMessage);
  mountFrame();
  return client;
}
