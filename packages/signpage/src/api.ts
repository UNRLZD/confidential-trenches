// The signing page's postMessage API, SIGN_HOST's end (wallet.md §7 item 4, W:1132-1135; S-C1, W:1589-1590; row W4.5,
// W:1118; the shapes are packages/kit/src/signpage/messages.ts, api 1). APP_HOST frames this page as a hidden iframe.
// The page listens, then posts `ready` to its parent with targetOrigin APP_ORIGIN, so no other embedder hears it. A
// message is read only when its origin is APP_ORIGIN exactly and its source is the window that framed this page; any
// other is dropped with no answer and no change. So is a request over SIGNPAGE_MAX_MESSAGE_BYTES of JSON or not made of
// plain objects, arrays with index keys only, strings, finite numbers, booleans and null (A:116-117), checked before
// any field is read, and anything but a plain object with an id that is a crypto.randomUUID(): no answer can be
// addressed to it. Every other message gets one answer, sent only to the parent with
// targetOrigin APP_ORIGIN: `state` with exactly {v: 1, id, type} is answered with the state; every other kind, a kind
// with no row, a v other than 1 and a field its row does not allow are refused as "not_allowed" (W:917; app.md
// §2.1 A2-A4, A:116-117), each signing kind until its own payload rules land (W:886-917). No field of a refused message
// is read, so a return_key such as "constructor" or "__proto__" is never looked up anywhere. A repeated id gets its first
// answer again, never a second run (messages.ts). Answers carry states only, never a key, the words or a note secret
// (W §2.9 row 11).
//
// src/main.ts starts it when the page runs inside APP_HOST's frame; scripts/build-app.mjs bundles both into public/app.js.

import type { ReadyEvent, SignpageAnswer, SignpageKind, SignpageState } from "../../kit/src/signpage/messages.ts";

/** APP_HOST: the one origin this page reads from and posts to. */
export const APP_ORIGIN = "https://confidential.unrealized.trade";
/** This page's release tag; a tagged release sets it (W §2.7 item 3). */
export const RELEASE = "unreleased";
/** The api of messages.ts this page speaks. */
export const API = 1;
/** The largest request read, in UTF-16 code units of its JSON (A:116-117; the kit's SIGNPAGE_MAX_MESSAGE_BYTES). */
export const SIGNPAGE_MAX_MESSAGE_BYTES = 65_536;
/** The deepest request read. */
const MAX_DEPTH = 12;
/** How many answered ids are kept for a retry; the oldest goes first. */
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
  /** Adds the page's message listener. */
  listen(fn: (e: IncomingMessage) => void): void;
  /** The state now. */
  state(): SignpageState;
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
 * True when `v` is plain data (objects with Object or null prototype, arrays with index keys only) within the caps.
 * Every value, key and string character spends at least one character of its JSON, so the walk stops once that budget
 * passes the cap: a structure that shares one object many times cannot make it, or the JSON size check, run long.
 */
function isPlainRequest(v: unknown): boolean {
  let budget = SIGNPAGE_MAX_MESSAGE_BYTES;
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
      if (typeof k !== "string" || (budget -= k.length) < 0 || !walk((x as Record<string, unknown>)[k], depth + 1)) return false;
    }
    return true;
  };
  if (!walk(v, 0)) return false;
  try {
    return JSON.stringify(v).length <= SIGNPAGE_MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

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

/** Starts the API: listens, then posts `ready` to the parent. */
export function startApi(host: ApiHost): void {
  const answered = new Map<string, SignpageAnswer>();
  const post = (msg: SignpageAnswer | ReadyEvent) => host.parent.postMessage(msg, APP_ORIGIN);

  host.listen((e) => {
    if (e.origin !== APP_ORIGIN || e.source !== host.parent) return;
    if (!isPlainRequest(e.data)) return;
    const m = envelope(e.data);
    if (!m) return;
    const id = m.id as string;
    const first = answered.get(id);
    if (first) return post(first);
    const answer: SignpageAnswer = isStateRequest(m)
      ? { v: 1, id, ok: true, result: host.state() }
      : { v: 1, id, ok: false, error: { code: "not_allowed" } };
    answered.set(id, answer);
    if (answered.size > REMEMBERED_IDS) answered.delete(answered.keys().next().value as string);
    post(answer);
  });
  post({ v: 1, type: "ready", release: RELEASE, api: API });
}
