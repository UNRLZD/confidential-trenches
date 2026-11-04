// node --test scripts/live-checks/index-sol-trades.test.mjs: the live check replays recorded answers
// (index-sol-trades.answers.json). good: apps/helper at the card branch run on a Mac (Solana lists passed through from the
// deployed helper, trades read from the public chain endpoints), 2026-11-03 21:00Z: PASS. bad_not_deployed: the deployed
// helper before this card, 404 on a listed Solana token's trades: FAIL. Made from the good answer: a tape that holds the
// trade only after 2 s, another trader, another side, no 1s bar at the trade's second, a vendor source, a stale read, no
// CORS echo, a tape oldest first, an extra field: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, tradesFault } from "./index-sol-trades.mjs";

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
});
