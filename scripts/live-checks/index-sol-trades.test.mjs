// node --test scripts/live-checks/index-sol-trades.test.mjs: the live check replays recorded answers
// (index-sol-trades.answers.json). good: apps/helper's trades.ts run on a Mac, its pump.fun part as recorded before, its
// Meteora part (card index-sol-trades-2) at that card's 180162ef0 (index-sol-trades.record-local.mjs --meteora: Solana
// lists passed through from the deployed helper, trades read from the public chain endpoints), 2026-11-18: PASS, one
// Meteora coin per venue. bad_not_deployed: the deployed
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

test("the tokens the check opened stay read while it waits for a trade (the helper closes a token nobody read for a minute)", async () => {
  // live run 4 Nov 06:27Z (run10): the wait took 66 s, the helper closed the token, and the tape read after the trade
  // answered 404 because the token had left the lists by then
  assert.equal(typeof check.keepOpen, "function");
  const seen = [];
  const fetchFn = async (url) => (seen.push(url), new Response("{}", { status: 200 }));
  const stop = check.keepOpen("https://helper.test", ["A1", "B2"], fetchFn, 10);
  await new Promise((r) => setTimeout(r, 45));
  stop();
  const n = seen.length;
  assert.ok(n >= 4, `${n} reads`);
  assert.ok(seen.includes(`https://helper.test${TRADES_PATH("A1")}`) && seen.includes(`https://helper.test${TRADES_PATH("B2")}`));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, n); // none after stop
});

// card evm-chart-opens-without-a-vendor-call: the candles read as the token page reads it (candles-read.mjs)
test("the 1s candles: a 200 after a 429 that cleared inside the span passes; a 429 still standing after it, or an empty 200, fails", () => {
  assert.deepEqual(bad(judge(edit((rec) => (rec.candles.waits = [30_000])))), []);
  const stood = judge(edit((rec) => Object.assign(rec.candles, { status: 429, body: '{"error":{"code":"rate_limited"}}', waits: [60_000, 15_000] })));
  assert.ok(bad(stood).some((l) => l.endsWith("answers 429 after 75 s of reads at each Retry-After (60, 15 s)")), bad(stood).join("\n"));
  const empty = judge(edit((rec) => body(rec.candles, (b) => (b.candles = []))));
  assert.ok(bad(empty).some((l) => /the 1s candles hold the trade's second/.test(l)), bad(empty).join("\n"));
});

// card index-sol-trades-2: one listed Meteora coin per venue. good (re-recorded for this card): its pump.fun part the
// check's own read() against this tree's trades.ts in process (index-sol-trades.record-local.mjs), its Meteora part the
// same recorder's --meteora run (the public websocket refused a second connection while the in-process helper held its
// own). On 18 Nov the lists held no coin on a DBC curve that traded, so the DBC leg reads "none to read" and its decoding
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
