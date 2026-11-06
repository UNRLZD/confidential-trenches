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
import type { DepositStage, SignpageState, Stage } from "../../kit/src/signpage/messages.ts";

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
  { id: "w", kind: "withdraw" as const, stage: "sent" as const, txs: tx },
  { id: "b", kind: "buy" as const, stage: "refused" as const, txs: [], code: "price_moved" },
  { id: "s", kind: "sell" as const, stage: "filled" as const, txs: tx },
  { id: "h", kind: "hop" as const, stage: "arrived" as const, txs: tx },
  { id: "r", kind: "return" as const, stage: "done" as const, txs: tx },
  { id: "x", kind: "restore" as const, stage: "reading" as const, txs: [] },
];
/** What kit-v1.4 is sent of OPS, in order: each deposit's stage mapped, its facts left out; every other op as it is. */
const OPS_V1_4 = [
  ["d-quote", "quote_checked"], ["d-wait", "waiting"], ["d-transit", "in_transit"], ["d-vault", "into_vault"],
  ["d-done", "done"], ["d-refunded", "refunded"], ["d-held", "held"], ["d-halted", "halted"],
  ["d-failed", "halted"], ["d-short", "halted"], ["d-expired", "quote_checked"], ["d-move", "refunded"],
  ["d-move-transit", "in_transit"], ["d-move-done", "done"],
].map(([id, stage]) => ({ id, kind: "deposit", stage, txs: tx })).concat(OPS.slice(14) as never[]);

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
  positions: [{ chain: "solana", token: "T", amount: "1", cost: "2", wallets: ["W1"] }],
  orders: [{ order_id: "o", chain: "solana", wallet: "W1", token: "T", group_id: "g", trigger: { kind: "stop", pool: "P", venue: "pumpswap", direction: "lte", price: "1", quote_asset: "SOL" }, state: "ARMED", last_check: 5 }],
  held: [{ id: "u.near", asset: "USDC", amount: "3" }],
  ops: OPS as SignpageState["ops"],
};
const { pools: _p, deposit_wallets: _d, ...FULL_V1_4_BASE } = FULL;
const FULL_V1_4 = { ...FULL_V1_4_BASE, ops: OPS_V1_4 };

/** What deposit.confirm answers, by its address: the stage named, with the facts that stage carries in OPS. */
const confirmOf = (address: string) => {
  const { id: _i, kind: _k, txs: _t, ...rest } = OPS.find((o) => o.id === address)!;
  return rest;
};
/** The deposit stages after kit-v1.4, and what kit-v1.4 reads for each. */
const MAPPED: [DepositStage, string][] = [["failed", "halted"], ["short", "halted"], ["expired", "quote_checked"], ["refund_move", "refunded"]];

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
  // a refund move never reads as done while it moves; the refund's own legs keep their stage
  assert.equal(ops.find((o) => o.id === "d-move")?.stage, "refunded");
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

// ------------------------------------------------------------------------------------------------ the hello
test("hello kit 1.5: every message as it is, and the kit's own schema reads each one", async () => {
  const p = page();
  p.send(hello("1.5"));
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
    [hello("1.5"), true], [hello("1.12"), true], [hello("2.0"), true],
    [hello("1.4"), false], [hello("1.0"), false], [hello("1.5.0"), false], [hello("v1.5"), false], [hello(15), false],
    [{ ...hello("1.5"), id: crypto.randomUUID() }, false], [{ v: 2, type: "hello", kit: "1.5" }, false],
  ] as const) {
    const p = page();
    const before = p.posted.length;
    p.send(msg);
    await p.api.idle();
    const after = p.posted.length;
    const id = await p.ask();
    assert.deepEqual(p.answer(id).result, full ? FULL : FULL_V1_4, JSON.stringify(msg));
    if (!("id" in msg)) assert.equal(after, before, `${JSON.stringify(msg)}: no answer`);
  }
});

test("each ready (the shell's, on each load of the app's frame) reads the app as kit-v1.4 again until its own hello", async () => {
  const p = page({ readyOnLoad: true });
  p.api.ready();
  p.send(hello("1.5"));
  let id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL);
  p.api.ready();
  id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL_V1_4, "a new document with no hello");
  p.send(hello("1.5"));
  id = await p.ask();
  assert.deepEqual(p.answer(id).result, FULL);
});

test("a repeated deposit.confirm gets its first answer shaped for the version asking now", async () => {
  const p = page();
  const msg = { v: 1, id: crypto.randomUUID(), type: "deposit.confirm", deposit_address: "d-move" };
  p.send(msg);
  await p.api.idle();
  assert.deepEqual(p.answer(msg.id).result, { stage: "refunded" });
  p.send(hello("1.5"));
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
