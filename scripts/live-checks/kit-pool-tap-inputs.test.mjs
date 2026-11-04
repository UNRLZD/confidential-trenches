// Replays kit-pool-tap-inputs.answers.json through the live check: `good` (a real run on the six public RPCs, its time
// in `read`) passes; `bad` (that run with one RPC's Pyth account answering another price) fails on the disagreement. The
// good run also fails when replayed long after it was read (stale), when one RPC's Chainlink round is another, when a
// feed's description is not ETH / USD, when the two ETH/USD feeds are far apart, and when a chain's two RPCs are one.
//   node --test scripts/live-checks/kit-pool-tap-inputs.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, RPCS } from "./kit-pool-tap-inputs.mjs";

const A = JSON.parse(readFileSync(new URL("./kit-pool-tap-inputs.answers.json", import.meta.url), "utf8"));

/** A Solana read's params without minContextSlot: a re-read at a newer slot gets the recorded answer again. */
const key = (params) => JSON.stringify(params.map((x) => (x !== null && typeof x === "object" && !Array.isArray(x) ? { ...x, minContextSlot: undefined } : x)));
/** fetch that answers each JSON-RPC call from the recording, by url, method and params, with the request's id: each
 * recorded answer once, then the last one again (the kit's re-reads of a disagreement). */
function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    const match = (a) => a.url === url && a.method === method && key(a.params) === key(params);
    let i = answers.findIndex((a, j) => !used.has(j) && match(a));
    if (i < 0) i = answers.findLastIndex(match);
    if (i < 0) throw new Error(`no recorded answer for ${method} on ${url}`);
    used.add(i);
    return new Response(JSON.stringify({ ...answers[i].json, id }), { status: answers[i].status });
  };
}
const run = (rec, opts = {}) => check({ fetchFn: replay(rec.answers), nowMs: rec.nowMs, ...opts });
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};
/** The good recording with every answer `pick` selects changed by `f`. */
function mutate(pick, f) {
  const out = structuredClone(A.good);
  let n = 0;
  for (const a of out.answers) if (pick(a)) (f(a.json), n++);
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const isCall = (data) => (a) => a.method === "eth_call" && a.params[0]?.data === data;

test("the recorded good run passes: every chain's price agreed on both RPCs, fresh, and $100 in base units", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 12);
  for (const chain of Object.keys(RPCS)) assert.ok(r.lines.some((l) => l.startsWith(`PASS ${chain}: $100 is `)), chain);
});

test("the recorded bad run fails: the two Solana RPCs disagree on the Pyth account", async () => {
  fails(await run(A.bad), /solana: pyth .*the two RPCs disagree on the Pyth account/);
});

test("the good run replayed two hours later fails: every price is stale, Robinhood's through Base's, which holds it", async () => {
  const r = await run(A.good, { nowMs: A.good.nowMs + 2 * 3600_000 });
  fails(r, /solana: .*older than 60 s/);
  fails(r, /base: .*older than 1500 s/);
  // Robinhood's own feed is inside its 24 h bound; the Base read that holds it is not
  fails(r, /robinhood: chainlink .*older than 1500 s/);
});

test("one RPC's Chainlink round that is another fails, a description that is not ETH / USD fails", async () => {
  const [, u1] = RPCS.base;
  const other = mutate((a) => a.url === u1 && isCall("0xfeaf968c")(a), (j) => (j.result = j.result.slice(0, 65) + (parseInt(j.result[65], 16) ^ 1).toString(16) + j.result.slice(66)));
  fails(await run(other), /base: .*the two RPCs disagree on roundId/);
  const desc = mutate((a) => a.url === RPCS.robinhood[0] && isCall("0x7284e416")(a), (j) => (j.result = j.result.replace("455448202f20555344", "425443202f20555344")));
  fails(await run(desc), /robinhood: the feed .*description\(\).*"BTC \/ USD"/);
});

test("Base and Robinhood ETH/USD far apart fails", async () => {
  // Robinhood's answer word, on both RPCs, doubled
  const far = mutate((a) => RPCS.robinhood.includes(a.url) && isCall("0xfeaf968c")(a), (j) => {
    const h = j.result.slice(2);
    const w = (BigInt(`0x${h.slice(64, 128)}`) * 2n).toString(16).padStart(64, "0");
    j.result = `0x${h.slice(0, 64)}${w}${h.slice(128)}`;
  });
  fails(await run(far), /robinhood: chainlink .*more than 100 bps from Base's/);
});

test("one operator twice on a chain fails", async () => {
  fails(await run(A.good, { rpcs: { ...RPCS, base: [RPCS.base[0], RPCS.base[0]] } }), /base: two operators/);
});
