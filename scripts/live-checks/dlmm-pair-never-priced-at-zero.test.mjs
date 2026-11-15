// node --test scripts/live-checks/dlmm-pair-never-priced-at-zero.test.mjs: card dlmm-pair-never-priced-at-zero's live
// check, replayed. dlmm-pair-never-priced-at-zero.answers.json holds three real runs from the Mac (`--record`, 15 Nov
// 06:34Z-06:35Z), none edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place: PASS;
// - bad_801_build: `--local` on PR 801's head (74166950d, card solana-buy-reaches-raydium-and-meteora), the build that
//   prices a DLMM pair at 0 when a first read moves its active bin out of the planned bin arrays: FAIL;
// - bad_live_before: SIGN_HOST as served before this card: FAIL.
// And plants on this tree's own build: each part changed fails that part alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { judge, pageFacts } from "./dlmm-pair-never-priced-at-zero.mjs";

const A = JSON.parse(readFileSync(new URL("./dlmm-pair-never-priced-at-zero.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: this card's build", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad runs fail: PR 801's build and SIGN_HOST before this card price a missed bin array at 0", () => {
  for (const k of ["bad_801_build", "bad_live_before"]) {
    const v = judge(A[k]);
    assert.equal(v.verdict, "FAIL", k);
    assert.equal(A[k].page.plan, 0, k);
    assert.equal(A[k].page.relook, 0, k);
  }
  assert.equal(A.bad_live_before.from, "https://confidential.unrealized.trade");
});

test("each part missing or doubled in the good run fails it, and an /app.js its index does not pin fails", () => {
  for (const [k, v] of [["plan", 0], ["plan", 2], ["walk", 0], ["walk", 2], ["relook", 0], ["relook", 2]]) {
    const a = structuredClone(A.good);
    a.page[k] = v;
    assert.equal(judge(a).verdict, "FAIL", `${k} ${v}`);
  }
  const a = structuredClone(A.good);
  a.page.pin = "sha384-other";
  assert.equal(judge(a).verdict, "FAIL");
  assert.equal(judge({}).verdict, "FAIL");
});

const dir = signBuilt();
const index = readFileSync(path.join(dir, "index.html"), "utf8");
const js = readFileSync(path.join(dir, "public/app.js"), "utf8");
/** The build with `from` replaced by `to` (once; it must be there): the parts judged on it. */
const planted = (from, to) => {
  assert.ok(js.match(from) !== null, `planted: ${from} is in the build`);
  return pageFacts(index, js.replace(from, to));
};

test("this tree's build as it is: each part found once", () => {
  const f = pageFacts(index, js);
  assert.deepEqual([f.plan, f.walk, f.relook], [1, 1, 1]);
});

test("planted on this tree's build: a plan from one read alone, a walk on every read array, a relook that keeps the 0, each fails", () => {
  // the arrays planned from provider A's read alone: no plan
  assert.equal(planted(/,([\w$]+)\(([\w$]+)\[1\]\.activeId,/, (_m, f, s) => `,${f}(${s}[0].activeId,`).plan, 0);
  // each read walks every read array, not its own: no walk
  assert.equal(planted(/new Map\(([\w$]+)\[([\w$]+)\]\.map\(/, (_m, o) => `new Map(${o}.flat().map(`).walk, 0);
  // a re-planned pair still missing its arrays left as it is: no relook
  assert.equal(planted(/&&\(([\w$]+)=\{kind:`bad`,why:`the \$\{([\w$]+)\.name\}'s read list moved twice`\}\)/, "").relook, 0);
});
