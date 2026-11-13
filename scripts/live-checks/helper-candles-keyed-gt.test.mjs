// node --test scripts/live-checks/helper-candles-keyed-gt.test.mjs: the live check's verdict replays recorded runs
// (helper-candles-keyed-gt.answers.json; its _note says where each was read): the good answer passes and the bad one
// fails, and planted changes to the good one fail by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BONK, firstListed, judge, keyed, read, READ_EVERY_MS, shapeOf, SPAN_MS } from "./helper-candles-keyed-gt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-candles-keyed-gt.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: BONK's chart src coingecko and a Base pool's chain,coingecko, bars in each", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.charts.map((c) => c.reads.at(-1).src), ["coingecko", "chain,coingecko"]);
});

test("the recorded bad answer (the deployed helper, main b1b679c42, no key) fails: both charts GeckoTerminal's", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(bad(r).length, 2, r.lines.join("\n"));
  assert.ok(bad(r).every((l) => /src chain,geckoterminal after 9 read\(s\)/.test(l)), r.lines.join("\n"));
});

test("planted on the good answer: the keyless source, no bars, a 503, no Base chart and a chart other than BONK each fail by name", () => {
  let r = edit((run) => (run.charts[0].reads.at(-1).src = "geckoterminal"));
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), [`BAD solana ${BONK}`]);
  r = edit((run) => (run.charts[1].reads.at(-1).src = "chain,geckoterminal"));
  assert.equal(bad(r).length, 1);
  r = edit((run) => (run.charts[1].reads.at(-1).bars = 0));
  assert.match(bad(r)[0], /^BAD base 0x[0-9a-f]{40}: 0 bars, src chain,coingecko/);
  r = edit((run) => (run.charts[0].reads[run.charts[0].reads.length - 1] = { status: 503, ms: 9, body: '{"error":{"code":"upstream"}}' }));
  assert.match(bad(r)[0], /^BAD solana .*: 503 \{"error":\{"code":"upstream"\}\}/);
  r = edit((run) => Object.assign(run.charts[1], { address: null, reads: [] }));
  assert.match(bad(r)[0], /^BAD base: no chart read/);
  r = edit((run) => (run.charts[0].address = "So11111111111111111111111111111111111111112"));
  assert.match(bad(r)[0], /^BAD solana: So1+2 read, not BONK$/);
  // a src that only contains the word is not the keyed source
  assert.equal(keyed("coingeckoish"), false);
  assert.equal(keyed("chain,coingecko"), true);
});

test("the reads: a chart read again until it is keyed, within the span; the lists' first Base row", async () => {
  assert.deepEqual(shapeOf('{"tf":"1m","candles":[[1]],"src":"coingecko","as_of_ms":1}'), { bars: 1, src: "coingecko", filling: false });
  assert.deepEqual(shapeOf('{"tf":"15m","candles":[],"src":"chain","as_of_ms":1}'), { bad: "not a 1m candles answer" });
  const T = `0x${"ab".repeat(20)}`;
  assert.equal(firstListed(JSON.stringify({ lists: { trending_1h: [{ token: "x" }, { token: T }] } })), T);
  const n = { solana: 0, base: 0 };
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    if (url.includes("/lists")) return new Response(JSON.stringify({ lists: { trending_1h: [{ token: T }] } }), { status: 200 });
    const chain = url.includes("chain=solana") ? "solana" : "base";
    n[chain]++;
    // a held keyless answer twice, then the keyed one
    return new Response(JSON.stringify({ tf: "1m", candles: [[1, "1", "1", "1", "1", "1"]], src: n[chain] > 2 ? (chain === "solana" ? "coingecko" : "chain,coingecko") : "geckoterminal", as_of_ms: 1 }), { status: 200 });
  };
  const waits = [];
  const run = await read("http://helper.test", fetchFn, async (ms) => void waits.push(ms));
  assert.deepEqual(run.charts.map((c) => [c.chain, c.address, c.reads.length]), [["solana", BONK, 3], ["base", T, 3]]);
  assert.ok(waits.every((w) => w === READ_EVERY_MS) && READ_EVERY_MS * 3 <= SPAN_MS);
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
});
