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
import { EVM_BUY_LAG_BLOCKS, EVM_BUY_SETTLE_MS, EVM_OWED_BACK_KEY, EVM_POSITION_COSTS_KEY, runEvmPoolBuy, type EvmHolding, type EvmOwedBack, type EvmPoolBuyAnswer, type EvmPoolBuyHost } from "../src/pool-buy-evm.ts";
import { evmBuyCalldata, EvmSendBusy, EvmSendNoAnswer, EvmSendRefused } from "../src/evm-send.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import * as R from "../src/rules/pool.ts";

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
// above the lag margin (EVM_BUY_LAG_BLOCKS, 400), so a read-back starts that margin under it
const START = 0x200n;
const OTHER = "0x00000000000000000000000000000000000000aa";
type Rel = { kind?: "bought" | "withdrawn"; w?: string; feeTo?: string; value?: bigint; fee?: bigint; nullifier?: bigint; token?: string; out?: bigint; block?: bigint; tx?: string; address?: string; blockHash?: string };
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
    blockHash: o.blockHash ?? "0x" + "be".repeat(32),
    removed: false,
  };
};
/** One pool RPC: its newest block at the run's clock (`t`, or `time` for its block time), the releases it shows, and
 *  every call it got. */
type Side = { logs?: unknown[] | (() => unknown[]); time?: () => bigint; down?: boolean; start?: bigint; head?: () => bigint; safeTime?: () => bigint };
type Call = { method: string; params: unknown };
const rpcOf = (side: Side, clock: { t: bigint }, calls: Call[]): EvmPoolBuyHost["rpcs"][0] => async (method, params) => {
  calls.push({ method, params });
  if (side.down) throw new Error("down");
  if (method === "eth_blockNumber") return "0x" + (side.start ?? START).toString(16);
  // the safe block is the newest one unless the side sets its time (`safeTime`)
  const safe = method === "eth_getBlockByNumber" && (params as unknown[])[0] === "safe" && side.safeTime !== undefined;
  // a block asked by number (the read-back's last block of a range cut by EVM_BUY_LOG_SPAN) answers that number
  const at = method === "eth_getBlockByNumber" && /^0x[0-9a-f]+$/.test(String((params as unknown[])[0])) ? BigInt(String((params as unknown[])[0])) : null;
  if (method === "eth_getBlockByNumber") return { number: "0x" + (at ?? side.head?.() ?? START + 0x40n).toString(16), timestamp: "0x" + ((safe ? side.safeTime!() : (side.time?.() ?? clock.t)) / 1000n).toString(16) };
  if (method === "eth_getLogs") return typeof side.logs === "function" ? side.logs() : (side.logs ?? []);
  throw new Error(`no ${method}`);
};

type Seen = { seeds: Uint8Array[]; takes: string[]; sends: { pool: string; data: Uint8Array; epoch: bigint }[]; settles: number; records: [string, EvmHolding][]; owed: EvmOwedBack[]; sent: number; late: EvmPoolBuyAnswer[]; quotes: EvmPoolBuyQuote["route"][]; calls: Call[]; order: string[]; clock: { t: bigint } };
type HostOpts = { ready?: ReadyProof<EvmPoolRequest>[]; a?: Side; b?: Side; send?: () => Promise<string>; quote?: () => Promise<EvmPoolBuyQuote>; claimed?: Set<string>; record?: () => Promise<void>; holdings?: Map<string, EvmHolding>; unrecord?: () => Promise<void>; following?: Set<string>; take?: () => Promise<void> };
/** Every host's sign out, aborted after each test: the reads a test leaves following end with it. */
const stops: AbortController[] = [];
afterEach(() => void stops.splice(0).forEach((c) => c.abort()));
function host(o: HostOpts = {}): { h: EvmPoolBuyHost; seen: Seen } {
  stops.push(new AbortController());
  const clock = { t: NOW };
  const seen: Seen = { seeds: [], takes: [], sends: [], settles: 0, records: [], owed: [], sent: 0, late: [], quotes: [], calls: [], order: [], clock };
  const ready = o.ready ?? [readyOf()];
  const kept = o.holdings ?? new Map<string, EvmHolding>();
  const h: EvmPoolBuyHost = {
    chain: "base",
    testnet: false,
    pin: { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n },
    venues: VENUES,
    rpcs: [rpcOf(o.a ?? {}, clock, seen.calls), rpcOf(o.b ?? {}, clock, seen.calls)],
    ready: async () => ready,
    take: async (id, attempt) => {
      seen.order.push("take");
      if (o.take) await o.take();
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
    // W's holdings as the page's host keeps them (evmBuyHost): a pending write refuses a W that has one; the removal
    // takes only that W's pending record of the nullifier given
    record: async (w, rec) => {
      seen.order.push(`record ${rec.state}`);
      if (o.record) await o.record();
      if (rec.state === "pending" && kept.has(w)) throw new Error("W already has a holding");
      kept.set(w, structuredClone(rec));
      seen.records.push([w, structuredClone(rec)]);
    },
    unrecord: async (w, n, d) => {
      if (o.unrecord) await o.unrecord();
      const mine = kept.get(w);
      if (mine?.state === "pending" && mine.buy?.nullifier === n.toString() && mine.buy.deadlineMs === d.toString()) kept.delete(w);
    },
    holdings: async () => Object.fromEntries(kept),
    following: o.following ?? new Set(),
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
  // what the chain is asked to end the buy, with the pending record: the nullifier, the read-back's first block, the
  // deadline, W's signed min out, the chunk, the fee cap and the fee recipient
  const minOut = seen.records[0]![1].buy?.minOut ?? "";
  assert.ok(/^[1-9][0-9]*$/.test(minOut), minOut);
  const buy = { nullifier: NULLIFIER.toString(), from: (START - EVM_BUY_LAG_BLOCKS).toString(), deadlineMs: DEADLINE.toString(), minOut, value: CHUNK.toString(), feeCap: FEE.toString(), feeRecipient: FEE_TO };
  assert.deepEqual(seen.records, [
    [W, { mint: TOKEN.toLowerCase(), decimals: 6, chain: "base", state: "pending", route, buy }],
    [W, { mint: TOKEN.toLowerCase(), decimals: 6, chain: "base", state: "filled", received: "40", route: { ...route, tx: TX, block: "272" }, buy }],
  ]);
  assert.equal(EVM_POSITION_COSTS_KEY, "owed/cost-evm");
  assert.equal(seen.settles, 1, "the settle pass ends the RESERVED note");
});

// card fresh-money-spendable-at-once: a tap spends one whole chunk, the ask's; among proofs of that chunk one on the
// epoch root goes before one on the newest root (a note that landed this epoch), which is spent only when it alone is
// the amount
test("the pick takes a proof of the ask's chunk on the epoch root before one on the newest root, and the newest one when it alone is the amount", async () => {
  const newest: ReadyProof<EvmPoolRequest> = { ...readyOf(relayOf(), "n0", "a0"), root: "newest" };
  const a = host({ ready: [newest, readyOf()], ...both([release()]) });
  assert.deepEqual(await runEvmPoolBuy(a.h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.deepEqual(a.seen.takes, ["n1"], "the epoch-root proof");
  const b = host({ ready: [newest], ...both([release()]) });
  assert.deepEqual(await runEvmPoolBuy(b.h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.deepEqual(b.seen.takes, ["n0"], "the newest-root proof alone");
  // the chunk comes first: an epoch-root proof of another chunk is never the pick
  const c = host({ ready: [{ ...readyOf(), chunk: CHUNK * 2n }, newest], ...both([release()]) });
  assert.deepEqual(await runEvmPoolBuy(c.h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.deepEqual(c.seen.takes, ["n0"]);
});

test("(ruling 2) the read-back names no W, nullifier or transaction to a public RPC: newest blocks and the pool's logs by address and topics only", async () => {
  const { h, seen } = host(both([release()]));
  await runEvmPoolBuy(h, ASK);
  assert.deepEqual([...new Set(seen.calls.map((c) => c.method))].sort(), ["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"]);
  const said = JSON.stringify(seen.calls.map((c) => c.params)).toLowerCase();
  for (const secret of [W.slice(2).toLowerCase(), w32(NULLIFIER), NULLIFIER.toString(16), HELPER_HASH.slice(2), TX.slice(2)]) assert.ok(!said.includes(secret), `no read names ${secret}`);
  const filter = seen.calls.find((c) => c.method === "eth_getLogs")!.params as [Record<string, unknown>];
  assert.deepEqual(filter, [{ address: POOL, topics: [[topic(EVM_POOL_EVENTS.Bought), topic(EVM_POOL_EVENTS.Withdrawn)]], fromBlock: "0x" + (START - EVM_BUY_LAG_BLOCKS).toString(16), toBlock: "0x" + (START + 0x40n).toString(16) }]);
  // the two RPCs' newest blocks differ: the reads start a lag margin (EVM_BUY_LAG_BLOCKS) under the lower, so neither misses the release
  const ahead = host({ a: { logs: [release()], start: START + 9n }, b: { logs: [release()] } });
  await runEvmPoolBuy(ahead.h, ASK);
  const froms = ahead.seen.calls.filter((c) => c.method === "eth_getLogs").map((c) => (c.params as [{ fromBlock: string }])[0].fromBlock);
  assert.ok(froms.length === 2 && froms.every((f) => f === "0x" + (START - EVM_BUY_LAG_BLOCKS).toString(16)), froms.join(","));
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

test("(ruling 1) only the helper's own 4xx naming a code is a refusal: refused, the note taken and settled, nothing read before the answer (W's follow reads after it: pending end 1)", async () => {
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

// ---- the second review's fixes (FIX of 39c2ab9c): each fails at 39c2ab9c ----
// the new names read through the module, so this file loads at 39c2ab9c too and each test below fails there on its own
const M = (await import("../src/pool-buy-evm.ts")) as Record<string, unknown>;
const LAG_MS = M.EVM_BUY_LAG_MS as number;
const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const logReads = (seen: Seen) => seen.calls.filter((c) => c.method === "eth_getLogs").map((c) => (c.params as { fromBlock: string; toBlock: string }[])[0]!);

test("(P2-1 a, ZZ-N1) both RPCs past the deadline while their logs trail one round: never not_landed on one round; the Bought the round after is filled", async () => {
  let n = 0;
  const logs = () => (++n <= 2 ? [] : [release()]);
  const past = () => DEADLINE + 1_000n;
  const { h, seen } = host({ a: { logs, time: past }, b: { logs, time: past } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.equal(seen.records.at(-1)![1].state, "filled");
});

test("(P2-1 a) not_landed with no release needs two rounds of it at least the wallet's lag margin apart (EVM_LAG_TRIES x EVM_LAG_WAIT_MS)", async () => {
  assert.equal(LAG_MS, 10_000);
  const past = () => DEADLINE + 1_000n;
  const { h, seen } = host({ a: { time: past }, b: { time: past } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "not_landed", txs: [] });
  const rounds = logReads(seen).length / 2;
  assert.ok(rounds >= 1 + LAG_MS / 2_000, `${rounds} rounds`);
  // a round between them that is not "none, past the deadline" (one side shows a release) starts the count again
  let k = 0;
  const flicker = () => (++k === 3 ? [release()] : []);
  const again = host({ a: { time: past, logs: flicker }, b: { time: past } });
  assert.deepEqual(await runEvmPoolBuy(again.h, ASK), { stage: "not_landed", txs: [] });
  assert.ok(logReads(again.seen).length / 2 >= 4 + LAG_MS / 2_000, "counted again from the round after the release");
});

test("(P2-1 b) the deadline is judged on the safe block: the newest past it while the safe one is not is never not_landed, and the safe one passing ends it", async () => {
  let safe = NOW;
  const side = (): Side => ({ time: () => DEADLINE + 1_000n, safeTime: () => safe });
  const { h, seen } = host({ a: side(), b: side() });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  await turns(200);
  assert.deepEqual(seen.late, [], "no end while the safe block is before the deadline");
  assert.ok(seen.calls.some((c) => c.method === "eth_getBlockByNumber" && (c.params as unknown[])[0] === "safe"));
  safe = DEADLINE + 1_000n;
  assert.deepEqual(await lateOf(seen), { stage: "not_landed", txs: [] });
});

test("(P2-1 c, ZZ-H1) the two RPCs naming the release in blocks of one number and two hashes: never filled", async () => {
  const { h, seen } = host({ a: { logs: [release({ blockHash: "0x" + "11".repeat(32) })] }, b: { logs: [release({ blockHash: "0x" + "22".repeat(32) })] } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  await turns(50);
  assert.deepEqual(seen.records.map((r) => r[1].state), ["pending"]);
  assert.deepEqual(seen.late, []);
});

test("(P2-2, ZZ-S1) a sign out while a round's logs are read: that round writes nothing and starts no settle", async () => {
  let n = 0;
  const logs = () => {
    n++;
    if (n === 7) stops.at(-1)!.abort();
    return n >= 7 ? [release()] : [];
  };
  const { h, seen } = host({ a: { logs }, b: { logs } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  await turns(50);
  assert.deepEqual(seen.records.map((r) => r[1].state), ["pending"]);
  assert.equal(seen.settles, 0);
  assert.deepEqual(seen.late, []);
});

test("(P2-2, ZZ-S2) a sign out during a follow with no end: no settle is started after it", async () => {
  const { h, seen } = host({ a: { logs: [release()] }, b: { logs: [release({ block: 0x111n })] } });
  await runEvmPoolBuy(h, ASK);
  await turns(20);
  const before = seen.settles;
  stops.at(-1)!.abort();
  await turns(50);
  assert.equal(seen.settles, before);
});

test("(P2-2, m31) a sign out during the tap's own reads ends them, even on rounds whose reads fail", async () => {
  const logs = () => {
    stops.at(-1)!.abort();
    throw new Error("down");
  };
  const { h, seen } = host({ a: { logs }, b: { logs } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  await turns(50);
  assert.ok(logReads(seen).length <= 4, `${logReads(seen).length} log reads after the sign out`);
  assert.equal(seen.settles, 0);
});

test("(P2-3, ZZ-R1) a coded 4xx after a busy answer is no answer: the run follows the chain (the first POST's bytes landed)", async () => {
  let n = 0;
  const { h, seen } = host({ ...both([release()]), send: async () => Promise.reject(n++ === 0 ? new EvmSendBusy(1_000) : new EvmSendRefused(422, "simulation_failed")) });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.equal(seen.sends.length, 2);
  assert.equal(seen.records.at(-1)![1].state, "filled");
});

test("(P3-4, ZZ-G1) two heads further apart than EVM_BUY_HEAD_SPREAD are refused before W signs; the range starts a lag margin under the lower head and stops at the safe block past the deadline", async () => {
  const spread = M.EVM_BUY_HEAD_SPREAD as bigint;
  const apart = host({ a: { start: START + spread + 1n }, b: {} });
  assert.deepEqual(await runEvmPoolBuy(apart.h, ASK), { error: "failed" });
  assert.deepEqual([apart.seen.seeds.length, apart.seen.sends.length, apart.seen.takes.length], [0, 0, 0]);
  // a chain of a block a second; the two RPCs never agree, so the reads go on long past the deadline
  const head = () => START + (seenOf.clock.t - NOW) / 1_000n;
  const { h, seen } = host({ a: { logs: [release()], head, start: START + 3n }, b: { logs: [release({ block: 0x111n })], head } });
  const seenOf = seen;
  await runEvmPoolBuy(h, ASK);
  for (let i = 0; i < 2_000 && seen.clock.t < DEADLINE + 600_000n; i++) await turns(1);
  const ranges = logReads(seen);
  assert.equal(BigInt(ranges[0]!.fromBlock), START - (M.EVM_BUY_LAG_BLOCKS as bigint), "a lag margin under the lower head");
  const last = ranges.at(-1)!;
  assert.ok(BigInt(last.toBlock) <= START + 171n + 1n, `the range stops at the deadline's block, not the head (${BigInt(last.toBlock)})`);
  assert.ok(head() > BigInt(last.toBlock) + 300n);
});

test("(P3-5) a sign out started during a busy wait ends it at once: one POST, the run ends sent, nothing read or settled", async () => {
  let out = false;
  const { h, seen } = host({ ...both([release()]), send: () => Promise.reject(new EvmSendBusy(60_000)) });
  h.stopped = () => out || (out = seen.clock.t >= NOW + 1_000n);
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  assert.equal(seen.sends.length, 1);
  assert.ok(seen.clock.t - NOW < 2_000n, `ended ${seen.clock.t - NOW} ms in, not at the helper's 60 s`);
  assert.deepEqual([logReads(seen).length, seen.settles, seen.sent], [0, 0, 1]);
});

// W's key: the test derives W itself (as W's address above), so it knows the key's bytes, and counts every fill(0) of a
// 32-byte array holding them: the derivation's own wipes (counted on a derivation alone), plus the run's (the review's
// zz K1 and K2, which hold the run's two zeroings with no hook in the source)
const fillsOf = async (key: Uint8Array, run: (mark: (s: string) => void) => unknown): Promise<string[]> => {
  const order: string[] = [];
  const real = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (this: Uint8Array, ...a: [number, number?, number?]) {
    if (a[0] === 0 && this.length === 32 && this.every((x, i) => x === key[i])) order.push("key zeroed");
    return real.apply(this, a);
  } as never;
  try {
    await run((s) => void order.push(s));
  } finally {
    Uint8Array.prototype.fill = real;
  }
  return order;
};
const zeroings = (order: string[], until?: string) => (until === undefined ? order : order.slice(0, order.indexOf(until))).filter((x) => x === "key zeroed").length;
test("(keys, zz K1) W's key is zeroed after the signature, before anything is recorded, taken or sent", async () => {
  const KEY = freshWallet(SEED, "evm", L, 0).secretKey;
  const alone = zeroings(await fillsOf(KEY, () => void freshWallet(SEED, "evm", L, 0)));
  const { h } = host(both([release()]));
  const rec = h.record;
  const order = await fillsOf(KEY, async (mark) => {
    h.record = async (w, r) => (mark(`record ${r.state}`), rec(w, r));
    await runEvmPoolBuy(h, ASK);
  });
  assert.equal(zeroings(order, "record pending"), alone + 1);
});
test("(keys, zz K2) W's key is zeroed when the run ends between the derive and the signature", async () => {
  const r0 = readyOf();
  const KEY = freshWallet(SEED, "evm", L, 1).secretKey;
  const alone = zeroings(await fillsOf(KEY, () => void freshWallet(SEED, "evm", L, 1)));
  const { h, seen } = host({ ready: [{ ...r0, wallet: { ...r0.wallet, j: 1 } }] });
  const order = await fillsOf(KEY, async () => assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: "failed" }));
  assert.equal(zeroings(order), alone + 1);
  assert.equal(seen.sends.length, 0);
});

test("(m07) the rule checks the quote's own amount in, never the run's sum: a device quote for another amount than the chunk less the fee is never signed", async () => {
  // a proof of one wei more than the recording's chunk: the run asks a quote for the recording's amount plus one, and the
  // kit (here) answers its genuine quote of the recording's amount
  const r0 = readyOf();
  const c2 = CHUNK + 1n;
  const ready = { ...r0, chunk: c2, publicSignals: r0.publicSignals.map((x, i) => (i === 2 ? c2.toString() : x)) as typeof r0.publicSignals };
  const { h, seen } = host({ ready: [ready] });
  h.quote = async () => fixtureQuote();
  assert.deepEqual(await runEvmPoolBuy(h, { ...ASK, amount: c2 }), { error: "quote_check_failed" });
  assert.deepEqual([seen.seeds.length, seen.sends.length], [0, 0]);
});

test("(P2-2) a sign out during the follow's own end write: no settle is started after it", async () => {
  // nothing until past the tap's bound; then the Bought, and the sign out lands while its record is written
  const late = () => (seenOf.clock.t > NOW + BigInt(EVM_BUY_SETTLE_MS) + 10_000n ? [release()] : []);
  const { h, seen } = host({ ...both(late), record: async () => void (seenOf.records.length > 0 && stops.at(-1)!.abort()) });
  const seenOf = seen;
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  const before = seen.settles;
  await turns(200);
  assert.deepEqual(seen.records.map((r) => r[1].state), ["pending", "filled"]);
  assert.equal(seen.settles, before, "the follow's end after a sign out starts no settle");
  assert.deepEqual(seen.late, []);
});

// ---- the pending record's end (review P3-7): each fails at e5978942 ----
const followPending = M.followPendingEvmBuys as ((h: EvmPoolBuyHost) => Promise<void>) | undefined;
const pastAll = (): Pick<HostOpts, "a" | "b"> => ({ a: { time: () => DEADLINE + 1_000n }, b: { time: () => DEADLINE + 1_000n } });

const until = async (done: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setImmediate(r));
  return done();
};

test("(pending end 1) a coded refusal on the first POST is the helper's word: the run answers refused and its pending record stays; no release by the two-round safe rule removes it and the same note buys again; a Bought after it fills W's holding, never removed", async () => {
  const refuse = () => Promise.reject(new EvmSendRefused(422, "simulation_failed"));
  // an honest refusal: nothing on either RPC, past the deadline
  const kept = new Map<string, EvmHolding>();
  const first = host({ holdings: kept, send: refuse, ...pastAll() });
  assert.deepEqual(await runEvmPoolBuy(first.h, ASK), { stage: "refused", txs: [] });
  assert.equal(kept.get(W)?.state, "pending", "the pending stays at the answer");
  assert.ok(await until(() => !kept.has(W)), "the run's own follow ends it not_landed in the same page life");
  assert.deepEqual(first.seen.late, [], "the app was told refused: not_landed is no news");
  assert.equal(first.h.following!.size, 0);
  const next = host({ holdings: kept, ...both([release()]) });
  assert.deepEqual(await runEvmPoolBuy(next.h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.equal(next.seen.sends.length, 1);
  // a lying helper: it refused and sent the bytes all the same
  const lied = new Map<string, EvmHolding>();
  const liar = host({ holdings: lied, send: refuse, ...both([release()]) });
  assert.deepEqual(await runEvmPoolBuy(liar.h, ASK), { stage: "refused", txs: [] });
  assert.ok(await until(() => lied.get(W)?.state === "filled"), "the Bought fills W's holding");
  assert.deepEqual([lied.get(W)?.received, lied.get(W)?.route.tx], ["40", TX]);
  assert.deepEqual(liar.seen.late, [{ stage: "filled", txs: [{ chain: "base", hash: TX }] }], "the end the helper denied goes out late");
  assert.equal(liar.seen.settles, 2, "the settle at the answer, and again at the end");
});

test("(pending end 2) not_landed by the two-round safe rule removes this run's pending record with the verdict: the same note's next buy signs and sends", async () => {
  const kept = new Map<string, EvmHolding>();
  const first = host({ holdings: kept, ...pastAll() });
  assert.deepEqual(await runEvmPoolBuy(first.h, ASK), { stage: "not_landed", txs: [] });
  assert.equal(kept.has(W), false, "no pending left");
  const next = host({ holdings: kept, ...both([release()]) });
  assert.deepEqual(await runEvmPoolBuy(next.h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] });
  assert.equal(next.seen.sends.length, 1);
});

test("(pending end 3, 4) withdrawn keeps the owed record; every end where bytes may have left with no verdict keeps the pending one, and the same note's next buy is refused with nothing sent", async () => {
  const cases: [string, HostOpts, (h: EvmPoolBuyHost) => void][] = [
    ["withdrawn", both([release({ kind: "withdrawn" })]), () => {}],
    ["sent, the follow still running", {}, () => {}],
    ["every read failing", {}, () => {}],
    ["a busy answer, then a coded refusal", { send: (() => { let n = 0; return () => Promise.reject(n++ === 0 ? new EvmSendBusy(1_000) : new EvmSendRefused(422, "simulation_failed")); })() }, () => {}],
    ["a sign out during the reads", { a: { logs: () => (stops.at(-1)!.abort(), []) }, b: {} }, () => {}],
  ];
  for (const [why, o] of cases) {
    const kept = new Map<string, EvmHolding>();
    const first = host({ ...o, holdings: kept });
    if (why === "every read failing") {
      // the heads are read before W signs: down only once the bytes have left
      let sentYet = false;
      const send = first.h.send;
      first.h.send = async (b) => ((sentYet = true), send(b));
      const [a, b] = first.h.rpcs;
      first.h.rpcs = [async (m, p) => (sentYet && m !== "eth_blockNumber" ? Promise.reject(new Error("down")) : a(m, p)), async (m, p) => (sentYet && m !== "eth_blockNumber" ? Promise.reject(new Error("down")) : b(m, p))];
    }
    const end = await runEvmPoolBuy(first.h, ASK);
    assert.ok(kept.has(W), `${why}: W's record kept (${JSON.stringify(end)})`);
    assert.equal(kept.get(W)!.state, why === "withdrawn" ? "withdrawn" : "pending", why);
    const next = host({ holdings: kept, ...both([release()]) });
    assert.deepEqual(await runEvmPoolBuy(next.h, ASK), { error: "failed" }, why);
    assert.deepEqual([next.seen.takes.length, next.seen.sends.length], [0, 0], why);
  }
});

test("(pending end, review P2-B) a take that refuses, or gives another attempt, ends the run before anything leaves: the device's own knowledge, so its pending record is removed and the remade proof buys", async () => {
  for (const why of ["the take throws", "another attempt"] as const) {
    const kept = new Map<string, EvmHolding>();
    const first = host(
      why === "the take throws"
        ? { holdings: kept, take: () => Promise.reject(new Error("the proof's epoch ended over 15000 ms ago: it is made again first")) }
        : { holdings: kept },
    );
    if (why === "another attempt") {
      const take = first.h.take;
      first.h.take = async (id) => ({ ...(await take(id, "a1")), attempt: "a2" });
    }
    assert.deepEqual(await runEvmPoolBuy(first.h, ASK), { error: "failed" }, why);
    assert.deepEqual([first.seen.sends.length, kept.has(W)], [0, false], `${why}: nothing sent, no pending left`);
    const next = host({ holdings: kept, ready: [readyOf(relayOf(), "n1", "a2")], ...both([release()]) });
    assert.deepEqual(await runEvmPoolBuy(next.h, ASK), { stage: "filled", txs: [{ chain: "base", hash: TX }] }, why);
  }
});

test("(pending end, review P3-D) not_landed with a release of the nullifier to another W (the note spent elsewhere) ends the record too: no load reads it again", async () => {
  const kept = new Map<string, EvmHolding>();
  const elsewhere = both([release({ w: OTHER })]);
  const first = host({ holdings: kept, ...elsewhere });
  assert.deepEqual(await runEvmPoolBuy(first.h, ASK), { stage: "not_landed", txs: [] });
  assert.equal(kept.has(W), false);
  const load = host({ holdings: kept, ...elsewhere });
  await followPending!(load.h);
  assert.equal(load.seen.calls.length, 0, "nothing left to read");
});

test("(pending end, review P3-F) a tap whose W another follow of the page holds leaves that follow's mark: the next state read starts no second follow", async () => {
  const kept = new Map<string, EvmHolding>();
  const tab = host({ holdings: kept });
  await runEvmPoolBuy(tab.h, ASK);
  stops.at(-1)!.abort();
  await turns(20);
  const following = new Set<string>([W.toLowerCase()]);
  const tap = host({ holdings: kept, following });
  assert.deepEqual(await runEvmPoolBuy(tap.h, ASK), { error: "failed" });
  assert.ok(following.has(W.toLowerCase()), "still the load's follow's");
});

test("(pending end, review P1-A) a pending record read again far past its own start: 50,000 blocks on ends not_landed and is removed, 10,000 as before, and a release inside the capped range still fills", async () => {
  for (const [blocks, landed] of [[50_000n, false], [10_000n, false], [50_000n, true]] as const) {
    const kept = new Map<string, EvmHolding>();
    const tab = host({ holdings: kept });
    await runEvmPoolBuy(tab.h, ASK);
    stops.at(-1)!.abort();
    await turns(20);
    const from = BigInt(kept.get(W)!.buy!.from);
    let reads = 0;
    const logs = () => {
      if (++reads >= 400) stops.at(-1)!.abort();
      return landed ? [release({ block: from + 5_000n })] : [];
    };
    const side: Side = { logs, head: () => from + blocks, time: () => DEADLINE + 3_600_000n };
    const load = host({ holdings: kept, a: side, b: side });
    load.seen.clock.t = NOW + 4_000_000n;
    await followPending!(load.h);
    const at = `${blocks} blocks, ${landed ? "landed" : "none"}`;
    if (landed) assert.equal(kept.get(W)?.state, "filled", at);
    else assert.equal(kept.has(W), false, `${at}: removed`);
    assert.ok(reads < 10, `${at}: ended in ${reads} log reads`);
  }
});

test("(pending end, review P3-G) the load's follow: the fee recipient is the pin's, never the record's; decimals not an integer 0 to 36, or a start block under the pool's deploy or past both newest blocks, leave the record unread", async () => {
  const kept = new Map<string, EvmHolding>();
  const tab = host({ holdings: kept });
  await runEvmPoolBuy(tab.h, ASK);
  stops.at(-1)!.abort();
  await turns(20);
  const rec = kept.get(W)!;
  // a record naming another fee recipient: a release paying that one is not this buy's, so it does not fill
  const BAD_FEE = "0x00000000000000000000000000000000000000bb";
  const edited = new Map<string, EvmHolding>([[W, { ...rec, buy: { ...rec.buy!, feeRecipient: BAD_FEE } }]]);
  const paid: Side = { logs: [release({ feeTo: BAD_FEE })], time: () => DEADLINE + 1_000n };
  const l1 = host({ holdings: edited, a: paid, b: paid });
  l1.seen.clock.t = NOW + 200_000n;
  await followPending!(l1.h);
  assert.notEqual(edited.get(W)?.state, "filled", "not filled by another fee recipient's release");
  assert.equal(l1.seen.owed.length, 0);
  for (const [why, bad] of [
    ["decimals -1", { ...rec, decimals: -1 }],
    ["decimals 1.5", { ...rec, decimals: 1.5 }],
    ["decimals 256", { ...rec, decimals: 256 }],
    ["a start block of 78 digits", { ...rec, buy: { ...rec.buy!, from: "9".repeat(78) } }],
    ["a start block under the pool's deploy", { ...rec, buy: { ...rec.buy!, from: "0" } }],
  ] as [string, EvmHolding][]) {
    const store = new Map<string, EvmHolding>([[W, bad]]);
    const load = host({ holdings: store, ...both([release()]), ...pastAll() });
    load.h.pin = { ...load.h.pin, fromBlock: 2n };
    await followPending!(load.h);
    assert.deepEqual(store.get(W), bad, `${why}: left as it is`);
    assert.equal(load.seen.calls.filter((c) => c.method === "eth_getLogs").length, 0, `${why}: unread`);
  }
});

test("(pending end, review P3-1) the run's own record of a token with 40 decimals (the rule takes up to TOKEN_DECIMALS_MAX) is followed by the load: a Bought on both RPCs fills it", async () => {
  const kept = new Map<string, EvmHolding>();
  const tab = host({ holdings: kept });
  tab.h.decimals = async () => 40;
  assert.deepEqual(await runEvmPoolBuy(tab.h, ASK), { stage: "sent", txs: [] });
  stops.at(-1)!.abort();
  await turns(20);
  assert.deepEqual([kept.get(W)?.state, kept.get(W)?.decimals], ["pending", 40]);
  const load = host({ holdings: kept, ...both([release()]) });
  load.seen.clock.t = NOW + 200_000n;
  await followPending!(load.h);
  assert.deepEqual([kept.get(W)?.state, kept.get(W)?.received], ["filled", R.poolUnits(40_000_000n, 40)]);
  assert.equal(load.seen.settles, 1, "the note's settle runs, so its Bought spends it and the queue proves the next one");
  assert.equal((R as { TOKEN_DECIMALS_MAX?: number }).TOKEN_DECIMALS_MAX, 255, "one bound, the rule's");
});

test("(pending end) a removal that fails leaves the pending record: the next buy is refused, nothing is doubled", async () => {
  const kept = new Map<string, EvmHolding>();
  const first = host({ holdings: kept, unrecord: () => Promise.reject(new Error("store closed")), ...pastAll() });
  assert.deepEqual(await runEvmPoolBuy(first.h, ASK), { stage: "not_landed", txs: [] });
  assert.equal(kept.get(W)?.state, "pending");
  const next = host({ holdings: kept, ...both([release()]) });
  assert.deepEqual(await runEvmPoolBuy(next.h, ASK), { error: "failed" });
  assert.equal(next.seen.sends.length, 0);
});

test("(pending end, dead tab) a pending record whose tab died before its end is followed at the next load from the record's own block range: not_landed removes it, a Bought fills it", async () => {
  assert.equal(typeof followPending, "function", "followPendingEvmBuys");
  for (const landed of [false, true]) {
    const kept = new Map<string, EvmHolding>();
    // the tab sends, answers sent at its bound, and dies (its signal aborted) while its follow reads on
    const tab = host({ holdings: kept });
    assert.deepEqual(await runEvmPoolBuy(tab.h, ASK), { stage: "sent", txs: [] });
    stops.at(-1)!.abort();
    await turns(20);
    assert.equal(kept.get(W)?.state, "pending");
    assert.equal(kept.get(W)!.buy!.nullifier, NULLIFIER.toString());
    // the next load: another tab, its own clock from the send
    const load = host({ holdings: kept, ...(landed ? both([release()]) : {}) });
    load.seen.clock.t = NOW + 200_000n;
    await followPending!(load.h);
    if (landed) assert.deepEqual([kept.get(W)?.state, kept.get(W)?.received, kept.get(W)?.route.tx], ["filled", "40", TX]);
    else assert.equal(kept.has(W), false, "never landed: removed, so the note can buy again");
    assert.ok(logReads(load.seen).every((r) => BigInt(r.fromBlock) === START - EVM_BUY_LAG_BLOCKS), "from the record's own block");
    assert.equal(load.seen.settles, 1, "the settle pass ends the note");
  }
});

test("(pending end) the load's follow leaves a W this page follows, a record of another chain, a filled one or one without its buy", async () => {
  const kept = new Map<string, EvmHolding>();
  const tab = host({ holdings: kept });
  await runEvmPoolBuy(tab.h, ASK);
  const rec = kept.get(W)!;
  const others: [string, EvmHolding][] = [["0x" + "01".repeat(20), { ...rec, chain: "robinhood" }], ["0x" + "02".repeat(20), { ...rec, state: "filled" }], ["0x" + "03".repeat(20), (({ buy: _b, ...r }) => r)(rec)]];
  for (const [w, r] of others) kept.set(w, r);
  const load = host({ holdings: kept, following: new Set([W.toLowerCase()]), ...pastAll() });
  await followPending!(load.h);
  assert.equal(load.seen.calls.length, 0, "no read at all, not even the newest blocks (review P3-3)");
  assert.equal(kept.size, 4);
});

// card pool-buy-record-never-stays-sent: the balance counts a RESERVED note at full value while its buy is in flight or
// refused, and its change only from the read-back of its own release; so a filled (or withdrawn) release tells the page
// its note and chunk, and an end with no release of its own tells it nothing
test("a release of this buy's own read back, filled or withdrawn, tells the page its note, attempt and chunk; not_landed tells nothing", async () => {
  for (const kind of ["bought", "withdrawn"] as const) {
    const r = host(both([release(kind === "bought" ? {} : { kind })]));
    const told: [string, string, bigint][] = [];
    r.h.landed = (id, attempt, w) => void told.push([id, attempt, w]);
    await runEvmPoolBuy(r.h, ASK);
    assert.deepEqual(told, [["n1", "a1", CHUNK]], kind);
  }
  for (const o of [{ w: OTHER }, { value: CHUNK - 1n }]) {
    const r = host(both([release(o)]));
    const told: unknown[] = [];
    r.h.landed = (...a) => void told.push(a);
    assert.deepEqual(await runEvmPoolBuy(r.h, ASK), { stage: "not_landed", txs: [] });
    assert.deepEqual(told, [], "another's release is not this note's");
  }
});
