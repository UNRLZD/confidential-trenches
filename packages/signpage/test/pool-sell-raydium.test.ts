// Card solana-buy-reaches-raydium-and-meteora: a coin bought privately on a Raydium CPMM or AMM v4 pool sells privately on
// that pool, part of it and all of it, and W's accounts end with nothing left on them. The pools are HIGH's CPMM pool
// CqvMZmWD… and CzLSuj's AMM v4 pool 9Tb2ohu5… as two mainnet providers answered them (packages/kit/test/vectors/
// high-cpmm.json, czlsuj-amm-v4.json); the chain around them is pool-sell-world.ts's. The page finds each pool with its
// finder (main.ts setPagePoolFinders), as on mainnet.
//   node --test test/pool-sell-raydium.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";
import { openWalletStore } from "@blindfill/wallet/store";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { SOL_GRID, SOL_NOTE_FLOOR } from "../../wallet/src/pool/pieces.ts";
import { isRung } from "../../wallet/src/pool/ladder.ts";
import { solanaAta, solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { SOLANA_CPMM_PROGRAM } from "../../kit/src/trade/solana/cpmm.ts";
import { SOLANA_AMM_V4_PROGRAM } from "../../kit/src/trade/solana/amm-v4.ts";
import { solanaSellFloor } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { PROGRAM, raydiumField, raydiumProviders, raydiumVectors, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { setPagePoolFinders } from "../src/page-rpc.ts";
import { forgetPageLoad, runPoolSell, solanaSellBudgetFits, type PoolSellHost } from "../src/pool-sell.ts";
import { poolSellPays } from "../src/pool-sell-dry.ts";
import { solanaSweepOf, solanaSweepStay } from "../src/rules/pool.ts";
import { ASK, ENOUGH, J, L, PIN, RAYDIUM_AMOUNT, SEED64, VF, W, chain, rentMin, sellAt, type Plant, type RaydiumVenue } from "./pool-sell-world.ts";

const KINDS = ["raydium-cpmm", "raydium-amm-v4"] as const;
// the page's finders on mainnet find each coin's Raydium SOL pools: here, each coin's one pool
setPagePoolFinders({
  cpmmPools: async (token) => (token === raydiumVectors["raydium-cpmm"].mint ? [raydiumVectors["raydium-cpmm"].pool] : []),
  ammV4Pools: async (token) => (token === raydiumVectors["raydium-amm-v4"].mint ? [raydiumVectors["raydium-amm-v4"].pool] : []),
});
const closers: (() => void)[] = [];
after(() => {
  setPagePoolFinders(null);
  closers.forEach((f) => f());
});

const PROG = { "raydium-cpmm": SOLANA_CPMM_PROGRAM, "raydium-amm-v4": SOLANA_AMM_V4_PROGRAM } as const;
// where the swap names the pool, W's coin in and W's wrapped SOL out (the kit's cpmmSwap and ammV4Swap)
const AT = { "raydium-cpmm": { pool: 3, src: 4, dst: 5 }, "raydium-amm-v4": { pool: 1, src: 5, dst: 6 } } as const;
const wallet = (kind: RaydiumVenue, amount: bigint): BuyWallet => ({
  pool: PROGRAM, chain: "sol", note: "n1", l: L, j: J, path: W.path, address: W.address,
  holdings: { native: 0n, tokens: new Map([[raydiumVectors[kind].mint, { amount, frozen: false }]]), unreadable: [] },
});

async function world(kind: RaydiumVenue, plant: Plant, wallets: BuyWallet[]) {
  forgetPageLoad();
  const c = chain({ venue: kind, ...plant });
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns: NoteStore = await openNoteStore(w);
  closers.push(() => ns.close());
  const bought = new Map<string, { mint: string; program: string }>([[W.address, { mint: raydiumVectors[kind].mint, program: SOLANA_TOKEN_PROGRAM }]]);
  const host: PoolSellHost = {
    pin: PIN,
    ...(plant.cluster === undefined ? {} : { cluster: plant.cluster }),
    bought: { get: async (a) => bought.get(a), put: async (a, m) => void bought.set(a, m) },
    rpcs: c.rpcs,
    notes: async () => ns,
    seed64: async () => SEED64.slice(),
    wallets: async () => wallets,
    sent: () => {},
    owed: { list: async () => [], put: async () => {}, drop: async () => {}, empty: async () => new Set(), markEmpty: async () => {} },
    kept: { list: async () => [], put: async () => {}, drop: async () => {} },
    told: () => {},
    now: () => 1_000n,
    reads: 3,
    wait: async () => {},
    pick: () => 2,
  };
  return { c, ns, host };
}
const sigOf = (a: unknown): string => (a as { txs: { hash: string }[] }).txs[0]!.hash;
const json = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? String(v) : v));
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);

for (const kind of KINDS) {
  const vec = raydiumVectors[kind];
  const AMOUNT = RAYDIUM_AMOUNT[kind];
  const ask = { ...ASK, token: vec.mint, amount: AMOUNT };

  test(`${kind}: the sell's largest form (the deposit back) has room for the compute budget under 1,232 bytes`, () => {
    assert.equal(solanaSellBudgetFits(kind, false), true);
  });

  test(`${kind}: a partial sell swaps W's coin into its wrapped SOL on the priced pool at the floor, its proceeds deposited back as a note in the same transaction`, async () => {
    const w = await world(kind, { held: 2n * AMOUNT }, [wallet(kind, 2n * AMOUNT)]);
    const a = await runPoolSell(w.host, ask);
    assert.equal("stage" in a && a.stage, "filled", json(a));
    const m = solanaDecodeMessage(w.c.txs.get(sigOf(a))!.tx.subarray(65));
    const swap = m.instructions.find((x) => m.staticKeys[x.programIndex] === PROG[kind])!;
    assert.ok(swap && sellAt(swap.data), "the venue's swap");
    const keys = swap.accounts.map((i) => m.staticKeys[i]!);
    assert.equal(keys[AT[kind].pool], vec.pool, "the priced pool");
    assert.equal(keys[AT[kind].src], VF[kind].ata, "W's coin in");
    assert.equal(keys[AT[kind].dst], solanaAta(W.address, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), "W's wrapped SOL out");
    assert.equal(u64(swap.data, sellAt(swap.data)!.amount), AMOUNT);
    assert.equal(u64(swap.data, sellAt(swap.data)!.min), VF[kind].minOut, "min out at the floor");
    assert.equal(m.staticKeys[m.instructions.at(-1)!.programIndex], PROGRAM, "the deposit back last");
    assert.ok(w.c.deposits.some((d) => !d.sweep && d.value > 0n), json(w.c.deposits));
    assert.equal(new DataView(w.c.accounts.get(VF[kind].ata)!.data.buffer, 64, 8).getBigUint64(0, true), AMOUNT, "W keeps the rest of its coin");
  });

  test(`${kind}: a full sell: W's coin account is gone, its wrapped SOL closed by the sell, and the sweep takes W's rest into the pool`, async () => {
    const w = await world(kind, { ataLamports: Number(rentMin(165)) }, [wallet(kind, AMOUNT)]);
    const a = await runPoolSell(w.host, ask);
    assert.equal("stage" in a && a.stage, "filled", json(a));
    const sell = solanaDecodeMessage(w.c.txs.get(sigOf(a))!.tx.subarray(65));
    assert.ok(sell.instructions.some((x) => sell.staticKeys[x.programIndex] === PROG[kind]), "the venue's swap");
    assert.ok(!sell.staticKeys.includes(PROGRAM), "a full sell carries no deposit back");
    for (const t of w.c.txs.values()) assert.equal(t.err, null, json(t.err));
    assert.equal(w.c.accounts.has(VF[kind].ata), false, "W's coin account closed, its rent back to W");
    assert.equal(w.c.accounts.has(solanaAta(W.address, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)), false, "W's wrapped-SOL account closed by the sell itself");
    const sweeps = w.c.deposits.filter((d) => d.sweep);
    assert.equal(w.c.deposits.length, sweeps.length, json(w.c.deposits));
    assert.ok(sweeps.length >= 1, "W swept");
    const value = sweeps.at(-1)!.value;
    const left = BigInt(w.c.accounts.get(W.address)?.lamports ?? 0);
    assert.ok(isRung({ one: SOL_GRID, min: SOL_NOTE_FLOOR }, value), String(value));
    assert.deepEqual(solanaSweepOf(left + value, solanaSweepStay(rent, 0n)), { value, under: left });
    for (const [address, acc] of w.c.accounts) if (acc.data.length >= 64 && acc.owner === SOLANA_TOKEN_PROGRAM) assert.notEqual(base58.encode(acc.data.subarray(32, 64)), W.address, `W's token account ${address} left`);
  });

  test(`${kind}: a sale on mainnet from a W with room pays the priority fee inside 1,232 bytes, full and partial`, async () => {
    for (const full of [true, false]) {
      const held = full ? AMOUNT : 2n * AMOUNT;
      const w = await world(kind, { cluster: "mainnet", held }, [wallet(kind, held)]);
      const a = await runPoolSell(w.host, ask);
      assert.equal("stage" in a && a.stage, "filled", json(a));
      const t = w.c.txs.get(sigOf(a))!.tx;
      assert.ok(t.length <= 1232, String(t.length));
      const m = solanaDecodeMessage(t.subarray(65));
      assert.ok(m.instructions.some((x) => x.data[0] === 3 && x.data.length === 9), `${full}: a compute unit price`);
    }
  });

  test(`${kind}: the preview prices the sale with no venue cashback claim, W's wrapped-SOL account its need`, async () => {
    const e = (await readSolanaReference(raydiumProviders(kind), { side: "sell", token: vec.mint, amount: AMOUNT, [raydiumField(kind)]: [vec.pool] }))!.pools.find((p) => p.venue === kind)!;
    assert.equal(e.cashback, undefined, "a Raydium pool reads no cashback flag");
    const floor = solanaSellFloor(e.expectedOut, 1000);
    const sizes = { stateSize: 100, labelSize: 100 };
    const w0 = { lamports: BigInt(ENOUGH), claim: [false, false] as const };
    const unread = poolSellPays(rent, kind, [w0], true, e.expectedOut, floor, e.cashback, sizes);
    assert.deepEqual(unread, poolSellPays(rent, kind, [w0], true, e.expectedOut, floor, false, sizes));
    assert.ok(!("refused" in unread) && unread.out > 0n, json(unread));
    const main = poolSellPays(rent, kind, [w0], true, e.expectedOut, floor, e.cashback, sizes, true);
    assert.ok(!("refused" in main) && main.priority > 0n, json(main));
  });
}

