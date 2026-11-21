// node --test scripts/live-checks/robinhood-pool-logs-on-keyed-route.test.mjs: the live check replays recorded answers
// (robinhood-pool-logs-on-keyed-route.answers.json, each side as rpcAnswer read it). good: the deployed helper read live
// 14 Nov 05:4xZ, Alchemy's logs timed and Robinhood's own logged blockTimestamp 0x0: PASS. bad_live: the deployed helper
// read live 13 Nov 16:26Z, both spans {"code":"upstream"}: FAIL. Planted from the good one: dRPC free's code-35 refusal,
// a log the route lacks, a log changed, no keyed name in Server-Timing, one span missing: FAIL; the same logs with keys in
// another order: PASS; a 429 on one side: INCONCLUSIVE, never PASS. A blockTimestamp of 0x0 or none on either side is no
// time: PASS; two different times, or any other field different: FAIL. Card robinhood-reads-past-ten-million-blocks:
// good_paged, Robinhood's own whole history read in pages of its 10,000,000-block cap: PASS; bad_capped, the same read
// whole and refused -32602: FAIL; a planted 11,625,840-block history refused whole pages and gives every log: PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { FROM, judge, OWN, POOL, read, RECENT } from "./robinhood-pool-logs-on-keyed-route.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "robinhood-pool-logs-on-keyed-route.answers.json"), "utf8"));
const BASE = "http://127.0.0.1:18743";

/** The HTTP answer a recorded side stands for: a result 200, an error 503 (the helper's upstream), a no-answer 429. */
const http = (side) =>
  new Response(side.noAnswer !== undefined ? "" : JSON.stringify(side.error !== undefined ? { error: side.error } : { jsonrpc: "2.0", id: 1, result: side.result }), {
    status: side.noAnswer !== undefined ? 429 : side.error !== undefined ? 503 : 200,
    headers: side.kept?.["server-timing"] ? { "server-timing": side.kept["server-timing"] } : {},
  });
/** A fetch that answers a recorded run: the head on Robinhood's own RPC, then each span on the route and on the own RPC
 *  (a no-answer twice, as rpcAnswer reads it again once). */
function replay(a) {
  // an own side read in pages of its cap (ownLogs): its whole read refused as recorded, then each page's logs
  const left = a.spans.flatMap((s) => [["route", s], ...(s.own.capped ? [["own", { ...s, own: { error: s.own.capped.refusal } }], ...s.own.capped.pages.map(([pa, pb], i) => ["own", { ...s, from: pa, to: pb, own: i === s.own.capped.pages.length - 1 && !Array.isArray(s.own.result) ? s.own : { result: (s.own.result ?? []).filter((l) => Number(BigInt(l.blockNumber)) >= pa && Number(BigInt(l.blockNumber)) <= pb) } }])] : [["own", s]])]);
  let again;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "eth_blockNumber") {
      assert.equal(url, OWN);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${a.head.toString(16)}` }), { status: 200 });
    }
    const [side, s] = again ?? left.shift();
    again = s[side].noAnswer !== undefined && again === undefined ? [side, s] : undefined;
    assert.equal(url, side === "route" ? `${BASE}/v1/rpc/robinhood?keyed=only` : OWN);
    assert.equal(init.headers.origin, undefined, "no Origin: the route's 5xx is judged, not a passing fault");
    assert.deepEqual(body.params, [{ address: POOL, fromBlock: `0x${s.from.toString(16)}`, toBlock: `0x${s.to.toString(16)}` }]);
    return http(s[side]);
  };
}

test("recorded good answer (the deployed helper 14 Nov, Alchemy's logs timed, Robinhood's own 0x0): PASS (red at a6b7a3ad7: not the same logs)", async () => {
  const r = judge(await read(BASE, replay(A.good)));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(judge(A.good).verdict, "PASS", "the recording as written passes too");
  assert.equal(A.good.spans[0].to - A.good.spans[0].from + 1, RECENT);
  assert.equal(A.good.spans[1].from, FROM);
});

test("recorded bad answer (the deployed helper 13 Nov 16:26Z: upstream on both spans): FAIL", async () => {
  const r = judge(await read(BASE, replay(A.bad_live)));
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.lines.includes('BAD newest 100000 (100000 blocks): the keyed route answers error {"code":"upstream"}'), r.lines.join("\n"));
  assert.equal(judge(A.bad_live).verdict, "FAIL");
});

const LOG = { address: POOL, topics: ["0x" + "a".repeat(64)], data: "0x", blockNumber: "0x6765e43", transactionHash: "0x" + "b".repeat(64), logIndex: "0x0", removed: false };
const withSpan = (i, f) => ({ ...A.good, spans: A.good.spans.map((s, j) => (j === i ? f(structuredClone(s)) : s)) });

test("planted from the good answer: a cap refusal, a missing or changed log, no keyed name, a span missing: FAIL", async () => {
  for (const [what, a] of [
    ["dRPC free's code 35", withSpan(1, (s) => ({ ...s, route: { error: { message: "ranges over 10000 blocks are not supported on free plan", code: 35 } } }))],
    ["the route missing a log the own RPC has", withSpan(1, (s) => ({ ...s, own: { result: [LOG] } }))],
    ["a log changed on the route", withSpan(0, (s) => ({ ...s, route: { ...s.route, result: [{ ...LOG, data: "0x01" }] }, own: { result: [LOG] } }))],
    ["no keyed name in Server-Timing", withSpan(0, (s) => ({ ...s, route: { ...s.route, kept: { "server-timing": 'rpc-wait;dur=0, rpc;dur=0;desc="none"' } } }))],
    ["no Server-Timing at all", withSpan(1, (s) => ({ ...s, route: { result: s.route.result } }))],
    ["one span missing", { ...A.good, spans: A.good.spans.slice(0, 1) }],
    ["a result that is no list", withSpan(0, (s) => ({ ...s, route: { ...s.route, result: "0x" } }))],
  ]) {
    assert.equal(judge(a).verdict, "FAIL", what);
    // read() always reads both spans, so a recording missing one is judged as written only
    if (a.spans.length === 2) assert.equal(judge(await read(BASE, replay(a))).verdict, "FAIL", `${what}, replayed`);
  }
});

// live run 44930704040 (21 Nov, helper 8713b1ca3): Robinhood's own RPC refused the whole history, its 11,625,840 blocks,
// in these words; it answers any span of up to 10,000,000 blocks
const OWN_CAP = 10_000_000;
const refusal = (from, to) => ({ code: -32602, message: `query spans ${to - from} blocks (${from} to ${to}), but only ${OWN_CAP} are allowed for this request; try a smaller range or send one value per position` });
/** A planted chain of `blocks` blocks from the pool's deploy block: the route answers any span, Robinhood's own refuses a
 *  span over OWN_CAP as it does; the pool's logs at the blocks given. Returns the fetch and the own RPC's asks. */
function capped(blocks, at) {
  const head = FROM + blocks - 1;
  const logs = at.map((b, i) => ({ ...LOG, blockNumber: `0x${b.toString(16)}`, transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}` }));
  const asks = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    const ok = (result, headers = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers });
    if (body.method === "eth_blockNumber") return ok(`0x${head.toString(16)}`);
    const f = body.params[0];
    const [a, b] = [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))];
    const inside = logs.filter((l) => Number(BigInt(l.blockNumber)) >= a && Number(BigInt(l.blockNumber)) <= b);
    if (url !== OWN) return ok(inside, { "server-timing": 'rpc-wait;dur=0, rpc;dur=90;desc="ROBINHOOD_RPC_URL"' });
    asks.push([a, b]);
    if (b - a + 1 > OWN_CAP) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: refusal(a, b) }), { status: 200 });
    return ok(inside);
  };
  return { fetchFn, asks, head };
}

test("planted: Robinhood's own refuses the whole history past its 10,000,000-block cap, as live run 44930704040: its history is read in pages of that cap and every log is there, PASS (red at 9905e1da1: one whole read, refused)", async () => {
  const at = [FROM + 5, FROM + 4_000_000, FROM + 9_999_999, FROM + 10_000_000, FROM + 11_625_000];
  const { fetchFn, asks, head } = capped(11_625_840, at);
  const run = await read(BASE, fetchFn);
  const r = judge(run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  const whole = run.spans[1];
  assert.equal(whole.own.result.length, at.length, "every log of the history");
  assert.deepEqual(whole.own.capped.pages, [[FROM, FROM + OWN_CAP - 1], [FROM + OWN_CAP, head]]);
  assert.ok(asks.every(([a, b]) => b - a + 1 <= OWN_CAP || (a === FROM && b === head)), "no read past the cap but the one it refused");
  // the run as recorded replays
  assert.equal(judge(await read(BASE, replay(run))).verdict, "PASS", "replayed");
});

test("recorded good answer past the cap (this card's check on the deployed helper, 21 Nov): Robinhood's own whole history in 2 pages of its 10,000,000-block cap, the same 8 logs: PASS; the check at 9905e1da1 on the same helper, one whole read refused as live run 44930704040: FAIL", async () => {
  const r = judge(await read(BASE, replay(A.good_paged)));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(A.good_paged.spans[1].own.capped.cap, 10_000_000);
  assert.equal(A.good_paged.spans[1].own.capped.pages.length, 2);
  assert.ok(A.good_paged.spans[1].to - A.good_paged.spans[1].from + 1 > 10_000_000);
  assert.equal(judge(A.bad_capped).verdict, "FAIL");
  assert.ok(judge(A.bad_capped).lines.some((l) => l.startsWith("BAD whole history: Robinhood's own RPC answers error") && l.includes("-32602")));
});

test("planted: a page of the cap's that Robinhood's own does not answer is that side's: INCONCLUSIVE, never PASS; one it refuses is FAIL", async () => {
  for (const [bad, want] of [[(b) => ({ noAnswer: "x HTTP 429: 429 Too Many Requests" }), "INCONCLUSIVE"], [() => ({ error: { code: -32000, message: "boom" } }), "FAIL"]]) {
    const { fetchFn } = capped(11_625_840, [FROM + 5]);
    let pages = 0;
    const f = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === OWN && body.method === "eth_getLogs") {
        const p = body.params[0];
        if (Number(BigInt(p.toBlock)) - Number(BigInt(p.fromBlock)) + 1 <= OWN_CAP && Number(BigInt(p.fromBlock)) === FROM && pages++ >= 0 && BigInt(p.toBlock) - BigInt(p.fromBlock) > 100_000n) {
          const side = bad();
          return side.noAnswer !== undefined ? new Response("", { status: 429 }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: side.error }), { status: 200 });
        }
      }
      return fetchFn(url, init);
    };
    assert.equal(judge(await read(BASE, f)).verdict, want);
  }
});

test("planted from the good answer: the same logs with keys in another order: PASS", async () => {
  const re = Object.fromEntries(Object.entries(LOG).reverse());
  const a = withSpan(1, (s) => ({ ...s, route: { ...s.route, result: [re] }, own: { result: [LOG] } }));
  assert.equal(judge(await read(BASE, replay(a))).verdict, "PASS", judge(a).lines.join("\n"));
});

test("planted from the good answer: a 429 from the route or from Robinhood's own: INCONCLUSIVE, never PASS", async () => {
  for (const side of ["route", "own"]) {
    const a = withSpan(1, (s) => ({ ...s, [side]: { noAnswer: "x HTTP 429: 429 Too Many Requests" } }));
    assert.equal(judge(await read(BASE, replay(a))).verdict, "INCONCLUSIVE", side);
  }
});

// card robinhood-pool-logs-on-keyed-route, 14 Nov: Robinhood's own RPC logs blockTimestamp 0x0 on every log
// (apps/helper/src/data/evm/swaps.ts Log), Alchemy the block's time, so a log is the same on both but for a time one
// side does not give
const TIMED = { ...LOG, blockHash: "0x" + "c".repeat(64), blockTimestamp: "0x6af77850" };
const pair = (route, own) => withSpan(1, (s) => ({ ...s, route: { ...s.route, result: [route] }, own: { result: [own] } }));

test("planted: a blockTimestamp of 0x0 or none on one side is no time: PASS (red at a6b7a3ad7: not the same logs)", async () => {
  const { blockTimestamp: _, ...untimed } = TIMED;
  for (const [what, a] of [
    ["the own RPC's 0x0, the route's time", pair(TIMED, { ...TIMED, blockTimestamp: "0x0" })],
    ["the route's 0x0, the own RPC's time", pair({ ...TIMED, blockTimestamp: "0x0" }, TIMED)],
    ["the own RPC with no blockTimestamp, the route's time", pair(TIMED, untimed)],
  ]) {
    assert.equal(judge(a).verdict, "PASS", `${what}\n${judge(a).lines.join("\n")}`);
    assert.equal(judge(await read(BASE, replay(a))).verdict, "PASS", `${what}, replayed`);
  }
});

test("planted: two different times, or any other field different, with the other side's time 0x0: FAIL", async () => {
  const own = { ...TIMED, blockTimestamp: "0x0" };
  for (const [what, a, want] of [
    ["two times, different", pair(TIMED, { ...TIMED, blockTimestamp: "0x6af77851" }), /log 0 blockTimestamp/],
    ["data", pair({ ...TIMED, data: "0x01" }, own), /log 0 data/],
    ["topics", pair({ ...TIMED, topics: ["0x" + "d".repeat(64)] }, own), /log 0 topics/],
    ["logIndex", pair({ ...TIMED, logIndex: "0x1" }, own), /log 0 logIndex/],
    ["blockHash", pair({ ...TIMED, blockHash: "0x" + "e".repeat(64) }, own), /log 0 blockHash/],
    ["a field one side lacks", pair(TIMED, (({ transactionHash: _, ...x }) => x)(own)), /log 0 transactionHash/],
  ]) {
    const r = judge(a);
    assert.equal(r.verdict, "FAIL", what);
    assert.ok(r.lines.some((l) => l.startsWith("BAD") && want.test(l)), `${what}\n${r.lines.join("\n")}`);
    assert.equal(judge(await read(BASE, replay(a))).verdict, "FAIL", `${what}, replayed`);
  }
});
