// pool.buy on an EVM pool (card signpage-evm-pool-buy, src/pool-buy-evm.ts and src/evm-send.ts): the device's own quote
// (replayed from the kit's recorded Base answers), the kit's build, checkEvmBuy, W's signature, the pending record, the
// take, the send and the read-back on the pool's own events on two RPCs, each step's refusals and each end; and the
// buy's calldata, byte for byte the encoding the pool's testnet run sends (contracts/pool-evm/script/testnet-run-lib.mjs
// buyData). The two pool RPCs are fakes of a chain whose clock is the run's own (each wait moves it).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmPoolBuyQuoteWith, EvmQuoteError, type EvmPoolBuyQuote, type EvmRpc as QuoteRpc, type EvmRpcCall } from "../../kit/src/checks/evm/quote.ts";
import { evmQuotedBuy } from "../../kit/src/trade/evm/quoted.ts";
import { evmPoolVenues, type EvmPoolVenue } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { asRecorded, gasRoundAnswers, withMarker } from "../../kit/test/evm-quote-gas-fx.ts";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { EVM_POOL_EVENTS, evmPoolContextOf, evmPoolScopeOf, evmRelayDataBytes, type EvmPoolRequest, type EvmRelayData } from "../../wallet/src/pool/evm.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import { EVM_BUY_SETTLE_MS, EVM_OWED_BACK_KEY, EVM_POSITION_COSTS_KEY, runEvmPoolBuy, type EvmHolding, type EvmOwedBack, type EvmPoolBuyAnswer, type EvmPoolBuyHost } from "../src/pool-buy-evm.ts";
import { evmBuyCalldata, EvmSendBusy, EvmSendNoAnswer, EvmSendRefused } from "../src/evm-send.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

// the pool's testnet run's own encoder (contracts/pool-evm/script/testnet-run-lib.mjs), a plain module with no types
const LIB = new URL("../../../contracts/pool-evm/script/testnet-run-lib.mjs", import.meta.url).href;
const { buyData, proofArg } = (await import(LIB)) as { buyData: (...a: unknown[]) => string; proofArg: (...a: unknown[]) => unknown };

// the kit's recorded quote: 0.01 ETH of USDC on Base through a v3 pool (kit test/fixtures/evm-quote.json "base-ok")
type Exchange = { calls: EvmRpcCall[]; answers: unknown[] };
const QF = (JSON.parse(readFileSync(new URL("../../kit/test/fixtures/evm-quote.json", import.meta.url), "utf8")) as Record<string, { request: Record<string, unknown>; now: number; exchanges: [Exchange[], Exchange[]] }>)["base-ok"]!;
const replay = (ex: Exchange[]): QuoteRpc => async (sent) => {
  const calls = asRecorded(sent);
  return withMarker(sent, structuredClone(ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls))?.answers ?? gasRoundAnswers(ex, calls)!));
};
const AMOUNT_IN = BigInt(QF.request.amountIn as string);
const TOKEN = QF.request.buys as string;
const FIXTURE_ROUTE = QF.request.route as EvmPoolBuyQuote["route"];
/** The kit's own quote of the recording at another slippage than the request's: a device quote whose min out is looser. */
const quoteAt = (slippageBps: number) => {
  const { buys, amountIn, ...rest } = QF.request;
  return evmPoolBuyQuoteWith({ ...(rest as object), slippageBps, token: buys as string, amountIn: BigInt(amountIn as string) } as never, [replay(QF.exchanges[0]), replay(QF.exchanges[1])], QF.now);
};
let quoted: Promise<EvmPoolBuyQuote> | null = null;
const fixtureQuote = () =>
  (quoted ??= (() => {
    const { buys, amountIn, ...rest } = QF.request;
    return evmPoolBuyQuoteWith({ ...(rest as object), token: buys as string, amountIn: BigInt(amountIn as string) } as never, [replay(QF.exchanges[0]), replay(QF.exchanges[1])], QF.now);
  })());

const { pool: _p, adapters: _a, sellDelegate: _s, feeCollector: _f, ...B } = evmPoolVenues().base;
const POOL = "0x00000000000000000000000000000000000f0011";
const A_V3 = "0x000000000000000000000000000000000000ad03";
const A_V4 = "0x000000000000000000000000000000000000ad04";
const FEE_TO = "0x0000000000000000000000000000000000000fee";
const VENUES = Object.freeze({ base: Object.freeze({ ...B, pool: POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }) }) as EvmPoolVenue });
const NOW = BigInt(QF.now);
const FEE = 10n ** 13n;
const CHUNK = AMOUNT_IN + FEE;
// the all-zero seed's W for (l, j) = (5, 0): the published test vector's words (packages/wallet/test/vectors/a8.json)
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 5n;
const W = freshWallet(SEED, "evm", L, 0).address;
const NULLIFIER = 0x1234567890abcdef1234n;

const relayOf = (o: Partial<EvmRelayData> = {}): EvmRelayData => ({ recipient: W, feeRecipient: FEE_TO, feeCap: FEE, deadlineMs: NOW + 170_000n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16), ...o });
function readyOf(relay = relayOf(), id = "n1", attempt = "a1"): ReadyProof<EvmPoolRequest> {
  const request: EvmPoolRequest = { processooor: POOL, relay };
  const context = evmPoolContextOf(request, evmPoolScopeOf(POOL, BigInt(B.chainId)));
  return {
    noteId: id,
    attempt,
    poolId: "evm:base",
    wallet: { chain: "evm", l: L, j: 0, path: "m", address: W },
    chunk: CHUNK,
    epochStartMs: NOW - 10_000n,
    deadlineMs: relay.deadlineMs,
    root: "epoch",
    binding: { context, feeCap: FEE, request },
    proof: { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] },
    publicSignals: ["11", NULLIFIER.toString(), CHUNK.toString(), "13", "14", "15", "16", context.toString()],
  };
}
const ASK: PoolAsk = { kind: "pool.buy", chain: "base", token: TOKEN, amount: CHUNK, slippageBps: 100, decimals: 18 };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const topic = (s: string) => "0x" + hex(keccak_256(new TextEncoder().encode(s)));
const w32 = (v: bigint) => v.toString(16).padStart(64, "0");
const HELPER_HASH = "0x" + "ab".repeat(32);
const TX = "0x" + "cd".repeat(32);
const DEADLINE = NOW + 170_000n;
const START = 0x100n;
const OTHER = "0x00000000000000000000000000000000000000aa";
type Rel = { kind?: "bought" | "withdrawn"; w?: string; feeTo?: string; value?: bigint; fee?: bigint; nullifier?: bigint; token?: string; out?: bigint; block?: bigint; tx?: string; address?: string };
/** A release log of the pool, as eth_getLogs gives it. */
const release = (o: Rel = {}) => {
  const head = [BigInt(o.feeTo ?? FEE_TO), o.value ?? CHUNK, o.fee ?? FEE, o.nullifier ?? NULLIFIER, 99n];
  const withdrawn = o.kind === "withdrawn";
  return {
    address: o.address ?? POOL,
    topics: [topic(withdrawn ? EVM_POOL_EVENTS.Withdrawn : EVM_POOL_EVENTS.Bought), "0x" + w32(BigInt(o.w ?? W))],
    data: "0x" + (withdrawn ? head : [...head, BigInt(o.token ?? TOKEN), o.out ?? 40_000_000n]).map(w32).join(""),
    blockNumber: "0x" + (o.block ?? 0x110n).toString(16),
    transactionHash: o.tx ?? TX,
    logIndex: "0x2",
    removed: false,
  };
};
/** One pool RPC: its newest block at the run's clock (`t`, or `time` for its block time), the releases it shows, and
 *  every call it got. */
type Side = { logs?: unknown[] | (() => unknown[]); time?: () => bigint; down?: boolean; start?: bigint };
type Call = { method: string; params: unknown };
const rpcOf = (side: Side, clock: { t: bigint }, calls: Call[]): EvmPoolBuyHost["rpcs"][0] => async (method, params) => {
  calls.push({ method, params });
  if (side.down) throw new Error("down");
  if (method === "eth_blockNumber") return "0x" + (side.start ?? START).toString(16);
  if (method === "eth_getBlockByNumber") return { number: "0x" + (START + 0x40n).toString(16), timestamp: "0x" + ((side.time?.() ?? clock.t) / 1000n).toString(16) };
  if (method === "eth_getLogs") return typeof side.logs === "function" ? side.logs() : (side.logs ?? []);
  throw new Error(`no ${method}`);
};

type Seen = { seeds: Uint8Array[]; takes: string[]; sends: { pool: string; data: Uint8Array; epoch: bigint }[]; settles: number; records: [string, EvmHolding][]; owed: EvmOwedBack[]; sent: number; late: EvmPoolBuyAnswer[]; quotes: EvmPoolBuyQuote["route"][]; calls: Call[]; order: string[]; clock: { t: bigint } };
type HostOpts = { ready?: ReadyProof<EvmPoolRequest>[]; a?: Side; b?: Side; send?: () => Promise<string>; quote?: () => Promise<EvmPoolBuyQuote>; claimed?: Set<string>; record?: () => Promise<void> };
/** Every host's sign out, aborted after each test: the reads a test leaves following end with it. */
const stops: AbortController[] = [];
afterEach(() => void stops.splice(0).forEach((c) => c.abort()));
function host(o: HostOpts = {}): { h: EvmPoolBuyHost; seen: Seen } {
  stops.push(new AbortController());
  const clock = { t: NOW };
  const seen: Seen = { seeds: [], takes: [], sends: [], settles: 0, records: [], owed: [], sent: 0, late: [], quotes: [], calls: [], order: [], clock };
  const ready = o.ready ?? [readyOf()];
  const h: EvmPoolBuyHost = {
    chain: "base",
    testnet: false,
    pin: { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n },
    venues: VENUES,
    rpcs: [rpcOf(o.a ?? {}, clock, seen.calls), rpcOf(o.b ?? {}, clock, seen.calls)],
    ready: async () => ready,
    take: async (id, attempt) => {
      seen.order.push("take");
      seen.takes.push(id);
      const r = ready.find((x) => x.noteId === id && x.attempt === attempt);
      if (!r) throw new Error("taken by another attempt");
      return r;
    },
    seed64: async () => {
      const s = SEED.slice();
      seen.seeds.push(s);
      return s;
    },
    // the device's quote: the standard shapes the kit refuses below its own best route (the recording's), then that one
    quote: async (req) => {
      seen.quotes.push(req.route);
      assert.equal(req.amountIn, CHUNK - FEE, "the quote is for what the pool swaps: the chunk less the proof's fee");
      assert.equal(req.slippageBps, ASK.slippageBps, "the quote is asked at the ask's own slippage");
      if (o.quote) return o.quote();
      const q = await fixtureQuote();
      if (JSON.stringify(req.route) !== JSON.stringify(FIXTURE_ROUTE)) throw new EvmQuoteError("below_reference", "the standard pool quotes more", { amountOut: q.amountOut, route: FIXTURE_ROUTE });
      return q;
    },
    build: (adapter, q) => evmQuotedBuy(VENUES, adapter, q, QF.now),
    decimals: async () => 6,
    send: async (body) => {
      seen.order.push("send");
      seen.sends.push(body);
      return o.send ? o.send() : HELPER_HASH;
    },
    settle: () => void seen.settles++,
    record: async (w, rec) => {
      seen.order.push(`record ${rec.state}`);
      if (o.record) await o.record();
      seen.records.push([w, structuredClone(rec)]);
    },
    owe: async (x) => void seen.owed.push(x),
    sent: () => void seen.sent++,
    late: (x) => void seen.late.push(x),
    claimed: o.claimed ?? new Set(),
    now: () => clock.t,
    // the chain's clock moves by each wait, and the event loop turns, so a follow that never ends starves no test
    wait: async (ms) => {
      await new Promise((r) => setImmediate(r));
      clock.t += BigInt(ms);
    },
    signal: stops.at(-1)!.signal,
  };
  return { h, seen };
}
const both = (logs: unknown[] | (() => unknown[])): Pick<HostOpts, "a" | "b"> => ({ a: { logs }, b: { logs } });
const lateOf = async (seen: Seen): Promise<EvmPoolBuyAnswer> => {
  for (let i = 0; i < 1000 && seen.late.length === 0; i++) await new Promise((r) => setImmediate(r));
  return seen.late[0]!;
};
const zero = (b: Uint8Array) => b.every((x) => x === 0);

test("the buy's calldata is the pool's canonical encoding: byte for byte the testnet run's buyData", async () => {
  const r = readyOf();
  const q = await fixtureQuote();
  const built = evmQuotedBuy(VENUES, A_V3, q, QF.now);
  const sig = Uint8Array.from({ length: 65 }, (_, i) => i + 1);
  const ours = evmBuyCalldata(POOL, r.binding.request.relay, r.proof, r.publicSignals, FEE, built, sig);
  const theirs = buyData(POOL, "0x" + hex(evmRelayDataBytes(r.binding.request.relay)), proofArg(r.proof, r.publicSignals), FEE, built, sig);
  assert.equal("0x" + hex(ours), theirs);
  assert.equal(hex(ours.subarray(0, 4)), "3edadd79", "PrivacyPoolSimple.buy's selector");
});

test("filled: one Bought for the nullifier, the same on both RPCs, paying W the token at least min out; filled names the release's own transaction and completes W's holding", async () => {
  const { h, seen } = host(both([release()]));
  const got = await runEvmPoolBuy(h, ASK);
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "base", hash: TX }] }, "the chain's transaction, never the helper's word");
  assert.deepEqual(seen.takes, ["n1"]);
  assert.equal(seen.sends.length, 1);
  assert.equal(seen.sends[0]!.epoch, NOW - 10_000n, "the epoch whose fee the proof binds");
  assert.equal(seen.sent, 1, "told sent once the bytes left");
  // the kit refused the first standard shape below its own best, and the device asked that best route once
  assert.deepEqual(seen.quotes.at(-1), FIXTURE_ROUTE);
  assert.equal(seen.quotes.length, 2, "the first standard shape, then the kit's best route once");
  const route = { venue: "uniswap-v3", adapter: A_V3, path: FIXTURE_ROUTE };
  assert.deepEqual(seen.records, [
    [W, { mint: TOKEN.toLowerCase(), decimals: 6, chain: "base", state: "pending", route }],
    [W, { mint: TOKEN.toLowerCase(), decimals: 6, chain: "base", state: "filled", received: "40", route: { ...route, tx: TX, block: "272" } }],
  ]);
  assert.equal(EVM_POSITION_COSTS_KEY, "owed/cost-evm");
  assert.equal(seen.settles, 1, "the settle pass ends the RESERVED note");
});

test("(ruling 2) the read-back names no W, nullifier or transaction to a public RPC: newest blocks and the pool's logs by address and topics only", async () => {
  const { h, seen } = host(both([release()]));
  await runEvmPoolBuy(h, ASK);
  assert.deepEqual([...new Set(seen.calls.map((c) => c.method))].sort(), ["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"]);
  const said = JSON.stringify(seen.calls.map((c) => c.params)).toLowerCase();
  for (const secret of [W.slice(2).toLowerCase(), w32(NULLIFIER), NULLIFIER.toString(16), HELPER_HASH.slice(2), TX.slice(2)]) assert.ok(!said.includes(secret), `no read names ${secret}`);
  const filter = seen.calls.find((c) => c.method === "eth_getLogs")!.params as [Record<string, unknown>];
  assert.deepEqual(filter, [{ address: POOL, topics: [[topic(EVM_POOL_EVENTS.Bought), topic(EVM_POOL_EVENTS.Withdrawn)]], fromBlock: "0x100", toBlock: "0x140" }]);
  // the two RPCs' newest blocks differ: the reads start at the lower, so neither misses the release
  const ahead = host({ a: { logs: [release()], start: START + 9n }, b: { logs: [release()] } });
  await runEvmPoolBuy(ahead.h, ASK);
  const froms = ahead.seen.calls.filter((c) => c.method === "eth_getLogs").map((c) => (c.params as [{ fromBlock: string }])[0].fromBlock);
  assert.ok(froms.length === 2 && froms.every((f) => f === "0x100"), froms.join(","));
});

test("(ruling 2) a Bought on one RPC only, or the two differing, is not filled; past the tap's bound the answer is sent, and the end goes out late once both agree", async () => {
  let lagging = true;
  const { h, seen } = host({ a: { logs: [release()] }, b: { logs: () => (lagging ? [] : [release()]) } });
  const got = await runEvmPoolBuy(h, ASK);
  assert.deepEqual(got, { stage: "sent", txs: [] });
  assert.ok(seen.clock.t - NOW >= BigInt(EVM_BUY_SETTLE_MS), "the tap read for its bound");
  assert.ok(seen.clock.t - NOW < BigInt(EVM_BUY_SETTLE_MS) + 10_000n, "and no longer");
  assert.equal(seen.records.length, 1, "W's holding is written pending all the same");
  lagging = false;
  assert.deepEqual(await lateOf(seen), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.equal(seen.records.at(-1)![1].state, "filled");
  assert.equal(seen.settles, 2, "the settle pass at the tap's answer, and again at the late end");
  for (const differ of [{ block: 0x111n }, { tx: "0x" + "ef".repeat(32) }, { out: 40_000_001n }]) {
    const r = host({ a: { logs: [release()] }, b: { logs: [release(differ)] } });
    assert.deepEqual(await runEvmPoolBuy(r.h, ASK), { stage: "sent", txs: [] }, JSON.stringify(differ, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }
});

test("(ruling 2) not_landed: the nullifier released elsewhere (another W, token, fee recipient, value, fee, or out under min out), or both RPCs' newest block past the deadline with none", async () => {
  for (const o of [{ w: OTHER }, { token: OTHER }, { feeTo: OTHER }, { value: CHUNK - 1n }, { fee: FEE + 1n }, { out: 1n }, { kind: "withdrawn" as const, w: OTHER }]) {
    const r = host(both([release(o)]));
    assert.deepEqual(await runEvmPoolBuy(r.h, ASK), { stage: "not_landed", txs: [] }, JSON.stringify(Object.keys(o)));
    assert.equal(r.seen.records.at(-1)![1].state, "pending");
  }
  // a release of another nullifier is not this buy's at all
  const near = host({ ready: [readyOf(relayOf({ deadlineMs: NOW + 100_000n }))], ...both([release({ nullifier: 5n })]) });
  assert.deepEqual(await runEvmPoolBuy(near.h, ASK), { stage: "not_landed", txs: [] });
  assert.ok(near.seen.clock.t > NOW + 100_000n, "only once the chain's time is past the deadline");
});

test("(ruling 2) never not_landed before the deadline on both RPCs: a send with nothing on chain reads on, and one RPC past it is not both", async () => {
  // nothing lands and the deadline is 170 s off: the tap answers sent at its bound; the end (not_landed) goes out late
  const { h, seen } = host();
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  assert.deepEqual(await lateOf(seen), { stage: "not_landed", txs: [] });
  assert.ok(seen.clock.t > DEADLINE);
  // one RPC's block time stuck before the deadline: never not_landed while it is, however long; the reads go on past
  // the follow window, slower, and the end goes out once that RPC moves (an hour past the deadline here)
  let moved = false;
  const stuck = host({ ready: [readyOf(relayOf({ deadlineMs: NOW + 100_000n }))], b: { time: () => (moved ? stuck.seen.clock.t : NOW) } });
  assert.deepEqual(await runEvmPoolBuy(stuck.h, ASK), { stage: "sent", txs: [] });
  for (let i = 0; i < 20_000 && stuck.seen.clock.t < NOW + 100_000n + 3_600_000n; i++) await new Promise((r) => setImmediate(r));
  assert.ok(stuck.seen.clock.t >= NOW + 100_000n + 3_600_000n, "the reads go on an hour past the deadline");
  assert.deepEqual(stuck.seen.late, [], "no end while one RPC is behind the deadline");
  const rounds = stuck.seen.calls.filter((c) => c.method === "eth_getLogs").length;
  assert.ok(rounds < 2 * (EVM_BUY_SETTLE_MS / 2_000 + (100_000 + 300_000) / 2_000 + 3_600_000 / 30_000) + 20, `slow past the follow window: ${rounds} reads`);
  moved = true;
  assert.deepEqual(await lateOf(stuck.seen), { stage: "not_landed", txs: [] });
});

test("the fee is the sender's pick up to the proof's cap (PrivacyPool.sol _release: FeeOverCap only): a release charging less is still this buy's, filled or owed back by its own fee", async () => {
  const { h, seen } = host(both([release({ fee: FEE / 2n, out: 41_000_000n })]));
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.equal(seen.records.at(-1)![1].received, "41");
  const free = host(both([release({ kind: "withdrawn", fee: 0n })]));
  assert.deepEqual(await runEvmPoolBuy(free.h, ASK), { stage: "refused", txs: [{ chain: "base", hash: TX }] });
  assert.equal(free.seen.owed[0]!.wei, CHUNK.toString(), "the chunk less the fee charged");
});

test("a sign out ends the reads past the tap: no late end, no more reads", async () => {
  // the two RPCs never agree: no end, so only the sign out stops the reads
  const { h, seen } = host({ a: { logs: [release()] }, b: { logs: [release({ block: 0x111n })] } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  stops.at(-1)!.abort();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const n = seen.calls.length;
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(seen.calls.length, n, "no read after the sign out");
  assert.deepEqual(seen.late, []);
});

test("(ruling 4) a Withdrawn for the nullifier: the buy did not fill, W's ETH (the chunk less the fee) is written owed back, and the answer names the release", async () => {
  const { h, seen } = host(both([release({ kind: "withdrawn" })]));
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "refused", txs: [{ chain: "base", hash: TX }] });
  assert.deepEqual(seen.owed, [{ address: W, chain: "base", wei: (CHUNK - FEE).toString(), tx: TX, block: "272" }]);
  assert.equal(seen.records.at(-1)![1].state, "withdrawn");
  assert.equal(EVM_OWED_BACK_KEY, "owed/back-evm");
});

test("(ruling 3) W's holding is written pending before the take and the send; a write that fails sends nothing and leaves the note HELD", async () => {
  const { h, seen } = host(both([release()]));
  assert.equal(((await runEvmPoolBuy(h, ASK)) as { stage: string }).stage, "filled");
  assert.deepEqual(seen.order.slice(0, 3), ["record pending", "take", "send"]);
  assert.equal(seen.records[0]![1].mint, TOKEN.toLowerCase(), "a landed buy is never without its record (ZZ-B2)");
  const failing = host({ record: () => Promise.reject(new Error("store closed")) });
  assert.deepEqual(await runEvmPoolBuy(failing.h, ASK), { error: "failed" });
  assert.deepEqual([failing.seen.takes.length, failing.seen.sends.length, failing.seen.settles, failing.h.claimed!.size], [0, 0, 0, 0]);
});

test("(ruling 1) the helper's 5xx, a coded-less 4xx, a timeout or a fault after the bytes left: never an error, the run reads on to the chain's end (ZZ-E)", async () => {
  for (const e of [new EvmSendNoAnswer(502, "not 200"), new EvmSendNoAnswer(503, "not 200"), new EvmSendNoAnswer(504, "not 200"), new EvmSendNoAnswer(400, "no code"), new EvmSendNoAnswer(null, "timeout"), new TypeError("fetch failed")]) {
    const { h, seen } = host({ send: () => Promise.reject(e), ...both([release()]) });
    assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] }, e.message);
    assert.deepEqual([seen.sends.length, seen.sent, seen.settles], [1, 1, 1]);
  }
});

test("(ruling 1) a fault of the page past the post is never an error: the stage is sent", async () => {
  const { h } = host(both([release()]));
  h.sent = () => {
    throw new Error("the page's answer failed");
  };
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
});

test("(ruling 1) only the helper's own 4xx naming a code is a refusal: refused, the note taken and settled, nothing read", async () => {
  const { h, seen } = host({ send: () => Promise.reject(new EvmSendRefused(422, "simulation_failed")) });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "refused", txs: [] });
  assert.deepEqual([seen.takes.length, seen.sends.length, seen.sent, seen.settles], [1, 1, 0, 1]);
  assert.ok(!seen.calls.some((c) => c.method === "eth_getLogs"));
});

test("(ruling 1) a busy helper is asked again after its Retry-After (at least 1 s) while the proof has more than the send margin left; then the run reads on", async () => {
  let n = 0;
  const { h, seen } = host({ send: async () => (++n < 3 ? Promise.reject(new EvmSendBusy(500)) : HELPER_HASH), ...both([release()]) });
  assert.equal(((await runEvmPoolBuy(h, ASK)) as { stage: string }).stage, "filled");
  assert.equal(seen.sends.length, 3);
  assert.equal(seen.clock.t - NOW >= 2_000n, true, "each wait at least 1 s");
  // busy for good: asked until the margin, then read on (never an error)
  const busy = host({ send: () => Promise.reject(new EvmSendBusy(60_000)), ...both([release()]) });
  assert.equal(((await runEvmPoolBuy(busy.h, ASK)) as { stage: string }).stage, "filled");
  assert.equal(busy.seen.sends.length, 2, "at 0 s, and at 60 s; a third would wait past the deadline less the margin");
  assert.ok(busy.seen.clock.t - NOW < 60_000n + 5_000n, "never past the deadline less the margin");
  // no margin left at all: asked once
  const late = host({ ready: [readyOf(relayOf({ deadlineMs: NOW + 61_000n }))], send: () => Promise.reject(new EvmSendBusy(1_000)), ...both([release()]) });
  await runEvmPoolBuy(late.h, ASK);
  assert.equal(late.seen.sends.length, 1);
});

test("(ruling 2) the read-back has a wall-clock bound however slow each read is, and the seed's lock is let go before it (ZZ-D)", async () => {
  const { h, seen } = host();
  let held = false;
  const during: boolean[] = [];
  h.hold = async (f) => {
    held = true;
    try {
      return await f();
    } finally {
      held = false;
    }
  };
  const rpcs = h.rpcs;
  h.rpcs = rpcs.map((rpc) => async (m: string, p: unknown) => {
    if (m === "eth_getLogs") {
      during.push(held);
      seen.clock.t += 8_000n; // a slow RPC: 8 s a read
    }
    return rpc(m as never, p as never);
  }) as never;
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  assert.ok(during.length > 0 && during.every((x) => x === false), "no read-back under the seed's lock");
  assert.ok(during.length < 20, `the tap's reads end at the bound: ${during.length}`);
});

test("(ruling 6) a device quote whose min out is under the ask's own slippage of its agreed output is never signed (the floor is the rule's, never the quote's)", async () => {
  const loose = await quoteAt(5_000);
  const q = await fixtureQuote();
  assert.ok(loose.minOut < q.minOut && loose.amountOut === q.amountOut, "the same route's output, a looser min out");
  const { h, seen } = host({ quote: async () => loose });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: "quote_check_failed" });
  assert.deepEqual([seen.seeds.length, seen.records.length, seen.takes.length, seen.sends.length], [0, 0, 0, 0]);
});

test("(ruling 6) the relay data's fee cap is held to the device's binding fee: a proof whose relay data commits more is never signed", async () => {
  const relay = relayOf({ feeCap: FEE * 2n });
  const r = readyOf(relay);
  const { h, seen } = host({ ready: [{ ...r, binding: { ...r.binding, feeCap: FEE } }] });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: "quote_check_failed" });
  assert.deepEqual([seen.seeds.length, seen.sends.length], [0, 0]);
});

test("a quote that fails checkEvmBuy is never signed: no seed read, no record, no take, no send", async () => {
  // the proof binds another fee recipient than the pinned one: the rule refuses fee_recipient
  const { h, seen } = host({ ready: [readyOf(relayOf({ feeRecipient: "0x0000000000000000000000000000000000000bad" }))] });
  const claimed = h.claimed!;
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: "quote_check_failed" });
  assert.deepEqual([seen.seeds.length, seen.records.length, seen.takes.length, seen.sends.length, seen.settles], [0, 0, 0, 0, 0]);
  assert.equal(claimed.size, 0, "the proof is released for the next tap");
  // a quote the providers fail: the search stops there, never on to the next shape
  for (const code of ["rpc_error", "rpc_disagree", "stale_quote"] as const) {
    const r = host({ quote: () => Promise.reject(new EvmQuoteError(code, "x")) });
    assert.deepEqual(await runEvmPoolBuy(r.h, ASK), { error: "quote_check_failed" }, code);
    assert.equal(r.seen.quotes.length, 1, code);
  }
  // a quote the kit refuses: never signed either
  const r2 = host({ quote: () => Promise.reject(new EvmQuoteError("stale_quote", "old")) });
  assert.deepEqual(await runEvmPoolBuy(r2.h, ASK), { error: "quote_check_failed" });
  assert.deepEqual([r2.seen.seeds.length, r2.seen.takes.length, r2.seen.sends.length], [0, 0, 0]);
  // the relay data names another recipient than the proof's W: refused by the rule before the seed is read
  const r3 = host({ ready: [readyOf(relayOf({ recipient: OTHER }))] });
  assert.deepEqual(await runEvmPoolBuy(r3.h, ASK), { error: "quote_check_failed" });
  assert.equal(r3.seen.seeds.length, 0);
});

test("(ruling 7) the pin, the venue list and the proof's own signals: each off is refused before the seed", async () => {
  const cases: [string, (h: EvmPoolBuyHost) => void, ReadyProof<EvmPoolRequest>[] | undefined, string][] = [
    ["the pin is another network's", (h) => void (h.pin = { ...h.pin, network: "robinhood" }), undefined, "not_allowed"],
    ["the venue list's pool is not the pin's", (h) => void (h.venues = Object.freeze({ base: { ...VENUES.base, pool: OTHER } }) as never), undefined, "not_allowed"],
    ["a fee of the whole chunk", () => {}, [{ ...readyOf(), binding: { ...readyOf().binding, feeCap: CHUNK } }], "not_funded"],
    ["the proof's context is not its binding's", () => {}, [{ ...readyOf(), publicSignals: readyOf().publicSignals.map((x, i) => (i === 7 ? "1" : x)) as never }], "failed"],
    ["the proof's value is not its chunk", () => {}, [{ ...readyOf(), publicSignals: readyOf().publicSignals.map((x, i) => (i === 2 ? "1" : x)) as never }], "failed"],
  ];
  for (const [name, edit, ready, code] of cases) {
    const { h, seen } = host({ ready });
    edit(h);
    assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: code }, name);
    assert.deepEqual([seen.seeds.length, seen.takes.length, seen.sends.length], [0, 0, 0], name);
  }
});

test("(ruling 7) keys: the seed is zeroed once W is derived, on every path; W must be the proof's W (W's key: zeroed once it signed and in the finally, src/pool-buy-evm.ts; freshWallet is called there directly, the wallet's one-derivation gate, so no test reaches the key)", async () => {
  const ok = host(both([release()]));
  await runEvmPoolBuy(ok.h, ASK);
  assert.ok(ok.seen.seeds.length === 1 && zero(ok.seen.seeds[0]!), "the seed");
  // already zero when the bytes are made: the record before the take sees it zeroed
  const at = host(both([release()]));
  const zeroAt: boolean[] = [];
  at.h.record = async (w, rec) => {
    if (rec.state === "pending") zeroAt.push(zero(at.seen.seeds[0]!));
    at.seen.records.push([w, rec]);
  };
  await runEvmPoolBuy(at.h, ASK);
  assert.deepEqual(zeroAt, [true], "the seed zeroed once W is derived");
  // a derive that throws (a label that is no field element): the seed zeroed all the same, nothing signed or sent
  const r0 = readyOf();
  const thrown = host({ ready: [{ ...r0, wallet: { ...r0.wallet, l: -1n } }] });
  assert.deepEqual(await runEvmPoolBuy(thrown.h, ASK), { error: "failed" });
  assert.equal(thrown.seen.seeds.length, 1, "the seed was read");
  assert.ok(zero(thrown.seen.seeds[0]!));
  assert.deepEqual([thrown.seen.records.length, thrown.seen.sends.length], [0, 0]);
  // W is not the proof's: refused before it signs, the seed zeroed, nothing recorded, taken or sent
  const other = host({ ready: [{ ...r0, wallet: { ...r0.wallet, j: 1 } }] });
  assert.deepEqual(await runEvmPoolBuy(other.h, ASK), { error: "failed" });
  assert.ok(zero(other.seen.seeds[0]!));
  assert.deepEqual([other.seen.records.length, other.seen.takes.length, other.seen.sends.length], [0, 0, 0]);
  // a fault after the signature (the record): the seed zeroed
  const fault = host({ record: () => Promise.reject(new Error("no store")) });
  await runEvmPoolBuy(fault.h, ASK);
  assert.ok(zero(fault.seen.seeds[0]!));
});

test("an RPC down before the signature: nothing signed, recorded, taken or sent", async () => {
  const { h, seen } = host({ b: { down: true } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: "failed" });
  assert.deepEqual([seen.seeds.length, seen.records.length, seen.takes.length, seen.sends.length, seen.settles, h.claimed!.size], [0, 0, 0, 0, 0, 0]);
});

test("(ruling 7) the take hands out this very attempt or nothing is sent", async () => {
  const r = readyOf();
  const { h, seen } = host();
  h.take = async () => (seen.takes.push("n1"), { ...r, attempt: "a2" });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: "failed" });
  assert.deepEqual([seen.sends.length, seen.settles], [0, 1]);
  // a remake swapped in after the pick: the take refuses, nothing is sent, nothing to settle
  const swapped = host();
  swapped.h.take = async () => {
    throw new Error("taken by another attempt");
  };
  assert.deepEqual(await runEvmPoolBuy(swapped.h, ASK), { error: "failed" });
  assert.deepEqual([swapped.seen.sends.length, swapped.seen.settles], [0, 0]);
  // a throw before the take (a decimals read that fails): no take, no settle, the claim released
  const early = host();
  early.h.decimals = async () => {
    throw new Error("the two RPCs differ");
  };
  assert.deepEqual(await runEvmPoolBuy(early.h, ASK), { error: "failed" });
  assert.deepEqual([early.seen.seeds.length, early.seen.takes.length, early.seen.settles, early.h.claimed!.size], [0, 0, 0, 0]);
});

test("a second tap while one is in flight takes another proof, or none", async () => {
  let release_!: () => void;
  const gate = new Promise<void>((r) => (release_ = r));
  const claimed = new Set<string>();
  const first = host({ ...both([release()]), claimed });
  first.h.quote = async (req) => {
    first.seen.quotes.push(req.route);
    await gate;
    return fixtureQuote();
  };
  const run1 = runEvmPoolBuy(first.h, ASK);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...claimed], ["n1"], "the first tap holds its proof");
  const second = host({ ...both([release()]), claimed });
  assert.deepEqual(await runEvmPoolBuy(second.h, ASK), { error: "not_funded" }, "the only ready proof is the first tap's");
  assert.equal(second.seen.seeds.length, 0);
  release_();
  assert.equal(((await run1) as { stage: string }).stage, "filled");
  assert.equal(claimed.size, 0);
});

test("a proof whose chunk is not the ask's amount, or an ask on another chain, is not this buy's", async () => {
  const { h } = host();
  assert.deepEqual(await runEvmPoolBuy(h, { ...ASK, amount: CHUNK + 1n }), { error: "not_funded" });
  assert.deepEqual(await runEvmPoolBuy(h, { ...ASK, chain: "robinhood" }), { error: "not_allowed" });
  assert.deepEqual(await runEvmPoolBuy(h, { ...ASK, kind: "pool.sell" }), { error: "not_allowed" });
});
