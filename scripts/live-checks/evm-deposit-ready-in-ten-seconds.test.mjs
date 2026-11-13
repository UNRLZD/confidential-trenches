// node --test scripts/live-checks/evm-deposit-ready-in-ten-seconds.test.mjs: card evm-deposit-ready-in-ten-seconds's live
// check, replayed. evm-deposit-ready-in-ten-seconds.answers.json holds two real runs from the Mac (`--record`), none
// edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place: PASS;
// - bad_live_before: SIGN_HOST as served before this card (U's nonce and its final block read before the round): FAIL.
// And plants on this tree's own build: each part changed fails that part alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { judge, pageFacts } from "./evm-deposit-ready-in-ten-seconds.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-deposit-ready-in-ten-seconds.answers.json", import.meta.url), "utf8"));
const PARTS = ["first", "guard"];

test("the recorded good run passes: this card's build", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails: SIGN_HOST before this card reads U's nonce before the round", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_live_before.from, "https://confidential.unrealized.trade");
  assert.equal(A.bad_live_before.page.first, false);
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

test("planted on this tree's build: each part changed fails that part alone", () => {
  // a read before the verdict's round
  assert.deepEqual(off(planted(/\.secretKey\);let ([\w$]+)=await ([\w$]+)\.h\.round\(\),/, (_m, o, e) => `.secretKey);let ${o}=(await ${e}.store.list(),await ${e}.h.round()),`)), ["first"]);
  // dead at any final nonce, whatever the round's final block
  assert.deepEqual(off(planted(/([\w$]+)!==null&&([\w$]+)\.finalBlock>=\1\)return\{kind:`dead`\}/, (_m, u) => `${u}!==null)return{kind:\`dead\`}`)), ["guard"]);
});
