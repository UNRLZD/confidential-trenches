// node --test scripts/live-checks/app-a2-e2e.test.mjs: the live check's verdict replays recorded runs
// (app-a2-e2e.answers.json), each read on 9 Nov 21:40Z from the deployed helper by app-a2-e2e.mjs collect():
//   good: both reads from the shipped origins: 200, CORS for APP_HOST and SIGN_HOST, the stub's fields, a blockhash: PASS;
//   bad:  the same reads from https://example.com (--as), an origin the helper does not serve: no CORS on either: FAIL.
// Planted from the good run: a field added to or dropped from the market answer, a status that is not 200, no blockhash.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, STUB_SHAPE } from "./app-a2-e2e.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./app-a2-e2e.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD")).join("\n");
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: both reads from the shipped origins, in the stub's shape: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.ok(v.ok, bad(v));
});

test("recorded bad answer: an origin the helper does not serve gets no CORS on either read: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.match(bad(v), /market token CORS for APP_HOST: none/);
  assert.match(bad(v), /devnet RPC CORS for SIGN_HOST: none/);
});

test("the stub's shape is the run's fixture: a row and a risk the token page draws from", () => {
  assert.ok(STUB_SHAPE.top.includes("row") && STUB_SHAPE.top.includes("risk"));
  assert.ok(STUB_SHAPE.row.includes("price_usd") && STUB_SHAPE.row.includes("launchpad"));
});

test("a field the helper adds or drops fails, naming it", () => {
  let v = mut((r) => r.market.shape.row.push("zz_new"));
  assert.equal(v.ok, false);
  assert.match(bad(v), /row fields as the run's stub: \+zz_new/);
  v = mut((r) => (r.market.shape.risk = r.market.shape.risk.filter((k) => k !== "honeypot")));
  assert.equal(v.ok, false);
  assert.match(bad(v), /risk fields as the run's stub: -honeypot/);
  assert.equal(mut((r) => (r.market.shape = null)).ok, false);
});

test("a status that is not 200, no blockhash or an error fails", () => {
  assert.equal(mut((r) => (r.market.status = 502)).ok, false);
  assert.equal(mut((r) => (r.devnet.status = 429)).ok, false);
  assert.equal(mut((r) => (r.devnet.blockhash = false)).ok, false);
  assert.equal(mut((r) => (r.error = "fetch failed")).ok, false);
});
