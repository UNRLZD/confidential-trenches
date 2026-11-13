// pool.sell on an EVM pool (card signpage-evm-pool-sell, src/pool-sell-evm.ts and src/evm-send.ts): the device's own
// sell quote (the kit's evmPoolSellQuoteWith on the kit's modelled chain, test/evm-sell-quote-fx.ts), the kit's build,
// checkEvmSell and checkEvmAuthorization, W's signatures, the open record and the note INCOMING before the send, the
// helper's sell sender (its 429 and 503 Retry-After waits, the one signature again past the deadline), the read-back on
// the pool's Deposited logs on two RPCs, and the note's end from the pool's round; the load's follow after a page closed
// between the record and the send or between the send and the read-back; the decimals read again at the quote's block;
// the hostile builds the rule refuses; and the restore of a buy's route from its own transaction. Every chain is a fake
// one; nothing here reaches a network.
import { after, afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { openWalletStore } from "@blindfill/wallet/store";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, refKey, type NoteStore } from "../../wallet/src/notes/store.ts";
import { evmPoolScopeOf, EVM_POOL_EVENTS, type EvmPoolEvent, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { evmRestore, SECOND_GAP } from "../../wallet/src/pool/evm-restore.ts";
import { EVM_SECOND_GAP } from "../../wallet/src/notes/store.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { evmPoolVenues, pinnedBuild, type EvmRoute } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildSell } from "../../kit/src/trade/evm/sell.ts";
import type { EvmPoolSellQuoteRequest } from "../../kit/src/checks/evm/quote.ts";
import { BOUGHT, flat, provider, refreshHead, sellQuoteWith, TOKEN } from "../../kit/test/evm-sell-quote-fx.ts";
import { EVM_POSITION_COSTS_KEY, type EvmHolding } from "../src/pool-buy-evm.ts";
import { EvmSendBusy, EvmSendNoAnswer, EvmSendRefused, evmBuyCalldata, evmSellSend } from "../src/evm-send.ts";
import { EVM_OPEN_SELLS_KEY, EVM_SELL_DEADLINE_S, evmBuyRouteRead, evmSellPlanQuote, followEvmSells, planEvmSell, poolSellEvmKind, runEvmPoolSell, type EvmOpenSell, type EvmSellHost } from "../src/pool-sell-evm.ts";
import { POOL_TRADE_LOCK } from "../src/trade.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { READ_WAIT_TOTAL_MS } from "../src/read-waits.ts";
import { enableTimers, resetTimers } from "./mock-timers.ts";

const LIB = new URL("../../../contracts/pool-evm/script/testnet-run-lib.mjs", import.meta.url).href;
const { sellData } = (await import(LIB)) as { sellData: (...a: unknown[]) => string };

const V = evmPoolVenues().base;
const POOL = V.pool!.toLowerCase();
const PIN: EvmPoolPin = Object.freeze({ network: "base", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(POOL, BigInt(V.chainId));
// the all-zero seed (the published test vector's words, packages/wallet/test/vectors/a8.json)
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
// the buy's note's label: the pool's first deposit's (so a restore from the words reads this world as the page wrote it)
const L = vaultLabelOf(keccak_256, SCOPE, 1n);
const DEP: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const J = jOf(DEP);
const W = freshWallet(SEED, "evm", L, J).address.toLowerCase();
const UNITS = 10n ** 18n;
const ASK: PoolAsk = { kind: "pool.sell", chain: "base", token: TOKEN, amount: UNITS, slippageBps: 100, decimals: 18 };
const RETURN: NoteRef = { kind: "return", c: "evm", l: L, j: J };
const P = noteSecrets(SEED, RETURN).precommitment;
const hx = (v: bigint) => "0x" + v.toString(16);
const w32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const topic = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex");
const T_DEPOSITED = topic(EVM_POOL_EVENTS.Deposited);
const T_BOUGHT = topic(EVM_POOL_EVENTS.Bought);
const NONCE_SEL = topic("nonce()").slice(0, 10);

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
beforeEach(() => {
  enableTimers(mock.timers, { apis: ["Date"], now: Date.now() });
  refreshHead();
});
afterEach(() => resetTimers(mock.timers));
/** The device's clock moves by `ms` (Date.now with it, and the modelled chain's head time). */
const tick = (ms: number) => {
  mock.timers.setTime(Date.now() + ms);
  refreshHead();
};

/** The sale's Sell from its calldata: the words after the selector and the head. */
const sellOf = (data: Uint8Array) => {
  const h = Buffer.from(data).toString("hex").slice(8);
  const w = (k: number) => BigInt("0x" + h.slice(64 * k, 64 * k + 64));
  return { fee: w(1), token: w(3), amount: w(4), minOut: w(7), pool: w(8), precommitment: w(9), feeCap: w(10), feeRecipient: w(11), deadline: w(12), nonce: w(13) };
};

/** One fake chain under both pool RPCs: W's balance and nonces, the token's decimals, the pool's Deposited logs, the
 *  safe block's time, and the pool's round (its events and final block). */
function chain() {
  const c = {
    head: 1000n,
    balance: [UNITS, UNITS],
    sellNonce: null as bigint | null,
    authNonce: [0n, 0n],
    decimals: [18n, 18n],
    /** decimals() at a block other than "latest" (the quote's), when set */
    decimalsAtBlock: null as bigint | null,
    deposits: [] as { block: bigint; depositor: string; value: bigint; precommitment: bigint; tx: string }[],
    events: [] as EvmPoolEvent[],
    fin: 900n,
    receipts: new Map<string, string>(),
    /** transactions by hash (eth_getTransactionByHash) */
    txs: new Map<string, unknown>(),
    /** each RPC's eth_blockNumber below the head by this much */
    lowBy: [0n, 0n] as bigint[],
    /** the Deposited logs answer empty while Date.now() is under this (logs trailing their headers) */
    hideUntil: 0,
    calls: [] as { k: number; method: string; params: unknown[] }[],
  };
  const timeOf = (n: bigint) => BigInt(Math.floor(Date.now() / 1000)) - (c.head - n) * 2n;
  const rpc =
    (k: number): EvmRpc =>
    async (method, params) => {
      const p = params as unknown[];
      c.calls.push({ k, method, params: p });
      switch (method) {
        case "eth_blockNumber":
          return hx(c.head - c.lowBy[k]!);
        case "eth_getTransactionByHash":
          return c.txs.get(p[0] as string) ?? null;
        case "eth_getBlockByNumber": {
          const n = p[0] === "latest" ? c.head : p[0] === "safe" ? c.head - 10n : BigInt(p[0] as string);
          return { number: hx(n), timestamp: hx(timeOf(n)), hash: w32(n) };
        }
        case "eth_getTransactionCount":
          return hx(c.authNonce[k]!);
        case "eth_getTransactionReceipt":
          return c.receipts.has(p[0] as string) ? { status: c.receipts.get(p[0] as string) } : null;
        case "eth_getLogs": {
          const f = p[0] as { address: string; topics: string[]; fromBlock: string; toBlock: string };
          assert.equal(f.address, POOL);
          assert.deepEqual(f.topics, [T_DEPOSITED], "the read-back asks the pool's Deposited topic only, never W");
          if (Date.now() < c.hideUntil) return [];
          return c.deposits
            .filter((d) => d.block >= BigInt(f.fromBlock) && d.block <= BigInt(f.toBlock))
            .map((d, i) => ({ address: POOL, topics: [T_DEPOSITED, w32(BigInt(d.depositor))], data: "0x" + [7n, 8n, d.value, d.precommitment].map((x) => x.toString(16).padStart(64, "0")).join(""), blockNumber: hx(d.block), blockHash: w32(d.block), logIndex: hx(BigInt(i)), transactionHash: d.tx, removed: false }));
        }
        case "eth_call": {
          const { to, data } = p[0] as { to: string; data: string };
          if (to === W && data === NONCE_SEL) return c.sellNonce === null ? "0x" : w32(c.sellNonce);
          if (to === TOKEN && data === "0x313ce567") return w32(p[1] !== "latest" && c.decimalsAtBlock !== null ? c.decimalsAtBlock : c.decimals[k]!);
          if (to === TOKEN && data.startsWith("0x70a08231")) return w32(c.balance[k]!);
          throw new Error(`no call ${to} ${data}`);
        }
      }
      throw new Error(`no method ${method}`);
    };
  /** The sale's deposit lands: its log on both RPCs at the next block, W's Sell nonce on by one, and in the pool's round
   *  at a final block (`pending`: above the round's final block, not final yet). */
  const land = (value: bigint, precommitment = P, depositor = W, tx = "0x" + "d1".repeat(32), pending = false) => {
    c.head += 1n;
    c.deposits.push({ block: c.head, depositor, value, precommitment, tx });
    if (depositor === W) c.sellNonce = (c.sellNonce ?? 0n) + 1n;
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(c.events.filter((e) => e.kind === "deposit").length + 1));
    const block = pending ? c.fin + 50n : c.fin;
    c.events.push({ block, blockHash: w32(block), logIndex: BigInt(c.events.length), bytes: "", kind: "deposit", state: noteCommitment(value, label, precommitment), label, value, precommitment, nullifier: null, recipient: null, token: null } as EvmPoolEvent);
  };
  return { c, rpcs: [rpc(0), rpc(1)] as const, land };
}

/** The meta store the host reads: the buy records and the open sales. */
function meta(init: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(init));
  return {
    m,
    get: async (_s: string, k: string) => structuredClone(m.get(k)),
    update: async (_s: string, k: string, f: (v: unknown) => unknown) => {
      const v = f(structuredClone(m.get(k)));
      if (v !== undefined) m.set(k, v);
      return v;
    },
  };
}
const ROUTE_REC: EvmHolding = { mint: TOKEN, decimals: 18, chain: "base", state: "filled", route: { venue: "uniswap-v4", adapter: V.adapters!.v4!.toLowerCase(), path: BOUGHT as EvmRoute, tx: "0x" + "b0".repeat(32), block: "256" } };

async function notes(): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  // the note the buy spent: W_{evm, L, J}'s
  const pre = noteSecrets(SEED, DEP).precommitment;
  const n = await ns.add({ ref: DEP, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 2n * 10n ** 15n, label: L, commitment: noteCommitment(2n * 10n ** 15n, L, pre), leafIndex: 0n } });
  await ns.move(n.id, "UNSPENT", "SPENT");
  return ns;
}

type World = { h: EvmSellHost; c: ReturnType<typeof chain>["c"]; land: ReturnType<typeof chain>["land"]; posts: { data: Uint8Array; authorization: unknown }[]; store: NoteStore; md: ReturnType<typeof meta> };
async function world(o: { send?: (n: number, body: { data: Uint8Array }) => Promise<string>; holding?: unknown; build?: EvmSellHost["build"]; store?: NoteStore; md?: ReturnType<typeof meta> } = {}): Promise<World> {
  const { c, rpcs, land } = chain();
  // the buy's note's deposit and its release (the buy), final in the round: no release of the device's is on its way to W
  const DEP_P = noteSecrets(SEED, DEP).precommitment;
  c.events.push({ block: 9n, blockHash: w32(9n), logIndex: 0n, bytes: "", kind: "deposit", state: noteCommitment(2n * 10n ** 15n, L, DEP_P), label: L, value: 2n * 10n ** 15n, precommitment: DEP_P, nullifier: null, recipient: null, token: null } as EvmPoolEvent);
  c.events.push({ block: 10n, blockHash: w32(10n), logIndex: 0n, bytes: "", kind: "buy", state: 1n, label: null, value: 2n * 10n ** 15n, precommitment: null, nullifier: noteSecrets(SEED, DEP).nullifierHash, recipient: W, token: TOKEN } as EvmPoolEvent);
  const store = o.store ?? (await notes());
  const md = o.md ?? meta({ [EVM_POSITION_COSTS_KEY]: { [W]: o.holding === undefined ? ROUTE_REC : o.holding } });
  const posts: World["posts"] = [];
  const model = { price: flat };
  const h: EvmSellHost = {
    chain: "base",
    testnet: false,
    pin: PIN,
    scope: SCOPE,
    venues: evmPoolVenues(),
    rpcs,
    round: async () => ({ events: [...c.events], fin: { number: c.fin } }),
    notes: async () => store,
    seed64: async () => SEED.slice(),
    holdings: async () => ((await md.get("meta", EVM_POSITION_COSTS_KEY)) ?? {}) as Record<string, unknown>,
    quote: (req: EvmPoolSellQuoteRequest) => sellQuoteWith(req, [provider(model), provider(model)], Date.now()),
    ...(o.build ? { build: o.build } : {}),
    banned: async () => [],
    ban: async () => {},
    reverted: async () => [],
    send: async (body) => {
      posts.push(body);
      return o.send ? o.send(posts.length, body) : "0x" + "aa".repeat(32);
    },
    open: async () => ((await md.get("meta", EVM_OPEN_SELLS_KEY)) ?? {}) as Record<string, EvmOpenSell>,
    record: async (x) => void (await md.update("meta", EVM_OPEN_SELLS_KEY, (v) => ({ ...((v as object) ?? {}), [x.note]: x }))),
    unrecord: async (note, deadline) =>
      void (await md.update("meta", EVM_OPEN_SELLS_KEY, (v) => {
        const all = { ...((v as Record<string, EvmOpenSell>) ?? {}) };
        if (all[note]?.deadline === deadline) delete all[note];
        return all;
      })),
    now: () => BigInt(Date.now()),
    wait: async (ms) => tick(ms),
  };
  return { h, c, land, posts, store, md };
}
const returnNote = async (store: NoteStore) => (await store.list()).find((n) => refKey(n.ref) === refKey(RETURN));
const openOf = async (x: World) => Object.values(((await x.md.get("meta", EVM_OPEN_SELLS_KEY)) ?? {}) as Record<string, EvmOpenSell>);

test("a sale: the device's quote, checked and signed, the record and the note INCOMING before the send, filled on both RPCs, one note UNSPENT", async () => {
  let x!: World;
  x = await world({
    send: async (_n, body) => {
      // before the bytes leave: the record and the note INCOMING
      assert.equal((await openOf(x)).length, 1);
      assert.equal((await returnNote(x.store))?.state, "INCOMING");
      const s = sellOf(body.data);
      x.land(s.minOut - s.fee);
      return "0x" + "d1".repeat(32);
    },
  });
  const a = await runEvmPoolSell(x.h, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "base", hash: "0x" + "d1".repeat(32) }] });
  assert.equal(x.posts.length, 1);
  const s = sellOf(x.posts[0]!.data);
  assert.equal(s.precommitment, P, "the return note's precommitment");
  assert.equal(s.feeRecipient, BigInt(V.feeCollector!), "the fee to the chain's pinned FeeCollector");
  assert.equal(s.pool, BigInt(POOL));
  assert.equal(s.amount, UNITS);
  assert.equal(s.fee, s.feeCap);
  assert.equal(s.nonce, 0n, "W's first sell nonce: no code yet");
  const auth = x.posts[0]!.authorization as { address: string; nonce: bigint; chainId: number };
  assert.equal(auth.address.toLowerCase(), V.sellDelegate!.toLowerCase());
  assert.equal(auth.nonce, 0n);
  assert.equal(auth.chainId, V.chainId);
  const n = await returnNote(x.store);
  assert.equal(n?.state, "UNSPENT");
  assert.equal(n?.leaf?.value, s.minOut - s.fee);
  assert.deepEqual(await openOf(x), [], "the record dropped once the note landed");
});

test("the calldata is byte for byte the encoding the pool's testnet run sends (testnet-run-lib.mjs sellData)", async () => {
  const x = await world({ send: async () => "0x" + "aa".repeat(32) });
  x.h.wait = async () => {
    throw new Error("stop");
  };
  await runEvmPoolSell(x.h, ASK).catch(() => {});
  const data = x.posts[0]!.data;
  const s = sellOf(data);
  const sig = Buffer.from(data).subarray(data.length - 96, data.length - 31);
  const h = Buffer.from(data).toString("hex");
  const swap = "0x" + h.slice(8 + 64 * 15, 8 + 64 * 15 + 2 * Number(BigInt("0x" + h.slice(8 + 64 * 14, 8 + 64 * 15))));
  // the target word as written: read it back from the calldata
  const target = "0x" + h.slice(8 + 64 * 5 + 24, 8 + 64 * 6);
  const again = sellData({ token: TOKEN, amount: s.amount, target, data: swap, minOut: s.minOut, pool: POOL, precommitment: s.precommitment, feeCap: s.feeCap, feeRecipient: V.feeCollector, deadline: s.deadline, nonce: s.nonce }, s.fee, new Uint8Array(sig));
  assert.equal("0x" + h, again);
});

test("the sale's finding reads only the Ws whose own buy record names the token sold: another W of the device, holding another token, is never named to the pool's RPCs (card evm-pools-on-mainnet)", async () => {
  const store = await notes();
  // a second note the device spent, paying its own W2, whose buy record names another token
  const DEP2: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  const L2 = vaultLabelOf(keccak_256, SCOPE, 2n);
  const pre2 = noteSecrets(SEED, DEP2).precommitment;
  const n2 = await store.add({ ref: DEP2, scope: SCOPE, precommitment: pre2, state: "UNSPENT", leaf: { value: 2n * 10n ** 15n, label: L2, commitment: noteCommitment(2n * 10n ** 15n, L2, pre2), leafIndex: 1n } });
  await store.move(n2.id, "UNSPENT", "SPENT");
  const W2 = freshWallet(SEED, "evm", L2, jOf(DEP2)).address.toLowerCase();
  assert.notEqual(W2, W);
  const OTHER = "0x" + "c0".repeat(20);
  const md = meta({ [EVM_POSITION_COSTS_KEY]: { [W]: ROUTE_REC, [W2]: { ...ROUTE_REC, mint: OTHER } } });
  const x = await world({ store, md });
  const named: string[] = [];
  const watch = (rpc: EvmRpc): EvmRpc => Object.assign(async (m: string, params: readonly unknown[]) => {
    named.push(JSON.stringify(params).toLowerCase());
    return rpc(m, params);
  }, { url: (rpc as { url?: string }).url });
  const plan = await planEvmSell({ ...x.h, rpcs: [watch(x.h.rpcs[0]), watch(x.h.rpcs[1])] as const }, ASK);
  assert.ok("legs" in plan, JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.ok(named.some((n) => n.includes(W.slice(2))), "W, the token's holder, is read");
  assert.ok(named.every((n) => !n.includes(W2.slice(2))), "W2 is never named to a pool RPC");
});

test("a pool RPC behind a W's buy block: the plan waits until both are past it, then reads W's tokens (a 100 % sale never plans without them)", async () => {
  const x = await world();
  // the buy record's block is 256: provider 1 reads two blocks under it
  x.c.lowBy[1] = x.c.head - 254n;
  await assert.rejects(planEvmSell(x.h, { ...ASK, amount: 0n, shareBps: 10_000 }), (e: Error) => e.name === "EvmLagError" && /under the buy at block 256/.test(e.message));
  // inside the tap's bound, a wait the provider catches up during plans W with all its units
  let waited = 0;
  x.h.wait = async (ms) => {
    waited++;
    tick(ms);
    x.c.lowBy[1] = 0n;
  };
  const { plan } = await evmSellPlanQuote(x.h, { ...ASK, amount: 0n, shareBps: 10_000 });
  assert.ok(waited >= 1, "the plan waited");
  assert.deepEqual(plan.legs.map((l) => [l.w.w, l.units]), [[W, UNITS]]);
});

test("a W whose buy record holds no route, or no block, is refused not_allowed: nothing read past the plan, nothing sent", async () => {
  for (const holding of [{ ...ROUTE_REC, route: undefined }, { ...ROUTE_REC, route: { ...ROUTE_REC.route, block: undefined } }, { ...ROUTE_REC, state: "pending" }]) {
    const x = await world({ holding });
    assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "not_allowed" });
    assert.equal(x.posts.length, 0);
    assert.equal(x.c.calls.length, 0, "no read at all");
    assert.deepEqual(await openOf(x), []);
  }
});

test("a token whose decimals() changed since its buy (6 at the quote's block, the ask's units made with 18) is refused before W signs", async () => {
  const x = await world();
  x.c.decimalsAtBlock = 6n;
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "quote_check_failed" });
  assert.equal(x.posts.length, 0);
  assert.deepEqual(await openOf(x), []);
  assert.notEqual((await returnNote(x.store))?.state, "INCOMING");
});

test("hostile inputs the rule refuses before W signs: another precommitment, another fee recipient, a hand-made sell, nonces the RPCs disagree on", async () => {
  const cases: [string, (x: World) => void][] = [
    ["another precommitment", (x) => (x.h.build = (q, f) => evmPoolBuildSell(q, { ...f, precommitment: f.precommitment + 1n }))],
    ["another fee recipient", (x) => (x.h.build = (q, f) => evmPoolBuildSell(q, { ...f, feeRecipient: "0x000000000000000000000000000000000000dEaD" }))],
    ["a hand-made sell", (x) => (x.h.build = (q, f) => ({ ...evmPoolBuildSell(q, f) }))],
    ["a fee cap over the device's rule", (x) => (x.h.build = (q, f) => evmPoolBuildSell(q, { ...f, feeCap: q.feeMax + 1n }))],
    ["W's account nonce two RPCs disagree on", (x) => (x.c.authNonce = [0n, 1n])],
    ["a quote made with more slippage than the ask's (its minOut under the rule's own floor)", (x) => (x.h.quote = (r) => sellQuoteWith({ ...r, slippageBps: r.slippageBps + 400 }, [provider({ price: flat }), provider({ price: flat })], Date.now()))],
    ["a quote that is not the kit's", (x) => (x.h.quote = async (r) => ({ ...(await sellQuoteWith(r, [provider({ price: flat }), provider({ price: flat })], Date.now())) }))],
  ];
  for (const [what, plant] of cases) {
    const x = await world();
    plant(x);
    const a = await runEvmPoolSell(x.h, ASK);
    assert.ok("error" in a && (a.error === "quote_check_failed" || a.error === "failed"), `${what}: ${JSON.stringify(a)}`);
    assert.equal(x.posts.length, 0, what);
    assert.deepEqual(await openOf(x), [], what);
  }
});

test("a 503 with Retry-After is waited out and the same signature sent again; it lands", async () => {
  let x!: World;
  x = await world({
    send: async (n, body) => {
      if (n < 3) throw new EvmSendBusy(5_000);
      const s = sellOf(body.data);
      x.land(s.minOut - s.fee);
      return "0x" + "d1".repeat(32);
    },
  });
  const a = await runEvmPoolSell(x.h, ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.equal(x.posts.length, 3);
  assert.deepEqual(x.posts[1]!.data, x.posts[0]!.data, "the same bytes");
  assert.deepEqual(x.posts[2]!.data, x.posts[0]!.data, "the same bytes");
});

test("past the deadline's margin the sale is signed once more on the same nonce and note; the first lands late, the second fails on chain, one note", async () => {
  let x!: World;
  x = await world({
    send: async (n) => {
      if (n === 1) {
        // the helper holds its lane long: the device's clock is past the first deadline's margin at its Retry-After
        tick(200_000);
        throw new EvmSendBusy(60_000);
      }
      // the second signature reached the helper; the FIRST one lands (a copy of its bytes someone sent), and the
      // second then fails on chain on the spent nonce, which leaves no log
      const first = sellOf(x.posts[0]!.data);
      x.land(first.minOut - first.fee, first.precommitment, W, "0x" + "f1".repeat(32));
      return "0x" + "d2".repeat(32);
    },
  });
  const a = await runEvmPoolSell(x.h, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "base", hash: "0x" + "f1".repeat(32) }] }, "the first's deposit, once");
  assert.equal(x.posts.length, 2);
  const [s1, s2] = x.posts.map((p) => sellOf(p.data));
  assert.equal(s2!.nonce, s1!.nonce, "the same Sell nonce: at most one of the two lands");
  assert.equal(s2!.precommitment, s1!.precommitment, "the same note");
  assert.ok(s2!.deadline > s1!.deadline, "a new deadline");
  assert.notDeepEqual(x.posts[1]!.data, x.posts[0]!.data);
  const mine = (await x.store.list()).filter((n) => n.ref.kind === "return" || n.ref.kind === "second");
  assert.equal(mine.length, 1, "one return note");
  assert.equal(mine[0]!.state, "UNSPENT");
  assert.equal(mine[0]!.leaf!.value, s1!.minOut - s1!.fee);
  assert.deepEqual(await openOf(x), []);
});

/** A closed page's tap: the device's timers mocked as well as its clock, so the tap's bound on the send (its 20 s
 *  timer) never passes while the test runs, and resetTimers clears it at the test's end; the order of the run's steps is
 *  the test's own, never a race with a real timer. */
const closedPageTimers = () => {
  resetTimers(mock.timers);
  enableTimers(mock.timers, { apis: ["Date", "setTimeout"], now: Date.now() });
};

test("a page closed between the record and the send: a reload's follow puts the note back PLANNED past the deadline, record dropped", async () => {
  closedPageTimers();
  // the send is asked (the record and the note INCOMING before it), and never answers: the page closed
  let posted!: () => void;
  const asked = new Promise<void>((r) => (posted = r));
  const x = await world({ send: () => (posted(), new Promise<string>(() => {})) });
  void runEvmPoolSell(x.h, ASK);
  await asked;
  assert.equal((await openOf(x)).length, 1);
  assert.equal((await returnNote(x.store))?.state, "INCOMING");
  // the reload: a new host on the same store and records, nothing of the closed run's in memory; the chain moves past
  const { h } = await world({ store: x.store, md: x.md });
  h.rpcs = x.h.rpcs;
  h.round = x.h.round;
  tick(400_000);
  x.c.head += 500n;
  await followEvmSells(h);
  assert.equal((await returnNote(x.store))?.state, "PLANNED");
  assert.deepEqual(await openOf(x), []);
});

test("a page closed between the send and the read-back: a reload's follow lands the one note UNSPENT, record dropped", async () => {
  closedPageTimers();
  // the send is asked and its deposit lands, and the answer never comes: the page closed
  let posted!: () => void;
  const asked = new Promise<void>((r) => (posted = r));
  let x!: World;
  x = await world({
    send: (_n, body) => {
      const s = sellOf(body.data);
      x.land(s.minOut - s.fee);
      posted();
      return new Promise<string>(() => {});
    },
  });
  void runEvmPoolSell(x.h, ASK);
  await asked;
  assert.equal(x.posts.length, 1);
  const { h } = await world({ store: x.store, md: x.md });
  h.rpcs = x.h.rpcs;
  h.round = x.h.round;
  await followEvmSells(h);
  const n = await returnNote(x.store);
  assert.equal(n?.state, "UNSPENT");
  assert.deepEqual(await openOf(x), []);
  assert.equal((await x.store.list()).filter((m) => m.ref.kind === "return" || m.ref.kind === "second").length, 1);
});

test("the helper's coded refusal on the first POST answers refused; the record stays for the chain to end", async () => {
  const x = await world({ send: async () => Promise.reject(new EvmSendRefused(422, "fee_low")) });
  x.h.signal = AbortSignal.abort();
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { stage: "refused", txs: [] });
  assert.equal((await openOf(x)).length, 1, "the helper's word never drops what may land");
});

test("the read-only plan and quote (evmSellPlanQuote) signs nothing and writes no record", async () => {
  const x = await world();
  const r = await evmSellPlanQuote(x.h, ASK);
  assert.equal(r.plan.legs.length, 1);
  assert.equal(r.legs[0]!.note.precommitment, P);
  assert.ok(r.legs[0]!.q.minOut > 0n);
  assert.equal(x.posts.length, 0);
  assert.deepEqual(await openOf(x), []);
});

test("evmSellSend: a 503 naming a Retry-After is a wait (the same bytes again), one with none is no answer, a 429 a wait", async () => {
  const body = { pool: POOL, w: W, data: new Uint8Array([1, 2]), authorization: { chainId: 8453, address: V.sellDelegate!, nonce: 0n, yParity: 1 as const, r: "0x01", s: "0x02" } };
  const at = (status: number, headers: Record<string, string> = {}, json: unknown = {}) => (async () => new Response(JSON.stringify(json), { status, headers })) as typeof fetch;
  await assert.rejects(evmSellSend("https://h.test", body, at(503, { "retry-after": "7" })), (e) => e instanceof EvmSendBusy && e.retryAfterMs === 7_000);
  await assert.rejects(evmSellSend("https://h.test", body, at(503)), (e) => e instanceof EvmSendNoAnswer);
  await assert.rejects(evmSellSend("https://h.test", body, at(429)), (e) => e instanceof EvmSendBusy && e.retryAfterMs === 1_000);
  await assert.rejects(evmSellSend("https://h.test", body, at(422, {}, { error: { code: "fee_low" } })), (e) => e instanceof EvmSendRefused && e.code === "fee_low");
  let sent: unknown = null;
  const ok = (async (_u: unknown, init: RequestInit) => ((sent = JSON.parse(String(init.body))), new Response(JSON.stringify({ hash: "0x" + "ab".repeat(32) }), { status: 200 }))) as typeof fetch;
  assert.equal(await evmSellSend("https://h.test", body, ok), "0x" + "ab".repeat(32));
  assert.deepEqual(sent, { pool: POOL, w: W, data: "0x0102", authorization: { chainId: "0x2105", address: V.sellDelegate!.toLowerCase(), nonce: "0x0", yParity: "0x1", r: "0x" + "1".padStart(64, "0"), s: "0x" + "2".padStart(64, "0") } });
});

test("restore: the route read back from the buy's own transaction on two RPCs equals the one the buy stored; no read names W or a hash", async () => {
  const adapter = V.adapters!.v4!;
  const route = BOUGHT as EvmRoute;
  const built = pinnedBuild(evmPoolVenues(), "base", adapter, route, 5n, TOKEN, true);
  const relay = { recipient: W, feeRecipient: PIN.feeRecipient, feeCap: 1n, deadlineMs: 1n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16) };
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const input = "0x" + Buffer.from(evmBuyCalldata(POOL, relay, proof as never, ["1", "2", "3", "4", "5", "6", "7", "8"] as never, 1n, built, new Uint8Array(65))).toString("hex");
  const TX = "0x" + "b0".repeat(32);
  const BH = "0x" + "cd".repeat(32);
  const asked: string[] = [];
  const rpc =
    (tamper = false): EvmRpc =>
    async (method, params) => {
      asked.push(JSON.stringify(params).toLowerCase());
      if (method === "eth_getLogs") {
        assert.deepEqual((params[0] as { topics: string[] }).topics, [T_BOUGHT]);
        return [{ address: POOL, topics: [T_BOUGHT, w32(BigInt(W))], data: "0x", blockNumber: "0x100", blockHash: BH, logIndex: "0x3", transactionHash: TX, transactionIndex: "0x1", removed: false }];
      }
      assert.equal(method, "eth_getBlockByNumber");
      return { hash: BH, transactions: [{ hash: "0x" + "00".repeat(32), to: POOL, input: "0x" }, { hash: TX, to: POOL, input: tamper ? input.slice(0, -2) + "ff" : input }] };
    };
  const got = await evmBuyRouteRead([rpc(), rpc()], "base", POOL, { w: W, token: TOKEN, block: 0x100n, blockHash: BH, logIndex: 3n });
  assert.deepEqual(got, { ...ROUTE_REC.route, tx: TX, adapter: adapter.toLowerCase() }, "the restored route is the stored one");
  assert.ok(asked.every((a) => !a.includes(W.slice(2)) && !a.includes(TX.slice(2))), "no read names W or the transaction");
  await assert.rejects(evmBuyRouteRead([rpc(), rpc(true)], "base", POOL, { w: W, token: TOKEN, block: 0x100n, blockHash: BH, logIndex: 3n }), /another buy/);
});

test("the live check's own constants are the page's: the sell selector, the Deposited topic, the testnet RPC pairs and chain ids, each testnet's sell delegate and sender, the sale's mark", async () => {
  const lc = (await import(new URL("../../../scripts/live-checks/signpage-evm-pool-sell.mjs", import.meta.url).href)) as Record<string, unknown>;
  const { EVM_SELL_SIGNATURE } = await import("../src/evm-send.ts");
  const { TESTNET_RPCS } = await import("../src/pool-testnet.ts");
  const { EVM_CHAIN_IDS } = await import("../../wallet/src/pool/evm.ts");
  assert.equal(lc.SELL_SELECTOR, topic(EVM_SELL_SIGNATURE).slice(0, 10));
  assert.equal(lc.DEPOSITED, T_DEPOSITED);
  assert.deepEqual(lc.RPCS, { "base-sepolia": TESTNET_RPCS.base, "robinhood-testnet": TESTNET_RPCS.robinhood });
  assert.deepEqual(lc.CHAIN_IDS, { "base-sepolia": EVM_CHAIN_IDS["base-sepolia"], "robinhood-testnet": EVM_CHAIN_IDS["robinhood-testnet"] });
  const v = evmPoolVenues();
  for (const n of ["base-sepolia", "robinhood-testnet"] as const) assert.deepEqual((lc.SELL_PINS as Record<string, unknown>)[n], { sellDelegate: v[n]!.sellDelegate!.toLowerCase(), sellSender: v[n]!.sellSender!.toLowerCase() });
  // the open sales' and the buy records' keys are no marks: the mainnet positions pass reads both (card evm-pools-on-mainnet)
  assert.ok(!(lc.EVM_SELL_MARKS as string[]).includes(EVM_OPEN_SELLS_KEY));
  assert.ok(!(lc.EVM_SELL_MARKS as string[]).includes(EVM_POSITION_COSTS_KEY));
  // the sale's typed data, whole: the kit's own type string (packages/kit/src/trade/evm/sell-unpinned.ts)
  assert.deepEqual(lc.EVM_SELL_MARKS, ["nonce()", "Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)"]);
});

// ---- the review of 1004e598..617fcd62 (card signpage-evm-pool-sell) ----

const HALF: PoolAsk = { ...ASK, amount: UNITS / 2n };
const R0: NoteRef = { kind: "second", id: { id: "R", c: "evm", l: L, j: J }, n: 0 };
const P_R0 = noteSecrets(SEED, R0).precommitment;
const saleNotes = async (store: NoteStore) => (await store.list()).filter((n) => n.ref.kind === "return" || n.ref.kind === "second").map((n) => `${refKey(n.ref)} ${n.state}`).sort();

test("P1-1: half, then the other half at once while the first sale's deposit is on chain but not final: its own note and the next Sell nonce; both land at the newest agreed block and stay landed once final; a restore from the words finds both in order", async () => {
  let x!: World;
  x = await world({
    send: async (_n, body) => {
      const s = sellOf(body.data);
      x.c.balance = x.c.balance.map((b) => b - s.amount);
      x.land(s.minOut - s.fee, s.precommitment, W, "0x" + (x.posts.length === 1 ? "e1" : "e2").repeat(32), true);
      return "0x" + "aa".repeat(32);
    },
  });
  const a1 = await runEvmPoolSell(x.h, HALF);
  assert.equal("stage" in a1 && a1.stage, "filled");
  assert.deepEqual(await saleNotes(x.store), [`${refKey(RETURN)} UNSPENT`], "the first sale's deposit is at the newest agreed block, not final: its note shows at once");
  const a2 = await runEvmPoolSell(x.h, HALF);
  assert.equal("stage" in a2 && a2.stage, "filled", JSON.stringify(a2));
  assert.equal(x.posts.length, 2);
  const [s1, s2] = x.posts.map((p) => sellOf(p.data));
  assert.deepEqual([s1!.precommitment, s2!.precommitment], [P, P_R0], "the second sale on R's first second arrival");
  assert.deepEqual([s1!.nonce, s2!.nonce], [0n, 1n], "the next Sell nonce");
  assert.deepEqual((await openOf(x)).map((o) => o.nonce), ["0", "1"], "both records kept: their deposits are in the round, not final");
  assert.deepEqual(await saleNotes(x.store), [`${refKey(RETURN)} UNSPENT`, `${refKey(R0)} UNSPENT`], "both shown before final");
  // the round's final block passes both deposits: a load's follow keeps both notes and drops both records
  x.c.fin += 100n;
  x.c.head += 200n;
  await followEvmSells(x.h);
  assert.deepEqual(await saleNotes(x.store), [`${refKey(RETURN)} UNSPENT`, `${refKey(R0)} UNSPENT`]);
  assert.deepEqual(await openOf(x), [], "both closed once final");
  // a wiped device: the words and the pool's events alone give both notes back (the walk's gap the test's own: the
  // pool's one deposit is lane 0's first index, and RESTORE_GAP's 8 x 10,000 misses are 28 s of pure hashing; the
  // return note's chain walks SECOND_GAP as on the device)
  const r = evmRestore({ seed64: SEED, scope: SCOPE, events: x.c.events, gap: 4 });
  assert.deepEqual(r.notes.filter((n) => n.ref.kind === "return" || n.ref.kind === "second").map((n) => [refKey(n.ref), n.leaf.value]), [
    [refKey(RETURN), s1!.minOut - s1!.fee],
    [refKey(R0), s2!.minOut - s2!.fee],
  ]);
});

for (const [ref, p] of [
  [RETURN, P],
  [R0, P_R0],
] as const) {
  test(`evm-money-shows-and-spends-at-once (review P2): a sale's ${ref.kind === "return" ? "return note" : "R note"}, landed at the newest agreed block, that a reorg backs out and no block includes again: the record stays until final, so a load's follow ends it not_landed and puts the note back PLANNED, never INCOMING for good`, async () => {
    let x!: World;
    const r = ref === R0;
    x = await world({
      send: async (_n, body) => {
        const s = sellOf(body.data);
        x.c.balance = x.c.balance.map((b) => b - s.amount);
        // the R case: the first sale lands final, the second (on R's first) at the newest agreed block only
        x.land(s.minOut - s.fee, s.precommitment, W, "0x" + (x.posts.length === 1 ? "e1" : "e2").repeat(32), !r || x.posts.length === 2);
        return "0x" + "aa".repeat(32);
      },
    });
    if (r) {
      const first = await runEvmPoolSell(x.h, HALF);
      assert.equal("stage" in first && first.stage, "filled", "the first sale, final");
    }
    const a = await runEvmPoolSell(x.h, HALF);
    assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
    const n = (await x.store.list()).find((m) => refKey(m.ref) === refKey(ref))!;
    assert.equal(n.precommitment, p);
    assert.equal(n.state, "UNSPENT", `${refKey(ref)}: shown at once`);
    assert.deepEqual((await openOf(x)).map((o) => o.note), [n.id], `${refKey(ref)}: its record kept while its block is above the final one`);
    // a reorg takes the deposit out and no block includes it again: the heal backs the note out (INCOMING), W's Sell
    // nonce back where it was
    x.c.deposits.pop();
    x.c.events.pop();
    x.c.sellNonce = x.c.sellNonce! - 1n;
    await x.store.backOut(n.id, x.c.fin);
    assert.equal((await x.store.get(n.id))!.state, "INCOMING");
    // past the sale's deadline, a later load: the follow reads no deposit of it and ends it
    tick((EVM_SELL_DEADLINE_S + 120) * 1000);
    await followEvmSells(x.h);
    assert.equal((await x.store.get(n.id))!.state, "PLANNED", `${refKey(ref)}: back to PLANNED, not an arriving line for good`);
    assert.deepEqual(await openOf(x), [], `${refKey(ref)}: the record dropped at its end`);
  });
}

test("P1-1: the store plans an EVM sale's next R note on an INCOMING one only while fewer than the restore's gap of that chain are unlanded; a Solana chain never", async () => {
  assert.equal(EVM_SECOND_GAP, SECOND_GAP, "the store's number is the restore's");
  const store = await notes();
  const ret = await store.add({ ref: RETURN, scope: SCOPE, precommitment: P, state: "PLANNED" });
  await store.move(ret.id, "PLANNED", "INCOMING");
  const rOf = (n: number): NoteRef => ({ kind: "second", id: { id: "R", c: "evm", l: L, j: J }, n });
  for (let n = 0; n < SECOND_GAP - 1; n++) {
    const m = await store.add({ ref: rOf(n), scope: SCOPE, precommitment: noteSecrets(SEED, rOf(n)).precommitment, state: "PLANNED" });
    await store.move(m.id, "PLANNED", "INCOMING");
  }
  await assert.rejects(store.add({ ref: rOf(SECOND_GAP - 1), scope: SCOPE, precommitment: noteSecrets(SEED, rOf(SECOND_GAP - 1)).precommitment, state: "PLANNED" }), /waits until the note before it has landed/);
  const sol: NoteRef = { kind: "return", c: "sol", l: L, j: J };
  const s = await store.add({ ref: sol, scope: SCOPE, precommitment: noteSecrets(SEED, sol).precommitment, state: "PLANNED" });
  await store.move(s.id, "PLANNED", "INCOMING");
  const solR: NoteRef = { kind: "second", id: { id: "R", c: "sol", l: L, j: J }, n: 0 };
  await assert.rejects(store.add({ ref: solR, scope: SCOPE, precommitment: noteSecrets(SEED, solR).precommitment, state: "PLANNED" }), /waits until the note before it has landed/);
});

test("P2-1: a sale that lands after the tap's read-back ended is still written: the follow runs on the page's store, kept open until it ends", async () => {
  const kept: Promise<unknown>[] = [];
  let closed = false;
  let x!: World;
  x = await world({
    send: async (_n, body) => {
      const s = sellOf(body.data);
      // its logs reach the RPCs only after the tap's EVM_SELL_SETTLE_MS of reads (hideUntil below)
      x.land(s.minOut - s.fee);
      return "0x" + "aa".repeat(32);
    },
  });
  x.c.hideUntil = Date.now() + 200_000;
  x.h.keep = (p) => void kept.push(p);
  const a = await runEvmPoolSell(x.h, ASK);
  assert.equal("stage" in a && a.stage, "sent");
  closed = kept.length === 0;
  assert.equal(closed, false, "the read-back was handed to the page");
  await Promise.all(kept);
  assert.equal((await returnNote(x.store))?.state, "UNSPENT");
  assert.deepEqual(await openOf(x), []);
});

test("P2-2: two heads further apart than the buy's bound refuse the sale before anything leaves; a record whose start is past a head is left unread", async () => {
  const x = await world();
  x.c.lowBy = [50_000n, 0n];
  x.c.head = 100_000n;
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "failed" });
  assert.equal(x.posts.length, 0);
  assert.deepEqual(await openOf(x), []);
  const y = await world();
  const o: EvmOpenSell = { note: "n1", chain: "base", w: W, token: TOKEN, amount: "1", precommitment: P.toString(), nonce: "0", deadline: "1", from: (y.c.head + 10n).toString(), least: "1" };
  await y.h.record(o);
  const before = y.c.calls.length;
  await followEvmSells(y.h);
  assert.equal(y.c.calls.filter((c) => c.method === "eth_getLogs").length, 0, "no log read on a start past the chain");
  assert.ok(y.c.calls.length - before <= 2, "the two heads only");
  assert.equal((await openOf(y)).length, 1, "kept as it is");
});

test("P2-3: one round past the deadline with empty log lists is not not_landed: the deposit read on a round EVM_BUY_LAG_MS on lands it", async () => {
  const x = await world();
  const n = await x.store.add({ ref: RETURN, scope: SCOPE, precommitment: P, state: "PLANNED" });
  await x.store.move(n.id, "PLANNED", "INCOMING");
  // a sale past its deadline (both RPCs' safe blocks past it) whose deposit is on chain, its logs trailing for 5 s
  const o: EvmOpenSell = { note: n.id, chain: "base", w: W, token: TOKEN, amount: "1", precommitment: P.toString(), nonce: "0", deadline: (BigInt(Math.floor(Date.now() / 1000)) - 100n).toString(), from: "900", least: "1" };
  await x.h.record(o);
  x.land(10n ** 15n);
  // in a block before the deadline (2 s blocks: 60 blocks under the head is 120 s back)
  x.c.deposits.at(-1)!.block = x.c.head - 60n;
  x.c.hideUntil = Date.now() + 5_000;
  await followEvmSells(x.h);
  assert.equal((await returnNote(x.store))?.state, "UNSPENT", "landed, never put back PLANNED on the first empty round");
  assert.deepEqual(await openOf(x), []);
  // and with no deposit at all: not_landed, on a round EVM_BUY_LAG_MS after the first
  const y = await world();
  const m = await y.store.add({ ref: RETURN, scope: SCOPE, precommitment: P, state: "PLANNED" });
  await y.store.move(m.id, "PLANNED", "INCOMING");
  await y.h.record({ ...o, note: m.id });
  await followEvmSells(y.h);
  assert.equal((await returnNote(y.store))?.state, "PLANNED");
  assert.deepEqual(await openOf(y), []);
});

test("P2-4: a helper's refusal never locks W's sale: the next tap, before the first's deadline, signs again on the same Sell nonce and note, and one note lands", async () => {
  let x!: World;
  x = await world({
    send: async (n, body) => {
      if (n === 1) throw new EvmSendRefused(422, "fee_low");
      const s = sellOf(body.data);
      x.land(s.minOut - s.fee);
      return "0x" + "aa".repeat(32);
    },
  });
  const kept: Promise<unknown>[] = [];
  x.h.keep = (p) => void kept.push(p);
  x.h.following = new Set();
  // the clock stands still: the first sale's deadline is minutes away for every read here
  x.h.wait = () => new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { stage: "refused", txs: [] });
  assert.equal((await returnNote(x.store))?.state, "INCOMING");
  assert.equal((await openOf(x)).length, 1, "the refused sale's record stays for the chain to end");
  const a = await runEvmPoolSell(x.h, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const [s1, s2] = x.posts.map((p) => sellOf(p.data));
  assert.equal(s2!.nonce, s1!.nonce);
  assert.equal(s2!.precommitment, s1!.precommitment);
  for (let i = 0; i < 3; i++) await Promise.all(kept);
  assert.deepEqual(await saleNotes(x.store), [`${refKey(RETURN)} UNSPENT`]);
  assert.deepEqual(await openOf(x), []);
});

test("P3-3: a sign out ends the sale's POST in flight: no answer at once, never the helper's 15 s", async () => {
  const stop = new AbortController();
  const fetchFn = ((_u: string, init: RequestInit) =>
    new Promise<Response>((_r, no) => init.signal!.addEventListener("abort", () => no(init.signal!.reason), { once: true }))) as typeof fetch;
  const sent = evmSellSend("https://helper.test", { pool: POOL, w: W, data: new Uint8Array(4), authorization: { chainId: 84532n, address: W, nonce: 0n, yParity: 0, r: 1n, s: 1n } as never }, fetchFn, stop.signal);
  setTimeout(() => stop.abort(), 5);
  const r = await Promise.race([sent.then(() => "answered", (e) => (e instanceof EvmSendNoAnswer ? "no answer" : String(e))), new Promise((r) => setTimeout(() => r("still waiting"), 2_000))]);
  assert.equal(r, "no answer");
});

test("P2-4: a sale another tap of this page is sending now is not signed again by a second tap", async () => {
  const x = await world({ send: () => new Promise<string>(() => {}) });
  x.h.sending = new Set();
  x.h.keep = () => {};
  x.h.sendTapMs = 50;
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { stage: "sent", txs: [] });
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "failed" });
  assert.equal(x.posts.length, 1);
});

test("P3-2: a helper hash whose receipt failed but which is not W's sale is not believed: the tap reads on and the sale lands", async () => {
  let x!: World;
  const BAD = "0x" + "bb".repeat(32);
  x = await world({
    send: async (_n, body) => {
      const s = sellOf(body.data);
      x.c.receipts.set(BAD, "0x0");
      x.c.txs.set(BAD, { to: "0x00000000000000000000000000000000000000cc", input: "0x0c2cb9ca" });
      x.land(s.minOut - s.fee);
      return BAD;
    },
  });
  // the first rounds read no log yet, so the tap asks after the hint first
  x.c.hideUntil = Date.now() + 10_000;
  x.h.keep = () => {};
  const a = await runEvmPoolSell(x.h, ASK);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
});

test("P3-3: a busy helper never holds the tap past its bound: answered sent, the send runs on and lands", async () => {
  let x!: World;
  let n = 0;
  x = await world({
    send: async (_k, body) => {
      if (++n < 4) throw new EvmSendBusy(5_000);
      const s = sellOf(body.data);
      x.land(s.minOut - s.fee);
      return "0x" + "aa".repeat(32);
    },
  });
  const kept: Promise<unknown>[] = [];
  x.h.keep = (p) => void kept.push(p);
  x.h.sendTapMs = 0;
  // the busy waits take real time here, so the tap's bound passes first
  x.h.wait = (ms) => new Promise((r) => setTimeout(() => (tick(ms), r()), 5));
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { stage: "sent", txs: [] });
  await Promise.all(kept);
  for (let i = 0; i < 50 && kept.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  await Promise.all(kept);
  assert.equal((await returnNote(x.store))?.state, "UNSPENT");
});

test("a wiped device sells the rest while its last sale's deposit is not final: that note written from the round and shown at once, the next on R's first; both stay landed once final; an INCOMING note no sale holds and no deposit names is signed on", async () => {
  let x!: World;
  x = await world({
    send: async (_n, body) => {
      const s = sellOf(body.data);
      x.c.balance = x.c.balance.map((b) => b - s.amount);
      x.land(s.minOut - s.fee, s.precommitment, W, "0x" + "e2".repeat(32), true);
      return "0x" + "aa".repeat(32);
    },
  });
  // the first sale, from another device: on chain above the final block, its note in no store here
  x.land(10n ** 15n, P, W, "0x" + "e1".repeat(32), true);
  const a = await runEvmPoolSell(x.h, HALF);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const s = sellOf(x.posts[0]!.data);
  assert.deepEqual([s.precommitment, s.nonce], [P_R0, 1n], "R's first, on the next Sell nonce");
  assert.deepEqual(await saleNotes(x.store), [`${refKey(RETURN)} UNSPENT`, `${refKey(R0)} UNSPENT`], "both at the newest agreed block, shown before final");
  x.c.fin += 100n;
  x.c.head += 200n;
  await followEvmSells(x.h);
  assert.deepEqual(await saleNotes(x.store), [`${refKey(RETURN)} UNSPENT`, `${refKey(R0)} UNSPENT`]);
  // an INCOMING note with no open sale whose deposit a reorg dropped: the next sale signs on it, never stuck
  const y = await world({
    send: async (_n, body) => {
      const s = sellOf(body.data);
      y.land(s.minOut - s.fee, s.precommitment);
      return "0x" + "aa".repeat(32);
    },
  });
  const n = await y.store.add({ ref: RETURN, scope: SCOPE, precommitment: P, state: "PLANNED" });
  await y.store.move(n.id, "PLANNED", "INCOMING");
  const b = await runEvmPoolSell(y.h, ASK);
  assert.equal("stage" in b && b.stage, "filled", JSON.stringify(b));
  assert.equal(sellOf(y.posts[0]!.data).precommitment, P);
  assert.equal((await returnNote(y.store))?.state, "UNSPENT");
});

test("the authorization's r and s go to the helper as 32-byte words, a zero first byte kept (its WORD32 shape): one in 128 signatures was refused bad_shape on every try", async () => {
  const { evmAuthorizationJson } = await import("../src/evm-send.ts");
  // as signEvmAuthorization gives them: hex strings, here with a zero first byte
  const j = evmAuthorizationJson({ chainId: 84532, address: W, nonce: 0n, yParity: 1, r: "0x" + "00ab".padStart(64, "0"), s: "0x" + (1n << 247n).toString(16).padStart(64, "0") });
  assert.match(j.r, /^0x[0-9a-f]{64}$/);
  assert.match(j.s, /^0x[0-9a-f]{64}$/);
  assert.equal(BigInt(j.r), 0xabn);
  assert.equal(BigInt(j.s), 1n << 247n);
  assert.deepEqual([j.chainId, j.nonce, j.yParity], ["0x14a34", "0x0", "0x1"], "the rest stay quantities");
});

// ---- the delta review of 2c3760a5 (card signpage-evm-pool-sell) ----

test("P2-A: a second tap while the first sale is with the helper (its hash in the record, not mined) answers failed and sends nothing; the first's own follow tells its fill", async () => {
  let x!: World;
  x = await world({ send: async () => "0x" + "aa".repeat(32) });
  let fast = true;
  x.h.wait = (ms) => (fast ? (tick(ms), Promise.resolve()) : new Promise((r) => setTimeout(r, 1)));
  const kept: Promise<unknown>[] = [];
  const lates: string[] = [];
  x.h.keep = (p) => void kept.push(p);
  x.h.late = (a) => void lates.push(a.stage);
  x.h.following = new Set();
  x.h.sending = new Set();
  assert.deepEqual(await runEvmPoolSell(x.h, HALF), { stage: "sent", txs: [] }, "not mined in the tap's settle");
  fast = false;
  assert.equal((await openOf(x))[0]?.tx, "0x" + "aa".repeat(32), "the helper's hash in the record");
  tick(2_000);
  assert.deepEqual(await runEvmPoolSell(x.h, HALF), { error: "failed" });
  assert.equal(x.posts.length, 1, "one POST");
  const s = sellOf(x.posts[0]!.data);
  x.c.txs.set("0x" + "aa".repeat(32), { input: "0x" + Buffer.from(x.posts[0]!.data).toString("hex") });
  x.land(s.minOut - s.fee, s.precommitment, W, "0x" + "aa".repeat(32));
  for (let i = 0; i < 3; i++) await Promise.all(kept);
  assert.deepEqual(lates, ["filled"], "one fill, the first tap's");
});

test("P2-A: two devices on one nonce and note: the device whose signature did not land answers failed, never filled; the note lands", async () => {
  let x!: World;
  const OTHER = "0x" + "bb".repeat(32);
  x = await world({
    send: async (_n, body) => {
      const s = sellOf(body.data);
      // the other device's Sell of the same note won the nonce: its transaction, with its own signature
      x.c.txs.set(OTHER, { to: W, input: "0x0c2cb9ca" + "11".repeat(400) });
      x.land(s.minOut - s.fee, s.precommitment, W, OTHER);
      return "0x" + "aa".repeat(32);
    },
  });
  x.h.keep = () => {};
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "failed" });
  assert.equal((await returnNote(x.store))?.state, "UNSPENT", "the user's note all the same");
  // and the device whose own signature it is answers filled
  let y!: World;
  y = await world({
    send: async (_n, body) => {
      const s = sellOf(body.data);
      y.c.txs.set(OTHER, { to: W, input: "0x" + Buffer.from(body.data).toString("hex") });
      y.land(s.minOut - s.fee, s.precommitment, W, OTHER);
      return "0x" + "aa".repeat(32);
    },
  });
  y.h.keep = () => {};
  const b = await runEvmPoolSell(y.h, ASK);
  assert.equal("stage" in b && b.stage, "filled", JSON.stringify(b));
});

test("P2-A: a refused sale signed again is that sale: another amount waits (failed, nothing sent); the same amount is signed on its amount and floor", async () => {
  let x!: World;
  x = await world({
    send: async (n, body) => {
      if (n === 1) throw new EvmSendRefused(422, "fee_low");
      const s = sellOf(body.data);
      x.land(s.minOut - s.fee);
      return "0x" + "aa".repeat(32);
    },
  });
  x.h.keep = () => {};
  x.h.following = new Set();
  x.h.wait = () => new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(await runEvmPoolSell(x.h, HALF), { stage: "refused", txs: [] });
  const first = (await openOf(x))[0]!;
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "failed" }, "another amount than the open sale's");
  assert.equal(x.posts.length, 1);
  const a = await runEvmPoolSell(x.h, HALF);
  assert.equal("stage" in a && a.stage, "filled", JSON.stringify(a));
  const [s1, s2] = x.posts.map((p) => sellOf(p.data));
  assert.equal(s2!.amount, s1!.amount);
  assert.ok(s2!.minOut - s2!.fee >= BigInt(first.least), "a floor no lower than the first's");
});

test("review F4: a refusal that comes past the tap's bound is told as a late stage", async () => {
  let x!: World;
  let n = 0;
  x = await world({
    send: async () => {
      if (++n < 3) throw new EvmSendBusy(5_000);
      throw new EvmSendRefused(422, "fee_low");
    },
  });
  const kept: Promise<unknown>[] = [];
  const lates: string[] = [];
  x.h.keep = (p) => void kept.push(p);
  x.h.late = (a) => void lates.push(a.stage);
  x.h.sendTapMs = 0;
  x.h.wait = (ms) => new Promise((r) => setTimeout(() => (tick(ms), r()), 5));
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { stage: "sent", txs: [] });
  for (let i = 0; i < 100 && !lates.includes("refused"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(lates[0], "refused");
  // its follow reads on to the deadline (a signed Sell can still be sent until it), then ends with no fill told
  for (let i = 0; i < 3; i++) await Promise.all(kept);
  assert.deepEqual(lates, ["refused"]);
});

test("review D1: logs trailing past the lag with W's Sell nonce taken: read on, the deposit lands, never put back PLANNED", async () => {
  const x = await world();
  const n = await x.store.add({ ref: RETURN, scope: SCOPE, precommitment: P, state: "PLANNED" });
  await x.store.move(n.id, "PLANNED", "INCOMING");
  const o: EvmOpenSell = { note: n.id, chain: "base", w: W, token: TOKEN, amount: "1", precommitment: P.toString(), nonce: "0", deadline: (BigInt(Math.floor(Date.now() / 1000)) - 100n).toString(), from: "900", least: "1" };
  await x.h.record(o);
  x.land(10n ** 15n);
  x.c.deposits.at(-1)!.block = x.c.head - 60n;
  // the logs answer empty for two minutes, far past the two rounds' lag
  x.c.hideUntil = Date.now() + 120_000;
  await followEvmSells(x.h);
  assert.equal((await returnNote(x.store))?.state, "UNSPENT");
  assert.deepEqual(await openOf(x), []);
});

test("review F3b: a sign out during a send past the tap's bound frees the note's follow mark", async () => {
  const stop = new AbortController();
  const x = await world({ send: () => new Promise<string>((_r, no) => stop.signal.addEventListener("abort", () => no(new EvmSendNoAnswer(null, "fault")), { once: true })) });
  const kept: Promise<unknown>[] = [];
  x.h.keep = (p) => void kept.push(p);
  x.h.following = new Set();
  x.h.signal = stop.signal;
  x.h.sendTapMs = 0;
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { stage: "sent", txs: [] });
  assert.equal(x.h.following.size, 1);
  stop.abort();
  for (let i = 0; i < 3; i++) await Promise.all(kept);
  assert.equal(x.h.following.size, 0);
});

// the page's one rule for a kind's reads (card start-reads-wait-out-a-throttle, src/read-waits.ts), the sale's too: a
// provider read that fails before W signs is made again after a wait from 1 s, doubling, at most 10 s, inside the tap's
// one bound, then "down"; a sign out ends a wait at once, and nothing runs after it
test("a throttled read before W signs: the rule's waits inside the tap's one bound, then down, nothing sent", async () => {
  const x = await world();
  const waited: number[] = [];
  let reads = 0;
  x.h.holdings = async () => {
    reads++;
    throw new SolanaRpcTransportError("http_429", "HTTP 429", 1, "rpc.test");
  };
  x.h.wait = async (ms) => (waited.push(ms), tick(ms));
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "down" });
  assert.deepEqual(waited, [1_000, 2_000, 4_000, 8_000, 10_000], "doubling, at most 10 s, none past the tap's bound");
  assert.ok(waited.reduce((a, b) => a + b, 0) <= READ_WAIT_TOTAL_MS);
  assert.equal(reads, waited.length + 1, "each attempt reads again from its first read");
  assert.equal(x.posts.length, 0);
});
test("a sign out while the sale's read waits ends the wait at once: failed, nothing read after, nothing sent", { timeout: 5_000 }, async () => {
  const x = await world();
  const out = new AbortController();
  let reads = 0;
  x.h.holdings = async () => {
    reads++;
    throw new SolanaRpcTransportError("http_429", "HTTP 429", 1, "rpc.test");
  };
  // a wait that ends only at the sign out
  x.h.wait = () => (out.abort(), new Promise<void>(() => {}));
  x.h.stop = out.signal;
  assert.deepEqual(await runEvmPoolSell(x.h, ASK), { error: "failed" });
  assert.equal(reads, 1);
  assert.equal(x.posts.length, 0);
});

// review P2-1 of 024e8a89d: the EVM sale's whole run holds POOL_TRADE_LOCK, shared, so no Solana leftover rent back
// starts beside it in any tab
test("kind: the run holds the trade lock, shared, before the host is made", async () => {
  const asked: { name: string; mode: string | undefined }[] = [];
  const locks = { request: (name: string, o: LockOptions, f: () => unknown) => (asked.push({ name, mode: o.mode }), Promise.resolve().then(f)) } as unknown as Pick<LockManager, "request">;
  const r = poolSellEvmKind(() => {
    throw new Error("no host");
  }, locks)(ASK, null) as { after: Promise<void>; answer(): unknown };
  await r.after;
  assert.deepEqual(r.answer(), { error: "failed" });
  assert.deepEqual(asked, [{ name: POOL_TRADE_LOCK, mode: "shared" }]);
});
