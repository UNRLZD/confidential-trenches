// Card solana-buy-reaches-raydium-and-meteora: a coin bought privately on a Meteora DLMM pair sells privately on that
// pair, part of it and all of it, and W's accounts end with nothing left on them. The pair is NEARKAT's (B8BH6ZKr…, a
// Token-2022 coin with a 3% transfer fee) as two mainnet providers answered it (packages/kit/test/vectors/
// nearkat-dlmm.json); the chain around it is pool-sell-world.ts's, which runs Token-2022's harvest and refuses its
// close of an account still holding withheld transfer fees.
//   node --test test/pool-sell-dlmm.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";
import { openWalletStore } from "@blindfill/wallet/store";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { SOL_GRID, SOL_NOTE_FLOOR } from "../../wallet/src/pool/pieces.ts";
import { isRung } from "../../wallet/src/pool/ladder.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SOL_MINT, SOLANA_TOKEN_2022_PROGRAM as TOKEN_2022, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_DLMM_PROGRAM } from "../../kit/src/trade/solana/dlmm.ts";
import { solanaSellFloor } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { dlmmProviders, dlmmReplay, dlmmVector, PROGRAM, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { tokenDecimalsKept } from "../src/pool-kinds.ts";
import { setPageDlmmPairs } from "../src/page-rpc.ts";
import { forgetPageLoad, runPoolSell, solanaSellBudgetFits, type PoolSellHost } from "../src/pool-sell.ts";
import { poolSellDry, poolSellPays } from "../src/pool-sell-dry.ts";
import { poolUnits, solanaNoteOf, solanaSweepOf, solanaSweepStay } from "../src/rules/pool.ts";
import { ASK, DLMM_AMOUNT, DLMM_WITHHELD, ENOUGH, J, L, PIN, SEED64, VF, W, chain, rentMin, withheldOf, type Plant } from "./pool-sell-world.ts";

// the page's finder on mainnet finds the coin's DLMM SOL pairs (main.ts setPageDlmmPairs): here, NEARKAT's one pair
setPageDlmmPairs(async (token) => (token === dlmmVector.mint ? [dlmmVector.pair] : []));
const closers: (() => void)[] = [];
after(() => {
  setPageDlmmPairs(null);
  closers.forEach((f) => f());
});

const MINT = dlmmVector.mint;
const DLMM_ASK = { ...ASK, token: MINT, amount: DLMM_AMOUNT };
const SWAP2 = [65, 75, 63, 76, 235, 91, 91, 136];
const isSwap2 = (d: Uint8Array): boolean => d.length === 28 && SWAP2.every((b, i) => d[i] === b);
const wallet = (amount: bigint): BuyWallet => ({
  pool: PROGRAM, chain: "sol", note: "n1", l: L, j: J, path: W.path, address: W.address,
  holdings: { native: 0n, tokens: new Map([[MINT, { amount, frozen: false }]]), unreadable: [] },
});

async function world(plant: Plant, wallets: BuyWallet[]) {
  forgetPageLoad();
  const c = chain({ venue: "dlmm", ...plant });
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns: NoteStore = await openNoteStore(w);
  closers.push(() => ns.close());
  const bought = new Map<string, { mint: string; program: string }>([[W.address, { mint: MINT, program: TOKEN_2022 }]]);
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

test("the DLMM sell's largest form (Token-2022, three bin arrays, the deposit back) has room for the compute budget under 1,232 bytes: a mainnet DLMM sell pays its priority", () => {
  assert.equal(solanaSellBudgetFits("dlmm", false), true);
});

test("a DLMM coin's partial sell: swap2 of W's coin into its wrapped SOL on the priced pair at the floor, its proceeds deposited back as a note in the same transaction", async () => {
  const w = await world({ held: 2n * DLMM_AMOUNT }, [wallet(2n * DLMM_AMOUNT)]);
  const a = await runPoolSell(w.host, DLMM_ASK);
  assert.equal("stage" in a && a.stage, "filled", json(a));
  const m = solanaDecodeMessage(w.c.txs.get(sigOf(a))!.tx.subarray(65));
  const swap = m.instructions.find((x) => m.staticKeys[x.programIndex] === SOLANA_DLMM_PROGRAM)!;
  assert.ok(swap && isSwap2(swap.data), "the venue's swap2");
  const keys = swap.accounts.map((i) => m.staticKeys[i]!);
  assert.equal(keys[0], dlmmVector.pair, "the priced pair");
  assert.equal(keys[4], VF.dlmm.ata, "W's coin in");
  assert.equal(keys[5], solanaAta(W.address, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), "W's wrapped SOL out");
  assert.equal(new DataView(swap.data.buffer, swap.data.byteOffset + 8, 8).getBigUint64(0, true), DLMM_AMOUNT);
  assert.equal(new DataView(swap.data.buffer, swap.data.byteOffset + 16, 8).getBigUint64(0, true), VF.dlmm.minOut, "min out at the floor");
  assert.equal(m.staticKeys[m.instructions.at(-1)!.programIndex], PROGRAM, "the deposit back last");
  assert.ok(w.c.deposits.some((d) => !d.sweep && d.value > 0n), json(w.c.deposits));
  // W keeps the rest of its coin, its account open
  assert.equal(new DataView(w.c.accounts.get(VF.dlmm.ata)!.data.buffer, 64, 8).getBigUint64(0, true), DLMM_AMOUNT);
});

test("a DLMM coin's full sell with 3% transfer fees withheld on W's coin account: the teardown harvests them to the mint before the close, W's coin account is gone, and the sweep takes W's rest into the pool", async () => {
  const w = await world({ ataLamports: Number(rentMin(182)) }, [wallet(DLMM_AMOUNT)]);
  assert.equal(withheldOf(w.c.accounts.get(VF.dlmm.ata)!.data), DLMM_WITHHELD, "the buy's fees withheld on W's account");
  const a = await runPoolSell(w.host, DLMM_ASK);
  assert.equal("stage" in a && a.stage, "filled", json(a));
  const sell = solanaDecodeMessage(w.c.txs.get(sigOf(a))!.tx.subarray(65));
  assert.ok(sell.instructions.some((x) => isSwap2(x.data)), "the venue's swap2");
  assert.ok(!sell.staticKeys.includes(PROGRAM), "a full sell carries no deposit back");
  // the teardown frame: Token-2022's HarvestWithheldTokensToMint on W's coin account, then its CloseAccount
  const frames = [...w.c.txs.values()].map((t) => solanaDecodeMessage(t.tx.subarray(65))).filter((m) => m.instructions.some((x) => m.staticKeys[x.programIndex] === TOKEN_2022 && x.data.length === 1 && x.data[0] === 9));
  assert.equal(frames.length, 1, "one teardown frame closes W's coin account");
  const f = frames[0]!;
  const at = (k: number[]) => f.instructions.findIndex((x) => f.staticKeys[x.programIndex] === TOKEN_2022 && x.data.length === k.length && k.every((b, i) => x.data[i] === b) && f.staticKeys[x.accounts[k.length === 2 ? 1 : 0]!] === VF.dlmm.ata);
  assert.ok(at([26, 4]) >= 0 && at([26, 4]) < at([9]), "harvest before close");
  for (const t of w.c.txs.values()) assert.equal(t.err, null, json(t.err));
  assert.equal(w.c.accounts.has(VF.dlmm.ata), false, "W's coin account closed, its rent back to W");
  assert.equal(w.c.accounts.has(solanaAta(W.address, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)), false, "W's wrapped-SOL account closed by the sell itself");
  assert.deepEqual(w.c.burned, [], "nothing to burn");
  // W's one sweep: the largest rung of all W holds, W left 0 or the rest past that rung (rent-exempt)
  const sweeps = w.c.deposits.filter((d) => d.sweep);
  assert.equal(w.c.deposits.length, sweeps.length, json(w.c.deposits));
  assert.ok(sweeps.length >= 1, "W swept");
  const value = sweeps.at(-1)!.value;
  const left = BigInt(w.c.accounts.get(W.address)?.lamports ?? 0);
  assert.ok(isRung({ one: SOL_GRID, min: SOL_NOTE_FLOOR }, value), String(value));
  assert.deepEqual(solanaSweepOf(left + value, solanaSweepStay(rent, 0n)), { value, under: left });
  // nothing else of W's is left anywhere on the chain
  for (const [address, acc] of w.c.accounts) if (acc.data.length >= 64 && (acc.owner === TOKEN_2022 || acc.owner === SOLANA_TOKEN_PROGRAM)) assert.notEqual(base58.encode(acc.data.subarray(32, 64)), W.address, `W's token account ${address} left`);
});

test("a DLMM coin's sale on mainnet from a W with room pays the priority fee inside 1,232 bytes, full and partial", async () => {
  for (const full of [true, false]) {
    const held = full ? DLMM_AMOUNT : 2n * DLMM_AMOUNT;
    const w = await world({ cluster: "mainnet", held, ataLamports: Number(rentMin(182)) }, [wallet(held)]);
    const a = await runPoolSell(w.host, DLMM_ASK);
    assert.equal("stage" in a && a.stage, "filled", json(a));
    const t = w.c.txs.get(sigOf(a))!.tx;
    assert.ok(t.length <= 1232, String(t.length));
    const m = solanaDecodeMessage(t.subarray(65));
    assert.ok(m.instructions.some((x) => x.data[0] === 3 && x.data.length === 9), `${full}: a compute unit price`);
  }
});

test("the preview prices a DLMM coin's sale: no venue cashback claim, W's wrapped-SOL account its need", async () => {
  const e = (await readSolanaReference(dlmmProviders(), { side: "sell", token: MINT, amount: DLMM_AMOUNT, dlmmPairs: [dlmmVector.pair] }))!.pools.find((p) => p.venue === "dlmm")!;
  assert.equal(e.cashback, undefined, "a DLMM pool reads no cashback flag");
  const floor = solanaSellFloor(e.expectedOut, 1000);
  const sizes = { stateSize: 100, labelSize: 100 };
  const w0 = { lamports: ENOUGH_N, claim: [false, false] as const };
  // the flag unread (the reference gives none for a DLMM pool) prices as no cashback: no claim counted on W
  const unread = poolSellPays(rent, "dlmm", [w0], true, e.expectedOut, floor, e.cashback, sizes);
  const plain = poolSellPays(rent, "dlmm", [w0], true, e.expectedOut, floor, false, sizes);
  assert.deepEqual(unread, plain);
  assert.ok(!("refused" in unread) && unread.out > solanaNoteOf(e.expectedOut), json(unread));
  // mainnet: the form has room for the budget, so the priority is counted
  const main = poolSellPays(rent, "dlmm", [w0], true, e.expectedOut, floor, e.cashback, sizes, true);
  assert.ok(!("refused" in main) && main.priority > 0n, json(main));
  // the sell box's preview of the whole holding: the sale's own quote on the same reads, never refused
  const W1 = "So11111111111111111111111111111111111111112";
  const mint = Object.values(dlmmVector.providers)[0]!.accounts[MINT]!;
  const rpcs = ([0, 1] as const).map((p) => {
    const rec = dlmmReplay(p);
    return (async (method: string, params: readonly unknown[]) => {
      if (method === "getAccountInfo") return { context: { slot: 1 }, value: params[0] === MINT ? { owner: mint.owner, lamports: 1, executable: false, rentEpoch: 0, data: [mint.data, "base64"] } : null };
      const list = params[0] as string[];
      if (list.includes(W1)) return { context: { slot: 1 }, value: list.map((a) => (a === W1 ? { lamports: Number(ENOUGH_N), owner: "11111111111111111111111111111111", data: ["", "base64"] } : null)) };
      return rec(method, params);
    }) as SolanaRpc;
  }) as unknown as readonly [SolanaRpc, SolanaRpc];
  const d = await poolSellDry({ pinned: () => true, rpcs: () => rpcs, positions: () => [{ chain: "solana", token: MINT, amount: "100000", cost: "0", wallets: [W1], decimals: 6 }], pin: () => ({ program: PROGRAM }), rent: () => rent, decimals: tokenDecimalsKept(), trading: () => false }, { chain: "solana", token: MINT, share_bps: 10_000, slippage_bps: 1000 });
  assert.ok("result" in d, json(d));
  assert.equal(d.result.out, poolUnits(plainNoSizes(e.expectedOut, floor).out, 9));
});

const ENOUGH_N = BigInt(ENOUGH);
/** The preview's pricing of the whole sale with W1's reads as the dry harness gives them: no volume accounts, the pool
 *  account not there (no sizes). */
const plainNoSizes = (e: bigint, floor: bigint) => {
  const p = poolSellPays(rent, "dlmm", [{ lamports: ENOUGH_N, claim: [false, false] }], true, e, floor, undefined, null);
  assert.ok(!("refused" in p));
  return p;
};
