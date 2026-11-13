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

function page(o: { quote?: { address: string } | { error: "above_max" }; ops?: Record<string, { stage: string; txs?: { chain: "solana" | "near"; hash: string }[] }[]>; withdraw?: null } = {}) {
  const quoted: { chain: string; amount: bigint; id: string }[] = [];
  const runs: { ready: PoolReady; id: string }[] = [];
  const puts: { id: string; rec: MoveOpRecord }[] = [];
  const reads: Record<string, number> = {};
  const d: PoolToCashDeps = {
    price: () => SOL,
    funds: async () => FUNDS,
    quote: async (chain, amount, id) => (quoted.push({ chain, amount, id }), o.quote ?? { address: DEPOSIT }),
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
  const off = page({ quote: { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" } });
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
  assert.deepEqual(await page().m.dry("solana", 20_000_000n), { sum: 20_000_000n, out: 1_552_000n, fee: 1_305_000n });
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
  assert.deepEqual(dry.answer(), { result: { out: "1.552", fee: "0.001305", steps: [{ step: "pool_out", chain: "solana" }, { step: "intents", chain: "near" }, { step: "vault_in", chain: "near" }] } });
  // more decimals than the pool's coin, pool to pool (next) and no pool-to-Cash path: refused
  for (const params of [{ from: "solana", to: "near", amount: "0.0000000001" }, { from: "solana", to: "base", amount: "0.02" }]) assert.deepEqual(k["pool.move"](params, { id: "x", sha: "00", progress: () => {} }), { error: "not_allowed" });
});
