// node --test scripts/live-checks/evm-cold-multihop-quote-inside-the-kpi.test.mjs: card
// evm-cold-multihop-quote-inside-the-kpi. The live check replays its recorded answers
// (evm-cold-multihop-quote-inside-the-kpi.answers.json). good: this branch's kit with the repo's Base snapshot: PASS.
// bad: the same run on the card's base (ef1433dc8), whose second kit quote agreed on a new head and read there: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AGAIN_MAX_MS, COINS, FIRST_MAX_MS, check } from "./evm-cold-multihop-quote-inside-the-kpi.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-cold-multihop-quote-inside-the-kpi.answers.json", import.meta.url), "utf8"));
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes", () => {
  const r = check(A.good.run);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(A.good.run.coins[0].first.asks.length > 1, "the good run's cold tap followed a reference");
});

test("the recorded bad answer fails: the followed quote asked at no block, its reads at two block hashes", () => {
  const r = check(A.bad.run);
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => l.includes("the later ones asked at no block")), bads(r).join("\n"));
});

test("a slow or faulted tap, a follow at another block, reads at two blocks, a coin short, no sync or a 429 fails", () => {
  const run = () => structuredClone(A.good.run);
  const other = "0x" + "1".repeat(64);
  const cases = {
    "slow cold": (x) => (x.coins[0].first.ms = FIRST_MAX_MS + 1),
    "slow again": (x) => (x.coins[0].again.ms = AGAIN_MAX_MS + 1),
    "a provider's fault": (x) => (x.coins[0].first = { ...x.coins[0].first, out: undefined, code: "rpc_error" }),
    "a stale quote": (x) => (x.coins[0].again = { ...x.coins[0].again, out: undefined, code: "stale_quote" }),
    "an unnamed end": (x) => (x.coins[0].first = { ...x.coins[0].first, out: undefined, code: undefined }),
    "a follow asked at another block": (x) => (x.coins[0].first.asks[1].at = other),
    "a follow asked at none": (x) => (x.coins[0].first.asks[1].at = null),
    "reads at two blocks": (x) => x.coins[0].first.blocks.push(other),
    "a coin short": (x) => x.coins.pop(),
    "another coin": (x) => (x.coins[0].coin = "0x" + "2".repeat(40)),
    "a partial sync": (x) => (x.sync.served = false),
    "no snapshot": (x) => ((x.snapshot = { status: 404 }), (x.sync = null)),
    "a 429": (x) => (x.s429 = { "base-rpc.publicnode.com": 1 }),
  };
  for (const [what, f] of Object.entries(cases)) {
    const x = run();
    f(x);
    assert.equal(check(x).ok, false, what);
  }
  assert.equal(A.good.run.coins.length, COINS.length);
});
