// Pool X to Cash (card one-balance-buys-on-every-chain, part 3 (b)): pool.move { from: X, to: "near" } plans the amount as
// the withdraw form does, asks Cash's own deposit quote of X's coin to U (its follow op under <op>/1click), then the pool
// withdraw run pays that address under <op>/out; the move op follows the run, then the deposit op, to done. Red at
// 2eaacce3b: no pool-to-cash.ts, and pool.move from a pool chain is refused not_allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashUsdcOf, moveStageOfDeposit, poolToCash, pricedPoolCoin, type PoolToCashDeps } from "../src/pool-to-cash.ts";
import { cashMover, poolMoveKinds, type MoveOpRecord } from "../src/cash-to-pool.ts";
import type { PoolFunds, PoolReady } from "../src/withdraw/pool-form.ts";

const FUNDS: PoolFunds = { notes: [{ id: "a", value: 30_000_000n }, { id: "b", value: 10_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n };
const SOL = { price: "8000000000", expo: -8 }; // SOL at 80 USD
const DEPOSIT = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";

function page(o: { quote?: { address: string; minOut: bigint } | { error: "above_max" }; ops?: Record<string, { stage: string; txs?: { chain: "solana" | "near"; hash: string }[] }[]>; withdraw?: null } = {}) {
  const quoted: { chain: string; amount: bigint; id: string }[] = [];
  const runs: { ready: PoolReady; id: string }[] = [];
  const puts: { id: string; rec: MoveOpRecord }[] = [];
  const reads: Record<string, number> = {};
  const d: PoolToCashDeps = {
    price: () => SOL,
    funds: async () => FUNDS,
    quote: async (chain, amount, id) => (quoted.push({ chain, amount, id }), o.quote ?? { address: DEPOSIT, minOut: 1_500_000n }),
    onChain: (_c, a) => a === DEPOSIT,
    withdraw: () => (o.withdraw === null ? null : (ready, id) => void runs.push({ ready, id })),
    op: async (id) => {
      const list = o.ops?.[id.slice(id.lastIndexOf("/") + 1)] ?? [];
      const k = reads[id] ?? 0;
      reads[id] = k + 1;
      return list[Math.min(k, list.length - 1)];
    },
    put: async (id, rec) => void puts.push({ id, rec: structuredClone(rec) }),
    now: () => 1_000,
    wait: async () => {},
  };
  return { m: poolToCash(d), quoted, runs, puts };
}

test("pool.move Solana to Cash: Cash's deposit quote of the planned sum to U first, then the pool withdraw run pays its address; leaving, in_transit once sent, then the deposit op's stages to done", async () => {
  const p = page({
    ops: {
      out: [{ stage: "proving" }, { stage: "sent", txs: [{ chain: "solana", hash: "SolTx1" }] }],
      "1click": [{ stage: "quote_checked" }, { stage: "quote_checked" }, { stage: "in_transit" }, { stage: "done", txs: [{ chain: "near", hash: "NearTx1" }] }],
    },
  });
  assert.deepEqual(await p.m.move("solana", 20_000_000n, "req-1"), { op: "req-1" });
  await p.m.idle();
  assert.deepEqual(p.quoted, [{ chain: "solana", amount: 20_000_000n, id: "req-1/1click" }]);
  assert.deepEqual(p.runs, [{ ready: { chain: "solana", to: DEPOSIT, amount: 20_000_000n, maxFee: 1_305_000n }, id: "req-1/out" }]);
  assert.deepEqual(p.puts.map((x) => x.rec.stage), ["leaving", "in_transit", "done"]);
  const last = p.puts.at(-1)!.rec;
  assert.deepEqual({ from: last.from, to: last.to, amount: last.amount, out: last.out }, { from: "solana", to: "near", amount: "0.02", out: "1.552" });
  assert.deepEqual(last.txs, [{ chain: "solana", hash: "SolTx1" }, { chain: "near", hash: "NearTx1" }]);
});

test("pool to Cash: a refused quote, an address off the pool's chain, more than the pool can send or no run on the page start no run", async () => {
  const refused = page({ quote: { error: "above_max" } });
  assert.deepEqual(await refused.m.move("solana", 20_000_000n, "r"), { error: "above_max" });
  assert.equal(refused.runs.length, 0);
  assert.equal(refused.puts.at(-1)!.rec.stage, "failed");
  const off = page({ quote: { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", minOut: 1_500_000n } });
  assert.deepEqual(await off.m.move("solana", 20_000_000n, "r"), { error: "quote_check_failed" });
  assert.equal(off.runs.length, 0);
  const over = page();
  assert.deepEqual(await over.m.move("solana", 50_000_000n, "r"), { error: "not_funded" });
  assert.equal(over.quoted.length, 0, "nothing asked for an amount the pool cannot send");
  const none = page({ withdraw: null });
  assert.deepEqual(await none.m.move("solana", 20_000_000n, "r"), { error: "not_allowed" });
});

test("pool to Cash: a run that stopped with nothing sent fails the move; the dry is the planned sum, the least USDC at the device's price less 3%, and the Max fee", async () => {
  const p = page({ ops: { out: [{ stage: "stopped" }] } });
  await p.m.move("solana", 20_000_000n, "r");
  await p.m.idle();
  assert.deepEqual(p.puts.map((x) => x.rec.stage), ["leaving", "failed"]);
  // and max, what the pool sends now: each note's largest part after its fees (card move-sends-what-it-shows)
  assert.deepEqual(await page().m.dry("solana", 20_000_000n), { sum: 20_000_000n, out: 1_552_000n, fee: 1_305_000n, max: 37_390_000n });
  assert.equal(cashUsdcOf(10n ** 18n, { price: "300000000000", expo: -8 }, "base"), 2_910_000_000n, "1 ETH at 3,000 USD less 3%");
});

test("pool to Cash: the deposit op's stages on the move op; the deposit rule prices only a pool coin, at the device's price, USDC out at 1", () => {
  assert.equal(moveStageOfDeposit("done"), "done");
  for (const s of ["refunded", "refund_move"] as const) assert.equal(moveStageOfDeposit(s), "refunded");
  for (const s of ["expired", "failed"] as const) assert.equal(moveStageOfDeposit(s), "failed");
  for (const s of ["in_transit", "into_vault", "held", "halted", "short"] as const) assert.equal(moveStageOfDeposit(s), "in_transit");
  assert.deepEqual(pricedPoolCoin("nep141:sol.omft.near", () => SOL), { decimals: 9, pricing: { in: ["80.00000000", "80.00000000"], out: ["1", "1"] } });
  assert.deepEqual(pricedPoolCoin("nep141:hood.omft.near", () => SOL)?.decimals, 18);
  assert.equal(pricedPoolCoin("nep141:wrap.near", () => SOL), null);
  assert.equal(pricedPoolCoin("nep141:sol.omft.near", () => null), null);
});

test("pool.move from a pool chain to Cash goes to the pool-to-Cash path; its dry answers out in USDC, the fee in the pool's coin and the three steps", async () => {
  const p = page({ ops: { out: [{ stage: "stopped" }] } });
  const k = poolMoveKinds(() => cashMover({ price: () => null, rails: [], quote: async () => ({ error: "not_allowed" }), fee: async () => 0n, cash: async () => 0n, handoff: null, landed: async () => false, now: () => 0 }), () => p.m);
  const run = k["pool.move"]({ from: "solana", to: "near", amount: "0.02" }, { id: "req-9", sha: "00", progress: () => {} });
  assert.ok("running" in run);
  await run.after;
  assert.deepEqual(run.answer(), { result: { stage: "leaving", txs: [] } });
  assert.equal(p.runs[0]!.id, "req-9/out");
  const dry = k["pool.move.dry"]({ from: "solana", to: "near", amount: "0.02" }, { id: "req-10", sha: "00", progress: () => {} });
  assert.ok("running" in dry);
  await dry.after;
  assert.deepEqual(dry.answer(), { result: { out: "1.552", fee: "0.001305", steps: [{ step: "pool_out", chain: "solana" }, { step: "intents", chain: "near" }, { step: "vault_in", chain: "near" }], max: "0.03739" } });
  // more decimals than the pool's coin: refused before anything runs
  assert.deepEqual(k["pool.move"]({ from: "solana", to: "near", amount: "0.0000000001" }, { id: "x", sha: "00", progress: () => {} }), { error: "not_allowed" });
  // no pool-to-Cash path on the page: a move out of a pool is refused
  const none = poolMoveKinds(() => cashMover({ price: () => null, rails: [], quote: async () => ({ error: "not_allowed" }), fee: async () => 0n, cash: async () => 0n, handoff: null, landed: async () => false, now: () => 0 }));
  for (const to of ["near", "base"]) assert.deepEqual(none["pool.move"]({ from: "solana", to, amount: "0.02" }, { id: "x", sha: "00", progress: () => {} }), { error: "not_allowed" });
});

// ------------------------------------------------------------------------------------------- pool to pool (part 3 (c))
test("pool.move Solana to Base: to Cash first, then, once its deposit is done, Cash's own move of the quote's least USDC less the withdraw fee into Base under <op>/on; in_vault, then that move's stages to done", async () => {
  const sent: { to: string; usdc: bigint; id: string }[] = [];
  const quoted: unknown[] = [];
  const ops: Record<string, { stage: string; txs?: { chain: "solana" | "near" | "base"; hash: string }[] }[]> = {
    out: [{ stage: "sent", txs: [{ chain: "solana", hash: "SolTx1" }] }],
    "1click": [{ stage: "in_transit" }, { stage: "done", txs: [{ chain: "near", hash: "NearTx1" }] }],
    on: [{ stage: "in_transit" }, { stage: "into_pool" }, { stage: "done", txs: [{ chain: "base", hash: "BaseTx1" }] }],
  };
  const reads: Record<string, number> = {};
  const puts: { id: string; rec: MoveOpRecord }[] = [];
  const m = poolToCash({
    price: () => SOL,
    funds: async () => FUNDS,
    quote: async (...a) => (quoted.push(a), { address: DEPOSIT, minOut: 1_500_000n }),
    onChain: (_c, a) => a === DEPOSIT,
    withdraw: () => () => {},
    op: async (id) => {
      const key = id.slice(id.lastIndexOf("/") + 1);
      if (key === "on" && sent.length === 0) return undefined;
      const list = ops[key] ?? [];
      const k = reads[id] ?? 0;
      reads[id] = k + 1;
      return list[Math.min(k, list.length - 1)];
    },
    put: async (id, rec) => void puts.push({ id, rec: structuredClone(rec) }),
    now: () => 1_000,
    wait: async () => {},
    onward: { move: async (to, usdc, id) => (sent.push({ to, usdc, id }), { op: id }), fee: async () => 50_000n },
  });
  assert.deepEqual(await m.move("solana", 20_000_000n, "req-2", "base"), { op: "req-2" });
  await m.idle();
  assert.deepEqual(sent, [{ to: "base", usdc: 1_450_000n, id: "req-2/on" }], "the quote's least USDC less the withdraw fee, once");
  // leg one's in_transit, the vault between the legs, then the onward move's own stages
  assert.deepEqual(puts.map((x) => x.rec.stage), ["leaving", "in_transit", "in_vault", "in_transit", "into_pool", "done"]);
  const last = puts.at(-1)!.rec;
  assert.deepEqual({ from: last.from, to: last.to, cash: last.cash }, { from: "solana", to: "base", cash: "1500000" });
  assert.deepEqual(last.txs.map((t) => t.hash), ["SolTx1", "NearTx1", "BaseTx1"]);

  // a reload at in_vault with its onward move already written: followed on, never sent again
  sent.length = 0;
  sent.push({ to: "x", usdc: 0n, id: "already" });
  puts.length = 0;
  for (const k of Object.keys(reads)) delete reads[k];
  m.resume([{ id: "req-2", rec: { ...last, stage: "in_vault" } }]);
  await m.idle();
  assert.equal(sent.length, 1, "no second onward move");
  assert.equal(puts.at(-1)!.rec.stage, "done");
});

test("pool to pool: an onward move the page refuses fails the move (its money stays in Cash); to the same chain, or with no onward path: refused", async () => {
  const puts: MoveOpRecord[] = [];
  const base = {
    price: () => SOL,
    funds: async () => FUNDS,
    quote: async () => ({ address: DEPOSIT, minOut: 1_500_000n }),
    onChain: () => true,
    withdraw: () => () => {},
    op: async (id: string) => (id.endsWith("/out") ? { stage: "sent" } : id.endsWith("/1click") ? { stage: "done" } : undefined),
    put: async (_id: string, rec: MoveOpRecord) => void puts.push(structuredClone(rec)),
    now: () => 1,
    wait: async () => {},
  };
  const m = poolToCash({ ...base, onward: { move: async () => ({ error: "not_funded" }), fee: async () => 50_000n } });
  await m.move("solana", 20_000_000n, "r", "robinhood");
  await m.idle();
  assert.deepEqual(puts.map((r) => r.stage), ["leaving", "in_vault", "failed"]);
  assert.deepEqual(await m.move("solana", 20_000_000n, "r", "solana"), { error: "not_allowed" });
  assert.deepEqual(await poolToCash(base).move("solana", 20_000_000n, "r", "base"), { error: "not_allowed" });
});

test("Cash's mover resumes Cash's own moves only: a move out of a pool (its <op>/1click a vault deposit's op) is the pool path's", async () => {
  const followed: string[] = [];
  const m = cashMover({ price: () => null, rails: ["1click"], quote: async () => ({ error: "not_allowed" }), fee: async () => 0n, cash: async () => 0n, handoff: null, landed: async () => false, now: () => 0, follow: async (id) => (followed.push(id), { stage: "in_pool", final: true }), wait: async () => {} });
  const rec = (from: "near" | "solana", to: "near" | "base"): MoveOpRecord => ({ kind: "move", from, to, stage: "in_transit", txs: [], amount: "1", created_ms: 1 });
  m.resume([{ id: "a", rec: rec("near", "base") }, { id: "b", rec: rec("solana", "near") }, { id: "c", rec: rec("solana", "base") }]);
  await m.idle();
  assert.deepEqual(followed, ["a/1click"]);
});

test("pool.move.dry Solana to Base: what Cash's move of the deposit's least USDC less its fee gives in Base, the pool's Max fee and the six steps", async () => {
  const p = page();
  // Cash's mover as a stub: its withdraw fee 0.05 USDC, no Cash today (the USDC comes from this move), Base's floor 1 wei,
  // and 1 USDC gives 1e12 wei of Base's coin less 3%
  const asked: bigint[] = [];
  const mover = {
    bounds: async () => ({ fee: 50_000n, cash: 0n, floor: 1n }),
    least: (_to: string, usdc: bigint) => (asked.push(usdc), (usdc * 970_000_000_000n) / 1_000_000n),
  } as unknown as ReturnType<typeof cashMover>;
  const k = poolMoveKinds(() => mover, () => p.m);
  const dry = k["pool.move.dry"]({ from: "solana", to: "base", amount: "0.02" }, { id: "d", sha: "00", progress: () => {} });
  assert.ok("running" in dry);
  await dry.after;
  const a = dry.answer() as { result: { out: string; fee: string; steps: { step: string; chain: string }[] } };
  assert.equal(a.result.fee, "0.001305");
  assert.deepEqual(a.result.steps.map((x) => `${x.step}:${x.chain}`), ["pool_out:solana", "intents:near", "vault_in:near", "vault_out:near", "intents:base", "pool_in:base"]);
  assert.equal(asked.at(-1), 1_552_000n - 50_000n, "Cash's move of the deposit's least USDC less the withdraw fee");
  assert.equal(a.result.out, "0.00000145694");
});
