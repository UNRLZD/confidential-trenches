// Replays evm-sell-hook-converge.answers.json through the live check. The good answer is the check's --local run on the
// card's branch (bafd7ebf): its helper sender in process carries the hooked plant to the deadline check, past the route
// check; it passes. The bad answer is a real read of HELPER_HOST at its build ea97ceff, before the card: the hooked
// plant is refused bad_route on both testnets; it fails on those two lines alone.
//   node --test scripts/live-checks/evm-sell-hook-converge.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HOOK, judge, plants } from "./evm-sell-hook-converge.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-sell-hook-converge.answers.json", import.meta.url), "utf8"));

test("the good answer (the card's helper sender) passes: both plants reach deadline_near on both testnets", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const n of ["base-sepolia", "robinhood-testnet"]) assert.ok(r.lines.some((l) => l.startsWith(`ok  [${n} hooked_deadline_near] POST /v1/pool/evm/sell answers 422`)), n);
});

test("the bad answer (HELPER_HOST before the card) fails: the hooked plant refused bad_route, and only that", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(bad.length, 2, bad.join("\n"));
  assert.ok(bad.every((l) => /hooked_deadline_near\] POST \/v1\/pool\/evm\/sell answers 422 \{"error":\{"code":"bad_route"/.test(l)), bad.join("\n"));
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const one = (f) => {
    const g = structuredClone(A.good);
    f(g);
    return judge(g).ok;
  };
  assert.equal(one((g) => (g.pools = [])), false, "no pool");
  assert.equal(one((g) => (g.pools[0].reads.find((r) => r.asked === "fee").status = 503)), false, "the fee unread");
  assert.equal(one((g) => (g.pools[0].reads.find((r) => r.asked === "fee").body = "{}")), false, "no fee collector");
  assert.equal(one((g) => g.pools[1].reads.splice(g.pools[1].reads.findIndex((r) => r.asked === "listed_deadline_near"), 1)), false, "a plant unread");
  assert.equal(one((g) => (g.pools[0].reads.find((r) => r.asked === "listed_deadline_near").body = JSON.stringify({ hash: "0x" + "ab".repeat(32) }))), false, "a plant sent");
  assert.equal(one((g) => (g.pools[0].reads.find((r) => r.asked === "hooked_deadline_near").status = 200)), false, "another status");
  assert.equal(one((g) => (g.pools[1].reads[0].headers["x-helper-commit"] = null)), false, "no commit header");
});

test("the hooked plant routes through HOOK and the listed one through no hook, each with its deadline 59 s away", () => {
  const p = plants({ network: "base-sepolia", pool: A.good.pools[0].pool, feeRecipient: "0x9cc4788af51677aaa7770d78277c41fb864b35e1", nowMs: 1_794_023_395_000 });
  const hookWord = HOOK.slice(2).padStart(64, "0");
  // the Sell's data holds the swap's bytes: the hook's word only in the hooked plant
  assert.ok(p.hooked_deadline_near.data.includes(hookWord));
  assert.ok(!p.listed_deadline_near.data.includes(hookWord));
});
