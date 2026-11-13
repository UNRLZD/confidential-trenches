// The pool deposit quote's follow (card pool-deposit-follow; src/pool-deposit-follow.ts): money 1Click delivers to U_X
// goes on into X's pool with no tap, on the device's own two-RPC reads only. A status from the helper moves only the
// stage shown; a forged SUCCESS with nothing under U_X on both RPCs deposits nothing.
//   node --test test/pool-deposit-follow.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

const { askOf, followPoolQuote, POOL_FOLLOW_FAST_MS } = await import("../src/pool-deposit-follow.ts");
const { SOL_LADDER } = await import("../../wallet/src/pool/solana.ts");
const { ladderSplit } = await import("../../wallet/src/pool/ladder.ts");
type Deps = Parameters<typeof followPoolQuote>[1];
type Rec = Parameters<typeof followPoolQuote>[0];
type End = Awaited<ReturnType<Deps["deposit"]>>["end"];

const F: Rec = { chain: "solana", s: "777", i: 3, u: "U_X", refund_id: "ab".repeat(32), address: "DEPOSIT", deadline_ms: 1, origin: "nep141:base-usdc", min_out: "20000000" };
// today's rent (5,080 lamports a byte): one deposit's worst case 2,936,160 and the 650,240 U_X keeps
const PER = 2_936_160n, KEEP = 650_240n, FLOOR = SOL_LADDER.min + PER + KEEP;

type Round = { bal: readonly [bigint, bigint]; status?: string | null; end?: End; past?: boolean };
function world(rounds: Round[], o: { refund?: Deps["refund"] } = {}) {
  const stages: string[] = [];
  const deposits: bigint[] = [];
  const sleeps: number[] = [];
  const ac = new AbortController();
  let k = 0;
  const now = () => rounds[Math.min(k, rounds.length - 1)]!;
  const deps: Deps = {
    status: async () => {
      const s = now().status;
      return s === undefined || s === null ? null : { status: s as never, delivered: null };
    },
    balances: async () => now().bal,
    costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
    ladder: SOL_LADDER,
    deposit: async (_f, amount) => {
      deposits.push(amount);
      return { end: now().end ?? "filled", txs: [] };
    },
    past: async () => now().past === true,
    stage: async (s) => void stages.push(s),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (++k >= rounds.length + 3) ac.abort();
    },
    signal: ac.signal,
    ...(o.refund ? { refund: o.refund } : {}),
  };
  return { deps, stages, deposits, sleeps };
}

test("askOf: the largest ask U_X pays with each rung's worst-case cost and the rent kept; none under the floor", () => {
  assert.equal(askOf(SOL_LADDER, FLOOR, PER, KEEP), 10_000_000n);
  assert.equal(askOf(SOL_LADDER, FLOOR - 1n, PER, KEEP), 0n);
  // 0.2 SOL: rungs of the ladder that, with a cost each and the rent kept, fit under what U_X holds
  const have = 200_000_000n;
  const ask = askOf(SOL_LADDER, have, PER, KEEP);
  const { notes } = ladderSplit(SOL_LADDER, ask);
  assert.ok(ask + BigInt(notes.length) * PER + KEEP <= have, `${ask} with ${notes.length} rungs`);
  assert.ok(ask >= 180_000_000n, String(ask));
});

test("SUCCESS and U_X's balance on both RPCs: pool.deposit runs from U_X, in_pool, followed on to the deadline", async () => {
  const w = world([
    { bal: [0n, 0n], status: "PROCESSING" },
    { bal: [20_000_000n, 20_000_000n], status: "SUCCESS" },
    { bal: [6_000_000n, 6_000_000n], status: "SUCCESS" },
    { bal: [6_000_000n, 6_000_000n], status: "SUCCESS", past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.deepEqual(w.deposits, [10_000_000n]);
  assert.deepEqual(w.stages, ["in_transit", "in_pool"]);
});

test("a forged SUCCESS with U_X short on one RPC deposits nothing: the lower of the two reads counts", async () => {
  const w = world([
    { bal: [20_000_000n, 0n], status: "SUCCESS" },
    { bal: [0n, 20_000_000n], status: "SUCCESS" },
    { bal: [FLOOR - 1n, FLOOR - 1n], status: "SUCCESS" },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_transit");
  assert.deepEqual(w.deposits, []);
});

test("the chain first: money under U_X with the helper down (no status) still goes into the pool", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR + 5n], status: null },
    { bal: [0n, 0n], status: null, past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.deepEqual(w.deposits, [10_000_000n]);
});

test("a deposit that ends not_landed or refused is no end: read again at the slow pace, then carried", async () => {
  for (const end of ["not_landed", "not_funded", "down", "sent"] as const) {
    const w = world([
      { bal: [FLOOR, FLOOR], status: "SUCCESS", end },
      { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
      { bal: [0n, 0n], status: "SUCCESS", past: true },
    ]);
    assert.equal(await followPoolQuote(F, w.deps), "in_pool", end);
    assert.deepEqual(w.deposits, [10_000_000n, 10_000_000n], end);
    assert.ok(w.sleeps[0]! > POOL_FOLLOW_FAST_MS, `${end}: no tight loop after a deposit that did not land`);
  }
});

test("a late second send to U_X after in_pool, before the deadline, is carried too", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS" },
    { bal: [0n, 0n], status: "SUCCESS" },
    { bal: [FLOOR * 2n, FLOOR * 2n], status: "SUCCESS" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.equal(w.deposits.length, 2);
});

test("a stale status never steps the stage back; no status and the deadline past shows expired", async () => {
  const w = world([
    { bal: [0n, 0n], status: "PROCESSING" },
    { bal: [0n, 0n], status: "PENDING_DEPOSIT" },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_transit");
  assert.deepEqual(w.stages, ["in_transit"]);
  const e = world([{ bal: [0n, 0n], status: null, past: true }]);
  assert.equal(await followPoolQuote(F, e.deps), "expired");
});

test("REFUNDED: with no refund carry nothing is read under U_{s,i}, so nothing shows refunded, and the follow never ends as if done", async () => {
  const w = world([{ bal: [0n, 0n], status: "REFUNDED", past: true }]);
  // review P2: the helper's REFUNDED alone shows no refund; nothing seen sent by the deadline: expired
  assert.equal(await followPoolQuote(F, w.deps), "expired");
  assert.deepEqual(w.stages, ["expired"]);
  assert.deepEqual(w.deposits, []);
  assert.ok(w.sleeps.length >= 3, "read on round after round until the signal stops it, never ended");
  // with a carry: the move is asked, shown, and what reaches U_X after it goes into the pool
  let asked = 0;
  const c = world(
    [
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [FLOOR, FLOOR], status: "REFUNDED" },
      { bal: [0n, 0n], status: "REFUNDED", past: true },
    ],
    { refund: async () => (++asked === 1 ? "moved" : "wait") },
  );
  assert.equal(await followPoolQuote(F, c.deps), "in_pool");
  // the move read the money under U_{s,i} on both RPCs: refunded, then moved, in one round
  assert.deepEqual(c.stages, ["refunded", "refund_move", "in_pool"]);
  assert.deepEqual(c.deposits, [10_000_000n]);
});

test("a quote never paid shows expired past its deadline, a stale PENDING_DEPOSIT never shows it live again", async () => {
  const w = world([
    { bal: [0n, 0n], status: "PENDING_DEPOSIT", past: true },
    { bal: [0n, 0n], status: "PENDING_DEPOSIT", past: true },
    { bal: [0n, 0n], status: "KNOWN_DEPOSIT_TX", past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "waiting");
  assert.deepEqual(w.stages, ["expired", "waiting"]);
});

test("the page's follower: the op written under the request's id, its stages kept, resumed at a landing, final at in_pool", async () => {
  const { poolFollows, poolFollowEnded } = await import("../src/pool-deposit-follow.ts");
  const rows = new Map<string, unknown>();
  const store = {
    get: async (_s: "ops", k: string) => rows.get(k),
    keys: async () => [...rows.keys()],
    update: async (_s: "ops", k: string, change: (v: unknown) => unknown) => {
      const v = change(rows.get(k));
      if (v !== undefined) rows.set(k, v);
      return rows.get(k);
    },
  };
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  let pinned = false;
  const host = poolFollows({ store: async () => store, deps: () => (pinned ? w.deps : null), decimals: () => 9, locks: () => null, now: () => 5 });
  const quote = { deposit_address: "DEPOSIT", origin_asset: "nep141:base-usdc", min_amount_out: "0.02", deadline: "2026-11-08T06:00:00.000Z" };
  const u = { scope: 777n, index: 3, wallet: "U_X", refundId: "ab".repeat(32) };
  await host.quoted("op-1", "solana", quote, u);
  await host.idle();
  const op = rows.get("op-1") as { kind: string; stage: string; follow: Record<string, unknown> };
  assert.equal(op.kind, "pool_deposit");
  assert.equal(op.stage, "quote_checked", "no pool pinned for it yet: written, waiting for a landing");
  assert.equal(op.follow.min_out, "20000000");
  assert.equal(op.follow.refund_id, "ab".repeat(32));
  // the same request again keeps its op; another deposit under the same id is refused
  await host.quoted("op-1", "solana", quote, u);
  await assert.rejects(host.quoted("op-1", "solana", { ...quote, deposit_address: "OTHER" }, u));
  await assert.rejects(host.quoted("op-2", "solana", { ...quote, min_amount_out: "0.0000000001" }, u));
  pinned = true;
  await host.settle();
  await host.idle();
  const done = rows.get("op-1") as { stage: "in_pool"; final?: true };
  assert.equal(done.stage, "in_pool");
  assert.ok(poolFollowEnded(done));
  assert.deepEqual(w.deposits, [10_000_000n]);
});

test("depositToEnd: the page's handler asked for the amount at the coin's decimals; a sent answer waits for its end as progress", async () => {
  const { depositToEnd } = await import("../src/pool-deposit-follow.ts");
  const ac = new AbortController();
  const asked: unknown[] = [];
  const sentThen = (end: string) => (params: unknown, ctx: { progress(s: string): void }) => (asked.push(params), {
    running: true,
    after: Promise.resolve().then(() => setTimeout(() => (ctx.progress("sent"), ctx.progress(end)), 1)),
    answer: () => ({ result: { stage: "sent", txs: [] } }),
  });
  assert.equal((await depositToEnd(sentThen("filled"), "solana", 9, 10_000_000n, ac.signal)).end, "filled");
  assert.deepEqual(asked[0], { chain: "solana", amount: "0.01" });
  assert.equal((await depositToEnd(sentThen("not_landed"), "solana", 9, 1_230_000_000n, ac.signal)).end, "not_landed");
  assert.deepEqual(asked[1], { chain: "solana", amount: "1.23" });
  assert.equal((await depositToEnd(() => ({ error: "not_funded" }), "solana", 9, 1n, ac.signal)).end, "not_funded");
  assert.equal((await depositToEnd(() => null, "solana", 9, 1n, ac.signal)).end, "not_allowed");
  assert.equal((await depositToEnd(() => ({ after: Promise.resolve(), answer: () => ({ error: "busy" }) }), "solana", 9, 1n, ac.signal)).end, "down");
  assert.equal((await depositToEnd(() => ({ after: Promise.resolve(), answer: () => ({ result: { stage: "filled" } }) }), "solana", 9, 1n, ac.signal)).end, "filled");
  // a sent answer whose end never comes: the stop reads down
  const stop = new AbortController();
  const hang = depositToEnd(() => ({ after: Promise.resolve(), answer: () => ({ result: { stage: "sent" } }) }), "solana", 9, 1n, stop.signal);
  stop.abort();
  assert.equal((await hang).end, "down");
});

test("Solana's reads: U_X's finalized balance per RPC, the costs at today's rent, the deadline on both clocks, the status for U_X and U_{s,i}", async () => {
  const { solanaPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const { DEPOSIT_STATUS_URL } = await import("../../wallet/src/deposit/follow.ts");
  const { base58 } = await import("@scure/base");
  const rentData = new Uint8Array(17);
  new DataView(rentData.buffer).setBigUint64(0, 5_080n, true);
  new DataView(rentData.buffer).setFloat64(8, 1, true);
  const calls: [string, unknown][] = [];
  const rpcOf = (url: string, bal: number, time: number) => {
    const f = (async (method: string, params: unknown[]) => {
      calls.push([method, params[1] ?? params[0]]);
      if (method === "getBalance") return (params[1] as { commitment?: string })?.commitment === "finalized" ? { context: { slot: 9 }, value: bal } : { context: { slot: 9 }, value: 10 ** 12 };
      if (method === "getAccountInfo") return { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [Buffer.from(rentData).toString("base64"), "base64"], lamports: 1 } };
      if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: base58.encode(new Uint8Array(32).fill(3)), lastValidBlockHeight: 10 } };
      if (method === "getFeeForMessage") return { context: { slot: 1 }, value: 5_000 };
      if (method === "getSlot") return 77;
      if (method === "getBlockTime") return time;
      throw new Error(method);
    }) as unknown as import("../../kit/src/trade/solana/send.ts").SolanaRpc;
    Object.defineProperty(f, "url", { value: url });
    return f;
  };
  const status = (refundTo: string) => (async (url: string) => {
    assert.ok(String(url).startsWith(DEPOSIT_STATUS_URL));
    return Response.json({ status: "SUCCESS", quoteResponse: { quote: { depositAddress: F.address }, quoteRequest: { recipient: F.u, refundTo } }, swapDetails: { amountOut: "20000000" } });
  }) as typeof fetch;
  const d = solanaPoolFollowDeps({ rpcs: [rpcOf("https://a.example", 30, 2_000), rpcOf("https://b.example", 40, 1_000)], program: base58.encode(new Uint8Array(32).fill(7)), deposit: async () => ({ end: "filled", txs: [] }), fetch: status(F.refund_id) });
  const U = base58.encode(new Uint8Array(32).fill(5));
  const f = { ...F, u: U, deadline_ms: 1_500_000 };
  assert.deepEqual(await d.balances(f), [30n, 40n]);
  assert.deepEqual(await d.costs(f), { floor: 13_586_400n, perRung: 2_936_160n, keep: 650_240n });
  assert.equal(await d.past(f), false, "one RPC's finalized clock is still before the deadline");
  assert.equal(await d.past({ ...f, deadline_ms: 999_000 }), true);
  const ok = solanaPoolFollowDeps({ rpcs: [rpcOf("https://a.example", 0, 0), rpcOf("https://b.example", 0, 0)], program: base58.encode(new Uint8Array(32).fill(7)), deposit: async () => ({ end: "filled", txs: [] }), fetch: status(F.refund_id) });
  assert.deepEqual(await ok.status(F, new AbortController().signal), { status: "SUCCESS", delivered: 20_000_000n });
  const bad = solanaPoolFollowDeps({ rpcs: [rpcOf("https://a.example", 0, 0), rpcOf("https://b.example", 0, 0)], program: base58.encode(new Uint8Array(32).fill(7)), deposit: async () => ({ end: "filled", txs: [] }), fetch: status(F.u) });
  assert.equal(await bad.status(F, new AbortController().signal), null, "a status whose refund is not U_{s,i} is no read");
});

test("review L1: after REFUNDED a stale PENDING_DEPOSIT past the deadline never steps the stage back to quote_checked or expired", async () => {
  const w = world(
    [
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [0n, 0n], status: "PENDING_DEPOSIT", past: true },
      { bal: [0n, 0n], status: "PENDING_DEPOSIT", past: true },
    ],
    // the refund read under U_{s,i} on both RPCs, not moved yet (pool-deposit-stages review P2: refunded needs that read)
    { refund: async () => "held" },
  );
  await followPoolQuote(F, w.deps);
  assert.deepEqual(w.stages, ["refunded"]);
});

test("review L1: after the refund's move a stale KNOWN_DEPOSIT_TX never steps refund_move back to waiting", async () => {
  const w = world([{ bal: [0n, 0n], status: "REFUNDED" }, { bal: [0n, 0n], status: "KNOWN_DEPOSIT_TX" }, { bal: [0n, 0n], status: "REFUNDED" }], { refund: async () => "moved" });
  await followPoolQuote(F, w.deps);
  assert.deepEqual(w.stages, ["refunded", "refund_move"]);
});

test("review L2: the costs are read only once U_X holds at least the least rung", async () => {
  const w = world([
    { bal: [0n, 0n], status: "PENDING_DEPOSIT" },
    { bal: [SOL_LADDER.min - 1n, SOL_LADDER.min], status: "PROCESSING" },
    { bal: [FLOOR, FLOOR], status: "SUCCESS", past: true },
  ]);
  // each costs read with the lower balance of its round
  const seen: bigint[] = [];
  let low = 0n;
  const bal = w.deps.balances, read = w.deps.costs;
  w.deps.balances = async (f) => {
    const r = await bal(f);
    low = r[0] < r[1] ? r[0] : r[1];
    return r;
  };
  w.deps.costs = (f) => (seen.push(low), read(f));
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.ok(seen.length > 0 && seen.every((l) => l >= SOL_LADDER.min), seen.join(","));
});

test("pool-deposit-stages: the follower writes since_ms at the first stage that saw a send and refunded from the refund on, and the app reads each on its stages", async () => {
  const { poolFollows } = await import("../src/pool-deposit-follow.ts");
  const { opOf } = await import("../src/state.ts");
  const rows = new Map<string, unknown>();
  const seen: unknown[] = [];
  const store = {
    get: async (_s: "ops", k: string) => rows.get(k),
    keys: async () => [...rows.keys()],
    update: async (_s: "ops", k: string, change: (v: unknown) => unknown) => {
      const v = change(rows.get(k));
      if (v !== undefined) rows.set(k, v), seen.push(opOf(k, v));
      return rows.get(k);
    },
  };
  let asked = 0;
  const w = world(
    [
      { bal: [0n, 0n], status: "PENDING_DEPOSIT" },
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [FLOOR, FLOOR], status: "REFUNDED" },
      { bal: [0n, 0n], status: "REFUNDED", past: true },
    ],
    { refund: async () => (++asked === 1 ? "moved" : "wait") },
  );
  let clock = 100;
  const host = poolFollows({ store: async () => store, deps: () => w.deps, decimals: () => 9, locks: () => null, now: () => clock++ });
  const quote = { deposit_address: "DEPOSIT", origin_asset: "nep141:base-usdc", min_amount_out: "0.02", deadline: "2026-11-08T06:00:00.000Z" };
  await host.quoted("op-r", "solana", quote, { scope: 777n, index: 3, wallet: "U_X", refundId: "ab".repeat(32) });
  await host.idle();
  const sent = seen.map((o) => {
    const { id: _i, kind: _k, txs: _t, chain, created_ms, ...rest } = o as Record<string, unknown>;
    assert.equal(chain, "solana");
    // the record's own time, sent on every write (kit 1.9 OpDetail, card kit-portfolio-reads)
    assert.equal(created_ms, (rows.get("op-r") as { created_ms: number }).created_ms);
    return rest;
  });
  // since_ms is the clock at the first stage past a send (refunded here), kept after; refunded only on the refund's legs
  const t = (sent.find((o) => o.stage === "refunded") as { since_ms: number }).since_ms;
  assert.ok(t > 100, "a time from the host's clock");
  assert.deepEqual(sent, [
    { stage: "quote_checked" },
    { stage: "refunded", since_ms: t },
    { stage: "refund_move", since_ms: t, refunded: true },
    { stage: "in_pool", since_ms: t, refunded: true },
    { stage: "in_pool", since_ms: t, refunded: true },
  ]);
  const last = rows.get("op-r") as Record<string, unknown>;
  assert.equal(last.final, true);
  assert.equal(last.refunded, true);
});

test("pool-deposit-stages: withStage sets since_ms once at the first stage past a send, never on quote_checked or expired", async () => {
  const { withStage } = await import("../src/pool-deposit-follow.ts");
  const op = { kind: "pool_deposit" as const, stage: "quote_checked" as const, txs: [], created_ms: 1, follow: F };
  assert.deepEqual(withStage(op, "expired", 5), { ...op, stage: "expired" });
  const w = withStage(withStage(op, "expired", 5), "waiting", 6);
  assert.equal(w.since_ms, 6, "a late send after expired");
  assert.equal(withStage(w, "in_pool", 9).since_ms, 6, "kept, never moved");
  assert.equal(withStage(w, "in_pool", 9).refunded, undefined);
  assert.equal(withStage(op, "in_pool", 3).since_ms, 3, "the chain read first: in_pool with no status seen still has its time");
  assert.equal(withStage(op, "refund_move", 3).refunded, true);
});

// ------------------------------------------------------------------------------------------------ review P2, P3 1
/** The page's follower over a store, posting each write through opOf as the app reads it. */
async function follower(rows: Map<string, unknown>, w: ReturnType<typeof world>, clock = { t: 1000 }) {
  const { poolFollows } = await import("../src/pool-deposit-follow.ts");
  const { opOf } = await import("../src/state.ts");
  const sent: Record<string, unknown>[] = [];
  const store = {
    get: async (_s: "ops", k: string) => rows.get(k),
    keys: async () => [...rows.keys()],
    update: async (_s: "ops", k: string, change: (v: unknown) => unknown) => {
      const v = change(rows.get(k));
      if (v !== undefined) {
        rows.set(k, v);
        const { id: _i, kind: _k, txs: _t, chain: _c, created_ms, ...rest } = opOf(k, v) as Record<string, unknown>;
        // the record's own time rides on every op it sends (kit 1.9 OpDetail, card kit-portfolio-reads)
        assert.equal(created_ms, (v as { created_ms?: unknown }).created_ms);
        sent.push(rest);
      }
      return rows.get(k);
    },
  };
  // the host's own signal runs the follow: the world's rounds running out stop the host, as a sign out would
  const deps = { ...w.deps, sleep: async (ms: number, sig: AbortSignal) => (await w.deps.sleep(ms, sig), w.deps.signal.aborted ? host.stop() : undefined) };
  const host = poolFollows({ store: async () => store, deps: () => deps, decimals: () => 9, locks: () => null, now: () => clock.t++ });
  return { host, sent };
}
const QUOTE = { deposit_address: "DEPOSIT", origin_asset: "nep141:base-usdc", min_amount_out: "0.02", deadline: "2026-11-08T06:00:00.000Z" };
const UX = { scope: 777n, index: 3, wallet: "U_X", refundId: "ab".repeat(32) };
const legacy = (stage: string) => new Map<string, unknown>([["op-old", { kind: "pool_deposit", stage, txs: [], created_ms: 400, follow: F }]]);

test("review P2: the helper's REFUNDED with nothing read under U_{s,i} shows no refund; the real delivery lands in_pool with no refunded", async () => {
  const asks: string[] = [];
  const w = world(
    [
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [FLOOR, FLOOR], status: "SUCCESS" },
      { bal: [0n, 0n], status: "SUCCESS", past: true },
    ],
    { refund: async () => (asks.push("none"), "none") },
  );
  const rows = new Map<string, unknown>();
  const { host, sent } = await follower(rows, w);
  await host.quoted("op-x", "solana", QUOTE, UX);
  await host.idle();
  assert.ok(asks.length >= 1, "the chain was read for the refund");
  assert.ok(!sent.some((o) => o.stage === "refunded" || o.stage === "refund_move" || "refunded" in o), JSON.stringify(sent));
  assert.deepEqual(sent.at(-1), { stage: "in_pool", since_ms: (sent.find((o) => o.stage === "in_pool") as { since_ms: number }).since_ms });
  assert.equal((rows.get("op-x") as { refunded?: true }).refunded, undefined, "the record carries no refund either");
});

test("review P2: an unsent quote with the helper answering REFUNDED and nothing under U_X or U_{s,i}: expired past its deadline, never refunded", async () => {
  const w = world([{ bal: [0n, 0n], status: "REFUNDED", past: true }], { refund: async () => "none" });
  await followPoolQuote(F, w.deps);
  assert.deepEqual(w.stages, ["expired"]);
  // a read that did not count ("wait": the two RPCs did not agree) is read again before expired is shown: here the next
  // read finds the refund held under U_{s,i}, so the quote that was sent never shows expired on the way (delta review)
  let n = 0;
  const v = world([{ bal: [0n, 0n], status: "REFUNDED", past: true }], { refund: async () => (++n === 1 ? "wait" : "held") });
  await followPoolQuote(F, v.deps);
  assert.deepEqual(v.stages, ["refunded"]);
  assert.ok(n >= 2, "read again after the wait");
  // and a wait then nothing under U_{s,i}: expired only after the read that found nothing
  let m = 0;
  const x = world([{ bal: [0n, 0n], status: "REFUNDED", past: true }], { refund: async () => (++m === 1 ? "wait" : "none") });
  await followPoolQuote(F, x.deps);
  assert.deepEqual(x.stages, ["expired"]);
});

test("review P2: the refund read under U_{s,i} on both RPCs and not moved (held) shows refunded; a later move shows refund_move", async () => {
  let n = 0;
  const w = world(
    [{ bal: [0n, 0n], status: "REFUNDED" }, { bal: [0n, 0n], status: "REFUNDED" }, { bal: [0n, 0n], status: "REFUNDED" }],
    { refund: async () => (++n === 1 ? "held" : "moved") },
  );
  await followPoolQuote(F, w.deps);
  assert.deepEqual(w.stages, ["refunded", "refund_move"]);
});

test("review P3 1: a record of release-94 to 107 past quote_checked gets no since_ms on a reload; a legacy refund_move keeps refunded into the pool", async () => {
  const transit = legacy("in_transit");
  const a = await follower(transit, world([{ bal: [FLOOR, FLOOR], status: "SUCCESS" }, { bal: [0n, 0n], status: "SUCCESS", past: true }]), { t: 900_000 });
  await a.host.settle();
  await a.host.idle();
  assert.deepEqual(a.sent, [{ stage: "in_pool" }, { stage: "in_pool" }], "no reload time as the send's");
  const move = legacy("refund_move");
  const b = await follower(move, world([{ bal: [FLOOR, FLOOR], status: "REFUNDED" }, { bal: [0n, 0n], status: "REFUNDED", past: true }], { refund: async () => "wait" }), { t: 900_000 });
  await b.host.settle();
  await b.host.idle();
  assert.deepEqual(b.sent, [{ stage: "in_pool", refunded: true }, { stage: "in_pool", refunded: true }]);
});

test("review P2 with P3 1: a legacy refunded record (the helper's word, no refunded fact) is read again from quote_checked, untimed; refunded again only on the chain's read", async () => {
  const { resumeOf } = await import("../src/pool-deposit-follow.ts");
  const old = legacy("refunded");
  const a = await follower(old, world([{ bal: [0n, 0n], status: "REFUNDED", past: true }], { refund: async () => "none" }));
  await a.host.settle();
  await a.host.idle();
  assert.deepEqual(a.sent, [{ stage: "quote_checked" }, { stage: "expired" }], "the refund the chain never read is gone; nothing sent: expired");
  const again = legacy("refunded");
  const b = await follower(again, world([{ bal: [0n, 0n], status: "REFUNDED" }], { refund: async () => "held" }));
  await b.host.settle();
  await b.host.idle();
  assert.deepEqual(b.sent, [{ stage: "quote_checked" }, { stage: "refunded" }], "read under U_{s,i}: refunded again, with no made-up send time");
  // a refunded record this build wrote (its refunded fact set at the chain's read) is followed on as it is
  const own = { kind: "pool_deposit" as const, stage: "refunded" as const, txs: [], created_ms: 1, follow: F, since_ms: 5, refunded: true as const };
  assert.equal(resumeOf(own), own);
});

// ------------------------------------------------------------------------------- card pool-deposit-op-txs

const { base58: b58 } = await import("@scure/base");
const sig = (n: number) => b58.encode(new Uint8Array(64).fill(n));
const sol = (n: number) => ({ chain: "solana" as const, hash: sig(n) });

test("pool-deposit-op-txs: depositToEnd yields the txs of both answers: the direct answer's landed txs, and the sent answer's txs once its end comes as a stage-only progress event", async () => {
  const { depositToEnd } = await import("../src/pool-deposit-follow.ts");
  const ac = new AbortController();
  // the direct answer (no RPC took a send before the run's end): its landed txs
  const direct = () => ({ after: Promise.resolve(), answer: () => ({ result: { stage: "filled", txs: [sol(1), sol(2)] } }) });
  assert.deepEqual(await depositToEnd(direct, "solana", 9, 1n, ac.signal), { end: "filled", txs: [sol(1), sol(2)] });
  // the sent answer at its first send, the end as progress with no tx (pool-deposit.ts poolDepositKind)
  const sent = (end: string) => (_p: unknown, ctx: { progress(s: string): void }) => ({
    running: true,
    after: Promise.resolve().then(() => setTimeout(() => (ctx.progress("sent"), ctx.progress(end)), 1)),
    answer: () => ({ result: { stage: "sent", txs: [sol(3)] } }),
  });
  assert.deepEqual(await depositToEnd(sent("part_filled"), "solana", 9, 1n, ac.signal), { end: "part_filled", txs: [sol(3)] });
  assert.deepEqual(await depositToEnd(sent("not_landed"), "solana", 9, 1n, ac.signal), { end: "not_landed", txs: [sol(3)] });
  // a refusal has none; a tx of another shape is not taken
  assert.deepEqual(await depositToEnd(() => ({ error: "not_funded" }), "solana", 9, 1n, ac.signal), { end: "not_funded", txs: [] });
  const odd = () => ({ after: Promise.resolve(), answer: () => ({ result: { stage: "filled", txs: [{ chain: "solana", hash: 7 }, { chain: "near", hash: sig(4) }, sol(5)] } }) });
  assert.deepEqual(await depositToEnd(odd, "solana", 9, 1n, ac.signal), { end: "filled", txs: [sol(5)] });
});

test("pool-deposit-op-txs: the follow writes only the txs its two-RPC read returns, after each landed deposit and once more before its end", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  const heardAsked: string[][] = [];
  const written: string[] = [];
  w.deps.deposit = async (_f, amount) => (w.deposits.push(amount), { end: "filled", txs: [sol(1)] });
  // the read: what the chain shows on both RPCs (sol(1) heard and read, sol(2) only listed, a third run's heard tx not read)
  w.deps.landed = async (_f, heard) => (heardAsked.push(heard.map((t) => t.hash)), [sol(1), sol(2)]);
  w.deps.txs = async (t) => void written.push(...t.map((x) => x.hash));
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.deepEqual(heardAsked, [[sig(1)], []], "after the deposit with its heard txs, then once at the end");
  assert.deepEqual(written, [sig(1), sig(2)], "each written once");
  // a read that fails at the end is no end: read again next round
  const v = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  let fail = true, reads = 0;
  v.deps.landed = async (_f, heard) => {
    if (heard.length === 0) reads++;
    if (heard.length === 0 && fail) throw ((fail = false), new Error("one RPC down"));
    return [];
  };
  v.deps.txs = async () => {};
  // inside the quote's deadline and the margin on the device's clock
  v.deps.now = () => F.deadline_ms;
  assert.equal(await followPoolQuote(F, v.deps), "in_pool");
  assert.equal(reads, 2, "read again, then the end");
});

test("review P2-b: an end whose tx read keeps failing is read again until the quote's deadline, or the follow's first end, and the margin are past on the device's clock, then ends with the txs read so far", async () => {
  const { POOL_TX_READ_MARGIN_MS } = await import("../src/pool-deposit-follow.ts");
  // the device's clock starts at `start` and moves on by `step` at each round's sleep
  const run = async (start: number, step: number, f = F) => {
    const w = world([
      { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
      { bal: [0n, 0n], status: "SUCCESS", past: true },
    ]);
    const written: string[] = [];
    let clock = start;
    w.deps.deposit = async () => ({ end: "filled", txs: [sol(1)] });
    w.deps.landed = async (_f, heard) => {
      if (heard.length === 0) throw new Error("429");
      return [sol(1)];
    };
    w.deps.txs = async (t) => void written.push(...t.map((x) => x.hash));
    w.deps.now = () => clock;
    const s0 = w.deps.sleep;
    w.deps.sleep = async (ms, sg) => ((clock += step), s0(ms, sg));
    const end = await followPoolQuote(f, w.deps);
    return { end, aborted: w.deps.signal.aborted, written };
  };
  assert.equal((await run(F.deadline_ms, 0)).aborted, true, "inside the margin: read again each round, never ended by itself");
  const past = await run(F.deadline_ms, POOL_TX_READ_MARGIN_MS + 1);
  assert.deepEqual(past, { end: "in_pool", aborted: false, written: [sig(1)] }, "past it: the end, with the txs read so far");
  // a quote with deadline_ms 0 and reads that never answer: it ends
  assert.deepEqual(await run(Date.now(), POOL_TX_READ_MARGIN_MS + 1, { ...F, deadline_ms: 0 }), { end: "in_pool", aborted: false, written: [sig(1)] });
});

test("re-check P2: a follow first at its end long past the quote's deadline (the page opened late) still reads a failing tx read again: the margin runs from its own first end", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  let fail = true, reads = 0;
  w.deps.landed = async (_f, heard) => {
    if (heard.length === 0) reads++;
    if (heard.length === 0 && fail) throw ((fail = false), new Error("429"));
    return [];
  };
  w.deps.txs = async () => {};
  w.deps.deposit = async () => ({ end: "filled", txs: [sol(1)] });
  w.deps.now = () => F.deadline_ms + 11 * 60_000;
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.equal(reads, 2, "not ended on the first round: read again, then the end");
});

test("pool-deposit-op-txs: the page's follower merges the txs into the op once each, and the app is sent them", async () => {
  const { poolFollows } = await import("../src/pool-deposit-follow.ts");
  const { opOf } = await import("../src/state.ts");
  const rows = new Map<string, unknown>();
  const store = {
    get: async (_s: "ops", k: string) => rows.get(k),
    keys: async () => [...rows.keys()],
    update: async (_s: "ops", k: string, change: (v: unknown) => unknown) => {
      const v = change(rows.get(k));
      if (v !== undefined) rows.set(k, v);
      return rows.get(k);
    },
  };
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS" },
    { bal: [FLOOR, FLOOR], status: "SUCCESS" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  let n = 0;
  w.deps.deposit = async () => ({ end: "filled", txs: [sol(++n)] });
  w.deps.landed = async (_f, heard) => [...heard, sol(1)];
  // each round yields a turn, and the follow is stopped at 2 s, so a build that never ends it fails here and never hangs
  const s0 = w.deps.sleep;
  w.deps.sleep = async (ms, sg) => (await new Promise((r) => setTimeout(r, 1)), s0(ms, sg));
  const host = poolFollows({ store: async () => store, deps: () => w.deps, decimals: () => 9, locks: () => null, now: () => 5 });
  const quote = { deposit_address: "DEPOSIT", origin_asset: "nep141:base-usdc", min_amount_out: "0.02", deadline: "2026-11-08T06:00:00.000Z" };
  await host.quoted("op-1", "solana", quote, { scope: 777n, index: 3, wallet: "U_X", refundId: "ab".repeat(32) });
  await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 2_000))]);
  host.stop();
  await host.idle();
  const op = rows.get("op-1") as { stage: string; txs: unknown[] };
  assert.equal(op.stage, "in_pool");
  assert.deepEqual(op.txs, [sol(1), sol(2)]);
  assert.deepEqual(opOf("op-1", op)?.txs, [sol(1), sol(2)], "the app is sent them");
});

/** One Solana RPC: U_X's finalized signatures (`listed`) and each tx's finalized read (`txs`: hash -> answer or null). */
function solRpc(listed: { signature: string; err: unknown }[], txs: Record<string, unknown>) {
  const asked: [string, unknown][] = [];
  const f = (async (method: string, params: unknown[]) => {
    asked.push([method, params]);
    if (method === "getSignaturesForAddress") return listed;
    if (method === "getTransaction") return txs[params[0] as string] ?? null;
    throw new Error(method);
  }) as unknown as import("../../kit/src/trade/solana/send.ts").SolanaRpc;
  return { f, asked };
}

test("pool-deposit-op-txs: Solana's read shows a tx only when both RPCs read it finalized, paid by U_X, with no error, a deposit instruction of the pool program", async () => {
  const { solanaPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const { SOLANA_POOL_TAG_DEPOSIT } = await import("../../kit/src/trade/solana/pool-deposit.ts");
  const U = b58.encode(new Uint8Array(32).fill(5)), PROGRAM = b58.encode(new Uint8Array(32).fill(7)), OTHER = b58.encode(new Uint8Array(32).fill(8));
  const DEPOSIT_DATA = b58.encode(Uint8Array.of(SOLANA_POOL_TAG_DEPOSIT, ...new Uint8Array(8).fill(1), ...new Uint8Array(32).fill(2)));
  const tx = (s: string, o: { payer?: string; err?: unknown; program?: string; data?: string } = {}) => ({
    slot: 9,
    meta: { err: o.err ?? null },
    transaction: { signatures: [s], message: { header: { numRequiredSignatures: 1 }, accountKeys: [o.payer ?? U, o.program ?? PROGRAM], instructions: [{ programIdIndex: 1, accounts: [0], data: o.data ?? DEPOSIT_DATA }] } },
  });
  const good = (n: number) => [sig(n), tx(sig(n))] as const;
  const answers = Object.fromEntries([
    good(1), good(2), good(3),
    [sig(4), tx(sig(4), { payer: OTHER })],
    [sig(5), tx(sig(5), { err: { InstructionError: [0, "Custom"] } })],
    [sig(6), tx(sig(6), { program: OTHER })],
    good(7),
    // review P3 3: the pool program's other instructions (a withdraw's tag) are no deposit
    [sig(8), tx(sig(8), { data: b58.encode(Uint8Array.of(SOLANA_POOL_TAG_DEPOSIT + 1, ...new Uint8Array(40))) })],
    [sig(9), tx(sig(9), { data: "" })],
  ]);
  const listed: { signature: string; err: unknown }[] = [1, 3, 4, 5, 6, 8, 9].map((n): { signature: string; err: unknown } => ({ signature: sig(n), err: null })).concat([{ signature: sig(7), err: { InstructionError: [0, "Custom"] } }]);
  const a = solRpc(listed, answers);
  const b = solRpc(listed.slice(0, 1), answers);
  const d = solanaPoolFollowDeps({ rpcs: [a.f, b.f], program: PROGRAM, deposit: async () => ({ end: "filled", txs: [] }) });
  const f = { ...F, u: U };
  // sig(2) is heard only (not listed yet): read on both, shown. sig(1) and sig(3) listed and read on both: shown
  assert.deepEqual(await d.landed!(f, [sol(2)]), [sol(2), sol(1), sol(3)]);
  for (const [m, p] of a.asked) {
    if (m === "getSignaturesForAddress") assert.deepEqual(p, [U, { commitment: "finalized", limit: 1000 }]);
    if (m === "getTransaction") assert.deepEqual((p as unknown[])[1], { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 });
  }
  // a hash already shown is not read again; review P3 2: nor one both RPCs answered as no deposit
  a.asked.length = 0;
  b.asked.length = 0;
  assert.deepEqual(await d.landed!(f, [], new Set([sig(1), sig(3)])), []);
  for (const r of [a, b]) assert.deepEqual(r.asked.filter(([m]) => m === "getTransaction"), [], "nothing read again");
  // a listing that fails on one RPC is no read: it throws, read again next round
  const down = solanaPoolFollowDeps({ rpcs: [a.f, (async () => { throw new Error("down"); }) as never], program: PROGRAM, deposit: async () => ({ end: "filled", txs: [] }) });
  await assert.rejects(down.landed!(f, []));
});

test("review P2-a: a candidate whose read throws or answers null on either RPC is no answer: landed throws (read again), never a deposit with no tx", async () => {
  const { solanaPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const { SOLANA_POOL_TAG_DEPOSIT } = await import("../../kit/src/trade/solana/pool-deposit.ts");
  const U = b58.encode(new Uint8Array(32).fill(5)), PROGRAM = b58.encode(new Uint8Array(32).fill(7)), OTHER = b58.encode(new Uint8Array(32).fill(8));
  const data = b58.encode(Uint8Array.of(SOLANA_POOL_TAG_DEPOSIT, ...new Uint8Array(40)));
  const tx = (s: string, payer = U) => ({ slot: 9, meta: { err: null }, transaction: { signatures: [s], message: { accountKeys: [payer, PROGRAM], instructions: [{ programIdIndex: 1, accounts: [0], data }] } } });
  const listed = [{ signature: sig(11), err: null }];
  const f = { ...F, u: U };
  const throwing = (async (method: string) => {
    if (method === "getSignaturesForAddress") return listed;
    throw new Error("429");
  }) as never;
  for (const [what, other] of [
    ["not indexed yet (null)", solRpc(listed, {}).f],
    ["a 429", throwing],
    ["another payer (the RPCs disagree)", solRpc(listed, { [sig(11)]: tx(sig(11), OTHER) }).f],
  ] as const) {
    const first = solRpc(listed, { [sig(11)]: tx(sig(11)) }).f;
    await assert.rejects(solanaPoolFollowDeps({ rpcs: [first, other], program: PROGRAM, deposit: async () => ({ end: "filled", txs: [] }) }).landed!(f, []), what);
    await assert.rejects(solanaPoolFollowDeps({ rpcs: [other, first], program: PROGRAM, deposit: async () => ({ end: "filled", txs: [] }) }).landed!(f, []), `${what}, the other way`);
  }
  // both answered and both agree it is no deposit: rejected, and not read again
  const no = solRpc(listed, { [sig(11)]: tx(sig(11), OTHER) });
  const d = solanaPoolFollowDeps({ rpcs: [no.f, no.f], program: PROGRAM, deposit: async () => ({ end: "filled", txs: [] }) });
  assert.deepEqual(await d.landed!(f, []), []);
  no.asked.length = 0;
  assert.deepEqual(await d.landed!(f, []), []);
  assert.deepEqual(no.asked.map(([m]) => m), ["getSignaturesForAddress", "getSignaturesForAddress"]);
});

test("pool-deposit-op-txs: past its deadline the follow ends only once a refund move's heard tx is settled (read final, or past the move's deadline)", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  const answers = [false, false, true];
  let asked = 0;
  const refund = Object.assign(async () => "none" as const, { settle: async () => answers[asked++] ?? true });
  w.deps.refund = refund;
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.equal(asked, 3, "read again each round until settled");
  // a carry with no settle (none given) ends as before
  const v = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  v.deps.refund = async () => "none";
  assert.equal(await followPoolQuote(F, v.deps), "in_pool");
  assert.ok(v.sleeps.length <= 2);
});

// card evm-deposit-route-mainnet: the follow's reads on Base and Robinhood (evmPoolFollowDeps). U_X's balance is polled on
// one reader (`wallet`: the helper's /v1/rpc route on mainnet, decision M359: a one-time account's holdings never go to a
// public provider from the device), or the pool's two RPCs with none (a testnet page); the costs are the quote's floor
// read now on the pool's two RPCs (names no account); the deadline on both RPCs' clocks; the status as Solana's
test("evm-deposit-route-mainnet: EVM's reads: U_X polled on the one wallet reader (the pool's RPCs never name it), the floor and its per-rung cost on both RPCs, keep 0, the deadline on both clocks, the status for U_X and U_{s,i}", async () => {
  const { evmPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const { evmPoolDepositFloor } = await import("../src/pool-deposit-quote.ts");
  const { EVM_DEPOSIT_PRIORITY_CAP } = await import("../src/pool-deposit-evm.ts");
  const { EVM_LADDER } = await import("../../wallet/src/pool/evm.ts");
  const { DEPOSIT_STATUS_URL } = await import("../../wallet/src/deposit/follow.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  const U = "0x229cFb760A282C0F9941923623a435b4a46FB463";
  const named: string[] = [];
  // each RPC's latest block (its clock): block n's time is (n - 99) x 1,000 s, the same block on both
  const rpcOf = (who: string, bal: bigint, time: number) => (async (method: string, params: readonly unknown[]) => {
    if (JSON.stringify(params).toLowerCase().includes(U.slice(2).toLowerCase())) named.push(`${who} ${method}`);
    if (method === "eth_getBalance") return "0x" + bal.toString(16);
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? 99 + Math.max(1, time / 1000) : Number(params[0]);
      return { number: "0x" + n.toString(16), hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: "0x" + ((n - 99) * 1000).toString(16), baseFeePerGas: "0x4c4b40" };
    }
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      if (data === sel("currentTreeDepth()")) return word(3n);
      if (data === sel("currentLabelTreeDepth()")) return word(2n);
      return word(data.startsWith("0xf1c7a58b") ? 7_000_000_000n : 0n);
    }
    throw new Error(`unmocked ${method}`);
  }) as unknown as import("../../wallet/src/pool/evm.ts").EvmRpc;
  const status = (refundTo: string) => (async (url: string) => {
    assert.ok(String(url).startsWith(DEPOSIT_STATUS_URL));
    return Response.json({ status: "SUCCESS", quoteResponse: { quote: { depositAddress: F.address }, quoteRequest: { recipient: U, refundTo } }, swapDetails: { amountOut: "2000000000000000" } });
  }) as typeof fetch;
  const pin = { network: "base", pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n } as const;
  const f = { ...F, chain: "base" as const, u: U, deadline_ms: 1_500_000 };
  const deposit = async () => ({ end: "filled" as const, txs: [] });
  // mainnet's shape: the wallet reader polls U_X, once, its reading as both
  const d = evmPoolFollowDeps({ rpcs: [rpcOf("pool-a", 30n, 2_000), rpcOf("pool-b", 40n, 1_000)], pin, wallet: rpcOf("helper", 55n, 0), deposit, fetch: status(F.refund_id) });
  assert.deepEqual(await d.balances(f), [55n, 55n]);
  const floor = evmPoolDepositFloor({ baseFee: 5_000_000n, tip: EVM_DEPOSIT_PRIORITY_CAP, l1Fee: 7_000_000_000n, stateDepth: 3n, labelDepth: 2n });
  assert.deepEqual(await d.costs(f), { floor, perRung: floor - EVM_LADDER.min, keep: 0n });
  assert.equal(d.ladder, EVM_LADDER);
  assert.equal(await d.past(f), false, "one RPC's clock is still before the deadline");
  assert.equal(await d.past({ ...f, deadline_ms: 999_000 }), true);
  assert.deepEqual(await d.status(f, new AbortController().signal), { status: "SUCCESS", delivered: 2_000_000_000_000_000n });
  assert.deepEqual(named, ["helper eth_getBalance"], "only the wallet reader named U_X");
  // a testnet page has no wallet reader: U_X's balance on each of the pool's RPCs
  const t = evmPoolFollowDeps({ rpcs: [rpcOf("pool-a", 30n, 2_000), rpcOf("pool-b", 40n, 1_000)], pin, deposit });
  assert.deepEqual(await t.balances(f), [30n, 40n]);
  // a status whose refund is not U_{s,i} is no read
  assert.equal(await evmPoolFollowDeps({ rpcs: [rpcOf("a", 0n, 0), rpcOf("b", 0n, 0)], pin, deposit, fetch: status(U) }).status(f, new AbortController().signal), null);
});

test("evm-deposit-route-mainnet: the follow on EVM's reads carries what U_X holds over the floor into the pool in one ask, and nothing under it", async () => {
  const { evmPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const { EVM_LADDER } = await import("../../wallet/src/pool/evm.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  let bal = 0n;
  const rpc = (async (method: string, params: readonly unknown[]) => {
    if (method === "eth_getBalance") return "0x" + bal.toString(16);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0x4c4b40" };
    if (method === "eth_call") return word((params[0] as { data: string }).data === sel("currentTreeDepth()") ? 3n : 0n);
    throw new Error(`unmocked ${method}`);
  }) as unknown as import("../../wallet/src/pool/evm.ts").EvmRpc;
  const pin = { network: "robinhood", pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n } as const;
  const asks: bigint[] = [];
  const d = evmPoolFollowDeps({ rpcs: [rpc, rpc], pin, wallet: rpc, deposit: async (_g, amount) => (asks.push(amount), (bal = 0n), { end: "filled", txs: [] }), fetch: (async () => Response.json({ status: "PENDING_DEPOSIT" })) as typeof fetch });
  const f = { ...F, chain: "robinhood" as const, u: "0x229cFb760A282C0F9941923623a435b4a46FB463" };
  const { floor, perRung } = await d.costs(f);
  // under the floor: nothing asked
  bal = floor - 1n;
  const ac = new AbortController();
  let rounds = 0;
  await followPoolQuote(f, { ...d, stage: async () => {}, signal: ac.signal, sleep: async () => void (++rounds >= 3 && ac.abort()) });
  assert.deepEqual(asks, []);
  // 0.0025 ETH and the per-rung cost of each rung it splits into: one ask of 0.0025 ETH (rungs 0.001 + 0.001 + 0.0005 at the EVM ladder)
  bal = 2_500_000_000_000_000n + 3n * perRung;
  const ac2 = new AbortController();
  await followPoolQuote(f, { ...d, stage: async () => {}, signal: ac2.signal, sleep: async () => ac2.abort() });
  assert.deepEqual(asks, [askOf(EVM_LADDER, 2_500_000_000_000_000n + 3n * perRung, perRung, 0n)]);
  assert.ok(asks[0]! >= EVM_LADDER.min);
});

// card evm-deposit-route-mainnet review P1: one reader's word (the helper's /v1/rpc on mainnet) only makes the page wait
// or starts a deposit the chain then checks; it never ends a follow. A three-rung deposit past the quote's deadline, the
// helper reading U_X as 0 once, twice, or forever from each round on: the follow never ends while either pool RPC holds
// one deposit's floor, and it always ends, every rung in the pool, once both read U_X under it.
test("evm-deposit-route-mainnet review P1: a helper that lies low once, twice or forever, at any round of a three-rung deposit, never ends the follow with a rung's worth in U_X", async () => {
  const { evmPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const { EVM_LADDER } = await import("../../wallet/src/pool/evm.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  type Rpc = import("../../wallet/src/pool/evm.ts").EvmRpc;
  const U = "0x229cFb760A282C0F9941923623a435b4a46FB463";
  const pin = { network: "robinhood", pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n } as const;
  const f = { ...F, chain: "robinhood" as const, u: U, deadline_ms: 1 };
  const run = async (lies: (round: number) => boolean) => {
    let chain = 0n;
    let round = 0;
    const rpc = ((who: "pool" | "helper") => (async (method: string, params: readonly unknown[]) => {
      if (method === "eth_getBalance") return "0x" + (who === "helper" && lies(round) ? 0n : chain).toString(16);
      if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x64", baseFeePerGas: "0x4c4b40" };
      if (method === "eth_call") return word((params[0] as { data: string }).data === sel("currentTreeDepth()") ? 3n : 0n);
      throw new Error(`unmocked ${method}`);
    })) as unknown as (who: "pool" | "helper") => Rpc;
    const landedRungs: bigint[] = [];
    let perRung = 0n;
    // the page's deposit: what the chain holds (it reads U_X itself), one rung of the ask per run, as one finality wait
    const deposit = async (_g: unknown, amount: bigint) => {
      const rungs = ladderSplit(EVM_LADDER, amount).notes;
      if (chain < rungs[0]! + perRung) return { end: "not_funded" as const, txs: [] };
      chain -= rungs[0]! + perRung;
      landedRungs.push(rungs[0]!);
      return { end: rungs.length > 1 ? ("part_filled" as const) : ("filled" as const), txs: [] };
    };
    const d = evmPoolFollowDeps({ rpcs: [rpc("pool"), rpc("pool")], pin, wallet: rpc("helper"), deposit: deposit as never, fetch: (async () => Response.json({ status: "SUCCESS" })) as typeof fetch });
    const { floor } = await d.costs(f);
    perRung = floor - EVM_LADDER.min;
    // 0.005 + 0.002 + 0.001 ETH, each with its cost
    chain = 8_000_000_000_000_000n + 3n * perRung;
    const ac = new AbortController();
    const end = await followPoolQuote(f, { ...d, stage: async () => {}, signal: ac.signal, sleep: async () => void (++round >= 40 && ac.abort()) });
    return { end, aborted: ac.signal.aborted, chain, floor, landedRungs };
  };
  const schedules: [string, (r: number) => boolean][] = [["never", () => false]];
  for (let at = 0; at < 8; at++) {
    schedules.push([`once at round ${at}`, (r) => r === at], [`twice from round ${at}`, (r) => r === at || r === at + 1], [`forever from round ${at}`, (r) => r >= at]);
  }
  for (const [name, lies] of schedules) {
    const r = await run(lies);
    if (name === "forever from round 0") {
      // nothing ever read over the floor: the page waits, the op open (a sign out or a closed page stops it, never final)
      assert.equal(r.aborted, true, name);
      assert.deepEqual(r.landedRungs, [], name);
      continue;
    }
    assert.equal(r.aborted, false, `${name}: the follow ends`);
    assert.equal(r.end, "in_pool", name);
    assert.ok(r.chain < r.floor, `${name}: ended with ${r.chain} in U_X, the floor ${r.floor}`);
    assert.deepEqual(r.landedRungs, [5_000_000_000_000_000n, 2_000_000_000_000_000n, 1_000_000_000_000_000n], name);
  }
});

// card evm-deposit-route-mainnet review P2a: a follow resumed (a reload) while a rung is landing: U_X already reads
// under the floor and the op's stage is in_transit. It reads the store's notes each round, and once a note of U_X's own
// reads landed (the deposit note at (s, i), or a second arrival: the middle of several rungs) it shows in_pool and ends
// past the deadline, instead of polling at in_transit for ever.
test("evm-deposit-route-mainnet review P2a: a reload while the only rung, or the middle one of several, is landing ends in_pool once the store holds a landed note of U_X's own", async () => {
  const { uxNoteLanded } = await import("../src/pool-deposit-follow.ts");
  const s = BigInt(F.s);
  const dep = (state: string) => ({ ref: { kind: "deposit" as const, s, i: F.i }, scope: s, state: state as never });
  const second = (n: number, state: string) => ({ ref: { kind: "second" as const, id: { id: "U" as const, s, i: F.i }, n }, scope: s, state: state as never });
  // the store's notes, round by round
  type Held = Parameters<typeof uxNoteLanded>[0][number];
  const resumed = async (byRound: Held[][]) => {
    const w = world([{ bal: [1_000n, 1_000n], status: "SUCCESS", past: true }]);
    let k = 0;
    const stages: string[] = [];
    const ac = new AbortController();
    const end = await followPoolQuote(F, { ...w.deps, noted: async () => uxNoteLanded(byRound[Math.min(k, byRound.length - 1)]!, F), stage: async (x) => void stages.push(x), signal: ac.signal, sleep: async () => void (++k >= 20 && ac.abort()) }, "in_transit");
    return { end, aborted: ac.signal.aborted, stages, rounds: k };
  };
  // the only rung: INCOMING for three rounds, then UNSPENT
  const one = await resumed([[dep("INCOMING")], [dep("INCOMING")], [dep("INCOMING")], [dep("UNSPENT")]]);
  assert.equal(one.aborted, false, "the follow ends");
  assert.equal(one.end, "in_pool");
  assert.deepEqual(one.stages, ["in_pool"]);
  assert.equal(one.rounds, 3);
  // the middle of several: the first rung landed, the second landing
  const mid = await resumed([[dep("UNSPENT"), second(0, "INCOMING")]]);
  assert.equal(mid.aborted, false);
  assert.equal(mid.end, "in_pool");
  assert.equal(mid.rounds, 1, "landed once its own SUCCESS is read (re-read P2-1), the round after its first");
  // never: no landed note of its own (another index, another scope, one still planned or landing): read on, no end
  const other = { ref: { kind: "deposit" as const, s, i: F.i + 1 }, scope: s, state: "UNSPENT" as never };
  const elsewhere = { ref: { kind: "deposit" as const, s: s + 1n, i: F.i }, scope: s + 1n, state: "UNSPENT" as never };
  const none = await resumed([[other, elsewhere, dep("PLANNED"), second(0, "INCOMING")]]);
  assert.equal(none.aborted, true);
  assert.deepEqual(none.stages, []);
});

// card evm-deposit-route-mainnet re-read P2-1: U_X is per (s, i), not per quote. A landed note of U_X's counts for a
// quote only once that quote's own status read SUCCESS, or its stage is in_pool already; on every chain (F is Solana's)
test("evm-deposit-route-mainnet re-read P2-1: a neighbour's landed note never shows an unpaid or expired quote in the pool, and never ends a paid one before its own late delivery is carried", async () => {
  const run = async (rounds: Round[], from: Parameters<typeof followPoolQuote>[2] = "quote_checked") => {
    const w = world(rounds);
    let reads = 0;
    const status = w.deps.status;
    const end = await followPoolQuote(F, { ...w.deps, noted: async () => true, status: async (f, sig) => (reads++, status(f, sig)) }, from);
    return { end, stages: w.stages, deposits: w.deposits, reads };
  };
  // an unpaid quote beside a landed one stays as it is: its status is read, nothing shows in the pool
  const unpaid = await run([{ bal: [0n, 0n], status: "PENDING_DEPOSIT" }]);
  assert.equal(unpaid.end, "quote_checked");
  assert.deepEqual(unpaid.stages, []);
  assert.ok(unpaid.reads > 0, "its own status is read");
  // an expired one is never in the pool by a neighbour's note, from a fresh follow or resumed at expired
  const expired = await run([{ bal: [0n, 0n], status: null, past: true }]);
  assert.equal(expired.end, "expired");
  assert.deepEqual(expired.stages, ["expired"]);
  const resumedExpired = await run([{ bal: [0n, 0n], status: "PENDING_DEPOSIT", past: true }], "expired");
  assert.equal(resumedExpired.end, "expired");
  assert.deepEqual(resumedExpired.stages, []);
  // two paid quotes on one U_X: this one's delivery comes after its deadline; it is followed until carried, then ends
  const late = await run([
    { bal: [0n, 0n], status: "PROCESSING", past: true },
    { bal: [0n, 0n], status: "PROCESSING", past: true },
    { bal: [FLOOR, FLOOR], status: "SUCCESS", past: true },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  assert.equal(late.end, "in_pool");
  assert.deepEqual(late.deposits, [10_000_000n], "its own delivery carried");
  assert.deepEqual(late.stages, ["in_transit", "in_pool"]);
  // its own SUCCESS read, the landed note counts: a resumed paid follow ends with nothing left under U_X
  const own = await run([{ bal: [0n, 0n], status: "SUCCESS", past: true }], "in_transit");
  assert.equal(own.end, "in_pool");
  assert.deepEqual(own.stages, ["in_pool"]);
  // an op already in_pool (paid by its stage) still ends at once
  const inPool = await run([{ bal: [0n, 0n], status: null, past: true }], "in_pool");
  assert.equal(inPool.end, "in_pool");
  assert.equal(inPool.reads, 0);
  // Solana's ops at every stage short of in_pool are unchanged by the rule with no SUCCESS of their own
  for (const from of ["quote_checked", "waiting", "in_transit", "refunded", "short", "failed"] as const) {
    const r = await run([{ bal: [0n, 0n], status: from === "quote_checked" ? "PENDING_DEPOSIT" : "PROCESSING" }], from);
    assert.ok(!r.stages.includes("in_pool"), `${from}: ${r.stages.join(",")}`);
    assert.notEqual(r.end, "in_pool", from);
  }
});

// card evm-deposit-route-mainnet re-read P3-4: the end's own read takes BOTH pool RPCs (chainBalances) under the floor;
// one under and one over is no end, whichever reads low
test("re-read P3-4: a follow past its deadline ends only when both pool RPCs read U_X under one deposit's floor", async () => {
  for (const pair of [[0n, FLOOR], [FLOOR, 0n], [FLOOR - 1n, FLOOR * 2n], [FLOOR * 2n, FLOOR - 1n]] as const) {
    const w = world([{ bal: [0n, 0n], status: "SUCCESS", past: true }]);
    const end = await followPoolQuote(F, { ...w.deps, chainBalances: async () => pair }, "in_pool");
    assert.equal(w.sleeps.length >= 4, true, `${pair}: read on, no end`);
    assert.equal(end, "in_pool");
    assert.deepEqual(w.deposits, [], `${pair}: the lower read under the floor carries nothing`);
  }
  // both under: the end at the first round
  const both = world([{ bal: [0n, 0n], status: "SUCCESS", past: true }]);
  await followPoolQuote(F, { ...both.deps, chainBalances: async () => [FLOOR - 1n, FLOOR - 1n] as const }, "in_pool");
  assert.equal(both.sleeps.length, 0, "ended with no sleep");
});

// card evm-deposit-route-mainnet re-read P3-2: money in U_X over the quote's floor that cannot pay a rung and its fee
// now (the deposit ends not_funded) was retried each slow round with nothing on the screen; it shows short
test("evm-deposit-route-mainnet re-read P3-2: a carry that cannot pay a rung and its fee shows short, read again slowly, then in_pool once it goes; never short after in_pool", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "not_funded" },
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "not_funded" },
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps, "in_transit"), "in_pool");
  assert.deepEqual(w.stages, ["short", "in_pool"]);
  assert.ok(w.sleeps[0]! > POOL_FOLLOW_FAST_MS && w.sleeps[1]! > w.sleeps[0]!, "read again at the slow pace, slower each time");
  // after a rung is in the pool, a later short carry (a late send under a rung and its fee) never shows short
  const after = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
    { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "not_funded" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  assert.equal(await followPoolQuote(F, after.deps, "in_transit"), "in_pool");
  assert.deepEqual(after.stages, ["in_pool"]);
});

// card evm-deposit-route-mainnet review: main.ts's Base and Robinhood route (evmQuoteRoute). A page not on testnet
// with no wallet reader (the helper's /v1/rpc) gets no floor, so pool.address shows no deposit address
// (pool-deposit-address.ts: a null floor asks no quote), and no follow, and reads nothing; with the reader the follow
// polls on it and carries refunds at the floor; a testnet page polls the pool's pair; no pool, no route
test("evm-deposit-route-mainnet review: the EVM route: mainnet with no wallet reader gives no floor and no follow, reading nothing; the reader's follow keeps the refund carry", async () => {
  const { evmQuoteRoute } = await import("../src/pool-deposit-follow.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  type Rpc = import("../../wallet/src/pool/evm.ts").EvmRpc;
  const reads: string[] = [];
  const rpcOf = (who: string, bal = 0n) => (async (method: string, params: readonly unknown[]) => {
    reads.push(`${who} ${method}`);
    if (method === "eth_getBalance") return "0x" + bal.toString(16);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0x4c4b40" };
    if (method === "eth_call") return word((params[0] as { data: string }).data === sel("currentTreeDepth()") ? 3n : 0n);
    throw new Error(`unmocked ${method}`);
  }) as unknown as Rpc;
  const pin = { network: "robinhood", pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n } as const;
  const pool = () => ({ pin, rpcs: [rpcOf("pool-a", 1n), rpcOf("pool-b", 2n)] as const });
  const deposit = async () => ({ end: "filled" as const, txs: [] });
  const refund = Object.assign(async () => "none" as const, {});
  const floors: (() => Promise<bigint>)[] = [];
  const refundAt = (floor: () => Promise<bigint>) => (floors.push(floor), refund);
  const f = { ...F, chain: "robinhood" as const, u: "0x229cFb760A282C0F9941923623a435b4a46FB463" };
  // mainnet, no reader: nothing, and nothing read
  const off = evmQuoteRoute({ network: "mainnet", pool, wallet: () => undefined });
  assert.equal(await off.floor("robinhood"), null);
  assert.equal(off.deps("robinhood", deposit, refundAt), null);
  assert.deepEqual(reads, []);
  // mainnet with the reader: a floor on the pool's pair, the follow polling the reader, its refund at that floor
  const on = evmQuoteRoute({ network: "mainnet", pool, wallet: () => rpcOf("helper", 7n) });
  assert.equal(typeof (await on.floor("robinhood")), "bigint");
  const d = on.deps("robinhood", deposit, refundAt)!;
  assert.equal(d.refund, refund, "the refund carry kept");
  assert.equal(await floors[0]!(), await on.floor("robinhood"), "carried at the pool's floor");
  reads.length = 0;
  assert.deepEqual(await d.balances(f), [7n, 7n]);
  assert.deepEqual(reads, ["helper eth_getBalance"]);
  assert.deepEqual(await d.chainBalances!(f), [1n, 2n], "the end's read: the pool's pair");
  // testnet: the pool's pair, no reader
  const t = evmQuoteRoute({ network: "testnet", pool, wallet: () => undefined }).deps("robinhood", deposit, refundAt)!;
  assert.deepEqual(await t.balances(f), [1n, 2n]);
  assert.equal(t.chainBalances, undefined);
  // no pool, or Solana: no route
  const none = evmQuoteRoute({ network: "mainnet", pool: () => null, wallet: () => rpcOf("helper") });
  assert.equal(await none.floor("base"), null);
  assert.equal(none.deps("base", deposit, refundAt), null);
  assert.equal(await on.floor("solana"), null);
});

// card evm-deposit-route-mainnet review P2b: fees rose after the quote. U_X holds the quote's min_out (the device held it
// at or above the floor then), under the floor read now: the follow still carries it in (the deposit prices itself at its
// own gas), and never ends while it is there
test("evm-deposit-route-mainnet review P2b: U_X at the quote's min_out, under a floor that rose since, is carried in and never ends the follow unread", async () => {
  const minOut = SOL_LADDER.min + PER + KEEP; // the floor at quote time
  const rose = { floor: minOut + 2n * PER, perRung: 3n * PER, keep: KEEP };
  let held = minOut;
  const asks: bigint[] = [];
  const ac = new AbortController();
  let k = 0;
  const end = await followPoolQuote({ ...F, min_out: String(minOut) }, {
    status: async () => ({ status: "SUCCESS" as never, delivered: null }),
    balances: async () => [held, held],
    costs: async () => rose,
    ladder: SOL_LADDER,
    deposit: async (_f, amount) => (asks.push(amount), (held = KEEP), { end: "filled", txs: [] }),
    past: async () => true,
    stage: async () => {},
    sleep: async () => void (++k >= 10 && ac.abort()),
    signal: ac.signal,
  });
  assert.deepEqual(asks, [SOL_LADDER.min], "one rung carried in");
  assert.equal(end, "in_pool");
  assert.equal(ac.signal.aborted, false);
});

// card evm-deposit-route-mainnet review (EVM refund): 1Click refunds the quote to U_{s,i} inside intents.near; the refund
// carry moves it back to U_X on the EVM chain, and the same follow carries it into the pool on the pool's own reads and
// ends only once both of the pool's RPCs read U_X under the floor
test("evm-deposit-route-mainnet review: an EVM quote refunded to U_{s,i} is moved back to U_X and carried into the pool by the same follow", async () => {
  const { evmPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const { EVM_LADDER } = await import("../../wallet/src/pool/evm.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  let chain = 0n;
  const rpc = (async (method: string, params: readonly unknown[]) => {
    if (method === "eth_getBalance") return "0x" + chain.toString(16);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x64", baseFeePerGas: "0x4c4b40" };
    if (method === "eth_call") return word((params[0] as { data: string }).data === sel("currentTreeDepth()") ? 3n : 0n);
    throw new Error(`unmocked ${method}`);
  }) as unknown as import("../../wallet/src/pool/evm.ts").EvmRpc;
  const pin = { network: "base", pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n } as const;
  const f = { ...F, chain: "base" as const, u: "0x229cFb760A282C0F9941923623a435b4a46FB463", deadline_ms: 1 };
  const asks: bigint[] = [];
  let perRung = 0n;
  const moves: string[] = [];
  const d = evmPoolFollowDeps({
    rpcs: [rpc, rpc],
    pin,
    wallet: rpc,
    deposit: async (_g, amount) => (asks.push(amount), (chain -= amount + perRung), { end: "filled", txs: [] }),
    // the carry: held under U_{s,i} once, then moved (the move lands 0.002 ETH and its cost at U_X)
    refund: Object.assign(async (g: { u: string }) => {
      moves.push(g.u);
      if (moves.length === 1) return "held" as const;
      if (moves.length === 2) chain = 2_000_000_000_000_000n + perRung;
      return "moved" as const;
    }, {}),
  });
  perRung = (await d.costs(f)).perRung;
  const stages: string[] = [];
  const ac = new AbortController();
  let k = 0;
  const end = await followPoolQuote(f, {
    ...d,
    status: async () => ({ status: "REFUNDED" as never, delivered: null }),
    stage: async (s) => void (stages.at(-1) !== s && stages.push(s)),
    signal: ac.signal,
    sleep: async () => void (++k >= 20 && ac.abort()),
  });
  assert.deepEqual(asks, [2_000_000_000_000_000n], "the refund's 0.002 ETH carried in as one rung");
  assert.ok(moves.every((u) => u === f.u), "the carry moves to this U_X only");
  assert.deepEqual(stages.slice(0, 2), ["refunded", "refund_move"]);
  assert.equal(end, "in_pool");
  assert.equal(ac.signal.aborted, false);
  assert.ok(chain < EVM_LADDER.min);
});

// card evm-deposit-route-mainnet review (the testnet runs, 17:34Z): rung 1 landed and rung 2 sent in one run, U_X under
// the floor, the quote's deadline past. Nothing shows in_pool and the follow never ends while rung 2 is still landing;
// when it fails to land its money is back in U_X and is carried again; the end only once no note of U_X's is open
test("evm-deposit-route-mainnet review: no in_pool and no end while a later rung of U_X's is still landing; a rung that fails to land is carried again", async () => {
  let held = KEEP; // after rung 2's send: U_X under the floor
  let open = true;
  const stages: string[] = [];
  const asks: bigint[] = [];
  const ac = new AbortController();
  let k = 0;
  const end = await followPoolQuote({ ...F, deadline_ms: 1 }, {
    status: async () => ({ status: "SUCCESS" as never, delivered: null }),
    balances: async () => [held, held],
    costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
    ladder: SOL_LADDER,
    deposit: async (_f, amount) => (asks.push(amount), (held = KEEP), (open = false), { end: "filled", txs: [] }),
    past: async () => true,
    noted: async () => true, // rung 1's note landed
    open: async () => open,
    stage: async (s) => void stages.push(`${s}@${k}`),
    sleep: async () => {
      k++;
      // round 5: rung 2 fails to land (its money back in U_X), the page's pass retires its note
      if (k === 5) (held = FLOOR), (open = false);
      if (k === 6) open = false;
      if (k >= 30) ac.abort();
    },
    signal: ac.signal,
  });
  const at = stages.find((s) => s.startsWith("in_pool@"));
  assert.ok(at !== undefined && Number(at.split("@")[1]) >= 5, `in_pool shown only once rung 2 settled: ${stages.join(", ")}`);
  assert.deepEqual(asks, [SOL_LADDER.min], "the failed rung's money carried again");
  assert.equal(end, "in_pool");
  assert.equal(ac.signal.aborted, false);
  assert.ok(k >= 5, "no end before the open rung settled");
});

// evm-deposit-route-mainnet round 3: each still-landing guard alone (pool-deposit-follow.ts: the carry's landed, the
// landed note, in_pool, the end), on a follow whose note of U_X's is landing while its own money already counts as landed
test("evm-deposit-route-mainnet round 3: a carry whose rung is still landing is not landed; once landed, no in_pool and no end while a rung of U_X's is landing", async () => {
  let held = KEEP, open = false, k = 0;
  const stages: string[] = [];
  const ac = new AbortController();
  const end = await followPoolQuote({ ...F, deadline_ms: 1 }, {
    status: async () => ({ status: "SUCCESS" as never, delivered: null }),
    balances: async () => [held, held],
    costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
    ladder: SOL_LADDER,
    // the rung is sent and its note is landing: U_X under the floor, the note open until round 5
    deposit: async () => ((held = KEEP), (open = true), { end: "filled", txs: [] }),
    past: async () => true,
    noted: async () => k >= 1, // rung 1's note in the store from round 1
    open: async () => open,
    stage: async (st) => void stages.push(`${st}@${k}`),
    sleep: async () => {
      k++;
      if (k === 1) held = FLOOR; // round 1: a second send to U_X, carried while the first counts as landed
      if (k === 5) open = false;
      if (k >= 30) ac.abort();
    },
    signal: ac.signal,
  });
  const at = stages.find((st) => st.startsWith("in_pool@"));
  assert.ok(at !== undefined && Number(at.split("@")[1]) >= 5, `in_pool only once the rung landed: ${stages.join(", ")}`);
  assert.equal(end, "in_pool");
  assert.ok(k >= 5, `no end while the rung is landing (ended at round ${k})`);
});

test("evm-deposit-route-mainnet round 3: a landed note is not counted while a note of U_X's is landing: the quote's own status is read on", async () => {
  let open = false, k = 0;
  const reads: number[] = [];
  const stages: string[] = [];
  const ac = new AbortController();
  const end = await followPoolQuote({ ...F, deadline_ms: 1 }, {
    status: async () => (reads.push(k), { status: "SUCCESS" as never, delivered: null }),
    balances: async () => [0n, 0n],
    costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
    ladder: SOL_LADDER,
    deposit: async () => ({ end: "filled", txs: [] }),
    past: async () => true,
    noted: async () => k >= 1,
    open: async () => open,
    stage: async (st) => void stages.push(`${st}@${k}`),
    sleep: async () => {
      k++;
      if (k === 1) open = true;
      if (k === 4) open = false;
      if (k >= 30) ac.abort();
    },
    signal: ac.signal,
  });
  assert.deepEqual(reads, [0, 1, 2, 3], "the status read every round a note is landing, none once the note counts");
  assert.equal(stages.find((st) => st.startsWith("in_pool@")), "in_pool@4");
  assert.equal(end, "in_pool");
});

// card evm-deposit-route-mainnet review: each landed rung's tx reaches the op on EVM as on Solana
test("evm-deposit-route-mainnet review: the EVM follow's landed reads each landed note's send on both pool RPCs (from U_X to the pool, final, alike), and a heard tx not final yet is read again", async () => {
  const { evmPoolFollowDeps } = await import("../src/pool-deposit-follow.ts");
  const U = "0x229cFb760A282C0F9941923623a435b4a46FB463";
  const pool = "0x00000000000000000000000000000000000f0011";
  const pin = { network: "base", pool, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n } as const;
  const h = (c: string) => "0x" + c.repeat(64);
  const receipts: Record<string, { status: string; from: string; to: string; blockNumber: string } | null> = {
    [h("1")]: { status: "0x1", from: U.toLowerCase(), to: pool, blockNumber: "0x10" }, // rung 1, landed
    [h("2")]: null, // rung 1's first send, replaced by h(1)
    [h("3")]: { status: "0x1", from: U.toLowerCase(), to: pool, blockNumber: "0x30" }, // rung 2, not final yet
    [h("4")]: { status: "0x1", from: "0x0000000000000000000000000000000000000bad", to: pool, blockNumber: "0x10" },
  };
  const named: string[] = [];
  const rpc = (async (method: string, params: readonly unknown[]) => {
    if (method === "eth_getTransactionReceipt") return named.push(String(params[0])), receipts[String(params[0])] ?? null;
    if (method === "eth_getBlockByNumber") return { number: "0x20" };
    throw new Error(`unmocked ${method}`);
  }) as unknown as import("../../wallet/src/pool/evm.ts").EvmRpc;
  const f = { ...F, chain: "base" as const, s: "9", i: 2, u: U };
  const note = (ref: unknown, state: string, sends: string[]) => ({ ref, scope: 9n, state, evmSends: sends.map((x) => ({ hash: x, nonce: 0n, value: 1n })) });
  const notes = [
    note({ kind: "deposit", s: 9n, i: 2 }, "UNSPENT", [h("2"), h("1")]),
    note({ kind: "second", id: { id: "U", s: 9n, i: 2 }, n: 0 }, "INCOMING", [h("3")]),
    note({ kind: "deposit", s: 9n, i: 3 }, "UNSPENT", [h("4")]), // another U's: never read
  ] as never;
  const d = evmPoolFollowDeps({ rpcs: [rpc, rpc], pin, deposit: async () => ({ end: "filled", txs: [] }), notes: async () => notes });
  assert.deepEqual(await d.landed!(f, []), [{ chain: "base", hash: h("1") }]);
  assert.ok(!named.includes(h("4")), "no other U's tx read");
  assert.deepEqual(await d.landed!(f, [], new Set([h("1")])), [], "a tx shown already is not read again");
  await assert.rejects(d.landed!(f, [{ chain: "base", hash: h("3") }]), /not read final yet/);
  assert.deepEqual(await d.landed!(f, [{ chain: "base", hash: h("4") }]), [{ chain: "base", hash: h("1") }], "a heard tx that is no deposit from U_X is not shown");
  // without the page's notes: no landed (as before)
  assert.equal(evmPoolFollowDeps({ rpcs: [rpc, rpc], pin, deposit: async () => ({ end: "filled", txs: [] }) }).landed, undefined);
});

// card evm-first-proof-inside-ten-seconds: a follow held under the floor reads the costs once per POOL_FOLLOW_COSTS_MS
// while U_X's balance stays the same (a Base mainnet copy of 13 Nov: its fee oracle read every round filled each pool
// host's pass budget), and a carry is only ever decided on costs read in its own round
const clocked = (w: ReturnType<typeof world>) => {
  let clock = 0;
  const sleep = w.deps.sleep;
  w.deps.now = () => clock;
  w.deps.sleep = async (ms, s) => {
    clock += ms;
    await sleep(ms, s);
  };
  const reads: { at: number; low: bigint }[] = [];
  return { reads, at: () => clock };
};
test("card evm-first-proof-inside-ten-seconds: under the floor with U_X's balance unchanged, the costs are read again only once POOL_FOLLOW_COSTS_MS passed, and a fee that fell under the balance is carried on that read", async () => {
  const { POOL_FOLLOW_COSTS_MS } = await import("../src/pool-deposit-follow.ts");
  const under = FLOOR - 1n;
  const w = world(Array.from({ length: 12 }, () => ({ bal: [under, under] as const, status: "SUCCESS" })));
  const c = clocked(w);
  w.deps.costs = async () => {
    c.reads.push({ at: c.at(), low: under });
    // the fee falls 16 s in: the floor and the rung's cost 10 lower
    return c.at() >= 16_000 ? { floor: FLOOR - 10n, perRung: PER - 10n, keep: KEEP } : { floor: FLOOR, perRung: PER, keep: KEEP };
  };
  const deposits: { at: number; amount: bigint }[] = [];
  w.deps.deposit = async (_f, amount) => (deposits.push({ at: c.at(), amount }), { end: "filled", txs: [] });
  await followPoolQuote(F, w.deps);
  const before = c.reads.filter((r) => r.at <= (deposits[0]?.at ?? Infinity));
  // reads at 0 s and at 16 s (the first round at or past 15 s), none of the six rounds between at the same balance
  assert.deepEqual(before.map((r) => r.at), [0, 16_000], `cost reads at ${c.reads.map((r) => r.at).join(", ")}`);
  assert.ok(POOL_FOLLOW_COSTS_MS === 15_000);
  // carried in the round that read the fallen fee, for what that read prices
  assert.equal(deposits[0]?.at, 16_000);
  assert.equal(deposits[0]?.amount, askOf(SOL_LADDER, under, PER - 10n, KEEP));
});

test("card evm-first-proof-inside-ten-seconds: a balance that moves inside POOL_FOLLOW_COSTS_MS is read at fresh costs before any carry, and the carry asks what that round's read prices", async () => {
  const under = FLOOR - 1n, more = FLOOR + 5_000_000n;
  const w = world([
    { bal: [under, under], status: "SUCCESS" },
    { bal: [under, under], status: "SUCCESS" },
    { bal: [under, under], status: "SUCCESS" },
    { bal: [more, more], status: "SUCCESS" },
  ]);
  const c = clocked(w);
  let low = 0n;
  const bal = w.deps.balances;
  w.deps.balances = async (f) => {
    const r = await bal(f);
    low = r[0] < r[1] ? r[0] : r[1];
    return r;
  };
  // each read prices the rung 5 more than the last: a carry on a held read would ask for less than this round's
  w.deps.costs = async () => {
    c.reads.push({ at: c.at(), low });
    return { floor: FLOOR, perRung: PER + 5n * BigInt(c.reads.length - 1), keep: KEEP };
  };
  const deposits: { at: number; amount: bigint }[] = [];
  w.deps.deposit = async (_f, amount) => (deposits.push({ at: c.at(), amount }), { end: "filled", txs: [] });
  await followPoolQuote(F, w.deps);
  // the first round reads, the two at the same balance hold it, the round the money moved (6 s in) reads again
  assert.deepEqual(c.reads.slice(0, 2), [{ at: 0, low: under }, { at: 6_000, low: more }], `cost reads ${JSON.stringify(c.reads, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`);
  assert.equal(deposits[0]?.at, 6_000);
  assert.equal(deposits[0]?.amount, askOf(SOL_LADDER, more, PER + 5n, KEEP));
});
