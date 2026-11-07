// The refund move's builders and steps (card wallet-refund-move; src/deposit/refund.ts, wallet.md §2.4 point 8 and the
// §2.8 refund move row). The checks here are stand-ins that record what they were handed; SIGN_HOST's real rules run in
// packages/signpage/test/refund-move.test.ts. No key is real: the stand-in signer never reads the bytes it is handed.
//   node --test test/deposit-refund.test.ts   (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import { base64 } from "@scure/base";
import { DEPOSIT_QUOTE_URL } from "../src/deposit/quote.ts";
import { NONCE_V1_PREFIX, RELEASE_INTENTS_URL, REFUND_INTENT_WINDOW_MS, type RefundMoveCheck, RefundMoveUnderMin, refundMoveRequest, runRefundMove, transferPayload, versionedNonce } from "../src/deposit/refund.ts";

const U = "5d".repeat(32);
const ASSET = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const NOW = Date.parse("2026-11-07T14:00:00.000Z");
const T = BigInt(NOW - 2_000) * 1_000_000n;

test("the request is §2.4 point 8's: INTENTS in, the vault's asset to U on the token, refunds to U inside intents.near", () => {
  assert.deepEqual(refundMoveRequest(U, ASSET, 25_000_000n, NOW), {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ASSET, depositType: "INTENTS",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: "25000000",
    refundTo: U, refundType: "INTENTS", recipient: U, recipientType: "DESTINATION_CHAIN", deadline: "2026-11-07T14:30:00.000Z",
  });
  assert.throws(() => refundMoveRequest("alice.near", ASSET, 1n, NOW));
  assert.throws(() => refundMoveRequest(U, ASSET, 0n, NOW));
});

test("the nonce is intents.near's V1: magic, version 0, the salt, the deadline in ns (i64 LE), 15 random bytes", () => {
  const r = Uint8Array.from({ length: 15 }, (_, k) => k + 1);
  const n = base64.decode(versionedNonce("252812b3", NOW + 120_000, r));
  assert.equal(n.length, 32);
  assert.deepEqual([...n.subarray(0, 5)], [...NONCE_V1_PREFIX]);
  assert.equal(Buffer.from(n.subarray(5, 9)).toString("hex"), "252812b3");
  assert.equal(new DataView(n.buffer, n.byteOffset).getBigInt64(9, true), BigInt(NOW + 120_000) * 1_000_000n);
  assert.deepEqual([...n.subarray(17)], [...r]);
  assert.throws(() => versionedNonce("2528", NOW));
  assert.notEqual(versionedNonce("252812b3", NOW), versionedNonce("252812b3", NOW), "random");
});

test("the payload is one spelling: the five keys in order, one transfer of one asset, no memo or msg", () => {
  assert.equal(
    transferPayload({ u: U, deadlineMs: NOW, nonce: "n", receiver: "ab".repeat(32), asset: ASSET, amount: 7n }),
    `{"signer_id":"${U}","verifying_contract":"intents.near","deadline":"2026-11-07T14:00:00.000Z","nonce":"n","intents":[{"intent":"transfer","receiver_id":"${"ab".repeat(32)}","tokens":{"${ASSET}":"7"}}]}`,
  );
});

/** A run with stand-in checks: each step logged in order. */
function run(o: { quote?: () => unknown; held?: [bigint, bigint]; intent?: () => unknown } = {}) {
  const log: string[] = [];
  const check: RefundMoveCheck<{ q: true }, { i: true }> = {
    quote: (req) => (log.push(`check ${req.depositType}`), (o.quote?.() as { q: true }) ?? { q: true }),
    read: () => ({ depositAddress: "ab".repeat(32), amountIn: 25_000_000n, deadlineMs: NOW + 72 * 3_600_000 }),
    intent: (payload, _q, _reads, prior) => (log.push(`intent ${prior}`), (o.intent?.() as { i: true }) ?? (JSON.parse(payload), { i: true })),
    sign: () => (log.push("sign"), { standard: "raw_ed25519", payload: "{}", public_key: "ed25519:1", signature: "ed25519:1" }),
  };
  const fetchFn = (async (url: string) => (log.push(url === DEPOSIT_QUOTE_URL ? "quote" : url === RELEASE_INTENTS_URL ? "send" : url), Response.json({}, { status: url === DEPOSIT_QUOTE_URL ? 201 : 200 }))) as typeof fetch;
  const held = o.held ?? [25_000_000n, 25_000_000n];
  const p = runRefundMove(
    { u: U, asset: ASSET, reads: [{ blockTimeNs: T, held: held[0] }, { blockTimeNs: T + 5n, held: held[1] }], salt: "252812b3", priorMs: null },
    { check, fetchFn, now: () => NOW, openKey: async (fn) => (log.push("key"), fn(new Uint8Array(32))), record: async () => void log.push("record") },
  );
  return { p, log };
}

test("the steps in order: quote, its check, the intent's check, the key opened to sign, the record, then the send", async () => {
  const r = run();
  const out = await r.p;
  assert.equal(out.kind, "sent");
  assert.deepEqual(r.log, ["quote", "check INTENTS", "intent null", "key", "sign", "record", "send"]);
  assert.equal(out.kind === "sent" && out.move.deadline_ms, NOW - 2_000 + REFUND_INTENT_WINDOW_MS, "the lower block time + 120 s");
});

test("under MIN_DEPOSIT at the quote's floor: nothing signed, recorded or sent", async () => {
  const r = run({ quote: () => { throw new RefundMoveUnderMin(); } });
  assert.deepEqual(await r.p, { kind: "under_min" });
  assert.deepEqual(r.log, ["quote", "check INTENTS"]);
});

test("a quote off the request, an intent the rule refuses, or reads that disagree: nothing signed, recorded or sent", async () => {
  for (const [what, o, log] of [
    ["quote", { quote: () => { throw new Error("quote check failed (echo)"); } }, ["quote", "check INTENTS"]],
    ["intent", { intent: () => { throw new Error("not_allowed"); } }, ["quote", "check INTENTS", "intent null"]],
    ["reads", { held: [25_000_000n, 24_000_000n] as [bigint, bigint] }, []],
  ] as const) {
    const r = run(o);
    assert.equal((await r.p).kind, "refused", what);
    assert.deepEqual(r.log, log, what);
  }
});
