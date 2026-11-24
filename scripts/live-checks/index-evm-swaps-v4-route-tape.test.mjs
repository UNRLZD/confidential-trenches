// node --test scripts/live-checks/index-evm-swaps-v4-route-tape.test.mjs: the live check replays its recorded answers
// (index-evm-swaps-v4-route-tape.answers.json). bad_run_44942886709: live run 44942886709's tape of Base 0x86fb3335, its
// USDC side pool's rows while its cbBTC pool traded 214 swaps over the scan: FAIL by name. good_*: a helper with the
// card's change, the coin the scan picked and its whole third-quoted pool's tape: PASS. Made from the answers: a scan whose busiest third-quoted coin trades more in a v2 or v3 pool, whose pool is near
// a tie with the coin's other trading (Base 0x95669a65's two third-quoted pools, 5 against 14 swaps over 1,500 blocks and
// 65 against 53 over 12,000, read 21 Nov 23:4xZ), or with none at all, judges no coin (INCONCLUSIVE); a run that judged
// another coin than the scan picks, a tape from the vendor, or a tape short of one of the pool's swaps: each FAIL. The scan's reads go through provider-answer.mjs: a provider's 429 is left out while
// two others answer alike, and a scan every provider throttles judges nothing (INCONCLUSIVE), never FAIL.
// burst_run_45360090006: live run 45360090006's scan of Base WBTC, its WBTC/NVDAc v4 pool the busiest over 5 minutes
// of one bot's arbitrages, with burst_day, GeckoTerminal's 24 h list of WBTC's pools read 51 minutes later by the check's
// dayOf: that pool not its clear main pool, so WBTC is not judged (INCONCLUSIVE by name); as recorded, before the day was
// read, it was judged and failed. Made from it: the same scan whose pool leads the day is judged, its missing swaps FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";
import { candidates, DOMINANCE, GT, judge, leadsDay, pick, read, scan, unpriced } from "./index-evm-swaps-v4-route-tape.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const RPCS = ["https://a.example", "https://b.example", "https://c.example"];
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const POOL = `0x${"ab".repeat(32)}`;
const COIN = `0x${"11".repeat(20)}`;
const QUOTE = `0x${"22".repeat(20)}`;
const w = (a) => a.slice(2).padStart(64, "0");
/** Providers that answer as the chain does (one third-quoted pool, 4 swaps), `down` answering 429 to everything. */
const chain = (down) => async (url, o) => {
  if (down.includes(url)) return new Response("Too Many Requests", { status: 429 });
  const one = ({ id, method, params }) => {
    const p = params[0];
    if (method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: "0x3e8000" };
    if (method === "eth_getLogs" && p.address === PM) return { jsonrpc: "2.0", id, result: p.fromBlock === `0x${(0x3e8000 - 10 - 1_499).toString(16)}` ? [0, 1, 2, 3].map((i) => ({ transactionHash: `0x${String(i).repeat(64)}`, blockNumber: p.fromBlock, logIndex: `0x${i}`, topics: [p.topics[0], POOL], data: "0x" })) : [] };
    if (method === "eth_getLogs") return { jsonrpc: "2.0", id, result: [] };
    if (method === "eth_call") return { jsonrpc: "2.0", id, result: `0x${w(COIN)}${w(QUOTE)}${"0".repeat(64 * 3)}` };
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } };
  };
  const b = JSON.parse(o.body);
  return new Response(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b)), { status: 200 });
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "index-evm-swaps-v4-route-tape.answers.json"), "utf8"));
const BAD = A.bad_run_44942886709;
const GOOD = Object.entries(A).filter(([k]) => k.startsWith("good"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("bad_run_44942886709: the cbBTC pool's swaps are not on the tape, its USDC side pool's are: FAIL by name", () => {
  const v = judge(BAD);
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^BAD \d+ of \d+ swap transactions of the coin's busiest pool 0xc265b42f/.test(l)), v.lines.join("\n"));
});

test("the bad answer's own tape made whole (every swap of the cbBTC pool in its range on it) passes this check's rule", () => {
  const r = copy(BAD);
  const p = r.scan.pools.find((x) => x.id === r.pool);
  const tms = (b) => 1793901601000 + (b - 53556127) * 200;
  r.trades.body = JSON.stringify({ trades: [...p.txs].sort((a, b) => b[1] - a[1]).map(([tx, b]) => ({ t_ms: tms(b), tx })), src: "chain" });
  const v = judge(r);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
});

test("pick: a coin a v2 or v3 pool outtrades is never judged; a scan with no third-quoted coin judges none (INCONCLUSIVE)", () => {
  const r = copy(BAD);
  assert.deepEqual(pick(r.scan), { coin: r.coin, pool: r.pool });
  r.scan.elsewhere[r.coin] = { pool: `0x${"aa".repeat(20)}`, transfers: 999 };
  assert.equal(pick(r.scan), null);
  assert.equal(judge(r).verdict, "INCONCLUSIVE");
  const tie = copy(BAD);
  tie.scan.others[tie.coin] = Math.floor(tie.scan.pools.find((p) => p.id === tie.pool).n / DOMINANCE) + 1;
  assert.equal(pick(tie.scan), null, "a pool near a tie with the coin's other trading is not judged");
  tie.scan.others[tie.coin]--;
  assert.deepEqual(pick(tie.scan), { coin: tie.coin, pool: tie.pool });
  const none = copy(BAD);
  none.scan.pools = none.scan.pools.filter((p) => p.id !== none.pool);
  assert.equal(candidates(none.scan).length, 0);
  assert.equal(judge(none).verdict, "INCONCLUSIVE");
});

test("a run that judged another coin than the scan picks, or whose tape is the vendor's: FAIL", () => {
  const other = copy(BAD);
  other.coin = `0x${"bb".repeat(20)}`;
  assert.equal(judge(other).verdict, "FAIL");
  const vendor = copy(BAD);
  vendor.trades.headers["x-helper-source"] = "coingecko";
  assert.ok(judge(vendor).lines.some((l) => /^BAD trades: 200 coingecko/.test(l)));
});

for (const [name, run] of GOOD)
  test(`${name}: a helper with the card's change, the scan's coin on its third-quoted pool's whole tape: PASS; the tape short of the pool's newest swap: FAIL`, () => {
    const v = judge(run);
    assert.equal(v.verdict, "PASS", v.lines.join("\n"));
    const r = copy(run);
    const p = r.scan.pools.find((x) => x.id === r.pool);
    const keep = p.txs.filter(([, b]) => b <= r.scan.head - 120).sort((a, b) => b[1] - a[1])[0][0];
    const body = JSON.parse(r.trades.body);
    r.trades.body = JSON.stringify({ ...body, trades: body.trades.filter((t) => t.tx !== keep) });
    assert.equal(judge(r).verdict, "FAIL");
  });

test("a provider's 429 is left out, never judged: the two that answer alike read the scan", async () => {
  const s = await scan(chain([RPCS[0]]), RPCS);
  assert.equal(s.unread, undefined, s.unread);
  assert.equal(s.pools.length, 1);
  assert.deepEqual([s.pools[0].id, s.pools[0].n, s.pools[0].c0, s.pools[0].c1], [POOL, 4, COIN, QUOTE]);
});

test("a scan every provider but one throttles is unread: INCONCLUSIVE naming the no-answers, never FAIL (and the helper is never asked)", async () => {
  let asked = 0;
  const f = chain(RPCS.slice(0, 2));
  const run = await read("https://helper.example", async (u, o) => (u.startsWith("https://helper.example") && asked++, f(u, o)), RPCS);
  assert.equal(run.scan, null);
  const v = judge(run);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(asked, 0);
});

test("a coin whose quote traded against no USDC, WETH or ETH pool on Base in the scan (live run 44979250087: Base RALLY's pool quoted in ELEVATE, whose one USD market is on Ethereum) is judged on its status alone: 503 FAIL by name, 200 PASS; never judged on a tape no read can price", () => {
  const r = copy(BAD);
  const p = r.scan.pools.find((x) => x.id === r.pool);
  const quote = p.c0 === r.coin ? p.c1 : p.c0;
  r.scan.markets = { [quote]: null };
  assert.equal(pick(r.scan), null, "a coin whose quote has no market here is not judged on its tape");
  assert.deepEqual(unpriced(r.scan), { coin: r.coin, pool: r.pool, quote });
  const { coin, pool } = r;
  delete r.coin, delete r.pool, delete r.trades;
  r.unpriced = { coin, pool, trades: { status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' } };
  const v = judge(r);
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^BAD the coin 0x86fb3335\w+, whose quote \w+ has no market on Base .*: trades 503/.test(l)), v.lines.join("\n"));
  r.unpriced.trades = { status: 200, headers: { "x-helper-source": "chain" }, body: '{"trades":[],"src":"chain"}' };
  assert.equal(judge(r).verdict, "PASS", judge(r).lines.join("\n"));
  // a quote with a market read: the coin is judged on its whole tape, as before
  const m = copy(BAD);
  m.scan.markets = { [quote]: { pool: `0x${"cc".repeat(20)}`, venue: "v3" } };
  assert.deepEqual(pick(m.scan), { coin: m.coin, pool: m.pool });
  assert.equal(unpriced(m.scan), null);
  assert.equal(judge(m).verdict, "FAIL");
});

test("the scan reads a quote's market by its Transfers: a counterparty whose factory is a Base venue's and whose tokens are the quote and USDC; a quote with no transfer has none", async () => {
  const PARTY = `0x${"33".repeat(20)}`;
  const V3 = VENUES.base.v3[0];
  const base = chain([]);
  const withMarket = async (url, o) => {
    const b = JSON.parse(o.body);
    const one = (q) => {
      const p = q.params[0];
      if (q.method === "eth_getLogs" && p.address === QUOTE) return { jsonrpc: "2.0", id: q.id, result: [{ topics: [TOPIC.transfer, `0x${w(PARTY)}`, `0x${w(`0x${"44".repeat(20)}`)}`] }] };
      if (q.method === "eth_call" && p.to === PARTY) return { jsonrpc: "2.0", id: q.id, result: `0x${w({ "0xc45a0155": V3, "0x0dfe1681": VENUES.base.usd, "0xd21220a7": QUOTE }[p.data])}` };
      return null;
    };
    const mine = [b].flat().map(one);
    if (mine.every((x) => x === null)) return base(url, o);
    const rest = mine.some((x) => x === null) ? JSON.parse(await (await base(url, { ...o, body: JSON.stringify([b].flat()) })).text()) : [];
    const out = mine.map((x, i) => x ?? rest[i]);
    return new Response(JSON.stringify(Array.isArray(b) ? out : out[0]), { status: 200 });
  };
  const s = await scan(withMarket, RPCS);
  assert.equal(s.unread, undefined, s.unread);
  assert.deepEqual(s.markets[QUOTE], { pool: PARTY, venue: V3 });
  const none = await scan(chain([]), RPCS);
  assert.equal(none.markets[QUOTE], null);
});

const BURST = A.burst_run_45360090006;
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const NVDA_POOL = "0xc6406d4628b7a4657f28fad1bb4ac04d618766e3ace0080f8cf86cd1f9f32d5e";
const withDay = (run, day) => ({ ...copy(run), scan: { ...copy(run.scan), day: copy(day) } });

test("burst_run_45360090006: as recorded (no day read) it judged WBTC's WBTC/NVDAc pool and failed; with GeckoTerminal's day the pool is not WBTC's clear main pool: not judged, INCONCLUSIVE by name", () => {
  assert.deepEqual(pick(BURST.scan), { coin: WBTC, pool: NVDA_POOL });
  const was = judge(BURST);
  assert.equal(was.verdict, "FAIL", was.lines.join("\n"));
  assert.ok(was.lines.some((l) => /^BAD 4 of 13 swap transactions of the coin's busiest pool 0xc6406d46/.test(l)), was.lines.join("\n"));
  const r = withDay(BURST, A.burst_day.day);
  assert.equal(pick(r.scan), null);
  const v = judge(r);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l === `-- ${WBTC}: its pool 0xc6406d46 (13 swaps in the scan) is not its clear main pool over the day on GeckoTerminal: 663 transactions in 24 h, 0xd960b78f 1215: not judged`), v.lines.join("\n"));
});

test("the day never hides a miss: the burst scan whose pool leads the day by DOMINANCE is judged, its 4 missing swaps FAIL; a day not read judges no coin", () => {
  const day = copy(A.burst_day.day);
  const top = Math.max(...Object.entries(day[WBTC]).filter(([id]) => id !== NVDA_POOL).map(([, n]) => n));
  day[WBTC][NVDA_POOL] = top * DOMINANCE;
  const r = withDay(BURST, day);
  assert.deepEqual(pick(r.scan), { coin: WBTC, pool: NVDA_POOL });
  const v = judge(r);
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^ok  the coin .*; 2430 transactions in 24 h on GeckoTerminal/.test(l)), v.lines.join("\n"));
  const unread = withDay(BURST, { [WBTC]: null });
  const u = judge(unread);
  assert.equal(u.verdict, "INCONCLUSIVE", u.lines.join("\n"));
  assert.ok(u.lines.includes(`-- ${WBTC}: GeckoTerminal's list of its pools not read: not judged`), u.lines.join("\n"));
});

// card v4-route-check-judges-the-deepest-pool: live run 45401968651 (24 Nov 13:18Z) judged Base CHEWY on its LSTEAK/CHEWY
// pool 0xa9e660ca, the busiest by count (149 transactions in 24 h, each other pool at most 68), which holds $339, while
// CHEWY/PLAZM holds $46,703 and the helper's tape follows CHEWY/ETH 0xdb6d9113 ($1,906): a pool of bots' arbitrages is
// no coin's main market. GeckoTerminal's same list gives each pool's reserve (`deep`): the judged pool must be the
// coin's deepest too.
const CHEWY_RUN = A.chewy_run_45401968651;
const CHEWY = "0xe1ea7991432d1b7a1cb478fe433587a9dca51e2e";
const LSTEAK_POOL = "0xa9e660ca1488d6dbbcb645a1a6d3a49fa1ae77166b36a3d830af11fac077e7db";
const withDeep = (run, deep) => ({ ...copy(run), scan: { ...copy(run.scan), deep: copy(deep) } });
test("chewy_run_45401968651: as recorded (no depth read) it judged CHEWY's $339 LSTEAK/CHEWY pool and failed; with GeckoTerminal's depths that pool is not CHEWY's deepest: no tape judged, CHEWY named, and the run passes on its unpriced coin's 200 alone (red at 342cf293b: FAIL)", () => {
  assert.deepEqual(pick(CHEWY_RUN.scan), { coin: CHEWY, pool: LSTEAK_POOL });
  const was = judge(CHEWY_RUN);
  assert.equal(was.verdict, "FAIL", was.lines.join("\n"));
  assert.ok(was.lines.some((l) => /^BAD 1 of 2 swap transactions of the coin's busiest pool 0xa9e660ca/.test(l)), was.lines.join("\n"));
  const r = withDeep(CHEWY_RUN, A.chewy_deep.deep);
  assert.equal(pick(r.scan), null);
  const v = judge(r);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.ok(v.lines.includes(`-- ${CHEWY}: its pool 0xa9e660ca (5 swaps in the scan) is not its clear main pool over the day on GeckoTerminal: 149 transactions in 24 h, $339 deep, 0x95c46679 $46703 deep: not judged`), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^ok  the coin 0x39cd7417.*: trades 200, never a 5xx$/.test(l)), v.lines.join("\n"));
  assert.equal(v.lines.at(-1), `-- no third-quoted coin whose quote has a market on Base in ${CHEWY_RUN.scan.pools.length} pools: no tape judged`);
});

test("the depth never hides a miss: the CHEWY scan whose pool is also the deepest is judged, its missing swap FAILs; a depth not given for the pool, or a record with none, is judged on transactions alone", () => {
  const deep = copy(A.chewy_deep.deep);
  deep[CHEWY][LSTEAK_POOL] = 50_000;
  const v = judge(withDeep(CHEWY_RUN, deep));
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^ok  the coin .*; 149 transactions in 24 h on GeckoTerminal, each other pool of the coin at most 1\/2 of it, and its deepest \(\$50000\)\)$/.test(l)), v.lines.join("\n"));
  deep[CHEWY][LSTEAK_POOL] = null;
  assert.deepEqual(pick(withDeep(CHEWY_RUN, deep).scan), { coin: CHEWY, pool: LSTEAK_POOL });
  assert.equal(leadsDay({ "0xaa": 9, "0xbb": 1 }, "0xaa", { "0xaa": 5, "0xbb": 6 }), false);
  assert.equal(leadsDay({ "0xaa": 9, "0xbb": 1 }, "0xaa", { "0xaa": 6, "0xbb": 6 }), true);
  assert.equal(leadsDay({ "0xaa": 9, "0xbb": 1 }, "0xaa", undefined), true);
});

test("leadsDay: the pool at DOMINANCE times every other pool's 24 h transactions leads; under it, unlisted, none, or a list not read does not", () => {
  const P = "0xaa", Q = "0xbb";
  assert.equal(leadsDay({ [P]: 2 * DOMINANCE, [Q]: 2 }, P), true);
  assert.equal(leadsDay({ [P]: 2 * DOMINANCE - 1, [Q]: 2 }, P), false);
  assert.equal(leadsDay({ [P]: 5 }, P), true);
  assert.equal(leadsDay({ [Q]: 5 }, P), false);
  assert.equal(leadsDay({ [P]: 0 }, P), false);
  assert.equal(leadsDay(null, P), false);
});

test("the scan reads the day of each coin it would judge, by GeckoTerminal's pool ids (a v4 pool's 32 bytes); a 429 there is no day, and no coin is judged", async () => {
  const PARTY = `0x${"33".repeat(20)}`;
  const V3 = VENUES.base.v3[0];
  const asked = [];
  const rig = (gt) => async (url, o) => {
    if (url.startsWith(GT)) return asked.push(url), gt();
    const b = JSON.parse(o.body);
    const one = (q) => {
      const p = q.params[0];
      if (q.method === "eth_getLogs" && p.address === QUOTE) return { jsonrpc: "2.0", id: q.id, result: [{ topics: [TOPIC.transfer, `0x${w(PARTY)}`, `0x${w(`0x${"44".repeat(20)}`)}`] }] };
      if (q.method === "eth_call" && p.to === PARTY) return { jsonrpc: "2.0", id: q.id, result: `0x${w({ "0xc45a0155": V3, "0x0dfe1681": VENUES.base.usd, "0xd21220a7": QUOTE }[p.data])}` };
      return null;
    };
    const mine = [b].flat().map(one);
    if (mine.every((x) => x === null)) return chain([])(url, o);
    const rest = mine.some((x) => x === null) ? JSON.parse(await (await chain([])(url, { ...o, body: JSON.stringify([b].flat()) })).text()) : [];
    const out = mine.map((x, i) => x ?? rest[i]);
    return new Response(JSON.stringify(Array.isArray(b) ? out : out[0]), { status: 200 });
  };
  const list = { data: [{ attributes: { address: POOL.toUpperCase().replace("0X", "0x"), reserve_in_usd: "1234.56", transactions: { h24: { buys: 30, sells: 12 } } } }, { attributes: { address: PARTY, reserve_in_usd: "99.4", transactions: { h24: { buys: 4, sells: 1 } } } }] };
  const s = await scan(rig(() => new Response(JSON.stringify(list), { status: 200 })), RPCS);
  assert.equal(s.unread, undefined, s.unread);
  assert.deepEqual(asked, [`${GT}/tokens/${COIN}/pools?page=1`]);
  assert.deepEqual(s.day, { [COIN]: { [POOL]: 42, [PARTY]: 5 } });
  assert.deepEqual(s.deep, { [COIN]: { [POOL]: 1235, [PARTY]: 99 } });
  assert.deepEqual(pick(s), { coin: COIN, pool: POOL });
  const t = await scan(rig(() => new Response("Too Many Requests", { status: 429 })), RPCS);
  assert.deepEqual(t.day, { [COIN]: null });
  assert.deepEqual(t.deep, { [COIN]: null });
  assert.equal(pick(t), null);
});
