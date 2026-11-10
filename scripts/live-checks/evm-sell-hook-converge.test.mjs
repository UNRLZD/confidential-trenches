// Replays evm-sell-hook-converge.answers.json through the live check. The good answer is the check's --local run on the
// card's branch (bafd7ebf): its helper sender in process carries the hooked plant to the deadline check, past the route
// check; it passes. The bad answer is a real read of HELPER_HOST at its build ea97ceff, before the card: the hooked
// plant is refused bad_route on both testnets; it fails on those two lines alone.
//   node --test scripts/live-checks/evm-sell-hook-converge.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HOOK, judge, plants, read } from "./evm-sell-hook-converge.mjs";

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

// card evm-fee-quiet-epoch: the fee read goes through evm-pool-fee-epoch.mjs. The helper has no block yet in the first
// moment of a minute (503 index_behind; 404 not_found before its change): the epoch before is asked, and a chain with no
// block for a minute is INCONCLUSIVE, never PASS.
const NO_BLOCK = [503, '{"error":{"code":"index_behind"}}'];
const NOT_FOUND = [404, '{"error":{"code":"not_found"}}'];
const goodFee = A.good.pools[0].reads.find((r) => r.asked === "fee");
const goodPlants = A.good.pools[0].reads.filter((r) => r.asked !== "fee");
/** read() against a fake helper: `first` answers the fee asked for the helper's now, `second` the one with &epoch=. */
async function planted(first, second) {
  const asked = [];
  let post = 0;
  const answer = (status, body) => new Response(body, { status, headers: { "x-helper-commit": goodFee.headers["x-helper-commit"] } });
  const fetchFn = async (url, init = {}) => {
    asked.push(`${init.method ?? "GET"} ${url}`);
    if (init.method === "POST") {
      const r = goodPlants[post++ % goodPlants.length];
      return answer(r.status, r.body);
    }
    const a = url.includes("&epoch=") ? second : first;
    return a === "good" ? answer(200, goodFee.body) : answer(a[0], a[1]);
  };
  const run = await read("https://helper.test", fetchFn);
  return { run, asked, r: judge(run) };
}

for (const [name, first] of [["503 index_behind", NO_BLOCK], ["404 not_found", NOT_FOUND]]) {
  test(`the first fee answer ${name} and the epoch before's 200 passes, both asks recorded`, async () => {
    const { run, asked, r } = await planted(first, "good");
    assert.equal(r.verdict, "PASS", r.lines.join("\n"));
    assert.equal(asked.filter((u) => u.startsWith("GET ")).length, 2 * run.pools.length);
    for (const p of run.pools) assert.deepEqual(p.reads.slice(0, 2).map((x) => [x.asked, x.status]), [["fee_first", first[0]], ["fee", 200]]);
  });
}

test("503 index_behind on the epoch and the one before is INCONCLUSIVE, never PASS; no plant is sent", async () => {
  const { asked, r } = await planted(NO_BLOCK, NO_BLOCK);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("QUIET") && /no block in the epoch or the one before/.test(l)), r.lines.join("\n"));
  assert.ok(asked.every((u) => u.startsWith("GET ")), "no POST");
});

test("404 not_found on the epoch and the one before fails: the pool is not carried", async () => {
  const { r } = await planted(NOT_FOUND, NOT_FOUND);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && /\[[a-z-]+ fee\] GET \/v1\/pool\/fee answers 404/.test(l)));
});
