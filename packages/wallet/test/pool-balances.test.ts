// node --test packages/wallet/test/pool-balances.test.ts: the private balance per chain's pool, from the device's own
// notes, and how much of it has a proof ready (card balances-per-chain, src/pool/balances.ts). Planted notes only: no
// seed, no key. Each pool names its asset; its 1.0 is the kit's POOL_ASSET_DECIMALS, never a ladder's `one`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { NoteRecord, NoteState } from "../src/notes/store.ts";
import { SOLANA_JITO_TIP_MIN, SOLANA_POOL_VOLUME_ACCOUNT_SIZE, SOLANA_POOL_WORST_BUY_VENUE, solanaPoolBuyFunds, solanaPoolBuyMaxSpend, solanaPoolBuySellNeed, solanaPoolFee, solanaRentMin, type SolanaPoolRelease, type SolanaRent } from "@blindfill/kit";
import { evmBalancePool, evmTapSpendOf, poolBalances, solanaBalancePool, solanaTapSpendOf, type BalancePool, type BalanceProof, type TapSpendOf } from "../src/pool/balances.ts";
import { EVM_LADDER } from "../src/pool/evm.ts";
import { SOL_LADDER, SOL_PIECES, SOL_TIP_CAP } from "../src/pool/solana.ts";

const LAMPORTS = 1_000_000_000n; // 1 SOL, 9 decimals
const WEI = 1_000_000_000_000_000_000n; // 1 ETH, 18 decimals
const USDC = 1_000_000n; // 6 decimals
const SOL: BalancePool = { id: "sol-pool", chain: "solana", scope: 11n, asset: "SOL" };
const BASE: BalancePool = { id: "base-pool", chain: "base", scope: 22n, asset: "ETH" };
const NEAR: BalancePool = { id: "near-usdc", chain: "near", scope: 33n, asset: "USDC" };

let n = 0;
/** A note of `scope` in `state`; landed states carry a leaf of `value` base units, HELD and RESERVED an attempt. */
function note(scope: bigint, state: NoteState, value: bigint, attempt?: string): NoteRecord {
  const id = `n${n++}`;
  const landed = state === "UNSPENT" || state === "HELD" || state === "RESERVED" || state === "SPENT";
  return {
    id,
    ref: { kind: "deposit", s: scope, i: n },
    scope,
    precommitment: BigInt(n),
    state,
    ...(landed ? { leaf: { value, label: BigInt(n), commitment: BigInt(n), leafIndex: BigInt(n) } } : {}),
    ...(state === "HELD" || state === "RESERVED" ? { attempt: attempt ?? `a-${id}`, deadlineMs: 1n } : {}),
  };
}
// each planted proof pays its own note's W (label, jOf of a deposit note: 0), as every pool with no pieces does
const proof = (pool: BalancePool, x: NoteRecord, chunk: bigint, attempt = x.attempt!, feeCap = 0n): BalanceProof => ({ noteId: x.id, attempt, poolId: pool.id, chunk, wallet: { l: x.leaf?.label ?? -1n, j: 0, address: `w-${x.id}` }, binding: { feeCap } });
/** A one-proof spendOf from a rule of its chunk, fee cap and tip cap: every set these tests plant holds one proof. */
const one = (f: (chunk: bigint, feeCap: bigint, tipCap: bigint | undefined) => bigint): TapSpendOf => (ps) => {
  assert.equal(ps.length, 1);
  return f(ps[0]!.chunk, ps[0]!.feeCap, ps[0]!.tipCap);
};

test("balance: UNSPENT, HELD and RESERVED notes count; PLANNED, INCOMING, SPENT and TAKEN do not", () => {
  const notes = [
    note(SOL.scope, "UNSPENT", 10n * LAMPORTS),
    note(SOL.scope, "HELD", 2_500_000_000n),
    note(SOL.scope, "RESERVED", 5n * LAMPORTS), // a proof already sent: still in the pool until the chain spends it
    note(SOL.scope, "SPENT", 100n * LAMPORTS),
    note(SOL.scope, "INCOMING", 0n), // no value until it lands
    note(SOL.scope, "PLANNED", 0n),
    note(SOL.scope, "TAKEN", 0n),
    note(BASE.scope, "UNSPENT", 1n), // another pool's
  ];
  assert.deepEqual(poolBalances(notes, [SOL]), [{ chain: "solana", asset: "SOL", balance: "17.5" }]);
});

test("balance: a buy in flight never reads its money gone; once its release is read landed the RESERVED note counts only its change (card pool-buy-record-never-stays-sent)", () => {
  const only = note(SOL.scope, "RESERVED", 3n * LAMPORTS, "a-buy"); // the user's one note, its buy in flight
  // in flight: the whole note is still in the pool, so the balance is not 0 and nothing is ready
  assert.deepEqual(poolBalances([only], [SOL], []), [{ chain: "solana", asset: "SOL", balance: "3", ready: "0" }]);
  // the release read landed on both RPCs, withdrawing 2 SOL: the note's change, 1 SOL, before the settle writes it
  assert.deepEqual(poolBalances([only], [SOL], [], undefined, new Map([[only.id, { attempt: "a-buy", withdrawn: 2n * LAMPORTS }]])), [{ chain: "solana", asset: "SOL", balance: "1", ready: "0" }]);
  // a landing read for another attempt of the note, or for a note no longer RESERVED, changes nothing
  assert.deepEqual(poolBalances([only], [SOL], [], undefined, new Map([[only.id, { attempt: "a-old", withdrawn: 2n * LAMPORTS }]])), [{ chain: "solana", asset: "SOL", balance: "3", ready: "0" }]);
  const back = { ...only, state: "UNSPENT" as const };
  delete (back as Partial<NoteRecord>).attempt;
  assert.deepEqual(poolBalances([back], [SOL], undefined, undefined, new Map([[only.id, { attempt: "a-buy", withdrawn: 2n * LAMPORTS }]])), [{ chain: "solana", asset: "SOL", balance: "3" }]);
  // the settle wrote the change: the note SPENT and its change UNSPENT, the same balance as just before
  const change = { ...note(SOL.scope, "UNSPENT", 1n * LAMPORTS), parent: only.id };
  assert.deepEqual(poolBalances([{ ...back, state: "SPENT" }, change], [SOL]), [{ chain: "solana", asset: "SOL", balance: "1" }]);
  // a withdrawn value over the note is refused, never a negative balance
  assert.throws(() => poolBalances([only], [SOL], undefined, undefined, new Map([[only.id, { attempt: "a-buy", withdrawn: 4n * LAMPORTS }]])), /withdrew more than it holds/);
});

test("ready: the chunks of ready proofs whose note is still HELD by the same attempt, in that pool", () => {
  const held = note(SOL.scope, "HELD", 25n * LAMPORTS);
  const moved = note(SOL.scope, "HELD", 10n * LAMPORTS, "a-new"); // its attempt changed since the proof was made
  const sent = note(SOL.scope, "RESERVED", 5n * LAMPORTS); // taken: a proof already sent
  const freed = note(SOL.scope, "UNSPENT", 7n * LAMPORTS); // dropped: back to UNSPENT
  const baseHeld = note(BASE.scope, "HELD", WEI / 2n);
  const ready = [
    proof(SOL, held, 20n * LAMPORTS),
    proof(SOL, held, 20n * LAMPORTS), // the same proof twice counts once
    proof(SOL, moved, 10n * LAMPORTS, "a-old"),
    proof(SOL, sent, 5n * LAMPORTS),
    proof(SOL, freed, 5n * LAMPORTS),
    proof(SOL, { ...held, id: "gone" }, 1n * LAMPORTS), // a note no longer in the store
    proof(BASE, baseHeld, WEI / 4n),
    proof(SOL, baseHeld, WEI / 2n), // names the Solana pool, but its note is Base's
  ];
  assert.deepEqual(poolBalances([held, moved, sent, freed, baseHeld], [SOL, BASE], ready), [
    { chain: "solana", asset: "SOL", balance: "47", ready: "20" },
    { chain: "base", asset: "ETH", balance: "0.5", ready: "0.25" },
  ]);
});

test("ready absent: no ready key on any entry, never \"0\" in its place; an empty queue is \"0\"", () => {
  const notes = [note(SOL.scope, "HELD", LAMPORTS)];
  const out = poolBalances(notes, [SOL, BASE]);
  assert.deepEqual(out, [{ chain: "solana", asset: "SOL", balance: "1" }, { chain: "base", asset: "ETH", balance: "0" }]);
  for (const e of out) assert.equal(Object.hasOwn(e, "ready") || Object.hasOwn(e, "tap_max"), false, e.chain);
  assert.deepEqual(poolBalances(notes, [SOL, BASE], []), [
    { chain: "solana", asset: "SOL", balance: "1", ready: "0" },
    { chain: "base", asset: "ETH", balance: "0", ready: "0" },
  ]);
});

test("ready per open queue: a chain none of whose pools has its queue open has no ready key, never \"0\"; an open one with none ready is \"0\"", () => {
  const h = note(SOL.scope, "HELD", LAMPORTS);
  const b = note(BASE.scope, "UNSPENT", WEI);
  const BASE_SPENDS = evmBalancePool("base-pool", "base", BASE.scope, evmTapSpendOf);
  // only Solana's queue is open: Base's entry has neither ready nor tap_max
  assert.deepEqual(poolBalances([h, b], [SOL, BASE_SPENDS], [proof(SOL, h, LAMPORTS)], new Set([SOL.id])), [
    { chain: "solana", asset: "SOL", balance: "1", ready: "1" },
    { chain: "base", asset: "ETH", balance: "1" },
  ]);
  // only Base's queue is open, with nothing ready yet: Base reads "0", Solana nothing
  assert.deepEqual(poolBalances([h, b], [SOL, BASE_SPENDS], [], new Set([BASE.id])), [
    { chain: "solana", asset: "SOL", balance: "1" },
    { chain: "base", asset: "ETH", balance: "1", ready: "0", tap_max: "0" },
  ]);
  // two pools on one chain: the chain reads ready when either one's queue is open
  const BASE2: BalancePool = { id: "base-pool-2", chain: "base", scope: 44n, asset: "ETH" };
  assert.deepEqual(poolBalances([b], [BASE, BASE2], [], new Set([BASE2.id])), [{ chain: "base", asset: "ETH", balance: "1", ready: "0" }]);
  // no queue open at all, with a list given: no ready anywhere
  for (const e of poolBalances([h, b], [SOL, BASE], [], new Set())) assert.equal(Object.hasOwn(e, "ready"), false, e.chain);
});

test("tap_max: the most one ready proof can spend at the tap, the largest of the pool's spendOf over the chain's counted ready proofs", () => {
  // one tap spends one ready proof: spendOf(chunk, feeCap), from its pool (the kit's one rule, given by the caller)
  const spend = (chunk: bigint, feeCap: bigint): bigint => chunk - feeCap - 1_000n;
  const S1: BalancePool = { ...SOL, spendOf: one(spend) };
  const S2: BalancePool = { id: "sol-pool-2", chain: "solana", scope: 44n, asset: "SOL", spendOf: one(spend) };
  const B: BalancePool = { ...BASE, spendOf: one((chunk, feeCap) => chunk - feeCap) };
  const a = note(S1.scope, "HELD", 25n * LAMPORTS);
  const b = note(S1.scope, "HELD", 3n * LAMPORTS);
  const c = note(S2.scope, "HELD", 12n * LAMPORTS);
  const moved = note(S1.scope, "HELD", 90n * LAMPORTS, "a-new"); // its proof is not counted, so neither is its spend
  const sent = note(S1.scope, "RESERVED", 80n * LAMPORTS); // taken already
  const e = note(B.scope, "HELD", WEI);
  const ready = [
    proof(S1, a, 20n * LAMPORTS, undefined, 19n * LAMPORTS), // a big chunk under a big fee: spends less than c's
    proof(S1, b, 2n * LAMPORTS, undefined, 1_300_000n),
    proof(S2, c, 10n * LAMPORTS, undefined, 1_300_000n),
    proof(S1, moved, 90n * LAMPORTS, "a-old"),
    proof(S1, sent, 80n * LAMPORTS),
    proof(S1, { ...a, id: "gone" }, 70n * LAMPORTS), // a note no longer in the store
    proof(B, e, 1_000_000_000_000_001n, undefined, 1n),
    proof(S1, e, 60n * LAMPORTS), // names the Solana pool, but its note is Base's
  ];
  assert.deepEqual(poolBalances([a, b, c, moved, sent, e], [S1, B, S2], ready), [
    { chain: "solana", asset: "SOL", balance: "210", ready: "32", tap_max: "9.998699" }, // 10 SOL - 1,300,000 - 1,000
    { chain: "base", asset: "ETH", balance: "1", ready: "0.001000000000000001", tap_max: "0.001" },
  ]);
  // never below 0: a proof its fee and accounts eat spends 0
  const tiny = note(S1.scope, "HELD", 2_000n);
  assert.deepEqual(poolBalances([tiny], [S1], [proof(S1, tiny, 2_000n, undefined, 1_500n)]), [{ chain: "solana", asset: "SOL", balance: "0.000002", ready: "0.000002", tap_max: "0" }]);
  // next to ready: absent with it; "0" with no proof counted
  assert.deepEqual(poolBalances([a], [S1]), [{ chain: "solana", asset: "SOL", balance: "25" }]);
  assert.deepEqual(poolBalances([a], [S1], []), [{ chain: "solana", asset: "SOL", balance: "25", ready: "0", tap_max: "0" }]);
  // absent on a chain one of whose pools gives no spendOf: the device cannot say what that pool's proofs spend
  assert.deepEqual(poolBalances([a, c], [S1, { ...S2, spendOf: undefined } as BalancePool], [proof(S1, a, 20n * LAMPORTS)]), [{ chain: "solana", asset: "SOL", balance: "37", ready: "20" }]);
  // a spendOf that gives more than the chunk, or no bigint, is refused
  assert.throws(() => poolBalances([a], [{ ...SOL, spendOf: one((x) => x + 1n) }], [proof(SOL, a, LAMPORTS)]), /spend/);
  assert.throws(() => poolBalances([a], [{ ...SOL, spendOf: () => 1 as never }], [proof(SOL, a, LAMPORTS)]), /spend/);
  assert.throws(() => poolBalances([a], [S1], [{ ...proof(S1, a, LAMPORTS), binding: { feeCap: -1n } }]), /fee cap/);
});

test("tap_max from the kit's rules: solanaTapSpendOf (the worst venue, the proof's own tip cap, the read rent) and evmTapSpendOf", () => {
  const rent: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
  const fee = solanaPoolFee(rent);
  assert.equal(fee, 1_300_000n);
  const S = solanaBalancePool("s", 11n, solanaTapSpendOf(rent));
  const B = evmBalancePool("b", "base", 22n, evmTapSpendOf);
  const s = note(11n, "HELD", LAMPORTS / 10n);
  const e = note(22n, "HELD", WEI / 1000n);
  // the proof's release lets the tap tip up to its tip cap (./solana.ts SOL_TIP_CAP, 0.001 SOL), well above the minimum
  assert.ok(SOL_TIP_CAP > SOLANA_JITO_TIP_MIN);
  const sp = { ...proof(S, s, LAMPORTS / 10n, undefined, fee), binding: { feeCap: fee, request: { tipCap: SOL_TIP_CAP } } };
  const out = poolBalances([s, e], [S, B], [sp, proof(B, e, WEI / 1000n, undefined, 10n ** 13n)]);
  const tapMax = BigInt(out[0]!.tap_max!.replace("0.", "").padEnd(9, "0"));
  assert.equal(tapMax, solanaPoolBuyMaxSpend({ withdrawnValue: LAMPORTS / 10n, relayFee: fee }, SOLANA_POOL_WORST_BUY_VENUE, SOL_TIP_CAP, rent));
  // a tap of tap_max fills on the worst venue at any tip the proof allows, its cap included; one lamport more does not
  const funds = (spend: bigint, tip: bigint) => solanaPoolBuyFunds({ withdrawnValue: LAMPORTS / 10n, relayFee: fee } as SolanaPoolRelease, SOLANA_POOL_WORST_BUY_VENUE as never, { spend, tip }, rent).problem;
  for (const tip of [0n, SOLANA_JITO_TIP_MIN, SOL_TIP_CAP]) assert.equal(funds(tapMax, tip), null, `tip ${tip}`);
  assert.notEqual(funds(tapMax + 1n, SOL_TIP_CAP), null);
  // priced at the minimum tip instead (91,383,880 here: 0.1 SOL less the relay fee, the tip, W's token account (195) and
  // pump's volume account (137), then its sell's up-front need once the coin graduates to PumpSwap: the fee, the
  // wrapped-SOL account (165) and, on a cashback coin, W's PumpSwap volume account (137) and its wrapped-SOL account
  // (165); the re-review of signpage-pool-sell 3bdca74), a tap at a higher tip would not fill
  const atMin = solanaPoolBuyMaxSpend({ withdrawnValue: LAMPORTS / 10n, relayFee: fee }, SOLANA_POOL_WORST_BUY_VENUE, SOLANA_JITO_TIP_MIN, rent);
  assert.equal(atMin, 91_383_880n);
  assert.notEqual(funds(atMin, SOL_TIP_CAP), null);
  assert.equal(out[1]!.tap_max, "0.00099", "an EVM tap spends the chunk less its relay fee (card buy-any-amount-on-every-chain)");
  // a Solana proof whose request names no tip cap, or a bad one, is refused
  assert.throws(() => poolBalances([s], [S], [proof(S, s, LAMPORTS / 10n, undefined, fee)]), /tip cap/);
  assert.throws(() => poolBalances([s], [S], [{ ...sp, binding: { feeCap: fee, request: { tipCap: -1n } } }]), /tip cap/);
});

test("the ladder's least rung at mainnet rent: every cost of src/pool/balances.ts's table from the kit's rules, summing to the chunk, and tap_max above 0", () => {
  // the Rent sysvar read on two mainnet RPCs on 5 Nov 19:10:24Z (card sol-small-note-buys)
  const rent: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
  const chunk = SOL_LADDER.min;
  assert.equal(chunk, 10_000_000n);
  // the live check (scripts/live-checks/sol-small-note-buys.mjs, kit entry only) writes the rung and the tip cap itself:
  // they are these
  const check = readFileSync(new URL("../../../scripts/live-checks/sol-small-note-buys.mjs", import.meta.url), "utf8");
  const big = (name: string) => BigInt((new RegExp(`^export const ${name} = ([0-9_]+)n;$`, "m").exec(check)?.[1] ?? "-1").replaceAll("_", ""));
  assert.deepEqual([big("SOL_RUNG"), big("SOL_TIP")], [SOL_LADDER.min, SOL_TIP_CAP]);
  const fee = solanaPoolFee(rent);
  const v = SOLANA_POOL_WORST_BUY_VENUE;
  const items = {
    fee,
    tip: SOL_TIP_CAP,
    tokenAccount: solanaRentMin(rent, v.tokenAccountSize),
    volumeAccount: solanaRentMin(rent, SOLANA_POOL_VOLUME_ACCOUNT_SIZE["pump-curve"]),
    sellReserve: solanaPoolBuySellNeed(v, rent),
    spend: solanaTapSpendOf(rent)([{ chunk, feeCap: fee, tipCap: SOL_TIP_CAP }]),
  };
  assert.deepEqual(items, { fee: 1_300_000n, tip: 1_000_000n, tokenAccount: 1_640_840n, volumeAccount: 1_346_200n, sellReserve: 4_328_080n, spend: 384_880n });
  assert.equal(Object.values(items).reduce((a, b) => a + b, 0n), chunk, "nothing of the chunk is left out of the table");
  const s = note(11n, "HELD", chunk);
  const S = solanaBalancePool("s", 11n, solanaTapSpendOf(rent));
  const sp = { ...proof(S, s, chunk, undefined, fee), binding: { feeCap: fee, request: { tipCap: SOL_TIP_CAP } } };
  assert.deepEqual(poolBalances([s], [S], [sp]), [{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00038488" }]);
  // that spend fills on the worst venue at every tip the proof allows
  const funds = (spend: bigint, tip: bigint) => solanaPoolBuyFunds({ withdrawnValue: chunk, relayFee: fee } as SolanaPoolRelease, v as never, { spend, tip }, rent).problem;
  for (const tip of [SOLANA_JITO_TIP_MIN, SOL_TIP_CAP]) assert.equal(funds(items.spend, tip), null, `tip ${tip}`);
  assert.notEqual(funds(items.spend + 1n, SOL_TIP_CAP), null);
});

test("the coin's own venue (card max-is-priced-for-the-coin): the least rung's tap spend on each venue and mint kind, each the most that venue's funds rule passes", () => {
  const rent: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
  const chunk = SOL_LADDER.min;
  const fee = solanaPoolFee(rent);
  const cases = [
    // a Token mint's coin with no cashback: the same on the curve and on PumpSwap
    [{ kind: "pump-curve", tokenAccountSize: 165, cashback: false }, 3_371_920n],
    [{ kind: "pumpswap", tokenAccountSize: 165, cashback: false }, 3_371_920n],
    // Token-2022 at its largest
    [{ kind: "pump-curve", tokenAccountSize: 195, cashback: false }, 3_219_520n],
    [{ kind: "pumpswap", tokenAccountSize: 195, cashback: false }, 3_219_520n],
    // cashback
    [{ kind: "pumpswap", tokenAccountSize: 165, cashback: true }, 1_883_480n],
    [{ kind: "pump-curve", tokenAccountSize: 165, cashback: true }, 537_280n],
    [SOLANA_POOL_WORST_BUY_VENUE, 384_880n],
  ] as const;
  for (const [venue, spend] of cases) {
    const at = JSON.stringify(venue);
    assert.equal(solanaTapSpendOf(rent, venue)([{ chunk: chunk, feeCap: fee, tipCap: SOL_TIP_CAP }]), spend, at);
    const funds = (s: bigint) => solanaPoolBuyFunds({ withdrawnValue: chunk, relayFee: fee } as SolanaPoolRelease, venue as never, { spend: s, tip: SOL_TIP_CAP }, rent).problem;
    assert.equal(funds(spend), null, at);
    assert.notEqual(funds(spend + 1n), null, at);
  }
  // with no venue: the costliest, as before
  assert.equal(solanaTapSpendOf(rent)([{ chunk: chunk, feeCap: fee, tipCap: SOL_TIP_CAP }]), 384_880n);
  const s = note(11n, "HELD", chunk);
  const S = solanaBalancePool("s", 11n, solanaTapSpendOf(rent, { kind: "pump-curve", tokenAccountSize: 165, cashback: false }));
  const sp = { ...proof(S, s, chunk, undefined, fee), binding: { feeCap: fee, request: { tipCap: SOL_TIP_CAP } } };
  assert.deepEqual(poolBalances([s], [S], [sp]), [{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00337192" }]);
});

test("one entry per chain in the order of the pool table: a configured chain with no notes is \"0\", two pools of one asset on one chain sum", () => {
  const SOL2: BalancePool = { id: "sol-pool-2", chain: "solana", scope: 44n, asset: "SOL" };
  const a = note(SOL.scope, "UNSPENT", 3n * LAMPORTS);
  const b = note(SOL2.scope, "HELD", 1_250_000_001n);
  const out = poolBalances([a, b], [NEAR, SOL, BASE, SOL2], [proof(SOL2, b, LAMPORTS)]);
  assert.deepEqual(out, [
    { chain: "near", asset: "USDC", balance: "0", ready: "0" },
    { chain: "solana", asset: "SOL", balance: "4.250000001", ready: "1" },
    { chain: "base", asset: "ETH", balance: "0", ready: "0" },
  ]);
  assert.deepEqual(poolBalances([], []), []);
});

test("the asset's real 1.0 from the kit table: 12.5 SOL and 0.25 ETH in notes read as 12.5 and 0.25", () => {
  const sol = note(SOL.scope, "UNSPENT", 12_500_000_000n); // lamports
  const eth = note(BASE.scope, "UNSPENT", 250_000_000_000_000_000n); // wei
  assert.deepEqual(poolBalances([sol, eth], [SOL, BASE]), [
    { chain: "solana", asset: "SOL", balance: "12.5" },
    { chain: "base", asset: "ETH", balance: "0.25" },
  ]);
});

test("the ladder's one never reaches the sum: one ladder step reads as that step in whole units", () => {
  // SOL_LADDER.one is 0.001 SOL and EVM_LADDER.one 0.0001 ETH: a sum scaled by the ladder would read them as 1
  const sol = note(SOL.scope, "UNSPENT", SOL_LADDER.one);
  const eth = note(BASE.scope, "UNSPENT", EVM_LADDER.one);
  const out = poolBalances([sol, eth], [SOL, BASE]);
  assert.deepEqual(out, [
    { chain: "solana", asset: "SOL", balance: "0.001" },
    { chain: "base", asset: "ETH", balance: "0.0001" },
  ]);
  for (const e of out) assert.notEqual(e.balance, "1", e.chain);
  for (const p of [SOL, BASE]) assert.equal(Object.hasOwn(p, "one"), false, "a pool carries its asset, never a one");
});

test("the table entry from a pool's kind: a Solana pool is SOL on solana, an EVM pool is ETH on base or robinhood", () => {
  // a Solana pool carries a piece's change by the pool's piece rule (card buy-spends-its-change-in-the-same-tap)
  assert.deepEqual(solanaBalancePool("s", 7n), { id: "s", chain: "solana", scope: 7n, asset: "SOL", carry: SOL_PIECES });
  assert.deepEqual(evmBalancePool("b", "base", 8n), { id: "b", chain: "base", scope: 8n, asset: "ETH" });
  assert.deepEqual(evmBalancePool("r", "robinhood", 9n), { id: "r", chain: "robinhood", scope: 9n, asset: "ETH" });
  assert.throws(() => evmBalancePool("x", "solana" as never, 1n), /chain/);
  assert.throws(() => evmBalancePool("x", "near" as never, 1n), /chain/);
});

test("amounts: exact decimals of base units / the asset's 1.0, no trailing zeros, \"0\" for zero, bigint only", () => {
  const at = (value: bigint): string => poolBalances([note(9n, "UNSPENT", value)], [{ id: "p", chain: "near", scope: 9n, asset: "USDC" }])[0]!.balance;
  assert.equal(at(0n), "0");
  assert.equal(at(1n), "0.000001");
  assert.equal(at(10n * USDC), "10");
  assert.equal(at(12_340_000n), "12.34");
  const big = (1n << 200n) + 1n; // far past a float's precision
  assert.equal(at(big), `${big / USDC}.${(big % USDC).toString().padStart(6, "0").replace(/0+$/, "")}`);
  assert.equal(at(big), "1606938044258990275541962092341162602522202993782792835.301377");
});

test("refused: an unknown asset, two assets on one chain, a pool table naming one id or scope twice, a bad chain, a counted note with no leaf", () => {
  for (const asset of ["BTC", "sol", "", undefined, "__proto__", "toString"]) assert.throws(() => poolBalances([], [{ ...SOL, asset: asset as never }]), /asset/, String(asset));
  assert.throws(() => poolBalances([], [SOL, { ...NEAR, chain: "solana" }]), /asset/, "SOL and USDC on one chain");
  assert.throws(() => poolBalances([], [{ ...SOL, one: LAMPORTS } as never]), /one/, "a pool that still carries a one");
  assert.throws(() => poolBalances([], [SOL, { ...BASE, id: SOL.id }]), /twice/);
  assert.throws(() => poolBalances([], [SOL, { ...BASE, scope: SOL.scope }]), /twice/);
  assert.throws(() => poolBalances([], [{ ...SOL, chain: "sol" as never }]), /chain/);
  const broken = { ...note(SOL.scope, "UNSPENT", 1n), leaf: undefined };
  assert.throws(() => poolBalances([broken], [SOL]), /leaf/);
});

// Card buy-spends-several-pieces: the owner's account read 12 Nov 12:22Z holds four notes, 9,425,404, 9,966,767,
// 5,487,104 and 5,547,107 lamports (30,426,382), none of 0.01 SOL or more. Their pieces on the ladder from 0.005 SOL are
// 5,000,000 each; with every proof bound to the owner note's W, tap_max is the four as one set: 20,000,000 less four relay
// fees, less the tip cap and the venue's per-buy costs once. A set whose owner note is gone counts nothing.
test("tap_max over pieces: the owner's four notes, each a 5,000,000 piece bound to one W, read as one set", () => {
  const rent: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
  const fee = solanaPoolFee(rent);
  const values = [9_425_404n, 9_966_767n, 5_487_104n, 5_547_107n];
  const notes = values.map((v) => note(11n, "HELD", v));
  const owner = notes[3]!; // the smallest chunk, the later leaf on the tie
  const bound = (x: NoteRecord, to: NoteRecord, address = "W-owner"): BalanceProof => ({
    ...proof(solanaBalancePool("s", 11n), x, 5_000_000n, undefined, fee),
    wallet: { l: to.leaf!.label, j: 0, address },
    binding: { feeCap: fee, request: { tipCap: SOL_TIP_CAP } },
  });
  const ready = notes.map((x) => bound(x, owner));
  const read = (venue?: Parameters<typeof solanaTapSpendOf>[1], r = ready) => poolBalances(notes, [solanaBalancePool("s", 11n, solanaTapSpendOf(rent, venue))], r)[0]!;
  // a Token coin with no cashback: 20,000,000 - 5,200,000 - 1,000,000 - (1,488,440 + 1,346,200 + 5,000 + 1,488,440)
  assert.deepEqual(read({ kind: "pump-curve", tokenAccountSize: 165, cashback: false }), { chain: "solana", asset: "SOL", balance: "0.030426382", ready: "0.02", tap_max: "0.00947192" });
  // the owner's coin of 12:19:52Z, a Token-2022 account of 170 bytes (rent 1,513,840)
  assert.equal(read({ kind: "pump-curve", tokenAccountSize: 170, cashback: false }).tap_max, "0.00944652");
  // before the coin is known: the worst venue
  assert.equal(read().tap_max, "0.00648488");
  // the same proofs with no owner note among them (its note taken): nothing
  assert.equal(read(undefined, ready.slice(0, 3)).tap_max, "0");
  // each bound to its own W, as before pieces: one piece of 5,000,000 buys nothing at any venue
  const own = notes.map((x) => bound(x, x, `W-${x.id}`));
  assert.equal(read({ kind: "pump-curve", tokenAccountSize: 165, cashback: false }, own).tap_max, "0");
});

test("making (card buy-spends-several-pieces): the value of the HELD notes whose first proof is being made, none ready; given beside ready only", () => {
  const held = note(11n, "HELD", 2_000_000_000n, "a1");
  const done = note(11n, "HELD", 3_000_000_000n, "a2");
  const idle = note(11n, "UNSPENT", 5_000_000_000n);
  const notes = [held, done, idle];
  const ready = [proof(SOL, done, 3_000_000_000n)];
  // the queue makes held's proof; done's is ready; idle has no proof being made (too small, or held out by a withdraw)
  const [e] = poolBalances(notes, [SOL], ready, undefined, undefined, new Set([held.id, done.id, idle.id]));
  assert.equal(e!.making, "2");
  assert.equal(e!.ready, "3");
  // nothing being made: "0", so an app tells no "making a proof" for a balance with no ready proof
  assert.equal(poolBalances(notes, [SOL], [], undefined, undefined, new Set())[0]!.making, "0");
  // no making set given, or no queue open: no key
  assert.equal("making" in poolBalances(notes, [SOL], ready)[0]!, false);
  assert.equal("making" in poolBalances(notes, [SOL], undefined, undefined, undefined, new Set([held.id]))[0]!, false);
});

test("tiers (card buy-spends-several-pieces): tap_max is the most of the largest single piece and the primary with its ready tier 2 pieces; a note held twice is ready once; making only above ready; ready right after a buy", () => {
  const L = LAMPORTS;
  const S: BalancePool = { ...SOL, spendOf: (ps) => ps.reduce((a, p) => a + p.chunk - p.feeCap, 0n) - 1_000n };
  // a note held by its tier 1 proof (its attempt) and its tier 2 proof (its second attempt, notes/store.ts)
  const twice = (x: NoteRecord, a2: string): NoteRecord => ({ ...x, second: { attempt: a2, deadlineMs: 2n, context: "2" } });
  const P = note(S.scope, "HELD", 20n * L);
  const X = twice(note(S.scope, "HELD", 10n * L), "x2");
  const Y = twice(note(S.scope, "HELD", 5n * L), "y2");
  const own = (x: NoteRecord, chunk: bigint, feeCap = 0n): BalanceProof => proof(S, x, chunk, x.attempt!, feeCap);
  // a proof of x paying by's own W
  const to = (x: NoteRecord, by: NoteRecord, attempt: string, chunk: bigint, feeCap = 0n): BalanceProof => ({ ...proof(S, x, chunk, attempt, feeCap), wallet: { l: by.leaf!.label, j: 0, address: `w-${by.id}` } });
  const ready = [own(P, 20n * L), own(X, 10n * L), own(Y, 5n * L), to(X, P, "x2", 10n * L), to(Y, P, "y2", 5n * L)];
  const read = (r: readonly BalanceProof[] = ready, notes: readonly NoteRecord[] = [P, X, Y], making?: ReadonlySet<string>) => poolBalances(notes, [S], r, undefined, undefined, making)[0]!;
  // each note once: 35; Max: the primary and its two pieces, 35 less the 1,000, over the 20 alone
  assert.equal(read().ready, "35");
  assert.equal(read().tap_max, "34.999999");
  // a piece that adds less than nothing (its fee over its chunk): the primary alone is more
  assert.equal(read([own(P, 20n * L), own(X, 10n * L), to(X, P, "x2", L, 3n * L)]).tap_max, "19.999999");
  // making: Q's first proof and R's own proof are being made (R's one ready proof pays a W whose note is gone, so it is
  // not ready); X's piece is being made again, but X is ready already
  const Q = note(S.scope, "HELD", 7n * L);
  const R = note(S.scope, "HELD", 3n * L);
  const gone = { ...P, id: "gone" };
  const m = read([...ready, to(R, gone, R.attempt!, 3n * L)], [P, X, Y, Q, R], new Set([X.id, Q.id, R.id]));
  assert.equal(m.ready, "35", "R's piece to a W whose note is gone is not ready");
  assert.equal(m.making, "10", "Q's and R's values only: making is what is not ready yet");
  // right after a buy took P: X and Y are ready by their own proofs; their pieces to P's W are not, and Max is X's
  const after = read(ready, [{ ...P, state: "RESERVED" }, X, Y]);
  assert.equal(after.ready, "15");
  assert.equal(after.tap_max, "9.999999");
});

test("solanaTapSpendOf at the tap's own tip (card max-is-what-you-hold-after-a-trade): the most the buy funds at that tip, 0 when it is over a piece's tip cap, the cap's bound without one", () => {
  const rent: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
  const fee = solanaPoolFee(rent);
  // the owner's three pieces on one W of 13 Nov 18:23Z
  const pieces = [5_547_107n, 3_502_518n, 5_000_000n].map((chunk) => ({ chunk, feeCap: fee, tipCap: SOL_TIP_CAP }));
  const asks: number[] = [];
  const tipOf = (k: number): bigint => (asks.push(k), 100_000n);
  const at = solanaTapSpendOf(rent, SOLANA_POOL_WORST_BUY_VENUE, tipOf)(pieces);
  assert.deepEqual(asks, [3], "the tip of a set of three pieces");
  assert.equal(at, 2_734_505n);
  const release = pieces.map((p) => ({ withdrawnValue: p.chunk, relayFee: p.feeCap }) as SolanaPoolRelease);
  const funds = (spend: bigint) => solanaPoolBuyFunds(release, SOLANA_POOL_WORST_BUY_VENUE, { spend, tip: 100_000n }, rent).problem;
  assert.equal(funds(at), null);
  assert.notEqual(funds(at + 1n), null);
  // without a tap's tip: the tip cap's bound, 900,000 less
  assert.equal(solanaTapSpendOf(rent)(pieces), at - 900_000n);
  // a tip over a piece's cap: the tag 3 refuses it, so no spend
  assert.equal(solanaTapSpendOf(rent, SOLANA_POOL_WORST_BUY_VENUE, () => SOL_TIP_CAP + 1n)(pieces), 0n);
});

test("card buy-any-amount-on-every-chain: an EVM chain's tap_max is every ready note's spend (its chunk less its relay fee), summed across the notes' Ws, as the page's plan spends them all in one tap", () => {
  const B = evmBalancePool("b", "base", 22n, evmTapSpendOf);
  const fee = 6n * 10n ** 13n;
  const two = note(22n, "HELD", (2n * WEI) / 1000n);
  const one1 = note(22n, "HELD", WEI / 1000n);
  // a sell's return note made before the ladder: any size is spent whole
  const odd = note(22n, "HELD", 1_880_000_000_000_000n);
  const out = poolBalances([two, one1, odd], [B], [proof(B, two, (2n * WEI) / 1000n, undefined, fee), proof(B, one1, WEI / 1000n, undefined, fee), proof(B, odd, 1_880_000_000_000_000n, undefined, fee)]);
  assert.deepEqual(out, [{ chain: "base", asset: "ETH", balance: "0.00488", ready: "0.00488", tap_max: "0.0047" }]);
});
