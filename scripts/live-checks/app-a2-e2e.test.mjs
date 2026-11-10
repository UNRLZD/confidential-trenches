// node --test scripts/live-checks/app-a2-e2e.test.mjs: the live check's verdict replays recorded runs
// (app-a2-e2e.answers.json), each read on 10 Nov 21:29Z from the deployed APP_HOST (main 1cc9d048) and helper by
// app-a2-e2e.mjs collect():
//   good: APP_HOST's token route and its script with every mark the run drives; the helper's reads from the shipped
//         origins: 200, CORS for APP_HOST and SIGN_HOST, the stub's fields, a blockhash: PASS;
//   bad:  the helper's reads from https://example.com (--as), an origin the helper does not serve: no CORS on either: FAIL.
// Planted from the good run: a mark the run drives gone from the scripts, APP_HOST framed by another origin or its
// connect-src without the helper, a field added to or dropped from the market answer, a status that is not 200, no
// blockhash.
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

test("APP_HOST: a mark the run drives gone, a wider frame-ancestors, a connect-src without the helper, or no script fails", () => {
  let v = mut((r) => r.app.js.forEach((f) => (f.marks["sell-cta"] = 0)));
  assert.equal(v.ok, false);
  assert.match(bad(v), /lack the run's marks: sell-cta/);
  v = mut((r) => (r.app.csp = r.app.csp.replace("frame-ancestors https://confidential.unrealized.trade", "frame-ancestors https://confidential.unrealized.trade https://evil.example")));
  assert.equal(v.ok, false);
  assert.match(bad(v), /framed only by SIGN_HOST/);
  v = mut((r) => (r.app.csp = r.app.csp.replace("connect-src 'self' https://ct-api.unrealized.trade ", "connect-src 'self' ")));
  assert.equal(v.ok, false);
  assert.match(bad(v), /connect-src names the helper/);
  assert.equal(mut((r) => (r.app.js = [])).ok, false);
  assert.equal(mut((r) => (r.app.status = 404)).ok, false);
});

test("the helper's devnet RPC giving no answer is INCONCLUSIVE, never PASS; with a wrong answer elsewhere it is FAIL", () => {
  let v = mut((r) => (r.devnet = { status: 429, cors: null, blockhash: false, noAnswer: "ct-api.unrealized.trade HTTP 429: 429 Too Many Requests" }));
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.equal(v.ok, false);
  v = mut((r) => {
    r.devnet = { status: null, cors: null, blockhash: false, noAnswer: "ct-api.unrealized.trade: no answer (TimeoutError)" };
    r.market.status = 502;
  });
  assert.equal(v.verdict, "FAIL");
  assert.equal(judge(ANSWERS.good).verdict, "PASS");
  assert.equal(judge(ANSWERS.bad).verdict, "FAIL");
});
