// The trade box's proof label on the pool path (card trade-box-pool; plan v2 A2): whether the chain's pool has a proof
// ready to buy, one being made, or none, read only from the signing page's `state.pools` (messages.ts: `ready` is the
// chunks with a proof ready, absent while no proof queue runs, never "0" in its place). Planted notes, as the device's
// totals would carry them.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { hasPool, presetsOf, PRESETS, poolBuyAsk, poolView, proofStatus, tradeBal } from "../src/screens/trade/model.ts";
import { WORDS } from "../src/screens/trade/words.ts";

type Pools = SignpageState["pools"];
const sol = (balance: string, ready?: string): NonNullable<Pools>[number] => ({ chain: "solana", asset: "SOL", balance, ...(ready === undefined ? {} : { ready }) });

test("ready: a planted note with its proof made reads Proof ready", () => {
  assert.equal(proofStatus([sol("0.2", "0.2")], "solana"), "ready");
  assert.equal(proofStatus([sol("1.25", "0.01")], "solana"), "ready");
});

test("making: notes landed, the queue running, no proof done yet reads Making proof", () => {
  assert.equal(proofStatus([sol("0.2", "0")], "solana"), "making");
  assert.equal(proofStatus([sol("0.2", "0.000")], "solana"), "making");
});

test("none: no pools read, no entry for the chain, an empty pool, or no queue running", () => {
  assert.equal(proofStatus(undefined, "solana"), "none");
  assert.equal(proofStatus([], "solana"), "none");
  assert.equal(proofStatus([sol("0")], "solana"), "none");
  assert.equal(proofStatus([sol("0", "0")], "solana"), "none");
  // `ready` absent means no proof queue runs: nothing is being made, so the box never says Making proof
  assert.equal(proofStatus([sol("0.5")], "solana"), "none");
});

test("another chain's ready proof is never this chain's", () => {
  const base = { chain: "base" as const, asset: "ETH" as const, balance: "0.01", ready: "0.01" };
  assert.equal(proofStatus([base], "solana"), "none");
  assert.equal(proofStatus([base, sol("0.2", "0")], "solana"), "making");
  assert.equal(proofStatus([sol("0.2", "0.2")], "base"), "none");
});

test("a total that is not a plain decimal reads none, never a label the data does not hold", () => {
  for (const bad of ["", "abc", "-1", "1e3", "0x10", " 1", "1.", ".5", "Infinity"]) {
    assert.equal(proofStatus([sol("0.2", bad)], "solana"), "none", `ready ${JSON.stringify(bad)}`);
    assert.equal(proofStatus([sol(bad, "0.2")], "solana"), "none", `balance ${JSON.stringify(bad)}`);
  }
});

test("the two labels are terse and kept (owner 8 Nov 07:55Z), no draft mark", () => {
  assert.deepEqual([WORDS.proofReady.text, WORDS.proofReady.draft], ["Proof ready", false]);
  assert.deepEqual([WORDS.proofMaking.text, WORDS.proofMaking.draft], ["Making proof", false]);
});

// A NEAR token has no pool: the vault is NEAR's money (deposit/model.ts DESTS), and the signing page lists it in
// state.pools (a `near` entry, its balance) beside the pools. The trade box takes the pool path only for a chain that
// has a pool, so a NEAR token's box is what a chain with no pool draws: the vault's Cash, no proof label, the four
// presets, no pool buy.
test("NEAR: the vault's entry in state.pools is no pool; the box is the one a chain with no pool draws", () => {
  const near = { chain: "near" as const, asset: "USDC" as const, balance: "7.25", ready: "7.25", tap_max: "7.25" };
  const pools: Pools = [near, sol("0.5", "0.5")];
  assert.equal(hasPool(pools, "near"), false);
  assert.equal(hasPool(undefined, "near"), false);
  assert.equal(hasPool([near], "near"), hasPool(undefined, "base"), "the same as a chain with no pool in the state");
  assert.equal(hasPool(pools, "solana"), true);
  assert.equal(hasPool(pools, "base"), false);
  assert.equal(proofStatus(pools, "near"), "none", "no proof label: the vault has no proof queue");
  assert.equal(poolView(pools, "near", { price: 1n, expo: 0, decimals: 6 }), null);
  assert.deepEqual(presetsOf("near", null), PRESETS);
  assert.deepEqual(poolBuyAsk(pools, "near", "wrap.near", 100n, { price: 1n, expo: 0, decimals: 6 }, 100), { ok: false, why: "no_pool" });
  // Bal is the vault path's Cash, as on any chain with no pool
  assert.deepEqual(tradeBal(hasPool(pools, "near"), null, 725n), { from: "cash", cents: 725n });
});
