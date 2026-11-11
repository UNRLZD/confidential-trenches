// Card sol-pool-buys-mayhem-coins: a pump.fun Mayhem coin's curve is bought and sold with pump Global's reserved fee
// recipient, read from the Global bytes both providers answered. Replays the recorded mainnet reads of
// 8ZrvYMy1bEc5RRHVmXXHHj9Yg294MLVqWuJRvU7Jpump (the coin the first mainnet buy met, 11 Nov 13:43Z; Token-2022, its
// curve's is_mayhem_mode set) and six real trades on its curve (fixtures/solana-pool-buy-mayhem.json): before this
// card the venue read refused it (venue_not_built); now the buy is built on a table without the reserved recipient
// (the mainnet curve table's own list), the device's check passes it, and a wrong recipient is refused before signing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58, base64 } from "@scure/base";
import {
  buildSolanaPoolBuy,
  checkSolanaPoolBuy,
  readSolanaPoolBuyVenue,
  readSolanaReference,
  solanaDecodeLookupTable,
  solanaPoolBuyTableAccounts,
  solanaPoolPages,
  solanaPoolSellSteps,
  solanaPoolTableVenueOf,
  solanaPoolVenueBuy,
  type SolanaPoolBuyReads,
  type SolanaPoolBuyRequest,
  type SolanaPoolBuyVenue,
  type SolanaRpc,
} from "../src/index.ts";
import { readSolanaReferenceWhy } from "../src/trade/solana/pool.ts";
import { ALT, BLOCKHASH, FEE_PAYER, PROGRAM, W, cfg, release, rent } from "./solana-pool-buy-fx.ts";

const MX = JSON.parse(readFileSync(new URL("./fixtures/solana-pool-buy-mayhem.json", import.meta.url), "utf8"));
const RESERVED = "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS";
const GLOBAL = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";
/** The reserved recipient's wSOL account; pump's global_volume_accumulator. */
const RESERVED_WSOL = "C93K8DX4YsABYJtHX9awzgZW3LWzBqBVezEbbLJH4yet";
const PUMP_GLOBAL_VOLUME = "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y";
const SPEND = 5_000_000n;
/** pump's and PumpSwap's buy discriminator; their sell is 33e685a4017f83ad. */
const BUY = "66063d1201daebea";

/** A provider answering getMultipleAccounts from the recorded mainnet reads; `edit` changes one account's bytes. */
const replay = (p: 0 | 1, edit?: (address: string, data: Uint8Array) => void): SolanaRpc =>
  (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const list = params[0] as string[];
    const ans = MX.reads[p][JSON.stringify(list)];
    assert.ok(ans, `no recorded read of ${JSON.stringify(list)}`);
    const copy = structuredClone(ans);
    if (edit)
      list.forEach((a, i) => {
        if (!copy.value[i]) return;
        const d = base64.decode(copy.value[i].data[0]);
        edit(a, d);
        copy.value[i].data[0] = base64.encode(d);
      });
    return copy;
  }) as SolanaRpc;
const providers = (): readonly [SolanaRpc, SolanaRpc] => [replay(0), replay(1)];
const venueRead = (pair = providers(), pick = 0) => readSolanaPoolBuyVenue(pair, "pump-curve", MX.mint, () => pick);
/** pump Global as provider 0 answered it in the venue's own read. */
const globalAccount = () => {
  const list = Object.keys(MX.reads[0]).map((k) => JSON.parse(k) as string[]).find((l) => l.length === 3 && l[2] === GLOBAL)!;
  const a = MX.reads[0][JSON.stringify(list)].value[2];
  return { owner: a.owner, data: base64.decode(a.data[0]) };
};

/** The buy on a table holding what the mainnet curve table holds (Global's fee recipient, never the reserved one). */
async function setup() {
  const venue = await venueRead();
  const ref = await readSolanaReference(providers(), { side: "buy", token: MX.mint, amount: SPEND });
  assert.ok(ref && ref.slot !== undefined);
  const E = ref.pools.find((p) => p.venue === "pump-curve")!.expectedOut;
  const tv = solanaPoolTableVenueOf("pump-curve", globalAccount());
  const addresses = solanaPoolBuyTableAccounts(cfg, tv as never, solanaPoolPages(PROGRAM, 7, 6));
  const tableAddr = base58.encode(new Uint8Array(32).fill(9));
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true);
  const tableData = Uint8Array.from([...meta, ...addresses.flatMap((k) => [...base58.decode(k)])]);
  const req: SolanaPoolBuyRequest = { wallet: W, feePayer: FEE_PAYER, token: MX.mint, spend: SPEND, minOut: (E * 9_700n) / 10_000n, tip: 10_000n, cuPrice: 100_000n, cluster: "mainnet" };
  const chain = { blockhash: BLOCKHASH, lastValidBlockHeight: 100, table: { address: tableAddr, table: solanaDecodeLookupTable(tableData) }, stateSize: 6, rent };
  const reads: SolanaPoolBuyReads = {
    blockhash: BLOCKHASH, slot: ref.slot + 2, stateSize: 6, rent,
    tables: { [tableAddr]: [{ owner: ALT, data: tableData }, { owner: ALT, data: tableData }] },
    reference: { amount: SPEND, ref, slippageBps: 300 },
  };
  return { venue, req, chain, reads, addresses };
}
const failed = (v: ReturnType<typeof checkSolanaPoolBuy>) => v.results.filter((r) => !r.ok).map((r) => r.id);

test("the recorded Mayhem curve: the venue names Global's reserved fee recipient, and the device's check passes its buy", async () => {
  const { venue, req, chain, reads, addresses } = await setup();
  assert.equal(venue.kind, "pump-curve");
  if (venue.kind !== "pump-curve") return;
  assert.equal(venue.feeRecipient, RESERVED);
  assert.equal(venue.tokenProgram, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  // the mainnet curve table holds Global's fee recipient, not the reserved one: the buy names it as a static key
  assert.ok(!addresses.includes(RESERVED));
  const built = buildSolanaPoolBuy(cfg, release, venue, req, chain, { pick: () => 0 });
  assert.ok(built.wire.length <= 1_232, `${built.wire.length} bytes`);
  const v = checkSolanaPoolBuy(built.wire, cfg, release, venue, req, reads);
  assert.equal(v.ok, true, JSON.stringify(v.results.filter((r) => !r.ok)));
});

test("a wrong fee recipient is refused before signing: a wire naming another one fails the device's check", async () => {
  const { venue, req, chain, reads } = await setup();
  if (venue.kind !== "pump-curve") return assert.fail();
  const global = globalAccount();
  const normal = base58.encode(global.data.subarray(41, 73));
  // Global's fee recipient (what a non-Mayhem curve pays, and what the build named before this card), another of the
  // eight reserved, any key: each built by a server that lies, each refused by the device's own venue
  for (const planted of [normal, base58.encode(global.data.subarray(516, 548)), base58.encode(new Uint8Array(32).fill(3))]) {
    const lied = { ...venue, feeRecipient: planted } as SolanaPoolBuyVenue;
    const wire = buildSolanaPoolBuy(cfg, release, lied, req, chain, { pick: () => 0 }).wire;
    const bad = failed(checkSolanaPoolBuy(wire, cfg, release, venue, req, reads));
    assert.ok(bad.includes("BUY"), `${planted}: ${bad.join(",")}`);
  }
});

test("the reserved recipient is the Global bytes both providers answered: one provider's other key is a disagreement; unset is refused", async () => {
  const other = Uint8Array.from(base58.decode(base58.encode(new Uint8Array(32).fill(4))));
  const bent = (a: string, d: Uint8Array) => void (a === GLOBAL && d.set(other, 483));
  await assert.rejects(venueRead([replay(0), replay(1, bent)]), /disagree/);
  await assert.rejects(venueRead([replay(0, bent), replay(1)]), /disagree/);
  const unset = (a: string, d: Uint8Array) => void (a === GLOBAL && d.fill(0, 483, 515));
  await assert.rejects(venueRead([replay(0, unset), replay(1, unset)]), /no reserved fee recipient/);
  // the same curve with is_mayhem_mode clear pays Global's fee recipient, as before
  const plain = (a: string, d: Uint8Array) => void (a === MX.curve && (d[81] = 0));
  const v = await venueRead([replay(0, plain), replay(1, plain)]);
  assert.equal(v.kind === "pump-curve" && v.feeRecipient, base58.encode(globalAccount().data.subarray(41, 73)));
});

test("the kit's Mayhem curve buy and sell name the accounts of the six real trades on this curve, as both providers read them", async () => {
  const venue = await venueRead();
  if (venue.kind !== "pump-curve") return assert.fail();
  assert.equal(MX.trades.length, 6);
  assert.equal(MX.trades.filter((t: { disc: string }) => t.disc === BUY).length, 3);
  for (const t of MX.trades) {
    assert.equal(t.same_on_both, true, t.signature);
    assert.equal(t.err, null, t.signature);
    assert.equal(t.accounts[1], RESERVED, t.signature);
    // the trade's own user and buyback recipient (one of Global's eight); every other account is the venue's
    const user = t.accounts[6] as string;
    assert.ok(venue.buybackFeeRecipients.includes(t.accounts.at(-1)), t.signature);
    const mine = { ...venue, buybackFeeRecipient: t.accounts.at(-1) } as SolanaPoolBuyVenue;
    const ix = t.disc === BUY ? solanaPoolVenueBuy(mine, user, 1n, 1n) : solanaPoolSellSteps(mine, user, 1n, 1n)[0]!;
    // but one: the bonding-curve-v2 remaining account (pump's sell: "If provided and valid, creator_fee goes to
    // user_volume_accumulator. Otherwise, falls back"; idl/pump.json). The kit names pump's own PDA
    // [b"bonding-curve-v2", mint] (3oK5HhUj...), this trader the same seeds under the Mayhem program (HyMkF1Ns...);
    // neither account exists, and the kit's buy and sell both simulate succeeded on mainnet (scripts/mayhem-simulate.mjs)
    const v2 = ix.accounts.length - 2;
    const kit = ix.accounts.map((a) => a.key);
    assert.equal(kit.length, t.accounts.length, t.signature);
    assert.deepEqual(kit.filter((_, i) => i !== v2), t.accounts.filter((_: string, i: number) => i !== v2), `${t.signature} (${t.disc === BUY ? "buy" : "sell"})`);
    assert.equal(kit[v2], "3oK5HhUjWK7VVjgd6rgEzGfrYqH6BV69JXjvK7nVBSDc");
    assert.equal(t.accounts[v2], "HyMkF1NswAvqRp2mUZeU8ZQrGtVy2uHNTQQaDjkprDgr");
    // and the writable flags the program got are the kit's, but for the buy's global_volume_accumulator (12): read-only
    // in pump's IDL (buy_exact_sol_in, idl/pump.json), as the kit names it; this trader marks it writable
    const off = ix.accounts.map((a, i) => (a.writable === t.writable[i] ? -1 : i)).filter((i) => i >= 0);
    assert.deepEqual(off, t.disc === BUY ? [12] : [], t.signature);
    if (t.disc === BUY) assert.equal(ix.accounts[12]!.key, PUMP_GLOBAL_VOLUME);
  }
});

const POOL = MX.pool;
const poolReplay = (p: 0 | 1, edit?: (address: string, data: Uint8Array) => void): SolanaRpc =>
  (async (_m: string, params: readonly unknown[]) => {
    const list = params[0] as string[];
    const copy = structuredClone(POOL.reads[p][JSON.stringify(list)]);
    assert.ok(copy, `no recorded read of ${JSON.stringify(list)}`);
    if (edit) list.forEach((a, i) => { if (copy.value[i]) { const d = base64.decode(copy.value[i].data[0]); edit(a, d); copy.value[i].data[0] = base64.encode(d); } });
    return copy;
  }) as SolanaRpc;
const AMM_CONFIG = "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw";

test("the recorded Mayhem PumpSwap pool: GlobalConfig's reserved fee recipient and its wSOL account; the kit's buy and sell name the accounts of three real trades on it", async () => {
  const venue = await readSolanaPoolBuyVenue([poolReplay(0), poolReplay(1)], "pumpswap", POOL.mint, () => 0);
  if (venue.kind !== "pumpswap") return assert.fail();
  assert.equal(venue.pool, POOL.pool);
  assert.equal(venue.protocolFeeRecipient, RESERVED);
  assert.equal(solanaPoolVenueBuy(venue, W, 1n, 1n).accounts[10]!.key, RESERVED_WSOL);
  // GlobalConfig's eight reserved recipients as provider 0 read them (385, then 7 at 418)
  const list = Object.keys(POOL.reads[0]).map((k) => JSON.parse(k) as string[]).find((l) => l[2] === AMM_CONFIG)!;
  const g = base64.decode(POOL.reads[0][JSON.stringify(list)].value[2].data[0]);
  const reserved = [385, ...Array.from({ length: 7 }, (_, i) => 418 + 32 * i)].map((o) => base58.encode(g.subarray(o, o + 32)));
  assert.equal(new Set(reserved).size, 8);
  assert.equal(POOL.trades.length, 3);
  for (const t of POOL.trades) {
    assert.equal(t.same_on_both, true, t.signature);
    assert.equal(t.err, null, t.signature);
    // each trade pays one of the eight (the pool's buy names it at 9 and its wSOL account at 10), never a protocol one
    assert.ok(reserved.includes(t.accounts[9]), t.signature);
    const user = t.accounts[1] as string;
    const mine = { ...venue, protocolFeeRecipient: t.accounts[9], buybackFeeRecipient: t.accounts.at(-2) } as SolanaPoolBuyVenue;
    // a buy here is PumpSwap's buy (66063d12...), the kit's buy_exact_quote_in: the same accounts (idl/pump_amm.json)
    const kit = t.disc === BUY ? solanaPoolVenueBuy(mine, user, 1n, 1n) : solanaPoolSellSteps(mine, user, 1n, 1n)[1]!;
    assert.deepEqual(kit.accounts.map((a) => a.key), t.accounts, `${t.signature} (${t.disc === BUY ? "buy" : "sell"})`);
    assert.deepEqual(kit.accounts.map((a) => a.writable), t.writable, t.signature);
  }
  // a pool that is not Mayhem pays protocol_fee_recipients[0] (57), as before this card
  const plain = await readSolanaPoolBuyVenue([poolReplay(0, (a, d) => void (a === POOL.pool && (d[243] = 0))), poolReplay(1, (a, d) => void (a === POOL.pool && (d[243] = 0)))], "pumpswap", POOL.mint, () => 0);
  assert.equal(plain.kind === "pumpswap" && plain.protocolFeeRecipient, base58.encode(g.subarray(57, 89)));
});

// Card sol-pool-buys-mayhem-coins: a curve sale is priced only up to the SOL the curve really holds. The recorded
// curve's real_quote_reserves (bytes 32..40) is 2 lamports: the Mayhem agent's tokens drained it, and the program
// fails a sale past it whole (Overflow 6024, as the mainnet simulation of 15:30Z read). The sell quote now pays
// nothing there, so the reference is the one a coin with no market gets (null: the page answers it quote_check_failed);
// the same sale on the same curve holding 1 SOL is priced as before
test("a sale the recorded Mayhem curve cannot pay from its real SOL has no reference, as a coin with no market", async () => {
  const curveOf = (p: 0 | 1) => {
    const list = Object.keys(MX.reads[p]).map((k) => JSON.parse(k) as string[]).find((l) => l.length === 6 && l[1] === MX.curve)!;
    return new DataView(base64.decode(MX.reads[p][JSON.stringify(list)].value[1].data[0]).buffer);
  };
  for (const p of [0, 1] as const) assert.equal(curveOf(p).getBigUint64(32, true), 2n, "the recorded curve holds 2 lamports of real SOL");
  const sale = { side: "sell" as const, token: MX.mint, amount: 1_000_000_000n, amounts: [400_000_000n, 600_000_000n] };
  assert.equal(await readSolanaReference(providers(), sale), null);
  assert.deepEqual(await readSolanaReferenceWhy(providers(), sale), { refused: "no pool pays out for this amount" });
  // a sale whose gross is within the 2 lamports still pays nothing once its fees are taken
  assert.equal(await readSolanaReference(providers(), { side: "sell", token: MX.mint, amount: 400_000n }), null);
  // the same curve holding 1 SOL of real SOL: the same sale is priced, gross less its fees, each leg too
  const funded = (p: 0 | 1) => replay(p, (a, d) => { if (a === MX.curve) new DataView(d.buffer, d.byteOffset).setBigUint64(32, 1_000_000_000n, true); });
  const ref = await readSolanaReference([funded(0), funded(1)], sale);
  assert.ok(ref && ref.expectedOut > 0n && ref.expectedOuts.length === 2 && ref.expectedOuts.every((x) => x > 0n));
  assert.equal(ref.pools[0]!.venue, "pump-curve");
  // the boundary (the review of 6eb64bdb): a curve holding exactly the sale's gross quotes it, one lamport less is null.
  // That equality pays is what the code does today, and what pump-public-docs says of a sell (PUMP_PROGRAM_README:
  // real_sol_reserves "decrease with the same lamports amount", 0 left): pump's program source is not public, so the
  // exact on-chain comparison (its lib.rs:1037 Overflow) is not read here
  const v = curveOf(0);
  const gross = (sale.amount * v.getBigUint64(16, true)) / (v.getBigUint64(8, true) + sale.amount);
  const holding = (sol: bigint) => (p: 0 | 1) => replay(p, (a, d) => { if (a === MX.curve) new DataView(d.buffer, d.byteOffset).setBigUint64(32, sol, true); });
  const one = { side: "sell" as const, token: MX.mint, amount: sale.amount };
  const at = await readSolanaReference([holding(gross)(0), holding(gross)(1)], one);
  assert.ok(at && at.expectedOut > 0n && at.expectedOut < gross, `at its gross (${gross}) the sale is quoted`);
  assert.equal(await readSolanaReference([holding(gross - 1n)(0), holding(gross - 1n)(1)], one), null);
});
