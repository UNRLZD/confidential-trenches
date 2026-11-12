// node --test scripts/live-checks/near-holdings-restore.test.mjs: the live check replays its recorded answers
// (near-holdings-restore.answers.json). good: this card's SIGN_HOST build as committed (the check's --local) with the
// FT list read live: PASS. bad: SIGN_HOST as served before this card (release 123), whose CSP lacks the FT list and
// whose bundle has no rebuild: FAIL, both named. Planted on the good one: the testnet FT list in connect-src, CORS for
// another origin, another account's list, too many rows, a row with no account id, an /app.js its index.html does not
// pin: each FAIL, named. The constants the check judges by are the page's own (src/near-buy.ts, read as text: a live
// check imports no file of packages/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EMPTY_KEY, FT_LIST, FT_LIST_TESTNET, HINTS_MAX, judge } from "./near-holdings-restore.mjs";

/** The page's source, read as text (as signpage-withdraw-handoff names its child: a path, no import). */
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

test("recorded good answer: this card's build, the FT list answering SIGN_HOST's origin: PASS", () => {
  const v = judge(A.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
});

test("recorded bad answer: SIGN_HOST before this card (release 123): FAIL, the missing CSP source and rebuild named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    "BAD SIGN_HOST's connect-src lacks the NEAR FT list https://api.fastnear.com: the page cannot ask a W's token hint",
    "BAD SIGN_HOST's /app.js carries no rebuild of the NEAR buy records: the build is before this card",
  ]);
});

test("planted bad answers: each FAIL, named", () => {
  one(planted((a) => (a.csp = a.csp.replace("connect-src ", `connect-src ${FT_LIST_TESTNET} `))), /names the testnet FT list/);
  one(planted((a) => (a.list.acao = "https://elsewhere.example")), /CORS allows/);
  one(planted((a) => (a.list.body.account_id = "someone.near")), /not the asked account's list/);
  one(planted((a) => (a.list.body.tokens = Array.from({ length: HINTS_MAX + 1 }, () => ({ contract_id: "a.near" })))), /above the page's 64/);
  one(planted((a) => (a.list.body.tokens = [{ contract_id: "NOT AN ID" }])), /a row the page refuses/);
  one(planted((a) => (a.list.status = 503)), /HTTP 503/);
  one(planted((a) => (a.appSha384 = "sha384-AAAA")), /is not the one its index.html pins/);
});

test("the check judges by the page's own constants", () => {
  const src = readFileSync(PAGE_SRC, "utf8");
  assert.ok(src.includes(`export const NEAR_FT_LIST: Readonly<Record<NearNetwork, string>> = Object.freeze({ mainnet: "${FT_LIST}", testnet: "${FT_LIST_TESTNET}" });`));
  assert.ok(src.includes(`export const NEAR_FT_HINTS_MAX = ${HINTS_MAX};`));
  assert.ok(src.includes(`export const NEAR_HOLDINGS_EMPTY_KEY = "${EMPTY_KEY}";`));
});
