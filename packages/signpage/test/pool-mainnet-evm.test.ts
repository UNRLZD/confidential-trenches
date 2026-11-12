// SIGN_HOST's build on Base and Robinhood (card evm-pools-on-mainnet): the wallet's mainnet EVM pins (EVM_POOLS.base,
// EVM_POOLS.robinhood), the page's USD price pair (the pool list's two seats) and the chains' positions, which read
// each W on the helper's route alone (pageEvmPassReads), so a public provider is never named one device's Ws. pool.deposit
// and pool.withdraw run there (card evm-deposit-on-mainnet), and pool.buy and its follow, as the build carries the
// chain's withdraw and a refused buy's ETH on W goes back into the pool (src/pool-carry-evm.ts); pool.sell and its
// follow stay refused, each read nothing, until a restored device holds the buy records to sell from.
//   node --test test/pool-mainnet-evm.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { EvmRpc } from "../../wallet/src/pool/evm.ts";

// the page's channels live as long as the page (as test/main-mainnet-pools.test.ts lets them): the process ends with
// them open
const BC = globalThis.BroadcastChannel;
(globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = class extends BC {
  constructor(name: string) {
    super(name);
    (this as unknown as { unref?: () => void }).unref?.();
  }
};
const { testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");

assert.equal(POOL_TESTNET, false, "this file runs as SIGN_HOST's build");
type Ask = import("../src/rules/pool.ts").PoolAsk;

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const ctx = { id: "r1", sha: "00", progress: () => {} };
const TOKEN = "0xF111111111111111111111111111111111111111";
const DEPOSIT: Ask = { kind: "pool.deposit", chain: "base", token: null, amount: 10n ** 15n, slippageBps: 0, decimals: 18 };
const BUY: Ask = { kind: "pool.buy", chain: "base", token: TOKEN, amount: 10n ** 15n, slippageBps: 100, decimals: 18 };
const SELL: Ask = { kind: "pool.sell", chain: "base", token: TOKEN, amount: 10n ** 6n, slippageBps: 100, decimals: 6 };
const stores: WalletStore[] = [];
after(() => stores.forEach((s) => s.close()));
const page = () => ({
  store: async () => {
    const w = await openWalletStore({ indexedDB: new IDBFactory() });
    stores.push(w);
    return w;
  },
  seed64: async () => SEED.slice(),
});
/** Two RPCs of two providers over an empty U (a block, nonce 0, balance 0), and every call they were asked. */
function rpcs() {
  const calls: string[] = [];
  const rpc = (url: string): EvmRpc => Object.assign(async (method: string, params: readonly unknown[]) => {
    calls.push(method);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0xf4240" };
    if (method === "eth_getTransactionCount" || method === "eth_getBalance") return "0x0";
    if (method === "eth_call") return "0x" + "0".repeat(64);
    throw new Error(`unmocked ${method} ${JSON.stringify(params)}`);
  }, { url });
  return { calls, pair: [rpc("https://a.example"), rpc("https://b.example")] as const };
}

test("SIGN_HOST's build pins both mainnet pools and reads each chain's price on the pool list's two seats", async () => {
  const { MAINNET_POOL_RPCS } = await import("../src/pool-testnet.ts");
  const deps = testnetPoolDeps();
  for (const chain of ["base", "robinhood"] as const) {
    assert.ok(EVM_POOLS[chain] !== undefined, `${chain} pinned`);
    assert.equal(deps.pinned(chain), true, `${chain}: a pool kind passes the pin`);
    const pair = deps.rpcs(chain) as unknown as { url?: string }[] | null;
    assert.deepEqual(pair?.map((r) => new URL(String(r.url)).origin), MAINNET_POOL_RPCS[chain].slice(0, 2), `${chain}: the price's pair (src/pool-price.ts), the trade box's Buy`);
  }
});

test("a Base and a Robinhood pool.sell read the token's decimals on the chain's pair, then reach the flow", async () => {
  const { poolKinds } = await import("../src/pool-kinds.ts");
  const calls: { url: string; to: unknown }[] = [];
  const at = (url: string) => Object.assign(async (m: string, p: readonly unknown[]) => {
    calls.push({ url, to: (p[0] as { to?: unknown })?.to });
    if (m === "eth_blockNumber") return "0x64";
    return "0x" + "0".repeat(63) + "6";
  }, { url });
  const flows: Ask[] = [];
  const deps = testnetPoolDeps((ask) => (flows.push(ask), { error: "not_allowed" }));
  const k = poolKinds({ ...deps, rpcs: () => [at("https://a.example"), at("https://b.example")] as never, wait: async () => {} });
  for (const chain of ["base", "robinhood"] as const) {
    const got = k["pool.sell"]({ chain, token: TOKEN, amount: "1", slippage_bps: 100 }, ctx as never) as { after?: Promise<unknown>; answer?: () => unknown };
    await got.after;
  }
  assert.deepEqual(flows.map((f) => `${f.kind} ${f.chain} ${f.decimals}`), ["pool.sell base 6", "pool.sell robinhood 6"]);
  assert.ok(calls.length > 0 && calls.every((c) => String(c.to ?? TOKEN).toLowerCase() === TOKEN.toLowerCase()), "only the token is read, never a W");
});

// On SIGN_HOST's build a Base and a Robinhood pool.deposit, a deposit from U, pool.withdraw and pool.buy reach their
// runners, as the build carries the chain's withdraw (src/pool-testnet.ts poolWayOut) and a refused buy's ETH on W has
// its way back (src/pool-carry-evm.ts). The sale stays closed until a restored device holds the buy records to sell
// from: refused, reading nothing.
test("on SIGN_HOST's build a Base and a Robinhood pool.deposit, a deposit from U, pool.withdraw and pool.buy reach their runners; pool.sell is refused not_allowed and reads nothing", async () => {
  const WITHDRAW: Ask = { kind: "pool.withdraw", chain: "base", token: null, amount: 10n ** 15n, slippageBps: 0, decimals: 18 };
  for (const chain of ["base", "robinhood"] as const) {
    const r = rpcs();
    const ran: string[] = [];
    const withdrawn: string[] = [];
    const t = testnetPool({ ...page(), openWithdraw: (c) => (withdrawn.push(c), { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent" } }) }) as never }, {
      evmRpcs: () => r.pair,
      evmRound: () => async () => (ran.push("round"), { events: [], finalBlock: 100n }),
      evmSync: () => ({ events: async () => assert.fail("no sync read") }),
      depositKinds: { evm: (() => (ask: Ask | null) => (ran.push(`deposit ${ask?.chain}`), { error: "not_allowed" })) as never },
      tradeKinds: {
        evmBuy: () => () => (ran.push("buy"), { error: "not_allowed" }),
        evmSell: () => () => (ran.push("sell"), { error: "not_allowed" }),
      },
    });
    for (const ask of [SELL, { ...SELL, amount: 0n, shareBps: 2_500 }] as Ask[]) {
      assert.deepEqual(t.flow({ ...ask, chain }, ctx), { error: "not_allowed" }, `${chain}: ${ask.kind} refused`);
    }
    assert.deepEqual(ran, [], `${chain}: no sale runner reached`);
    assert.deepEqual(r.calls, [], `${chain}: the refused sale reads nothing`);
    t.flow({ ...BUY, chain }, ctx);
    assert.deepEqual(ran, ["buy"], `${chain}: the buy reaches its runner`);
    t.flow({ ...DEPOSIT, chain }, ctx);
    t.depositFrom({ chain, token: null, amount: "0.001", slippage_bps: 0 }, { s: "1", i: 0, u: "x" } as never, ctx);
    assert.deepEqual(ran.slice(1), [`deposit ${chain}`, `deposit ${chain}`], `${chain}: the deposit and the deposit from U reach the deposit runner`);
    t.flow({ ...WITHDRAW, chain }, ctx);
    assert.deepEqual(withdrawn, [chain], `${chain}: the withdraw form is opened`);
    await t.signedOut();
  }
});

test("on SIGN_HOST's build a state read follows a Base and a Robinhood buy left pending, and no sale left open", async () => {
  const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
  const { EVM_OPEN_SELLS_KEY } = await import("../src/pool-sell-evm.ts");
  for (const chain of ["base", "robinhood"] as const)
  for (const left of ["buy", "sale"] as const) {
    const pin = EVM_POOLS[chain]!;
    const from = pin.fromBlock.toString();
    const w = await openWalletStore({ indexedDB: new IDBFactory() });
    stores.push(w);
    await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
    const W = "0x" + "4b".repeat(20);
    const buy = { nullifier: "123", from, deadlineMs: String(Date.now() + 60_000), minOut: "1", value: "1000", feeCap: "1", feeRecipient: pin.feeRecipient.toLowerCase() };
    if (left === "buy") await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W]: { mint: TOKEN.toLowerCase(), decimals: 6, chain, state: "pending", route: { venue: "uniswap-v3", adapter: "0x" + "22".repeat(20), path: { venue: "uniswap-v3", tokens: [], fees: [] } }, buy } }));
    if (left === "sale") await w.update("meta", EVM_OPEN_SELLS_KEY, () => ({ n1: { note: "n1", chain, w: W, token: TOKEN.toLowerCase(), amount: "1", precommitment: "7", nonce: "0", deadline: String(Math.floor(Date.now() / 1000) + 300), from, least: "1" } }));
    const asked: string[] = [];
    const head = (url: string): EvmRpc => Object.assign(async (method: string) => {
      asked.push(method);
      if (method === "eth_blockNumber") return "0x" + (pin.fromBlock + 1_000n).toString(16);
      throw new Error(`unmocked ${method}`);
    }, { url });
    const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED.slice() }, {
      evmRpcs: (c) => (c === chain ? [head("https://a.example"), head("https://b.example")] : null),
      evmSync: () => ({ events: async () => ({ events: [], fin: { number: 0n } }) as never }),
    });
    await t.stateRead();
    await new Promise((ok) => setTimeout(ok, 50));
    const heads = asked.filter((m) => m === "eth_blockNumber").length;
    if (left === "buy") assert.ok(heads >= 2, `${chain}: the buy's follow reads both RPCs' heads (${heads})`);
    else assert.equal(heads, 0, `${chain}: no sale follow reads either RPC's head`);
    await t.signedOut();
  }
});

test("on SIGN_HOST's build a chain whose pool list is not exactly two providers shows no positions and reads nothing for them", async () => {
  const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const { noteCommitment, noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
  const { evmPoolScopeOf, EVM_CHAIN_IDS } = await import("../../wallet/src/pool/evm.ts");
  const { vaultLabelOf } = await import("../../kit/src/vault/shapes.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const pin = EVM_POOLS.base!;
  const scope = evmPoolScopeOf(pin.pool.toLowerCase(), EVM_CHAIN_IDS.base);
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  stores.push(w);
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const ref = { kind: "deposit" as const, s: scope, i: 0 };
  const l = vaultLabelOf(keccak_256, scope, 1n);
  const pre = noteSecrets(SEED, ref).precommitment;
  const n = await ns.add({ ref, scope, precommitment: pre, state: "UNSPENT", leaf: { value: 10n ** 15n, label: l, commitment: noteCommitment(10n ** 15n, l, pre), leafIndex: 0n } });
  await ns.move(n.id, "UNSPENT", "SPENT");
  ns.close();
  // W's filled buy, as the positions pass reads it (its record names the token)
  const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
  const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
  const { jOf } = await import("../../wallet/src/pool/queue.ts");
  const k = freshWallet(SEED, "evm", l, jOf(ref));
  k.secretKey.fill(0);
  const W = k.address.toLowerCase();
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W]: { mint: TOKEN.toLowerCase(), decimals: 6, chain: "base", state: "filled", received: "1", route: { venue: "uniswap-v3", adapter: "0x" + "ad".repeat(20), path: { kind: "v3", fee: 500 }, tx: "0x" + "11".repeat(32), block: "90" } } }));
  const asked: string[] = [];
  const any = (url: string): EvmRpc => Object.assign(async (method: string) => (asked.push(`${url} ${method}`), method === "eth_blockNumber" ? "0x64" : { number: "0x64", hash: "0x" + "4b".repeat(32) }), { url });
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => (fetched.push(String(input instanceof Request ? input.url : input)), new Response("{}", { status: 429 }))) as typeof fetch;
  try {
    for (const list of [[any("https://a.example")], [any("https://a.example"), any("https://b.example"), any("https://c.example")]]) {
      const timers: (() => void)[] = [];
      const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED.slice() }, {
        evmRpcs: (chain) => (chain === "base" ? list : null),
        evmSync: () => ({ events: async () => ({ events: [], fin: { number: 0n } }) as never }),
        positions: { setTimer: (f: () => void) => (timers.push(f), f), clearTimer: () => {} },
      });
      for (let i = 0; i < 10; i++) {
        assert.deepEqual(((await t.positions()) ?? []).filter((p) => p.chain === "base"), [], `${list.length} providers: no row`);
        for (const f of timers.splice(0)) f();
        await new Promise((ok) => setTimeout(ok, 10));
      }
      assert.deepEqual([...asked, ...fetched].filter((x) => !x.endsWith("eth_getLogs")), [], `${list.length} providers: no positions read`);
      await t.signedOut();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The page's own wiring (review of df88c194: the mutant `rpcs: e.passRpcs` for `...pageEvmPassReads(chain, e.passRpcs)`
// in the positions pass names every W to the public pair, and no lower-level test sees it). Three Ws of one device on
// Base: W1 and W2 bought TOKEN, W3 another token. The public pair answers the chain; the helper's route (POST
// TRADE_HELPER/v1/rpc/base, through a stubbed fetch) answers four times W1's and W2's amounts.
test("on SIGN_HOST's build the page's positions name Ws only to the helper, a share sale is refused and names none, and a helper 429 keeps the last amounts", async () => {
  const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
  const { TRADE_HELPER } = await import("../src/trade.ts");
  const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const { noteCommitment, noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
  const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
  const { jOf } = await import("../../wallet/src/pool/queue.ts");
  const { evmPoolScopeOf, EVM_CHAIN_IDS } = await import("../../wallet/src/pool/evm.ts");
  const { vaultLabelOf } = await import("../../kit/src/vault/shapes.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const OTHER = "0x" + "0e".repeat(20);
  const pin = EVM_POOLS.base!;
  const scope = evmPoolScopeOf(pin.pool.toLowerCase(), EVM_CHAIN_IDS.base);
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  stores.push(w);
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const ws: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ref = { kind: "deposit" as const, s: scope, i };
    const l = vaultLabelOf(keccak_256, scope, BigInt(i + 1));
    const pre = noteSecrets(SEED, ref).precommitment;
    const n = await ns.add({ ref, scope, precommitment: pre, state: "UNSPENT", leaf: { value: 10n ** 15n, label: l, commitment: noteCommitment(10n ** 15n, l, pre), leafIndex: BigInt(i) } });
    await ns.move(n.id, "UNSPENT", "SPENT");
    const k = freshWallet(SEED, "evm", l, jOf(ref));
    k.secretKey.fill(0);
    ws.push(k.address.toLowerCase());
  }
  ns.close();
  const [W1, W2, W3] = ws as [string, string, string];
  const rec = (mint: string) => ({ mint: mint.toLowerCase(), decimals: 6, chain: "base", state: "filled", received: "1", route: { venue: "uniswap-v3", adapter: "0x" + "ad".repeat(20), path: { kind: "v3", fee: 500 }, tx: "0x" + "11".repeat(32), block: "90" } });
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W1]: rec(TOKEN), [W2]: rec(TOKEN), [W3]: rec(OTHER) }));
  // the chain: W1 1.0 TOKEN, W2 3.0 TOKEN, W3 5.0 OTHER (6 decimals), at block 100
  const chainHeld = new Map([[`${W1} ${TOKEN.toLowerCase()}`, 1_000_000n], [`${W2} ${TOKEN.toLowerCase()}`, 3_000_000n], [`${W3} ${OTHER}`, 5_000_000n]]);
  const helperHeld = new Map([...chainHeld].map(([k, v]) => [k, k.endsWith(OTHER) ? v : v * 4n]));
  const named = (params: readonly unknown[]) => ws.filter((x) => JSON.stringify(params).toLowerCase().includes(x.slice(2)));
  let phase = "positions";
  const publicNamed: { phase: string; w: string; to: string }[] = [];
  const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  const pub = (url: string): EvmRpc => Object.assign(async (method: string, params: readonly unknown[]) => {
    const c = params[0] as { to?: string; data?: string } | undefined;
    for (const x of named(params)) publicNamed.push({ phase, w: x, to: String(c?.to).toLowerCase() });
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: "0x" + "4b".repeat(32), timestamp: "0x1", baseFeePerGas: "0xf4240" };
    if (method === "eth_call" && c?.data === "0x313ce567") return word(6n);
    if (method === "eth_call" && c?.data?.startsWith("0x70a08231")) return word(chainHeld.get(`0x${c.data.slice(-40)} ${String(c.to).toLowerCase()}`) ?? 0n);
    throw new Error(`unmocked ${method}`);
  }, { url });
  const pair = [pub("https://a.example"), pub("https://b.example")] as const;
  // the helper's route, through fetch: a lying helper, then a 429
  let helperDown = false;
  let throttled = 0;
  const helperNamed: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${TRADE_HELPER}/v1/rpc/base`)) throw new Error(`no fetch of ${url}`);
    if (helperDown) return (throttled++, new Response("{}", { status: 429 }));
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] } | { id: unknown; method: string; params: unknown[] }[];
    const one = (q: { id: unknown; method: string; params: unknown[] }) => {
      helperNamed.push(...named(q.params));
      const c = q.params[0] as { to?: string; data?: string } | undefined;
      const result =
        q.method === "eth_getBlockByNumber" ? { number: "0x64", hash: "0x" + "4b".repeat(32) }
        : q.method === "eth_call" && c?.data?.startsWith("0x70a08231") ? word(helperHeld.get(`0x${c.data.slice(-40)} ${String(c.to).toLowerCase()}`) ?? 0n)
        : q.method === "eth_call" && c?.data === "0x313ce567" ? word(6n)
        : q.method === "eth_blockNumber" ? "0x64"
        : null;
      return { jsonrpc: "2.0", id: q.id, result };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const timers: (() => void)[] = [];
    let sold = 0;
    const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED.slice() }, {
      evmRpcs: (chain) => (chain === "base" ? pair : null),
      evmSync: () => ({ events: async () => assert.fail("no sync read") }),
      positions: { setTimer: (f: () => void) => (timers.push(f), f), clearTimer: () => {} },
      tradeKinds: {
        evmSell: () => () => (sold++, { error: "not_allowed" }),
      },
    });
    const rowsOf = async () => ((await t.positions()) ?? []).filter((p) => p.chain === "base").map((p) => `${p.token.toLowerCase()} ${p.amount}`).sort();
    let rows: string[] = [];
    // the helper's route is paced (one queue for the holdings readers): its reads come a little apart
    for (let i = 0; i < 200 && rows.length < 2; i++) {
      rows = await rowsOf();
      for (const f of timers.splice(0)) f();
      await new Promise((ok) => setTimeout(ok, 25));
    }
    // the helper's (lying) amounts are what the rows show: they are display, never signed on
    assert.deepEqual(rows, [`${OTHER} 5`, `${TOKEN.toLowerCase()} 16`], "the rows are the helper's reads (in whole tokens)");
    // (a) the positions named every W to the helper, none to the public pair
    assert.deepEqual([...new Set(helperNamed)].sort(), [...ws].sort());
    assert.equal(publicNamed.length, 0, `the positions named no W to a public provider: ${JSON.stringify(publicNamed)}`);
    // a share sale: refused on this build before any read (the sale reaches no runner, names no W anywhere)
    phase = "sale";
    const before = helperNamed.length;
    assert.deepEqual(t.flow({ ...SELL, amount: 0n, shareBps: 2_500 }, ctx), { error: "not_allowed" });
    assert.equal(sold, 0);
    assert.equal(helperNamed.length, before, "the refused sale named no W to the helper");
    assert.deepEqual(publicNamed, [], "the refused sale named no W to a public provider");
    // (c) a helper 429: the next passes keep the last amounts (no row lost, never a failure)
    helperDown = true;
    t.evmHoldingsRestored("base");
    for (let i = 0; i < 20; i++) {
      for (const f of timers.splice(0)) f();
      await new Promise((ok) => setTimeout(ok, 5));
      assert.deepEqual(await rowsOf(), rows, `pass ${i}: the last amounts kept`);
    }
    assert.ok(throttled > 0, "the passes met the helper's 429");
    assert.deepEqual(publicNamed, [], "a helper 429 never sends a W's read to a public provider");
    await t.signedOut();
  } finally {
    globalThis.fetch = realFetch;
  }
});
