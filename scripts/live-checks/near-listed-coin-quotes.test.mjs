// node --test scripts/live-checks/near-listed-coin-quotes.test.mjs: the live check replays recorded runs
// (near-listed-coin-quotes.answers.json). good: the branch's NEAR lists (engineFirst over the live engine and Rhea's pools)
// read at HELPER_HOST's name at 2026-11-16 08:13Z, 16 coins each with a route of at least $1000, Rhea's pools read live
// on both RPCs: PASS. bad: the deployed helper at 08:12Z, before this card, 56 coins of which 40 have no such route,
// hoodl-95275b.launchpad.justhoot.near (Rhea DCL only) among them: FAIL. Made from the good run: a coin with no pool, a
// route under the floor and the lists not answered each FAIL; the RPCs' pages differing and no coin listed INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { coinsOf, judge } from "./near-listed-coin-quotes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-listed-coin-quotes.answers.json"), "utf8"));
const HOODL = "hoodl-95275b.launchpad.justhoot.near";
const edit = (fn) => {
  const r = structuredClone(A.good.run);
  fn(r);
  return judge(r);
};

test("good: the branch's lists, every NEAR coin with a route a buy quotes: PASS", () => {
  const j = judge(A.good.run);
  assert.equal(j.verdict, "PASS", j.lines.join("\n"));
  assert.ok(A.good.run.coins.length > 0 && !A.good.run.coins.includes(HOODL));
});

test("bad: the deployed helper before this card lists hoodl with no Rhea classic pool (nor, then, DCL read): FAIL, naming it", () => {
  const j = judge(A.bad.run);
  assert.equal(j.verdict, "FAIL");
  assert.ok(j.lines.some((l) => l.startsWith("BAD") && l.includes(HOODL) && l.includes("no Rhea classic pool or DCL pool")), j.lines.join("\n"));
  assert.equal(j.lines.filter((l) => l.startsWith("BAD")).length, 40);
});

test("planted: a coin with no pool, a route under the floor, or the lists not answered FAIL", () => {
  assert.equal(edit((r) => ((r.routes[r.coins[0]] = null), 0)).verdict, "FAIL");
  assert.equal(edit((r) => ((r.routes[r.coins[0]] = "999.99"), 0)).verdict, "FAIL");
  assert.equal(edit((r) => ((r.lists.status = 503), 0)).verdict, "FAIL");
  assert.equal(edit((r) => (r.coins.push(HOODL), 0)).verdict, "FAIL", "a listed coin the read did not value");
});

test("planted: the RPCs' pages differ, or no NEAR coin listed: INCONCLUSIVE", () => {
  assert.equal(edit((r) => ((r.error = { differ: true, message: "get_pools: the RPCs' answers differ" }), (r.block = null))).verdict, "INCONCLUSIVE");
  assert.equal(edit((r) => ((r.coins = []), (r.routes = {}))).verdict, "INCONCLUSIVE");
});

test("coinsOf: each NEAR coin of every list once, in list order; another chain's row is not one", () => {
  const rows = { new: [{ chain: "near", token: "a.near" }, { chain: "solana", token: "So1" }], trending: [{ chain: "near", token: "b.near" }, { chain: "near", token: "a.near" }], graduating: [{ chain: "near", token: 7 }] };
  assert.deepEqual(coinsOf({ lists: rows }), ["a.near", "b.near"]);
  assert.deepEqual(coinsOf(null), []);
});
