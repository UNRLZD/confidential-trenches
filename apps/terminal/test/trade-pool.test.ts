// The trade box's proof label on the pool path (card trade-box-pool; plan v2 A2): whether the chain's pool has a proof
// ready to buy, one being made, or none, read only from the signing page's `state.pools` (messages.ts: `ready` is the
// chunks with a proof ready, absent while no proof queue runs, never "0" in its place). Planted notes, as the device's
// totals would carry them.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { proofStatus } from "../src/screens/trade/model.ts";
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
