// The refund move's builders and steps (card wallet-refund-move; src/deposit/refund.ts, wallet.md §2.4 point 8 and the
// §2.8 refund move row). The checks here are stand-ins that record what they were handed; SIGN_HOST's real rules run in
// packages/signpage/test/refund-move.test.ts. No key is real: the stand-in signer never reads the bytes it is handed.
//   node --test test/deposit-refund.test.ts   (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import { base64 } from "@scure/base";
import { DEPOSIT_QUOTE_URL } from "../src/deposit/quote.ts";
import { INTENTS_ANSWER_MAX_BYTES, NONCE_V1_PREFIX, RELEASE_INTENTS_URL, REFUND_INTENT_WINDOW_MS, type RefundMoveCheck, RefundMoveUnderMin, refundMoveRequest, runRefundMove, transferPayload, versionedNonce } from "../src/deposit/refund.ts";

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
function run(o: { quote?: () => unknown; held?: [bigint, bigint]; registered?: [boolean, boolean]; intent?: () => unknown; request?: (u: string, asset: string, amount: bigint, now: number) => import("@blindfill/kit").OneClickRequest; sent?: unknown[] } = {}) {
  const log: string[] = [];
  const check: RefundMoveCheck<{ q: true }, { i: true }> = {
    quote: (req) => (log.push(`check ${req.depositType}`), o.sent?.push(req), (o.quote?.() as { q: true }) ?? { q: true }),
    read: () => ({ depositAddress: "ab".repeat(32), amountIn: 25_000_000n, deadlineMs: NOW + 72 * 3_600_000 }),
    intent: (payload, _q, _reads, prior) => (log.push(`intent ${prior}`), (o.intent?.() as { i: true }) ?? (JSON.parse(payload), { i: true })),
    sign: () => (log.push("sign"), { standard: "raw_ed25519", payload: "{}", public_key: "ed25519:1", signature: "ed25519:1" }),
  };
  const fetchFn = (async (url: string) => (log.push(url === DEPOSIT_QUOTE_URL ? "quote" : url === RELEASE_INTENTS_URL ? "send" : url), Response.json({}, { status: url === DEPOSIT_QUOTE_URL ? 201 : 200 }))) as typeof fetch;
  const held = o.held ?? [25_000_000n, 25_000_000n];
  const p = runRefundMove(
    { u: U, asset: ASSET, reads: [{ blockTimeNs: T, held: held[0], registered: o.registered?.[0] ?? true }, { blockTimeNs: T + 5_000_000n, held: held[1], registered: o.registered?.[1] ?? true }], salt: "252812b3", priorMs: null, height: 223_478_949 },
    { check, fetchFn, now: () => NOW, openKey: async (fn) => (log.push("key"), fn(new Uint8Array(32))), record: async () => void log.push("record"), ...(o.request ? { request: o.request } : {}) },
  );
  return { p, log };
}

test("the steps in order: quote, its check, the intent's check, the key opened to sign, the record, then the send", async () => {
  const r = run();
  const out = await r.p;
  assert.equal(out.kind, "sent");
  assert.deepEqual(r.log, ["quote", "check INTENTS", "intent null", "key", "sign", "record", "send"]);
  assert.equal(out.kind === "sent" && out.move.deadline_ms, NOW - 2_000 + REFUND_INTENT_WINDOW_MS, "the lower block time + 120 s");
  assert.equal(out.kind === "sent" && out.move.height, 223_478_949, "the block its reads were made at, kept with the move (L2)");
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

/** A run whose relayer answers `answer` to the move and `probe` to an empty body; the URLs asked logged in order. */
function relayRun(answer: () => Response, o: { probe?: boolean; probeAnswer?: () => Response; record?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const check: RefundMoveCheck<{ q: true }, { i: true }> = {
    quote: () => ({ q: true }),
    read: () => ({ depositAddress: "ab".repeat(32), amountIn: 25_000_000n, deadlineMs: NOW + 72 * 3_600_000 }),
    intent: () => ({ i: true }),
    sign: () => (log.push("sign"), { standard: "raw_ed25519", payload: "{}", public_key: "ed25519:1", signature: "ed25519:1" }),
  };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url === DEPOSIT_QUOTE_URL) return (log.push("quote"), Response.json({}, { status: 201 }));
    if (init?.body === "{}") return (log.push("probe"), (o.probeAnswer ?? (() => Response.json({ error: { code: "bad_shape" } }, { status: 400 })))());
    return (log.push("send"), answer());
  }) as typeof fetch;
  const p = runRefundMove(
    { u: U, asset: ASSET, reads: [{ blockTimeNs: T, held: 25_000_000n, registered: true }, { blockTimeNs: T, held: 25_000_000n, registered: true }], salt: "252812b3", priorMs: null, height: 223_478_949, probe: o.probe },
    { check, fetchFn, now: () => NOW, openKey: async (fn) => fn(new Uint8Array(32)), record: o.record ?? (async () => void log.push("record")) },
  );
  return { p, log };
}

test("a record that fails sends nothing: no move is ever out unrecorded", async () => {
  const r = relayRun(() => Response.json({ tx_hash: "1".repeat(44) }), { record: async () => { throw new Error("the store refused"); } });
  await assert.rejects(r.p, /the store refused/);
  assert.deepEqual(r.log, ["quote", "sign"]);
});

test("the relayer's answer: its listed code with a 4xx status is read (sender_struck), anything else is no code", async () => {
  for (const [what, answer, status, code] of [
    ["struck", () => Response.json({ error: { code: "sender_struck" } }, { status: 403 }), 403, "sender_struck"],
    ["carried", () => Response.json({ tx_hash: "1".repeat(44) }, { status: 200 }), 200, null],
    ["no route", () => new Response("not found", { status: 404 }), 404, null],
    ["a code not listed", () => Response.json({ error: { code: "nope" } }, { status: 400 }), 400, null],
    ["a listed code on a 200", () => Response.json({ error: { code: "sender_struck" } }, { status: 200 }), 200, null],
    ["an answer over the cap", () => new Response(JSON.stringify({ error: { code: "sender_struck" }, pad: "x".repeat(INTENTS_ANSWER_MAX_BYTES) }), { status: 403 }), 403, null],
  ] as const) {
    const r = relayRun(answer);
    const out = await r.p;
    assert.equal(out.kind, "sent", what);
    assert.deepEqual(out.kind === "sent" && [out.status, out.code], [status, code], what);
    assert.deepEqual(r.log, ["quote", "sign", "record", "send"], what);
  }
});

test("after a refusal (probe): the route is asked first with an empty body; no answer of its own (404, 5xx, none) asks no quote and opens no key", async () => {
  const ok = relayRun(() => Response.json({ tx_hash: "1".repeat(44) }), { probe: true });
  assert.equal((await ok.p).kind, "sent");
  assert.deepEqual(ok.log, ["probe", "quote", "sign", "record", "send"]);
  for (const probeAnswer of [() => new Response("not found", { status: 404 }), () => new Response("", { status: 502 }), () => Response.json({ error: "not_found" }, { status: 404 })]) {
    const r = relayRun(() => Response.json({}), { probe: true, probeAnswer });
    assert.deepEqual(await r.p, { kind: "refused", why: "relay" });
    assert.deepEqual(r.log, ["probe"]);
  }
});

test("pin (delta): the relayer's answer is read up to INTENTS_ANSWER_MAX_BYTES (1024 B): an answer of exactly that many bytes is read, one byte more is no code", async () => {
  assert.equal(INTENTS_ANSWER_MAX_BYTES, 1_024);
  const body = (n: number) => {
    const j = JSON.stringify({ error: { code: "sender_struck" } });
    return j.slice(0, -1) + " ".repeat(n - j.length) + "}";
  };
  assert.equal(body(1_024).length, 1_024);
  for (const [n, code] of [[1_024, "sender_struck"], [1_025, null]] as const) {
    const r = relayRun(() => new Response(body(n), { status: 403 }));
    const out = await r.p;
    assert.deepEqual(out.kind === "sent" && out.code, code, `${n} B`);
  }
});

test("card pool-deposit-follow: a pool refund's move asks the request it is given (to X's coin, to U_X), the vault's otherwise", async () => {
  const { poolRefundMoveRequest } = await import("../src/deposit/refund.ts");
  const { depositId } = await import("../src/derive/keys.ts");
  const { base58 } = await import("@scure/base");
  const k = depositId(new Uint8Array(64), 777n, 0); // the all-zero published test seed
  const wallet = base58.encode(k.publicKey), id = k.id;
  k.secretKey.fill(0);
  const sent: { destinationAsset?: string; recipient?: string }[] = [];
  const r = run({ sent, request: (_u, asset, amount, now) => poolRefundMoveRequest("solana", wallet, id, asset, amount, now) });
  assert.equal((await r.p).kind, "sent");
  assert.equal(sent[0]!.destinationAsset, "nep141:sol.omft.near");
  assert.equal(sent[0]!.recipient, wallet);
  const v: { destinationAsset?: string }[] = [];
  await run({ sent: v }).p;
  assert.equal(v[0]!.destinationAsset, refundMoveRequest(U, ASSET, 1n, NOW).destinationAsset);
});

test("card intents-u-registered-first: U not registered on USDC on either RPC: refused unregistered, no quote asked, nothing signed or sent", async () => {
  for (const registered of [[false, true], [true, false], [false, false]] as [boolean, boolean][]) {
    const r = run({ registered });
    assert.deepEqual(await r.p, { kind: "refused", why: "unregistered" }, String(registered));
    assert.deepEqual(r.log, [], String(registered));
  }
});
