// pool.buy on an EVM pool (card signpage-evm-pool-buy, src/pool-buy-evm.ts and src/evm-send.ts): the device's own quote
// (replayed from the kit's recorded Base answers), the kit's build, checkEvmBuy, W's signature, the take, the send and
// the read-back on two RPCs, each step's refusals; and the buy's calldata, byte for byte the encoding the pool's
// testnet run sends (contracts/pool-evm/script/testnet-run-lib.mjs buyData).
import { test } from "node:test";
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
import { EVM_POSITION_COSTS_KEY, runEvmPoolBuy, type EvmHolding, type EvmPoolBuyHost } from "../src/pool-buy-evm.ts";
import { evmBuyCalldata, EvmSendRefused } from "../src/evm-send.ts";
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
const NULLIFIER = 777n;

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
const HASH = "0x" + "ab".repeat(32);
/** The pool's Bought for W, as a receipt carries it. */
const bought = (out: bigint, o: { nullifier?: bigint; token?: string } = {}) => ({
  address: POOL,
  topics: [topic(EVM_POOL_EVENTS.Bought), "0x" + w32(BigInt(W))],
  data: "0x" + [BigInt(FEE_TO), CHUNK, FEE, o.nullifier ?? NULLIFIER, 99n, BigInt(o.token ?? TOKEN), out].map(w32).join(""),
});
/** One RPC: the transaction under HASH (the calldata it was sent, or `input`), its receipt (`status` and logs). */
type Chain = { tx?: "mine" | "other" | "none"; status?: "0x1" | "0x0" | null; logs?: unknown[] };
const rpcOf = (c: Chain, sent: { data?: string }): EvmPoolBuyHost["rpcs"][0] => async (method, params) => {
  const hash = (params as string[])[0];
  if (method === "eth_getTransactionByHash") {
    if ((c.tx ?? "mine") === "none" || hash !== HASH) return null;
    return { hash, to: POOL, input: c.tx === "other" ? "0x1234" : sent.data, chainId: "0x" + BigInt(B.chainId).toString(16) };
  }
  if (method === "eth_getTransactionReceipt") return c.status === null ? null : { transactionHash: hash, blockNumber: "0x10", status: c.status ?? "0x1", logs: c.logs ?? [] };
  throw new Error(`no ${method}`);
};

type Seen = { seeds: number; takes: string[]; sends: { pool: string; data: Uint8Array; epoch: bigint }[]; settles: number; records: [string, EvmHolding][]; sent: string[]; quotes: EvmPoolBuyQuote["route"][] };
function host(o: { ready?: ReadyProof<EvmPoolRequest>[]; a?: Chain; b?: Chain; send?: () => Promise<string>; quote?: () => Promise<EvmPoolBuyQuote>; claimed?: Set<string> } = {}): { h: EvmPoolBuyHost; seen: Seen } {
  const seen: Seen = { seeds: 0, takes: [], sends: [], settles: 0, records: [], sent: [], quotes: [] };
  const wire: { data?: string } = {};
  const ready = o.ready ?? [readyOf()];
  const h: EvmPoolBuyHost = {
    chain: "base",
    testnet: false,
    pin: { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n },
    venues: VENUES,
    rpcs: [rpcOf(o.a ?? {}, wire), rpcOf(o.b ?? {}, wire)],
    ready: async () => ready,
    take: async (id, attempt) => {
      seen.takes.push(id);
      const r = ready.find((x) => x.noteId === id && x.attempt === attempt);
      if (!r) throw new Error("taken by another attempt");
      return r;
    },
    seed64: async () => (seen.seeds++, SEED.slice()),
    // the device's quote: the standard shapes the kit refuses below its own best route (the recording's), then that one
    quote: async (req) => {
      seen.quotes.push(req.route);
      assert.equal(req.amountIn, CHUNK - FEE, "the quote is for what the pool swaps: the chunk less the proof's fee");
      if (o.quote) return o.quote();
      const q = await fixtureQuote();
      if (JSON.stringify(req.route) !== JSON.stringify(FIXTURE_ROUTE)) throw new EvmQuoteError("below_reference", "the standard pool quotes more", { amountOut: q.amountOut, route: FIXTURE_ROUTE });
      return q;
    },
    build: (adapter, q) => evmQuotedBuy(VENUES, adapter, q, QF.now),
    decimals: async () => 6,
    send: async (body) => {
      seen.sends.push(body);
      wire.data = "0x" + hex(body.data);
      return o.send ? o.send() : HASH;
    },
    settle: () => void seen.settles++,
    record: async (w, rec) => void seen.records.push([w, rec]),
    sent: (x) => void seen.sent.push(x),
    claimed: o.claimed ?? new Set(),
    now: () => NOW,
    reads: 3,
    wait: async () => {},
  };
  return { h, seen };
}

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

test("a buy read back on both RPCs with the pool's Bought for W is filled, and W's holding stores the route the transaction took", async () => {
  const logs = [bought(40_000_000n)];
  const { h, seen } = host({ a: { logs }, b: { logs } });
  const got = await runEvmPoolBuy(h, ASK);
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "base", hash: HASH }] });
  assert.deepEqual(seen.takes, ["n1"]);
  assert.equal(seen.sends.length, 1);
  assert.equal(seen.sends[0]!.epoch, NOW - 10_000n, "the epoch whose fee the proof binds");
  assert.deepEqual(seen.sent, [HASH], "named once both RPCs read this very transaction");
  // the kit refused the first standard shape below its own best, and the device asked that best route once
  assert.deepEqual(seen.quotes.at(-1), FIXTURE_ROUTE);
  assert.equal(seen.records.length, 1);
  const [w, rec] = seen.records[0]!;
  assert.equal(w, W);
  assert.deepEqual(rec, { mint: TOKEN.toLowerCase(), received: "40", decimals: 6, chain: "base", route: { venue: "uniswap-v3", adapter: A_V3, path: FIXTURE_ROUTE, tx: HASH, block: "16" } });
  assert.equal(EVM_POSITION_COSTS_KEY, "owed/cost-evm");
  assert.equal(seen.settles, 1, "the settle pass ends the RESERVED note");
});

test("a quote that fails checkEvmBuy is never signed: no seed read, no take, no send", async () => {
  // the proof binds another fee recipient than the pinned one: the rule refuses fee_recipient
  const { h, seen } = host({ ready: [readyOf(relayOf({ feeRecipient: "0x0000000000000000000000000000000000000bad" }))] });
  const claimed = h.claimed!;
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { error: "quote_check_failed" });
  assert.deepEqual([seen.seeds, seen.takes.length, seen.sends.length, seen.settles], [0, 0, 0, 0]);
  assert.equal(claimed.size, 0, "the proof is released for the next tap");
  // a quote the kit refuses: never signed either
  const r2 = host({ quote: () => Promise.reject(new EvmQuoteError("stale_quote", "old")) });
  assert.deepEqual(await runEvmPoolBuy(r2.h, ASK), { error: "quote_check_failed" });
  assert.deepEqual([r2.seen.seeds, r2.seen.takes.length, r2.seen.sends.length], [0, 0, 0]);
});

test("a buy read back on one RPC only is not marked filled", async () => {
  const logs = [bought(40_000_000n)];
  const { h, seen } = host({ a: { logs }, b: { tx: "none" } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  assert.deepEqual([seen.records.length, seen.sent.length, seen.settles], [0, 0, 1]);
  // read on both, with Bought on one and none on the other: not filled either
  const r2 = host({ a: { logs }, b: { logs: [] } });
  assert.deepEqual(await runEvmPoolBuy(r2.h, ASK), { stage: "sent", txs: [{ chain: "base", hash: HASH }] });
  assert.equal(r2.seen.records.length, 0);
  // a Bought that names another nullifier, or another token, is not this buy's
  for (const log of [bought(40_000_000n, { nullifier: 1n }), bought(40_000_000n, { token: "0x00000000000000000000000000000000000000aa" })]) {
    const r3 = host({ a: { logs: [log] }, b: { logs: [log] } });
    assert.equal(((await runEvmPoolBuy(r3.h, ASK)) as { stage: string }).stage, "sent");
    assert.equal(r3.seen.records.length, 0);
  }
});

test("a helper that answers the send with another transaction than the one signed: never named, never filled", async () => {
  const { h, seen } = host({ a: { tx: "other" }, b: { tx: "other" } });
  assert.deepEqual(await runEvmPoolBuy(h, ASK), { stage: "sent", txs: [] });
  assert.deepEqual([seen.sent.length, seen.records.length, seen.settles], [0, 0, 1]);
});

test("the proof taken is settled on every exit past the take, and released before it", async () => {
  // the helper refuses: failed, and the settle runs (the note RESERVED until it ends it)
  const refused = host({ send: () => Promise.reject(new EvmSendRefused(422, "fee_off")) });
  assert.deepEqual(await runEvmPoolBuy(refused.h, ASK), { error: "failed" });
  assert.deepEqual([refused.seen.takes.length, refused.seen.settles], [1, 1]);
  // no answer at all: the helper may have sent it; nothing named, the settle runs
  const silent = host({ send: () => Promise.reject(new TypeError("fetch failed")) });
  assert.deepEqual(await runEvmPoolBuy(silent.h, ASK), { stage: "sent", txs: [] });
  assert.equal(silent.seen.settles, 1);
  // reverted on both: refused with its transaction, settled
  const reverted = host({ a: { status: "0x0" }, b: { status: "0x0" } });
  assert.deepEqual(await runEvmPoolBuy(reverted.h, ASK), { stage: "refused", txs: [{ chain: "base", hash: HASH }] });
  assert.equal(reverted.seen.settles, 1);
  // a remake swapped in after the pick: the take refuses, nothing is sent, the settle runs
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
  assert.deepEqual([early.seen.seeds, early.seen.takes.length, early.seen.settles, early.h.claimed!.size], [0, 0, 0, 0]);
});

test("a second tap while one is in flight takes another proof, or none", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const logs = [bought(40_000_000n)];
  const claimed = new Set<string>();
  const first = host({ a: { logs }, b: { logs }, claimed, quote: async () => (await gate, fixtureQuote()) });
  first.h.quote = async (req) => {
    first.seen.quotes.push(req.route);
    await gate;
    return fixtureQuote();
  };
  const run1 = runEvmPoolBuy(first.h, ASK);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...claimed], ["n1"], "the first tap holds its proof");
  const second = host({ a: { logs }, b: { logs }, claimed });
  assert.deepEqual(await runEvmPoolBuy(second.h, ASK), { error: "not_funded" }, "the only ready proof is the first tap's");
  assert.equal(second.seen.seeds, 0);
  release();
  assert.equal(((await run1) as { stage: string }).stage, "filled");
  assert.equal(claimed.size, 0);
});

test("a proof whose chunk is not the ask's amount, or an ask on another chain, is not this buy's", async () => {
  const { h } = host();
  assert.deepEqual(await runEvmPoolBuy(h, { ...ASK, amount: CHUNK + 1n }), { error: "not_funded" });
  assert.deepEqual(await runEvmPoolBuy(h, { ...ASK, chain: "robinhood" }), { error: "not_allowed" });
  assert.deepEqual(await runEvmPoolBuy(h, { ...ASK, kind: "pool.sell" }), { error: "not_allowed" });
});
