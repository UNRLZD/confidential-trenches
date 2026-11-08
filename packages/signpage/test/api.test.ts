// SIGN_HOST's postMessage API (src/api.ts), card signpage-postmessage.
//   node --test test/api.test.ts      (from packages/signpage)
// The page posts `ready` to APP_HOST only, answers `state` with exactly {v, id, type}, refuses every other kind as
// "not_allowed", answers a repeated request with its first answer and a reused id with another body with "id_reused",
// and drops a wrong origin, a wrong source, a request over the UTF-8 size cap, a forbidden key or a malformed envelope
// with no answer and no change. public/app.js being this source's build is scripts/build-app.test.mjs's.
import assert from "node:assert/strict";
import { throughApi } from "./api-ends.ts";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { APP_ORIGIN, REMEMBERED_IDS, RELEASE, SIGNPAGE_MAX_REQUEST_BYTES, signedOutState, startApi } from "../src/api.ts";
import type { IncomingMessage } from "../src/api.ts";

const KINDS = [
  "deposit.quote", "deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return",
  "withdraw.open", "signin.open", "backup.open", "export.open", "signout", "restore",
];

/** A page started on a fake parent: what it posted, a way to send it a message, and a wait for it to finish. */
function page() {
  let reads = 0;
  const posted: { msg: unknown; to: string }[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to }) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: () => (reads++, signedOutState()) });
  const send = (data: unknown, from: { origin?: string; source?: unknown } = {}) =>
    listener!({ origin: from.origin ?? APP_ORIGIN, source: "source" in from ? from.source : parent, data });
  return { posted, send, parent, idle: () => api.idle(), reads: () => reads, msgs: () => posted.map((p) => p.msg) };
}

const uuid = () => crypto.randomUUID();
const state = (id = uuid()) => ({ v: 1, id, type: "state" });
const notAllowed = (id: string) => ({ v: 1, id, ok: false, error: { code: "not_allowed" } });
const idReused = (id: string) => ({ v: 1, id, ok: false, error: { code: "id_reused" } });
const stateAnswer = (id: string) => ({ v: 1, id, ok: true, result: signedOutState() });
// The api answers after an off-thread SHA-256 of each message, so on a loaded runner an answer comes when it comes: a
// wait for one waits until its condition holds, bounded at 2 s with a named failure, never for a set time. A set wait is
// left only before a check that nothing came, where it can let a late post through but never fail.
async function until(cond: () => boolean, what: string, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`not within ${ms} ms: ${what}`);
    await new Promise((ok) => setTimeout(ok, 1));
  }
}
const idOf = (m: unknown) => (m as { id?: string } | null)?.id;

test("ready: posted once at start, to the parent, with targetOrigin APP_HOST, in the frozen shape", () => {
  const p = page();
  assert.deepEqual(p.posted, [{ msg: { v: 1, type: "ready", release: RELEASE, api: 1 }, to: APP_ORIGIN }]);
});

test("state from APP_HOST's parent: answered with the state, to APP_HOST only", async () => {
  const p = page();
  const id = uuid();
  p.send(state(id));
  await p.idle();
  assert.deepEqual(p.posted, [p.posted[0], { msg: stateAnswer(id), to: APP_ORIGIN }]);
  const s = signedOutState();
  assert.deepEqual(Object.keys(s).sort(), ["api", "code_saved", "held", "ops", "orders", "positions", "release", "signed_in", "vault_balance", "wallets"]);
  assert.equal(s.signed_in, false);
});

test("a wrong origin is dropped: no answer, no change", async () => {
  const p = page();
  const id = uuid();
  for (const origin of ["https://evil.ct.test", "https://app.other.test", "https://example.com", "https://ct-app.unrealized.trade.evil.com", "http://ct-app.unrealized.trade", "https://confidential.unrealized.trade", "null", ""]) {
    p.send({ v: 1, id, type: "buy" }, { origin });
  }
  await p.idle();
  assert.equal(p.posted.length, 1, "only ready");
  p.send(state(id));
  await p.idle();
  assert.deepEqual(p.msgs()[1], stateAnswer(id), "the dropped messages left no id behind");
});

test("a wrong source from APP_HOST's origin is dropped: no answer, no change", async () => {
  const p = page();
  const id = uuid();
  for (const source of [null, undefined, {}, { postMessage() {} }]) p.send({ v: 1, id, type: "buy" }, { source });
  await p.idle();
  assert.equal(p.posted.length, 1, "only ready");
  p.send(state(id));
  await p.idle();
  assert.deepEqual(p.msgs()[1], stateAnswer(id));
});

test("a malformed envelope is dropped: not an object, no UUID id, a class instance", async () => {
  const p = page();
  const id = uuid();
  const bad: unknown[] = [
    null, undefined, "state", 1, [], [state(id)], new Map([["v", 1]]), new Date(),
    { v: 1, type: "state" }, { v: 1, id: 7, type: "state" }, { v: 1, id: "", type: "state" },
    { v: 1, id: "not-a-uuid", type: "state" }, { v: 1, id: id.toUpperCase(), type: "state" }, { v: 1, id: `${id} `, type: "state" },
    Object.assign(Object.create({ v: 1, id }), { type: "state" }),
    Object.assign(Object.create({ x: 1 }), { v: 1, id, type: "state" }),
    Object.assign(new Date(), { v: 1, id, type: "state" }),
  ];
  for (const d of bad) p.send(d);
  await p.idle();
  assert.equal(p.posted.length, 1, "only ready");
});

test("every other kind, an unknown kind, a wrong v and an extra field: not_allowed", async () => {
  const p = page();
  const cases: Record<string, unknown>[] = [
    ...KINDS.map((type) => ({ v: 1, id: uuid(), type })),
    { v: 1, id: uuid(), type: "buy", chain: "solana", token: "So11111111111111111111111111111111111111112", side: "buy", amount: "1", slippage_bps: 50 },
    { v: 1, id: uuid(), type: "sign" },
    { v: 1, id: uuid(), type: "eth_signTypedData_v4" },
    { v: 1, id: uuid() },
    { v: 1, id: uuid(), type: 5 },
    { v: 1, id: uuid(), type: "State" },
    { v: 1, id: uuid(), type: "state", extra: true },
    { v: 2, id: uuid(), type: "state" },
    { v: "1", id: uuid(), type: "state" },
    { id: uuid(), type: "state" },
  ];
  for (const c of cases) p.send(c);
  await p.idle();
  assert.equal(p.posted.length, 1 + cases.length);
  cases.forEach((c, i) => assert.deepEqual(p.posted[1 + i], { msg: notAllowed(c.id as string), to: APP_ORIGIN }, JSON.stringify(c)));
});

test("a __proto__, constructor or prototype key at any depth is dropped (the kit's FORBIDDEN_KEYS)", async () => {
  const p = page();
  const id = uuid();
  const bad: unknown[] = [
    { v: 1, id, type: "state", ["__proto__"]: { polluted: true } },
    JSON.parse(`{"v":1,"id":"${id}","type":"state","__proto__":{"polluted":true}}`),
    { v: 1, id, type: "buy", constructor: 1 },
    { v: 1, id, type: "buy", prototype: 1 },
    { v: 1, id, type: "orders.set", tp: { constructor: { prototype: 1 } } },
    { v: 1, id, type: "buy", list: [{ a: [{ ["__proto__"]: null }] }] },
    JSON.parse(`{"v":1,"id":"${id}","type":"buy","x":{"y":{"__proto__":{"polluted":true}}}}`),
  ];
  for (const d of bad) p.send(d);
  await p.idle();
  assert.equal(p.posted.length, 1, "only ready");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  p.send({ v: 1, id, type: "buy", note: "constructor" });
  await p.idle();
  assert.deepEqual(p.msgs()[1], notAllowed(id), "the word as a value is read, and refused as any buy is");
});

test("a return_key is never looked up: constructor, __proto__, toString and an unknown name are refused", async () => {
  const p = page();
  const cases: Record<string, unknown>[] = [];
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "no_such_screen", "deposit"]) {
    cases.push({ v: 1, id: uuid(), type: "signin.open", return_key: key, way: "passkey" });
    cases.push({ v: 1, id: uuid(), type: "backup.open", return_key: key });
    cases.push({ v: 1, id: uuid(), type: "withdraw.open", return_key: key });
  }
  for (const c of cases) assert.doesNotThrow(() => p.send(c));
  await p.idle();
  assert.equal(p.posted.length, 1 + cases.length);
  cases.forEach((c, i) => assert.deepEqual(p.posted[1 + i], { msg: notAllowed(c.id as string), to: APP_ORIGIN }, JSON.stringify(c)));
});

test("every message posted is at most 4 MiB of JSON, with plain arrays of at most 10,000 items, index keys only", async () => {
  const p = page();
  p.send(state());
  p.send({ v: 1, id: uuid(), type: "buy" });
  await p.idle();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      assert.equal(Object.getPrototypeOf(x), Array.prototype);
      assert.ok(x.length <= 10_000);
      assert.deepEqual(Reflect.ownKeys(x), [...x.keys()].map(String).concat("length"));
      x.forEach(walk);
    } else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk);
  };
  for (const { msg } of p.posted) {
    assert.ok(new TextEncoder().encode(JSON.stringify(msg)).length <= 4 * 1024 * 1024);
    walk(msg);
  }
  assert.equal(p.posted.length, 3);
});

test("the same request again gets its first answer; the same id with another body is refused id_reused", async () => {
  const p = page();
  const x = uuid();
  const buy = { v: 1, id: x, type: "buy", chain: "solana", token: "t", side: "buy", amount: "1", slippage_bps: 50 };
  p.send(buy);
  p.send({ ...buy });
  p.send({ ...buy, amount: "1000" });
  p.send(state(x));
  await p.idle();
  assert.deepEqual(p.msgs().slice(1), [notAllowed(x), notAllowed(x), idReused(x), idReused(x)]);
  assert.equal(p.reads(), 0, "a state on a used id reads nothing");
});

test("state is never kept: read fresh each time, and its id stays free (state X then buy X is the buy's answer)", async () => {
  const p = page();
  const x = uuid();
  p.send(state(x));
  p.send(state(x));
  p.send({ v: 1, id: x, type: "buy" });
  await p.idle();
  assert.equal(p.reads(), 2);
  assert.deepEqual(p.msgs().slice(1), [stateAnswer(x), stateAnswer(x), notAllowed(x)]);
});

test("state polls push out no other id; answered ids are kept up to REMEMBERED_IDS, the oldest first", async () => {
  const p = page();
  const ids = Array.from({ length: REMEMBERED_IDS + 1 }, uuid);
  for (const id of ids) p.send({ v: 1, id, type: "buy" });
  for (let i = 0; i < 2 * REMEMBERED_IDS; i++) p.send(state());
  p.send({ v: 1, id: ids[1], type: "buy", amount: "2" });
  p.send({ v: 1, id: ids[0], type: "buy", amount: "2" });
  await p.idle();
  const last = p.msgs().slice(-2);
  assert.deepEqual(last[0], idReused(ids[1]!), "ids[1] is still kept after 2,048 state polls");
  assert.deepEqual(last[1], notAllowed(ids[0]!), "ids[0] was the oldest and went: a new run");
});

test("the request cap is UTF-8 bytes of the JSON, 64 KiB, checked before any field is read (A:116-117)", async () => {
  const p = page();
  const id = uuid();
  const euro = { v: 1, id, type: "buy", pad: "€".repeat(65_209) };
  const json = JSON.stringify(euro);
  assert.ok(json.length <= SIGNPAGE_MAX_REQUEST_BYTES && new TextEncoder().encode(json).length > SIGNPAGE_MAX_REQUEST_BYTES, "under the cap in UTF-16 units, over it in UTF-8 bytes");
  const extraKey = Object.assign([1, 2], { evil: true });
  let deep: unknown = 1;
  for (let i = 0; i < 20; i++) deep = { d: deep };
  let node: unknown = "x";
  for (let i = 0; i < 12; i++) node = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`k${k}`, node]));
  const bad: unknown[] = [
    euro,
    { v: 1, id, type: "buy", pad: "x".repeat(SIGNPAGE_MAX_REQUEST_BYTES) },
    { v: 1, id, type: "buy", list: extraKey },
    { v: 1, id, type: "buy", list: new Array(5) },
    { v: 1, id, type: "buy", deep },
    { v: 1, id, type: "buy", n: Number.NaN },
    { v: 1, id, type: "buy", when: new Date() },
    { v: 1, id, type: "buy", list: Array.from({ length: SIGNPAGE_MAX_REQUEST_BYTES + 1 }, () => 0) },
    { v: 1, id, type: "buy", node },
  ];
  const t0 = performance.now();
  for (const d of bad) p.send(d);
  await p.idle();
  assert.ok(performance.now() - t0 < 1_000, "the shared-object request is refused fast");
  assert.equal(p.posted.length, 1, "only ready");
  const under = { v: 1, id, type: "buy", pad: "" };
  under.pad = "x".repeat(SIGNPAGE_MAX_REQUEST_BYTES - JSON.stringify(under).length);
  assert.equal(new TextEncoder().encode(JSON.stringify(under)).length, SIGNPAGE_MAX_REQUEST_BYTES);
  p.send(under);
  await p.idle();
  assert.deepEqual(p.msgs()[1], notAllowed(id), "exactly at the cap is read");
});

test("a shared-reference bomb of nulls and numbers is refused fast: every value visited spends the budget", async () => {
  const p = page();
  const id = uuid();
  const nulls = Array.from({ length: 10_000 }, () => null);
  const nums = Array.from({ length: 10_000 }, () => 0);
  const depth1 = Array.from({ length: 10_000 }, () => nulls);
  const depth2 = Array.from({ length: 10_000 }, () => Array.from({ length: 10 }, () => nums));
  const wide = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, nulls]));
  const bad: unknown[] = [
    { v: 1, id, type: "buy", list: depth1 },
    { v: 1, id, type: "buy", list: depth2 },
    { v: 1, id, type: "buy", wide },
  ];
  for (const d of bad) {
    const t0 = performance.now();
    p.send(d);
    await p.idle();
    assert.ok(performance.now() - t0 < 1_000, `refused in ${Math.round(performance.now() - t0)} ms`);
  }
  assert.equal(p.posted.length, 1, "only ready");
});

test("SIGNPAGE_MAX_REQUEST_BYTES equals the kit's (app-signpage-client 6db85d4), 65,536 until that card merges", async () => {
  const schema = new URL("../../kit/src/signpage/schema.ts", import.meta.url);
  if (existsSync(schema)) {
    const kit = (await import(schema.href)) as { SIGNPAGE_MAX_REQUEST_BYTES?: number };
    assert.equal(SIGNPAGE_MAX_REQUEST_BYTES, kit.SIGNPAGE_MAX_REQUEST_BYTES);
  }
  assert.equal(SIGNPAGE_MAX_REQUEST_BYTES, 65_536);
});

// card signpage-frame-state: the host's state may be a promise, and a change the host reports posts a `state` event
/** A page whose state the test sets, and whose watcher the test calls. */
function watched(first: Partial<ReturnType<typeof signedOutState>> = {}) {
  let now = { ...signedOutState(), ...first };
  let change: (() => void) | null = null;
  const posted: { msg: unknown; to: string }[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to }) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: () => new Promise((ok) => setTimeout(() => ok(structuredClone(now)), 1)),
    watch: (fn) => (change = fn),
  });
  return {
    posted,
    set: (s: Partial<ReturnType<typeof signedOutState>>) => (now = { ...now, ...s }),
    change: () => change!(),
    ask: (id = uuid()) => listener!({ origin: APP_ORIGIN, source: parent, data: state(id) }),
    idle: () => api.idle(),
    events: () => posted.filter((p) => (p.msg as { type?: string }).type === "state"),
  };
}

test("a promised state is answered once it resolves", async () => {
  const p = watched({ signed_in: true, way: "words", code_saved: true });
  const id = uuid();
  p.ask(id);
  await p.idle();
  assert.deepEqual(p.posted[1], { msg: { v: 1, id, ok: true, result: { ...signedOutState(), signed_in: true, way: "words", code_saved: true } }, to: APP_ORIGIN });
});

test("a change posts a state event, to APP_HOST only, when the state differs from the last one sent", async () => {
  const p = watched();
  p.ask();
  await p.idle();
  p.set({ signed_in: true, way: "passkey" });
  p.change();
  await p.idle();
  assert.deepEqual(p.events(), [{ msg: { v: 1, type: "state", state: { ...signedOutState(), signed_in: true, way: "passkey" } }, to: APP_ORIGIN }]);
  // the same state again: no event
  p.change();
  await p.idle();
  assert.equal(p.events().length, 1);
  p.set({ code_saved: true });
  p.change();
  await p.idle();
  assert.equal(p.events().length, 2);
  assert.equal((p.events()[1]!.msg as { state: { code_saved: boolean } }).state.code_saved, true);
});

test("no state event before the first state answer; a burst of changes makes one read, one event", async () => {
  const p = watched();
  p.set({ signed_in: true });
  p.change();
  await p.idle();
  assert.equal(p.events().length, 0, "the app is not READY before its first answer");
  p.ask();
  await p.idle();
  p.set({ code_saved: true });
  for (let i = 0; i < 50; i++) p.change();
  await p.idle();
  assert.equal(p.events().length, 1);
});

test("a kind whose handler answers later is answered with its result once it settles, in order, never refused", async () => {
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const ran: string[] = [];
  startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: signedOutState,
    // the page's resync holds the open kinds until its store read ends, then decides (src/main.ts openKind)
    kinds: { "backup.open": () => ({ after: held, answer: () => ({ result: { pending: true as const }, then: () => void ran.push("then") }) }) },
  });
  const send = (data: unknown) => listener!({ origin: APP_ORIGIN, source: parent, data });
  const a = uuid();
  const b = uuid();
  send({ v: 1, id: a, type: "backup.open", return_key: "settings" });
  send(state(b));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(posted.filter((m) => (m as { id?: string }).id === a || (m as { id?: string }).id === b), [], "answered before the handler settled");
  release();
  await until(() => posted.filter((m) => idOf(m) === a || idOf(m) === b).length === 2, "both answers once the handler settled");
  const answers = posted.filter((m) => (m as { id?: string }).id !== undefined);
  assert.deepEqual(answers, [{ v: 1, id: a, ok: true, result: { pending: true } }, stateAnswer(b)]);
  assert.deepEqual(ran, ["then"]);
});

test("a host kind's refusal carries its own code; busy and down are not kept, so the same request runs again", async () => {
  const codes = ["busy", "down", "quote_check_failed", "above_max"];
  let runs = 0;
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: () => signedOutState(),
    kinds: { "deposit.quote": (p) => (runs++, { error: codes[Number(p.amount) - 1] as string }) },
  });
  for (const [i, code] of codes.entries()) {
    const id = uuid();
    const m = { v: 1, id, type: "deposit.quote", origin_asset: "nep141:a", amount: String(i + 1) };
    const before = runs;
    for (let k = 0; k < 2; k++) listener!({ origin: APP_ORIGIN, source: parent, data: m });
    await api.idle();
    assert.deepEqual(posted.slice(-2), [{ v: 1, id, ok: false, error: { code } }, { v: 1, id, ok: false, error: { code } }], code);
    assert.equal(runs - before, code === "busy" || code === "down" ? 2 : 1, code);
  }
});

test("a running kind (a trade) gets its id, holds no other message, runs once for a repeat, and its progress follows its answer", async () => {
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const ids: string[] = [];
  startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: signedOutState,
    kinds: {
      // a trade answered at "sent", its fill as a progress event (src/trade.ts); a progress before the answer waits for it
      buy: (p, ctx) => {
        ids.push(ctx.id);
        if (p.side === "sell") return { error: "quote_check_failed" };
        ctx.progress("signed");
        return { running: true, after: held.then(() => ctx.progress("filled")), answer: () => ({ result: { stage: "sent" as const, txs: [{ chain: "solana" as const, hash: "sig" }] } }) };
      },
    },
  });
  const send = (data: unknown) => listener!({ origin: APP_ORIGIN, source: parent, data });
  const a = uuid();
  const b = uuid();
  const c = uuid();
  const buy = { v: 1, type: "buy", chain: "solana", token: "Mint", amount: "10", slippage_bps: 500 };
  send({ ...buy, id: a, side: "buy" });
  send({ ...buy, id: a, side: "buy" });
  send({ ...buy, id: a, side: "buy", amount: "20" });
  send({ ...buy, id: b, side: "sell" });
  send(state(c));
  await until(() => posted.length >= 4, "the repeat's, the sell's and the state's answers");
  assert.deepEqual(posted.slice(1), [idReused(a), { v: 1, id: b, ok: false, error: { code: "quote_check_failed" } }, stateAnswer(c)], "nothing waits for the trade; its repeat is not run");
  release();
  await until(() => posted.length >= 7, "a's answer and its two progress events");
  assert.deepEqual(ids, [a, b], "one run for a");
  assert.deepEqual(posted.slice(4), [
    { v: 1, id: a, ok: true, result: { stage: "sent", txs: [{ chain: "solana", hash: "sig" }] } },
    { v: 1, type: "progress", id: a, stage: "signed" },
    { v: 1, type: "progress", id: a, stage: "filled" },
  ]);
  send({ ...buy, id: a, side: "buy" });
  await until(() => posted.length >= 8, "a's answer again for its repeat");
  assert.deepEqual(posted.slice(7), [{ v: 1, id: a, ok: true, result: { stage: "sent", txs: [{ chain: "solana", hash: "sig" }] } }], "a repeat after the answer gets it again");
});

test("a running id's answer refreshes its place among the remembered ids, so ids answered while it ran never push it out", async () => {
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const runs: string[] = [];
  const shas = new Map<string, string>();
  const api = startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: signedOutState,
    kinds: {
      buy: (p, ctx) => {
        runs.push(ctx.id);
        shas.set(ctx.id, ctx.sha);
        if (p.side === "sell") return { error: "quote_check_failed" };
        return { running: true, after: held, answer: () => ({ result: { stage: "sent" as const, txs: [] } }) };
      },
    },
  });
  const send = (data: unknown) => listener!({ origin: APP_ORIGIN, source: parent, data });
  const buy = { v: 1, type: "buy", chain: "solana", token: "Mint", amount: "10", slippage_bps: 500 };
  const a = uuid();
  send({ ...buy, id: a, side: "buy" });
  for (let i = 0; i < REMEMBERED_IDS - 1; i++) send({ ...buy, id: uuid(), side: "sell" });
  await api.idle();
  release();
  await until(() => posted.some((m) => idOf(m) === a && (m as { ok?: boolean }).ok === true), "a's answer once its run settled");
  send({ ...buy, id: uuid(), side: "sell" }); // one more: the oldest remembered id goes, which is no longer a
  send({ ...buy, id: a, side: "buy" });
  await api.idle();
  assert.equal(runs.filter((x) => x === a).length, 1, "a was remembered: its repeat got its answer, not a second run");
  assert.deepEqual(posted.at(-1), { v: 1, id: a, ok: true, result: { stage: "sent", txs: [] } });
  const bytes = new TextEncoder().encode(JSON.stringify({ ...buy, id: a, side: "buy" }));
  assert.equal(shas.get(a), Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"), "ctx.sha is the request's SHA-256");
});

// Card signpage-error-after-timeout: a trade kind's end goes out as progress after its answer, since the kit's client
// drops an answer that comes past its 10 s window and the app then ends the trade on progress alone. The rule's edges.
test("a trade kind's end as progress: refused for a refusal, never for id_reused, never twice; other kinds untouched", async () => {
  const BUY = { chain: "solana", token: "So11111111111111111111111111111111111111112", side: "buy", amount: "10", slippage_bps: 500 };
  const running = (answer: unknown, held: string[] = []) => (_p: Record<string, unknown>, ctx: { progress(s: string): void }) => {
    for (const s of held) ctx.progress(s);
    return { running: true, after: Promise.resolve(), answer: () => answer };
  };
  const refused = await throughApi("buy", running({ error: "failed" }) as never, BUY);
  assert.deepEqual(refused.stages, ["refused"]);
  const reused = await throughApi("buy", running({ error: "id_reused" }) as never, BUY);
  assert.deepEqual(reused.stages, [], "id_reused: that id runs elsewhere, its end is that run's");
  const late = await throughApi("buy", running({ result: { stage: "not_landed", txs: [] } }) as never, BUY);
  assert.deepEqual(late.stages, ["not_landed"]);
  const once = await throughApi("buy", running({ result: { stage: "not_landed", txs: [] } }, ["not_landed"]) as never, BUY);
  assert.deepEqual(once.stages, ["not_landed"], "a held end is not posted again");
  const sent = await throughApi("buy", running({ result: { stage: "sent", txs: [] } }) as never, BUY);
  assert.deepEqual(sent.stages, [], "sent is no end: the run's own progress tells its end");
  const open = await throughApi("pool.withdraw", running({ error: "failed" }) as never, { return_key: "portfolio", chain: "solana" });
  assert.deepEqual(open.stages, [], "not a trade kind");
});
