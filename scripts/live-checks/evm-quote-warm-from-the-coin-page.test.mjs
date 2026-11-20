// node --test scripts/live-checks/evm-quote-warm-from-the-coin-page.test.mjs: the live check's verdict replays its
// answers (evm-quote-warm-from-the-coin-page.answers.json; its _note says where each was read): the good run passes,
// the bad one fails on the cold tap alone, and planted changes to the good one fail by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, COINS, TAP_MAX_MS, WARM_MAX_MS } from "./evm-quote-warm-from-the-coin-page.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "evm-quote-warm-from-the-coin-page.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return check(run);
};

test("the recorded good run passes: both coins warmed, each tap one kit quote inside TAP_MAX_MS", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.coins.map((c) => c.coin), COINS);
});

test("the bad run (main's cold first tap of 0x07b3d9, 7,333 ms) fails on that tap alone", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), [`BAD [base] ${COINS[0]} tap after the warm quoted 159506262204199822828 in 7333 ms (at most ${TAP_MAX_MS} ms)`]);
});

test("planted on the good run: a slow warm, a slow tap, a provider's fault, a second kit quote, a 429, no sync, a coin missing each fail by name", () => {
  const cases = [
    [(run) => (run.coins[1].warm.ms = WARM_MAX_MS + 1), /warm ended in \d+ ms/],
    [(run) => (run.coins[1].tap.ms = TAP_MAX_MS + 1), /tap after the warm quoted \d+ in \d+ ms/],
    [(run) => (run.coins[0].tap = { ms: 400, code: "rpc_disagree", asks: 1 }), /refused rpc_disagree/],
    [(run) => (run.coins[0].tap.asks = 2), /tap: 2 kit quotes \(one\)/],
    [(run) => (run.s429 = { "base-rpc.publicnode.com": 3 }), /answers of 429: base-rpc\.publicnode\.com 3/],
    [(run) => (run.sync = { ms: 900, served: false }), /sync from it partial/],
    [(run) => run.coins.pop(), /1 of 2 coins/],
  ];
  for (const [f, want] of cases) {
    const r = edit(f);
    assert.equal(r.ok, false, String(want));
    assert.ok(bad(r).some((l) => want.test(l)), `${want}: ${bad(r).join(" | ")}`);
  }
  // each 429 is printed with its step, and a sync's fails the run as a tap's does (card evm-warm-tap-reads-in-one-round)
  const sync = edit((run) => ((run.s429 = { "base.api.pocket.network": 1 }), (run.s429At = { "sync, base.api.pocket.network": 1 })));
  assert.equal(sync.ok, false);
  assert.ok(sync.lines.includes("    429 in the sync, base.api.pocket.network: 1"), sync.lines.join("\n"));
  // a named refusal that is no provider's fault ends the tap
  const r = edit((run) => (run.coins[0].tap = { ms: 400, code: "not_allowed", asks: 1 }));
  assert.equal(r.ok, true, r.lines.join("\n"));
});
