// node --test scripts/live-checks/base-uniswap-v2-tape.test.mjs: the live check of card base-uniswap-v2-tape judges
// recorded runs (base-uniswap-v2-tape.answers.json). good: the deployed helper fc3c11b6e, two Uniswap v2-only Base tokens
// whose window's swaps were all on their tapes with their sides and a chain bar at the newest: PASS. bad_live: the helper
// at a6b7a3ad7, before Uniswap v2 was a Base venue (8a92d76bd), run keyless on a Mac: an empty tape and no candles
// while the chain logged 2 swaps: FAIL. Planted from the good one: a swap missing, a wrong side, a vendor tape, a tape
// 503, candles from the vendor alone or with no bar at the swap's minute: FAIL; nothing to judge: INCONCLUSIVE. The
// written-out venue figures are held to the helper's, and the Swap decoding to a real Uniswap v2 log.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BASE_VENUES, TOPIC, TRADES_MAX as HELPER_TRADES_MAX, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";
import { candidates, FACTORY, judge, PACE, SETTLE_MS, SWAP_TOPIC, swapOf, TRADES_MAX, WETH, WINDOW } from "./base-uniswap-v2-tape.mjs";

const A = JSON.parse(readFileSync(new URL("./base-uniswap-v2-tape.answers.json", import.meta.url), "utf8"));
const FIX = JSON.parse(readFileSync(new URL("../../apps/helper/src/data/evm/fixtures/swaps-univ2-base.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const tok = (run, i, f) => ({ ...run, tokens: run.tokens.map((t, j) => (j === i ? f(structuredClone(t)) : t)) });

test("the figures the check writes out are the helper's own", () => {
  assert.equal(FACTORY, BASE_VENUES.uniswapV2);
  assert.ok(VENUES.base.v2.includes(FACTORY) && VENUES.base.uniV2.includes(FACTORY), "the helper reads the factory as a Uniswap v2 venue");
  assert.equal(WETH, BASE_VENUES.weth);
  assert.equal(SWAP_TOPIC, TOPIC.swapUni2);
  assert.equal(WINDOW, VENUES.base.cold);
  assert.equal(TRADES_MAX, HELPER_TRADES_MAX);
});

test("swapOf decodes a real Uniswap v2 Swap: SPCX / WETH, WETH in and SPCX out is a buy of SPCX", () => {
  const pair = FIX.pool;
  assert.equal(FIX.factory, FACTORY);
  assert.deepEqual(swapOf(FIX.log, pair, true), { tx: FIX.log.transactionHash, index: 60, ts: 0x6af7e684, side: "b" });
  assert.equal(swapOf(FIX.log, pair, false).side, "s", "the same swap seen from WETH is a sell of it");
  // hostile logs: another emitter, another topic, a short body, a fourth topic
  assert.equal(swapOf({ ...FIX.log, address: WETH }, pair, true), null);
  assert.equal(swapOf({ ...FIX.log, topics: [TOPIC.swap2, ...FIX.log.topics.slice(1)] }, pair, true), null);
  assert.equal(swapOf({ ...FIX.log, data: FIX.log.data.slice(0, -64) }, pair, true), null);
  assert.equal(swapOf({ ...FIX.log, topics: [...FIX.log.topics, FIX.log.topics[1]] }, pair, true), null);
});

test("good: the deployed helper, every swap of the window on the tape: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("ok ")).length, 2);
});

test("bad_live: the helper before Uniswap v2 was a Base venue, an empty tape and no candles: FAIL", () => {
  const r = judge(A.bad_live);
  assert.equal(r.verdict, "FAIL");
  assert.equal(bad(r).length, 3, r.lines.join("\n"));
  assert.ok(bad(r).filter((l) => / is not on the tape \(0 rows\)$/.test(l)).length === 2, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /1m candles answered 404/.test(l)), r.lines.join("\n"));
});

test("planted from the good answer: FAIL on a wrong answer, INCONCLUSIVE on nothing to judge", () => {
  const swapped = A.good.tokens[0].swaps.find((s) => A.good.tokens[0].tape.rows.some((r) => r.tx === s.tx));
  for (const [what, run, want, verdict = "FAIL"] of [
    ["a swap left off the tape", tok(A.good, 0, (t) => ({ ...t, tape: { ...t.tape, rows: t.tape.rows.filter((r) => r.tx !== swapped.tx) } })), /is not on the tape/],
    ["a swap's side the other way", tok(A.good, 0, (t) => ({ ...t, tape: { ...t.tape, rows: t.tape.rows.map((r) => (r.tx === swapped.tx ? { ...r, side: r.side === "b" ? "s" : "b" } : r)) } })), /on the chain, the tape says/],
    ["a vendor's tape", tok(A.good, 1, (t) => ({ ...t, tape: { ...t.tape, src: "coingecko" } })), /src is "coingecko", not "chain"/],
    ["a tape 503", tok(A.good, 1, (t) => ({ ...t, tape: { ...t.tape, status: 503, rows: null } })), /the tape answered 503/],
    ["candles from the vendor alone", tok(A.good, 0, (t) => ({ ...t, candles: { ...t.candles, src: "coingecko" } })), /not from our chain reads/],
    ["no bar at the newest swap's minute", tok(A.good, 0, (t) => ({ ...t, candles: { ...t.candles, bars: t.candles.bars.slice(0, -5) } })), /no 1m bar at \d+/],
    ["no candidate", { ...A.good, gt: 429, tokens: [] }, /answered 429: no candidate/, "INCONCLUSIVE"],
    ["no swap in the window", { ...A.good, tokens: A.good.tokens.map((t) => ({ ...t, swaps: [] })) }, /nothing checked/, "INCONCLUSIVE"],
    ["the providers not alike on the swaps", { ...A.good, tokens: A.good.tokens.map((t) => ({ ...t, swaps: null })) }, /not given alike by two providers/, "INCONCLUSIVE"],
    ["a pair another factory made", { ...A.good, tokens: A.good.tokens.map((t) => ({ ...t, confirm: { ...t.confirm, factory: BASE_VENUES.aerodromeV2 } })) }, /not a Uniswap v2 WETH pair of the token on chain/, "INCONCLUSIVE"],
  ]) {
    const r = judge(run);
    assert.equal(r.verdict, verdict, `${what}\n${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => want.test(l)), `${what}\n${r.lines.join("\n")}`);
  }
});

test("a full tape judges only the swaps no older than its oldest row; a swap past its as_of_ms is not judged", () => {
  const t0 = A.good.tokens[0];
  assert.equal(t0.tape.rows.length, TRADES_MAX, "the good answer's first tape is full");
  const oldest = Math.min(...t0.tape.rows.map((r) => r.t_ms));
  const older = { tx: `0x${"ee".repeat(32)}`, index: 0, ts: Math.floor(oldest / 1000) - 60, side: "b" };
  const later = { tx: `0x${"dd".repeat(32)}`, index: 0, ts: Math.ceil(t0.tape.as_of_ms / 1000) + 1, side: "b" };
  assert.equal(judge(tok(A.good, 0, (t) => ({ ...t, swaps: [...t.swaps, older, later] }))).verdict, "PASS");
});

test("candidates: a token counts only when its every pool with a trade in the hour is the Uniswap v2 pair", async () => {
  const T = ["0x" + "11".repeat(20), "0x" + "22".repeat(20), "0x" + "33".repeat(20)];
  const P = ["0x" + "a1".repeat(20), "0x" + "a2".repeat(20), "0x" + "a3".repeat(20)];
  const pool = (p, base, quote) => ({ attributes: { address: p }, relationships: { base_token: { data: { id: `base_${base}` } }, quote_token: { data: { id: `base_${quote}` } } } });
  const active = (p, n) => ({ attributes: { address: p, transactions: { h1: { buys: n, sells: 0 } } } });
  const answers = {
    list: { data: [pool(P[0], T[0], WETH), pool(P[1], WETH, T[1]), pool(P[2], T[2], "0x" + "44".repeat(20))] },
    [T[0]]: { data: [active(P[0], 5), active("0x" + "b1".repeat(20), 0)] },
    [T[1]]: { data: [active(P[1], 5), active("0x" + "b2".repeat(20), 2)] },
  };
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    const m = /\/tokens\/(0x[0-9a-f]{40})\/pools$/.exec(url);
    const body = m ? answers[m[1]] : answers.list;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  };
  PACE.gtMs = 0;
  const { gt, list } = await candidates(fetchFn);
  assert.equal(gt, 200);
  assert.deepEqual(list, [{ coin: T[0], pair: P[0] }], "T1 has another pool trading this hour; T2's pair is quoted in no WETH");
  assert.equal(asked.length, 3, "the pool list and the two WETH pairs' tokens");
});

test("card v2-tape-check-waits-for-the-open: a tape answered from the vendor's held rows (a cold open past its bound serves them while it fills: card evm-vendor-tape-late-open-serves-held) is read again, never taken as the helper's last word; one from the chain dated past the newest swap ends the reads (red at main 4be15c065: live run 45276410984 judged 0x3c46ca0b's one read after the chain reads, src coingecko, as the helper not reading the pair, and the helper read it from the chain at its next ask)", async () => {
  const { settled } = await import("./base-uniswap-v2-tape.mjs");
  const at = 1_795_473_420_000;
  const tape = (src, as_of_ms) => ({ status: 200, src, as_of_ms, filling: false, rows: [] });
  assert.equal(settled(tape("coingecko", at), 0), false, "a vendor answer is read again, even with no swap to wait for");
  assert.equal(settled(tape("coingecko", at), at - 60_000), false, "a vendor answer dated past the newest swap is read again");
  assert.equal(settled(tape("chain", at), 0), true, "a chain answer with no swap to wait for ends the reads");
  assert.equal(settled(tape("chain", at), at - SETTLE_MS), true, "a chain answer dated SETTLE_MS past the newest swap ends them");
  assert.equal(settled(tape("chain", at), at - SETTLE_MS + 1), false, "a chain answer short of the newest swap is read again");
  assert.equal(settled({ ...tape("chain", at), status: 503 }, 0), false, "a 503 is read again");
  assert.equal(settled(tape("chain", null), 0), false, "an answer with no as_of_ms is read again");
});
