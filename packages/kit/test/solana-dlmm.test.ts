/// <reference types="node" />
// A coin whose SOL pool is a Meteora DLMM pair gets a device reference (card solana-buy-reaches-raydium-and-meteora).
// Replays NEARKAT's pair B8BH6ZKr… as two mainnet providers answered it (test/vectors/nearkat-dlmm.json: the pair, the
// Token-2022 mint with its 3% transfer fee, the Clock, both reserves and three bin arrays), and holds E to the program's
// own out for the same buy (simulateTransaction of swap2, nothing sent) to the unit. Bad: reserves outside the band
// and static bytes that differ refuse the route; a coin extension the reference does not price, a pair of another coin
// and a disabled pair are no candidate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64 } from "@scure/base";
import { readSolanaReferenceWhy } from "../src/trade/solana/pool.ts";
import { solanaCoinTransferFee, solanaDlmmTotalFee, solanaTransferFeeOf } from "../src/trade/solana/dlmm.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

type Acc = { owner: string; data: string } | null;
type Provider = { slot: number; accounts: Record<string, Acc> };
const V = JSON.parse(readFileSync(new URL("./vectors/nearkat-dlmm.json", import.meta.url), "utf8")) as {
  mint: string; pair: string; providers: Record<string, Provider>; programOut: Record<string, { out: string; slot: number }>;
};
const [PA, PB] = Object.values(V.providers) as [Provider, Provider];

/** A provider that answers getMultipleAccounts from its recorded accounts (any other address: no account). */
function replay(p: Provider, edit: (addr: string, data: Uint8Array) => Uint8Array = (_a, d) => d): SolanaRpc {
  return (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const list = params[0] as string[];
    return {
      context: { slot: p.slot },
      value: list.map((a) => {
        const x = p.accounts[a];
        if (!x) return null;
        return { owner: x.owner, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(edit(a, base64.decode(x.data))), "base64"] };
      }),
    };
  }) as SolanaRpc;
}
const buy = (amount: bigint, extra: Record<string, unknown> = {}) => ({ side: "buy" as const, token: V.mint, amount, amounts: [1_000_000_000n], ...extra });
const accountOf = (owner: string, p: Provider) => Object.entries(p.accounts).find(([, v]) => v?.owner === owner)?.[0];

test("a DLMM coin's buy gets the device's reference, equal to the program's own out to the unit (NEARKAT, two providers)", async () => {
  const r = await readSolanaReferenceWhy([replay(PA), replay(PB)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.ok("reference" in r, `no reference: ${"refused" in r ? r.refused : ""}`);
  assert.equal(r.reference.expectedOut, BigInt(V.programOut["100000000"]!.out));
  assert.deepEqual(r.reference.expectedOuts, [BigInt(V.programOut["1000000000"]!.out)]);
  assert.equal(r.reference.pools.length, 1);
  assert.equal(r.reference.pools[0]!.venue, "dlmm");
  assert.equal(r.reference.pools[0]!.address, V.pair);
  assert.equal(r.reference.slot, Math.min(PA.slot, PB.slot));
});

test("without its DLMM pair the same coin has no reference pool (what main answered for every Raydium or Meteora coin)", async () => {
  const r = await readSolanaReferenceWhy([replay(PA), replay(PB)], buy(100_000_000n));
  assert.deepEqual(r, { refused: "no reference pool" });
});

test("a reserve outside the band on one provider refuses the route after the one re-read", async () => {
  const pair = PA.accounts[V.pair]!;
  const reserveY = (await import("../src/trade/solana/dlmm.ts")).solanaDecodeDlmmPair({ owner: pair.owner, data: base64.decode(pair.data) }).reserveY;
  const fat = (a: string, d: Uint8Array) => {
    if (a !== reserveY) return d;
    const c = d.slice();
    const v = new DataView(c.buffer);
    v.setBigUint64(64, (v.getBigUint64(64, true) * 105n) / 100n, true);
    return c;
  };
  const r = await readSolanaReferenceWhy([replay(PA), replay(PB, fat)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.ok("refused" in r && /reserves are outside the band, after a re-read/.test(r.refused), JSON.stringify(r));
});

test("a first read of the pair alone on one provider that names another reserve owned by the pair refuses the route (every later read honest)", async () => {
  // any token account of a mint can be made out to the pair's address, so a list naming one passes the reserve's mint and
  // owner check: the list must be the one the agreed pair bytes name (pair reserve_x at 152, reserve_y at 184)
  const { base58 } = await import("@scure/base");
  const { solanaDecodeDlmmPair } = await import("../src/trade/solana/dlmm.ts");
  const pair = solanaDecodeDlmmPair({ owner: PA.accounts[V.pair]!.owner, data: base64.decode(PA.accounts[V.pair]!.data) });
  const SOL = "So11111111111111111111111111111111111111112";
  const [at, mint, real] = pair.tokenX === SOL ? [152, pair.tokenX, pair.reserveX] : [184, pair.tokenY, pair.reserveY];
  const FAKE = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff));
  const d = base64.decode(PA.accounts[real]!.data).slice(0, 165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(V.pair), 32);
  new DataView(d.buffer).setBigUint64(64, new DataView(d.buffer).getBigUint64(64, true) * 1_000n, true);
  const fake = { owner: PA.accounts[real]!.owner, data: base64.encode(d) };
  const lying = (p: Provider, head: boolean): SolanaRpc => {
    const q: Provider = { slot: p.slot, accounts: { ...p.accounts, [FAKE]: fake } };
    return (async (method: string, params: readonly unknown[]) => {
      const list = params[0] as string[];
      const lie = head && list.length === 1 && list[0] === V.pair;
      return replay(q, (a, x) => (lie && a === V.pair ? Object.assign(x.slice(), Object.fromEntries([...base58.decode(FAKE)].map((b, i) => [at + i, b]))) : x))(method as never, params as never);
    }) as SolanaRpc;
  };
  const honest = await readSolanaReferenceWhy([lying(PA, false), lying(PB, false)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.ok("reference" in honest, "refused" in honest ? honest.refused : "");
  // provider A's first read plans the list: its lie refuses the route
  const r = await readSolanaReferenceWhy([lying(PA, true), lying(PB, false)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.ok("refused" in r && /accounts that are not the pair's own, after a re-read/.test(r.refused), "reference" in r ? `depth ${r.reference.pools[0]!.depth}` : r.refused);
  // provider B's first read plans nothing once A's does: its lie moves nothing
  const rb = await readSolanaReferenceWhy([lying(PA, false), lying(PB, true)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.ok("reference" in rb && rb.reference.pools[0]!.depth.join() === honest.reference.pools[0]!.depth.join(), "refused" in rb ? rb.refused : `depth ${rb.reference.pools[0]!.depth}`);
});

// card dlmm-pair-never-priced-at-zero: the read list's bin arrays are planned from one provider's first read of the pair
// alone. A first read whose active_id (i32 at 76) is moved plans bin arrays that miss the ones the agreed read walks; the
// kit plans them again from the agreed read and never prices the pair at 0 (before: +70 bins on a buy, or -70 on a
// sell, walked nothing, priced the pair 0, and the route answered "no pool pays out for this amount").
const moveActive = (d: Uint8Array, bins: number): Uint8Array => {
  const c = d.slice();
  const v = new DataView(c.buffer);
  v.setInt32(76, v.getInt32(76, true) + bins, true);
  return c;
};
/** A provider whose first read of the pair alone moves its active_id by `bins`; every later read honest. */
const headMoves = (p: Provider, bins: number): SolanaRpc => {
  let first = true;
  return (async (method: string, params: readonly unknown[]) => {
    const list = params[0] as string[];
    const head = first && list.length === 1 && list[0] === V.pair;
    if (head) first = false;
    return replay(p, (a, d) => (head && a === V.pair ? moveActive(d, bins) : d))(method as never, params as never);
  }) as SolanaRpc;
};
const sell = (amount: bigint) => ({ side: "sell" as const, token: V.mint, amount, amounts: [amount / 10n] });
const E = (r: Awaited<ReturnType<typeof readSolanaReferenceWhy>>) => ("reference" in r ? [r.reference.expectedOut, ...r.reference.expectedOuts] : r.refused);

test("a first read on provider A that moves the pair's active bin by +70 or -70 still gets the honest out, buy and sell", async () => {
  for (const req of [buy(100_000_000n, { dlmmPairs: [V.pair] }), buy(5_000_000_000n, { dlmmPairs: [V.pair] }), { ...sell(10_000_000_000n), dlmmPairs: [V.pair] }]) {
    const honest = E(await readSolanaReferenceWhy([replay(PA), replay(PB)], req));
    assert.ok(Array.isArray(honest) && honest[0]! > 0n, `${req.side} ${req.amount}: no honest reference: ${String(honest)}`);
    for (const bins of [70, -70]) {
      const got = E(await readSolanaReferenceWhy([headMoves(PA, bins), replay(PB)], req));
      assert.deepEqual(got, honest, `${req.side} ${req.amount}, first read moved ${bins} bins`);
    }
  }
});

test("the other first-read moves (-140, -35, +35, +140) and the same move on provider B give the honest out", async () => {
  for (const req of [buy(100_000_000n, { dlmmPairs: [V.pair] }), { ...sell(10_000_000_000n), dlmmPairs: [V.pair] }]) {
    const honest = E(await readSolanaReferenceWhy([replay(PA), replay(PB)], req));
    for (const bins of [-140, -35, 35, 140]) assert.deepEqual(E(await readSolanaReferenceWhy([headMoves(PA, bins), replay(PB)], req)), honest, `${req.side} A ${bins}`);
    for (const bins of [70, -70]) assert.deepEqual(E(await readSolanaReferenceWhy([replay(PA), headMoves(PB, bins)], req)), honest, `${req.side} B ${bins}`);
  }
});

test("the active bin moving into another bin array between the first read and the pair's own read still prices the pair", async () => {
  // both providers' pair reads after their first one sit in the bin array behind the walk, as a pool that moved: a buy
  // (walking up) at -491 (array -8, one bin past -7's lower edge), a sell (walking down) at -421 (array -6's first bin);
  // each walk takes the bin arrays a swap from there names, read with the pair's other accounts at one slot
  const moved = (p: Provider, bins: number): SolanaRpc => {
    let first = true;
    return (async (method: string, params: readonly unknown[]) => {
      const list = params[0] as string[];
      const head = first && list.length === 1 && list[0] === V.pair;
      if (head) first = false;
      return replay(p, (a, d) => (!head && a === V.pair ? moveActive(d, bins) : d))(method as never, params as never);
    }) as SolanaRpc;
  };
  for (const [req, bins] of [[buy(100_000_000n, { dlmmPairs: [V.pair] }), -15], [{ ...sell(10_000_000_000n), dlmmPairs: [V.pair] }, 55]] as const) {
    const r = await readSolanaReferenceWhy([moved(PA, bins), moved(PB, bins)], req);
    assert.ok("reference" in r && r.reference.expectedOut > 0n && r.reference.pools[0]!.venue === "dlmm", `${req.side}: ${"refused" in r ? r.refused : ""}`);
  }
});

test("a pair whose active bin leaves the bin arrays read on every read is refused after the re-read, never priced at 0", async () => {
  // provider A answers every pair read with a new active bin, one bin array further each time: a re-plan never catches it
  let n = 0;
  const running: SolanaRpc = (async (method: string, params: readonly unknown[]) => {
    const list = params[0] as string[];
    const k = list.includes(V.pair) ? ++n : n;
    return replay(PA, (a, d) => (a === V.pair ? moveActive(d, 70 * k) : d))(method as never, params as never);
  }) as SolanaRpc;
  const r = await readSolanaReferenceWhy([running, replay(PB)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.ok("refused" in r && /active bin left the bin arrays read, after a re-read/.test(r.refused), JSON.stringify(E(r), (_k, v) => (typeof v === "bigint" ? String(v) : v)));
});

test("a static byte of the pair that differs (its base factor) refuses the route", async () => {
  const r = await readSolanaReferenceWhy([replay(PA), replay(PB, (a, d) => (a === V.pair ? Object.assign(d.slice(), { [8]: d[8]! ^ 1 }) : d))], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.ok("refused" in r && /static bytes differ/.test(r.refused), JSON.stringify(r));
});

test("a coin with a Token-2022 extension the reference does not price (a transfer hook) is no candidate", async () => {
  // the mint's first extension (metadata pointer, type 18 at 166) relabelled as TransferHook (14) on both providers
  const hook = (a: string, d: Uint8Array) => (a === V.mint ? Object.assign(d.slice(), { [166]: 14 }) : d);
  const r = await readSolanaReferenceWhy([replay(PA, hook), replay(PB, hook)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.deepEqual(r, { refused: "no reference pool" });
});

test("a pair of another coin, and a disabled pair, are no candidate", async () => {
  const other = await readSolanaReferenceWhy([replay(PA), replay(PB)], { side: "buy", token: "So11111111111111111111111111111111111111112", amount: 1n, dlmmPairs: [V.pair] });
  assert.deepEqual(other, { refused: "no reference pool" });
  const off = (a: string, d: Uint8Array) => (a === V.pair ? Object.assign(d.slice(), { [82]: 1 }) : d);
  const r = await readSolanaReferenceWhy([replay(PA, off), replay(PB, off)], buy(100_000_000n, { dlmmPairs: [V.pair] }));
  assert.deepEqual(r, { refused: "no reference pool" });
});

test("a pair list over the cap, or a pair that is not an address, is refused before any read", async () => {
  const many = Array.from({ length: 9 }, (_, i) => accountOf("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", PA)!.slice(0, 40) + String(i).padStart(4, "A"));
  await assert.rejects(readSolanaReferenceWhy([replay(PA), replay(PB)], buy(1n, { dlmmPairs: many })), /at most 8 DLMM pairs/);
  await assert.rejects(readSolanaReferenceWhy([replay(PA), replay(PB)], buy(1n, { dlmmPairs: ["not-a-key"] })));
});

test("the fee: base plus variable capped at 10%, and the coin's transfer fee by epoch with its cap", () => {
  const p = { baseFactor: 10_000n, binStep: 100n, baseFeePowerFactor: 0n, variableFeeControl: 7_500n };
  assert.equal(solanaDlmmTotalFee(p, 0n), 10_000_000n); // 1%
  // variable: ceil(7,500 × (100,000 × 100)² / 1e11) = 7,500,000; total 17,500,000
  assert.equal(solanaDlmmTotalFee(p, 100_000n), 17_500_000n);
  assert.equal(solanaDlmmTotalFee(p, 1n), 10_000_001n); // ceil(7,500 × 10,000 / 1e11) = 1
  assert.equal(solanaDlmmTotalFee(p, 1_000_000n), 100_000_000n); // 760,000,000 capped at 10%
  const mint = PA.accounts[V.mint]!;
  const fee = solanaCoinTransferFee({ owner: mint.owner, data: base64.decode(mint.data) }, 2_000n);
  assert.deepEqual(fee, { bps: 300n, max: 1_000_000_000_000_000n });
  assert.equal(solanaTransferFeeOf(fee, 1_000n), 30n);
  assert.equal(solanaTransferFeeOf(fee, 1n), 1n); // rounded up
  assert.equal(solanaTransferFeeOf({ bps: 300n, max: 5n }, 1_000n), 5n);
});
