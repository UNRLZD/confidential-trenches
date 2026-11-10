// node --test scripts/live-checks/market-data-push.test.mjs: the live check replays recorded answers
// (market-data-push.answers.json). good: the card's helper run locally: PASS. bad_any_origin: that helper with its push
// Origin check admitting every Origin, so "*", https://example.com, SIGN_HOST, "null" and no Origin are upgraded and
// sent the tape: FAIL. bad_pre_card: the deployed helper before the card, with no push socket: FAIL. Each planted bad
// answer is the good one with one fault: only "*" upgraded, only example.com upgraded, a refusal carrying an allow
// header, a refused Origin not tried, the socket sending no tape, the socket emptier than the polled route, a 101 with a
// wrong accept key, a tape row not of the shape: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, judge, REFUSED } from "./market-data-push.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "market-data-push.answers.json"), "utf8"));
const clone = (v) => structuredClone(v);
const TAPE = JSON.stringify({ trades: [{ t_ms: 1794257000000, side: "b", usd: "12.5", amt: "1000", trader: null, tx: "5tx" }], src: "chain", as_of_ms: 1794257000001 });

/** The good answer with Origin `origin` upgraded and sent the tape. */
function accepted(origin) {
  const a = clone(A.good);
  const r = a.refused.find((x) => x.origin === origin);
  Object.assign(r, { status: 101, acceptOk: true, frame: a.app.frame, frames: 1 });
  return a;
}

test("the recorded answers are what the note says", () => {
  assert.equal(A.good.app.status, 101);
  assert.deepEqual(A.good.refused.map((r) => r.origin), REFUSED);
  assert.ok(A.bad_any_origin.refused.every((r) => r.status === 101), "the any-Origin helper upgraded every refused Origin");
  assert.equal(A.bad_pre_card.app.status, 404, "the pre-card helper has no push socket");
});

test("recorded good answer (the card's helper): PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer (a helper admitting every Origin, '*' and example.com included): FAIL", () => {
  const r = judge(A.bad_any_origin);
  assert.equal(r.ok, false);
  for (const o of ['"*"', '"https://example.com"', '"https://confidential.unrealized.trade"', '"null"', "no Origin"]) assert.ok(r.lines.some((l) => l.startsWith("BAD") && l.includes(o)), `${o} named BAD`);
});

test("recorded bad answer (the deployed helper before the card, no push socket): FAIL", () => {
  const r = judge(A.bad_pre_card);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD APP_HOST's handshake")));
});

test("planted: one refused Origin upgraded ('*', example.com, SIGN_HOST, 'null' or none) fails", () => {
  for (const o of REFUSED) assert.equal(judge(accepted(o)).ok, false, `${o} upgraded`);
});

test("planted: a refusal that carries Access-Control-Allow-Origin ('*' or the foreign origin) fails", () => {
  for (const v of ["*", "https://example.com", APP]) {
    const a = clone(A.good);
    a.refused[1].headers["access-control-allow-origin"] = v;
    assert.equal(judge(a).ok, false, v);
  }
});

test("planted: a refused Origin left untried fails", () => {
  const a = clone(A.good);
  a.refused = a.refused.filter((r) => r.origin !== "*");
  assert.equal(judge(a).ok, false);
});

test("planted: APP_HOST sent no tape, a wrong accept key, or a row not of the shape fails", () => {
  const none = clone(A.good);
  none.app.frame = null;
  assert.equal(judge(none).ok, false, "no frame");
  const key = clone(A.good);
  key.app.acceptOk = false;
  assert.equal(judge(key).ok, false, "accept key");
  const row = clone(A.good);
  row.held = 1;
  row.app.frame = JSON.stringify({ trades: [{ t_ms: "soon", side: "buy", tx: "x" }] });
  assert.equal(judge(row).ok, false, "row shape");
  const text = clone(A.good);
  text.app.frame = "<html>";
  assert.equal(judge(text).ok, false, "not JSON");
});

test("the socket is held to the polled route: a trade there and none pushed fails; one pushed passes", () => {
  const empty = clone(A.good);
  empty.held = 3;
  empty.app.frame = JSON.stringify({ trades: [], src: "chain", as_of_ms: 1 });
  assert.equal(judge(empty).ok, false, "emptier than the route");
  const full = clone(A.good);
  full.held = 3;
  full.app.frame = TAPE;
  assert.equal(judge(full).ok, true, judge(full).lines.join("\n"));
});

test("a row's side is the helper's word (06b Trades: \"b\" or \"s\"), the one the terminal reads; \"buy\" spelled out fails", () => {
  const long = clone(A.good);
  long.held = 1;
  long.app.frame = JSON.stringify({ trades: [{ t_ms: 1794257000000, side: "buy", usd: "12.5", amt: "1000", trader: null, tx: "5tx" }], src: "chain", as_of_ms: 1 });
  assert.equal(judge(long).ok, false);
  for (const side of ["b", "s"]) {
    const ok = clone(A.good);
    ok.held = 1;
    ok.app.frame = JSON.stringify({ trades: [{ t_ms: 1794257000000, side, usd: "12.5", amt: "1000", trader: null, tx: "5tx" }], src: "chain", as_of_ms: 1 });
    assert.equal(judge(ok).ok, true, side);
  }
});
