// node --test scripts/live-checks/signpage-pool-price.test.mjs: the live check's verdict replays recorded runs
// (signpage-pool-price.answers.json), each read on 4 Nov by signpage-pool-price.mjs collect() in headless Chrome on the
// test box: Pyth's SOL/USD on the signing page's own Solana pair, then the terminal in the stand-in shell sent the
// devnet Solana pool with that price fresh, stale and absent:
//   good: the harness, this card's terminal build (entry /assets/index-ByRV7dR0.js) at APP_HOST's name, read at
//         14:41:51Z: the pair agreed on 9388311299 x 10^-8 published 2 s before; at 1440 and 390 a fresh price shows
//         Bal $0.93, Buy on, and the tap asks for one pool.buy of 0.000532577 SOL ($0.05 rounded down); stale and none
//         show no USD, Buy off, nothing asked: PASS;
//   bad:  the deployed APP_HOST before this card (entry /assets/index-BqB1l2a4.js), read at 14:42:03Z: its kit's exact
//         state schema refuses a pool entry carrying a price, so with a fresh or stale price the box reads signed out
//         on the vault path and asks for nothing: FAIL.
// Planted from the good run: a wrong amount, a vault buy, Buy on or USD drawn with a stale price, a disagreeing or
// stale read, the page's pair changed, a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { expectedSol, judge, PAGE_PAIR, poolWith } from "./signpage-pool-price.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-pool-price.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, p) => rec.runs.find((r) => r.width === w && r.price === p);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the amount: $0.05 in SOL at the read's price, rounded down; the states the stand-in sends", () => {
  assert.equal(expectedSol({ price: "9388311299", expo: -8 }), "0.000532577");
  assert.equal(expectedSol({ price: "5000000000", expo: -8 }), "0.001");
  const p = { price: "9388311299", expo: -8, published_s: 1_793_803_309, read_ms: 1_793_803_311_000 };
  assert.deepEqual(poolWith("fresh", p, 1_793_803_312_000).price, p);
  assert.equal(poolWith("stale", p, 1_793_803_312_000).price.published_s, 1_793_803_312 - 60 - 30);
  assert.equal(Object.hasOwn(poolWith("none", p, 0), "price"), false);
});

test("recorded good answer: the page's pair agrees, a fresh price turns Buy on with a priced pool.buy, a stale or no price keeps it off: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 6);
});

test("recorded bad answer: the deployed app before this card reads a priced state as signed out: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop fresh: the box is on the vault path.*the tap asked for nothing, not one pool\.buy/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone stale: .*Buy is on with a stale price/.test(l)), r.lines.join("\n"));
});

test("planted: a pool.buy of another amount or chain, a vault buy, two asks, or none with a fresh price fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "fresh").asked[0].params.amount = "0.000532578")), /^BAD desktop fresh: its pool\.buy is 0\.000532578 SOL on solana, not 0\.000532577/);
  fails(mut((rec) => (run(rec, "phone", "fresh").asked[0].params.chain = "base")), /^BAD phone fresh: its pool\.buy is .* on base/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").asked = [{ type: "buy", params: {} }])), /^BAD desktop fresh: the tap asked for buy, not one pool\.buy/);
  fails(mut((rec) => run(rec, "phone", "fresh").asked.push(run(rec, "phone", "fresh").asked[0])), /^BAD phone fresh: the tap asked for pool\.buy, pool\.buy/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").asked = [])), /^BAD desktop fresh: the tap asked for nothing/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").box.ctaOn = false)), /^BAD desktop fresh: Buy is off with a fresh price/);
  fails(mut((rec) => (run(rec, "phone", "fresh").box.bal = "Bal —")), /^BAD phone fresh: Bal shows Bal —, not USD/);
});

test("planted: USD, Buy on or an ask with a stale or no price fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "stale").box.bal = "Bal $0.93")), /^BAD desktop stale: Bal shows Bal \$0\.93 with a stale price/);
  fails(mut((rec) => (run(rec, "phone", "none").box.ctaOn = true)), /^BAD phone none: Buy is on with no price/);
  fails(mut((rec) => (run(rec, "desktop", "none").asked = [{ type: "pool.buy", params: {} }])), /^BAD desktop none: the tap asked for pool\.buy/);
  fails(mut((rec) => (run(rec, "phone", "stale").box.path = "vault")), /^BAD phone stale: the box is on the vault path/);
});

test("planted: the page's read disagreeing, stale, on another pair or one host; a missing run, outside the shell, no shot fail", () => {
  fails(mut((rec) => { delete rec.read.price; rec.read.error = "the two RPCs disagree on the Pyth account"; }), /^BAD the two agree on Pyth's SOL\/USD: the two RPCs disagree/);
  fails(mut((rec) => (rec.read.published_s -= 61)), /^BAD the price is fresh: published 6\d s before the run/);
  fails(mut((rec) => (rec.read.rpcs = ["https://api.mainnet-beta.solana.com", PAGE_PAIR[1]])), /^BAD the page's Solana pair read/);
  fails(mut((rec) => (rec.read.rpcs = [PAGE_PAIR[0], PAGE_PAIR[0]])), /^BAD the page's Solana pair read/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 5 run\(s\) of 6/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").framed = false)), /^BAD desktop fresh: not inside SIGN_HOST's shell/);
  fails(mut((rec) => (run(rec, "phone", "stale").shot = null)), /^BAD phone stale: no screenshot/);
  fails(mut((rec) => (rec.entry = null)), /^BAD the served \/ names its entry script none/);
});
