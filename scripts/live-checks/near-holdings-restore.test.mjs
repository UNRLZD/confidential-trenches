// node --test scripts/live-checks/near-holdings-restore.test.mjs: the live check replays its recorded answers
// (near-holdings-restore.answers.json). good: this card's SIGN_HOST build as committed (the check's --local) with the
// helper's record route answered by this card's helper: PASS. bad: SIGN_HOST and the helper as served before this
// card (release 125's build, the helper with no record route): FAIL, each named. Planted on the good one: a FastNEAR API
// host in connect-src, CORS for another origin, a record of another wallet, a record of the never-paid W that is not
// empty, an /app.js its index.html does not pin: each FAIL, named. The constant the check judges by is the page's own
// (src/near-buy.ts, read as text: a live check imports no file of packages/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ASKED, judge, W_KEY } from "./near-holdings-restore.mjs";

const PAGE_SRC = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages", "signpage", "src", "near-buy.ts");
const A = JSON.parse(readFileSync(new URL("./near-holdings-restore.answers.json", import.meta.url), "utf8"));
const planted = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};
const one = (v, re) => {
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 1, v.lines.join(" | "));
  assert.match(v.lines[0], re);
};

test("recorded good answer: this card's build, the helper's record route answering the never-paid W empty: PASS", () => {
  const v = judge(A.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
});

test("recorded bad answer: SIGN_HOST and the helper before this card: FAIL, the missing rebuild and route named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    "BAD SIGN_HOST's /app.js carries no rebuild from W's own calls: the build is before this card",
    "BAD the helper's record route answered HTTP 404",
    "BAD the helper's record route did not answer one record of the asked wallet",
  ]);
});

test("planted bad answers: each FAIL, named", () => {
  one(planted((a) => (a.csp = a.csp.replace("connect-src ", "connect-src https://api.fastnear.com "))), /names https:\/\/api\.fastnear\.com/);
  one(planted((a) => (a.record.acao = "https://elsewhere.example")), /allows "https:\/\/elsewhere\.example"/);
  one(planted((a) => (a.record.body.records[0].wallet = "1".repeat(64))), /one record of the asked wallet/);
  one(planted((a) => (a.record.body.records[0].token = "token.near")), /not the empty shape/);
  one(planted((a) => (a.record.body.records[0].calls = [{}])), /not the empty shape/);
  one(planted((a) => (a.appSha384 = "sha384-AAAA")), /is not the one its index.html pins/);
  assert.equal(ASKED, "0".repeat(64));
});

test("the check judges by the page's own constant", () => {
  const src = readFileSync(PAGE_SRC, "utf8");
  assert.ok(src.includes(`export const NEAR_HOLDINGS_W_KEY = "${W_KEY}";`));
  assert.ok(src.includes('RELEASE_BIND_URL.replace(/\\/v1\\/bind$/, "/v1/bind/record")'));
});
