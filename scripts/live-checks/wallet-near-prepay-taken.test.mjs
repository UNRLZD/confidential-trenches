// node --test scripts/live-checks/wallet-near-prepay-taken.test.mjs: the live check replays its recorded answers
// (wallet-near-prepay-taken.answers.json). good: this card's SIGN_HOST build as committed on its branch (index.html and
// public/app.js): PASS. bad: SIGN_HOST as served before the card's deploy (read 7 Nov 18:03Z), whose bundle reads no
// call's signed amount: FAIL, the fact named. Planted on the good one: another /app.js, no pin, no value read, no follow:
// each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, LOCK, MARK, read } from "./wallet-near-prepay-taken.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-near-prepay-taken.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the card's build reads a call's signed amount and follows deposits: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, the value read named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [`BAD SIGN_HOST's bundle does not read a deposit call's signed amount (${JSON.stringify(MARK)}): a stranger's deposit naming U counts as U's`]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const planted = [
    [{ ...g, sha384: "sha384-other" }, "BAD SIGN_HOST's served /app.js is not the one index.html pins"],
    [{ ...g, index: "<html></html>" }, "BAD SIGN_HOST's index.html pins no /app.js"],
    [{ ...g, value_read: false }, `BAD SIGN_HOST's bundle does not read a deposit call's signed amount (${JSON.stringify(MARK)}): a stranger's deposit naming U counts as U's`],
    [{ ...g, lock: false }, `BAD SIGN_HOST's bundle has no deposit follow (${LOCK})`],
  ];
  for (const [a, line] of planted) {
    const v = judge(a);
    assert.equal(v.ok, false, line);
    assert.ok(v.lines.includes(line), `${line}\n${v.lines.join("\n")}`);
  }
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("read() asks SIGN_HOST's / and /app.js and nothing else", async () => {
  const asked = [];
  const fetchFn = async (url) => (asked.push(url), new Response(url.endsWith("/app.js") ? `x${MARK}${LOCK}` : A.good.index));
  const a = await read(fetchFn);
  assert.deepEqual(asked, ["https://confidential.unrealized.trade/", "https://confidential.unrealized.trade/app.js"]);
  assert.deepEqual([a.value_read, a.lock], [true, true]);
});
