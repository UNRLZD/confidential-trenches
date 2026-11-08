// Replays card evm-buy-gas-floor's live check on its recorded answers (evm-buy-gas-floor.answers.json).
// Good: `good`, a real run (2026-11-08T08:37Z) of the check: every pinned pool reads BUY_SWAP_GAS() 500000 on two
// providers, and the kit's swap read (its evmBuySwapFitCall at each provider's latest block), from the pool at the 476,190 cap, fits on Base's and Robinhood's two providers,
// while at 20,000 it runs out of gas in the words the kit maps; re-recorded 2026-11-08T12:13Z with the kit's public quote
// on both chains (card evm-buy-quote-ends-on-node), each ending within the bound with a named refusal, no quote fitting
// the window. Bad: `bad`, the same run with the read sent from
// 0x...dEaD instead of the pool, as a kit that sent it as any account would: buySwap reverts OnlyPool (0x4b602735) on
// every provider at both caps; its quotes, the kit before that card (quote.ts at 3a73b181), ran past the bound.
//   node --test scripts/live-checks/evm-buy-gas-floor.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./evm-buy-gas-floor.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-buy-gas-floor.answers.json", import.meta.url), "utf8"));

test("the good answer (the kit's read, from the pool) passes: four pools at 500000, the swap fits at the cap and runs out at 20,000", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 4 + 2 * 2 * 2 + 2 * 3);
});

test("the bad answer (the read sent from another account) fails: OnlyPool at both caps on every provider", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD")).length, 8 + 2, r.lines.join("\n"));
  assert.ok(A.bad.swaps.every((s) => s.reads.every((x) => x.cap?.error?.data === "0x4b602735")), "OnlyPool()");
});

test("planted: a pool past 500000, one provider, a swap that answers nothing, an out-of-gas word the kit does not map, no pools", () => {
  const plant = (f) => {
    const a = structuredClone(A.good);
    f(a);
    return judge(a).ok;
  };
  assert.equal(plant((a) => (a.pools[0].reads[1].result = "0x" + (600_000).toString(16).padStart(64, "0"))), false, "a pool whose floor moved");
  assert.equal(plant((a) => (a.pools[1].reads = a.pools[1].reads.slice(0, 1))), false, "one provider for a pool");
  assert.equal(plant((a) => (a.pools = a.pools.slice(0, 1))), false, "one pool");
  assert.equal(plant((a) => (a.swaps[0].reads = a.swaps[0].reads.slice(0, 1))), false, "the swap on one provider");
  assert.equal(plant((a) => (a.swaps[1].reads[0].cap = "0x" + "0".repeat(64))), false, "nothing out");
  assert.equal(plant((a) => (a.swaps[1].reads[0].cap = { error: { code: -32000, message: "out of gas" } })), false, "the cap does not fit");
  assert.equal(plant((a) => (a.swaps[0].reads[1].low = { error: { code: -32000, message: "gas exhausted" } })), false, "words the kit does not map");
  assert.equal(plant((a) => (a.swaps = a.swaps.filter((s) => s.chain !== "robinhood"))), false, "no Robinhood read");
  assert.equal(plant((a) => (a.quotes = a.quotes.filter((q) => q.chain !== "base"))), false, "no Base quote");
  assert.equal(plant((a) => (a.quotes[1].ms = 60_000)), false, "a quote past the bound");
  assert.equal(judge({}).ok, false, "an empty answer");
});
