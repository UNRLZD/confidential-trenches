// node --test scripts/live-checks/evm-first-quote-inside-the-kpi.test.mjs: card evm-first-quote-inside-the-kpi.
// The live check replays its recorded answers (evm-first-quote-inside-the-kpi.answers.json). good: this branch with the
// release's fresh Base snapshot: PASS. bad: origin/main on SIGN_HOST at release 171, whose sync asked every span Pocket
// refused as halves on both readers (201 getLogs on the first for 86 spans) and took 12.7 s: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AGAIN_MAX_MS, COINS, FIRST_MAX_MS, HALVED_MAX, SYNC_MAX_MS, check } from "./evm-first-quote-inside-the-kpi.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-first-quote-inside-the-kpi.answers.json", import.meta.url), "utf8"));
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes", () => {
  const r = check(A.good.run);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer fails: a slow sync whose first reader asked spans as halves", () => {
  const r = check(A.bad.run);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.split(" (")[0]), ["BAD [base] a fresh device's sync from it whole in 12670 ms", "BAD [base] its first reader asked 201 getLogs for a gap of 849390 blocks, 86 spans"]);
});

test("a slow or partial sync, halves past the bound, a slow or faulted quote, a coin short, or a 429 fails", () => {
  const run = () => structuredClone(A.good.run);
  const cases = {
    "slow sync": (x) => (x.sync.ms = SYNC_MAX_MS + 1),
    "partial sync": (x) => (x.sync.served = false),
    "halves past the bound": (x) => (x.sync.getLogs[0] = Math.ceil((x.sync.coversThrough - x.snapshot.through) / x.sync.span) + 1 + HALVED_MAX + 1),
    "slow first quote": (x) => (x.coins[0].first.ms = FIRST_MAX_MS + 1),
    "slow again": (x) => (x.coins[1].again.ms = AGAIN_MAX_MS + 1),
    "a provider's fault": (x) => (x.coins[2].first = { ms: 900, code: "rpc_error" }),
    "a stale quote": (x) => (x.coins[3].again = { ms: 900, code: "stale_quote" }),
    "an unnamed end": (x) => (x.coins[4].first = { ms: 900 }),
    "a coin short": (x) => x.coins.pop(),
    "a 429": (x) => (x.s429 = { "base-rpc.publicnode.com": 1 }),
    "no snapshot": (x) => ((x.snapshot = { status: 404 }), (x.sync = null)),
  };
  for (const [what, f] of Object.entries(cases)) {
    const x = run();
    f(x);
    assert.equal(check(x).ok, false, what);
  }
  assert.equal(A.good.run.coins.length, COINS);
});
