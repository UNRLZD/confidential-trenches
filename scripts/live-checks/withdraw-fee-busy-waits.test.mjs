// node --test scripts/live-checks/withdraw-fee-busy-waits.test.mjs: the live check replays recorded answers
// (withdraw-fee-busy-waits.answers.json). good: the deployed helper, both fee routes 200 with Retry-After exposed: PASS.
// good_busy: this card's helper with its providers down, both routes 503 upstream with Retry-After 2: PASS.
// bad_pre_card: origin/main's helper the same way, 503 upstream with no Retry-After: FAIL. Planted from them: a 500, a
// busy answer with another code, a Retry-After of 0 or past 75, Retry-After not exposed, another origin: FAIL; a route
// that answers nothing: INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asks, DEVNET_POOL, judge, MAINNET_USDC, read, SIGN } from "./withdraw-fee-busy-waits.mjs";
import { TOKENS } from "./relayer-withdraw-fee.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "withdraw-fee-busy-waits.answers.json"), "utf8"));

/** A fetch that answers each asked path with its recorded read, and checks the ask is the device's. */
const replay = (run) => async (url, init) => {
  const u = new URL(url);
  const r = run.reads.find((x) => x.asked === `${u.pathname}${u.search}`);
  assert.ok(r, `asked ${u.pathname}${u.search}`);
  assert.equal(init.headers.origin, SIGN);
  if (r.noAnswer !== undefined) throw new TypeError("fetch failed");
  return new Response(r.body, { status: r.status, headers: r.headers });
};
const edit = (run, route, f) => ({ ...run, reads: run.reads.map((r) => (r.route === route ? f(structuredClone(r)) : r)) });

test("the check asks the device's two fee routes: mainnet USDC (relayer-withdraw-fee's) and the devnet pool of its deploy record", () => {
  assert.equal(MAINNET_USDC, TOKENS.mainnet);
  assert.deepEqual(asks().map((a) => a.path), [`/v1/withdraw/fee?token=${MAINNET_USDC}`, `/v1/pool/fee?cluster=devnet&pool=${DEVNET_POOL}`]);
});

test("recorded good answer (the deployed helper, both routes 200, Retry-After exposed): PASS", async () => {
  const r = judge(await read(A.good.base, replay(A.good)));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded good busy answer (this card's helper, its providers down: 503 upstream, Retry-After 2): PASS", async () => {
  const r = judge(await read(A.good_busy.base, replay(A.good_busy)));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad answer (origin/main's helper, its providers down: 503 upstream naming no wait): FAIL", async () => {
  const r = judge(await read(A.bad_pre_card.base, replay(A.bad_pre_card)));
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.lines.some((l) => /^BAD \[withdraw-fee\] 503 names its wait: Retry-After none/.test(l)), r.lines.join("\n"));
});

test("planted: a 500, a busy status with another code, a Retry-After of 0 or past 75, Retry-After not exposed, another origin: FAIL; no answer: INCONCLUSIVE", () => {
  const busy = A.good_busy;
  for (const [what, run] of [
    ["a 500", edit(A.good, "withdraw-fee", (r) => ({ ...r, status: 500, body: '{"error":"internal"}' }))],
    ["a 404", edit(A.good, "pool-fee", (r) => ({ ...r, status: 404, body: '{"error":{"code":"not_found"}}' }))],
    ["a 503 with another code", edit(busy, "withdraw-fee", (r) => ({ ...r, body: '{"error":{"code":"relayer_low"}}' }))],
    ["a 429 with the 503's code", edit(busy, "pool-fee", (r) => ({ ...r, status: 429 }))],
    ["Retry-After 0", edit(busy, "withdraw-fee", (r) => ((r.headers["retry-after"] = "0"), r))],
    ["Retry-After 76", edit(busy, "pool-fee", (r) => ((r.headers["retry-after"] = "76"), r))],
    ["Retry-After as a date", edit(busy, "pool-fee", (r) => ((r.headers["retry-after"] = "Mon, 09 Nov 2026 12:00:00 GMT"), r))],
    ["Retry-After not exposed", edit(A.good, "withdraw-fee", (r) => ((r.headers["access-control-expose-headers"] = "X-Helper-Commit"), r))],
    ["another origin", edit(A.good, "pool-fee", (r) => ((r.headers["access-control-allow-origin"] = "*"), r))],
    ["a 200 that is not the fee", edit(A.good, "withdraw-fee", (r) => ({ ...r, body: '{"relay_fee":"1"}' }))],
    ["a 200 for another pool", edit(A.good, "pool-fee", (r) => ({ ...r, body: JSON.stringify({ ...JSON.parse(r.body), pool: "x" }) }))],
    ["a route missing", { ...A.good, reads: A.good.reads.slice(0, 1) }],
  ]) assert.equal(judge(run).verdict, "FAIL", what);
  const quiet = judge(edit(A.good, "pool-fee", (r) => ({ route: r.route, asked: r.asked, noAnswer: "127.0.0.1: no answer (ECONNREFUSED)" })));
  assert.equal(quiet.verdict, "INCONCLUSIVE", quiet.lines.join("\n"));
});
