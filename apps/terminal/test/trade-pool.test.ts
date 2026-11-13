// The pool path's proof state (card trade-box-pool; plan v2 A2; since 13 Nov 07:53Z it gates a buy and no screen names
// it): whether the chain's pool has a proof
// ready to buy, one being made, or none, read only from the signing page's `state.pools` (messages.ts: `ready` is the
// chunks with a proof ready, absent while no proof queue runs, never "0" in its place). Planted notes, as the device's
// totals would carry them.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { hasPool, presetsOf, PRESETS, poolBuyAsk, poolView, proofStatus, spendSoon, tradeBal } from "../src/screens/trade/model.ts";
import { WORDS } from "../src/screens/trade/words.ts";

type Pools = SignpageState["pools"];
const sol = (balance: string, ready?: string, making?: string): NonNullable<Pools>[number] => ({ chain: "solana", asset: "SOL", balance, ...(ready === undefined ? {} : { ready }), ...(making === undefined ? {} : { making }) });

test("ready: a planted note with its proof made reads Proof ready", () => {
  assert.equal(proofStatus([sol("0.2", "0.2")], "solana"), "ready");
  assert.equal(proofStatus([sol("1.25", "0.01")], "solana"), "ready");
});

test("making: notes landed, no proof done yet, the device making one now (making above 0) reads Making proof", () => {
  assert.equal(proofStatus([sol("0.2", "0", "0.2")], "solana"), "making");
  assert.equal(proofStatus([sol("0.2", "0.000", "0.01")], "solana"), "making");
});

test("card buy-spends-several-pieces: money with no proof ready and none being made never reads Making proof", () => {
  // the queue makes none: the note too small for any proof, or held by a running withdraw
  assert.equal(proofStatus([sol("0.2", "0", "0")], "solana"), "none");
  // a page that sends no making (kit 1.10): no label, never a guess from ready "0" alone
  assert.equal(proofStatus([sol("0.2", "0")], "solana"), "none");
  assert.equal(proofStatus([sol("0.2", "0", "x")], "solana"), "none");
  // a proof ready wins over one being made
  assert.equal(proofStatus([sol("0.3", "0.1", "0.2")], "solana"), "ready");
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
  assert.equal(proofStatus([base, sol("0.2", "0", "0.2")], "solana"), "making");
  assert.equal(proofStatus([sol("0.2", "0.2")], "base"), "none");
});

test("a total that is not a plain decimal reads none, never a label the data does not hold", () => {
  for (const bad of ["", "abc", "-1", "1e3", "0x10", " 1", "1.", ".5", "Infinity"]) {
    assert.equal(proofStatus([sol("0.2", bad)], "solana"), "none", `ready ${JSON.stringify(bad)}`);
    assert.equal(proofStatus([sol(bad, "0.2")], "solana"), "none", `balance ${JSON.stringify(bad)}`);
  }
});

test("13 Nov 07:53Z: the box names no proof: no word of it says proof, proving, ready or pending", () => {
  assert.equal("proofReady" in WORDS, false);
  assert.equal("proofMaking" in WORDS, false);
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.text, /proo?f|prov(e|ed|ing)|\bready\b|pending/i, k);
});

test("spendSoon: a pool balance a tap cannot spend yet but will, while the device gets it ready", () => {
  // no queue yet (the seconds after a load) and a fresh deposit being made ready: soon, with no Max or a Max of zero
  assert.equal(spendSoon([sol("0.2")], "solana", null), true);
  assert.equal(spendSoon([sol("0.2", "0", "0.2")], "solana", null), true);
  assert.equal(spendSoon([{ ...sol("0.2", "0", "0.2"), tap_max: "0" }], "solana", 0n), true);
  // spendable now: a Max above zero
  assert.equal(spendSoon([{ ...sol("0.2", "0.2"), tap_max: "0.1" }], "solana", 16n), false);
  // nothing on the chain, no pool, another chain's pool
  assert.equal(spendSoon([sol("0")], "solana", null), false);
  assert.equal(spendSoon(undefined, "solana", null), false);
  assert.equal(spendSoon([sol("0.2")], "base", null), false);
  // none coming: too small for any proof or held by a running withdraw (ready sent, making "0" or absent)
  assert.equal(spendSoon([sol("0.2", "0", "0")], "solana", null), false);
  assert.equal(spendSoon([sol("0.2", "0")], "solana", null), false);
  assert.equal(spendSoon([sol("x")], "solana", null), false);
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
