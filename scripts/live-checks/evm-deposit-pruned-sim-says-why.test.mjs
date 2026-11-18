// node --test scripts/live-checks/evm-deposit-pruned-sim-says-why.test.mjs: card evm-deposit-pruned-sim-says-why's live
// check, replayed. evm-deposit-pruned-sim-says-why.answers.json holds two real runs from the Mac (`--record`), none
// edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place: PASS;
// - bad_live_before: SIGN_HOST as served before this card (a simulation's every refusal sim_failed, the verdict through
//   the chain walk): FAIL.
// And plants on this tree's own build: each part changed fails that part alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { judge, pageFacts } from "./evm-deposit-pruned-sim-says-why.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-deposit-pruned-sim-says-why.answers.json", import.meta.url), "utf8"));
const PARTS = ["miss", "sim", "down", "own"];

test("the recorded good run passes: this card's build", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails: SIGN_HOST before this card", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_live_before.from, "https://confidential.unrealized.trade");
  assert.deepEqual(PARTS.map((k) => A.bad_live_before.page[k]), [false, false, false, false]);
});

test("each part missing from the good run fails it", () => {
  for (const k of PARTS) {
    const a = structuredClone(A.good);
    a.page[k] = false;
    assert.equal(judge(a).verdict, "FAIL", k);
  }
  const a = structuredClone(A.good);
  a.page.pin = "sha384-other";
  assert.equal(judge(a).verdict, "FAIL", "an /app.js its index does not pin");
});

const dir = signBuilt();
const index = readFileSync(path.join(dir, "index.html"), "utf8");
const js = readFileSync(path.join(dir, "public/app.js"), "utf8");
/** The build with `from` replaced by `to` (once; it must be there): the parts judged on it. */
const planted = (from, to) => {
  assert.ok(js.match(from) !== null, `planted: ${from} is in the build`);
  return pageFacts(index, js.replace(from, to));
};
const off = (facts) => PARTS.filter((k) => facts[k] !== true);

test("this tree's build as it is: every part found", () => {
  assert.deepEqual(off(pageFacts(index, js)), []);
});

test("planted on this tree's build: each part changed fails it", () => {
  // a revert read as a state miss: the miss rule, and the sim and down found through it
  assert.deepEqual(off(planted(/return!([\w$]+)\.test\(([\w$]+)\)&&([\w$]+)\.test\(\2\)\}/, (_m, _r, t, s) => `return ${s}.test(${t})}`)), ["miss", "sim", "down"]);
  // a pruned node's word off the list
  assert.deepEqual(off(planted("|unsupported block number|", "|")), ["miss", "sim", "down"]);
  // any one state miss among the refusals a lag (a revert on the other RPC with it)
  assert.deepEqual(off(planted(/\.length>0&&([\w$]+)\.every\(([\w$]+)\)\)throw new /, (_m, k, f) => `.length>0&&${k}.some(${f}))throw new `)), ["sim", "down"]);
  // the lag thrown as a plain error: the run's catch reads it failed, not down
  assert.deepEqual(off(planted(/throw new ([\w$]+)\(`the simulation at block/, () => "throw new Error(`the simulation at block")), ["down"]);
  // the run's catch: the lag no longer down
  assert.deepEqual(off(planted(/\|\|([\w$]+) instanceof ([\w$]+)\?\(([\w$]+)\.fault=\1,\{error:`down`\}\)/, (_m, e, _c, n) => `?(${n}.fault=${e},{error:\`down\`})`)), ["down"]);
  // the verdict's Deposited through the chain walk again
  assert.deepEqual(off(planted(/=([\w$]+)\(([\w$]+)\.scope,([\w$]+)\.events,([\w$]+)\.precommitment\);if\(/, (_m, f, e, o, t) => `=${f}(${e}.scope,${o}.events,0n&&${t}.precommitment);if(`)), ["own"]);
});
