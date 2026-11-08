// Replays evm-pool-index.answers.json through the live check: `good`, a real run on this card's kit (2026-11-08 from
// this Mac), passes; `bad`, the same script run in a checkout of the kit before this card (fb2c25cf, no index in the
// venue list), fails; and the good run with one thing changed fails: the readers' block N differs (no pin), one reader
// misses a pool, a span answered without its last block, two readers of one operator, a reader of ours, another margin.
//   node --test scripts/live-checks/evm-pool-index.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./evm-pool-index.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-index.answers.json", import.meta.url), "utf8"));
const bad = (run, re) => {
  const v = judge(run);
  assert.equal(v.pass, false);
  assert.ok(v.lines.some((l) => l.startsWith("BAD") && re.test(l)), v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
};
const changed = (f) => {
  const r = structuredClone(A.good);
  f(r);
  return r;
};

test("the recorded good run passes", () => {
  const v = judge(A.good);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
});

test("the recorded bad run, the kit before this card, fails: no index", () => {
  bad(A.bad, /base: the kit's venue lists no index/);
  bad(A.bad, /robinhood: the kit's venue lists no index/);
});

test("the good run with one thing changed fails", () => {
  for (const chain of ["base", "robinhood"]) {
    bad(changed((r) => (r.chains[chain].spans[0].on[1].last = "0x" + "11".repeat(32))), new RegExp(`${chain} .*the pin`));
    bad(changed((r) => r.chains[chain].spans[1].on[1].ids.pop()), new RegExp(`${chain} .*pools on both`));
    bad(changed((r) => (r.chains[chain].spans[2].on[0].last = null)), new RegExp(`${chain} .*with its last block in the same batch`));
    bad(changed((r) => (r.chains[chain].index.readers[1] = r.chains[chain].index.readers[0].replace("://", "://other."))), new RegExp(`${chain}: two index readers on two operators`));
    bad(changed((r) => (r.chains[chain].index.readers[1] = "https://ct-api.unrealized.trade")), new RegExp(`${chain}: no reader is ours`));
    bad(changed((r) => (r.chains[chain].index.margin = 0)), new RegExp(`${chain}: span .*margin 0`));
  }
});
