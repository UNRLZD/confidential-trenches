// node --test scripts/live-checks/balance-shows-fast.test.mjs: the live check replays its recorded answers
// (balance-shows-fast.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before the card:
// FAIL, all three marks named. Planted on the good one: another /app.js, no pin, each mark taken away, one queue of two
// wired: each FAIL. Planted in a bundle: an adopt with no nullifier check or no root check, a queue with no kept list:
// each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_ADOPT, NO_STORE, NO_WIRED, facts, judge } from "./balance-shows-fast.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./balance-shows-fast.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, all three marks named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_STORE, NO_ADOPT, NO_WIRED]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, store: false }).lines, [NO_STORE]);
  assert.deepEqual(judge({ ...g, adopt: false }).lines, [NO_ADOPT]);
  assert.deepEqual(judge({ ...g, wired: 1 }).lines, [NO_WIRED]);
  assert.deepEqual(judge({ ...g, wired: 0 }).lines, [NO_WIRED]);
});

test("planted in a bundle: each mark broken in place FAILs", () => {
  // as the card's build minifies them
  const good = [
    "Ro=/^proofs\\/[^/]{1,200}$/",
    "if(p[1]!==Ye(i,c.ref).nullifierHash.toString()||p[2]!==u.toString()||p[3]!==m.stateRoot.toString()||p[5]!==m.labelRoot.toString())continue",
    "return{queue:Gn({seed64:o,notes:a,pool:s,provers:[e.vault],hardwareConcurrency:c,skip:$,kept:Qn(await t.store(),s.id)}),notes:a,poolId:s.id}",
    "return{queue:Gn({seed64:o,notes:a,pool:d,provers:[e.vault],hardwareConcurrency:f,skip:$,kept:Qn(await t.store(),d.id)}),notes:a,poolId:d.id}",
  ];
  const ok = facts("", good.join(";"));
  assert.equal(ok.store && ok.adopt && ok.wired === 2, true, JSON.stringify(ok));
  const broken = (i, from, to) => facts("", good.map((s, k) => (k === i ? s.replace(from, to) : s)).join(";"));
  assert.equal(broken(0, "proofs", "proof").store, false, "another key");
  assert.equal(broken(1, "p[1]!==Ye(i,c.ref).nullifierHash.toString()||", "").adopt, false, "no nullifier check");
  assert.equal(broken(1, "||p[3]!==m.stateRoot.toString()", "").adopt, false, "no root check");
  assert.equal(broken(3, ",kept:Qn(await t.store(),d.id)", "").wired, 1, "the EVM queue with no kept list");
});
