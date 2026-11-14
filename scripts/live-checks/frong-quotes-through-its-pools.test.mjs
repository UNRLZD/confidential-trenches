// node --test scripts/live-checks/frong-quotes-through-its-pools.test.mjs: the live check frong-quotes-through-its-pools,
// replayed. frong-quotes-through-its-pools.answers.json holds two real Robinhood mainnet runs from the Mac (read only):
// - bad_before: FRONG's four buy taps as robinhood-quotes-inside-provider-limits recorded them on 2d4e7dead
//   (2026-11-13 23:52Z, its step2_after), every one too_many_pools; that check reads no sale, so no holder;
// - good_after: this check's own `--record` on the card's branch (2026-11-14 02:33Z): four buy taps and two sells, each
//   a quote.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, WARM_RUNS } from "./frong-quotes-through-its-pools.mjs";

const A = JSON.parse(readFileSync(new URL("./frong-quotes-through-its-pools.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("the recorded run after the fix passes: every buy tap and both sells end in a quote", () => {
  const v = judge(A.good_after);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good_after.buys.length, 1 + WARM_RUNS);
  assert.equal(A.good_after.sells.length, 2);
});

test("the recorded run before fails: every FRONG buy tap refused too_many_pools", () => {
  const v = judge(A.bad_before);
  assert.equal(v.verdict, "FAIL");
  assert.ok(bad(v).some((l) => /buy taps each end in a quote/.test(l)), v.lines.join("\n"));
  assert.ok(bad(v).some((l) => /too_many_pools/.test(l)), v.lines.join("\n"));
});

test("each plant on the good run fails on its own line; no holder is INCONCLUSIVE, never a pass", () => {
  const g = () => structuredClone(A.good_after);
  const one = g();
  one.buys[2] = { ...one.buys[2], ok: false, code: "too_many_pools", message: "too_many_pools: planted" };
  assert.equal(judge(one).verdict, "FAIL");
  const sell = g();
  sell.sells[1] = { ...sell.sells[1], ok: false, code: "too_many_pools", message: "too_many_pools: planted" };
  const vs = judge(sell);
  assert.equal(vs.verdict, "FAIL");
  assert.ok(bad(vs).some((l) => /sells as .* each end in a quote/.test(l)), vs.lines.join("\n"));
  const short = g();
  short.buys.pop();
  assert.equal(judge(short).verdict, "FAIL");
  const none = g();
  none.holder = { w: null, lines: ["planted"] };
  none.sells = [];
  assert.equal(judge(none).verdict, "INCONCLUSIVE");
  const idx = g();
  idx.index.served = false;
  assert.equal(judge(idx).verdict, "FAIL");
});
