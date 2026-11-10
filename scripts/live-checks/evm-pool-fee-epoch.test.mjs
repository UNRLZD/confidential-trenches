// The shared EVM fee reader's rules (card evm-fee-quiet-epoch, evm-pool-fee-epoch.mjs): the helper's no block yet (503
// index_behind) and 404 not_found each get one more ask, for the epoch before; any other answer is returned as it came.
//   node --test scripts/live-checks/evm-pool-fee-epoch.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { epochOf, evmPoolFeeAsk, feeUrl, noBlockYet, notFound } from "./evm-pool-fee-epoch.mjs";

const POOL = "0xed9fac860e6bc5e932455232eedca8b71c44da4d";
const BASE = "https://ct-api.unrealized.trade";
const NOW = 1_800_000_000_400; // 0.4 s into the epoch 1_800_000_000_000
const OK = { status: 200, body: { pool: POOL } };
const BEHIND = { status: 503, body: { error: { code: "index_behind" } } };
const NF = { status: 404, body: '{"error":{"code":"not_found"}}' }; // a body kept as text is read too

test("the URL: the pool, and the epoch when one is named", () => {
  assert.equal(feeUrl(`${BASE}/`, POOL), `${BASE}/v1/pool/fee?pool=${POOL}`);
  assert.equal(feeUrl(BASE, POOL, 1_800_000_000_000), `${BASE}/v1/pool/fee?pool=${POOL}&epoch=1800000000000`);
  assert.equal(epochOf(NOW), 1_800_000_000_000);
});

test("no block yet and not found are told apart from every other answer", () => {
  assert.equal(noBlockYet(BEHIND), true);
  assert.equal(noBlockYet({ status: 503, body: { error: { code: "upstream" } } }), false, "a provider's fault is not no block yet");
  assert.equal(noBlockYet({ status: 404, body: BEHIND.body }), false);
  assert.equal(notFound(NF), true);
  assert.equal(notFound({ status: 404, body: "not json" }), false);
  assert.equal(notFound(OK), false);
});

test("a 200 is the answer, one ask; no block yet or not found asks the epoch before once and returns that", async () => {
  for (const [first, epochMs, before] of [
    [BEHIND, undefined, 1_799_999_940_000],
    [NF, undefined, 1_799_999_940_000],
    [BEHIND, 1_799_999_940_000, 1_799_999_880_000],
  ]) {
    const asked = [];
    const r = await evmPoolFeeAsk(async (u) => (asked.push(u), asked.length === 1 ? first : OK), BASE, POOL, { epochMs, nowMs: NOW });
    assert.deepEqual(asked, [feeUrl(BASE, POOL, epochMs), feeUrl(BASE, POOL, before)]);
    assert.deepEqual(r, { answer: OK, epochMs: before, first });
  }
  const asked = [];
  assert.deepEqual(await evmPoolFeeAsk(async (u) => (asked.push(u), OK), BASE, POOL, { nowMs: NOW }), { answer: OK, epochMs: undefined, first: null });
  assert.equal(asked.length, 1);
  // a 503 upstream (a provider's fault) and a 429 are returned as they came, never stepped past
  for (const a of [{ status: 503, body: { error: { code: "upstream" } } }, { status: 429, body: { error: { code: "rate_limited" } } }]) {
    const n = [];
    assert.equal((await evmPoolFeeAsk(async (u) => (n.push(u), a), BASE, POOL, { nowMs: NOW })).answer, a);
    assert.equal(n.length, 1);
  }
  // a pool not carried: 404 to both, the second returned
  assert.equal((await evmPoolFeeAsk(async () => NF, BASE, POOL, { nowMs: NOW })).answer, NF);
});
