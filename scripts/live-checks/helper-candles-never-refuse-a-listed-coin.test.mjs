// node --test scripts/live-checks/helper-candles-never-refuse-a-listed-coin.test.mjs: the live check's verdict replays
// recorded runs (helper-candles-never-refuse-a-listed-coin.answers.json; its _note says where each was read): the good
// answer passes and the bad one fails, and planted changes to the good one fail by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { coinsOf, judge, LIMIT, read, shapeOf, TAPE_WAIT_MS, TAPES, tapeOf, TF, WAVE, WAVE_GAP_MS } from "./helper-candles-never-refuse-a-listed-coin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-candles-never-refuse-a-listed-coin.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: every listed Solana coin off pump.fun charted at the page's first tf, and MOW's and DEGEN's tapes our own reads", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.tf, "15m");
  assert.ok(A.good.reads.length >= 70 && A.good.reads.every((x) => x.status === 200 && x.bars > 0));
  assert.deepEqual(A.good.tapes.map((t) => [t.name, t.src, t.trades > 0]), [["MOW", "chain", true], ["DEGEN", "chain", true]]);
});

test("the recorded bad answer (the deployed helper at 23:42Z on 15 Nov) fails: Solana 145, Base 35 and Robinhood 14 listed coins refused, and MOW's tape GeckoTerminal's", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const refused = (chain) => Number(/ (\d+) refused/.exec(r.lines.find((l) => l.startsWith(`BAD ${chain}: `)) ?? "")?.[1]);
  assert.deepEqual([refused("solana"), refused("base"), refused("robinhood")], [145, 35, 14], r.lines.slice(-3).join("\n"));
  assert.ok(bad(r).some((l) => /^BAD robinhood MOW tape: \d+ trades, src geckoterminal/.test(l)), r.lines.join("\n"));
});

test("planted on the good answer's tapes: none read, an empty tape, a vendor's tape and a 503 each fail by name", () => {
  let r = edit((run) => delete run.tapes);
  assert.match(bad(r)[0], /^BAD no tape read$/);
  r = edit((run) => Object.assign(run.tapes[0], { trades: 0, filling: false }));
  assert.match(bad(r)[0], /^BAD robinhood MOW tape: 0 trades, src chain/);
  r = edit((run) => Object.assign(run.tapes[1], { src: "geckoterminal" }));
  assert.match(bad(r)[0], /^BAD base DEGEN tape: \d+ trades, src geckoterminal/);
  r = edit((run) => Object.assign(run.tapes[1], { status: 503, body: "", trades: undefined }));
  assert.match(bad(r)[0], /^BAD base DEGEN tape: 503/);
});

test("a tape read as the page reads it: again every 3 s while filling, TAPE_WAIT_MS at most", async () => {
  assert.deepEqual(TAPES.map((t) => t.name), ["MOW", "DEGEN"]);
  let n = 0;
  const waits = [];
  const fetchFn = async (url) => {
    assert.match(url, /\/v1\/market\/trades\?chain=robinhood&token=0x0b7c6c13\w+&limit=50$/);
    n++;
    return new Response(JSON.stringify({ trades: n < 3 ? [] : [{}], src: "chain", ...(n < 3 ? { filling: true } : {}) }), { status: 200 });
  };
  const t = await tapeOf("https://helper.test", TAPES[0], fetchFn, async (ms) => void waits.push(ms));
  assert.deepEqual([t.trades, t.filling, t.waited_ms, waits], [1, false, 6_000, [3_000, 3_000]]);
  const stuck = await tapeOf("https://helper.test", TAPES[0], async () => new Response('{"trades":[],"src":"chain","filling":true}', { status: 200 }), async () => undefined);
  assert.equal(stuck.waited_ms, TAPE_WAIT_MS);
});

test("planted on the good answer: a filling chart, a 429, a 503, unreadable lists and an EVM coin with a pool but no bars each fail by name; a Solana coin with no pool (404, or no bars and no filling) is not judged", () => {
  let r = edit((run) => Object.assign(run.reads[0], { bars: 0, filling: true }));
  assert.match(bad(r)[0], /^BAD solana \S+: 0 bars, filling$/);
  r = edit((run) => Object.assign(run.reads[1], { status: 429, body: '{"error":{"code":"rate_limited"}}' }));
  assert.match(bad(r)[0], /^BAD solana \S+: 429 \{"error"/);
  r = edit((run) => Object.assign(run.reads[2], { status: 503, body: "" }));
  assert.match(bad(r)[0], /^BAD solana \S+: 503$/);
  r = edit((run) => (run.lists.solana = { status: 503, coins: null }));
  assert.match(bad(r)[0], /^BAD solana: lists answered 503/);
  r = edit((run) => {
    run.chains = ["solana", "base"];
    run.lists.base = { status: 200, coins: 1 };
    run.reads.push({ chain: "base", address: `0x${"ab".repeat(20)}`, pool: true, status: 200, bars: 0, filling: false, src: "chain" });
  });
  assert.match(bad(r)[0], /^BAD base 0x(ab){20}: 0 bars, the lists name its pool$/);
  r = edit((run) => {
    Object.assign(run.reads[0], { status: 404, body: '{"error":{"code":"not_found"}}' });
    Object.assign(run.reads[1], { bars: 0, filling: false });
  });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.at(-1), /2 with no pool, 0 refused/);
  assert.equal(judge({ chains: [], lists: {}, reads: [] }).ok, false, "no chain read");
});

test("the reads: every listed coin once at the page's tf and limit, in waves under one client's window", async () => {
  assert.equal(TF, "15m");
  assert.equal(LIMIT, 500);
  assert.ok(WAVE <= 100 && WAVE_GAP_MS >= 10_000);
  const B58 = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const S = (i) => `${"1".repeat(40)}${B58[Math.floor(i / B58.length)]}${B58[i % B58.length]}`;
  assert.deepEqual(coinsOf("solana", JSON.stringify({ lists: { a: [{ token: S(1) }, { token: S(1) }, { token: "x" }], b: [{ token: S(2) }] } })), [{ address: S(1), pool: false }, { address: S(2), pool: false }]);
  assert.deepEqual(coinsOf("base", JSON.stringify({ lists: { a: [{ token: `0x${"cd".repeat(20)}` }] }, pools: { [`0x${"cd".repeat(20)}`]: "0x1" } })), [{ address: `0x${"cd".repeat(20)}`, pool: true }]);
  assert.equal(coinsOf("solana", "[]"), null);
  assert.deepEqual(shapeOf('{"tf":"15m","candles":[[1]],"src":"chain","as_of_ms":1}'), { bars: 1, filling: false, src: "chain", as_of_ms: 1 });
  const rows = Array.from({ length: WAVE + 5 }, (_, i) => ({ token: S(i) }));
  const asked = [];
  const waits = [];
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    if (url.includes("/lists")) return new Response(JSON.stringify({ lists: { trending: rows } }), { status: 200 });
    if (url.includes("/trades")) return new Response('{"trades":[{}],"src":"chain"}', { status: 200 });
    asked.push(url);
    return new Response('{"tf":"15m","candles":[[1,"1","1","1","1","0"]],"src":"chain","as_of_ms":1}', { status: 200 });
  };
  const run = await read("https://helper.test", ["solana"], fetchFn, async (ms) => void waits.push(ms));
  assert.equal(asked.filter((u) => u.includes("/candles")).length, WAVE + 5);
  assert.ok(asked.every((u) => u.includes("tf=15m&limit=500")));
  assert.equal(run.tapes.length, TAPES.length);
  assert.deepEqual(waits, [WAVE_GAP_MS], "two waves, one gap");
  assert.equal(judge(run).ok, true);
});
