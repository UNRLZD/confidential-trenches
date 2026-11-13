// node --test scripts/live-checks/evm-pass-in-two-seconds.test.mjs: card evm-pass-in-two-seconds's live check, replayed.
// evm-pass-in-two-seconds.answers.json holds two real runs from the Mac (`--record`), none edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place: PASS;
// - bad_live_before: SIGN_HOST as served before this card (the held block read again, the cut searched by root times,
//   the newest read waiting for a later block): FAIL.
// And plants on this tree's own build: each part's code changed back to its shape before this card FAILs that part
// alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { judge, pageFacts } from "./evm-pass-in-two-seconds.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pass-in-two-seconds.answers.json", import.meta.url), "utf8"));
const PARTS = ["held", "fee", "batched", "cut", "newest", "depth"];

test("the recorded good run passes: this card's build", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails: SIGN_HOST before this card, every part", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_live_before.from, "https://confidential.unrealized.trade");
  for (const k of PARTS) assert.equal(A.bad_live_before.page[k], false, k);
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

test("planted on this tree's build: each part back to its shape before this card fails that part alone", () => {
  // the held block read again on both RPCs (heldBlock): taken only while both hold it
  assert.deepEqual(off(planted(/let ([\w$]+)=([\w$]+)\.get\(([\w$]+)\)\?\.block\?\?await/, (_m, u, c, i) => `let ${u}=(${c}.get(${i})?.hash===${c}.get(${i})?.hash&&${c}.get(${i})?.hash===${c}.get(${i})?.hash?${c}.get(${i})?.block:null)??await`)), ["held"]);
  // the pool's time read alone, the helper's fee asked only by the bind
  assert.deepEqual(off(planted(/return typeof ([\w$]+)==`bigint`&&\1>0n&&[\w$]+\.get\(\1-\1%[\w$]+,([\w$]+)\)\.catch\(\(\)=>\{\}\),\1\}/, (_m, t) => `return ${t}}`)), ["fee"]);
  // the logs read after the views, never beside them
  assert.deepEqual(off(planted(/\{fin:([\w$]+),anchor:([\w$]+)\},([\w$]+),([\w$]+)\.length,([\w$]+),([\w$]+)\),([\w$]+)\.catch/, (m) => m.replace("{fin:", "{fin:await ")) ), ["batched"]);
  // the cut searched by root times: the sync never handed the first block
  assert.deepEqual(off(planted(/\{\.\.\.([\w$]+),first:([\w$]+)\.block\}/, (_m, n) => n)), ["cut"]);
  // the newest read a round of its own every time
  assert.deepEqual(off(planted(/\?\.newest===!0&&([\w$]+)!==null&&\1\.anchor\.timestamp\*1000n>=([\w$]+)-1n\?\1:await/, (_m, o, e) => `?.newest===!0&&${o}!==null&&!1?${o}:await`)), ["newest"]);
  // the depth read on both RPCs again
  assert.deepEqual(off(planted(/&&([\w$]+)\.firsts\.has\(`\$\{([\w$]+)\}:\$\{([\w$]+)\}`\)\)return Promise\.resolve\(/, (m) => m.replace("return Promise.resolve(", "return Promise.reject(")) ), ["depth"]);
});
