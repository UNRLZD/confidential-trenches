// The signing page's postMessage API, SIGN_HOST's end (wallet.md §7 item 4, W:1132-1135; S-C1, W:1589-1590; row W4.5,
// W:1118; the shapes are packages/kit/src/signpage/messages.ts, api 1). APP_HOST frames this page as a hidden iframe.
// The page listens, then posts `ready` to its parent with targetOrigin APP_ORIGIN, so no other embedder hears it. A
// message is read only when its origin is APP_ORIGIN exactly and its source is the window that framed this page; any
// other is dropped with no answer and no change. So is, before any field is read, a request whose JSON is over
// SIGNPAGE_MAX_REQUEST_BYTES in UTF-8, or not made of plain objects, arrays with index keys only, strings, finite
// numbers, booleans and null, or holding a `__proto__`, `constructor` or `prototype` key at any depth (A:116-117); and
// anything but a plain object with an id that is a crypto.randomUUID(): no answer can be addressed to it. Every other
// message gets one answer, sent only to the parent with targetOrigin APP_ORIGIN: `state` with exactly {v: 1, id, type}
// is answered with the state; every other kind, a kind with no row, a v other than 1 and a field its row does not allow
// are refused as "not_allowed" (W:917; app.md §2.1 A2-A4, A:116-117), each signing kind until its own payload rules
// land (W:886-917). No field of a refused message is read, so a return_key such as "constructor" is never looked up.
// A repeated request gets its first answer again, never a second run; a repeated id with another body is refused
// "id_reused" (startApi). Answers carry states only, never a key, the words or a note secret (W §2.9 row 11).
// The state is the host's: in the frame, src/state.ts reads it from the wallet store (card signpage-frame-state). On
// every change the host reports, the page reads the state again and posts a `state` event {v: 1, type, state} when it
// differs from the last state it sent; none before the first `state` answer, which carries a fresh read itself.
//
// src/main.ts starts it when the page runs inside APP_HOST's frame; scripts/build-app.mjs bundles both into public/app.js.

import type { ReadyEvent, SignpageAnswer, SignpageKind, SignpageState, StateEvent } from "../../kit/src/signpage/messages.ts";

/** APP_HOST: the one origin this page reads from and posts to. */
export const APP_ORIGIN = "https://confidential.unrealized.trade";
/** This page's release tag; a tagged release sets it (W §2.7 item 3). */
export const RELEASE = "unreleased";
/** The api of messages.ts this page speaks. */
export const API = 1;
/**
 * The largest request read: UTF-8 bytes of its JSON (A:116-117). Equal to the kit's SIGNPAGE_MAX_REQUEST_BYTES
 * (packages/kit/src/signpage/schema.ts, card app-signpage-client); taken from there once that card merges.
 */
export const SIGNPAGE_MAX_REQUEST_BYTES = 65_536;
/** The deepest request read. */
const MAX_DEPTH = 12;
/** Keys refused at any depth, as the kit's client refuses them. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** How many answered ids are kept for a retry (never `state`'s); the oldest goes first. */
export const REMEMBERED_IDS = 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE: SignpageKind = "state";

/** A window this page posts to. */
export interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** What a message event carries that this page reads. */
export interface IncomingMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface ApiHost {
  /** The window that framed this page: the only source read and the only target posted to. */
  parent: PostTarget;
  /**
   * Adds the page's message listener. `data` must be what the browser's structured clone made (MessageEvent.data):
   * plain values that read the same every time. A Proxy or getter whose value changes between reads would pass the
   * checks and then be read as something else.
   */
  listen(fn: (e: IncomingMessage) => void): void;
  /** The state now, read fresh; it must not throw (src/state.ts answers signed out when it cannot read). */
  state(): SignpageState | Promise<SignpageState>;
  /** Registers `fn`, called on every change of the state's source (another tab's sign-in, sign-out, words saved, op). */
  watch?(fn: () => void): void;
}

/** The state of a page that holds no seed yet. */
export function signedOutState(): SignpageState {
  return {
    release: RELEASE,
    api: API,
    signed_in: false,
    code_saved: false,
    vault_balance: "0",
    wallets: [],
    positions: [],
    orders: [],
    held: [],
    ops: [],
  };
}

/**
 * The request's JSON as UTF-8 when `v` is plain data (objects with Object or null prototype and no forbidden key,
 * arrays with index keys only) within the cap; null otherwise. The walk is a pre-filter: every value, key and string
 * code unit spends at least one byte of the UTF-8 JSON, so it stops once that budget passes the cap, and a structure
 * that shares one object many times cannot make it, or the JSON, run long. The cap itself is the UTF-8 length.
 */
function plainRequestBytes(v: unknown): Uint8Array<ArrayBuffer> | null {
  let budget = SIGNPAGE_MAX_REQUEST_BYTES;
  const walk = (x: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || --budget < 0) return false;
    if (typeof x === "string") return (budget -= x.length) >= 0;
    if (x === null || typeof x === "boolean") return true;
    if (typeof x === "number") return Number.isFinite(x);
    if (typeof x !== "object") return false;
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype || x.length > budget) return false;
      const keys = Reflect.ownKeys(x);
      if (keys.length !== x.length + 1 || keys.some((k, i) => (i < x.length ? k !== String(i) : k !== "length"))) return false;
      return x.every((e) => walk(e, depth + 1));
    }
    const proto: unknown = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const k of Reflect.ownKeys(x)) {
      if (typeof k !== "string" || FORBIDDEN_KEYS.has(k) || (budget -= k.length) < 0) return false;
      if (!walk((x as Record<string, unknown>)[k], depth + 1)) return false;
    }
    return true;
  };
  if (!walk(v, 0)) return null;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(v));
    return bytes.length <= SIGNPAGE_MAX_REQUEST_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** The envelope's fields when `data` is a plain object with a UUID id; null when no answer can go to it. */
function envelope(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const proto: unknown = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return null;
  const m = data as Record<string, unknown>;
  if (!Object.hasOwn(m, "id") || typeof m.id !== "string" || !UUID.test(m.id)) return null;
  return m;
}

/** True when `m` is a `state` request with v 1 and no field beyond v, id and type. */
function isStateRequest(m: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(m);
  return keys.length === 3 && Object.hasOwn(m, "v") && m.v === 1 && Object.hasOwn(m, "type") && m.type === STATE;
}

/**
 * Starts the API: listens, then posts `ready` to the parent. Messages are handled one at a time, in the order they came
 * (the SHA-256 is async). An answered id is kept with the SHA-256 of its request's JSON: the same request again gets
 * its first answer, never a second run; the same id with another body is refused "id_reused" (an ErrorCode string,
 * messages.ts), `state` included. `state` is read fresh each time and never kept, so polling it pushes out no other
 * id. A change the host reports reads the state in the same queue and posts a `state` event when it differs from the
 * last state sent (answer or event), so an event never overtakes a newer answer. A kind that moves money writes its id to the wallet store before it signs (wallet.md §7 item 4), with that card.
 */
export function startApi(host: ApiHost): { idle(): Promise<void> } {
  const answered = new Map<string, { sha: string; answer: SignpageAnswer }>();
  const post = (msg: SignpageAnswer | ReadyEvent | StateEvent) => host.parent.postMessage(msg, APP_ORIGIN);
  // the JSON of the last state sent; null until the first `state` answer
  let sent: string | null = null;
  const read = async (): Promise<SignpageState> => {
    const s = await host.state();
    sent = JSON.stringify(s);
    return s;
  };

  const handle = async (data: unknown): Promise<void> => {
    const bytes = plainRequestBytes(data);
    if (!bytes) return;
    const m = envelope(data);
    if (!m) return;
    const id = m.id as string;
    const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
    const first = answered.get(id);
    if (first) return post(first.sha === sha ? first.answer : { v: 1, id, ok: false, error: { code: "id_reused" } });
    if (isStateRequest(m)) return post({ v: 1, id, ok: true, result: await read() });
    const answer: SignpageAnswer = { v: 1, id, ok: false, error: { code: "not_allowed" } };
    answered.set(id, { sha, answer });
    if (answered.size > REMEMBERED_IDS) answered.delete(answered.keys().next().value as string);
    post(answer);
  };

  let queue: Promise<void> = Promise.resolve();
  // many changes while one read waits make one more read, not one each
  let pushQueued = false;
  host.watch?.(() => {
    if (pushQueued) return;
    pushQueued = true;
    queue = queue
      .then(async () => {
        pushQueued = false;
        if (sent === null) return;
        const before = sent;
        const s = await read();
        if (sent !== before) post({ v: 1, type: "state", state: s });
      })
      .catch(() => {});
  });
  host.listen((e) => {
    if (e.origin !== APP_ORIGIN || e.source !== host.parent) return;
    const data = e.data;
    queue = queue.then(() => handle(data)).catch(() => {});
  });
  post({ v: 1, type: "ready", release: RELEASE, api: API });
  return { idle: () => queue };
}
