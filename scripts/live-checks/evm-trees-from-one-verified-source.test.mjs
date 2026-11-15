// node --test scripts/live-checks/evm-trees-from-one-verified-source.test.mjs: card evm-trees-from-one-verified-source's
// live check, replayed. evm-trees-from-one-verified-source.answers.json holds two real runs from the Mac (`--record`),
// none edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place: PASS;
// - bad_live_before: SIGN_HOST as served before this card (a proof's trees wait for two operators' same logs): FAIL.
// And plants on this tree's own build: each text removed fails that part alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { judge, pageFacts, TEXTS } from "./evm-trees-from-one-verified-source.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-trees-from-one-verified-source.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: this card's build", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails: SIGN_HOST before this card waits for two operators' logs", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_live_before.from, "https://confidential.unrealized.trade");
  assert.equal(A.bad_live_before.page.root, 0);
});

test("each part missing or doubled in the good run fails it", () => {
  for (const k of Object.keys(TEXTS)) for (const v of [0, 2]) {
    const a = structuredClone(A.good);
    a.page[k] = v;
    assert.equal(judge(a).verdict, "FAIL", `${k} ${v}`);
  }
  const a = structuredClone(A.good);
  a.page.pin = "sha384-other";
  assert.equal(judge(a).verdict, "FAIL", "an /app.js its index does not pin");
});

const dir = signBuilt();
const index = readFileSync(path.join(dir, "index.html"), "utf8");
const js = readFileSync(path.join(dir, "public/app.js"), "utf8");

test("this tree's build as it is: each text once", () => {
  const f = pageFacts(index, js);
  for (const k of Object.keys(TEXTS)) assert.equal(f[k], 1, k);
});

test("planted on this tree's build: each text taken out fails its part alone", () => {
  for (const [k, t] of Object.entries(TEXTS)) {
    const f = pageFacts(index, js.replace(t, "planted"));
    assert.equal(f[k], 0, k);
    for (const o of Object.keys(TEXTS)) if (o !== k) assert.equal(f[o], 1, `${k}: ${o} kept`);
  }
});
