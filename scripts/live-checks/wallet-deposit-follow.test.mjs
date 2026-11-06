// node --test scripts/live-checks/wallet-deposit-follow.test.mjs: the live check replays its recorded answers
// (wallet-deposit-follow.answers.json). good: this card's SIGN_HOST build as committed on its branch (index.html and
// public/app.js) and the helper's live POST status answer for the G1 run's address: PASS. bad: SIGN_HOST as served
// before the card's deploy and the helper asked by GET (405), as the card's first build asked it: FAIL, each fact named.
// Planted on the good one: another /app.js, no pin, no status URL, no follow lock, a helper 404, a keyless-style
// answer for another address, a status 1Click does not name: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ADDRESS, judge, read } from "./wallet-deposit-follow.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-deposit-follow.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the card's build carries the follow and the helper's keyed status names our address: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.deepEqual(A.good.helper.answer, { status: "SUCCESS", depositAddress: ADDRESS });
});

test("recorded bad answer: SIGN_HOST before the card and the helper asked by GET: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    "BAD SIGN_HOST's bundle reads no deposit status on the helper's proxy (/v1/proxy/oneclick/v0/status)",
    "BAD SIGN_HOST's bundle has no deposit follow (ct-wallet/deposit-follow/)",
    "BAD the helper's status read answers 405, not 200",
    "BAD the helper's status read is not 1Click's (X-Helper-Source null)",
    "BAD the status answer names none of 1Click's seven statuses (undefined)",
    "BAD the status answer does not name the address asked",
  ]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const planted = [
    [{ ...g, sha384: "sha384-other" }, "BAD SIGN_HOST's served /app.js is not the one index.html pins"],
    [{ ...g, index: "<html></html>" }, "BAD SIGN_HOST's index.html pins no /app.js"],
    [{ ...g, status_url: false }, "BAD SIGN_HOST's bundle reads no deposit status on the helper's proxy (/v1/proxy/oneclick/v0/status)"],
    [{ ...g, lock: false }, "BAD SIGN_HOST's bundle has no deposit follow (ct-wallet/deposit-follow/)"],
    [{ ...g, helper: { ...g.helper, status: 404, answer: {} } }, "BAD the helper's status read answers 404, not 200"],
    [{ ...g, helper: { ...g.helper, answer: { ...g.helper.answer, depositAddress: "b".repeat(64) } } }, "BAD the status answer does not name the address asked"],
    [{ ...g, helper: { ...g.helper, answer: { ...g.helper.answer, status: "DONE" } } }, 'BAD the status answer names none of 1Click\'s seven statuses ("DONE")'],
    [{ ...g, helper: { ...g.helper, source: "lifi" } }, 'BAD the helper\'s status read is not 1Click\'s (X-Helper-Source "lifi")'],
  ];
  for (const [a, line] of planted) {
    const v = judge(a);
    assert.equal(v.ok, false, line);
    assert.ok(v.lines.includes(line), `${line}\n${v.lines.join("\n")}`);
  }
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("read() asks SIGN_HOST's / and /app.js, and the helper's status by POST with Origin APP_HOST for the recorded address", async () => {
  const asked = [];
  const fetchFn = async (url, init = {}) => {
    asked.push([init.method ?? "GET", url, init.headers?.origin ?? null]);
    if (url.endsWith("/app.js")) return new Response("x");
    if (url.includes("/v1/proxy/")) return Response.json({ status: "SUCCESS", quoteResponse: { quote: { depositAddress: ADDRESS } } }, { headers: { "x-helper-source": "oneclick" } });
    return new Response(A.good.index);
  };
  const a = await read(fetchFn);
  assert.deepEqual(asked, [
    ["GET", "https://sign.confidential.unrealized.trade/", null],
    ["GET", "https://sign.confidential.unrealized.trade/app.js", null],
    ["POST", `https://api.confidential.unrealized.trade/v1/proxy/oneclick/v0/status?depositAddress=${ADDRESS}`, "https://confidential.unrealized.trade"],
  ]);
  assert.deepEqual(a.helper, { status: 200, source: "oneclick", answer: { status: "SUCCESS", depositAddress: ADDRESS } });
});
