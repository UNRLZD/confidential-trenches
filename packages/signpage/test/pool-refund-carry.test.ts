// The pool refund carry's driver (card pool-deposit-follow; src/pool-deposit-follow.ts poolRefundMover): a refund under
// U_{s,i} inside intents.near is quoted back to X's coin to U_X, its quote and intent checked by this page's rules,
// signed by U_{s,i} only, recorded before it is sent; never a second intent while one is in its window.
//   node --test test/pool-refund-carry.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, ADDRESS, H72, COLLECTOR, signAnswer, mockKey, type Answer } from "./oneclick-mock.ts";

const { oneClickFloors } = await import("../../kit/src/checks/oneclick.ts");
const { DEPOSIT_QUOTE_URL } = await import("../../wallet/src/deposit/quote.ts");
const { RELEASE_INTENTS_URL } = await import("../../wallet/src/deposit/refund.ts");
const { depositId } = await import("../../wallet/src/derive/keys.ts");
const { base58 } = await import("@scure/base");
const { poolRefundMover } = await import("../src/pool-deposit-follow.ts");
type Host = Parameters<typeof poolRefundMover>[0];
type MoveRead = NonNullable<Awaited<ReturnType<Host["read"]>>>;

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SEED64 = new Uint8Array(64); // the all-zero published test seed
const k0 = depositId(SEED64, 777n, 0);
const ID = k0.id, SOL_U = base58.encode(k0.publicKey);
k0.secretKey.fill(0);
const PRICING = { in: ["1", "1"], out: ["150", "150.1"] } as const;
const F = { chain: "solana" as const, s: "777", i: 0, u: SOL_U, refund_id: ID, address: "DEPOSIT", deadline_ms: NOW, origin: BASE_USDC, min_out: "20000000" };
const T = BigInt(NOW - 2_000) * 1_000_000n;
const readOf = (held: bigint, used: boolean | null = null, timeMs = NOW - 2_000): MoveRead => ({ height: 100, timeMs, reads: [{ blockTimeNs: BigInt(timeMs) * 1_000_000n, held }, { blockTimeNs: BigInt(timeMs) * 1_000_000n + 5_000_000n, held }], held, used, salt: "252812b3" });

function answerTo(req: Record<string, unknown>): Answer {
  const amountIn = BigInt(req.amount as string);
  const { minAmountOut } = oneClickFloors({ amountIn, withdrawFee: 5_000n, slippageBps: req.slippageTolerance as number, feeBps: 20, pricing: PRICING, decimalsIn: 6, decimalsOut: 9, intoVault: false });
  const out = minAmountOut + 1_000n, min = out - 500n;
  const fmt = (v: bigint, d: number) => { const s = v.toString().padStart(d + 1, "0"); return `${s.slice(0, -d)}.${s.slice(-d)}`; };
  const a: Answer = {
    quote: {
      amountIn: req.amount as string, amountInFormatted: fmt(amountIn, 6), amountInUsd: "25.0", minAmountIn: req.amount as string,
      amountOut: out.toString(), amountOutFormatted: fmt(out, 9), amountOutUsd: "24.9", minAmountOut: min.toString(),
      depositAddress: ADDRESS, deadline: new Date(Date.parse(req.deadline as string) + H72).toISOString(),
      timeWhenInactive: new Date(Date.parse(req.deadline as string) + H72).toISOString(), timeEstimate: 20, refundFee: "0", withdrawFee: "5000",
    },
    quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false, appFees: [{ recipient: COLLECTOR, fee: 20 }] } as never,
    signature: "", timestamp: new Date(NOW - 500).toISOString(), correlationId: "00000000-0000-4000-8000-000000000000",
  };
  signAnswer(a, mockKey.privateKey);
  return a;
}

function world(o: { read: MoveRead | null; move?: { nonce: string; deadline_ms: number; asset: string; amount: string; height: number }; seed?: Uint8Array; floor?: bigint; intents?: number }) {
  const log: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const sentIntents: { signed_intent: { payload: string; public_key: string } }[] = [];
  let recorded: unknown;
  const host: Host = {
    read: async () => o.read,
    floor: async () => o.floor ?? 13_586_400n,
    priced: () => ({ decimalsIn: 6, pricing: PRICING }),
    decimals: () => 9,
    seed64: async () => (log.push("seed"), (o.seed ?? new Uint8Array(64)).slice()),
    seedLock: (fn) => fn(),
    move: () => o.move,
    record: async (m) => void ((recorded = m), log.push("record")),
    now: () => NOW,
    fetch: (async (url: string, init?: RequestInit) => {
      if (url === DEPOSIT_QUOTE_URL) {
        const req = JSON.parse(String(init?.body));
        asked.push(req);
        log.push("quote");
        return Response.json(answerTo(req), { status: 201 });
      }
      if (url === RELEASE_INTENTS_URL) {
        log.push("send");
        if (String(init?.body) !== "{}") sentIntents.push(JSON.parse(String(init?.body)));
        return Response.json({}, { status: o.intents ?? 200 });
      }
      throw new Error(url);
    }) as typeof fetch,
  };
  return { host, log, asked, sentIntents, recorded: () => recorded };
}
const signal = new AbortController().signal;

test("a refund under U_{s,i} is quoted to X's coin for U_X, signed by U_{s,i}, recorded before the send: moved", async () => {
  const w = world({ read: readOf(25_000_000n) });
  assert.equal(await poolRefundMover(w.host)(F, signal), "moved");
  assert.deepEqual(w.log, ["quote", "seed", "record", "send"]);
  assert.equal(w.asked[0]!.destinationAsset, "nep141:sol.omft.near");
  assert.equal(w.asked[0]!.recipient, SOL_U);
  assert.equal(w.asked[0]!.refundTo, ID);
  assert.equal(w.asked[0]!.originAsset, BASE_USDC);
  const p = JSON.parse(w.sentIntents[0]!.signed_intent.payload);
  assert.equal(p.signer_id, ID);
  assert.deepEqual(p.intents[0].tokens, { [BASE_USDC]: "25000000" });
  assert.equal(p.intents[0].receiver_id, ADDRESS);
  assert.equal(w.sentIntents[0]!.signed_intent.public_key, `ed25519:${SOL_U}`);
});

test("nothing held, reads that do not agree, a move in its window, a seed that is not U_{s,i}'s, a relayer refusal: nothing new", async () => {
  assert.equal(await poolRefundMover(world({ read: readOf(0n) }).host)(F, signal), "none");
  assert.equal(await poolRefundMover(world({ read: null }).host)(F, signal), "wait");
  const inWindow = world({ read: readOf(25_000_000n, false), move: { nonce: "n", deadline_ms: NOW + 60_000, asset: BASE_USDC, amount: "25000000", height: 99 } });
  assert.equal(await poolRefundMover(inWindow.host)(F, signal), "wait");
  assert.deepEqual(inWindow.log, [], "never a second intent for the same money in the first one's window");
  const other = world({ read: readOf(25_000_000n), seed: new Uint8Array(64).fill(1) });
  assert.equal(await poolRefundMover(other.host)(F, signal), "wait");
  assert.ok(!other.log.includes("send") && !other.log.includes("record"), "a seed whose U_{s,i} is not the op's signs nothing");
  assert.equal(await poolRefundMover(world({ read: readOf(25_000_000n), intents: 400 }).host)(F, signal), "wait");
  // a refund the pool's floor refuses (about 0.0132 SOL of min out under 0.0136): no intent signed, it waits
  const small = world({ read: readOf(2_000_000n) });
  assert.equal(await poolRefundMover(small.host)(F, signal), "wait");
  assert.deepEqual(small.log, ["quote"]);
});

test("past an unused move's deadline a new move goes, the earlier deadline handed on; a used nonce with money left moves anew", async () => {
  const past = world({ read: readOf(25_000_000n, false, NOW - 2_000), move: { nonce: "n", deadline_ms: NOW - 3_000, asset: BASE_USDC, amount: "25000000", height: 99 } });
  assert.equal(await poolRefundMover(past.host)(F, signal), "moved");
  const through = world({ read: readOf(25_000_000n, true), move: { nonce: "n", deadline_ms: NOW + 60_000, asset: BASE_USDC, amount: "1", height: 99 } });
  assert.equal(await poolRefundMover(through.host)(F, signal), "moved");
  const done = world({ read: readOf(0n, true), move: { nonce: "n", deadline_ms: NOW + 60_000, asset: BASE_USDC, amount: "25000000", height: 99 } });
  assert.equal(await poolRefundMover(done.host)(F, signal), "none");
});
