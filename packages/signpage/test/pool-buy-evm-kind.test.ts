// The EVM pool.buy kind and its page host (card signpage-evm-pool-buy, src/pool-buy-evm.ts poolBuyEvmKind and
// evmBuyHost): the kind's lock, its early "sent" answer once the bytes have left, its progress (the run's stage and a
// late end), its host's end on every exit; the host's records in the wallet store's meta, its send, its ready list and
// its two-RPC decimals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmPoolBuyQuoteWith, type EvmPoolBuyQuote, type EvmRpc as QuoteRpc, type EvmRpcCall } from "../../kit/src/checks/evm/quote.ts";
import { evmQuotedBuy } from "../../kit/src/trade/evm/quoted.ts";
import { evmPoolVenues, type EvmPoolVenue } from "../../kit/src/trade/evm/buy-unpinned.ts";
import type { Stage } from "../../kit/src/signpage/messages.ts";
import { asRecorded, gasRoundAnswers, withMarker } from "../../kit/test/evm-quote-gas-fx.ts";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { EVM_POOL_EVENTS, evmPoolContextOf, evmPoolScopeOf, type EvmPoolPin, type EvmPoolRequest, type EvmRelayData, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import type { ProofQueue } from "../../wallet/src/pool/queue.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { EVM_OWED_BACK_KEY, EVM_POSITION_COSTS_KEY, evmBuyHost, poolBuyEvmKind, type EvmBuyPage, type EvmHolding, type EvmOwedBack, type EvmPoolBuyHost } from "../src/pool-buy-evm.ts";
import type { KindContext } from "../src/api.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import { TRADE_HELPER } from "../src/trade.ts";

// the kit's recorded quote: 0.01 ETH of USDC on Base through a v3 pool (kit test/fixtures/evm-quote.json "base-ok")
type Exchange = { calls: EvmRpcCall[]; answers: unknown[] };
const QF = (JSON.parse(readFileSync(new URL("../../kit/test/fixtures/evm-quote.json", import.meta.url), "utf8")) as Record<string, { request: Record<string, unknown>; now: number; exchanges: [Exchange[], Exchange[]] }>)["base-ok"]!;
const replay = (ex: Exchange[]): QuoteRpc => async (sent) => {
  const calls = asRecorded(sent);
  return withMarker(sent, structuredClone(ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls))?.answers ?? gasRoundAnswers(ex, calls)!));
};
const AMOUNT_IN = BigInt(QF.request.amountIn as string);
const TOKEN = QF.request.buys as string;
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
const OTHER_W = "0x0000000000000000000000000000000000000077";
const VENUES = Object.freeze({ base: Object.freeze({ ...B, pool: POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }) }) as EvmPoolVenue });
const PIN: EvmPoolPin = { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
const NOW = BigInt(QF.now);
const FEE = 10n ** 13n;
const CHUNK = AMOUNT_IN + FEE;
// the all-zero seed's W for (l, j) = (5, 0): the published test vector's words (packages/wallet/test/vectors/a8.json)
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 5n;
const W = freshWallet(SEED, "evm", L, 0).address;
const NULLIFIER = 777n;
const HASH = "0x" + "ab".repeat(32);

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
/** The pool's Bought for W, as eth_getLogs carries it. */
const BOUGHT_LOG = {
  address: POOL,
  topics: [topic(EVM_POOL_EVENTS.Bought), "0x" + w32(BigInt(W))],
  data: "0x" + [BigInt(FEE_TO), CHUNK, FEE, NULLIFIER, 99n, BigInt(TOKEN), 40_000_000n].map(w32).join(""),
  blockNumber: "0x10",
  transactionHash: HASH,
  logIndex: "0x0",
  blockHash: "0x" + "be".repeat(32),
  removed: false,
};

// ---- the kind ----

/** `p`, or a failure once `ms` pass: a kind that never answers fails its test instead of holding the run. */
const within = <T>(p: Promise<T>, what: string, ms = 5_000): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
};

type Lock = { name: string; mode: string | undefined };
function lockManager(): { locks: Pick<LockManager, "request">; asked: Lock[] } {
  const asked: Lock[] = [];
  const request = (name: string, options: LockOptions, f: (l: Lock | null) => unknown) => {
    asked.push({ name, mode: options.mode });
    return Promise.resolve().then(() => f({ name, mode: options.mode }));
  };
  return { locks: { request } as unknown as Pick<LockManager, "request">, asked };
}
function context(o: { progress?: (s: Stage) => void } = {}): { ctx: KindContext; stages: Stage[] } {
  const stages: Stage[] = [];
  return { ctx: { id: "r1", sha: "00", progress: o.progress ?? ((s) => void stages.push(s)) }, stages };
}

/** A run that ends before the send: no proof ready. */
function unfunded(): EvmPoolBuyHost & { end(): void; ends: number } {
  const h = {
    chain: "base",
    testnet: false,
    pin: PIN,
    venues: VENUES,
    rpcs: [async () => null, async () => null],
    ready: async () => [],
    take: async () => assert.fail("no take"),
    seed64: async () => assert.fail("no seed"),
    quote: async () => assert.fail("no quote"),
    build: () => assert.fail("no build"),
    decimals: async () => 6,
    send: async () => assert.fail("no send"),
    settle: () => {},
    record: async () => {},
    owe: async () => {},
    unrecord: async () => {},
    holdings: async () => ({}),
    claimed: new Set<string>(),
    now: () => NOW,
    wait: async () => {},
    ends: 0,
    end() {
      h.ends++;
    },
  } as EvmPoolBuyHost & { end(): void; ends: number };
  return h;
}

/** A run that reaches the send: the device's quote replayed, the pool's two RPCs answering each read-back round with
 *  `logs(round)` once `gate` lets the reads through. */
function sending(o: { logs?: (round: number) => unknown[]; gate?: Promise<void>; now?: () => bigint; decimals?: () => Promise<number>; claimed?: Set<string> } = {}) {
  const seen = { sends: 0, ends: 0, rounds: 0 };
  const ready = [readyOf()];
  const rpc: EvmRpc = async (method) => {
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getBlockByNumber") {
      await o.gate;
      return { number: "0x11", timestamp: "0x1" };
    }
    if (method === "eth_getLogs") return (o.logs ?? (() => [BOUGHT_LOG]))(seen.rounds++ >> 1);
    throw new Error(`no ${method}`);
  };
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const h: EvmPoolBuyHost & { end(): void } = {
    chain: "base",
    testnet: false,
    pin: PIN,
    venues: VENUES,
    rpcs: [rpc, rpc],
    ready: async () => ready,
    take: async () => ready[0]!,
    seed64: async () => SEED.slice(),
    quote: async () => fixtureQuote(),
    build: (adapter, q) => evmQuotedBuy(VENUES, adapter, q, QF.now),
    decimals: o.decimals ?? (async () => 6),
    send: async () => (seen.sends++, HASH),
    settle: () => {},
    record: async () => {},
    owe: async () => {},
    unrecord: async () => {},
    holdings: async () => ({}),
    claimed: o.claimed ?? new Set(),
    now: o.now ?? (() => NOW),
    wait: async () => {},
    end() {
      seen.ends++;
      done();
    },
  };
  return { h, seen, ended };
}

test("kind: an ask on another chain, or no lock manager, is not_allowed with no host made", () => {
  let made = 0;
  const host = () => (made++, unfunded());
  const { locks } = lockManager();
  assert.deepEqual(poolBuyEvmKind(host, locks)({ ...ASK, chain: "solana" }, context().ctx), { error: "not_allowed" });
  assert.deepEqual(poolBuyEvmKind(host, null)(ASK, context().ctx), { error: "not_allowed" });
  assert.equal(made, 0);
});

test("kind: the run up to the send holds the seed's lock, shared", async () => {
  const { locks, asked } = lockManager();
  const r = poolBuyEvmKind(() => unfunded(), locks)(ASK, context().ctx) as { after: Promise<unknown> };
  await within(r.after, "the answer");
  assert.deepEqual(asked, [{ name: WALLET_SEED_LOCK, mode: "shared" }]);
});

test("kind: a run that ends with an error answers it, never sent", async () => {
  const { locks } = lockManager();
  const { ctx, stages } = context();
  const h = unfunded();
  const r = poolBuyEvmKind(() => h, locks)(ASK, ctx) as { running: true; after: Promise<unknown>; answer(): unknown };
  assert.equal(r.running, true);
  await within(r.after, "the answer");
  assert.deepEqual(r.answer(), { error: "not_funded" });
  assert.deepEqual(stages, [], "no stage for an error");
  assert.equal(h.ends, 1);
});

test("kind: once the bytes have left, it answers sent before the run ends; the run's end goes out as progress", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const { h, seen, ended } = sending({ gate });
  const { locks } = lockManager();
  const { ctx, stages } = context();
  const r = poolBuyEvmKind(() => h, locks)(ASK, ctx) as { after: Promise<unknown>; answer(): unknown };
  await within(r.after, "the answer");
  assert.equal(seen.sends, 1);
  assert.deepEqual(r.answer(), { result: { stage: "sent", txs: [] } });
  assert.equal(seen.ends, 0, "the run still reads back");
  assert.deepEqual(stages, []);
  open();
  await within(ended, "the run's end");
  assert.deepEqual(stages, ["filled"], "the run's own end, as progress");
  assert.deepEqual(r.answer(), { result: { stage: "sent", txs: [] } }, "the answer once given stays");
});

test("kind: an end the reads find past the tap's bound goes out as progress (late)", async () => {
  // the clock moves on 200 s at each read after the send: the tap's one round finds nothing, the follow's first finds W's Bought
  let sentYet = false;
  let t = NOW;
  const { h, seen, ended } = sending({ now: () => (sentYet ? (t += 200_000n) : NOW), logs: (round) => (round === 0 ? [] : [BOUGHT_LOG]) });
  const send = h.send;
  h.send = async (b) => {
    sentYet = true;
    return send(b);
  };
  let late!: () => void;
  const lateCame = new Promise<void>((r) => (late = r));
  const stages: Stage[] = [];
  const { ctx } = context({ progress: (s) => (stages.push(s), s === "filled" && late()) });
  const { locks } = lockManager();
  const r = poolBuyEvmKind(() => h, locks)(ASK, ctx) as { after: Promise<unknown>; answer(): unknown };
  await within(r.after, "the answer");
  await within(ended, "the run's end");
  assert.deepEqual(stages, ["sent"], "the run answered its last true stage at its bound");
  await within(lateCame, "the late end");
  assert.deepEqual(stages, ["sent", "filled"]);
  assert.equal(seen.ends, 1);
});

test("kind: the host's end runs once even when the run throws", async () => {
  // a claim whose release throws: the run's own finally throws past the pick
  const claimed = new Set<string>();
  let threw = 0;
  claimed.delete = () => {
    threw++;
    throw new Error("store gone");
  };
  const { h, seen } = sending({ claimed, decimals: async () => Promise.reject(new Error("the two RPCs differ")) });
  const { locks } = lockManager();
  const r = poolBuyEvmKind(() => h, locks)(ASK, context().ctx) as { after: Promise<unknown>; answer(): unknown };
  await within(r.after, "the answer");
  assert.equal(threw, 1, "the run threw");
  assert.equal(seen.ends, 1);
  assert.equal(seen.sends, 0);
  assert.deepEqual(r.answer(), { error: "failed" });
});

// ---- the page's host ----

function store(seed: Record<string, unknown> = {}): { store: WalletStore; data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(seed));
  const s = {
    async get(name: string, key: string) {
      return data.get(`${name}/${key}`);
    },
    async update(name: string, key: string, f: (v: unknown) => unknown) {
      const v = f(data.get(`${name}/${key}`));
      data.set(`${name}/${key}`, v);
      return v;
    },
  };
  return { store: s as unknown as WalletStore, data };
}
function page(o: { store?: WalletStore; ready?: ReadyProof<EvmPoolRequest>[]; fetch?: typeof fetch } = {}) {
  let refreshes = 0;
  const queue = { ready: () => o.ready ?? [], refresh: async () => (refreshes++, { proved: [], remade: [], failed: [] }), take: async () => assert.fail("no take") } as unknown as ProofQueue<EvmPoolRequest>;
  const p: EvmBuyPage = { queue: async () => queue, seed64: async () => SEED.slice(), held: async () => o.store ?? store().store, settle: () => {}, marks: async () => new Map(), testnet: false, fetch: o.fetch };
  return { p, refreshes: () => refreshes };
}
const NO_RPCS: readonly [EvmRpc, EvmRpc] = [async () => null, async () => null];
const HOLDING: EvmHolding = { mint: TOKEN.toLowerCase(), decimals: 6, chain: "base", state: "pending", route: { venue: "uniswap-v3", adapter: A_V3, path: { venue: "uniswap-v3", tokens: [B.weth, TOKEN], fees: [500] } } };

test("host: record writes W's holding under EVM_POSITION_COSTS_KEY, keeping another W's", async () => {
  const other = { mint: "x", state: "filled" };
  const s = store({ [`meta/${EVM_POSITION_COSTS_KEY}`]: { [OTHER_W]: other } });
  const h = evmBuyHost("base", PIN, NO_RPCS, new Set(), page({ store: s.store }).p);
  await h.record(W, HOLDING);
  assert.deepEqual(s.data.get(`meta/${EVM_POSITION_COSTS_KEY}`), { [OTHER_W]: other, [W]: HOLDING });
  assert.deepEqual([...s.data.keys()], [`meta/${EVM_POSITION_COSTS_KEY}`]);
});

test("host (P3-7): the pending write refuses a W that already has a holding (another tab's run of the same note), keeping it; an end's write completes W's own", async () => {
  const theirs = { ...HOLDING, mint: "0x" + "77".repeat(20) };
  const s = store({ [`meta/${EVM_POSITION_COSTS_KEY}`]: { [W]: theirs } });
  const h = evmBuyHost("base", PIN, NO_RPCS, new Set(), page({ store: s.store }).p);
  await assert.rejects(h.record(W, HOLDING), /already has a holding/);
  assert.deepEqual(s.data.get(`meta/${EVM_POSITION_COSTS_KEY}`), { [W]: theirs }, "the other run's token kept");
  const filled = { ...theirs, state: "filled" as const, received: "1" };
  await h.record(W, filled);
  assert.deepEqual(s.data.get(`meta/${EVM_POSITION_COSTS_KEY}`), { [W]: filled });
});

test("host (P2-2): record and owe write the store only while it is open (the page's held), never opening it; the page's sign-out signal and sign-out count reach the run (m53)", async () => {
  let opens = 0;
  const s = store();
  const signal = new AbortController().signal;
  const stopped = () => true;
  const p: EvmBuyPage = { ...page().p, held: async () => Promise.reject(new Error("no wallet store is open")), signal, stopped };
  (p as unknown as { store: () => Promise<WalletStore> }).store = async () => (opens++, s.store);
  const h = evmBuyHost("base", PIN, NO_RPCS, new Set(), p);
  await assert.rejects(h.record(W, HOLDING), /no wallet store is open/);
  await assert.rejects(h.owe({ address: W, chain: "base", wei: "1", tx: HASH, block: "1" }), /no wallet store is open/);
  assert.deepEqual([opens, s.data.size], [0, 0]);
  assert.equal(h.signal, signal);
  assert.equal(h.stopped, stopped);
});

test("host (pending end): unrecord removes only W's own pending record (the nullifier and deadline given), never another W's or another buy's, and holdings reads them from the open store", async () => {
  const buy = { nullifier: "77", from: "1", deadlineMs: "2", minOut: "3", value: "4", feeCap: "5", feeRecipient: "0x" + "0f".repeat(20) };
  const mine = { ...HOLDING, buy };
  const other = { ...HOLDING, mint: "x" };
  const s = store({ [`meta/${EVM_POSITION_COSTS_KEY}`]: { [W]: mine, [OTHER_W]: other } });
  const h = evmBuyHost("base", PIN, NO_RPCS, new Set(), page({ store: s.store }).p);
  assert.deepEqual(await h.holdings(), { [W]: mine, [OTHER_W]: other });
  await h.unrecord(W, 78n, 2n);
  await h.unrecord(OTHER_W, 77n, 2n);
  // the same note proved again has another deadline: an older run's removal leaves the later buy's record (review P3-E)
  await h.unrecord(W, 77n, 3n);
  assert.deepEqual(s.data.get(`meta/${EVM_POSITION_COSTS_KEY}`), { [W]: mine, [OTHER_W]: other }, "another nullifier or deadline, or a W with no pending buy of it: kept");
  await h.record(W, { ...mine, state: "filled", received: "1" });
  await h.unrecord(W, 77n, 2n);
  assert.equal((s.data.get(`meta/${EVM_POSITION_COSTS_KEY}`) as Record<string, EvmHolding>)[W]!.state, "filled", "a filled record is never removed");
  s.data.set(`meta/${EVM_POSITION_COSTS_KEY}`, { [W]: mine, [OTHER_W]: other });
  await h.unrecord(W, 77n, 2n);
  assert.deepEqual(s.data.get(`meta/${EVM_POSITION_COSTS_KEY}`), { [OTHER_W]: other });
});

test("host: owe writes W's ETH owed back under EVM_OWED_BACK_KEY, keeping another W's", async () => {
  const other: EvmOwedBack = { address: OTHER_W, chain: "base", wei: "1", tx: HASH, block: "1" };
  const s = store({ [`meta/${EVM_OWED_BACK_KEY}`]: { [OTHER_W]: other } });
  const h = evmBuyHost("base", PIN, NO_RPCS, new Set(), page({ store: s.store }).p);
  const mine: EvmOwedBack = { address: W, chain: "base", wei: (CHUNK - FEE).toString(), tx: HASH, block: "16" };
  await h.owe(mine);
  assert.deepEqual(s.data.get(`meta/${EVM_OWED_BACK_KEY}`), { [OTHER_W]: other, [W]: mine });
  assert.deepEqual([...s.data.keys()], [`meta/${EVM_OWED_BACK_KEY}`]);
});

test("host: send posts to the trade helper's /v1/pool/evm/send through the page's fetch", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => (urls.push(url), new Response(JSON.stringify({ hash: HASH }), { status: 200 }))) as unknown as typeof fetch;
  const h = evmBuyHost("base", PIN, NO_RPCS, new Set(), page({ fetch: fetchFn }).p);
  assert.equal(await h.send({ pool: POOL, data: new Uint8Array([1]), epoch: 1n }), HASH);
  assert.deepEqual(urls, [`${TRADE_HELPER}/v1/pool/evm/send`]);
});

test("host: ready with none starts the queue's pass once; with proofs it does not", async () => {
  const none = page();
  assert.deepEqual(await evmBuyHost("base", PIN, NO_RPCS, new Set(), none.p).ready(), []);
  assert.equal(none.refreshes(), 1);
  const some = page({ ready: [readyOf()] });
  assert.equal((await evmBuyHost("base", PIN, NO_RPCS, new Set(), some.p).ready()).length, 1);
  assert.equal(some.refreshes(), 0);
});

test("host: decimals reads the token on both RPCs, and two answers that differ throw", async () => {
  const counted = (answer: string) => {
    const calls: [string, readonly unknown[]][] = [];
    const rpc: EvmRpc = async (method, params) => (calls.push([method, params]), answer);
    return { rpc, calls };
  };
  const a = counted("0x" + w32(6n));
  const b = counted("0x" + w32(6n));
  assert.equal(await evmBuyHost("base", PIN, [a.rpc, b.rpc], new Set(), page().p).decimals(TOKEN), 6);
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(a.calls[0]![0], "eth_call");
  assert.deepEqual(a.calls[0], b.calls[0]);
  // kept for the session (card sell-first-read-waits-out-a-throttle, src/pool-kinds.ts): another run reads it no more
  const again = counted("0x" + w32(18n));
  assert.equal(await evmBuyHost("base", PIN, [again.rpc, again.rpc], new Set(), page().p).decimals(TOKEN), 6);
  assert.equal(again.calls.length, 0);
  // another token, two answers that differ: thrown, and nothing kept
  const other = "0x" + "00".repeat(19) + "07";
  const c = counted("0x" + w32(18n));
  const d = counted("0x" + w32(6n));
  await assert.rejects(evmBuyHost("base", PIN, [d.rpc, c.rpc], new Set(), page().p).decimals(other));
  await assert.rejects(evmBuyHost("base", PIN, [d.rpc, c.rpc], new Set(), page().p).decimals(other));
  assert.equal(c.calls.length, 2, "read again");
});

test("host: claimed is the page's very set", () => {
  const claimed = new Set<string>();
  assert.equal(evmBuyHost("base", PIN, NO_RPCS, claimed, page().p).claimed, claimed);
});
