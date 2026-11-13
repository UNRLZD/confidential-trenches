// node --test scripts/live-checks/chart-candles-never-429.test.mjs: the live check's verdict replays recorded runs
// (chart-candles-never-429.answers.json; its _note says where each was read): the good answer passes and the bad one
// fails, and planted changes to the good one fail by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ANSWER_MS, BONK, firstListed, judge, read, shapeOf, VIEWERS, PROXY_VIEWERS } from "./chart-candles-never-429.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "chart-candles-never-429.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: every chart read 200 inside the bound, filling while GeckoTerminal had no call, every 1Click list read 200", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(A.good.charts.every((c) => c.viewers.length === VIEWERS));
  assert.equal(A.good.proxy.length, PROXY_VIEWERS);
});

test("the recorded bad answer (6de76338d) fails: each chart's 429s and the list's 429s named", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.deepEqual(bad(r).map((l) => l.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/, "<mint>")), ["BAD solana <mint>: 6 of 6 reads answered 429", "BAD solana <mint>: 6 of 6 reads answered 429", "BAD 1Click's token list read 12 times at once from one address: 5 answered 200, 7 answered 429 (want 12 and 0)"]);
});

test("planted on the good answer: a 429, a read past the bound, another failed read, a list 429, a missing viewer and no BONK each fail by name", () => {
  let r = edit((run) => Object.assign(run.charts[0].viewers[2][3], { status: 429, body: '{"error":{"code":"rate_limited"}}', bars: undefined, filling: undefined }));
  assert.deepEqual(bad(r), [`BAD solana ${BONK}: 1 of 90 reads answered 429`]);
  r = edit((run) => (run.charts[1].viewers[0][0].ms = ANSWER_MS + 1));
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /: 1 of 90 reads took past 8000 ms/);
  r = edit((run) => Object.assign(run.charts[0].viewers[0][0], { status: 503, body: '{"error":{"code":"upstream"}}', bars: undefined, filling: undefined }));
  assert.deepEqual(bad(r), [`BAD solana ${BONK}: 503 {"error":{"code":"upstream"}}`]);
  r = edit((run) => (run.proxy[4] = { status: 429, ms: 3 }));
  assert.match(bad(r)[0], /11 answered 200, 1 answered 429/);
  r = edit((run) => run.charts[0].viewers.pop());
  assert.deepEqual(bad(r), [`BAD solana ${BONK}: 5 viewer(s) (want 6)`]);
  r = edit((run) => run.charts.shift());
  assert.match(bad(r)[0], /^BAD 1 chart\(s\) opened, BONK's among them/);
});

test("a chart still filling at the span's end is printed, not judged: GeckoTerminal's capacity, the page's loading state", () => {
  const r = judge(A.good);
  assert.ok(r.lines.some((l) => /^ {4}solana .*: 0 of 6 viewers drawn with bars inside 75 s, 90 filling read\(s\) on the way$/.test(l)), r.lines.join("\n"));
});

test("the reads: answers as the page reads them, the lists' first rows, and a viewer reading a filling chart again until bars", async () => {
  assert.deepEqual(shapeOf('{"tf":"15m","candles":[],"filling":true,"src":"chain","as_of_ms":1}'), { bars: 0, filling: true });
  assert.deepEqual(shapeOf('{"tf":"1h","candles":[],"src":"chain","as_of_ms":1}'), { bad: "not a 15m candles answer" });
  assert.equal(firstListed(JSON.stringify({ lists: { trending_1h: [{ token: "x" }, { token: BONK }] } }), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/), BONK);
  let n = 0;
  const fetchFn = async (url, init) => {
    if (url.includes("/v1/proxy/")) return new Response('{"ok":1}', { status: 200 });
    if (url.includes("/lists")) return new Response('{"lists":{}}', { status: 200 });
    n++;
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    return new Response(JSON.stringify({ tf: "15m", candles: n > VIEWERS ? [[1, "1", "1", "1", "1", "1"]] : [], ...(n > VIEWERS ? {} : { filling: true }), src: "chain", as_of_ms: 1 }), { status: 200 });
  };
  const run = await read("http://helper.test", fetchFn, async () => {});
  assert.equal(run.charts.length, 1, "BONK alone when the lists name no token");
  assert.ok(run.charts[0].viewers.every((v) => v.length === 2 && v[1].bars === 1), JSON.stringify(run.charts[0].viewers));
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
});
