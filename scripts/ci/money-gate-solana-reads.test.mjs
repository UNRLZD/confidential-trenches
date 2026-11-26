// node --test scripts/ci/money-gate-solana-reads.test.mjs (card money-gate-solana-reads-on-two-operators): replays the
// recorded runs of money-gate-solana-reads.mjs (money-gate-solana-reads.answers.json, read from the Mac on 2026-11-26) through the money gate's
// own code, with no network and no waits. The good run, on the gate's list after the card, PASSes: each tx read ok on
// api.mainnet-beta and Tatum. The bad run, on the list before it, FAILs: Solana Vibe Station refused every connection and
// PublicNode answered null before its first block, so each tx read ok on one operator. Planted: the good run with Tatum
// refusing the connection FAILs the same way, and the gate's list is the good run's, three operators by the gate's map.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RPCS } from "./money-gate.mjs";
import { RPC_OPERATORS } from "./rpc-operators.mjs";
import { BEFORE, check, TXS } from "./money-gate-solana-reads.mjs";

const A = JSON.parse(readFileSync(new URL("./money-gate-solana-reads.answers.json", import.meta.url), "utf8"));
const TATUM = "https://solana-mainnet.gateway.tatum.io";
const still = async () => {};

// each request gets the recorded answers to the same request in order, the last one again once they run out; a recorded
// no-reply throws as fetch does
function replay(answers) {
  const queues = new Map();
  for (const a of answers) {
    const k = `${a.url} ${a.method} ${JSON.stringify(a.params)}`;
    queues.set(k, [...(queues.get(k) ?? []), a]);
  }
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const q = queues.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!q) throw new Error(`no recorded answer for ${method} on ${url}`);
    const a = q.length > 1 ? q.shift() : q[0];
    if (a.error !== undefined) throw new TypeError(a.error);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (k) => (k.toLowerCase() === "retry-after" ? (a.retryAfter ?? null) : null) }, text: async () => a.text };
  };
}

test("the good run, on the gate's list today, passes: each tx read ok on two operators", async () => {
  const r = await check({ fetchFn: replay(A.good.answers), solana: A.good.solana, sleep: still });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.lines, TXS.map((t) => `GOOD ${t.slice(0, 8)} read ok on 2 operator(s) (solana, tatum)`));
});

test("the bad run, on the list before the card, fails: Vibe Station refused, PublicNode had no history, one operator read each", async () => {
  const r = await check({ fetchFn: replay(A.bad.answers), solana: A.bad.solana, sleep: still });
  assert.equal(r.ok, false);
  assert.equal(r.lines.length, TXS.length);
  for (const [i, t] of TXS.entries()) {
    assert.match(r.lines[i], new RegExp(`^BAD ${t.slice(0, 8)} read ok on 1 operator\\(s\\) \\(solana\\): `));
    assert.match(r.lines[i], /no answer \(fetch failed\) on https:\/\/public\.rpc\.solanavibestation\.com/);
  }
});

test("planted: the good run with Tatum refusing every connection fails on one operator, never a pass", async () => {
  const answers = A.good.answers.map((a) => (a.url === TATUM ? { url: a.url, method: a.method, params: a.params, error: "fetch failed" } : a));
  const r = await check({ fetchFn: replay(answers), solana: A.good.solana, sleep: still });
  assert.equal(r.ok, false);
  for (const l of r.lines) assert.match(l, /^BAD \S+ read ok on 1 operator\(s\) \(solana\): /);
});

test("the gate's Solana list is the good run's, three operators by the gate's map; the bad run's is the list before", () => {
  assert.deepEqual(RPCS.solana, A.good.solana);
  assert.deepEqual(BEFORE, A.bad.solana);
  const ops = RPCS.solana.map((u) => RPC_OPERATORS.solana[new URL(u).host]);
  assert.ok(ops.every((o) => typeof o === "string"), ops.join(","));
  assert.equal(new Set(ops).size, 3);
  assert.ok(!RPCS.solana.some((u) => u.includes("solanavibestation")));
});
