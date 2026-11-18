// node --test scripts/live-checks/helper-candles-keyed-gt.test.mjs: the live check's verdict replays recorded runs
// (helper-candles-keyed-gt.answers.json; its _note says where each was read): the good answer passes and the bad one
// fails, and planted changes to the good one fail by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIVE_TRADES_5M, BONK, firstListed, FULL_BARS, judge, keyed, ours, read, READ_EVERY_MS, shapeOf, SPAN_MS } from "./helper-candles-keyed-gt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-candles-keyed-gt.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: BONK's and Base DRB's charts full, src chain,coingecko", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.charts.map((c) => [c.reads.at(-1).src, c.reads.at(-1).bars >= FULL_BARS]), [["chain,coingecko", true], ["chain,coingecko", true]]);
});

test("the recorded bad answer (live run 43776130630) fails on the short chart alone: Base DRB 3 bars, src chain, after 9 reads; BONK's full chart of our reads and GeckoTerminal's history passes", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD base 0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2: 3 bars, src chain after 9 read\(s\)/);
});

test("card held-chart-names-its-bars: the recorded held BONK (live 07:02Z, as run 43816654565) passes: off the lists its chart is GeckoTerminal's alone once held (KEYED_COLD_ONLY), 500 bars named geckoterminal; a listed chart named geckoterminal alone still fails", () => {
  const r = judge(A.held_bonk);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.held_bonk.charts.map((c) => [c.chain, c.reads.at(-1).src, c.reads.at(-1).bars]), [["solana", "geckoterminal", 500], ["base", "chain,coingecko", 500]]);
  const run = structuredClone(A.held_bonk);
  run.charts[1].reads.at(-1).src = "geckoterminal";
  assert.match(bad(judge(run))[0] ?? "", /^BAD base \S+: 500 bars, src geckoterminal/);
  // off the lists, still only the three sources, and still full
  for (const f of [{ src: "dexscreener" }, { src: "geckoterminal,dexscreener" }, { bars: FULL_BARS - 1 }, { filling: true }]) {
    const o = structuredClone(A.held_bonk);
    Object.assign(o.charts[0].reads.at(-1), f);
    assert.deepEqual(bad(judge(o)).map((l) => l.split(":")[0]), [`BAD solana ${BONK}`], JSON.stringify(f));
  }
});

test("the bar re-cut, not loosened: the old bar's bad answer (no key, both 500 bars of our reads and GeckoTerminal's history) is a full chart now; an empty, short, filling or vendor-only chart still fails", () => {
  assert.equal(judge(A.old_bar_bad).ok, true, judge(A.old_bar_bad).lines.join("\n"));
  const last = (f) => edit((run) => Object.assign(run.charts[1].reads[run.charts[1].reads.length - 1], f));
  assert.match(bad(last({ bars: 0 }))[0], /^BAD base \S+: 0 bars/);
  assert.match(bad(last({ bars: FULL_BARS - 1 }))[0], new RegExp(`^BAD base \\S+: ${FULL_BARS - 1} bars`));
  assert.match(bad(last({ filling: true }))[0], /^BAD base \S+: 500 bars, filling/);
  assert.match(bad(last({ src: "geckoterminal" }))[0], /^BAD base \S+: 500 bars, src geckoterminal/);
  assert.match(bad(last({ src: "chain,dexscreener" }))[0], /src chain,dexscreener/);
  assert.equal(ours("coingecko"), true);
  assert.equal(ours("chain"), true);
  assert.equal(ours("chain,geckoterminal"), true);
  assert.equal(ours("geckoterminal"), false);
  assert.equal(ours(""), false);
});

test("planted on the good answer: GeckoTerminal's alone on the listed chart, no bars, a 503, no Base chart and a chart other than BONK each fail by name", () => {
  let r = edit((run) => (run.charts[1].reads.at(-1).src = "geckoterminal"));
  assert.deepEqual(bad(r).map((l) => l.split(" ").slice(0, 2).join(" ")), ["BAD base"]);
  // card held-chart-names-its-bars: BONK off the lists, held, is GeckoTerminal's alone, and passes
  r = edit((run) => (run.charts[0].reads.at(-1).src = "geckoterminal"));
  assert.equal(bad(r).length, 0, r.lines.join("\n"));
  r = edit((run) => (run.charts[1].reads.at(-1).src = "chain,geckoterminal"));
  assert.equal(bad(r).length, 0, "our bars with GeckoTerminal's history before them: full");
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

test("the reads: a chart read again until it is full, within the span; the lists' first Base row", async () => {
  assert.deepEqual(shapeOf('{"tf":"1m","candles":[[1]],"src":"coingecko","as_of_ms":1}'), { bars: 1, src: "coingecko", filling: false });
  assert.deepEqual(shapeOf('{"tf":"15m","candles":[],"src":"chain","as_of_ms":1}'), { bad: "not a 1m candles answer" });
  const T = `0x${"ab".repeat(20)}`;
  assert.equal(firstListed(JSON.stringify({ lists: { trending_1h: [{ token: "x", buys_5m: 9 }, { token: T, buys_5m: 3, sells_5m: 2 }] } }))?.token, T);
  const n = { solana: 0, base: 0 };
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    if (url.includes("/lists")) return new Response(JSON.stringify({ lists: { trending_1h: [{ token: T, buys_5m: 5, sells_5m: 0 }] } }), { status: 200 });
    const chain = url.includes("chain=solana") ? "solana" : "base";
    n[chain]++;
    // a short chart filling twice, then the full one
    const full = n[chain] > 2;
    return new Response(JSON.stringify({ tf: "1m", candles: Array.from({ length: full ? 500 : 3 }, (_, i) => [i, "1", "1", "1", "1", "1"]), src: chain === "solana" ? "coingecko" : "chain,coingecko", ...(full ? {} : { filling: true }), as_of_ms: 1 }), { status: 200 });
  };
  const waits = [];
  const run = await read("http://helper.test", fetchFn, async (ms) => void waits.push(ms));
  assert.deepEqual(run.charts.map((c) => [c.chain, c.address, c.reads.length]), [["solana", BONK, 3], ["base", T, 3]]);
  assert.ok(waits.every((w) => w === READ_EVERY_MS) && READ_EVERY_MS * 3 <= SPAN_MS);
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
});

// card helper-candles-full-after-tape-behind: the Base pick is a coin that trades every minute
test("the recorded active pick (Mac, 18 Nov 07:22Z) passes; the recorded quiet pick (live run 44249482613, ANZ) fails on its short chart alone", () => {
  const good = judge(A.active_pick);
  assert.equal(good.ok, true, good.lines.join("\n"));
  assert.ok(A.active_pick.lists.pick.trades_5m >= ACTIVE_TRADES_5M && A.active_pick.lists.pick.row > 0, "row 0 was quiet and skipped");
  const r = judge(A.quiet_pick_bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.deepEqual(bad(r), [
    "BAD base 0xeec468333ccc16d4bf1cef497a56cf8c0aae4ca3: 84 bars, src chain,coingecko after 9 read(s) (chain,coingecko); want 100 bars or more, not filling, src our own reads or coingecko",
  ]);
});

/** The recorded quiet-then-hot rows as the helper sends them: each row's address (kept as coin) as its token. */
const QUIET_THEN_HOT = { lists: { trending_1h: A.lists_quiet_then_hot.lists.trending_1h.map(({ coin, ...r }) => ({ token: coin, ...r })) } };

test("the pick: the quiet-then-hot lists answer (read 18 Nov 07:17Z) skips ANZ for PROS; Trending 1h, then 5m, then New; under ACTIVE_TRADES_5M or a count that is not a whole number is skipped", () => {
  const L = QUIET_THEN_HOT;
  const [quiet, hot] = L.lists.trending_1h;
  assert.deepEqual([quiet.symbol, quiet.buys_5m + quiet.sells_5m, hot.symbol], ["ANZ", 0, "PROS"]);
  assert.deepEqual(firstListed(JSON.stringify(L)), { token: hot.token, list: "trending_1h", row: 1, trades_5m: hot.buys_5m + hot.sells_5m });
  assert.equal(firstListed(JSON.stringify({ lists: { trending_1h: [quiet] } })), null);
  const at = (buys_5m, sells_5m) => ({ token: hot.token, buys_5m, sells_5m });
  assert.equal(firstListed(JSON.stringify({ lists: { trending_1h: [at(ACTIVE_TRADES_5M - 1, 0)] } })), null);
  assert.equal(firstListed(JSON.stringify({ lists: { trending_1h: [at(ACTIVE_TRADES_5M - 2, 2)] } }))?.trades_5m, ACTIVE_TRADES_5M);
  for (const v of ["9", 2.5, -9, null, 1e20]) assert.equal(firstListed(JSON.stringify({ lists: { trending_1h: [at(v, 4)] } })), null, JSON.stringify(v));
  // Trending 1h's quiet rows, then Trending 5m's, then New's
  assert.deepEqual(firstListed(JSON.stringify({ lists: { new: [hot], trending_5m: [quiet], trending_1h: [quiet] } })), { token: hot.token, list: "new", row: 0, trades_5m: 68 });
  for (const body of ["", "{", '{"lists":null}', '{"lists":{"trending_1h":"x"}}']) assert.equal(firstListed(body), null, body);
});

test("a run on the quiet-then-hot lists charts PROS and names its row; lists of quiet rows only is its own BAD line, never a pass; a recorded quiet pick fails by name", async () => {
  const charts = (lists) => async (url) =>
    url.includes("/lists")
      ? new Response(JSON.stringify(lists), { status: 200 })
      : new Response(JSON.stringify({ tf: "1m", candles: Array.from({ length: 500 }, (_, i) => [i, "1", "1", "1", "1", "1"]), src: "chain,coingecko", as_of_ms: 1 }), { status: 200 });
  const L = QUIET_THEN_HOT;
  let run = await read("http://helper.test", charts(L), async () => {});
  assert.equal(run.charts[1].address, L.lists.trending_1h[1].token);
  assert.deepEqual(run.lists, { base: 200, pick: { list: "trending_1h", row: 1, trades_5m: 68 } });
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
  run = await read("http://helper.test", charts({ lists: { trending_1h: [L.lists.trending_1h[0]] } }), async () => {});
  assert.deepEqual([run.lists, run.charts[1].reads.length], [{ base: 200, pick: null }, 0]);
  assert.deepEqual(bad(judge(run)), ["BAD base: no active Base pick (no Trending 1h, 5m or New row with 5 or more trades in 5m)"]);
  // a lists answer that is not 200 still says so
  run = await read("http://helper.test", async (url) => (url.includes("/lists") ? new Response("", { status: 503 }) : charts(L)(url)), async () => {});
  assert.deepEqual(bad(judge(run)), ["BAD base: no chart read (Base's lists answered 503)"]);
  // planted on the recorded active pick: a pick under the bar, or none, fails by name
  for (const [p, want] of [
    [{ list: "trending_1h", row: 0, trades_5m: 0 }, /^BAD base 0x[0-9a-f]{40}: picked with 0 trades in 5m \(trending_1h row 0\); want 5 or more$/],
    [{ list: "trending_1h", row: 0 }, /^BAD base 0x[0-9a-f]{40}: picked with no trades in 5m/],
    [null, /^BAD base: no active Base pick/],
  ]) {
    const o = structuredClone(A.active_pick);
    o.lists.pick = p;
    assert.deepEqual(bad(judge(o)).map((l) => want.test(l)), [true], JSON.stringify(p));
  }
});
