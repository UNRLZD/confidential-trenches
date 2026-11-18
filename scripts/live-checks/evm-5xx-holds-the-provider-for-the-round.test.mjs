// node --test scripts/live-checks/evm-5xx-holds-the-provider-for-the-round.test.mjs: the live check replays its
// recorded answers (evm-5xx-holds-the-provider-for-the-round.answers.json). good: this card's SIGN_HOST build
// (scripts/signpage-built.mjs on its branch): PASS. bad: SIGN_HOST as served on 18 Nov 03:16Z, which sends a provider
// that answered HTTP 5xx every batch of its round: FAIL, each fact named. Planted on the good one: another /app.js, no
// pin, and each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, NO_GATE, NO_ROUND, NO_SCAN, read, SCAN } from "./evm-5xx-holds-the-provider-for-the-round.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-5xx-holds-the-provider-for-the-round.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the card's build holds a provider that answered 5xx for its round: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST on 18 Nov 03:16Z: FAIL, every mark named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_GATE, NO_ROUND, NO_SCAN]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const planted = [
    [{ ...g, sha384: "sha384-other" }, "BAD SIGN_HOST's served /app.js is not the one index.html pins"],
    [{ ...g, index: "<html></html>" }, "BAD SIGN_HOST's index.html pins no /app.js"],
    [{ ...g, gate: false }, NO_GATE],
    [{ ...g, round: false }, NO_ROUND],
    [{ ...g, scan: false }, NO_SCAN],
  ];
  for (const [a, line] of planted) {
    const v = judge(a);
    assert.equal(v.ok, false, line);
    assert.ok(v.lines.includes(line), `${line}\n${v.lines.join("\n")}`);
  }
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("the marks as the build minifies them, and none in the code before the card", () => {
  const card = 'l(e).catch(e=>{throw MS(e)&&t?.down?.(),e}) spare:()=>!_&&m<l.length,down:()=>void c?.add(l[r])}) "' + SCAN + '"';
  const f = facts("", card);
  assert.deepEqual([f.gate, f.round, f.scan], [true, true, true]);
  // main's gated sent the request and returned its promise; its hooks ended at spare
  const before = facts("", "t?.moved()===!0?Promise.reject(Ab):(i(),t?.sent(),l(e)) spare:()=>!_&&m<l.length})");
  assert.deepEqual([before.gate, before.round, before.scan], [false, false, false]);
});

test("read() asks SIGN_HOST's / and /app.js and nothing else", async () => {
  const asked = [];
  const fetchFn = async (url) => (asked.push(url), new Response(url.endsWith("/app.js") ? `x"${SCAN}"` : A.good.index));
  const a = await read(fetchFn);
  assert.deepEqual(asked, ["https://confidential.unrealized.trade/", "https://confidential.unrealized.trade/app.js"]);
  assert.equal(a.scan, true);
});
