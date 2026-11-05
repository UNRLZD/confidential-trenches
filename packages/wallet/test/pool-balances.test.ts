// node --test packages/wallet/test/pool-balances.test.ts: the private balance per chain's pool, from the device's own
// notes, and how much of it has a proof ready (card balances-per-chain, src/pool/balances.ts). Planted notes only: no
// seed, no key. Each pool names its asset; its 1.0 is the kit's POOL_ASSET_DECIMALS, never a ladder's `one`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { NoteRecord, NoteState } from "../src/notes/store.ts";
import { SOLANA_JITO_TIP_MIN, SOLANA_POOL_VOLUME_ACCOUNT_SIZE, SOLANA_POOL_WORST_BUY_VENUE, solanaPoolBuyFunds, solanaPoolBuyMaxSpend, solanaPoolBuySellNeed, solanaPoolFee, solanaRentMin, type SolanaPoolRelease, type SolanaRent } from "@blindfill/kit";
import { evmBalancePool, evmTapSpendOf, poolBalances, solanaBalancePool, solanaTapSpendOf, type BalancePool, type BalanceProof } from "../src/pool/balances.ts";
import { EVM_LADDER } from "../src/pool/evm.ts";
import { SOL_LADDER, SOL_TIP_CAP } from "../src/pool/solana.ts";

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
const proof = (pool: BalancePool, x: NoteRecord, chunk: bigint, attempt = x.attempt!, feeCap = 0n): BalanceProof => ({ noteId: x.id, attempt, poolId: pool.id, chunk, binding: { feeCap } });

test("balance: UNSPENT and HELD notes count; PLANNED, INCOMING, RESERVED, SPENT and TAKEN do not", () => {
  const notes = [
    note(SOL.scope, "UNSPENT", 10n * LAMPORTS),
    note(SOL.scope, "HELD", 2_500_000_000n),
    note(SOL.scope, "RESERVED", 5n * LAMPORTS), // a proof already sent: the buy's op shows it
    note(SOL.scope, "SPENT", 100n * LAMPORTS),
    note(SOL.scope, "INCOMING", 0n), // no value until it lands
    note(SOL.scope, "PLANNED", 0n),
    note(SOL.scope, "TAKEN", 0n),
    note(BASE.scope, "UNSPENT", 1n), // another pool's
  ];
  assert.deepEqual(poolBalances(notes, [SOL]), [{ chain: "solana", asset: "SOL", balance: "12.5" }]);
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
    { chain: "solana", asset: "SOL", balance: "42", ready: "20" },
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

test("tap_max: the most one ready proof can spend at the tap, the largest of the pool's spendOf over the chain's counted ready proofs", () => {
  // one tap spends one ready proof: spendOf(chunk, feeCap), from its pool (the kit's one rule, given by the caller)
  const spend = (chunk: bigint, feeCap: bigint): bigint => chunk - feeCap - 1_000n;
  const S1: BalancePool = { ...SOL, spendOf: spend };
  const S2: BalancePool = { id: "sol-pool-2", chain: "solana", scope: 44n, asset: "SOL", spendOf: spend };
  const B: BalancePool = { ...BASE, spendOf: (chunk, feeCap) => chunk - feeCap };
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
    { chain: "solana", asset: "SOL", balance: "130", ready: "32", tap_max: "9.998699" }, // 10 SOL - 1,300,000 - 1,000
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
  assert.throws(() => poolBalances([a], [{ ...SOL, spendOf: (x) => x + 1n }], [proof(SOL, a, LAMPORTS)]), /spend/);
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
  assert.equal(out[1]!.tap_max, "0.001", "an EVM tap asks for the whole chunk");
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
    spend: solanaTapSpendOf(rent)(chunk, fee, SOL_TIP_CAP),
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
  assert.deepEqual(solanaBalancePool("s", 7n), { id: "s", chain: "solana", scope: 7n, asset: "SOL" });
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
