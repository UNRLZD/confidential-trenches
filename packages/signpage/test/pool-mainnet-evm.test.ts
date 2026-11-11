// SIGN_HOST's build on Base and Robinhood (card evm-pools-on-mainnet): the wallet's mainnet EVM pins (EVM_POOLS.base,
// EVM_POOLS.robinhood) turn on pool.deposit, pool.buy and pool.sell there, on those pins, and the page's USD price pair
// (the pool list's two seats). A sale's finding reads, on the pool's two RPCs, only the Ws whose own buy record names
// the token sold (planEvmSell). The chains' positions stay closed until the helper-route reader of a W's holdings lands
// (card evm-pools-on-mainnet-reader): they read every W of the device on the pool's public RPCs, so a public provider
// would see one device's Ws together.
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

test("a Base and a Robinhood pool.deposit reach the EVM deposit runner on the mainnet pin (an empty U answered not_funded)", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const r = rpcs();
    const pins: unknown[] = [];
    const flow = testnetPool(page(), { evmRpcs: () => r.pair, evmRound: (p) => (pins.push(p), async () => ({ events: [], finalBlock: 100n })) }).flow;
    const run = flow({ ...DEPOSIT, chain }, ctx) as { running: true; after: Promise<void>; answer(): unknown };
    assert.equal(run.running, true, `${chain}: a run of the runner`);
    await run.after;
    assert.deepEqual(run.answer(), { error: "not_funded" });
    assert.ok(pins.length > 0 && pins.every((p) => p === EVM_POOLS[chain]), `${chain}: the run's pool is EVM_POOLS.${chain}`);
    assert.ok(r.calls.includes("eth_getBalance"), `${chain}: U read`);
  }
});

test("a Base and a Robinhood pool.buy and pool.sell reach the EVM buy and sell on the mainnet pin", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const r = rpcs();
    const bought: string[] = [];
    let sold = 0;
    const t = testnetPool(page(), {
      evmRpcs: () => r.pair,
      evmSync: () => ({ events: async () => assert.fail("no sync read") }),
      tradeKinds: {
        evmBuy: (host) => () => {
          const h = host();
          bought.push(`${h.chain} ${h.pin.network} ${h.pin.pool}`);
          h.end?.();
          return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
        },
        evmSell: (host) => () => {
          const h = host();
          sold++;
          assert.equal(h.pin, EVM_POOLS[chain], `${chain}: the sale's pool is the mainnet pin`);
          return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
        },
      },
    });
    const got = t.flow({ ...BUY, chain }, ctx);
    assert.ok("after" in got, `${chain}: the buy runs`);
    await got.after;
    assert.deepEqual(bought, [`${chain} ${chain} ${EVM_POOLS[chain]!.pool}`], `${chain}: on the mainnet pin`);
    const sale = t.flow({ ...SELL, chain }, ctx);
    assert.ok("after" in sale, `${chain}: the sell runs`);
    await sale.after;
    assert.equal(sold, 1, `${chain}: the EVM sell ran`);
    await t.signedOut();
  }
});

test("the mainnet positions read no W: with a filled buy record on each chain, their passes run and the pool's RPCs are asked nothing", async () => {
  const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  stores.push(w);
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const rec = (chain: string) => ({ mint: TOKEN.toLowerCase(), decimals: 6, chain, state: "filled", received: "999000000", route: { venue: "uniswap-v3", adapter: "0x" + "ad".repeat(20), path: { kind: "v3", fee: 500 }, tx: "0x" + "11".repeat(32), block: "90" } });
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ ["0x" + "a1".repeat(20)]: rec("base"), ["0x" + "a2".repeat(20)]: rec("robinhood") }));
  const r = rpcs();
  const timers: (() => void)[] = [];
  const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED.slice() }, {
    evmRpcs: () => r.pair,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    positions: { setTimer: (f: () => void) => (timers.push(f), f), clearTimer: () => {} },
  });
  for (let i = 0; i < 20; i++) {
    const rows = (await t.positions()) ?? [];
    assert.deepEqual(rows.filter((p) => p.chain !== "solana"), [], "no Base or Robinhood row");
    for (const f of timers.splice(0)) f();
    await new Promise((ok) => setTimeout(ok, 1));
  }
  assert.deepEqual(r.calls, [], "no read of a W on a public provider");
  await t.signedOut();
});
