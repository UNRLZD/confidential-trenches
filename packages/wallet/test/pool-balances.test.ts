// node --test packages/wallet/test/pool-balances.test.ts: the private balance per chain's pool, from the device's own
// notes, and how much of it has a proof ready (card balances-per-chain, src/pool/balances.ts). Planted notes only: no
// seed, no key. Each pool names its asset; its 1.0 is the kit's POOL_ASSET_DECIMALS, never a ladder's `one`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteRecord, NoteState } from "../src/notes/store.ts";
import { evmBalancePool, poolBalances, solanaBalancePool, type BalancePool, type BalanceProof } from "../src/pool/balances.ts";
import { EVM_LADDER } from "../src/pool/evm.ts";
import { SOL_LADDER } from "../src/pool/solana.ts";

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
const proof = (pool: BalancePool, x: NoteRecord, chunk: bigint, attempt = x.attempt!): BalanceProof => ({ noteId: x.id, attempt, poolId: pool.id, chunk });

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
  for (const e of out) assert.equal(Object.hasOwn(e, "ready"), false, e.chain);
  assert.deepEqual(poolBalances(notes, [SOL, BASE], []), [
    { chain: "solana", asset: "SOL", balance: "1", ready: "0" },
    { chain: "base", asset: "ETH", balance: "0", ready: "0" },
  ]);
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
