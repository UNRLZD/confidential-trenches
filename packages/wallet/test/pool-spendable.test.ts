// node --test packages/wallet/test/pool-spendable.test.ts: state.pools' spendable (card taps-wait-inside-the-page,
// src/pool/balances.ts): from the first answer after a load, before any proof queue opens, the most one tap can spend
// once the device's prepared spends stand, read from the proofs kept on the device; at least tap_max; never a kept proof
// whose note moved on. At e1995d679 poolBalances took no kept proofs and gave no spendable: an app's Max read 0 after a
// load until the first pass ended. Planted notes only: no seed, no key.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteRecord, NoteState } from "../src/notes/store.ts";
import { evmBalancePool, evmTapSpendOf, poolBalances, type BalancePool, type BalanceProof } from "../src/pool/balances.ts";

const WEI = 1_000_000_000_000_000_000n;
const BASE: BalancePool = evmBalancePool("base-pool", "base", 22n, evmTapSpendOf);
const NOSPEND: BalancePool = { id: "base-pool", chain: "base", scope: 22n, asset: "ETH" };

let n = 0;
function note(state: NoteState, value: bigint, attempt?: string): NoteRecord {
  const id = `n${n++}`;
  return {
    id,
    ref: { kind: "deposit", s: 22n, i: n },
    scope: 22n,
    precommitment: BigInt(n),
    state,
    leaf: { value, label: BigInt(n), commitment: BigInt(n), leafIndex: BigInt(n) },
    ...(state === "HELD" || state === "RESERVED" ? { attempt: attempt ?? `a-${id}`, deadlineMs: 1n } : {}),
  };
}
const proof = (x: NoteRecord, chunk: bigint, attempt: string, feeCap: bigint): BalanceProof => ({ noteId: x.id, attempt, poolId: BASE.id, chunk, wallet: { l: x.leaf!.label, j: 0, address: `w-${x.id}` }, binding: { feeCap } });

test("after a load, no queue open: spendable is what the kept proofs will buy, tap_max and ready absent as before", () => {
  // a reload freed the dead tab's HELD notes (UNSPENT again); their proofs are kept on the device
  const a = note("UNSPENT", WEI);
  const b = note("UNSPENT", WEI / 2n);
  const kept = [proof(a, WEI, "k-a", 10n ** 15n), proof(b, WEI / 2n, "k-b", 10n ** 15n)];
  const [e] = poolBalances([a, b], [BASE], undefined, undefined, undefined, undefined, kept);
  // an EVM tap spends every note in one tap, each its chunk less its relay fee (evmTapSpendOf)
  assert.deepEqual(e, { chain: "base", asset: "ETH", balance: "1.5", spendable: "1.498" });
  // with no kept list given: as before the card, no spendable
  assert.deepEqual(poolBalances([a, b], [BASE]), [{ chain: "base", asset: "ETH", balance: "1.5" }]);
});

test("a kept proof whose note moved on (RESERVED by a buy, SPENT, or HELD by another attempt) counts nothing", () => {
  const sent = note("RESERVED", WEI, "a-buy");
  const spent = note("SPENT", WEI);
  const other = note("HELD", WEI, "a-live");
  const kept = [proof(sent, WEI, "a-buy", 0n), proof(spent, WEI, "k-s", 0n), proof(other, WEI, "k-old", 0n)];
  const [e] = poolBalances([sent, spent, other], [BASE], [], undefined, undefined, undefined, kept);
  assert.equal(e!.spendable, "0");
});

test("once the queue runs, spendable is at least tap_max, and a live proof of the same attempt as a kept one counts once", () => {
  const a = note("HELD", WEI, "a-1");
  const b = note("UNSPENT", WEI);
  const live = [proof(a, WEI, "a-1", 0n)];
  const kept = [proof(a, WEI, "a-1", 0n), proof(b, WEI, "k-b", 0n)];
  const [e] = poolBalances([a, b], [BASE], live, new Set([BASE.id]), undefined, new Set(), kept);
  assert.equal(e!.tap_max, "1");
  assert.equal(e!.spendable, "2");
  // all of it ready: spendable is tap_max
  const [f] = poolBalances([a], [BASE], live, new Set([BASE.id]), undefined, new Set(), kept);
  assert.equal(f!.spendable, f!.tap_max);
});

test("a chain whose pool gives no spendOf (Solana before its rent is read) has no spendable, never a 0 in its place", () => {
  const a = note("UNSPENT", WEI);
  const [e] = poolBalances([a], [NOSPEND], undefined, undefined, undefined, undefined, [proof(a, WEI, "k", 0n)]);
  assert.equal(Object.hasOwn(e!, "spendable"), false);
});
