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
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { evmPoolVenues, pinnedBuild, type EvmRoute } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildSell } from "../../kit/src/trade/evm/sell.ts";
import type { EvmPoolSellQuoteRequest } from "../../kit/src/checks/evm/quote.ts";
import { BOUGHT, flat, provider, refreshHead, sellQuoteWith, TOKEN } from "../../kit/test/evm-sell-quote-fx.ts";
import { EVM_POSITION_COSTS_KEY, type EvmHolding } from "../src/pool-buy-evm.ts";
import { EvmSendBusy, EvmSendNoAnswer, EvmSendRefused, evmBuyCalldata, evmSellSend } from "../src/evm-send.ts";
import { EVM_OPEN_SELLS_KEY, evmBuyRouteRead, evmSellPlanQuote, followEvmSells, runEvmPoolSell, type EvmOpenSell, type EvmSellHost } from "../src/pool-sell-evm.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const LIB = new URL("../../../contracts/pool-evm/script/testnet-run-lib.mjs", import.meta.url).href;
const { sellData } = (await import(LIB)) as { sellData: (...a: unknown[]) => string };

const V = evmPoolVenues().base;
const POOL = V.pool!.toLowerCase();
const PIN: EvmPoolPin = Object.freeze({ network: "base", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(POOL, BigInt(V.chainId));
// the all-zero seed (the published test vector's words, packages/wallet/test/vectors/a8.json)
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 5n;
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
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  refreshHead();
});
afterEach(() => mock.timers.reset());
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
          return hx(c.head);
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
  /** The sale's deposit lands: its log on both RPCs at the next block, and in the pool's round at a final block. */
  const land = (value: bigint, precommitment = P, depositor = W, tx = "0x" + "d1".repeat(32)) => {
    c.head += 1n;
    c.deposits.push({ block: c.head, depositor, value, precommitment, tx });
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(c.events.filter((e) => e.kind === "deposit").length + 1));
    c.events.push({ block: c.fin, blockHash: w32(c.fin), logIndex: BigInt(c.events.length), bytes: "", kind: "deposit", state: noteCommitment(value, label, precommitment), label, value, precommitment, nullifier: null, recipient: null, token: null } as EvmPoolEvent);
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
  // the buy's own release, final in the round: no release of the device's is on its way to W
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
    build: o.build ?? evmPoolBuildSell,
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

test("a page closed between the record and the send: a reload's follow puts the note back PLANNED past the deadline, record dropped", async () => {
  const x = await world({ send: () => new Promise<string>(() => {}) });
  void runEvmPoolSell(x.h, ASK);
  for (let i = 0; i < 200 && (await openOf(x)).length === 0; i++) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 200 && x.posts.length === 0; i++) await new Promise((r) => setImmediate(r));
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
  let x!: World;
  x = await world({
    send: (_n, body) => {
      const s = sellOf(body.data);
      x.land(s.minOut - s.fee);
      return new Promise<string>(() => {});
    },
  });
  void runEvmPoolSell(x.h, ASK);
  for (let i = 0; i < 400 && x.posts.length === 0; i++) await new Promise((r) => setImmediate(r));
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
  assert.deepEqual(sent, { pool: POOL, w: W, data: "0x0102", authorization: { chainId: "0x2105", address: V.sellDelegate!.toLowerCase(), nonce: "0x0", yParity: "0x1", r: "0x1", s: "0x2" } });
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
