// Replays card evm-fee-quiet-epoch's live check on its recorded answers (evm-fee-quiet-epoch.answers.json).
// Good: `good`, a real run of this card's helper code in process (--local: server.ts's handler on 127.0.0.1, the deploy
// records' EVM pools with a throwaway sender key, nothing sent) over the kit's providers, at a minute's turn: every ask
// 200 or 503 index_behind with a wait, never 404. Bad: `bad`, a real run against the deployed helper before this card
// (https://ct-api.unrealized.trade at f8945cd4) at a minute's turn: robinhood-testnet's pool, which it carries,
// answered 404 not_found for the asks before its provider held the minute's first block.
//   node --test scripts/live-checks/evm-fee-quiet-epoch.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { noAnswerHosts } from "../ci/live-rerun.mjs";
import { collect, judge, NOT_CARRIED, TURN_OFFSETS_MS } from "./evm-fee-quiet-epoch.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-fee-quiet-epoch.answers.json", import.meta.url), "utf8"));

test("the good answer (this card's helper, at a minute's turn) passes: no carried pool answered 404", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(A.good.runs.length >= 2, "the deploy records' EVM pools");
});

test("the bad answer (the deployed helper before this card, at a minute's turn) fails on a 404 for a pool it carries", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD ") && l.includes("404 for a pool it carries")), r.lines.join("\n"));
});

// planted runs, made from a pool's 200 at the turn
const POOL = "0xed9fac860e6bc5e932455232eedca8b71c44da4d";
const NET = "robinhood-testnet";
const TURN = 1_800_000_000_000;
const ok = (epochMs) => ({ status: 200, retryAfter: null, body: JSON.stringify({ chain: "evm", network: NET, pool: POOL, epoch_ms: 60_000, epoch_start_ms: epochMs, block: "0x1", fee: "1" }) });
const BEHIND = { status: 503, retryAfter: "1", body: '{"error":{"code":"index_behind"}}' };
const NF = { status: 404, retryAfter: null, body: '{"error":{"code":"not_found"}}' };
const runWith = (turnAnswers, before = ok(TURN - 60_000), notCarried = NF) => ({
  base: "https://ct-api.unrealized.trade",
  turnMs: TURN,
  runs: [{ network: NET, pool: POOL, turn: TURN_OFFSETS_MS.map((o, i) => ({ network: NET, pool: POOL, offsetMs: o, askedMs: TURN + o, answer: turnAnswers[i] ?? turnAnswers.at(-1) })), before }],
  notCarried,
});

test("planted: 200 or 503 index_behind with a wait at the turn PASS; a 404, a 503 index_behind with no wait, another pool's or epoch's 200 FAIL", () => {
  assert.equal(judge(runWith([ok(TURN)])).verdict, "PASS");
  assert.equal(judge(runWith([BEHIND, BEHIND, ok(TURN)])).verdict, "PASS", "no block yet, then the fee");
  assert.equal(judge(runWith([ok(TURN - 60_000), ok(TURN)])).verdict, "PASS", "a helper clock a moment behind");
  assert.equal(judge(runWith([NF, ok(TURN)])).verdict, "FAIL", "a 404 for a carried pool");
  assert.equal(judge(runWith([{ ...BEHIND, retryAfter: null }])).verdict, "FAIL", "no block yet with no wait");
  assert.equal(judge(runWith([ok(TURN - 120_000)])).verdict, "FAIL", "an epoch two back");
  assert.equal(judge(runWith([{ ...ok(TURN), body: ok(TURN).body.replace(POOL, `0x${"1".repeat(40)}`) }])).verdict, "FAIL", "another pool");
  assert.equal(judge(runWith([ok(TURN)], BEHIND)).verdict, "FAIL", "the epoch before has no block");
  assert.equal(judge(runWith([ok(TURN)], ok(TURN))).verdict, "FAIL", "the epoch before answered for another epoch");
  assert.equal(judge(runWith([ok(TURN)], ok(TURN - 60_000), ok(TURN))).verdict, "FAIL", "the address no helper carries answered 200");
  assert.equal(judge(runWith([ok(TURN)], ok(TURN - 60_000), BEHIND)).verdict, "FAIL", "the address no helper carries answered 503");
  const short = runWith([ok(TURN)]);
  short.runs[0].turn.pop();
  assert.equal(judge(short).verdict, "FAIL", "an ask missing");
  assert.equal(judge({ ...runWith([ok(TURN)]), runs: [] }).verdict, "FAIL", "no pool");
});

test("planted: no answer from the helper (a timeout, a 429, a 503 upstream) is INCONCLUSIVE, named as live-rerun reads it; never a pass", () => {
  for (const none of [{ error: "TimeoutError" }, { status: 429, retryAfter: "1", body: '{"error":{"code":"rate_limited"}}' }, { status: 503, retryAfter: "2", body: '{"error":{"code":"upstream"}}' }]) {
    for (const r of [judge(runWith([ok(TURN), none])), judge(runWith([ok(TURN)], none)), judge(runWith([ok(TURN)], ok(TURN - 60_000), none))]) {
      assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
      assert.deepEqual(noAnswerHosts(r.lines.join("\n")), ["ct-api.unrealized.trade"], r.lines.join("\n"));
    }
    // a wrong answer beside it still FAILs
    assert.equal(judge(runWith([NF, none])).verdict, "FAIL");
  }
});

test("collect waits for the next minute's turn, asks each pool at every offset after it, then the epoch before and an address no helper carries", async () => {
  let t = TURN - 59_000;
  const asked = [];
  const fetchFn = async (url) => {
    asked.push([url, t]);
    const u = new URL(url);
    const pool = u.searchParams.get("pool");
    const epoch = u.searchParams.get("epoch");
    if (pool === NOT_CARRIED) return new Response(NF.body, { status: 404 });
    return new Response(ok(epoch === null ? TURN : Number(epoch)).body, { status: 200 });
  };
  const run = await collect("https://h.test", fetchFn, { [NET]: POOL, base: null }, { now: () => t, wait: async (ms) => void (t += ms) });
  assert.equal(run.turnMs, TURN);
  const turn = asked.slice(0, TURN_OFFSETS_MS.length);
  assert.ok(turn.every(([u, at]) => u === `https://h.test/v1/pool/fee?pool=${POOL}` && at >= TURN), JSON.stringify(turn));
  assert.deepEqual(asked.slice(TURN_OFFSETS_MS.length).map(([u]) => u), [`https://h.test/v1/pool/fee?pool=${POOL}&epoch=${TURN - 60_000}`, `https://h.test/v1/pool/fee?pool=${NOT_CARRIED}`]);
  assert.equal(judge({ base: "https://h.test", ...run }).verdict, "PASS", judge(run).lines.join("\n"));
});
