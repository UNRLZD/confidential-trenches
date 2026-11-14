// pool.move and pool.move.dry on the signing page (card one-balance-buys-on-every-chain): Cash to the Solana pool runs
// through the same mover a buy's shortfall does (src/cash-to-pool.ts cashMover.move), writes one move op and moves its
// stage from the hand-off and the pool deposit follow; every other pair is refused not_allowed, its dry too. Red at
// 8b620897f: the page has no pool.move, no move op and no dry of it. Card move-sends-what-it-shows: each move is held to
// its dry, which reads the destination pool's deposit floor (here 0.001 SOL, and 0.001 ETH plus a deposit's gas), and
// the dry names max, the most Cash sends (its balance less the withdraw fee), and answers an amount over it with max.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashMover, poolMoveKinds, type CashMoverDeps, type CashQuote, type MoveOpRecord } from "../src/cash-to-pool.ts";
import type { HandoffEnd } from "../src/withdraw/handoff.ts";
import { opOf } from "../src/state.ts";

const ADDRESS = "a".repeat(64);
const PRICE = { price: "8000000000", expo: -8 }; // SOL at 80 USD
const ctx = { id: "req-1", sha: "00", progress: () => {} };

type Follow = { stage: string; final?: true; txs?: { chain: "solana"; hash: string }[] } | undefined;
const ETH = { price: "300000000000", expo: -8 }; // ETH at 3,000 USD
function page(o: { cash?: bigint; quote?: (usdc: bigint) => CashQuote | { error: string }; end?: HandoffEnd; follows?: Follow[]; price?: null } = {}) {
  const chains: string[] = [];
  const followed: string[] = [];
  const paid: { recipient: string; amount: bigint; fee: bigint }[] = [];
  const quoted: { usdc: bigint; id: string }[] = [];
  const puts: { id: string; rec: MoveOpRecord }[] = [];
  const follows = [...(o.follows ?? [])];
  let f = 0;
  const d: CashMoverDeps = {
    price: (c) => (o.price === null ? null : c === "solana" ? PRICE : ETH),
    rails: ["1click"],
    quote: async (chain, usdc, id) => (chains.push(chain), quoted.push({ usdc, id }), o.quote?.(usdc) ?? { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 9n) / 80_000_000n }),
    fee: async () => 50_000n,
    cash: async () => o.cash ?? 1_000_000_000n,
    handoff: async (w, fee) => (paid.push({ recipient: w.recipient, amount: w.amount, fee }), o.end ?? { kind: "landed", tx: "NearTx1" }),
    landed: async () => false,
    floor: async (c) => (c === "solana" ? 1_000_000n : 1_030_000_000_000_000n),
    now: () => 1_000,
    put: async (id, rec) => void puts.push({ id, rec: structuredClone(rec) }),
    follow: async (id) => (followed.push(id), follows[Math.min(f++, follows.length - 1)]),
    wait: async () => {},
  };
  const m = cashMover(d);
  return { m, k: poolMoveKinds(() => m), paid, quoted, puts, chains, followed };
}

async function settle(a: unknown): Promise<unknown> {
  const r = a as { after?: Promise<unknown>; answer?: () => unknown };
  if (r.after === undefined) return { ...(a as object) };
  await r.after;
  return { ...(r.answer!() as object) };
}

test("pool.move near -> solana: one move op, leaving -> in_transit -> into_pool -> done, the exact amount out of the vault to the checked quote", async () => {
  const p = page({ follows: [{ stage: "in_transit" }, { stage: "in_pool", txs: [{ chain: "solana", hash: "SolTx1" }] }, { stage: "in_pool", final: true, txs: [{ chain: "solana", hash: "SolTx1" }] }] });
  assert.deepEqual(await settle(p.k["pool.move"]({ from: "near", to: "solana", amount: "25.5" }, ctx)), { result: { stage: "leaving", txs: [] } });
  await p.m.idle();
  assert.deepEqual(p.quoted, [{ usdc: 25_500_000n, id: "req-1/1click" }], "the quote's follow op beside the move op");
  assert.deepEqual(p.paid, [{ recipient: ADDRESS, amount: 25_500_000n, fee: 50_000n }]);
  assert.deepEqual(new Set(p.puts.map((x) => x.id)), new Set(["req-1"]), "one move op, under the request's id");
  // leaving twice: written before the quote is asked, then with the quote's out (card move-sends-or-says-why)
  assert.deepEqual(p.puts.map((x) => x.rec.stage), ["leaving", "leaving", "in_transit", "into_pool", "done"]);
  const last = p.puts.at(-1)!.rec;
  assert.deepEqual({ ...last, created_ms: 0 }, { kind: "move", from: "near", to: "solana", stage: "done", txs: [{ chain: "near", hash: "NearTx1" }, { chain: "solana", hash: "SolTx1" }], amount: "25.5", out: "0.31875", created_ms: 0 });
  // the record reads back as a move op the kit's schema takes
  assert.deepEqual(opOf("req-1", last), { id: "req-1", kind: "move", from: "near", to: "solana", stage: "done", txs: last.txs, amount: "25.5", out: "0.31875", created_ms: 1_000 });
});

test("pool.move: a refused hand-off ends the op failed; a refunded follow reads refunded", async () => {
  const p = page({ end: { kind: "expired" } as HandoffEnd });
  await settle(p.k["pool.move"]({ from: "near", to: "solana", amount: "25.5" }, ctx));
  await p.m.idle();
  assert.deepEqual(p.puts.map((x) => x.rec.stage), ["leaving", "leaving", "failed"]);
  const r = page({ follows: [{ stage: "refunded" }, { stage: "expired" }] });
  await settle(r.k["pool.move"]({ from: "near", to: "solana", amount: "25.5" }, ctx));
  await r.m.idle();
  assert.deepEqual(r.puts.map((x) => x.rec.stage), ["leaving", "leaving", "in_transit", "refunded", "failed"]);
});

test("pool.move: a quote that is not a NEAR implicit account, not the amount asked, or under the least withdraws nothing, its op failed with no tx", async () => {
  for (const q of [
    { address: "intents.near", amountIn: 25_500_000n, minOut: 318_750_000n },
    { address: ADDRESS, amountIn: 25_500_001n, minOut: 318_750_000n },
    { address: ADDRESS, amountIn: 25_500_000n, minOut: 299_000_000n },
    { error: "above_max" },
  ]) {
    const p = page({ quote: () => q });
    const a = (await settle(p.k["pool.move"]({ from: "near", to: "solana", amount: "25.5" }, ctx))) as { error?: string };
    await p.m.idle();
    const name = JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    assert.ok(a.error !== undefined, name);
    assert.deepEqual(p.paid, [], name);
    // the record written before the quote, then failed (card move-sends-or-says-why)
    assert.deepEqual(p.puts.map((x) => [x.id, x.rec.stage, x.rec.txs]), [["req-1", "leaving", []], ["req-1", "failed", []]], name);
  }
});

test("pool.move: from === to, an unknown chain, a zero or malformed amount: not_allowed; above Cash with its fee: not_funded; nothing withdrawn, no op", async () => {
  const cases: [Record<string, unknown>, string, bigint?][] = [
    [{ from: "near", to: "near", amount: "1" }, "not_allowed"],
    [{ from: "near", to: "ethereum", amount: "1" }, "not_allowed"],
    [{ from: "near", to: "solana", amount: "0" }, "not_allowed"],
    [{ from: "near", to: "solana", amount: "0.0000001" }, "not_allowed"],
    [{ from: "near", to: "solana", amount: "1e3" }, "not_allowed"],
    [{ from: "near", to: "solana", amount: 5 }, "not_allowed"],
    [{ from: "near", to: "solana", amount: "25.5" }, "not_funded", 25_549_999n],
  ];
  for (const [params, code, cash] of cases) {
    for (const kind of ["pool.move", "pool.move.dry"] as const) {
      const p = page(cash === undefined ? {} : { cash });
      // over what Cash sends: the dry answers that most, with no out (card move-sends-what-it-shows); the move is refused
      const want = kind === "pool.move.dry" && code === "not_funded" ? { result: { max: "25.499999", steps: [{ step: "vault_out", chain: "near" }, { step: "intents", chain: "solana" }, { step: "pool_in", chain: "solana" }] } } : { error: code };
      assert.deepEqual(await settle(p.k[kind](params, ctx)), want, `${kind} ${JSON.stringify(params)}`);
      await p.m.idle();
      assert.deepEqual(p.paid, []);
      assert.deepEqual(p.quoted, []);
      assert.deepEqual(p.puts, []);
    }
  }
});

test("every pair but Cash to a pool: not_allowed, its dry too (pool to Cash and pool to pool build next)", async () => {
  const chains = ["near", "solana", "base", "robinhood"];
  for (const from of chains)
    for (const to of chains) {
      if (from === to || from === "near") continue;
      for (const kind of ["pool.move", "pool.move.dry"] as const) {
        const p = page();
        assert.deepEqual(await settle(p.k[kind]({ from, to, amount: "1" }, ctx)), { error: "not_allowed" }, `${kind} ${from} -> ${to}`);
        assert.deepEqual(p.paid, []);
      }
    }
});

test("pool.move.dry near -> solana: out (the least the move takes, in SOL), fee (the withdraw fee, in USDC) and the three steps; signs, writes and sends nothing", async () => {
  const p = page();
  assert.deepEqual(await settle(p.k["pool.move.dry"]({ from: "near", to: "solana", amount: "25.544" }, ctx)), {
    result: { out: "0.3", fee: "0.05", steps: [{ step: "vault_out", chain: "near" }, { step: "intents", chain: "solana" }, { step: "pool_in", chain: "solana" }], max: "999.95" },
  });
  assert.deepEqual([p.paid, p.quoted, p.puts], [[], [], []]);
  const none = page({ price: null });
  assert.deepEqual(await settle(none.k["pool.move.dry"]({ from: "near", to: "solana", amount: "25.544" }, ctx)), { error: "not_allowed" }, "no price: no promise");
});

test("pool.move near -> base and near -> robinhood: the quote asked for that chain's pool, its least in wei at the device's ETH price less 3% and the EVM rung (0.001 ETH), the op's out in ETH", async () => {
  for (const to of ["base", "robinhood"] as const) {
    // a quote that delivers the least exactly: taken; one wei under it: refused, nothing withdrawn
    const least = 7_252_427_184_466_019n;
    const p = page({ quote: (usdc) => ({ address: ADDRESS, amountIn: usdc, minOut: least }), follows: [{ stage: "in_pool", final: true }] });
    assert.deepEqual(await settle(p.k["pool.move"]({ from: "near", to, amount: "25.5" }, ctx)), { result: { stage: "leaving", txs: [] } }, to);
    await p.m.idle();
    assert.deepEqual(p.chains, [to]);
    assert.deepEqual(p.paid, [{ recipient: ADDRESS, amount: 25_500_000n, fee: 50_000n }]);
    assert.deepEqual(p.puts.map((x) => [x.rec.to, x.rec.stage, x.rec.out]), [[to, "leaving", undefined], [to, "leaving", "0.007252427184466019"], [to, "in_transit", "0.007252427184466019"], [to, "done", "0.007252427184466019"]]);
    const short = page({ quote: (usdc) => ({ address: ADDRESS, amountIn: usdc, minOut: least - 1n }) });
    assert.ok("error" in ((await settle(short.k["pool.move"]({ from: "near", to, amount: "25.5" }, ctx))) as object), to);
    assert.deepEqual(short.paid, []);
    const dry = page();
    assert.deepEqual(await settle(dry.k["pool.move.dry"]({ from: "near", to, amount: "25.5" }, ctx)), {
      result: { out: "0.007252427184466019", fee: "0.05", steps: [{ step: "vault_out", chain: "near" }, { step: "intents", chain: to }, { step: "pool_in", chain: to }], max: "999.95" },
    });
  }
});

test("resume after a reload: each move op not yet done or failed follows its quote's follow op (<op>/1click) on from its last stage; an ended one is left as it is; nothing is withdrawn", async () => {
  const p = page({ follows: [{ stage: "in_pool", txs: [{ chain: "solana", hash: "SolTx1" }] }, { stage: "in_pool", final: true, txs: [{ chain: "solana", hash: "SolTx1" }] }] });
  const rec = (stage: MoveOpRecord["stage"]): MoveOpRecord => ({ kind: "move", from: "near", to: "solana", stage, txs: [{ chain: "near", hash: "NearTx1" }], amount: "25.5", out: "0.3", created_ms: 5 });
  p.m.resume([
    { id: "mv-run", rec: rec("in_transit") },
    { id: "mv-done", rec: rec("done") },
    { id: "mv-failed", rec: rec("failed") },
  ]);
  await p.m.idle();
  assert.deepEqual([...new Set(p.followed)], ["mv-run/1click"], "only the op on its way is followed, by its follow op's id");
  assert.deepEqual(p.puts.map((x) => [x.id, x.rec.stage, x.rec.txs.map((t) => t.hash)]), [["mv-run", "into_pool", ["NearTx1", "SolTx1"]], ["mv-run", "done", ["NearTx1", "SolTx1"]]]);
  assert.deepEqual([p.paid, p.quoted], [[], []]);
});
