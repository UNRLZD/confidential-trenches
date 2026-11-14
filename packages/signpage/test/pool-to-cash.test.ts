// Pool X to Cash (card one-balance-buys-on-every-chain, part 3 (b)): pool.move { from: X, to: "near" } plans the amount as
// the withdraw form does, asks Cash's own deposit quote of X's coin to U (its follow op under <op>/1click), then the pool
// withdraw run pays that address under <op>/out; the move op follows the run, then the deposit op, to done. Red at
// 2eaacce3b: no pool-to-cash.ts, and pool.move from a pool chain is refused not_allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashUsdcOf, moveStageOfDeposit, poolToCash, pricedPoolCoin, type PoolToCashDeps } from "../src/pool-to-cash.ts";
import { cashMover, poolMoveKinds, type MoveOpRecord } from "../src/cash-to-pool.ts";
import type { PoolFunds, PoolReady } from "../src/withdraw/pool-form.ts";

/** The store's compare-and-set on an op record (WalletStore.update) over a test's write log: a write that keeps the
 *  record's stage replaces that record's last entry, so the log reads one entry a stage. */
function casOver<E>(log: E[], entry: (id: string, rec: MoveOpRecord) => E, idOf: (e: E) => string): PoolToCashDeps["update"] {
  const mem = new Map<string, MoveOpRecord>();
  return async (id, change) => {
    const prev = mem.get(id);
    const v = change(prev === undefined ? undefined : structuredClone(prev));
    if (v === undefined) return undefined;
    mem.set(id, structuredClone(v));
    const at = log.findLastIndex((e) => idOf(e) === id);
    if (prev?.stage === v.stage && at >= 0) log[at] = entry(id, structuredClone(v));
    else log.push(entry(id, structuredClone(v)));
    return v;
  };
}
const logged = (puts: { id: string; rec: MoveOpRecord }[]) => casOver(puts, (id, rec) => ({ id, rec }), (e) => e.id);

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
    update: logged(puts),
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
    update: logged(puts),
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
    update: casOver(puts, (_id, rec) => rec, () => "r"),
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

// ------------------------------------------- pool to pool in one confidential swap (card move-one-confidential-swap)
// Owner 14 Nov 03:37Z: "Move = ONE NEAR Intents confidential swap, pool payout -> destination pool, no vault stop". With
// `direct` the page quotes X's coin into Y's pool once (the Move host: confidential, checked at the device's prices),
// the pool withdraw run pays that address, and the pool follow (U_Y's balance on Y's two RPCs) carries it in.
const ETH = { price: "200000000000", expo: -8 }; // ETH at 2,000 USD
const DIRECT_ADDR = "57LxDLkS96hfigLJW45RFEBYT28kzZ8x8u28Vd14o3xU";
function direct(o: { quote?: { address: string; minOut: bigint } | { error: "quote_check_failed" | "down" }; ops?: Record<string, { stage: string; final?: true; txs?: { chain: "solana" | "base"; hash: string }[] }[]>; price?: (c: string) => typeof SOL | null; floor?: bigint | null } = {}) {
  const quoted: unknown[] = [], cash: unknown[] = [], onward: unknown[] = [];
  const runs: { ready: PoolReady; id: string }[] = [];
  const puts: { id: string; rec: MoveOpRecord }[] = [];
  const reads: Record<string, number> = {};
  const read = (id: string) => {
    const list = o.ops?.[id.slice(id.lastIndexOf("/") + 1)] ?? [];
    const k = reads[id] ?? 0;
    reads[id] = k + 1;
    return list[Math.min(k, list.length - 1)];
  };
  const d: PoolToCashDeps = {
    price: o.price ?? ((c) => (c === "solana" ? SOL : ETH)),
    funds: async () => FUNDS,
    quote: async (...a) => (cash.push(a), { address: DEPOSIT, minOut: 1_500_000n }),
    onChain: (_c, a) => a === DIRECT_ADDR,
    withdraw: () => (ready, id) => void runs.push({ ready, id }),
    op: async (id) => read(id),
    update: logged(puts),
    now: () => 1_000,
    wait: async () => {},
    onward: { move: async (...a) => (onward.push(a), { op: "x" }), fee: async () => 50_000n },
    direct: {
      quote: async (from, to, amount, id) => (quoted.push({ from, to, amount, id }), o.quote ?? { address: DIRECT_ADDR, minOut: 760_000_000_000_000n }),
      follow: async (id) => read(id),
      floor: async () => (o.floor === undefined ? 500_000_000_000_000n : o.floor),
    },
  };
  return { m: poolToCash(d), quoted, cash, onward, runs, puts };
}

test("pool.move Solana to Base in one confidential swap: one quote into Base's pool under <op>/pool, the Solana pool run pays its address, no Cash quote and no vault stop; leaving, in_transit, into_pool, done", async () => {
  const p = direct({
    ops: {
      out: [{ stage: "proving" }, { stage: "sent", txs: [{ chain: "solana", hash: "SolTx1" }] }],
      pool: [{ stage: "quote_checked" }, { stage: "quote_checked" }, { stage: "in_transit" }, { stage: "in_pool" }, { stage: "in_pool", final: true, txs: [{ chain: "base", hash: "BaseTx1" }] }],
    },
  });
  assert.deepEqual(await p.m.move("solana", 20_000_000n, "mv-1", "base"), { op: "mv-1" });
  await p.m.idle();
  assert.deepEqual(p.quoted, [{ from: "solana", to: "base", amount: 20_000_000n, id: "mv-1/pool" }]);
  assert.deepEqual(p.cash, [], "no Cash quote");
  assert.deepEqual(p.onward, [], "no move out of Cash");
  assert.deepEqual(p.runs, [{ ready: { chain: "solana", to: DIRECT_ADDR, amount: 20_000_000n, maxFee: 1_305_000n }, id: "mv-1/out" }]);
  assert.deepEqual(p.puts.map((x) => x.rec.stage), ["leaving", "in_transit", "into_pool", "done"]);
  const last = p.puts.at(-1)!.rec;
  assert.deepEqual({ from: last.from, to: last.to, amount: last.amount, out: last.out, cash: last.cash }, { from: "solana", to: "base", amount: "0.02", out: "0.00076", cash: undefined });
  assert.deepEqual(last.txs, [{ chain: "solana", hash: "SolTx1" }, { chain: "base", hash: "BaseTx1" }]);
});

test("pool to pool, one swap: a refused quote or an address off the source chain starts no run; a run that stopped with nothing sent fails; an expired quote fails; a refund carried back into the pool shows refunded, then done", async () => {
  for (const [q, code] of [[{ error: "quote_check_failed" as const }, "quote_check_failed"], [{ error: "down" as const }, "down"], [{ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", minOut: 1n }, "quote_check_failed"]] as const) {
    const p = direct({ quote: q });
    assert.deepEqual(await p.m.move("solana", 20_000_000n, "r", "base"), { error: code });
    assert.equal(p.runs.length, 0);
    assert.equal(p.puts.at(-1)!.rec.stage, "failed");
  }
  const stopped = direct({ ops: { out: [{ stage: "stopped" }], pool: [{ stage: "quote_checked" }] } });
  await stopped.m.move("solana", 20_000_000n, "r", "base");
  await stopped.m.idle();
  assert.deepEqual(stopped.puts.map((x) => x.rec.stage), ["leaving", "failed"]);
  const expired = direct({ ops: { out: [{ stage: "sent", txs: [{ chain: "solana", hash: "S" }] }], pool: [{ stage: "quote_checked" }, { stage: "expired" }] } });
  await expired.m.move("solana", 20_000_000n, "r", "base");
  await expired.m.idle();
  assert.deepEqual(expired.puts.map((x) => x.rec.stage), ["leaving", "in_transit", "failed"]);
  const back = direct({ ops: { out: [{ stage: "sent", txs: [{ chain: "solana", hash: "S" }] }], pool: [{ stage: "refunded" }, { stage: "refund_move" }, { stage: "in_pool", final: true }] } });
  await back.m.move("solana", 20_000_000n, "r", "base");
  await back.m.idle();
  assert.deepEqual(back.puts.map((x) => x.rec.stage), ["leaving", "refunded", "done"]);
});

test("pool to pool, one swap, after a reload: a move op with no cash follows its pool op on; nothing is quoted or run again", async () => {
  const p = direct({ ops: { out: [{ stage: "sent", txs: [{ chain: "solana", hash: "S" }] }], pool: [{ stage: "in_pool", final: true, txs: [{ chain: "base", hash: "B" }] }] } });
  p.m.resume([{ id: "mv-2", rec: { kind: "move", from: "solana", to: "base", stage: "in_transit", txs: [{ chain: "solana", hash: "S" }], amount: "0.02", out: "0.00076", created_ms: 1 } }]);
  await p.m.idle();
  assert.equal(p.quoted.length + p.runs.length + p.onward.length, 0);
  assert.equal(p.puts.at(-1)!.rec.stage, "done");
  assert.deepEqual(p.puts.at(-1)!.rec.txs, [{ chain: "solana", hash: "S" }, { chain: "base", hash: "B" }]);
});

test("pool.move.dry Solana to Base, one swap: out in Base's coin at the device's prices less 3%, the fee in SOL, three steps with no vault; under Base's pool floor the least that clears it; a read not in yet is down", async () => {
  const kinds = (p: ReturnType<typeof direct>) => poolMoveKinds(() => cashMover({ price: () => null, rails: [], quote: async () => ({ error: "not_allowed" }), fee: async () => 0n, cash: async () => 0n, handoff: null, landed: async () => false, now: () => 0 }), () => p.m);
  // the answer as plain data (a HostAnswer's `then` would make an async function's answer a thenable)
  const dry = async (p: ReturnType<typeof direct>, amount: string): Promise<unknown> => {
    const r = kinds(p)["pool.move.dry"]({ from: "solana", to: "base", amount }, { id: "d", sha: "00", progress: () => {} });
    assert.ok("running" in r);
    await r.after;
    return JSON.parse(JSON.stringify(r.answer())) as unknown;
  };
  // 0.02 SOL at 80 USD = 1.6 USD = 0.0008 ETH at 2,000, less 3%: 0.000776
  assert.deepEqual(await dry(direct(), "0.02"), { result: { out: "0.000776", fee: "0.001305", steps: [{ step: "pool_out", chain: "solana" }, { step: "intents", chain: "base" }, { step: "pool_in", chain: "base" }], max: "0.03739" } });
  // Base's floor 0.001 ETH: 0.02 SOL brings 0.000776, so the least SOL that clears it, and no out
  const low = await dry(direct({ floor: 1_000_000_000_000_000n }), "0.02") as { result: { min?: string; out?: string } };
  assert.equal(low.result.out, undefined);
  assert.ok(low.result.min !== undefined && Number(low.result.min) > 0.02 && Number(low.result.min) * 80 / 2000 * 0.97 >= 0.001, JSON.stringify(low));
  // the reads not in yet: Base's price, Solana's price, Base's floor
  assert.deepEqual(await dry(direct({ price: (c) => (c === "solana" ? SOL : null) }), "0.02"), { error: "down" });
  assert.deepEqual(await dry(direct({ price: (c) => (c === "solana" ? null : ETH) }), "0.02"), { error: "down" });
  assert.deepEqual(await dry(direct({ floor: null }), "0.02"), { error: "down" });
  // and the move is held to its dry: under the floor nothing is quoted or run
  const p = direct({ floor: 1_000_000_000_000_000n });
  const run = kinds(p)["pool.move"]({ from: "solana", to: "base", amount: "0.02" }, { id: "m", sha: "00", progress: () => {} });
  assert.ok("running" in run);
  await run.after;
  assert.deepEqual(run.answer(), { error: "below_min" });
  assert.equal(p.quoted.length + p.runs.length, 0);
});

test("pool to Cash: a price or the pool's funds not read yet is down (Busy, Retry), never not_allowed", async () => {
  const d0 = { price: () => null, funds: async () => FUNDS, quote: async () => ({ error: "not_allowed" as const }), onChain: () => true, withdraw: () => () => {}, op: async () => undefined, update: async () => undefined, now: () => 1 };
  assert.deepEqual(await poolToCash(d0).dry("solana", 20_000_000n), { error: "down" });
  assert.deepEqual(await poolToCash({ ...d0, price: () => SOL, funds: async () => Promise.reject(new TypeError("fetch failed")) }).dry("solana", 20_000_000n), { error: "down" });
});
