// node --test scripts/live-checks/sol-tape-in-order.test.mjs: the live check replays recorded answers
// (sol-tape-in-order.answers.json), both read 19 Nov 00:0xZ (UTC+7) on the same three busy listed coins off pump.fun
// (cbBTC, Xsc9qvGR, A7bdiYdS), each row's block time read on api.mainnet-beta. good: apps/helper at this card's branch
// run on a Mac with no vendor key (127.0.0.1:8799): every read newest first, 55 rows each dated by its block: PASS.
// bad_deployed: the deployed helper c775de255 at the same minute: cbBTC's trade 3 dated a second after trade 2, rows 1 s
// after their blocks on two coins: FAIL. Made from the good answer: a row moved a second late, rows out of order, a
// refused read, too few rows read back (INCONCLUSIVE).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { busiest, judge, sampled } from "./sol-tape-in-order.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "sol-tape-in-order.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (fn) => {
  const rec = structuredClone(A.good);
  fn(rec);
  return rec;
};
const rows = (r, fn) => {
  const b = JSON.parse(r.body);
  fn(b.trades);
  r.body = JSON.stringify(b);
};

test("the good answer passes", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.verdict, "PASS");
  assert.ok(r.lines.some((l) => /55 sampled rows read back/.test(l)));
});

test("the deployed helper before this card fails: a row a second after its block, above an older one", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /is newer than trade/.test(l)));
  assert.ok(bad(r).some((l) => /its block .*1 s off/.test(l)));
});

test("a sampled row dated a second after its block fails, in order or not", () => {
  const r = judge(edit((rec) => {
    const c = rec.coins.find((x) => x.reads.some((y) => JSON.parse(y.body).trades.length > 1));
    rows(c.reads.at(-1), (t) => (sampled(t)[0].t_ms += 1_000));
  }));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /1 s off/.test(l)));
});

test("rows out of order fail", () => {
  const r = judge(edit((rec) => rows(rec.coins[2].reads[0], (t) => t.reverse())));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /is newer than trade/.test(l)));
});

test("a refused read fails; too few rows read back is INCONCLUSIVE, never a pass", () => {
  assert.equal(judge(edit((rec) => (rec.coins[0].reads[1] = { atMs: 1, status: 503, body: "{}" }))).verdict, "FAIL");
  const few = judge(edit((rec) => (rec.blocks = Object.fromEntries(Object.entries(rec.blocks).slice(0, 1)))));
  assert.equal(few.verdict, "INCONCLUSIVE");
  assert.equal(judge({ coins: [] }).verdict, "FAIL");
});

test("the coins read are the busiest listed off pump.fun", () => {
  // a list row: its mint, launchpad and day's volume (mints in a variable: a literal under `token` reads as a key to gitleaks)
  const row = (token, launchpad, vol_24h_usd) => ({ token, launchpad, vol_24h_usd });
  const [SOL, TTWO, XSC9, HIGH] = ["So11111111111111111111111111111111111111112", "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh"];
  const list = [row(SOL, "pump.fun", 9e9), row(TTWO, null, 2.7e8), row(XSC9, null, 1e6), row(TTWO, null, 1), row(HIGH, "raydium-launchlab", 6e4), row("not a mint", null, 1e12)];
  assert.deepEqual(busiest(list), [TTWO, XSC9, HIGH]);
});
