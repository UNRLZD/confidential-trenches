// node --test scripts/live-checks/cash-withdraws-everything-to-any-chain.test.mjs: the live check replays its recorded
// answers (cash-withdraws-everything-to-any-chain.answers.json). good: this card's SIGN_HOST build (mainnet), the Cash
// withdraw's steps and its checked send to another chain in the bundle: PASS. bad: SIGN_HOST as served before this card's deploy:
// FAIL on both. Planted on the good one: another /app.js, no pin, no steps, no send to another chain: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, ONWARD, read, SIGN } from "./cash-withdraws-everything-to-any-chain.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./cash-withdraws-everything-to-any-chain.answers.json", import.meta.url), "utf8"));
const NO_STEPS = "BAD the bundle draws no Cash withdraw steps: Withdraw sends one note, not the whole of Cash";
const NO_ONWARD = "BAD the bundle has no checked send to another chain: Cash goes out to NEAR only";

test("recorded good answer: this card's build draws the steps and checks a send to another chain: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before this card: FAIL, each fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_STEPS, NO_ONWARD]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, steps: false }).lines, [NO_STEPS]);
  assert.deepEqual(judge({ ...g, onward: undefined }).lines, [NO_ONWARD]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle, and the read of SIGN_HOST's index and pinned bundle", async () => {
  const js = `p.dataset.steps=\`cash-withdraw\`;throw Error(\`${ONWARD}\`)`;
  assert.deepEqual([facts("", js).steps, facts("", js).onward], [true, true]);
  assert.equal(facts("", js.replace("cash-withdraw", "cash")).steps, false);
  assert.equal(facts("", js.replace("onward quote:", "quote:")).onward, false);
  const files = { [`${SIGN}/`]: "<html></html>", [`${SIGN}/app.js`]: js };
  const f = async (u) => (u in files ? new Response(files[u], { status: 200 }) : new Response("", { status: 404 }));
  assert.equal((await read(f)).steps, true);
  delete files[`${SIGN}/app.js`];
  await assert.rejects(read(f), /HTTP 404/);
});
