// node --test packages/wallet/test/pool-balances.test.ts: the private balance per chain's pool, from the device's own
// notes, and how much of it has a proof ready (card balances-per-chain, src/pool/balances.ts). Planted notes only: no
// seed, no key.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteRecord, NoteState } from "../src/notes/store.ts";
import { poolBalances, type BalancePool, type BalanceProof } from "../src/pool/balances.ts";

const USDC = 1_000_000n; // 6 decimals
const SOL: BalancePool = { id: "sol-usdc", chain: "solana", scope: 11n, one: USDC };
const BASE: BalancePool = { id: "base-usdc", chain: "base", scope: 22n, one: USDC };
const NEAR: BalancePool = { id: "near-usdc", chain: "near", scope: 33n, one: USDC };

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
    note(SOL.scope, "UNSPENT", 10n * USDC),
    note(SOL.scope, "HELD", 2_500_000n),
    note(SOL.scope, "RESERVED", 5n * USDC), // a proof already sent: the buy's op shows it
    note(SOL.scope, "SPENT", 100n * USDC),
    note(SOL.scope, "INCOMING", 0n), // no value until it lands
    note(SOL.scope, "PLANNED", 0n),
    note(SOL.scope, "TAKEN", 0n),
    note(BASE.scope, "UNSPENT", 1n), // another pool's
  ];
  assert.deepEqual(poolBalances(notes, [SOL]), [{ chain: "solana", balance: "12.5" }]);
});

test("ready: the chunks of ready proofs whose note is still HELD by the same attempt, in that pool", () => {
  const held = note(SOL.scope, "HELD", 25n * USDC);
  const moved = note(SOL.scope, "HELD", 10n * USDC, "a-new"); // its attempt changed since the proof was made
  const sent = note(SOL.scope, "RESERVED", 5n * USDC); // taken: a proof already sent
  const freed = note(SOL.scope, "UNSPENT", 7n * USDC); // dropped: back to UNSPENT
  const baseHeld = note(BASE.scope, "HELD", 50n * USDC);
  const ready = [
    proof(SOL, held, 20n * USDC),
    proof(SOL, held, 20n * USDC), // the same proof twice counts once
    proof(SOL, moved, 10n * USDC, "a-old"),
    proof(SOL, sent, 5n * USDC),
    proof(SOL, freed, 5n * USDC),
    proof(SOL, { ...held, id: "gone" }, 1n * USDC), // a note no longer in the store
    proof(BASE, baseHeld, 50n * USDC),
    proof(SOL, baseHeld, 50n * USDC), // names the Solana pool, but its note is Base's
  ];
  assert.deepEqual(poolBalances([held, moved, sent, freed, baseHeld], [SOL, BASE], ready), [
    { chain: "solana", balance: "42", ready: "20" },
    { chain: "base", balance: "50", ready: "50" },
  ]);
});

test("ready absent: no ready key on any entry, never \"0\" in its place; an empty queue is \"0\"", () => {
  const notes = [note(SOL.scope, "HELD", USDC)];
  const out = poolBalances(notes, [SOL, BASE]);
  assert.deepEqual(out, [{ chain: "solana", balance: "1" }, { chain: "base", balance: "0" }]);
  for (const e of out) assert.equal(Object.hasOwn(e, "ready"), false, e.chain);
  assert.deepEqual(poolBalances(notes, [SOL, BASE], []), [
    { chain: "solana", balance: "1", ready: "0" },
    { chain: "base", balance: "0", ready: "0" },
  ]);
});

test("one entry per chain in the order of the pool table: a configured chain with no notes is \"0\", two pools on one chain sum", () => {
  const SOL2: BalancePool = { id: "sol-usdc-2", chain: "solana", scope: 44n, one: USDC };
  const SOL8: BalancePool = { id: "sol-8", chain: "solana", scope: 55n, one: 100_000_000n }; // another asset's decimals
  const a = note(SOL.scope, "UNSPENT", 3n * USDC);
  const b = note(SOL2.scope, "HELD", 1_250_000n);
  const c = note(SOL8.scope, "UNSPENT", 1n); // 0.00000001
  const out = poolBalances([a, b, c], [NEAR, SOL, BASE, SOL2, SOL8], [proof(SOL2, b, USDC)]);
  assert.deepEqual(out, [
    { chain: "near", balance: "0", ready: "0" },
    { chain: "solana", balance: "4.25000001", ready: "1" },
    { chain: "base", balance: "0", ready: "0" },
  ]);
  assert.deepEqual(poolBalances([], []), []);
});

test("amounts: exact decimals of base units / one, no trailing zeros, \"0\" for zero, bigint only", () => {
  const at = (value: bigint, one: bigint): string => poolBalances([note(9n, "UNSPENT", value)], [{ id: "p", chain: "near", scope: 9n, one }])[0]!.balance;
  assert.equal(at(0n, USDC), "0");
  assert.equal(at(1n, USDC), "0.000001");
  assert.equal(at(10n * USDC, USDC), "10");
  assert.equal(at(12_340_000n, USDC), "12.34");
  assert.equal(at(7n, 1n), "7");
  const big = (1n << 200n) + 1n; // far past a float's precision
  assert.equal(at(big, USDC), `${big / USDC}.${(big % USDC).toString().padStart(6, "0").replace(/0+$/, "")}`);
  assert.equal(at(big, USDC), "1606938044258990275541962092341162602522202993782792835.301377");
});

test("refused: a pool whose one is not a power of ten, a pool table naming one id or scope twice, a bad chain, a counted note with no leaf", () => {
  for (const one of [0n, -10n, 3n, 1_000_001n, 20n]) assert.throws(() => poolBalances([], [{ ...SOL, one }]), /one is not a power of ten/, String(one));
  assert.throws(() => poolBalances([], [{ ...SOL, one: 1e6 as unknown as bigint }]), /one is not a power of ten/);
  assert.throws(() => poolBalances([], [SOL, { ...BASE, id: SOL.id }]), /twice/);
  assert.throws(() => poolBalances([], [SOL, { ...BASE, scope: SOL.scope }]), /twice/);
  assert.throws(() => poolBalances([], [{ ...SOL, chain: "sol" as never }]), /chain/);
  const broken = { ...note(SOL.scope, "UNSPENT", 1n), leaf: undefined };
  assert.throws(() => poolBalances([broken], [SOL]), /leaf/);
});
