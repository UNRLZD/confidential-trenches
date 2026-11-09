// Replays card evm-quote-read-gas-starve's live check on its recorded answers (evm-quote-read-gas-starve.answers.json).
// Good: `good`, a real run (its `at`) on every pinned mainnet quote provider (Base 4, Robinhood 5) at its latest
// block: the kit's EVM_READ_GAS_CODE at Multicall3 with EVM_READ_CALL_GAS answers the six planted reads
// [1 7, 2 empty, 1 7, 0 0xaa, 2 0xee, 1 7], 64 reads with the loop first 2 then 63 of 1, six reads, the first a revert
// after 14M gas, [0 0xbb, then five of 1 7], and the loop then five reads of 1.5M [2, then five of 1 7], each answer
// ending in the code's marker, each read's gas used beside its answer, the same on every provider of a chain (card
// evm-quote-gas-used). Bad: `bad`, the same run
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
  assert.equal(r.lines.length, 4 + 2 * A.good.chains.length + 5 * providers);
});

test("the bad answer (Multicall3's own code) fails: the loop and the caught out of gas answer as reverts on every provider", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const providers = A.bad.chains.reduce((n, c) => n + c.reads.length, 0);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD")).length, 1 + 5 * providers, r.lines.join("\n"));
});

test("planted: one provider on a chain, a chain missing, a read answered 0 where 2 is due, a heavy revert answered 2, a read behind the loop answered 2, an error for an answer, no marker, a gas used wrong or differing", () => {
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
  // the heavy revert answered 2, as the even share of 206d625f's code answered it (the warm quote's re-reads)
  const twoFirst = (r) => {
    const h = r.slice(2);
    const e = 64 + Number(BigInt("0x" + h.slice(128, 192)));
    return "0x" + h.slice(0, 2 * e) + "2".padStart(64, "0") + h.slice(2 * e + 64);
  };
  assert.equal(plant((a) => (a.chains[0].reads[0].heavy = twoFirst(a.chains[0].reads[0].heavy))), false, "a heavy revert answered 2");
  // a read behind the loop answered 2, as a code that keeps nothing for the reads after the one it runs answers it
  const twoSecond = (r) => {
    const h = r.slice(2);
    const e = 64 + Number(BigInt("0x" + h.slice(192, 256)));
    return "0x" + h.slice(0, 2 * e) + "2".padStart(64, "0") + h.slice(2 * e + 64);
  };
  assert.equal(plant((a) => (a.chains[1].reads[2].floor = twoSecond(a.chains[1].reads[2].floor))), false, "a read behind the loop answered 2");
  // a provider that stopped applying the code override answers Multicall3's own shape, which has no marker
  assert.equal(plant((a) => (a.chains[1].reads[1].six = a.chains[1].reads[1].six.slice(0, -64))), false, "no marker");
  // card evm-quote-gas-used: the first read's gas used answered as `g` (the 14M revert's as 100,000, or one provider's
  // differing from the others by one)
  const usedFirst = (r, g) => {
    const h = r.slice(2);
    const e = 64 + Number(BigInt("0x" + h.slice(128, 192)));
    return "0x" + h.slice(0, 2 * (e + 32)) + g.toString(16).padStart(64, "0") + h.slice(2 * (e + 64));
  };
  assert.equal(plant((a) => (a.chains[0].reads[2].heavy = usedFirst(a.chains[0].reads[2].heavy, 100_000))), false, "the 14M revert answered as using 100,000");
  assert.equal(plant((a) => (a.chains[1].reads[3].sixtyFour = usedFirst(a.chains[1].reads[3].sixtyFour, 29_533_582))), false, "one provider's gas used differs");
});
