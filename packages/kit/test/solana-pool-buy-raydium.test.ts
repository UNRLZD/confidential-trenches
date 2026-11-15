/// <reference types="node" />
// The private buy and sell on a Raydium CPMM or AMM v4 pool (card solana-buy-reaches-raydium-and-meteora): HIGH's
// CqvMZmWD… and CzLSuj…'s 9Tb2ohu5… as two mainnet providers answered them (test/vectors/high-cpmm.json,
// czlsuj-amm-v4.json), built into one tag 3 on the venue's table, checked by the device before W signs. Good: the build
// fits 1,232 bytes with a tip and the next page and passes every check; the swap's accounts and flags are its source's
// (cpmm instructions/swap_base_input.rs, amm processor.rs process_swap_base_in_v2), its data the discriminator or tag,
// the amount and the min out; the kit's own steps with min out E are what the recorded mainnet simulation ran and
// passed, and with E + 1 failed; the sell swaps the coin into W's wrapped SOL and closes it. Bad: a message that swaps
// on another vault, for a lower min out, or into another account fails the check; a pool of another coin, a disabled
// pool, an AMM v4 Token-2022 coin and providers that disagree are refused at the venue read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import {
  SOLANA_AMM_V4_AUTHORITY,
  SOLANA_AMM_V4_PROGRAM,
  SOLANA_CPMM_AUTHORITY,
  SOLANA_CPMM_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  SOLANA_POOL_BUY_CU,
  SOLANA_SOL_MINT,
  SOLANA_TOKEN_PROGRAM,
  SolanaPoolBuyError,
  buildSolanaPoolBuy,
  checkSolanaPoolBuy,
  readSolanaRaydiumBuyVenue,
  readSolanaVenueAt,
  solanaAta,
  solanaPoolBuyFunds,
  solanaPoolBuySteps,
  solanaPoolSellSteps,
  solanaPoolVenueAddress,
  solanaRentMin,
} from "../src/index.ts";
import { cfg, raydiumProviders, raydiumVectors, release, rent, setup, W } from "./solana-pool-buy-fx.ts";

const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
// each source's account list as [signer, writable]
const FLAGS = {
  "raydium-cpmm": [[1, 0], [0, 0], [0, 0], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 1]],
  "raydium-amm-v4": [[0, 0], [0, 1], [0, 0], [0, 1], [0, 1], [0, 1], [0, 1], [1, 0]],
} as const;
const KINDS = ["raydium-cpmm", "raydium-amm-v4"] as const;
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);

for (const kind of KINDS) {
  const vec = raydiumVectors[kind];
  const program = kind === "raydium-cpmm" ? SOLANA_CPMM_PROGRAM : SOLANA_AMM_V4_PROGRAM;
  const dataLen = kind === "raydium-cpmm" ? 24 : 17;
  const minAt = dataLen - 8;

  test(`${kind}: the buy builds into one tag 3 that fits 1,232 bytes and passes every device check`, async () => {
    const { venue, req, chain, reads, E, minOut } = await setup(kind);
    assert.equal(venue.kind, kind);
    assert.equal(solanaPoolVenueAddress(venue), vec.pool);
    assert.ok(E > 0n && minOut > 0n);
    const built = buildSolanaPoolBuy(cfg, release, venue, req, chain, { pick: () => 0 });
    assert.ok(built.size <= SOLANA_MAX_TX_BYTES, `${built.size} bytes`);
    assert.equal(built.cuLimit, SOLANA_POOL_BUY_CU[kind]);
    assert.equal(built.instructions[2]!.data[1]! & 2, 2, "the next state page named (flag bit 1), with the tip");
    const v = checkSolanaPoolBuy(built.wire, cfg, release, venue, req, reads);
    assert.ok(v.ok, JSON.stringify(v.results.filter((r) => !r.ok)));
    assert.match(v.results.find((r) => r.id === "QUOTE")!.detail, new RegExp(`E ${E}`));
    console.log(`${kind} tag 3: ${built.size} bytes, E ${E}, min out ${minOut}`);
  });

  test(`${kind}: the swap's accounts and flags are its source's, W's wSOL in and its coin account out, data with the amount and min out`, async () => {
    const { venue, req } = await setup(kind);
    const steps = solanaPoolBuySteps(venue, W, req.spend, req.minOut);
    assert.deepEqual(steps.map((s) => s.program), [ATA, SYSTEM, SOLANA_TOKEN_PROGRAM, ATA, program, SOLANA_TOKEN_PROGRAM]);
    const swap = steps[4]!;
    assert.deepEqual(swap.accounts.map((a) => [a.signer ? 1 : 0, a.writable ? 1 : 0]), FLAGS[kind]);
    const keys = swap.accounts.map((a) => a.key);
    const wsol = solanaAta(W, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
    const coin = solanaAta(W, vec.mint, SOLANA_TOKEN_PROGRAM);
    if (venue.kind === "raydium-cpmm") {
      // payer, authority, amm_config, pool, input/output accounts, input/output vaults, programs, mints, observation
      assert.deepEqual(keys, [W, SOLANA_CPMM_AUTHORITY, venue.ammConfig, vec.pool, wsol, coin, venue.solVault, venue.coinVault, SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_PROGRAM, SOLANA_SOL_MINT, vec.mint, venue.observation]);
      assert.deepEqual([...swap.data.subarray(0, 8)], [143, 190, 90, 218, 196, 30, 51, 222]);
    } else if (venue.kind === "raydium-amm-v4") {
      assert.deepEqual(keys, [SOLANA_TOKEN_PROGRAM, vec.pool, SOLANA_AMM_V4_AUTHORITY, venue.coinVault, venue.pcVault, wsol, coin, W]);
      assert.equal(swap.data[0], 16);
    } else assert.fail(venue.kind);
    assert.equal(swap.data.length, dataLen);
    assert.equal(u64(swap.data, dataLen - 16), req.spend);
    assert.equal(u64(swap.data, minAt), req.minOut);
  });

  test(`${kind}: the kit's steps with min out E are what mainnet's simulation passed, and with E + 1 failed`, async () => {
    const venue = await readSolanaRaydiumBuyVenue(raydiumProviders(kind), kind, vec.mint, vec.pool);
    for (const [name, o] of Object.entries(vec.programOut)) {
      const [side, amount] = name.split(" ") as ["buy" | "sell", string];
      const steps = (m: bigint) => (side === "buy" ? solanaPoolBuySteps(venue, W, BigInt(amount), m) : solanaPoolSellSteps(venue, W, BigInt(amount), m));
      const swap = (m: bigint) => steps(m).find((s) => s.program === program)!;
      assert.equal(u64(swap(BigInt(o.E)).data, minAt), BigInt(o.E), name);
      assert.equal(o.atE.err, null, name);
      assert.equal(o.atE.program.received, o.E, name);
      assert.notEqual(o.atE1.err, null, name);
      console.log(`${kind} ${name}: min out E ${o.E} passed (${o.atE.units} CU), E + 1 ${JSON.stringify(o.atE1.err)}`);
    }
  });

  test(`${kind}: the check refuses a message that swaps on another vault, for a lower min out, or with the coin into another account`, async () => {
    const { venue, req, chain, reads } = await setup(kind);
    const fails = (wire: Uint8Array): string[] => checkSolanaPoolBuy(wire, cfg, release, venue, req, reads).results.filter((r) => !r.ok).map((r) => r.id);
    const other = base58.encode(new Uint8Array(32).fill(3));
    const vault = buildSolanaPoolBuy(cfg, release, ({ ...venue, coinVault: other }) as typeof venue, req, chain, { pick: () => 0 });
    assert.ok(fails(vault.wire).includes("BUY"));
    const low = buildSolanaPoolBuy(cfg, release, venue, { ...req, minOut: req.minOut / 2n }, chain, { pick: () => 0 });
    assert.ok(fails(low.wire).includes("BUY"));
    assert.ok(checkSolanaPoolBuy(low.wire, cfg, release, venue, { ...req, minOut: req.minOut / 2n }, reads).results.some((r) => r.id === "QUOTE" && !r.ok));
    const pool = buildSolanaPoolBuy(cfg, release, ({ ...venue, pool: other }) as typeof venue, req, chain, { pick: () => 0 });
    assert.ok(fails(pool.wire).includes("BUY"));
  });

  test(`${kind}: the sell swaps the coin into W's wrapped SOL and closes it`, async () => {
    const venue = await readSolanaVenueAt(raydiumProviders(kind), kind, vec.mint, vec.pool, "sell");
    assert.equal(venue.kind, kind);
    const steps = solanaPoolSellSteps(venue, W, 1_000n, 1n);
    assert.deepEqual(steps.map((s) => s.program), [ATA, program, SOLANA_TOKEN_PROGRAM]);
    const keys = steps[1]!.accounts.map((a) => a.key);
    const [src, dst] = kind === "raydium-cpmm" ? [keys[4], keys[5]] : [keys[5], keys[6]];
    assert.equal(src, solanaAta(W, vec.mint, SOLANA_TOKEN_PROGRAM));
    assert.equal(dst, solanaAta(W, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM));
    if (venue.kind === "raydium-cpmm") assert.deepEqual([keys[6], keys[7], keys[10], keys[11]], [venue.coinVault, venue.solVault, vec.mint, SOLANA_SOL_MINT]);
    assert.deepEqual([...steps[2]!.data], [9]);
  });

  test(`${kind}: W's funds on a buy: the spend, its coin account, the wrapped SOL at the peak, no volume account`, async () => {
    const { venue } = await setup(kind);
    const f = solanaPoolBuyFunds(release, venue, { spend: 1_000_000n, tip: 10_000n }, rent);
    const ata = solanaRentMin(rent, venue.tokenAccountSize);
    const wsol = solanaRentMin(rent, 165);
    assert.equal(f.peak - 1_000_000n, ata + wsol);
    assert.equal(f.chunk - f.left, 1_000_000n + ata);
    assert.equal(f.problem, null);
  });

  test(`${kind}: the venue read refuses another coin's pool, a pool that does not swap, and providers that disagree`, async () => {
    const pool = vec.pool;
    // another coin: both mints overwritten (CPMM token_0/1_mint 168/200, AMM v4 coin/pc mint 400/432)
    const [m0, m1] = kind === "raydium-cpmm" ? [168, 200] : [400, 432];
    const other = (a: string, d: Uint8Array) => (a === pool ? Object.assign(d.slice(), Object.fromEntries(Array.from({ length: 32 }, (_, i) => [[m0 + i, 7], [m1 + i, 8]]).flat())) : d);
    await assert.rejects(readSolanaRaydiumBuyVenue(raydiumProviders(kind, other), kind, vec.mint, pool), (e: unknown) => e instanceof SolanaPoolBuyError && e.code === "venue_not_built");
    const off = (a: string, d: Uint8Array) => (a === pool ? Object.assign(d.slice(), kind === "raydium-cpmm" ? { [329]: 4 } : { [0]: 2 }) : d);
    await assert.rejects(readSolanaRaydiumBuyVenue(raydiumProviders(kind, off), kind, vec.mint, pool), /does not swap now/);
    const flip = (a: string, d: Uint8Array) => (a === pool ? Object.assign(d.slice(), { [176]: d[176]! ^ 1 }) : d);
    const [pa] = raydiumProviders(kind);
    const [, pb] = raydiumProviders(kind, flip);
    await assert.rejects(readSolanaRaydiumBuyVenue([pa, pb], kind, vec.mint, pool), /disagree on the raydium/);
  });
}
