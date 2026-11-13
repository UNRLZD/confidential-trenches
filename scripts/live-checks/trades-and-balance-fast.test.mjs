// node --test scripts/live-checks/trades-and-balance-fast.test.mjs: the live check replays its recorded answers
// (trades-and-balance-fast.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before the
// card: FAIL, all four marks named. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL.
// Planted in a bundle: the old second's pace, a read count off the budget, a gate with no gap, the sweep's follow
// before its send or holding the sell lock, filled told before every leg landed or on a short share: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_FOLLOW, NO_GATE, NO_LANDED, NO_PACE, facts, judge } from "./trades-and-balance-fast.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./trades-and-balance-fast.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, all four marks named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_PACE, NO_GATE, NO_FOLLOW, NO_LANDED]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, pace: false }).lines, [NO_PACE]);
  assert.deepEqual(judge({ ...g, gate: false }).lines, [NO_GATE]);
  assert.deepEqual(judge({ ...g, follow: false }).lines, [NO_FOLLOW]);
  assert.deepEqual(judge({ ...g, landed: false }).lines, [NO_LANDED]);
});

test("planted in a bundle: each mark broken in place FAILs", () => {
  // as the card's build minifies them
  const good = [
    "var GX=1e3,KX=400,qX=120*GX/KX,JX=4e3",
    "o=await Promise.all(e.map(e=>e(`getSlot`,[{commitment:`finalized`}]))).then(e=>e.map(e=>cZ(e)),()=>null);if(o===null)return 0;let s=Math.max(a[0]-o[0],a[1]-o[1]);return s>0?Math.min(s*KX,AZ):0}",
    "await y(j.one.signed,j.one.signature),n?.release();let P=0;return await MZ(jZ(s,j.one.signature,j.one.signed),async()=>0",
    "landed:e=>{v.add(e),y===null&&m.short!==!0&&m.legs!==void 0&&m.legs.length>0&&v.size===m.legs.length&&(y=`filled`,r.progress(`filled`))},ended:(e,t)=>{}",
  ];
  const ok = facts("", good.join(";"));
  assert.equal(ok.pace && ok.gate && ok.follow && ok.landed, true, JSON.stringify(ok));
  const broken = (i, from, to) => facts("", good.map((s, k) => (k === i ? s.replace(from, to) : s)).join(";"));
  assert.equal(broken(0, "KX=400", "KX=1e3").pace, false, "a second apart");
  assert.equal(broken(0, "120*GX/KX", "120").pace, false, "a read count off the wall-clock budget");
  assert.equal(broken(1, "return s>0?Math.min(s*KX,AZ):0", "return 0").gate, false, "no gap waited");
  assert.equal(broken(1, "`finalized`", "`confirmed`").gate, false, "the confirmed slot, not the finalized one");
  assert.equal(broken(2, "n?.release();", "").follow, false, "the sell lock held through the follow");
  assert.equal(broken(2, "await y(j.one.signed,j.one.signature),", "").follow, false, "no send before the follow");
  assert.equal(broken(3, "v.size===m.legs.length", "v.size>0").landed, false, "filled told before every leg landed");
  assert.equal(broken(3, "m.short!==!0&&", "").landed, false, "filled told on a share left short");
});
