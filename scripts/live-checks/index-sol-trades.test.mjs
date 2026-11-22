// node --test scripts/live-checks/index-sol-trades.test.mjs: the live check replays recorded answers
// (index-sol-trades.answers.json). good: apps/helper's trades.ts run on a Mac, its pump.fun part as recorded before, its
// Meteora part (card index-sol-trades-2) at that card's 180162ef0, the check's own readMeteora against trades.ts run in
// process behind its routes (a one-off recorder kept out of the tree: live-checks-provider-answer refuses a new file that
// imports a check still building its own JSON-RPC; Solana lists passed through from the deployed helper, trades read from
// the public chain endpoints), 2026-11-18: PASS, one Meteora coin per venue. bad_not_deployed: the deployed
// helper before this card, 404 on a listed Solana token's trades: FAIL. Made from the good answer: a tape that holds the
// trade only after 2 s, another trader, another side, no 1s bar at the trade's second, a vendor source, a stale read, no
// CORS echo, a tape oldest first, an extra field: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./index-sol-trades.mjs";
const { judge, read, TRADES_PATH, tradesFault } = check;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "index-sol-trades.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (fn) => {
  const rec = structuredClone(A.good);
  fn(rec);
  return rec;
};
const hitIndex = (rec) => rec.polls.findIndex((p) => JSON.parse(p.body).trades.some((r) => r.tx === rec.fresh.sig));
const body = (r, fn) => {
  const b = JSON.parse(r.body);
  fn(b);
  r.body = JSON.stringify(b);
};

test("the good answer passes", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
  assert.ok(r.lines.length >= 15);
});

test("the deployed helper before this card fails: 404 on a listed token's Solana trades", () => {
  const r = judge(A.bad_not_deployed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /answers 404/.test(l)), bad(r).join("\n"));
});

test("a trade that reaches the tape more than 2 s after the chain had it fails", () => {
  const r = judge(edit((rec) => (rec.polls[hitIndex(rec)].answeredMs = rec.fresh.heldAtMs + 2_001)));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /after the check held it/.test(l)));
});

test("a trade the tape never shows fails", () => {
  const r = judge(edit((rec) => (rec.fresh.sig = "5" + rec.fresh.sig.slice(1, -1) + "1")));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /in none of/.test(l)));
});

test("another trader, another side or another time than the event's fails", () => {
  for (const f of [(row) => (row.trader = "11111111111111111111111111111111"), (row) => (row.side = row.side === "b" ? "s" : "b"), (row) => (row.t_ms += 1000)]) {
    const r = judge(edit((rec) => body(rec.polls[hitIndex(rec)], (b) => f(b.trades.find((x) => x.tx === rec.fresh.sig)))));
    assert.equal(r.ok, false);
  }
});

test("no 1s bar at the trade's second, or a zero-volume one, fails", () => {
  const drop = judge(edit((rec) => body(rec.candles, (b) => (b.candles = b.candles.filter((c) => c[0] !== rec.fresh.ts)))));
  assert.ok(bad(drop).some((l) => /1s candles hold/.test(l)));
  const zero = judge(edit((rec) => body(rec.candles, (b) => b.candles.forEach((c) => (c[5] = "0")))));
  assert.equal(zero.ok, false);
});

test("a vendor source, a stale read or no CORS echo fails", () => {
  assert.equal(judge(edit((rec) => (rec.polls[0].headers["x-helper-source"] = "jupiter"))).ok, false);
  assert.equal(judge(edit((rec) => (rec.candles.headers["x-fetched-at"] = new Date(rec.candles.answeredMs - 60_000).toISOString()))).ok, false);
  assert.equal(judge(edit((rec) => (rec.candles.headers["access-control-allow-origin"] = "*"))).ok, false);
});

test("the tape's wire form: oldest first or an extra field fails", () => {
  const rows = [
    { t_ms: 2_000, side: "b", usd: "1", amt: "1", trader: null, tx: "5jUW7yLN5oBN8zC5bRcG2LpB3TFKqJYfEgq1yMScDnks" },
    { t_ms: 3_000, side: "s", usd: "1", amt: "1", trader: null, tx: "5jUW7yLN5oBN8zC5bRcG2LpB3TFKqJYfEgq1yMScDnks" },
  ];
  assert.match(tradesFault({ trades: rows, src: "chain", as_of_ms: 1 }), /newer/);
  assert.match(tradesFault({ trades: [{ ...rows[0], extra: 1 }], src: "chain", as_of_ms: 1 }), /keys/);
  assert.equal(tradesFault({ trades: rows.slice().reverse(), src: "chain", as_of_ms: 1 }), null);
  // a tape still filling carries `filling: true` between trades and src; any other value or place is a fault
  assert.equal(tradesFault({ trades: rows.slice().reverse(), filling: true, src: "chain", as_of_ms: 1 }), null);
  // release 177's settled tape with its reach (card trades-checks-pass-on-177); a reach on a filling tape is a fault
  assert.equal(tradesFault({ trades: rows.slice().reverse(), whole_ms: 1_000, src: "chain", as_of_ms: 5_000 }), null);
  assert.match(tradesFault({ trades: rows.slice().reverse(), filling: true, whole_ms: 1_000, src: "chain", as_of_ms: 5_000 }), /whole_ms on a filling tape/);
  assert.match(tradesFault({ trades: rows.slice().reverse(), filling: false, src: "chain", as_of_ms: 1 }), /keys/);
  assert.match(tradesFault({ trades: rows.slice().reverse(), src: "chain", filling: true, as_of_ms: 1 }), /keys/);
});

test("a request that times out is named in the error, with its path and the 10 s bound", async () => {
  const coin = "GAtQEYEvkPHMbspPivN4GUVXSg2PVwYXSHSprPEtpump";
  const fetchFn = async (url) => {
    if (url.endsWith("/v1/market/lists?chain=solana")) return new Response(JSON.stringify({ lists: { trending: [{ token: coin }] } }), { status: 200 });
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  await assert.rejects(read("https://helper.test", fetchFn, "wss://ws.test"), (e) => {
    assert.equal(e.message, `GET ${TRADES_PATH(coin)} timed out after 10 s`);
    return true;
  });
});

test("a run says where the time went: the helper's fold between the read without the trade and the read with it", () => {
  const r = judge(A.good);
  const line = r.lines.find((l) => /timing:/.test(l));
  assert.match(line ?? "", /folded it after \+\d+ ms \(read \d+ sent, without it\) and by \+-?\d+ ms \(as_of_ms of read \d+\); read \d+ sent at \+\d+ ms, answered in \d+ ms/);
  assert.equal(r.ok, true);
});

test("the tokens the check opened stay read while it waits for a trade (the helper closes a token nobody read for a minute)", (t) => {
  // live run 4 Nov 06:27Z (run10): the wait took 66 s, the helper closed the token, and the tape read after the trade
  // answered 404 because the token had left the lists by then. Card helper-sol-tape-checks-hold: on the test's clock
  // (mock timers), so a loaded machine never cuts the count (it read 3 of 4 in 45 ms of the wall clock, 2 of 20 runs at
  // 10 at once on main 5113ed107)
  assert.equal(typeof check.keepOpen, "function");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seen = [];
  const fetchFn = (url) => (seen.push(url), Promise.resolve(new Response("{}", { status: 200 })));
  const stop = check.keepOpen("https://helper.test", ["A1", "B2"], fetchFn, 10);
  t.mock.timers.tick(9);
  assert.equal(seen.length, 0, "none before the first interval");
  t.mock.timers.tick(1);
  t.mock.timers.tick(10);
  stop();
  assert.deepEqual(seen, [TRADES_PATH("A1"), TRADES_PATH("B2"), TRADES_PATH("A1"), TRADES_PATH("B2")].map((p) => `https://helper.test${p}`));
  t.mock.timers.tick(100);
  assert.equal(seen.length, 4); // none after stop
});

// card evm-chart-opens-without-a-vendor-call: the candles read as the token page reads it (candles-read.mjs)
test("the 1s candles: a 200 after a 429 that cleared inside the span passes; a 429 still standing after it, or an empty 200, fails", () => {
  assert.deepEqual(bad(judge(edit((rec) => (rec.candles.waits = [30_000])))), []);
  const stood = judge(edit((rec) => Object.assign(rec.candles, { status: 429, body: '{"error":{"code":"rate_limited"}}', waits: [60_000, 15_000] })));
  assert.ok(bad(stood).some((l) => l.endsWith("answers 429 after 75 s of reads at each Retry-After (60, 15 s)")), bad(stood).join("\n"));
  const empty = judge(edit((rec) => body(rec.candles, (b) => (b.candles = []))));
  assert.ok(bad(empty).some((l) => /the 1s candles hold the trade's block second/.test(l)), bad(empty).join("\n"));
});

// card index-sol-trades-2: one listed Meteora coin per venue. good.meteora: the in-process recorder's Meteora part, its
// signatures read back once that process's helper had stopped (its reads on the same public RPC drew 429s). On 18 Nov the lists held no coin on a DBC curve that traded, so the DBC leg reads "none to read" and its decoding
// is held by decode.test.ts's recorded DBC trades. bad_meteora_before: the deployed helper before this card read by the
// check's Meteora part: FAIL.
const VENUES = ["meteora-dlmm", "meteora-dbc", "meteora-damm2"];
const READ = VENUES.filter((v) => v in A.good.meteora);

test("card index-sol-trades-2: the good answer holds a fresh trade of a listed coin on each Meteora venue, on its tape, read back on two RPCs", () => {
  const r = check.judgeMeteora(A.good.meteora);
  assert.deepEqual(bad(r), []);
  assert.ok(READ.includes("meteora-dlmm") && READ.includes("meteora-damm2"), READ.join());
  for (const v of VENUES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${v}: the trade`) || (v === "meteora-dbc" && l.startsWith(`ok  ${v}: none to read`))), v);
});

test("card index-sol-trades-2: no DBC trade passes only while the lists hold no coin on a DBC curve that trades", () => {
  const noDbc = (fn) => edit((rec) => (delete rec.meteora["meteora-dbc"], fn(rec.meteora)));
  assert.equal(judge(noDbc((m) => (m.dbc_curves = []))).ok, true);
  assert.equal(judge(noDbc((m) => (m.dbc_curves = ["65iH8k736QNhuUHm1tt8X7yJXpJ517HPPq8BrVdwring"]))).ok, false, "a DBC curve coin listed");
  assert.equal(judge(noDbc((m) => delete m.dbc_curves)).ok, false, "no DBC curve list");
  assert.equal(judge(noDbc((m) => (m.dbc_curves = "none"))).ok, false, "a DBC curve list that is not a list");
  const rows = [
    { token: "A1", launchpad: "met-dbc", curve_bps: 5_000, vol_24h_usd: 2_000 },
    { token: "B2", launchpad: "met-dbc", curve_bps: 10_000, vol_24h_usd: 2_000 },
    { token: "C3", launchpad: "met-dbc", curve_bps: 5_000, vol_24h_usd: 0.99 },
  ];
  assert.equal(check.DBC_VOL_USD, 1_000);
  assert.deepEqual(check.dbcCurves(rows), ["A1"]);
});

test("card index-sol-trades-2: the deployed helper before this card fails the Meteora part", () => {
  const r = check.judgeMeteora(A.bad_meteora_before.meteora);
  assert.equal(r.ok, false);
  assert.ok(bad(r).length > 0);
  assert.equal(judge({ ...A.good, meteora: A.bad_meteora_before.meteora }).ok, false);
});

test("card index-sol-trades-2: a venue with no fresh trade, the trade not on the tape, another side or time, a vendor source, or a signature one RPC does not read back succeeded, fails", () => {
  const onTape = (rec, v, fn) => body(rec.meteora[v].polls.at(-1), (b) => fn(b, b.trades.find((x) => x.tx === rec.meteora[v].sig)));
  for (const v of READ) {
    assert.equal(judge(edit((rec) => delete rec.meteora[v])).ok, false, `${v} missing`);
    assert.equal(judge(edit((rec) => onTape(rec, v, (b) => (b.trades = b.trades.filter((x) => x.tx !== rec.meteora[v].sig))))).ok, false, `${v} not on the tape`);
    assert.equal(judge(edit((rec) => onTape(rec, v, (b, row) => (row.side = row.side === "b" ? "s" : "b")))).ok, false, `${v} side`);
    assert.equal(judge(edit((rec) => (rec.meteora[v].ts += 1))).ok, false, `${v} time`);
    assert.equal(judge(edit((rec) => (rec.meteora[v].polls.at(-1).headers["x-helper-source"] = "vendor"))).ok, false, `${v} source`);
    assert.equal(judge(edit((rec) => (rec.meteora[v].reads[check.READ_BACK[1]] = { error: "getSignatureStatuses answered 429" }))).ok, false, `${v} read back`);
    assert.equal(judge(edit((rec) => (rec.meteora[v].reads[check.READ_BACK[0]].value[0].err = { InstructionError: [0, "Custom"] }))).ok, false, `${v} failed`);
  }
  assert.equal(judge(edit((rec) => delete rec.meteora)).ok, false, "no Meteora part");
});

// card sol-meteora-tape-inside-rpc-budget: the helper serves a coin past its whole reads' budget its pool's tape and names
// it in Server-Timing (sol-whole-cut). good_cut: the check's readMeteora at this card's head against a local helper on
// mainnet at the head (main with sol-tape-in-order, and this card), 10 busy Solana coins open beside it, 18 Nov 20:21Z:
// a fresh DLMM and DAMM v2 trade judged on uncut tapes, PASS (no coin of its 20 was cut that run). A cut coin skipped beside
// a judged one is rolled_try4's DLMM venue (14 cut coins skipped, a trade judged on an uncut tape). bad_all_cut: the
// check against a scratch build of that head with WHOLE_PER_S 0: every DBC coin it sampled cut, FAIL naming the cut.
test("card sol-meteora-tape-inside-rpc-budget: a coin past the helper's whole reads' budget is skipped and named, and an uncut one is judged", () => {
  const g = check.judgeMeteora(A.good_cut.meteora);
  assert.deepEqual(bad(g), [], g.lines.join("\n"));
  for (const v of VENUES) if (A.good_cut.meteora[v]) assert.equal(check.cutOf(A.good_cut.meteora[v].polls.at(-1)), null, `${v} judged on an uncut answer`);
  const m = A.rolled_try4.meteora;
  const r = check.judgeMeteora(m);
  const dlmm = "meteora-dlmm";
  assert.ok(m.cut[dlmm].length > 0, "the recorded run skipped cut DLMM coins");
  assert.deepEqual(bad(r).filter((l) => l.includes(dlmm)), [], r.lines.join("\n"));
  const coins = new Set(m.cut[dlmm].map((c) => c.coin)).size;
  assert.ok(r.lines.some((l) => l.startsWith(`ok  ${dlmm}: ${coins} coin(s), ${m.cut[dlmm].length} trade(s): `) && l.endsWith("past the helper's whole reads' budget skipped (sol-whole-cut)")), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`ok  ${dlmm}: the trade `)), "a DLMM trade judged beside the skipped ones");
  assert.equal(check.cutOf(m[dlmm].polls.at(-1)), null);
  assert.ok(!m.cut[dlmm].some((c) => c.sig === m[dlmm].sig), "the judged trade is not a skipped one");
});

test("card sol-meteora-tape-inside-rpc-budget: every sampled coin cut fails, naming the cut; a judged coin served past the budget fails", () => {
  const r = check.judgeMeteora(A.bad_all_cut.meteora);
  assert.equal(r.ok, false);
  // its cuts were recorded undated: no span read, so judged as cuts inside one keep, a fault naming the cut
  assert.ok(bad(r).some((l) => /none judged: every trade found .* inside one cut of the helper's whole reads' budget \(sol-whole-cut.*undated/.test(l)), bad(r).join("\n"));
  const m = structuredClone(A.good_cut.meteora);
  const v = VENUES.find((x) => m[x]?.polls);
  m[v].polls.at(-1).headers["server-timing"] = `sol-vendor-read;desc="rows read 1 ms ago", sol-whole-cut;desc="a Meteora trade unread 3 s ago", total;dur=4`;
  assert.ok(bad(check.judgeMeteora(m)).some((l) => l.includes(`${v}: the judged coin`)), "a judged coin past the budget");
  assert.equal(check.cutOf({ headers: { "server-timing": "sol-vendor-read;desc=\"x\", total;dur=3" } }), null);
  assert.equal(check.cutOf({ headers: { "server-timing": "sol-whole-cut;desc=\"a Meteora trade unread 0 s ago\", total;dur=3" } }), 'sol-whole-cut;desc="a Meteora trade unread 0 s ago"');
});

// card solana-flooded-coin-first-answer-holds-rows: past the budget the helper serves a coin its own rows, filling, the cut
// named and no reach (whole_ms) while the cut lasts. A cut answer that names a reach claims every trade from then on while
// one is unread: BAD. rolled_try4's DLMM cut coins name none (its DLMM venue judged ok, above); the same run with one cut
// answer naming a reach fails on DLMM.
test("card solana-flooded-coin-first-answer-holds-rows: a cut answer naming a reach (whole_ms) fails; one naming none is skipped", () => {
  const m = structuredClone(A.rolled_try4.meteora);
  const v = "meteora-dlmm";
  assert.ok(m.cut[v].length > 0, "the recorded run holds cut DLMM coins");
  assert.ok(m.cut[v].every((c) => c.whole_ms === undefined), "the recorded cuts name no reach");
  assert.deepEqual(bad(check.judgeMeteora(m)).filter((l) => l.includes(v)), []);
  m.cut[v][0].whole_ms = 1795011901000;
  const r = check.judgeMeteora(m);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.startsWith(`BAD ${v}: `) && l.includes("named the cut") && l.includes("whole_ms 1795011901000")), bad(r).join("\n"));
  // the reach read off an answer's body, null when it names none or is not JSON
  assert.equal(check.wholeOf({ body: JSON.stringify({ trades: [], filling: true, src: "chain" }) }), null);
  assert.equal(check.wholeOf({ body: JSON.stringify({ trades: [], whole_ms: 5, src: "chain" }) }), 5);
  assert.equal(check.wholeOf({ body: "busy" }), null);
});

// card sol-meteora-tape-inside-rpc-budget: GET /v1/market/trades takes a limit only (at most 50), so a found trade its
// coin's tape no longer answers for is skipped and named in `rolled`, never judged missing: one older than the 50 rows, or
// older than the reach the answer names (whole_ms). rolled_try4: the check's readMeteora at 8ddec0fe2 against a local
// helper at 7239c82e4, 18 Nov 19:51Z: DAMM v2 trade m6AJaXiFvoPs at 1795031220 s, its tape's whole_ms 1795031235000 (50
// rows, newest 1795031191 s, oldest 1795029860 s), judged "not in its 50 rows" at 8ddec0fe2; no other DAMM v2 trade.
const DAMM = "meteora-damm2";
const reachOf = (v) => JSON.parse(v.polls.at(-1).body).whole_ms;

test("card sol-meteora-tape-inside-rpc-budget: a trade older than the reach its tape names is skipped, not judged missing", () => {
  const m = A.rolled_try4.meteora;
  assert.ok(m[DAMM].ts * 1000 < reachOf(m[DAMM]), "the recorded trade is older than the tape's named reach");
  const r = check.judgeMeteora(m);
  assert.deepEqual(r.lines.filter((l) => /not in its \d+ rows/.test(l)), [], r.lines.join("\n"));
  // with a judged DAMM v2 trade beside it (the good answer's), the skipped one is not BAD
  const both = structuredClone(m);
  both.rolled = { [DAMM]: [{ coin: m[DAMM].coin, sig: m[DAMM].sig, ts: m[DAMM].ts, why: check.outOfSpan(m[DAMM]) }] };
  both[DAMM] = structuredClone(A.good.meteora[DAMM]);
  const rb = check.judgeMeteora(both);
  assert.deepEqual(bad(rb).filter((l) => l.includes(DAMM)), [], rb.lines.join("\n"));
  assert.ok(rb.lines.some((l) => l.startsWith(`ok  ${DAMM}: 1 trade(s) out of its tape's span skipped: m6AJaXiFvoPs before the tape's named reach`)), rb.lines.join("\n"));
});

test("card sol-meteora-tape-inside-rpc-budget: a trade older than a full tape's 50 rows is skipped; one missing inside the rows' span and the reach is BAD", () => {
  const g = A.good.meteora[DAMM];
  const rows = (b) => JSON.parse(b);
  // 50 rows all newer than the trade, the trade not among them: rolled past
  const rolledPast = structuredClone(g);
  const b = rows(rolledPast.polls.at(-1).body);
  const newest = (g.ts + 60) * 1000;
  b.trades = Array.from({ length: 50 }, (_, i) => ({ ...b.trades[0], t_ms: newest - i * 100, tx: `${"1".repeat(80)}${String(i).padStart(8, "0")}`.slice(-88) }));
  delete b.whole_ms;
  rolledPast.polls.at(-1).body = JSON.stringify(b);
  assert.match(check.outOfSpan(rolledPast) ?? "", /^rolled past the tape's 50 rows/);
  // the trade's row taken out of the good tape: inside its span and its reach, so the tape's fault
  const missing = structuredClone(g);
  const mb = rows(missing.polls.at(-1).body);
  mb.trades = mb.trades.filter((x) => x.tx !== g.sig);
  missing.polls.at(-1).body = JSON.stringify(mb);
  assert.equal(check.outOfSpan(missing), null);
  const r = check.judgeMeteora({ ...A.good.meteora, [DAMM]: missing });
  assert.ok(bad(r).some((l) => l.startsWith(`BAD ${DAMM}: the trade ${g.sig.slice(0, 12)} is on the coin's tape, not in its`)), r.lines.join("\n"));
});

test("card sol-meteora-tape-inside-rpc-budget: a venue whose every sampled trade was skipped is BAD, so a run of skips never passes", () => {
  const r = check.judgeMeteora(A.rolled_try4.meteora);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.startsWith(`BAD ${DAMM}: every sampled trade was skipped, none judged: 1 out of its tape's span (m6AJaXiFvoPs`)), bad(r).join("\n"));
  // the same from a recorded `rolled` list with no judged trade
  const m = structuredClone(A.good.meteora);
  m.rolled = { [DAMM]: [{ coin: m[DAMM].coin, sig: m[DAMM].sig, ts: m[DAMM].ts, why: "rolled past the tape's 50 rows (oldest 1)" }] };
  delete m[DAMM];
  assert.ok(bad(check.judgeMeteora(m)).some((l) => l.startsWith(`BAD ${DAMM}: every sampled trade was skipped`)));
});

// card sol-meteora-tape-inside-rpc-budget: side_try6, the check's readMeteora at 8ddec0fe2 against a local helper at that
// head, 18 Nov 20:12Z: DAMM v2 transaction 25KF3ptvBtY1 of E5cbap6o holds two rows of the coin (a sell, then a buy of
// 26023135.8611); the event found was the buy, judged against the sell row at 8ddec0fe2.
test("card sol-meteora-tape-inside-rpc-budget: a transaction with several rows of the coin is judged on the row of the trade's side and time", () => {
  const v = A.side_try6.meteora[DAMM];
  const rows = JSON.parse(v.polls.at(-1).body).trades.filter((r) => r.tx === v.sig);
  assert.deepEqual(rows.map((r) => r.side), ["s", "b"], "the recorded tape holds both rows, the sell first");
  const r = check.judgeMeteora(A.side_try6.meteora);
  assert.deepEqual(bad(r).filter((l) => l.startsWith(`BAD ${DAMM}`)), [], r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  ${DAMM}: its side "b" and time ${v.ts * 1000} are the event's (b, ${v.ts * 1000})`), r.lines.join("\n"));
  // no row of the trade's side: still BAD
  const m = structuredClone(A.side_try6.meteora);
  const b = JSON.parse(m[DAMM].polls.at(-1).body);
  b.trades = b.trades.filter((x) => !(x.tx === v.sig && x.side === "b"));
  m[DAMM].polls.at(-1).body = JSON.stringify(b);
  assert.ok(bad(check.judgeMeteora(m)).some((l) => l.startsWith(`BAD ${DAMM}: its side "s"`)));
});

test("card sol-meteora-tape-inside-rpc-budget: the check keeps open fewer coins than the helper's walks, room left for the users' pages", async () => {
  const { OPEN_MAX } = await import("../../apps/helper/src/data/solana/trades.ts");
  assert.ok(check.METEORA_WATCH + check.OPEN <= OPEN_MAX - 10, `${check.METEORA_WATCH} + ${check.OPEN} of ${OPEN_MAX}`);
});

// card helper-sol-tape-checks-hold: a trade's time is its block's (the good answer's block read on api.mainnet-beta 20 Nov
// 05:3xZ: 1793741218, its event's clock the same second). An event's clock is a second before its block in some slots
// (slot 471386582's DAMM v2 event 1795102226, block 1795102227 on both public RPCs), where the helper now dates the row by
// its block: that row and its 1s bar pass, the event's second fails, and a run whose block was read on no RPC fails.
test("card helper-sol-tape-checks-hold: the pump.fun trade's row and 1s bar are judged at its block's second, never its event's clock a second before", () => {
  const atBlock = (rec, s) => {
    rec.fresh.block = rec.fresh.ts + 1;
    if (s.row) body(rec.polls[hitIndex(rec)], (b) => (b.trades.find((x) => x.tx === rec.fresh.sig).t_ms = rec.fresh.block * 1000));
    if (s.bar) body(rec.candles, (b) => (b.candles.find((c) => c[0] === rec.fresh.ts)[0] = rec.fresh.block));
  };
  assert.deepEqual(bad(judge(edit((rec) => atBlock(rec, { row: true, bar: true })))), [], "dated by its block: PASS");
  const evRow = bad(judge(edit((rec) => atBlock(rec, { bar: true }))));
  assert.ok(evRow.some((l) => /its side "s", time 1793741218000 .* its block's time \(s, 1793741219000,/.test(l)), evRow.join("\n"));
  const evBar = bad(judge(edit((rec) => atBlock(rec, { row: true }))));
  assert.ok(evBar.some((l) => /the 1s candles hold the trade's block second 1793741219: none/.test(l)), evBar.join("\n"));
  const unread = bad(judge(edit((rec) => (rec.fresh.block = null))));
  assert.ok(unread.some((l) => /its block time read back: null/.test(l)), unread.join("\n"));
});

test("card helper-sol-tape-checks-hold: a signature a public RPC knows no status for yet is asked again (2, 4, 8, 16 s), never judged on its first none", async () => {
  const asked = [];
  const waits = [];
  const st = { value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }] };
  // publicnode answers none twice (a node behind), then the status; api.mainnet-beta at once
  const callFn = async (u, method) => (asked.push(`${new URL(u).host} ${method}`), new URL(u).host === "solana-rpc.publicnode.com" && asked.filter((a) => a.startsWith("solana-rpc")).length <= 2 ? { value: [null] } : st);
  const reads = await check.readBack("5".repeat(88), callFn, async (ms) => void waits.push(ms));
  assert.deepEqual(Object.values(reads).map((r) => r.value[0]?.confirmationStatus), ["finalized", "finalized"]);
  assert.deepEqual(waits, [2_000, 4_000]);
  // none on every try stays none (judged BAD, as before)
  const never = await check.readBack("5".repeat(88), async () => ({ value: [null] }), async () => undefined);
  assert.equal(never["https://solana-rpc.publicnode.com"].value[0], null);
  const m = structuredClone(A.good.meteora);
  m["meteora-damm2"].reads["https://solana-rpc.publicnode.com"] = never["https://solana-rpc.publicnode.com"];
  assert.ok(bad(check.judgeMeteora(m)).some((l) => l === "BAD meteora-damm2: the signature reads back succeeded on solana-rpc.publicnode.com: none"));
});

test("card helper-sol-tape-checks-hold: a trade's block time is the first public RPC's that names one, asked again 2, 4 and 8 s on; none answering is null", async () => {
  let n = 0;
  const waits = [];
  const t = await check.blockOf("5".repeat(88), async () => (++n <= 3 ? null : { blockTime: 1795102227 }), async (ms) => void waits.push(ms));
  assert.equal(t, 1795102227);
  assert.deepEqual(waits, [2_000]);
  assert.equal(await check.blockOf("5".repeat(88), async () => ({ blockTime: null }), async () => undefined), null);
});

// card helper-sol-tape-checks-hold: live run 44721792317 (job 136239401075, 20 Nov 10:50Z) failed on "BAD meteora-dbc: every
// sampled coin (13: fZgm5f3J, fZgm5f3J, ... 13 times) was served past the helper's whole reads' budget": one busy DBC coin,
// sampled again at each of its trades while one cut lasted (trades.ts CUT_KEEP_MS). The judge counts coins once, and calls
// a venue starved only when its cuts were read more than a cut's keep apart; cuts inside one keep judge nothing, a fault
// named as that. The run's DBC part rebuilt on bad_all_cut's recorded cut (its coin, sig and Server-Timing), dated.
const FZ = "fZgm5f3JAqcupMr2mRMUwNnPS8yW4ttagX9AuDbHhR9";
/** bad_all_cut's Meteora part with its DBC venue cut `n` times on one coin, `stepMs` apart, nothing judged. */
function dbcCutOnce(n, stepMs) {
  const m = structuredClone(A.bad_all_cut.meteora);
  const t0 = 1_795_171_000_000;
  const timing = 'sol-whole-cut;desc="a Meteora trade unread 1 s ago"';
  m["meteora-dbc"] = undefined;
  m.cut["meteora-dbc"] = Array.from({ length: n }, (_, i) => ({ coin: FZ, sig: `${"5".repeat(80)}${String(i).padStart(8, "1")}`, timing, atMs: t0 + i * stepMs }));
  return m;
}
const dbcLines = (m) => check.judgeMeteora(m).lines.filter((l) => l.includes("meteora-dbc"));

test("card helper-sol-tape-checks-hold: one coin cut 13 times inside one cut's keep is named once and is never called a starved venue, a fault named as none judged (red at 5113ed107: \"every sampled coin (13: fZgm5f3J, ... 13 times)\", the budget starved the venue)", () => {
  const lines = dbcLines(dbcCutOnce(13, 4_000)); // 13 trades over 48 s, inside CUT_KEEP_MS
  assert.equal(lines.filter((l) => l.startsWith("BAD")).length, 1, lines.join("\n"));
  assert.ok(!lines.some((l) => /starved/.test(l)), `a cut inside one keep called starved: ${lines.join("\n")}`);
  assert.ok(lines.some((l) => l.startsWith("BAD meteora-dbc: none judged: every trade found (1 coin(s), 13 trade(s): fZgm5f3J)") && l.includes("all within 48 s")), lines.join("\n"));
});

test("card helper-sol-tape-checks-hold: cuts read more than a cut's keep apart are a starved venue, each coin named once", () => {
  const lines = dbcLines(dbcCutOnce(3, check.CUT_KEEP_MS / 2 + 1_000)); // the third read 62 s after the first
  assert.ok(lines.some((l) => l.startsWith("BAD meteora-dbc: every sampled coin (1 coin(s), 3 trade(s): fZgm5f3J)") && /cut again 62 s after its first, past the 60 s a cut lasts: the budget starved the venue/.test(l)), lines.join("\n"));
  // and a cut exactly at the keep is still inside it
  assert.ok(!dbcLines(dbcCutOnce(2, check.CUT_KEEP_MS)).some((l) => /starved/.test(l)));
});

test("card helper-sol-tape-checks-hold: cuts the coin's own share explains are never a starved venue, however far apart; every coin's second spent, a held or unanswered provider is", () => {
  const own = dbcCutOnce(3, check.CUT_KEEP_MS / 2 + 1_000);
  for (const c of own.cut["meteora-dbc"]) c.timing = `sol-whole-cut;desc="a Meteora trade unread 1 s ago: past the coin's own 20 a 10 s"`;
  const lines = dbcLines(own);
  assert.ok(!lines.some((l) => /starved/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("BAD meteora-dbc: none judged: every trade found (1 coin(s), 3 trade(s): fZgm5f3J) was on a coin past its own share")), lines.join("\n"));
  for (const why of ["past every coin's 10 a second", "its provider held", "its read unanswered"]) {
    const m = dbcCutOnce(3, check.CUT_KEEP_MS / 2 + 1_000);
    for (const c of m.cut["meteora-dbc"]) c.timing = `sol-whole-cut;desc="a Meteora trade unread 1 s ago: ${why}"`;
    assert.ok(dbcLines(m).some((l) => l.includes(`(sol-whole-cut;desc="a Meteora trade unread 1 s ago: ${why}"), cut again 62 s after its first`) && l.endsWith("the budget starved the venue")), `${why}: ${dbcLines(m).join("\n")}`);
  }
  // the coin's own cuts set no span: one starving cut beside them is inside one keep
  own.cut["meteora-dbc"][1].timing = 'sol-whole-cut;desc="a Meteora trade unread 1 s ago: its read unanswered"';
  assert.ok(dbcLines(own).some((l) => l.startsWith("BAD meteora-dbc: none judged") && l.includes("all within 0 s")), dbcLines(own).join("\n"));
});

// round 3: live run 44901581973 (helper 4e03fcbac) cut a quiet DBC coin "past every coin's 10 a second" 136 s apart,
// while busy coins filled each second; the helper now keeps 3 places a second from busy coins and names a busy coin's
// cut by the busy share. That cut is the busy coin's own load: never starved, still none judged (BAD, never a pass).
test("card helper-sol-tape-checks-hold: a busy coin's cut by the busy share is its own share, never a starved venue, still none judged", () => {
  const busy = dbcCutOnce(3, check.CUT_KEEP_MS / 2 + 1_000);
  for (const c of busy.cut["meteora-dbc"]) c.timing = `sol-whole-cut;desc="a Meteora trade unread 1 s ago: past the 7 a second busy coins share"`;
  const lines = dbcLines(busy);
  assert.ok(!lines.some((l) => /starved/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("BAD meteora-dbc: none judged: every trade found (1 coin(s), 3 trade(s): fZgm5f3J) was on a coin past its own share")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.startsWith("ok  meteora-dbc") || l.startsWith("PASS")), lines.join("\n"));
});

test("card helper-sol-tape-checks-hold: the check's own-share causes are the helper's texts, and no other cause is (trades.ts)", async () => {
  const t = await import("../../apps/helper/src/data/solana/trades.ts");
  for (const why of [`past the coin's own ${t.WHOLE_COIN_MAX} a ${t.WHOLE_WINDOW_MS / 1_000} s`, `past the ${t.WHOLE_PER_S - t.WHOLE_QUIET_ROOM} a second busy coins share`]) assert.match(`desc="a Meteora trade unread 1 s ago: ${why}"`, check.OWN_SHARE, why);
  for (const why of [`past every coin's ${t.WHOLE_PER_S} a second`, "its provider held", "its read unanswered"]) assert.doesNotMatch(`desc="a Meteora trade unread 1 s ago: ${why}"`, check.OWN_SHARE, why);
});

test("card helper-sol-tape-checks-hold: the check's CUT_KEEP_MS is the helper's (trades.ts)", async () => {
  const trades = await import("../../apps/helper/src/data/solana/trades.ts");
  assert.equal(check.CUT_KEEP_MS, trades.CUT_KEEP_MS);
});

test("card helper-sol-tape-checks-hold: a trade of a coin whose cut lasts is passed over by the watch, not read; another coin's is read", async () => {
  const sent = [];
  class FakeWs {
    constructor() {
      FakeWs.last = this;
      setImmediate(() => this.onopen?.());
    }
    send(m) {
      sent.push(JSON.parse(m));
    }
    close() {}
  }
  const realWs = globalThis.WebSocket;
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.WebSocket = FakeWs;
  globalThis.fetch = async (url, init) => {
    asked.push(JSON.parse(String(init.body)).params[0]);
    throw new Error("no network in the test");
  };
  try {
    const coins = [FZ, "GM8EysYT8NRSsoULdeYShbRsUdhoUoiB9EN4eW3YETCH"];
    const done = check.watchMeteora(coins, "ws://fake", 200, async () => true, (coin) => coin === FZ);
    await new Promise((r) => setImmediate(r));
    const ws = FakeWs.last;
    sent.forEach((m, i) => ws.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: 100 + i }) }));
    const note = (sub, sig) => ws.onmessage({ data: JSON.stringify({ method: "logsNotification", params: { subscription: sub, result: { value: { signature: sig, err: null, logs: [`Program ${check.METEORA["meteora-dbc"]} invoke [1]`] } } } }) });
    note(100, "sigOfTheCutCoin");
    note(101, "sigOfAnother");
    await done;
    // each read asks READ_BACK's two RPCs in turn: the signatures asked, once each
    assert.deepEqual([...new Set(asked)], ["sigOfAnother"], "only the other coin's trade was read");
  } finally {
    globalThis.WebSocket = realWs;
    globalThis.fetch = realFetch;
  }
});

// good_cause: the check at this card against a local helper at this card (5113ed107 with this card's trades.ts), on
// mainnet, 20 Nov 12:00Z: every venue judged on a fresh trade (DBC on 3A2F3vVE), one DLMM coin skipped, its cut dated and
// named by its cause, the coin's own share. PASS.
test("card helper-sol-tape-checks-hold: a recorded run at this card judges every venue, its cut dated and named by its cause", () => {
  const m = A.good_cause.meteora;
  const r = check.judgeMeteora(m);
  assert.deepEqual(bad(r), [], r.lines.join("\n"));
  for (const v of VENUES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${v}: the trade `)), `${v} judged`);
  const cuts = Object.values(m.cut).flat();
  assert.ok(cuts.length > 0 && cuts.every((c) => Number.isSafeInteger(c.atMs) && / s ago: past the coin's own 20 a 10 s"$/.test(c.timing)), JSON.stringify(cuts));
  // the same cuts with the DLMM trade unjudged and their cause every coin's second, read past one keep: starved
  const s = structuredClone(m);
  s["meteora-dlmm"] = undefined;
  s.cut["meteora-dlmm"] = [0, check.CUT_KEEP_MS + 1].map((d, i) => ({ ...cuts[0], sig: `${cuts[0].sig.slice(0, -1)}${i + 2}`, atMs: cuts[0].atMs + d, timing: cuts[0].timing.replace("past the coin's own 20 a 10 s", "past every coin's 10 a second") }));
  assert.ok(bad(check.judgeMeteora(s)).some((l) => l.startsWith("BAD meteora-dlmm: every sampled coin (1 coin(s), 2 trade(s)") && l.endsWith("the budget starved the venue")), bad(check.judgeMeteora(s)).join("\n"));
});
