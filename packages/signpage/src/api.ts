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
// A kind the host answers may refuse with its own code (deposit.quote, src/deposit-wire.ts).
// A repeated request gets its first answer again, never a second run, but for a "busy" or "down" refusal (RETRY_CODES),
// which is not kept, so a retry runs again; a repeated id with another body is refused "id_reused" (startApi). Answers carry states only, never a key, the words or a note secret (W §2.9 row 11).
// The state is the host's: in the frame, src/state.ts reads it from the wallet store (card signpage-frame-state). On
// every change the host reports, the page reads the state again and posts a `state` event {v: 1, type, state} when it
// differs from the last state it sent; none before the first `state` answer, which carries a fresh read itself.
// Every message it posts is shaped for the app's kit version (card kit-frame-version, src/kit-version.ts): a hello
// {v: 1, type: "hello", kit} names it, read in the queue like a request and answered with nothing; until one comes, and
// again from each `ready`, the app is read as kit-v1.4.
// closed(id) posts the closed notice {v: 1, type: "closed", id} (card signing-layer-says-when-it-closes; the shell's,
// src/shell.ts, once an open's layer has closed): only to an app whose hello named the kit's own version or above, the
// one level that reads it, through the same one post as every other message, at once (never behind the queue, whose
// head may wait seconds on a helper).
//
// src/main.ts starts it when the page runs inside APP_HOST's frame; scripts/build-app.mjs bundles both into public/app.js.

import type { BuyRoute, ClosedEvent, ErrorCode, ProgressEvent, ProgressRouteEvent, ReadyEvent, SignpageAnswer, SignpageKind, SignpageResults, SignpageState, Stage, StateEvent } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_PARAM_SCHEMAS, signpageProgressRouteSchema } from "../../kit/src/signpage/schema.ts";
import { SIGNPAGE_TIMEOUT_MS } from "../../kit/src/signpage/client.ts";
import { KIT_DEFAULT, helloKit, kitLevel, resultFor, routeFor, stageFor, stateFor, type KitLevel } from "./kit-version.ts";

/** APP_HOST: the one origin this page reads from and posts to. */
export const APP_ORIGIN = "https://ct-app.unrealized.trade";
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

/**
 * Refusals that say "not now", never "no": a rate-limited or silent helper. They are not kept for the id, so the same
 * request again runs again (card signpage-deposit-quote-wire); every other answer is kept and given again.
 */
export const RETRY_CODES: ReadonlySet<ErrorCode> = new Set(["busy", "down"]);
/** The trade kinds, answered by running (Running): their answer may come past the kit client's window for them (10 s,
 *  packages/kit/src/signpage/client.ts SIGNPAGE_TIMEOUT_MS), which the client drops, and the app then ends the trade on
 *  its progress stages alone (apps/terminal/src/screens/trade/model.ts progress). So each one's end also goes out as a
 *  progress stage after its answer: a refusal as "refused" (but id_reused: that id runs elsewhere), a result's end stage
 *  as itself; never twice (card signpage-error-after-timeout). */
export const ENDS_AS_PROGRESS: ReadonlySet<SignpageKind> = new Set(["buy", "pool.buy", "pool.sell", "pool.deposit"]);
/** The stages that end a trade in the app (model.ts progress, route.ts fromStage). */
const END_STAGES: ReadonlySet<Stage> = new Set(["filled", "part_filled", "not_landed", "refused"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE: SignpageKind = "state";
/** A state read this long, from its request's arrival, may answer past the app's wait (the kit's SIGNPAGE_TIMEOUT_MS.state,
 *  less a second for the request's trip and the page's queue): named in the console and posted as a state event too. */
export const STATE_SLOW_MS = SIGNPAGE_TIMEOUT_MS.state - 1_000;

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
  /**
   * The app's window: the only source read and the only target posted to. In a frame, the window that framed this page;
   * in the shell (src/shell.ts), the framed APP_HOST's window (its iframe's contentWindow, the same object across the
   * frame's loads).
   */
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
  /** The clock a state read is timed on, in ms (tests only; Date.now otherwise). */
  now?(): number;
  /**
   * The shell's (src/shell.ts): no `ready` at start, only the caller's ready() on each load of the frame. At start the
   * frame holds no APP_HOST document yet, and a message posted then can still reach the one that comes (the target
   * origin is checked on delivery), which would be a second ready for one load.
   */
  readyOnLoad?: boolean;
  /**
   * Kinds the host answers itself (the shell's signin.open, nav and reload). A request reaches its handler only when its
   * params are exactly what the kit's schema for that kind allows (packages/kit/src/signpage/schema.ts); the handler
   * returns the result, or null to refuse not_allowed, or a HostRefusal to refuse with its own code (deposit.quote's
   * above_max, busy, down, quote_check_failed), or a Deferred when it must wait first (src/main.ts: an open kind waits
   * out a store read in flight; deposit.quote waits for the helper); the queue holds every later message until it is
   * answered, so answers keep their order. `then` runs once the answer is posted (the shell removes its frame after
   * answering signin.open, so the answer must go first). A Running answer (a trade) is answered once its wait settles
   * too, but the queue does not wait for it: a trade's reads and signatures never hold `state`, nav or an open kind.
   * `ctx` gives the request's id and `progress`, which posts a `progress` event {v: 1, type, id, stage} for it in the
   * queue, held until the id's answer is posted, so one never overtakes the answer.
   */
  kinds?: { [K in SignpageKind]?: (params: Record<string, unknown>, ctx: KindContext) => HostAnswer<K> | HostRefusal | Deferred<K> | Running<K> | null };
}

/** What a host-answered kind knows of its request: its id, and the poster of its `progress` events. */
export interface KindContext {
  id: string;
  /** The SHA-256 (hex) of the request's JSON: a kind that keeps its id past a reload keeps it too (wallet.md §7 item 4). */
  sha: string;
  progress(stage: Stage): void;
  /** Posts one route event (messages.ts BuyRoute) for the id, queued in order with the id's stage events once they are
   *  posted; not held for the answer, which is posted on its own, so a route event may follow it (card
   *  signpage-buy-route-events). One the kit's client would refuse is not posted. */
  route?(r: BuyRoute): void;
}

/**
 * A kind answered once `after` settles, by `answer()` then. Not a promise of the answer: a HostAnswer has a `then`, so
 * a promise resolved with one would take it for a thenable and never settle.
 */
export interface Deferred<K extends SignpageKind> {
  after: Promise<unknown>;
  answer(): HostAnswer<K> | HostRefusal | null;
}

/** A host-answered kind's refusal with its own code; RETRY_CODES are not kept for the id. */
export interface HostRefusal {
  error: ErrorCode;
  /** The fixed word naming the rule that refused (refusal-rule.ts), for the page's own record: give posts `error` alone. */
  rule?: string;
}

/**
 * A kind that runs long (a trade): answered once `after` settles, by `answer()` then, with no other message waiting for
 * it. While it runs, the same request again gets no second run and no answer of its own (its one answer is on its way to
 * the id); the same id with another body is refused "id_reused".
 */
export interface Running<K extends SignpageKind> extends Deferred<K> {
  running: true;
}

/** A host-answered kind's result, or its refusal with an ErrorCode of messages.ts, and what runs once it is posted. */
export type HostAnswer<K extends SignpageKind> =
  | { result: SignpageResults[K]; then?: () => void }
  | { error: ErrorCode; then?: () => void };

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

/** The host's own answer to `m`, when the host answers its kind and its params are exactly the kit's schema's. */
function hostAnswer(host: ApiHost, m: Record<string, unknown>, ctx: KindContext): HostAnswer<SignpageKind> | HostRefusal | Deferred<SignpageKind> | Running<SignpageKind> | null {
  if (!Object.hasOwn(m, "v") || m.v !== 1 || !Object.hasOwn(m, "type") || typeof m.type !== "string") return null;
  const kind = m.type as SignpageKind;
  const run = host.kinds && Object.hasOwn(host.kinds, kind) ? host.kinds[kind] : undefined;
  if (!run || !Object.hasOwn(SIGNPAGE_PARAM_SCHEMAS, kind)) return null;
  const params: Record<string, unknown> = {};
  for (const k of Object.keys(m)) if (k !== "v" && k !== "id" && k !== "type") params[k] = m[k];
  if (!SIGNPAGE_PARAM_SCHEMAS[kind](params)) return null;
  return (run as (p: Record<string, unknown>, c: KindContext) => HostAnswer<SignpageKind> | HostRefusal | Deferred<SignpageKind> | Running<SignpageKind> | null)(params, ctx);
}

/**
 * Starts the API: listens, then posts `ready` to the parent. Messages are handled one at a time, in the order they came
 * (the SHA-256 is async). An answered id is kept with the SHA-256 of its request's JSON: the same request again gets
 * its first answer, never a second run; the same id with another body is refused "id_reused" (an ErrorCode string,
 * messages.ts), `state` included. `state` is read fresh each time and never kept, so polling it pushes out no other
 * id. A change the host reports reads the state in the same queue and posts a `state` event when it differs from the
 * last state sent (answer or event), so an event never overtakes a newer answer. A kind that moves money writes its id
 * to the wallet store before it signs (wallet.md §7 item 4), with that card.
 */
export function startApi(host: ApiHost): { idle(): Promise<void>; ready(): void; closed(id: string): void } {
  // answer null: a Running kind's id whose answer is not posted yet; `held` keeps its progress events until it is
  const answered = new Map<string, { sha: string; kind: SignpageKind; answer: SignpageAnswer | null }>();
  const held = new Map<string, Stage[]>();
  // the app's kit version, as a hello named it (src/kit-version.ts)
  let level: KitLevel = KIT_DEFAULT;
  // a hello read since the last ready: `level` names the frame's own document, never the one a ready said went (its reset
  // waits in the queue; review P3-2 of card signing-layer-says-when-it-closes). Cleared by the ready at once; a hello the
  // old document sent before it, read after, sets it again, but the reset queued behind that hello sets `level` back to
  // kit-v1.4 in the same run of the queue, before any timer's closed() can read the two
  let hello = false;
  // the message as the app's kit reads it, or null when it reads none of it; `kind`: an answer's request kind
  const shaped = (msg: SignpageAnswer | ReadyEvent | StateEvent | ProgressEvent | ProgressRouteEvent | ClosedEvent, kind?: SignpageKind): unknown => {
    if ("ok" in msg) return msg.ok && kind !== undefined ? { ...msg, result: resultFor(level, kind, msg.result) } : msg;
    if (msg.type === "state") return { ...msg, state: stateFor(level, msg.state) };
    if (msg.type !== "progress") return msg;
    if (!("stage" in msg)) return level !== "1.4" ? routeFor(level, msg) : null;
    const stage = stageFor(level, msg.stage);
    return stage === null ? null : stage === msg.stage ? msg : { ...msg, stage };
  };
  const post = (msg: SignpageAnswer | ReadyEvent | StateEvent | ProgressEvent | ProgressRouteEvent | ClosedEvent, kind?: SignpageKind) => {
    const out = shaped(msg, kind);
    if (out !== null) host.parent.postMessage(out, APP_ORIGIN);
  };
  const clock = host.now ?? Date.now;
  // the JSON of the last state sent, as the app's kit reads it; null until the first `state` answer
  let sent: string | null = null;
  const read = async (): Promise<SignpageState> => {
    const s = await host.state();
    sent = JSON.stringify(stateFor(level, s));
    return s;
  };

  const handle = async (data: unknown, at: number): Promise<void> => {
    const bytes = plainRequestBytes(data);
    if (!bytes) return;
    const kit = helloKit(data);
    if (kit !== null) return void ((level = kitLevel(kit)), (hello = true));
    const m = envelope(data);
    if (!m) return;
    const id = m.id as string;
    const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
    const first = answered.get(id);
    if (first && first.sha !== sha) return post({ v: 1, id, ok: false, error: { code: "id_reused" } });
    if (first) return first.answer ? post(first.answer, first.kind) : undefined;
    if (isStateRequest(m)) {
      const s = await read();
      post({ v: 1, id, ok: true, result: s }, STATE);
      // card portfolio-counts-every-note: the app's kit waits SIGNPAGE_TIMEOUT_MS.state for this answer and drops one
      // that comes later, keeping its last state, while `sent` above already holds this one, so no change after it
      // would post it: an answer this slow (timed from the request's arrival, so a second short of the app's wait
      // counts its trip) goes as a state event too, which has no timeout
      const took = clock() - at;
      if (took >= STATE_SLOW_MS) {
        console.warn(`state read took ${took} ms (the app waits ${SIGNPAGE_TIMEOUT_MS.state} ms for its answer): sent as a state event too`);
        post({ v: 1, type: "state", state: s });
      }
      return;
    }
    // a Deferred is answered once its wait settles, either way; a plain answer is used as it is, in this task
    const progress = (stage: Stage): void => {
      const waiting = held.get(id);
      if (waiting) return void waiting.push(stage);
      queue = queue.then(() => post({ v: 1, type: "progress", id, stage })).catch(() => {});
    };
    // the event names each field itself from the object's own keys, so nothing but the route's own fields is ever
    // posted, and only an event the kit's client takes (signpageProgressRouteSchema): anything else is not told
    const route = (r: BuyRoute): void => {
      const own = (k: string): boolean => Object.hasOwn(r, k);
      const f: BuyRoute | null = own("wallet") ? { wallet: (r as { wallet: string }).wallet } : own("venue") ? { venue: (r as { venue: string }).venue, pool: (r as { pool: string }).pool } : own("out") ? { out: (r as { out: string }).out } : own("tx") ? { tx: (r as { tx: string }).tx } : own("move") ? { move: (r as { move: "cash" }).move, ...(own("op") ? { op: (r as { op: string }).op } : {}) } : null;
      const msg: ProgressRouteEvent | null = f && { v: 1, type: "progress", id, ...f };
      if (msg === null || !signpageProgressRouteSchema(msg)) return;
      queue = queue.then(() => post(msg)).catch(() => {});
    };
    // a progress event before the id's answer waits for it (give posts it after)
    held.set(id, []);
    const kind = m.type as SignpageKind;
    const got = hostAnswer(host, m, { id, sha, progress, route });
    if (got && "running" in got) {
      answered.set(id, { sha, kind, answer: null });
      const ends = ENDS_AS_PROGRESS.has(kind);
      void got.after.catch(() => {}).then(() => give(kind, id, sha, got.answer(), progress, ends));
      return;
    }
    let own: HostAnswer<SignpageKind> | HostRefusal | null;
    if (got && "after" in got) {
      await got.after.catch(() => {});
      own = got.answer();
    } else own = got;
    give(kind, id, sha, own, progress);
  };
  // posts a host kind's answer (null: not_allowed), keeps it for a retry, then the id's progress events held for it,
  // then, for a trade kind (`ends`), its end as a progress stage unless one of those was it
  const give = (kind: SignpageKind, id: string, sha: string, own: HostAnswer<SignpageKind> | HostRefusal | null, progress: (stage: Stage) => void, ends = false): void => {
    const ok = own !== null && "result" in own ? own : null;
    const code: ErrorCode = own !== null && "error" in own && typeof own.error === "string" ? own.error : "not_allowed";
    const answer: SignpageAnswer = ok ? { v: 1, id, ok: true, result: ok.result } : { v: 1, id, ok: false, error: { code } };
    answered.delete(id);
    // a "not now" refusal is not kept: the same request again runs again
    if (ok || !RETRY_CODES.has(code)) {
      answered.set(id, { sha, kind, answer });
      if (answered.size > REMEMBERED_IDS) answered.delete(answered.keys().next().value as string);
    }
    post(answer, kind);
    const stages = held.get(id) ?? [];
    held.delete(id);
    for (const stage of stages) progress(stage);
    if (ends) {
      const end = ok ? (ok.result as { stage?: unknown }).stage : code === "id_reused" ? null : "refused";
      if (typeof end === "string" && END_STAGES.has(end as Stage) && !stages.includes(end as Stage)) progress(end as Stage);
    }
    if (own && "then" in own) own.then?.();
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
    const at = clock();
    queue = queue.then(() => handle(data, at)).catch(() => {});
  });
  // each ready starts a new app document, read as kit-v1.4 until its hello, and sent no state event before its own first
  // `state` answer (its client asks one at once, after its hello); in the queue, so a hello its document posted before
  // is read first and the new one's after
  const ready = (): void => {
    hello = false;
    queue = queue.then(() => {
      level = KIT_DEFAULT;
      sent = null;
    });
    post({ v: 1, type: "ready", release: RELEASE, api: API });
  };
  if (!host.readyOnLoad) ready();
  // the shell posts `ready` on each load of its frame instead: each APP_HOST document needs its own, once
  // the notice that an open's layer has closed: the type and the id alone, to an app at kit-v1.13's level or above only
  // (kit 1.13 reads it; kit 1.14, 1.15 and 1.16 too), as the hello of the frame's document since its ready named it (a ready's
  // reset still in the queue: none)
  const closed = (id: string): void => {
    if (!hello || (level !== "current" && level !== "1.16" && level !== "1.15" && level !== "1.14" && level !== "1.13")) return;
    const msg: ClosedEvent = { v: 1, type: "closed", id };
    post(msg);
  };
  return { idle: () => queue, ready, closed };
}
