// node --test scripts/live-checks/near-pair-on-keyed-providers.test.mjs: the live check replays recorded answers
// (near-pair-on-keyed-providers.answers.json; the keys are on the helper box only). good: this card's helper in-process,
// made-up keyed FastNear and dRPC URLs whose sends went to the same companies' free endpoints, four fee quotes 200:
// PASS. bad_429: the good run with one fee call answered 429 rate_limited, as helper live run 43432500633 read it:
// FAIL. bad_pre_card: the deployed helper before the card, read live with --record (no X-Helper-Near-Pair): FAIL.
// Planted from the good one: a free endpoint in the pair, one company twice, dRPC first, a URL in the header, a pair
// member not in rpc.near, a fee call missing, calls spanning past 10 s: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FEE_CALLS, FEE_GAP_MS, HEADER, judge, read, USDC } from "./near-pair-on-keyed-providers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-pair-on-keyed-providers.answers.json"), "utf8"));

/** A fetch that answers a recorded run: /v1/health with its pair header, then each fee call in order. */
function replay(a) {
  let fee = 0;
  return async (url, init) => {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    const u = new URL(url);
    if (u.pathname === "/v1/health") return new Response(a.health.body, { status: a.health.status, headers: a.health.pair === null ? {} : { [HEADER]: a.health.pair } });
    assert.equal(u.pathname, "/v1/withdraw/fee");
    assert.equal(u.searchParams.get("token"), USDC);
    const f = a.fees[fee++];
    return new Response(f.body, { status: f.status, headers: f.retry_after === null ? {} : { "retry-after": f.retry_after } });
  };
}
/** The run as read() reads it from the replay, on the recorded clock: the calls FEE_GAP_MS apart. */
async function replayed(a) {
  let t = a.fees[0]?.at ?? 0;
  const r = await read("http://127.0.0.1:18742", replay(a), async (ms) => void (t += ms), () => t);
  return r;
}

test("recorded good answer (this card's helper: FastNear and dRPC's keys as the pair, four fee quotes 200 in one window): PASS", async () => {
  const r = judge(await replayed(A.good));
  assert.ok(r.ok, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  x-helper-near-pair: two different companies (fastnear.com, drpc.org)"), r.lines.join("\n"));
  assert.ok(judge(A.good).ok, "the recording as written passes too");
});

test("recorded bad answer (a fee call 429 rate_limited, helper live run 43432500633): FAIL", async () => {
  const r = judge(await replayed(A.bad_429));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD GET /v1/withdraw/fee #2: 429 rate_limited retry-after 10 (want 200)"), r.lines.join("\n"));
});

test("recorded bad answer (the deployed helper before the card: no pair header): FAIL", async () => {
  const r = judge(await replayed(A.bad_pre_card));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('BAD x-helper-near-pair: null names not two providers'), r.lines.join("\n"));
});

test("planted from the good answer: a free endpoint, one company twice, dRPC first, a URL, a member not listed, a call missing, a span past 10 s: FAIL", () => {
  const g = A.good;
  const withPair = (pair) => ({ ...g, health: { ...g.health, pair } });
  for (const [what, a] of [
    ["the free dRPC endpoint", withPair("fastnear.com, drpc.org keyless")],
    ["the free FastNEAR endpoint", withPair("fastnear.com keyless, drpc.live")],
    ["dRPC twice", withPair("fastnear.com, drpc.org")],
    ["FastNear twice", withPair("fastnear.com, fastnear.com")],
    ["dRPC first", withPair("drpc.live, fastnear.com")],
    ["one provider", withPair("fastnear.com")],
    ["a URL", withPair("https://rpc.mainnet.fastnear.com?apiKey=x, drpc.live")],
    ["not in rpc.near", { ...g, health: { ...g.health, body: JSON.stringify({ ...JSON.parse(g.health.body), rpc: { ...JSON.parse(g.health.body).rpc, near: ["fastnear.com answers"] } }) } }],
    ["a fee call missing", { ...g, fees: g.fees.slice(1) }],
    ["a 503", { ...g, fees: g.fees.map((f, i) => (i === 3 ? { ...f, status: 503, body: '{"error":{"code":"upstream"}}' } : f)) }],
    ["past one window", { ...g, fees: g.fees.map((f, i) => ({ ...f, at: g.fees[0].at + i * 4_000 })) }],
    ["health 503", { ...g, health: { ...g.health, status: 503 } }],
  ]) {
    const r = judge(a);
    assert.equal(r.ok, false, `${what}: ${r.lines.join("\n")}`);
  }
});

test("the recorded runs are the check's own shape: FEE_CALLS calls about FEE_GAP_MS apart", () => {
  for (const k of ["good", "bad_429", "bad_pre_card"]) {
    assert.equal(A[k].fees.length, FEE_CALLS, k);
    for (let i = 1; i < FEE_CALLS; i++) assert.ok(A[k].fees[i].at - A[k].fees[i - 1].at >= FEE_GAP_MS, `${k} #${i}`);
  }
});
