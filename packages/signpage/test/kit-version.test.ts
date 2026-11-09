// The page sends each kit version only what it reads (card kit-frame-version; src/kit-version.ts, src/api.ts).
//   node --test test/kit-version.test.ts      (from packages/signpage)
// kit-v1.4's schema is the tag's own (test/fixtures/kit-v1.4/, `git show kit-v1.4:packages/kit/src/...`, each file
// pinned by its SHA-256 below and compared with the tag byte for byte where the tag is fetched). A client that posts
// no hello is kit-v1 to kit-v1.4: every state answer, state event, deposit.confirm answer and progress event the page
// posts it must pass that schema, with every deposit stage and fact the page has in the state. Red before this card:
// the page sent the state as it is, which kit-v1.4 refuses whole. A hello from kit-v1.5 gets every message as it is.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_ORIGIN, startApi, type ApiHost, type IncomingMessage } from "../src/api.ts";
import * as NOW from "../../kit/src/signpage/schema.ts";
import * as V14 from "./fixtures/kit-v1.4/signpage/schema.ts";
import * as V17 from "./fixtures/kit-v1.7/signpage/schema.ts";
import { POOL_DEPOSIT_STAGES, SIGNPAGE_KIT_VERSION, type DepositStage, type PoolChain, type PoolDepositStage, type SignpageState, type Stage } from "../../kit/src/signpage/messages.ts";

const TAG_FILES = {
  "signpage/schema.ts": "6efa19805b2856212bdfbb2e3c5ae56ecd5ad24189553ced229ec3eea9415092",
  "signpage/messages.ts": "43c58a099db72b26e5f755edadf9cc5e056e8d4034c1981967bda04ca4bd904f",
  "orders/record.ts": "8b3bd33d80d46272174ede5aa517212c402bcc46d08a14d0256c628ba124c5f5",
};
const fixture = (f: string) => readFileSync(new URL(`./fixtures/kit-v1.4/${f}`, import.meta.url));

test("the kit-v1.4 schema here is the tag's: each file's SHA-256 pinned, and byte for byte the tag's where it is fetched", (t) => {
  for (const [f, sha] of Object.entries(TAG_FILES)) assert.equal(createHash("sha256").update(fixture(f)).digest("hex"), sha, f);
  let tag: (f: string) => Buffer;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "kit-v1.4^{commit}"], { stdio: "pipe" });
    tag = (f) => execFileSync("git", ["show", `kit-v1.4:packages/kit/src/${f}`], { maxBuffer: 1 << 24 });
  } catch {
    return t.skip("no kit-v1.4 tag in this clone (a shallow checkout): the pins above hold the files");
  }
  for (const f of Object.keys(TAG_FILES)) assert.ok(tag(f).equals(fixture(f)), `${f} is kit-v1.4's`);
});

// ------------------------------------------------------------------------------------------------ the page's state
const tx = [{ chain: "near" as const, hash: "9xTx" }];
const dep = (id: string, stage: DepositStage, facts: Record<string, unknown> = {}) => ({ id, kind: "deposit" as const, stage, txs: tx, ...facts });
/** Every deposit stage, each with the facts it may carry, the refund's legs too, and one op of every other kind. */
const OPS = [
  dep("d-quote", "quote_checked"),
  dep("d-wait", "waiting", { since_ms: 1 }),
  dep("d-transit", "in_transit", { since_ms: 1 }),
  dep("d-vault", "into_vault", { since_ms: 1 }),
  dep("d-done", "done", { since_ms: 1, amount_usd: "10.5" }),
  dep("d-refunded", "refunded", { held_id: "u.near", since_ms: 1 }),
  dep("d-held", "held", { held_id: "u.near", since_ms: 1 }),
  dep("d-halted", "halted", { hold: "vault_blocked", held_id: "u.near", since_ms: 1 }),
  dep("d-failed", "failed", { since_ms: 1 }),
  dep("d-short", "short", { since_ms: 1 }),
  dep("d-expired", "expired"),
  dep("d-move", "refund_move", { refunded: true, held_id: "v.near", since_ms: 1 }),
  dep("d-move-transit", "in_transit", { refunded: true, since_ms: 1 }),
  dep("d-move-done", "done", { refunded: true, since_ms: 1, amount_usd: "9" }),
  dep("d-move-vault", "into_vault", { refunded: true, since_ms: 1 }),
  dep("d-move-held", "held", { refunded: true, held_id: "v.near", since_ms: 1 }),
  dep("d-moved", "held", { held_id: "u.near", since_ms: 1, moved_out: true }),
  { id: "w", kind: "withdraw" as const, stage: "sent" as const, txs: tx },
  { id: "b", kind: "buy" as const, stage: "refused" as const, txs: [], code: "price_moved" },
  { id: "s", kind: "sell" as const, stage: "filled" as const, txs: tx },
  { id: "h", kind: "hop" as const, stage: "arrived" as const, txs: tx },
  { id: "r", kind: "return" as const, stage: "done" as const, txs: tx },
  { id: "x", kind: "restore" as const, stage: "reading" as const, txs: [] },
];
const pdep = (id: string, stage: PoolDepositStage, facts: Record<string, unknown> = {}, chain: PoolChain = "solana") => ({ id, kind: "pool_deposit" as const, chain, stage, txs: [], ...facts });
/** Every pool deposit stage (card pool-deposit-stages), each with the facts it may carry, the refund's legs too, and a
 *  pool deposit on each pool chain. */
const POOL_OPS = [
  pdep("p-quote", "quote_checked"),
  pdep("p-wait", "waiting", { since_ms: 1 }),
  pdep("p-transit", "in_transit", { since_ms: 1 }, "base"),
  pdep("p-in", "in_pool", { since_ms: 1 }),
  pdep("p-refunded", "refunded", { since_ms: 1 }),
  pdep("p-move", "refund_move", { refunded: true, since_ms: 1 }),
  pdep("p-move-in", "in_pool", { refunded: true, since_ms: 1 }, "robinhood"),
  // card pool-deposit-op-txs: a pool deposit with its txs (a deposit's and a refund move's), left out below 1.7 as any
  pdep("p-txs", "in_pool", { refunded: true, since_ms: 1, txs: [{ chain: "solana", hash: "5sig" }, { chain: "near", hash: "9move" }] }),
  pdep("p-failed", "failed", { since_ms: 1 }),
  pdep("p-short", "short", { since_ms: 1 }),
  pdep("p-expired", "expired"),
];
const ALL_OPS = [...OPS, ...POOL_OPS];
/** What kit-v1.4 is sent of each deposit in OPS: its stage mapped (a refund's leg on its way read as refunded), its facts
 *  left out; every other op as it is. */
const DEPOSIT_V1_4: Record<string, string> = {
  "d-quote": "quote_checked", "d-wait": "waiting", "d-transit": "in_transit", "d-vault": "into_vault",
  "d-done": "done", "d-refunded": "refunded", "d-held": "held", "d-halted": "halted",
  "d-failed": "in_transit", "d-short": "in_transit", "d-expired": "quote_checked", "d-move": "refunded",
  "d-move-transit": "refunded", "d-move-done": "done", "d-move-vault": "refunded", "d-move-held": "held",
  "d-moved": "held",
};
const OPS_V1_4 = OPS.map((o) => (o.kind === "deposit" ? { id: o.id, kind: "deposit", stage: DEPOSIT_V1_4[o.id], txs: o.txs } : o));

const FULL: SignpageState = {
  release: "release-test",
  api: 1,
  signed_in: true,
  way: "words",
  code_saved: true,
  vault_balance: "12.5",
  pools: [{ chain: "solana", asset: "SOL", balance: "2", ready: "1", tap_max: "0.9", price: { price: "15000000000", expo: -8, published_s: 1, read_ms: 2 } }],
  deposit_wallets: [{ chain: "base", address: "0xabc", asset: "ETH", amount: "0.01" }],
  wallets: [{ chain: "solana", address: "W1", role: "fresh", size: "50", state: "READY" }],
  positions: [{ chain: "solana", token: "T", amount: "1.5", cost: "2", wallets: ["W1"], decimals: 6 }, { chain: "base", token: "0xT", amount: "3", cost: "1", wallets: ["0xW"] }],
  orders: [{ order_id: "o", chain: "solana", wallet: "W1", token: "T", group_id: "g", trigger: { kind: "stop", pool: "P", venue: "pumpswap", direction: "lte", price: "1", quote_asset: "SOL" }, state: "ARMED", last_check: 5 }],
  held: [{ id: "u.near", asset: "USDC", amount: "3" }],
  ops: ALL_OPS as SignpageState["ops"],
};
/** FULL's positions as kit-v1.7 and before read them (card signpage-state-holdings): with no decimals. */
const POSITIONS_V1_7 = [{ chain: "solana", token: "T", amount: "1.5", cost: "2", wallets: ["W1"] }, { chain: "base", token: "0xT", amount: "3", cost: "1", wallets: ["0xW"] }] as SignpageState["positions"];
const { pools: _p, deposit_wallets: _d, ...FULL_V1_4_BASE } = FULL;
const FULL_V1_4 = { ...FULL_V1_4_BASE, positions: POSITIONS_V1_7, ops: OPS_V1_4 };
/** What kit-v1.5 is sent (card held-move-forgotten-tx): FULL with each moved-out deposit's moved_out and held_id left
 *  out (review L1: no live Withdraw on an older app). */
const FULL_V1_5 = { ...FULL, positions: POSITIONS_V1_7, ops: OPS.map((o) => (o.kind === "deposit" && "moved_out" in o ? (({ moved_out: _m, held_id: _h, ...r }: Record<string, unknown>) => r)(o) : o)) } as SignpageState;

/** What kit-v1.6 is sent (card pool-deposit-stages): FULL with every pool_deposit op left out, kit-v1.6 having no kind
 *  for it; every other op as it is, moved_out included. */
const FULL_V1_6 = { ...FULL, positions: POSITIONS_V1_7, ops: OPS } as SignpageState;

/** What kit-v1.7 is sent (card signpage-state-holdings): FULL with each position's decimals left out, a key kit-v1.7's
 *  schema refuses the whole state for; everything else as it is, every pool_deposit op included. */
const FULL_V1_7 = { ...FULL, positions: POSITIONS_V1_7 } as SignpageState;

/** What deposit.confirm answers, by its address: the stage named, with the facts that stage carries in OPS. */
const confirmOf = (address: string) => {
  const { id: _i, kind: _k, txs: _t, ...rest } = OPS.find((o) => o.id === address)!;
  return rest;
};
/** The deposit stages after kit-v1.4, and what kit-v1.4 reads for each. */
const MAPPED: [DepositStage, string][] = [["failed", "in_transit"], ["short", "in_transit"], ["expired", "quote_checked"], ["refund_move", "refunded"]];

/** A page on a fake parent whose state is FULL, deposit.confirm answered from OPS with a progress stage, and a change. */
function page(opts: { readyOnLoad?: boolean } = {}) {
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void (to === APP_ORIGIN && posted.push(structuredClone(msg))) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  let change: (() => void) | null = null;
  let current: SignpageState = FULL;
  const kinds: ApiHost["kinds"] = {
    "deposit.confirm": (params, ctx) => {
      const r = confirmOf(params.deposit_address as string);
      ctx.progress(r.stage as Stage);
      return { result: r as never };
    },
  };
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: () => current, watch: (fn) => (change = fn), kinds, readyOnLoad: opts.readyOnLoad });
  const send = (data: unknown) => listener!({ origin: APP_ORIGIN, source: parent, data });
  return {
    posted,
    api,
    send,
    set(s: SignpageState) {
      current = s;
      change!();
    },
    async ask(): Promise<string> {
      const id = crypto.randomUUID();
      send({ v: 1, id, type: "state" });
      await api.idle();
      return id;
    },
    async confirm(address: string): Promise<string> {
      const id = crypto.randomUUID();
      send({ v: 1, id, type: "deposit.confirm", deposit_address: address });
      await api.idle();
      return id;
    },
    answer: (id: string) => posted.find((m) => (m as { id?: string }).id === id) as { ok: boolean; result: Record<string, unknown> },
  };
}
const hello = (kit: unknown) => ({ v: 1, type: "hello", kit });

/** True when a client of that schema module reads `msg` as a state answer, deposit.confirm answer, state or progress event. */
function reads(S: typeof NOW | typeof V14, msg: unknown, kind?: "state" | "deposit.confirm"): boolean {
  if (!S.signpageIsPlainMessage(msg)) return false;
  const m = msg as Record<string, unknown>;
  if (Object.hasOwn(m, "ok")) return S.signpageAnswerOkSchema(m) && kind !== undefined && S.SIGNPAGE_RESULT_SCHEMAS[kind](m.result);
  if (m.type === "state") return S.signpageStateEventSchema(m);
  if (m.type === "progress") return S.signpageProgressSchema(m);
  return S.signpageReadySchema(m);
}

// ------------------------------------------------------------------------------------------------ kit-v1.4: no hello
test("no hello (kit-v1 to kit-v1.4): the state answer, every deposit.confirm answer and its progress pass kit-v1.4's schema", async () => {
  const p = page();
  const id = await p.ask();
  assert.ok(reads(V14, p.answer(id), "state"), "kit-v1.4 reads the state answer");
  for (const op of OPS.filter((o) => o.kind === "deposit")) {
    const cid = await p.confirm(op.id);
    assert.ok(reads(V14, p.answer(cid), "deposit.confirm"), `kit-v1.4 reads deposit.confirm at ${op.stage}${"refunded" in op ? " (refund)" : ""}`);
  }
  const progress = p.posted.filter((m) => (m as { type?: string }).type === "progress");
  assert.equal(progress.length, OPS.filter((o) => o.kind === "deposit").length);
  for (const m of progress) assert.ok(reads(V14, m), `kit-v1.4 reads progress ${JSON.stringify(m)}`);
});

test("no hello: the state is kit-v1.4's fields only, each deposit's stage mapped and its facts left out, the rest as it is", async () => {
  const p = page();
  const id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL_V1_4);
});

test("no hello: each later deposit stage maps to the one that tells where the money is, on the op, deposit.confirm and progress", async () => {
  const p = page();
  const id = await p.ask();
  const ops = (p.answer(id).result as unknown as SignpageState).ops;
  for (const [from, to] of MAPPED) {
    const op = OPS.find((o) => o.stage === from)!;
    assert.equal(ops.find((o) => o.id === op.id)?.stage, to, `the op at ${from}`);
    const before = p.posted.length;
    const cid = await p.confirm(op.id);
    assert.deepEqual(p.answer(cid).result, { stage: to }, `deposit.confirm at ${from}`);
    assert.deepEqual(p.posted.slice(before).find((m) => (m as { type?: string }).type === "progress"), { v: 1, type: "progress", id: cid, stage: to }, `progress ${from}`);
  }
  // a refund move never reads as done while it moves
  assert.equal(ops.find((o) => o.id === "d-move")?.stage, "refunded");
  // a failed or short deposit is 1Click's still: never halted, the held screen with a withdraw from an id it is not under
  for (const id of ["d-failed", "d-short"]) assert.equal(ops.find((o) => o.id === id)?.stage, "in_transit", id);
});

test("no hello: a refund's later legs on their way read as refunded, never as a new deposit; where it landed keeps its stage", async () => {
  const p = page();
  const id = await p.ask();
  const ops = (p.answer(id).result as unknown as SignpageState).ops;
  for (const [op, want] of [["d-move-transit", "refunded"], ["d-move-vault", "refunded"], ["d-move-done", "done"], ["d-move-held", "held"], ["d-transit", "in_transit"], ["d-vault", "into_vault"]]) {
    assert.equal(ops.find((o) => o.id === op)?.stage, want, `the op ${op}`);
    const cid = await p.confirm(op!);
    assert.deepEqual(p.answer(cid).result, { stage: want }, `deposit.confirm ${op}`);
  }
});

test("no hello: a state event after a change passes kit-v1.4's schema; a change it cannot see posts no event", async () => {
  const p = page();
  await p.ask();
  p.set({ ...FULL, pools: [{ chain: "solana", asset: "SOL", balance: "3" }] });
  await p.api.idle();
  assert.equal(p.posted.filter((m) => (m as { type?: string }).type === "state").length, 0, "pools only changed: kit-v1.4 sees no change");
  p.set({ ...FULL, vault_balance: "13" });
  await p.api.idle();
  const ev = p.posted.filter((m) => (m as { type?: string }).type === "state");
  assert.equal(ev.length, 1);
  assert.ok(reads(V14, ev[0]), "kit-v1.4 reads the state event");
  assert.deepEqual((ev[0] as { state: unknown }).state, { ...FULL_V1_4, vault_balance: "13" });
});

test("no hello: an op kit-v1.4 cannot read at all is left out, and the state still passes", async () => {
  const p = page();
  p.set({ ...FULL, ops: [...FULL.ops, { id: "later", kind: "withdraw", stage: "teleported", txs: [] } as never, { id: "k", kind: "lend", stage: "done", txs: [] } as never] });
  const id = await p.ask();
  assert.ok(reads(V14, p.answer(id), "state"));
  assert.deepEqual((p.answer(id).result as unknown as SignpageState).ops.map((o) => o.id), OPS_V1_4.map((o) => o.id));
});

test("no hello: a route event (kit-v1.4 has no pool.buy) is not posted", async () => {
  const posted: unknown[] = [];
  const parent = { postMessage: (m: unknown) => void posted.push(m) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: () => FULL,
    kinds: { "pool.buy": (_p, ctx) => (ctx.route!({ out: "1.5" }), { result: { stage: "filled", txs: [] } }) },
  });
  const id = crypto.randomUUID();
  listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: "pool.buy", chain: "solana", token: "T", amount: "1", slippage_bps: 50 } });
  // the route's post is queued behind the request's own turn: wait for both, and for the answer
  for (let i = 0; i < 3; i++) await api.idle();
  assert.ok(posted.some((m) => (m as { id?: string }).id === id), "the buy was answered");
  assert.equal(posted.filter((m) => (m as { type?: string; out?: string }).out !== undefined).length, 0);
});

test("hello kit 1.5: a route event is posted (kit-v1.5 has pool.buy), as at the kit's own version", async () => {
  for (const kit of ["1.5", SIGNPAGE_KIT_VERSION]) {
    const posted: unknown[] = [];
    const parent = { postMessage: (m: unknown) => void posted.push(m) };
    let listener: ((e: IncomingMessage) => void) | null = null;
    const api = startApi({
      parent,
      listen: (fn) => (listener = fn),
      state: () => FULL,
      kinds: { "pool.buy": (_p, ctx) => (ctx.route!({ out: "1.5" }), { result: { stage: "filled", txs: [] } }) },
    });
    listener!({ origin: APP_ORIGIN, source: parent, data: hello(kit) });
    const id = crypto.randomUUID();
    listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: "pool.buy", chain: "solana", token: "T", amount: "1", slippage_bps: 50 } });
    for (let i = 0; i < 3; i++) await api.idle();
    assert.equal(posted.filter((m) => (m as { out?: string }).out === "1.5").length, 1, kit);
  }
});

// ------------------------------------------------------------------------------------------------ the hello
test("hello at the kit's own version: every message as it is, and the kit's own schema reads each one", async () => {
  const p = page();
  p.send(hello(SIGNPAGE_KIT_VERSION));
  const id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL);
  assert.ok(reads(NOW, p.answer(id), "state"));
  for (const [from] of MAPPED) {
    const cid = await p.confirm(OPS.find((o) => o.stage === from)!.id);
    assert.equal(p.answer(cid).result.stage, from);
    assert.ok(reads(NOW, p.answer(cid), "deposit.confirm"));
  }
  assert.equal(p.posted.filter((m) => (m as { id?: string; type?: string }).type === undefined && (m as { id?: string }).id === undefined).length, 0, "the hello is answered with nothing");
});

test("a hello gets no answer; a later or higher version reads everything, an older, malformed or extra-keyed one is kit-v1.4", async () => {
  for (const [msg, full] of [
    [hello(SIGNPAGE_KIT_VERSION), FULL], [hello("1.12"), FULL], [hello("2.0"), FULL], [hello("1.7"), FULL_V1_7], [hello("1.6"), FULL_V1_6], [hello("1.5"), FULL_V1_5],
    [hello("1.4"), FULL_V1_4], [hello("1.0"), FULL_V1_4], [hello("1.5.0"), FULL_V1_4], [hello("v1.5"), FULL_V1_4], [hello(15), FULL_V1_4],
    [{ ...hello(SIGNPAGE_KIT_VERSION), id: crypto.randomUUID() }, FULL_V1_4], [{ v: 2, type: "hello", kit: SIGNPAGE_KIT_VERSION }, FULL_V1_4],
  ] as const) {
    const p = page();
    const before = p.posted.length;
    p.send(msg);
    await p.api.idle();
    const after = p.posted.length;
    const id = await p.ask();
    assert.deepEqual(p.answer(id).result, full, JSON.stringify(msg));
    if (!("id" in msg)) assert.equal(after, before, `${JSON.stringify(msg)}: no answer`);
  }
});

test("in the shell's order (hello, a 1.5 answer, the next document's ready, a store change): no state event before that document's own answer", async () => {
  const p = page({ readyOnLoad: true });
  p.api.ready();
  p.send(hello(SIGNPAGE_KIT_VERSION));
  const id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL);
  p.api.ready();
  p.set({ ...FULL, vault_balance: "99" });
  await p.api.idle();
  assert.equal(p.posted.filter((m) => (m as { type?: string }).type === "state").length, 0, "no event in any shape to the new document before it asks");
  p.send(hello(SIGNPAGE_KIT_VERSION));
  const id2 = await p.ask();
  assert.deepEqual(p.answer(id2).result, { ...FULL, vault_balance: "99" });
  p.set({ ...FULL, vault_balance: "100" });
  await p.api.idle();
  const ev = p.posted.filter((m) => (m as { type?: string }).type === "state");
  assert.deepEqual(ev, [{ v: 1, type: "state", state: { ...FULL, vault_balance: "100" } }], "events again after its answer, in its own shape");
});

test("the version the page reads every kit at in full is the kit's own SIGNPAGE_KIT_VERSION; the one before it is kit-v1.7's", async () => {
  const [major, minor] = SIGNPAGE_KIT_VERSION.split(".").map(Number) as [number, number];
  assert.equal(`${major}.${minor - 1}`, "1.7", "raising the version again adds its level here");
  for (const [kit, want] of [[SIGNPAGE_KIT_VERSION, FULL], [`${major}.${minor - 1}`, FULL_V1_7], [`${major}.${minor - 2}`, FULL_V1_6], [`${major}.${minor - 3}`, FULL_V1_5], [`${major}.${minor + 1}`, FULL]] as const) {
    const p = page();
    p.send(hello(kit));
    const id = await p.ask();
    assert.deepEqual(p.answer(id).result, want, kit);
  }
});

test("hello kit 1.5 (held-move-forgotten-tx): every deposit with no moved_out, in the state, its events and deposit.confirm; the rest as it is", async () => {
  const p = page();
  p.send(hello("1.5"));
  const id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL_V1_5);
  assert.ok(reads(NOW, p.answer(id), "state"));
  assert.ok(!JSON.stringify(p.answer(id)).includes("moved_out"), "no moved_out in kit-v1.5's state");
  const cid = await p.confirm("d-moved");
  assert.deepEqual(p.answer(cid).result, { stage: "held", since_ms: 1 }, "deposit.confirm: held with no held_id (no Withdraw on kit-v1.5), its other facts kept");
  assert.ok(reads(NOW, p.answer(cid), "deposit.confirm"));
  assert.deepEqual((p.answer(id).result as unknown as SignpageState).ops.find((o) => o.id === "d-moved-held" || o.id === "d-held"), OPS.find((o) => o.id === "d-held"), "a deposit still held keeps its held_id");
  for (const [from] of MAPPED) {
    const c = await p.confirm(OPS.find((o) => o.stage === from)!.id);
    assert.equal(p.answer(c).result.stage, from, "later stages as they are");
    assert.ok(p.posted.some((m) => (m as { id?: string; type?: string; stage?: string }).id === c && (m as { type?: string }).type === "progress" && (m as { stage?: string }).stage === from), `its progress at ${from} as it is`);
  }
  p.set({ ...FULL, vault_balance: "99" });
  await p.api.idle();
  const ev = p.posted.filter((m) => (m as { type?: string }).type === "state").at(-1) as { state: SignpageState };
  assert.deepEqual(ev.state, { ...FULL_V1_5, vault_balance: "99" }, "a state event in kit-v1.5's shape");
  // the kit at its own version gets the fact, and its schema reads it
  const q = page();
  q.send(hello(SIGNPAGE_KIT_VERSION));
  const qc = await q.confirm("d-moved");
  assert.deepEqual(q.answer(qc).result, { stage: "held", held_id: "u.near", since_ms: 1, moved_out: true });
  assert.ok(reads(NOW, q.answer(qc), "deposit.confirm"));
});


test("each ready (the shell's, on each load of the app's frame) reads the app as kit-v1.4 again until its own hello", async () => {
  const p = page({ readyOnLoad: true });
  p.api.ready();
  p.send(hello(SIGNPAGE_KIT_VERSION));
  let id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL);
  p.api.ready();
  id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL_V1_4, "a new document with no hello");
  p.send(hello(SIGNPAGE_KIT_VERSION));
  id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL);
});

test("a repeated deposit.confirm gets its first answer shaped for the version asking now", async () => {
  const p = page();
  const msg = { v: 1, id: crypto.randomUUID(), type: "deposit.confirm", deposit_address: "d-move" };
  p.send(msg);
  await p.api.idle();
  assert.deepEqual(p.answer(msg.id).result, { stage: "refunded" });
  p.send(hello(SIGNPAGE_KIT_VERSION));
  p.send(msg);
  await p.api.idle();
  const again = () => (p.posted.filter((m) => (m as { id?: string }).id === msg.id).at(-1) as { result: unknown }).result;
  assert.deepEqual(again(), confirmOf("d-move"), "the same answer, every fact");
  // a new document with no hello asks the same again: kit-v1.4's shape of it
  p.api.ready();
  p.send(msg);
  await p.api.idle();
  assert.deepEqual(again(), { stage: "refunded" }, "the first answer, shaped for kit-v1.4");
});

test("no hello: a state with no pools and no deposit wallets is still mapped (every deposit stage, no fact)", async () => {
  const p = page();
  const { pools: _a, deposit_wallets: _b, ...bare } = FULL;
  p.set(bare);
  const id = await p.ask();
  assert.ok(reads(V14, p.answer(id), "state"));
  assert.deepEqual(p.answer(id).result, FULL_V1_4);
});

test("no hello: the deployed shape today (pools and deposit_wallets, kit-v1.4's stages only, no facts) passes kit-v1.4's schema", async () => {
  // what SIGN_HOST already sends a signed-in device with pool notes and deposit wallets before card kit-deposit-calls'
  // stages are written: kit-v1.4 refuses it whole for the two fields alone
  const old = OPS.filter((o) => !("refunded" in o) && (o.kind !== "deposit" || ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted"].includes(o.stage)))
    .map((o) => (o.kind === "deposit" ? { id: o.id, kind: o.kind, stage: o.stage, txs: o.txs } : o));
  const deployed = { ...FULL, ops: old as SignpageState["ops"] };
  assert.equal(V14.SIGNPAGE_RESULT_SCHEMAS.state(deployed), false, "kit-v1.4 refuses the state for pools and deposit_wallets alone");
  const p = page();
  p.set(deployed);
  const id = await p.ask();
  assert.ok(reads(V14, p.answer(id), "state"), "kit-v1.4 reads it now");
  const { pools: _a, deposit_wallets: _b, ...rest } = deployed;
  assert.deepEqual(p.answer(id).result, { ...rest, positions: POSITIONS_V1_7 }, "the two fields and the position decimals left out, every other field and op as it is");
});

// ------------------------------------------------------------------------------------------------ card pool-deposit-stages
test("the pool ops here hold every pool deposit stage the kit names", () => {
  assert.deepEqual([...new Set(POOL_OPS.map((o) => o.stage))].sort(), [...POOL_DEPOSIT_STAGES].sort());
});

test("hello at the kit's own version: every pool deposit op as it is, each stage with its facts, and the kit's schema reads the state", async () => {
  const p = page();
  p.send(hello(SIGNPAGE_KIT_VERSION));
  const id = await p.ask();
  const ops = (p.answer(id).result as unknown as SignpageState).ops;
  assert.deepEqual(ops.filter((o) => o.kind === "pool_deposit"), POOL_OPS);
  assert.ok(reads(NOW, p.answer(id), "state"));
});

test("hello kit 1.6: the state with every pool_deposit op left out and everything else as it is, moved_out included; its events too", async () => {
  const p = page();
  p.send(hello("1.6"));
  const id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL_V1_6);
  assert.ok(!JSON.stringify(p.answer(id)).includes("pool_deposit"), "no pool_deposit op in kit-v1.6's state");
  assert.ok(reads(NOW, p.answer(id), "state"));
  const cid = await p.confirm("d-moved");
  assert.deepEqual(p.answer(cid).result, { stage: "held", held_id: "u.near", since_ms: 1, moved_out: true }, "deposit.confirm as it is: kit-v1.6 reads moved_out");
  // a change to a pool op alone: kit-v1.6 sees no change, so no event
  p.set({ ...FULL, ops: FULL.ops.map((o) => (o.id === "p-quote" ? { ...o, stage: "waiting", since_ms: 2 } : o)) as SignpageState["ops"] });
  await p.api.idle();
  assert.equal(p.posted.filter((m) => (m as { type?: string }).type === "state").length, 0, "a pool op's change only: no event to kit-v1.6");
  p.set({ ...FULL, vault_balance: "99" });
  await p.api.idle();
  const ev = p.posted.filter((m) => (m as { type?: string }).type === "state");
  assert.deepEqual(ev, [{ v: 1, type: "state", state: { ...FULL_V1_6, vault_balance: "99" } }]);
  // the kit at its own version sees the pool op's change
  const q = page();
  q.send(hello(SIGNPAGE_KIT_VERSION));
  await q.ask();
  q.set({ ...FULL, ops: FULL.ops.map((o) => (o.id === "p-quote" ? { ...o, stage: "waiting", since_ms: 2 } : o)) as SignpageState["ops"] });
  await q.api.idle();
  assert.equal(q.posted.filter((m) => (m as { type?: string }).type === "state").length, 1, "kit-v1.7 gets the pool op's change");
});

test("hello kit 1.5 and no hello: no pool_deposit op either", async () => {
  for (const msg of [hello("1.5"), null]) {
    const p = page();
    if (msg) p.send(msg);
    const id = await p.ask();
    assert.ok(!JSON.stringify(p.answer(id)).includes("pool_deposit"), JSON.stringify(msg));
    assert.deepEqual(p.answer(id).result, msg ? FULL_V1_5 : FULL_V1_4);
  }
});

// ------------------------------------------------------------------------------------------------ card signpage-state-holdings
// kit-v1.7's schema is main's before this card (f6066882, the last commit at kit 1.7: test/fixtures/kit-v1.7/, each
// file pinned by its SHA-256 below and compared with that commit byte for byte where the clone has it). Its exact keys
// refuse a position with decimals, so a kit-v1.7 app would drop the whole state the first time one carried them
// (review P2-3).
const V17_COMMIT = "f6066882";
const V17_FILES = {
  "signpage/schema.ts": "cc59469013d851ea7d401ddfd26aa73232f3d7fdc49a4824936915070cf9f05e",
  "signpage/messages.ts": "9db8e564257068ea1e87e1010cf8352bc022a3181a1f10fa9c5b53c958d3ac2a",
  "orders/record.ts": "1499cd86f07143d7205e1e86ffd3f37ae25f65e64c83b2c7fd70235a5a5def8d",
  "freeze.ts": "28118f50d643c20f7604c945eaf4d5fc1b2a6e4246a5193d814b2fdfde75e4d0",
};
test("the kit-v1.7 schema here is main's at kit 1.7: each file's SHA-256 pinned, and byte for byte that commit's where the clone has it", (t) => {
  const file = (f: string) => readFileSync(new URL(`./fixtures/kit-v1.7/${f}`, import.meta.url));
  for (const [f, sha] of Object.entries(V17_FILES)) assert.equal(createHash("sha256").update(file(f)).digest("hex"), sha, f);
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${V17_COMMIT}^{commit}`], { stdio: "pipe" });
  } catch {
    return t.skip(`no ${V17_COMMIT} in this clone (a shallow checkout): the pins above hold the files`);
  }
  for (const f of Object.keys(V17_FILES)) assert.ok(execFileSync("git", ["show", `${V17_COMMIT}:packages/kit/src/${f}`], { maxBuffer: 1 << 24 }).equals(file(f)), `${f} is kit-v1.7's`);
});

test("hello kit 1.7: every position with no decimals, everything else as it is, and kit-v1.7's own schema reads it; its events too", async () => {
  assert.equal(V17.SIGNPAGE_RESULT_SCHEMAS.state(FULL), false, "kit-v1.7 refuses the whole state for a position's decimals");
  const p = page();
  p.send(hello("1.7"));
  const id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL_V1_7);
  assert.ok(reads(V17, p.answer(id), "state"), "kit-v1.7's schema reads what the page sends it");
  p.set({ ...FULL, vault_balance: "99" });
  await p.api.idle();
  const ev = p.posted.filter((m) => (m as { type?: string }).type === "state");
  assert.deepEqual(ev, [{ v: 1, type: "state", state: { ...FULL_V1_7, vault_balance: "99" } }]);
  assert.ok(reads(V17, ev[0], "state"));
});

test("hello at the kit's own version (1.8): each position's decimals as they are, and the kit's schema reads them", async () => {
  assert.equal(SIGNPAGE_KIT_VERSION, "1.8");
  const p = page();
  p.send(hello(SIGNPAGE_KIT_VERSION));
  const id = await p.ask();
  assert.deepEqual((p.answer(id).result as unknown as SignpageState).positions, FULL.positions);
  assert.equal((p.answer(id).result as unknown as SignpageState).positions[0]!.decimals, 6);
  assert.ok(reads(NOW, p.answer(id), "state"));
});

test("every level below the current one reads its own schema's positions: no decimals at 1.6, 1.5 and with no hello", async () => {
  for (const msg of [hello("1.6"), hello("1.5"), null]) {
    const p = page();
    if (msg) p.send(msg);
    const id = await p.ask();
    assert.deepEqual((p.answer(id).result as unknown as SignpageState).positions, POSITIONS_V1_7, JSON.stringify(msg));
  }
  const p = page();
  const id = await p.ask();
  assert.ok(reads(V14, p.answer(id), "state"), "kit-v1.4 still reads it");
});

test("review: hello kit 1.7: every deposit.confirm answer with its facts as they are, moved_out included, and kit-v1.7's schema reads each", async () => {
  const p = page();
  p.send(hello("1.7"));
  await p.ask();
  for (const op of OPS.filter((o) => o.kind === "deposit")) {
    const cid = await p.confirm(op.id);
    assert.deepEqual(p.answer(cid).result, confirmOf(op.id), `deposit.confirm ${op.id}`);
    assert.ok(reads(V17, p.answer(cid), "deposit.confirm"), `kit-v1.7 reads deposit.confirm ${op.id}`);
  }
  const cid = await p.confirm("d-moved");
  assert.deepEqual(p.answer(cid).result, { stage: "held", held_id: "u.near", since_ms: 1, moved_out: true });
});
