// Replays card evm-quote-read-gas-starve's live check on its recorded answers (evm-quote-read-gas-starve.answers.json).
// Good: `good`, a real run (2026-11-08T17:0xZ) on every pinned mainnet quote provider (Base 4, Robinhood 5) at its latest
// block: the kit's EVM_READ_GAS_CODE at Multicall3 with EVM_READ_CALL_GAS answers the six planted reads
// [1 7, 2 empty, 1 7, 0 0xaa, 2 0xee, 1 7] and 64 reads with the loop first 2 then 63 of 1. Bad: `bad`, the same run
// through Multicall3's own code, as the kit sent its reads before the card: the loop and the read that caught its
// inner out of gas answer 0, a revert, as the kit priced them.
//   node --test scripts/live-checks/evm-quote-read-gas-starve.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./evm-quote-read-gas-starve.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-quote-read-gas-starve.answers.json", import.meta.url), "utf8"));

test("the good answer (the kit's per-read gas code) passes on every provider of both chains", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  const providers = A.good.chains.reduce((n, c) => n + c.reads.length, 0);
  assert.ok(providers >= 4, `${providers} providers`);
  assert.equal(r.lines.length, 2 + A.good.chains.length + 2 * providers);
});

test("the bad answer (Multicall3's own code) fails: the loop and the caught out of gas answer as reverts on every provider", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const providers = A.bad.chains.reduce((n, c) => n + c.reads.length, 0);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD")).length, 1 + 2 * providers, r.lines.join("\n"));
});

test("planted: one provider on a chain, a chain missing, a read answered 0 where 2 is due, an error for an answer", () => {
  const plant = (f) => {
    const a = structuredClone(A.good);
    f(a);
    return judge(a).ok;
  };
  assert.equal(plant(() => {}), true, "control");
  assert.equal(plant((a) => (a.chains[0].reads = a.chains[0].reads.slice(0, 1))), false, "one provider");
  assert.equal(plant((a) => (a.chains = a.chains.slice(0, 1))), false, "one chain");
  assert.equal(plant((a) => (a.chains[1].reads[0].six = A.bad.chains[1].reads[0].six)), false, "a 2 answered as 0");
  assert.equal(plant((a) => (a.chains[0].reads[1].sixtyFour = { error: { code: -32000, message: "out of gas" } })), false, "an error");
});
