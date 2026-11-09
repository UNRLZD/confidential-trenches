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
type End = Awaited<ReturnType<Deps["deposit"]>>;

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
      return now().end ?? "filled";
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
  assert.equal(await depositToEnd(sentThen("filled"), "solana", 9, 10_000_000n, ac.signal), "filled");
  assert.deepEqual(asked[0], { chain: "solana", amount: "0.01" });
  assert.equal(await depositToEnd(sentThen("not_landed"), "solana", 9, 1_230_000_000n, ac.signal), "not_landed");
  assert.deepEqual(asked[1], { chain: "solana", amount: "1.23" });
  assert.equal(await depositToEnd(() => ({ error: "not_funded" }), "solana", 9, 1n, ac.signal), "not_funded");
  assert.equal(await depositToEnd(() => null, "solana", 9, 1n, ac.signal), "not_allowed");
  assert.equal(await depositToEnd(() => ({ after: Promise.resolve(), answer: () => ({ error: "busy" }) }), "solana", 9, 1n, ac.signal), "down");
  assert.equal(await depositToEnd(() => ({ after: Promise.resolve(), answer: () => ({ result: { stage: "filled" } }) }), "solana", 9, 1n, ac.signal), "filled");
  // a sent answer whose end never comes: the stop reads down
  const stop = new AbortController();
  const hang = depositToEnd(() => ({ after: Promise.resolve(), answer: () => ({ result: { stage: "sent" } }) }), "solana", 9, 1n, stop.signal);
  stop.abort();
  assert.equal(await hang, "down");
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
  const d = solanaPoolFollowDeps({ rpcs: [rpcOf("https://a.example", 30, 2_000), rpcOf("https://b.example", 40, 1_000)], program: base58.encode(new Uint8Array(32).fill(7)), deposit: async () => "filled", fetch: status(F.refund_id) });
  const U = base58.encode(new Uint8Array(32).fill(5));
  const f = { ...F, u: U, deadline_ms: 1_500_000 };
  assert.deepEqual(await d.balances(f), [30n, 40n]);
  assert.deepEqual(await d.costs(f), { floor: 13_586_400n, perRung: 2_936_160n, keep: 650_240n });
  assert.equal(await d.past(f), false, "one RPC's finalized clock is still before the deadline");
  assert.equal(await d.past({ ...f, deadline_ms: 999_000 }), true);
  const ok = solanaPoolFollowDeps({ rpcs: [rpcOf("https://a.example", 0, 0), rpcOf("https://b.example", 0, 0)], program: base58.encode(new Uint8Array(32).fill(7)), deposit: async () => "filled", fetch: status(F.refund_id) });
  assert.deepEqual(await ok.status(F, new AbortController().signal), { status: "SUCCESS", delivered: 20_000_000n });
  const bad = solanaPoolFollowDeps({ rpcs: [rpcOf("https://a.example", 0, 0), rpcOf("https://b.example", 0, 0)], program: base58.encode(new Uint8Array(32).fill(7)), deposit: async () => "filled", fetch: status(F.u) });
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
    const { id: _i, kind: _k, txs: _t, chain, ...rest } = o as Record<string, unknown>;
    assert.equal(chain, "solana");
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
        const { id: _i, kind: _k, txs: _t, chain: _c, ...rest } = opOf(k, v) as Record<string, unknown>;
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
  // a read that did not count ("wait": the two RPCs did not agree) is read again before expired is shown
  let n = 0;
  const v = world([{ bal: [0n, 0n], status: "REFUNDED", past: true }], { refund: async () => (++n === 1 ? "wait" : "none") });
  await followPoolQuote(F, v.deps);
  assert.deepEqual(v.stages, ["expired"]);
  assert.ok(n >= 2, "expired only after a read that found nothing");
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
