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
const readOf = (held: bigint, used: boolean | null = null, timeMs = NOW - 2_000): MoveRead => ({ height: 100, timeMs, reads: [{ blockTimeNs: BigInt(timeMs) * 1_000_000n, held, registered: true }, { blockTimeNs: BigInt(timeMs) * 1_000_000n + 5_000_000n, held, registered: true }], held, used, salt: "252812b3" });

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

function world(o: { read: MoveRead | null; move?: Awaited<ReturnType<Host["move"]>>; seed?: Uint8Array; floor?: bigint | Error; intents?: number; intentsBody?: unknown; tx?: Host["tx"]; unpriced?: true; down?: true; unrecorded?: true }) {
  const log: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const sentIntents: { signed_intent: { payload: string; public_key: string } }[] = [];
  const records: unknown[] = [];
  let recorded: unknown;
  const host: Host = {
    read: async () => o.read,
    floor: async () => {
      if (o.floor instanceof Error) throw o.floor;
      return o.floor ?? 13_586_400n;
    },
    priced: () => (o.unpriced ? null : { decimalsIn: 6, pricing: PRICING }),
    decimals: () => 9,
    seed64: async () => (log.push("seed"), (o.seed ?? new Uint8Array(64)).slice()),
    seedLock: (fn) => fn(),
    move: async () => o.move,
    record: async (m) => {
      if (o.unrecorded) throw new Error("the store write failed");
      void ((recorded = m), records.push(m), log.push("record"));
    },
    now: () => NOW,
    fetch: (async (url: string, init?: RequestInit) => {
      if (o.down) throw new TypeError("fetch failed");
      if (url === DEPOSIT_QUOTE_URL) {
        const req = JSON.parse(String(init?.body));
        asked.push(req);
        log.push("quote");
        return Response.json(answerTo(req), { status: 201 });
      }
      if (url === RELEASE_INTENTS_URL) {
        log.push("send");
        if (String(init?.body) !== "{}") sentIntents.push(JSON.parse(String(init?.body)));
        return Response.json(o.intentsBody ?? {}, { status: o.intents ?? 200 });
      }
      throw new Error(url);
    }) as typeof fetch,
  };
  if (o.tx) host.tx = o.tx;
  return { host, log, asked, sentIntents, recorded: () => recorded, records };
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

test("nothing held, reads that do not agree, a move in its window, a seed that is not U_{s,i}'s, a relayer refusal: nothing new (held: the money read under U_{s,i}, not moved)", async () => {
  assert.equal(await poolRefundMover(world({ read: readOf(0n) }).host)(F, signal), "none");
  assert.equal(await poolRefundMover(world({ read: null }).host)(F, signal), "wait");
  const inWindow = world({ read: readOf(25_000_000n, false), move: { nonce: "n", deadline_ms: NOW + 60_000, asset: BASE_USDC, amount: "25000000", height: 99 } });
  assert.equal(await poolRefundMover(inWindow.host)(F, signal), "wait");
  assert.deepEqual(inWindow.log, [], "never a second intent for the same money in the first one's window");
  const other = world({ read: readOf(25_000_000n), seed: new Uint8Array(64).fill(1) });
  assert.equal(await poolRefundMover(other.host)(F, signal), "held");
  assert.ok(!other.log.includes("send") && !other.log.includes("record"), "a seed whose U_{s,i} is not the op's signs nothing");
  assert.equal(await poolRefundMover(world({ read: readOf(25_000_000n), intents: 400 }).host)(F, signal), "held");
  // a refund the pool's floor refuses (about 0.0132 SOL of min out under 0.0136): no intent signed, it waits
  const small = world({ read: readOf(2_000_000n) });
  assert.equal(await poolRefundMover(small.host)(F, signal), "held");
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

test("delta review: money read under U_{s,i} on both RPCs that cannot be moved now is held, never hidden: no price, a floor read that fails, a move that throws", async () => {
  // each one, read as "wait" or thrown, would keep refunded off the screen with the money sitting under U_{s,i}
  const unpriced = world({ read: readOf(25_000_000n), unpriced: true });
  assert.equal(await poolRefundMover(unpriced.host)(F, signal), "held");
  assert.deepEqual(unpriced.log, [], "no price: nothing quoted or signed");
  const noFloor = world({ read: readOf(25_000_000n), floor: new Error("the pool's floor read failed") });
  assert.equal(await poolRefundMover(noFloor.host)(F, signal), "held");
  assert.deepEqual(noFloor.log, [], "no floor: nothing quoted or signed");
  const down = world({ read: readOf(25_000_000n), down: true });
  assert.equal(await poolRefundMover(down.host)(F, signal), "held");
  assert.ok(!down.log.includes("send") && !down.log.includes("record"), "a quote that cannot be asked sends nothing");
  // the move's record cannot be written: runRefundMove throws before the send (never a send it did not record)
  const unrecorded = world({ read: readOf(25_000_000n), unrecorded: true });
  assert.equal(await poolRefundMover(unrecorded.host)(F, signal), "held");
  assert.deepEqual(unrecorded.log, ["quote", "seed"], "signed, not recorded, never sent");
});

// ------------------------------------------------------------------------------- card pool-deposit-op-txs

const HASH = base58.encode(new Uint8Array(32).fill(9)), HASH2 = base58.encode(new Uint8Array(32).fill(8));
const MOVE = { nonce: "n", deadline_ms: NOW + 60_000, asset: BASE_USDC, amount: "25000000", height: 99 };
const heard = (hash: string, nonce = "n", deadline_ms = MOVE.deadline_ms) => ({ hash, nonce, deadline_ms });

test("pool-deposit-op-txs: the relayer's tx_hash is kept on the move as heard (with its nonce and deadline), after its send; a malformed one is not, and the move is moved either way", async () => {
  const w = world({ read: readOf(25_000_000n), intentsBody: { tx_hash: HASH } });
  assert.equal(await poolRefundMover(w.host)(F, signal), "moved");
  assert.deepEqual(w.log, ["quote", "seed", "record", "send", "record"]);
  const first = w.records[0] as { nonce: string; deadline_ms: number; txs?: unknown };
  assert.equal(first.txs, undefined, "recorded before the send with no tx");
  assert.deepEqual(w.records[1], { ...first, txs: [heard(HASH, first.nonce, first.deadline_ms)] }, "the same move, its tx as heard");
  for (const body of [{ tx_hash: "1".repeat(44) }, { tx_hash: 7 }, {}]) {
    const m = world({ read: readOf(25_000_000n), intentsBody: body });
    assert.equal(await poolRefundMover(m.host)(F, signal), "moved", JSON.stringify(body));
    assert.deepEqual(m.log, ["quote", "seed", "record", "send"], JSON.stringify(body));
  }
});

test("pool-deposit-op-txs: a heard tx is final only once its move's nonce reads used on both RPCs and the tx reads FINAL with success on both, carrying that very intent (U_{s,i}, that nonce)", async () => {
  const asked: unknown[] = [];
  const tx = (ok: boolean) => async (h: string, intent: unknown) => (asked.push([h, intent]), ok);
  // used, and the tx final on both: settled final (the follower then shows it); the read asked for this move's intent
  const yes = world({ read: readOf(0n, true), move: { ...MOVE, txs: [heard(HASH)] }, tx: tx(true) });
  assert.equal(await poolRefundMover(yes.host).settle(F), true);
  assert.deepEqual(yes.records, [{ ...MOVE, txs: [{ ...heard(HASH), final: true }] }]);
  assert.deepEqual(asked, [[HASH, { signer: ID, nonce: "n" }]]);
  // used, the tx not final on both yet: nothing recorded, read again (inside the move's window)
  const not = world({ read: readOf(0n, true), move: { ...MOVE, txs: [heard(HASH)] }, tx: tx(false) });
  assert.equal(await poolRefundMover(not.host).settle(F), false);
  assert.deepEqual(not.records, []);
  // the nonce not used: the tx is not even read
  asked.length = 0;
  const unused = world({ read: readOf(0n, false), move: { ...MOVE, txs: [heard(HASH)] }, tx: tx(true) });
  assert.equal(await poolRefundMover(unused.host).settle(F), false);
  assert.deepEqual(asked, []);
  // its nonce unused past the move's deadline on the chain's clock: it can never land; let go, never shown
  const { POOL_TX_READ_MARGIN_MS } = await import("../src/pool-deposit-follow.ts");
  const late = world({ read: readOf(0n, false, MOVE.deadline_ms + 1), move: { ...MOVE, txs: [heard(HASH)] }, tx: tx(true) });
  assert.equal(await poolRefundMover(late.host).settle(F), true);
  assert.deepEqual(late.records, [{ ...MOVE, txs: [{ ...heard(HASH), dropped: true }] }]);
  // used, the tx not final: read again past the deadline (FINAL may lag), let go past the margin on the chain's clock
  const lag = world({ read: readOf(0n, true, MOVE.deadline_ms + 1), move: { ...MOVE, txs: [heard(HASH)] }, tx: tx(false) });
  assert.equal(await poolRefundMover(lag.host).settle(F), false);
  const gone = world({ read: readOf(0n, true, MOVE.deadline_ms + POOL_TX_READ_MARGIN_MS + 1), move: { ...MOVE, txs: [heard(HASH)] }, tx: tx(false) });
  assert.equal(await poolRefundMover(gone.host).settle(F), true);
  assert.deepEqual(gone.records, [{ ...MOVE, txs: [{ ...heard(HASH), dropped: true }] }]);
  // nothing heard, or already settled: nothing to read
  assert.equal(await poolRefundMover(world({ read: readOf(0n, true), move: MOVE, tx: tx(true) }).host).settle(F), true);
  assert.equal(await poolRefundMover(world({ read: readOf(0n, true), move: { ...MOVE, txs: [{ ...heard(HASH), final: true }] }, tx: tx(true) }).host).settle(F), true);
  // the carry itself settles a heard tx first, at every round it reads the move
  const round = world({ read: readOf(0n, true), move: { ...MOVE, txs: [heard(HASH)] }, tx: tx(true) });
  assert.equal(await poolRefundMover(round.host)(F, signal), "none");
  assert.deepEqual(round.records, [{ ...MOVE, txs: [{ ...heard(HASH), final: true }] }]);
});

test("review P2-b: reads that never agree (null) hold a heard tx only until the device's clock is past its move's deadline and the margin: then it is let go, never shown, and the follow can end", async () => {
  const { POOL_TX_READ_MARGIN_MS } = await import("../src/pool-deposit-follow.ts");
  const tx = async () => true;
  const inside = world({ read: null, move: { ...MOVE, txs: [heard(HASH)] }, tx });
  assert.equal(await poolRefundMover({ ...inside.host, now: () => MOVE.deadline_ms + POOL_TX_READ_MARGIN_MS }).settle(F), false, "inside the margin: read again");
  const past = world({ read: null, move: { ...MOVE, txs: [heard(HASH)] }, tx });
  assert.equal(await poolRefundMover({ ...past.host, now: () => MOVE.deadline_ms + POOL_TX_READ_MARGIN_MS + 1 }).settle(F), true);
  assert.deepEqual(past.records, [{ ...MOVE, txs: [{ ...heard(HASH), dropped: true }] }]);
  // a move with deadline_ms 0 and reads that never agree: let go at once on any real clock
  const zero = world({ read: null, move: { ...MOVE, deadline_ms: 0, txs: [heard(HASH, "n", 0)] }, tx });
  assert.equal(await poolRefundMover({ ...zero.host, now: () => NOW }).settle(F), true);
});

test("review P3 1: a new move never loses an earlier move's heard tx: each is kept and settled on its own nonce", async () => {
  const { poolFollows } = await import("../src/pool-deposit-follow.ts");
  const rows = new Map<string, unknown>();
  const store = {
    get: async (_s: "ops", k: string) => rows.get(k),
    keys: async () => [...rows.keys()],
    update: async (_s: "ops", k: string, change: (v: unknown) => unknown) => {
      const v = change(rows.get(k));
      if (v !== undefined) rows.set(k, v);
      return rows.get(k);
    },
  };
  let op!: { move(): Promise<unknown>; record(m: never): Promise<void> };
  const host = poolFollows({ store: async () => store, deps: (_f, o) => ((op = o as never), null), decimals: () => 9, locks: () => null, now: () => 5 });
  const quote = { deposit_address: "DEPOSIT", origin_asset: BASE_USDC, min_amount_out: "0.02", deadline: "2026-11-08T06:00:00.000Z" };
  await host.quoted("op-1", "solana", quote, { scope: 777n, index: 0, wallet: SOL_U, refundId: ID });
  await host.idle();
  // the first move and its heard tx; then a second move recorded before its send, as runRefundMove writes it (no txs)
  await op.record({ ...MOVE, txs: [heard(HASH)] } as never);
  const MOVE2 = { ...MOVE, nonce: "m", deadline_ms: MOVE.deadline_ms + 1_000 };
  await op.record(MOVE2 as never);
  await op.record({ ...MOVE2, txs: [heard(HASH2, "m", MOVE2.deadline_ms)] } as never);
  assert.deepEqual(await op.move(), { ...MOVE2, txs: [heard(HASH), heard(HASH2, "m", MOVE2.deadline_ms)] });
  assert.deepEqual((rows.get("op-1") as { txs: unknown[] }).txs, [], "heard is not shown");
  // settle reads each on its own nonce: the first move's tx final, the second's not yet
  const reads: (string | null)[] = [];
  const mover = poolRefundMover({
    ...world({ read: null }).host,
    read: async (_f, nonce) => (reads.push(nonce), readOf(0n, true)),
    tx: async (h) => h === HASH,
    move: op.move as never,
    record: op.record as never,
  });
  assert.equal(await mover.settle(F), false, "the second is still open");
  assert.deepEqual(reads, ["n", "m"]);
  assert.deepEqual((rows.get("op-1") as { txs: unknown[] }).txs, [{ chain: "near", hash: HASH }], "the first move's tx shown once final");
  await op.record({ ...MOVE2, txs: [{ ...heard(HASH2, "m", MOVE2.deadline_ms), final: true }] } as never);
  assert.deepEqual((rows.get("op-1") as { txs: unknown[] }).txs, [{ chain: "near", hash: HASH }, { chain: "near", hash: HASH2 }]);
});

test("review P1: nearTxFinal reads the tx FINAL with success on both RPCs, sent by the release relayer to intents.near, carrying exactly one execute_intents of exactly one intent: this move's own (U_{s,i}, its nonce)", async () => {
  const { nearTxFinal } = await import("../src/pool-deposit-follow.ts");
  const { RELEASE_RELAYER } = await import("../../wallet/src/deposit/bind.ts");
  const relayer = RELEASE_RELAYER.mainnet!;
  const intent = { signer: ID, nonce: "bm9uY2U=" };
  const signedOf = (signer = ID, nonce = intent.nonce) => ({ standard: "raw_ed25519", payload: JSON.stringify({ signer_id: signer, verifying_contract: "intents.near", deadline: "2026-11-08T06:00:00.000Z", nonce, intents: [] }), public_key: "ed25519:x", signature: "ed25519:y" });
  const args = (signed: unknown[]) => Buffer.from(JSON.stringify({ signed })).toString("base64");
  const call = (o: { method?: string; signed?: unknown[] } = {}) => ({ FunctionCall: { method_name: o.method ?? "execute_intents", args: args(o.signed ?? [signedOf()]), gas: 300_000_000_000_000, deposit: "0" } });
  const answer = (o: { status?: unknown; signer?: string; receiver?: string; final?: string; hash?: string; actions?: unknown[] } = {}) => ({
    result: { final_execution_status: o.final ?? "FINAL", status: o.status ?? { SuccessValue: "" }, transaction: { hash: o.hash ?? HASH, signer_id: o.signer ?? relayer, receiver_id: o.receiver ?? "intents.near", actions: o.actions ?? [call()] } },
  });
  const params: unknown[] = [];
  const rpc = (a: unknown) => ({ tx: async (p: unknown) => (params.push(p), typeof a === "function" ? (a as () => unknown)() : a) }) as never;
  assert.equal(await nearTxFinal([rpc(answer()), rpc(answer())], HASH, intent), true);
  assert.deepEqual(params[0], { tx_hash: HASH, sender_account_id: relayer, wait_until: "FINAL" });
  for (const [what, b] of [
    ["a failure", answer({ status: { Failure: { ActionError: {} } } })],
    ["another signer", answer({ signer: "x.near" })],
    ["another receiver", answer({ receiver: "wrap.near" })],
    ["not final", answer({ final: "EXECUTED_OPTIMISTIC" })],
    ["another tx", answer({ hash: HASH2 })],
    // review P1: a tx of the same relayer that carries another move
    ["another signer's intent", answer({ actions: [call({ signed: [signedOf("cd".repeat(32))] })] })],
    ["another nonce's intent", answer({ actions: [call({ signed: [signedOf(ID, "b3RoZXI=")] })] })],
    ["two intents", answer({ actions: [call({ signed: [signedOf(), signedOf()] })] })],
    ["no intent", answer({ actions: [call({ signed: [] })] })],
    ["another method", answer({ actions: [call({ method: "ft_transfer" })] })],
    ["two actions", answer({ actions: [call(), call()] })],
    ["no actions", answer({ actions: [] })],
    ["args not base64 JSON", answer({ actions: [{ FunctionCall: { method_name: "execute_intents", args: "!!", gas: 1, deposit: "0" } }] })],
    ["a payload not JSON", answer({ actions: [call({ signed: [{ ...signedOf(), payload: "{" }] })] })],
    ["an error", { error: { name: "HANDLER_ERROR" } }],
    ["no answer", () => { throw new Error("down"); }],
  ] as const) {
    assert.equal(await nearTxFinal([rpc(answer()), rpc(b)], HASH, intent), false, `${what} on one RPC`);
    assert.equal(await nearTxFinal([rpc(b), rpc(answer())], HASH, intent), false, `${what} on the other`);
  }
});

test("pool-deposit-op-txs: the page's follower adds a refund move's tx to the op's txs only once it is final", async () => {
  const { poolFollows } = await import("../src/pool-deposit-follow.ts");
  const rows = new Map<string, unknown>();
  const store = {
    get: async (_s: "ops", k: string) => rows.get(k),
    keys: async () => [...rows.keys()],
    update: async (_s: "ops", k: string, change: (v: unknown) => unknown) => {
      const v = change(rows.get(k));
      if (v !== undefined) rows.set(k, v);
      return rows.get(k);
    },
  };
  let op!: { move(): Promise<unknown>; record(m: never): Promise<void> };
  const host = poolFollows({ store: async () => store, deps: (_f, o) => ((op = o as never), null), decimals: () => 9, locks: () => null, now: () => 5 });
  const quote = { deposit_address: "DEPOSIT", origin_asset: BASE_USDC, min_amount_out: "0.02", deadline: "2026-11-08T06:00:00.000Z" };
  await host.quoted("op-1", "solana", quote, { scope: 777n, index: 0, wallet: SOL_U, refundId: ID });
  await host.idle();
  await op.record({ ...MOVE, txs: [heard(HASH)] } as never);
  assert.deepEqual((rows.get("op-1") as { txs: unknown[] }).txs, [], "heard is not shown");
  await op.record({ ...MOVE, txs: [{ ...heard(HASH2), dropped: true }] } as never);
  assert.deepEqual((rows.get("op-1") as { txs: unknown[] }).txs, [], "let go is not shown");
  await op.record({ ...MOVE, txs: [{ ...heard(HASH2), final: true }] } as never);
  assert.deepEqual((rows.get("op-1") as { txs: unknown[] }).txs, [], "let go stays let go");
  await op.record({ ...MOVE, txs: [{ ...heard(HASH), final: true }] } as never);
  await op.record({ ...MOVE, txs: [{ ...heard(HASH), final: true }] } as never);
  assert.deepEqual((rows.get("op-1") as { txs: unknown[] }).txs, [{ chain: "near", hash: HASH }], "final: shown, once");
});
