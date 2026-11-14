/// <reference types="node" />
// The private buy on a Meteora DLMM pair (card solana-buy-reaches-raydium-and-meteora): NEARKAT's B8BH6ZKr… as two
// mainnet providers answered it (test/vectors/nearkat-dlmm.json), built into one tag 3 on a DLMM table, checked by the
// device before W signs. Good: the build fits 1,232 bytes with a tip and the next page and passes every check; swap2's
// accounts and flags are its IDL's, then the bin arrays; the sell reverses the swap into W's wrapped SOL and closes it.
// Bad: a message that swaps on another pair, another bin array, for a lower min out or into another account fails the
// check; a pair of another coin, a disabled pair, a coin with a transfer hook and providers that disagree are refused
// at the venue read; a venue read for one side never builds the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import {
  SOLANA_DLMM_EVENT_AUTHORITY,
  SOLANA_DLMM_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  SOLANA_MEMO_PROGRAM,
  SOLANA_POOL_BUY_CU,
  SOLANA_SOL_MINT,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  SolanaPoolBuyError,
  buildSolanaPoolBuy,
  checkSolanaPoolBuy,
  readSolanaDlmmBuyVenue,
  solanaAta,
  solanaPoolBuyFunds,
  solanaPoolBuySteps,
  solanaPoolSellSteps,
  solanaRentMin,
} from "../src/index.ts";
import { cfg, dlmmReplay, dlmmVector, release, rent, setup, W } from "./solana-pool-buy-fx.ts";

const SWAP2 = [65, 75, 63, 76, 235, 91, 91, 136];
// @meteora-ag/dlmm 1.9.14 IDL swap2: each account's [signer, writable], in order (optional ones given as the program)
const IDL = [[0, 1], [0, 0], [0, 1], [0, 1], [0, 1], [0, 1], [0, 0], [0, 0], [0, 1], [0, 0], [1, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];

test("a DLMM buy builds into one tag 3 that fits 1,232 bytes and passes every device check", async () => {
  const { venue, req, chain, reads, E, minOut } = await setup("dlmm");
  assert.equal(venue.kind, "dlmm");
  assert.ok(E > 0n && minOut > 0n);
  const built = buildSolanaPoolBuy(cfg, release, venue, req, chain, { pick: () => 0 });
  assert.ok(built.size <= SOLANA_MAX_TX_BYTES, `${built.size} bytes`);
  assert.equal(built.cuLimit, SOLANA_POOL_BUY_CU.dlmm);
  assert.equal(built.instructions[2]!.data[1]! & 2, 2, "the next state page named (flag bit 1), with the tip");
  const v = checkSolanaPoolBuy(built.wire, cfg, release, venue, req, reads);
  assert.ok(v.ok, JSON.stringify(v.results.filter((r) => !r.ok)));
  assert.match(v.results.find((r) => r.id === "QUOTE")!.detail, new RegExp(`E ${E}`));
  console.log(`DLMM tag 3: ${built.size} bytes, E ${E}, min out ${minOut}`);
});

test("swap2's accounts and flags are its IDL's, W's wSOL in and its coin account out, then the three bin arrays writable", async () => {
  const { venue, req } = await setup("dlmm");
  assert.ok(venue.kind === "dlmm");
  const steps = solanaPoolBuySteps(venue, W, req.spend, req.minOut);
  assert.deepEqual(steps.map((s) => s.program), ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "11111111111111111111111111111111", SOLANA_TOKEN_PROGRAM, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", SOLANA_DLMM_PROGRAM, SOLANA_TOKEN_PROGRAM]);
  const swap = steps[4]!;
  assert.deepEqual(swap.accounts.slice(0, 16).map((a) => [a.signer ? 1 : 0, a.writable ? 1 : 0]), IDL);
  const keys = swap.accounts.map((a) => a.key);
  assert.equal(keys[0], dlmmVector.pair);
  assert.equal(keys[1], SOLANA_DLMM_PROGRAM); // no bitmap extension
  assert.equal(keys[4], solanaAta(W, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM));
  assert.equal(keys[5], solanaAta(W, dlmmVector.mint, SOLANA_TOKEN_2022_PROGRAM));
  assert.equal(keys[9], SOLANA_DLMM_PROGRAM); // no host fee
  assert.equal(keys[10], W);
  // NEARKAT is X on Token-2022, wSOL is Y on SPL Token
  assert.deepEqual([keys[6], keys[7], keys[11], keys[12]], [dlmmVector.mint, SOLANA_SOL_MINT, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM]);
  assert.deepEqual(keys.slice(13, 16), [SOLANA_MEMO_PROGRAM, SOLANA_DLMM_EVENT_AUTHORITY, SOLANA_DLMM_PROGRAM]);
  assert.deepEqual(keys.slice(16), venue.binArrays);
  assert.ok(swap.accounts.slice(16).every((a) => a.writable && !a.signer));
  const data = [...swap.data];
  assert.deepEqual(data.slice(0, 8), SWAP2);
  const dv = new DataView(swap.data.buffer, swap.data.byteOffset);
  assert.equal(dv.getBigUint64(8, true), req.spend);
  assert.equal(dv.getBigUint64(16, true), req.minOut);
  assert.deepEqual(data.slice(24), [0, 0, 0, 0]);
});

test("the check refuses a message that swaps on another bin array, for a lower min out, or with the coin into another account", async () => {
  const { venue, req, chain, reads } = await setup("dlmm");
  assert.ok(venue.kind === "dlmm");
  const fails = (wire: Uint8Array): string[] => checkSolanaPoolBuy(wire, cfg, release, venue, req, reads).results.filter((r) => !r.ok).map((r) => r.id);
  const other = base58.encode(new Uint8Array(32).fill(3));
  const arrays = buildSolanaPoolBuy(cfg, release, { ...venue, binArrays: [venue.binArrays[0]!, other, venue.binArrays[2]!] }, req, chain, { pick: () => 0 });
  assert.ok(fails(arrays.wire).includes("BUY"));
  const low = buildSolanaPoolBuy(cfg, release, venue, { ...req, minOut: req.minOut / 2n }, chain, { pick: () => 0 });
  assert.ok(fails(low.wire).includes("BUY"));
  // the check's own request with a min out under E less the slippage: QUOTE
  assert.ok(checkSolanaPoolBuy(low.wire, cfg, release, venue, { ...req, minOut: req.minOut / 2n }, reads).results.some((r) => r.id === "QUOTE" && !r.ok));
  const reserve = buildSolanaPoolBuy(cfg, release, { ...venue, reserveX: other }, req, chain, { pick: () => 0 });
  assert.ok(fails(reserve.wire).includes("BUY"));
});

test("the DLMM sell swaps the coin into W's wrapped SOL and closes it; a venue read for one side never builds the other", async () => {
  const { venue } = await setup("dlmm");
  assert.ok(venue.kind === "dlmm");
  assert.throws(() => solanaPoolSellSteps(venue, W, 1_000n, 1n), /read for a buy, not a sell/);
  const sellVenue = await readSolanaDlmmBuyVenue([dlmmReplay(0), dlmmReplay(1)], dlmmVector.mint, dlmmVector.pair, "sell");
  assert.ok(sellVenue.kind === "dlmm");
  assert.notDeepEqual(sellVenue.binArrays, venue.binArrays); // the walk goes the other way
  assert.equal(sellVenue.binArrays[0], venue.binArrays[0]); // from the same active bin array
  assert.throws(() => solanaPoolBuySteps(sellVenue, W, 1_000n, 1n), /read for a sell, not a buy/);
  const steps = solanaPoolSellSteps(sellVenue, W, 1_000n, 1n);
  assert.deepEqual(steps.map((s) => s.program), ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", SOLANA_DLMM_PROGRAM, SOLANA_TOKEN_PROGRAM]);
  assert.equal(steps[1]!.accounts[4]!.key, solanaAta(W, dlmmVector.mint, SOLANA_TOKEN_2022_PROGRAM));
  assert.equal(steps[1]!.accounts[5]!.key, solanaAta(W, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM));
  assert.deepEqual([...steps[2]!.data], [9]);
});

test("W's funds on a DLMM buy: the spend, its coin account, the wrapped SOL at the peak, no volume account, its sell's wrapped SOL kept", async () => {
  const { venue } = await setup("dlmm");
  const f = solanaPoolBuyFunds(release, venue, { spend: 1_000_000n, tip: 10_000n }, rent);
  const ata = solanaRentMin(rent, venue.tokenAccountSize);
  const wsol = solanaRentMin(rent, 165);
  assert.equal(f.peak - 1_000_000n, ata + wsol);
  assert.equal(f.chunk - f.left, 1_000_000n + ata);
  assert.equal(f.problem, null);
});

test("the venue read refuses a pair of another coin, a disabled pair, a coin with a transfer hook, and providers that disagree", async () => {
  const pair = dlmmVector.pair;
  const other = (a: string, d: Uint8Array) => (a === pair ? Object.assign(d.slice(), Object.fromEntries(Array.from({ length: 32 }, (_, i) => [88 + i, 7]))) : d);
  await assert.rejects(readSolanaDlmmBuyVenue([dlmmReplay(0, other), dlmmReplay(1, other)], dlmmVector.mint, pair, "buy"), (e: unknown) => e instanceof SolanaPoolBuyError && e.code === "venue_not_built");
  const off = (a: string, d: Uint8Array) => (a === pair ? Object.assign(d.slice(), { [82]: 1 }) : d);
  await assert.rejects(readSolanaDlmmBuyVenue([dlmmReplay(0, off), dlmmReplay(1, off)], dlmmVector.mint, pair, "buy"), /disabled/);
  const hook = (a: string, d: Uint8Array) => (a === dlmmVector.mint ? Object.assign(d.slice(), { [166]: 14 }) : d);
  await assert.rejects(readSolanaDlmmBuyVenue([dlmmReplay(0, hook), dlmmReplay(1, hook)], dlmmVector.mint, pair, "buy"), /extension 14 is not priced/);
  const flip = (a: string, d: Uint8Array) => (a === pair ? Object.assign(d.slice(), { [8]: d[8]! ^ 1 }) : d);
  await assert.rejects(readSolanaDlmmBuyVenue([dlmmReplay(0), dlmmReplay(1, flip)], dlmmVector.mint, pair, "buy"), /disagree on the DLMM pair/);
  const t2022Flag = (a: string, d: Uint8Array) => (a === pair ? Object.assign(d.slice(), { [880]: 0 }) : d);
  await assert.rejects(readSolanaDlmmBuyVenue([dlmmReplay(0, t2022Flag), dlmmReplay(1, t2022Flag)], dlmmVector.mint, pair, "buy"), /token program flag is not the mint's program/);
});
