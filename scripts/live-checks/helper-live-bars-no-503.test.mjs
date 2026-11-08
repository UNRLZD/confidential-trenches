// node --test scripts/live-checks/helper-live-bars-no-503.test.mjs: the live check's verdict replays recorded runs
// (helper-live-bars-no-503.answers.json; its _note says where each was read): the good answer passes and the bad one
// fails, and planted changes to the good one fail by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELD_MIN, judge, read, READS, shapeOf, TOKENS, tokensOf } from "./helper-live-bars-no-503.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-live-bars-no-503.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: 100 live reads of held Base tokens, every one 200 with its bars, the 503 count and the ages printed", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.live.length, READS);
  assert.match(r.lines.at(-1), /^ {4}100 of 100 live reads 200, 0 answered 503 \(p50 \d+ ms, p95 \d+ ms; age p50 -?\d+ ms, max -?\d+ ms\)$/);
});

test("the recorded bad answer fails, each 503 of a held token named", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  const n503 = A.bad.live.filter((a) => a.status === 503).length;
  assert.ok(n503 > 0, "the bad answer holds a 503");
  assert.equal(bad(r).filter((l) => /^BAD live read 0x[0-9a-f]{40}: 503 /.test(l)).length, n503, bad(r).join("\n"));
  assert.match(r.lines.at(-1), new RegExp(`, ${n503} answered 503 `));
});

test("planted on the good answer: a 503, a 429, an empty 200, a held read of a token not held, too few held, too few reads and failed lists each fail", () => {
  let r = edit((run) => Object.assign(run.live[17], { status: 503, body: '{"error":{"code":"upstream"}}', bars: undefined, ageMs: undefined }));
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /^BAD live read 0x[0-9a-f]{40}: 503 \{"error":\{"code":"upstream"\}\} in \d+ ms$/);
  assert.match(r.lines.at(-1), /99 of 100 live reads 200, 1 answered 503/);
  r = edit((run) => Object.assign(run.live[3], { status: 429, body: '{"error":{"code":"rate_limited"}}', bars: undefined, ageMs: undefined }));
  assert.match(bad(r)[0], / 429 /);
  r = edit((run) => (run.live[4].bars = 0));
  assert.match(bad(r)[0], / 200 0 bars /);
  r = edit((run) => (run.live[5].address = `0x${"ab".repeat(20)}`));
  assert.match(bad(r)[0], /not a held token/);
  r = edit((run) => {
    // HELD_MIN - 1 tokens held, every other first read 503
    let k = 0;
    for (const f of run.first) if (!(f.status === 200 && f.bars > 0 && k++ < HELD_MIN - 1)) Object.assign(f, { status: 503, body: "{}", bars: undefined });
  });
  assert.ok(bad(r).some((l) => new RegExp(`^BAD ${HELD_MIN - 1} tokens held`).test(l)), r.lines.join("\n"));
  r = edit((run) => run.live.pop());
  assert.deepEqual(bad(r), [`BAD 99 live reads (limit 2) made (${READS})`]);
  r = edit((run) => Object.assign(run, { lists: { status: 503, ms: 10, tokens: 0 }, first: [], live: [] }));
  assert.equal(r.ok, false);
  assert.match(bad(r)[0], /^BAD GET \/v1\/market\/lists\?chain=base answers 503/);
});

test("tokensOf takes Trending 1h, then 5m, then New, each address once, at most TOKENS, and refuses a non-address; shapeOf takes only a 15m candle answer", () => {
  const a = (i) => `0x${i.toString(16).padStart(40, "0")}`;
  const t = tokensOf(JSON.stringify({ lists: { trending_1h: [{ token: a(1) }, { token: "0xBAD" }, { token: a(2) }], trending_5m: [{ token: a(2) }, { token: a(3) }], new: Array.from({ length: 20 }, (_, i) => ({ token: a(10 + i) })) } }));
  assert.equal(t.length, TOKENS);
  assert.deepEqual(t.slice(0, 4), [a(1), a(2), a(3), a(10)]);
  assert.deepEqual(tokensOf("not json"), []);
  const bar = [1, "1", "1", "1", "1", "0"];
  assert.deepEqual(shapeOf(JSON.stringify({ tf: "15m", candles: [bar, bar], src: "chain", as_of_ms: 5 })), { bars: 2, asOfMs: 5 });
  assert.deepEqual(shapeOf(JSON.stringify({ tf: "1m", candles: [bar], src: "chain", as_of_ms: 5 })), { bad: 'tf "1m"' });
  assert.deepEqual(shapeOf(JSON.stringify({ tf: "15m", candles: [[1, "1"]], src: "chain", as_of_ms: 5 })), { bad: "no candles list" });
  assert.deepEqual(shapeOf(JSON.stringify({ tf: "15m", candles: [], src: "chain" })), { bad: "no as_of_ms" });
  assert.deepEqual(shapeOf("<html>"), { bad: "not JSON" });
});

test("read() asks the lists with the app's Origin, reads each token once in full, then READS live reads (limit 2) of the held ones only, and keeps no 200 body", async () => {
  const asked = [];
  const a = (i) => `0x${i.toString(16).padStart(40, "0")}`;
  const bar = [1, "1", "1", "1", "1", "0"];
  const fetchFn = async (url, init) => {
    asked.push([url, init.headers.origin]);
    if (url.includes("/v1/market/lists")) return new Response(JSON.stringify({ lists: { trending_1h: Array.from({ length: 5 }, (_, i) => ({ token: a(i + 1) })) } }), { status: 200 });
    if (url.includes(a(5))) return new Response('{"error":{"code":"upstream"}}', { status: 503 });
    return new Response(JSON.stringify({ tf: "15m", candles: url.includes("limit=2") ? [bar, bar] : [bar, bar, bar], src: "chain", as_of_ms: Date.now() }), { status: 200 });
  };
  const run = await read("https://helper.test", fetchFn, 0);
  assert.equal(asked.length, 1 + 5 + READS);
  assert.ok(asked.every(([, o]) => o === "https://ct-app.unrealized.trade"));
  assert.ok(asked.slice(6).every(([u]) => u.endsWith("&tf=15m&limit=2") && !u.includes(a(5))), "live reads of held tokens only");
  assert.ok(run.live.every((x) => !("body" in x) && x.bars === 2));
  assert.equal(run.first.find((f) => f.address === a(5)).status, 503);
  const r = judge(run);
  assert.equal(r.ok, true, r.lines.join("\n"));
});
