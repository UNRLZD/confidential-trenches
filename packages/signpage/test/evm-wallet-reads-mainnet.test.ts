// A mainnet W's balance on Base and Robinhood (decision M359, card evm-pools-on-mainnet): its positions and a sale's
// finding read each W on the helper's route alone (src/pool-testnet.ts pageEvmWalletRpc), never on the pool RPCs a device
// reaches itself; one request names one W; the answers equal the testnet reader's (each W on the pool's two RPCs) on
// the same recorded chain answers; and what a holding of 1, 3 and 8 Ws costs the helper's route per pass. Every chain is
// a fake one; nothing here reaches a network.
//   node --test test/evm-wallet-reads-mainnet.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { openWalletStore } from "@blindfill/wallet/store";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { evmPoolScopeOf, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { HOLDINGS_RPC_LIMIT } from "../../wallet/src/pool/buy-wallets.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPositionsPass } from "../src/positions-evm.ts";
import { passMemo } from "../src/positions.ts";
import { planEvmSell } from "../src/pool-sell-evm.ts";
import { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS, pageEvmWalletRpc } from "../src/pool-testnet.ts";
import { TRADE_HELPER } from "../src/trade.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const TOKEN = "0x" + "0c".repeat(20); // a made-up token address
const POOL = evmPoolVenues().base.pool!.toLowerCase();
const SCOPE = evmPoolScopeOf(POOL, BigInt(evmPoolVenues().base.chainId));
const HEAD = 100n;
const HASH = "0x" + "4b".repeat(32);
const hex = (n: bigint) => `0x${n.toString(16)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

/** The Ws of `n` buys of the pool: each a SPENT note's W_{evm, l, j}, as the queue's proof pays it. */
async function boughtWs(n: number): Promise<{ ws: string[]; store: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  const store = await openNoteStore(w);
  closers.push(() => store.close());
  const ws: string[] = [];
  for (let i = 0; i < n; i++) {
    const ref: NoteRef = { kind: "deposit", s: SCOPE, i };
    const l = vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1));
    const pre = noteSecrets(SEED, ref).precommitment;
    const note = await store.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10n ** 15n, label: l, commitment: noteCommitment(10n ** 15n, l, pre), leafIndex: BigInt(i) } });
    await store.move(note.id, "UNSPENT", "SPENT");
    const k = freshWallet(SEED, "evm", l, jOf(ref));
    k.secretKey.fill(0);
    ws.push(k.address.toLowerCase());
  }
  return { ws, store };
}
/** Each W's filled buy record (pool-buy-evm.ts EVM_POSITION_COSTS_KEY), its route and block. */
const records = (ws: readonly string[]) =>
  Object.fromEntries(ws.map((w) => [w, { mint: TOKEN, decimals: 6, chain: "base", state: "filled", route: { venue: "uniswap-v3", adapter: "0x" + "ad".repeat(20), path: { kind: "v3", fee: 500 }, tx: "0x" + "11".repeat(32), block: "90" } }]));
/** The recorded chain answers: W i holds (i + 1) x 1.5 tokens of 6 decimals at block HEAD (hash HASH); the last of 3 or
 *  more holds none (no row of its own). */
const held = (ws: readonly string[]) => new Map(ws.map((w, i) => [w, ws.length >= 3 && i === ws.length - 1 ? 0n : BigInt(i + 1) * 1_500_000n]));

type Call = { host: string; method: string; params: readonly unknown[] };
/** Every request of a read, by the host it went to. */
const calls: Call[] = [];
/** A pool RPC the device reaches itself, answering the recorded state: the testnet reader's pair. */
function publicRpc(host: string, bal: ReadonlyMap<string, bigint>): EvmRpc {
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ host, method, params });
      const c = params[0] as { data?: string } | undefined;
      if (method === "eth_blockNumber") return hex(HEAD);
      if (method === "eth_call" && c?.data === "0x313ce567") return word(6n);
      if (method === "eth_call" && c?.data?.startsWith("0x70a08231") && params[1] === hex(HEAD)) return word(bal.get(`0x${c.data.slice(-40)}`) ?? 0n);
      throw new Error(`no such read: ${method}`);
    },
    { url: host },
  ) as EvmRpc;
}
/** The helper's route, answering the same recorded state: one block, then each balance only at its hash. */
function helperRpc(bal: ReadonlyMap<string, bigint>): EvmRpc {
  const host = `${TRADE_HELPER}/v1/rpc/base`;
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ host, method, params });
      const c = params[0] as { data?: string } | undefined;
      if (method === "eth_getBlockByNumber" && params[0] === "latest") return { number: hex(HEAD), hash: HASH };
      if (method === "eth_call" && c?.data?.startsWith("0x70a08231") && (params[1] as { blockHash?: string })?.blockHash === HASH) return word(bal.get(`0x${c.data.slice(-40)}`) ?? 0n);
      throw new Error(`no such read: ${method}`);
    },
    { url: host },
  ) as EvmRpc;
}
const PUBLIC = MAINNET_POOL_RPCS.base;
/** The Ws a request names (its params, any case). */
const named = (c: Call, ws: readonly string[]): string[] => {
  const s = JSON.stringify(c.params).toLowerCase();
  return ws.filter((w) => s.includes(w.slice(2)));
};

async function positions(ws: readonly string[], mainnet: boolean) {
  const bal = held(ws);
  calls.length = 0;
  const rpcs = [publicRpc(PUBLIC[0]!, bal), publicRpc(PUBLIC[1]!, bal)] as const;
  const got = await evmPositionsPass(
    {
      chain: "base",
      rpcs,
      ...(mainnet ? { one: helperRpc(bal) } : {}),
      signal: new AbortController().signal,
      holdings: async () => records(ws),
      decimals: async (token, r) => {
        const [a, b] = await Promise.all(r.map((rpc) => rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])));
        assert.equal(a, b);
        return Number(BigInt(a as string));
      },
    },
    passMemo(),
  );
  return { got, calls: [...calls] };
}

test("SIGN_HOST's build reads a W on the helper's route only: never a pool RPC, a fee RPC or a history source the device reaches itself", () => {
  for (const chain of ["base", "robinhood"] as const) {
    const r = pageEvmWalletRpc(chain);
    assert.ok(r, `${chain}: a mainnet W reader`);
    assert.equal(r.url, `${TRADE_HELPER}/v1/rpc/${chain}`);
    for (const pub of [...MAINNET_POOL_RPCS[chain], ...MAINNET_EVM_FEE_RPCS[chain], ...MAINNET_POOL_HISTORY[chain]]) assert.notEqual(new URL(String(r.url)).host, new URL(pub).host);
  }
});

for (const n of [1, 3, 8]) {
  test(`positions of ${n} W${n > 1 ? "s" : ""} on mainnet: equal to the testnet reader's on the same chain answers; no W named to a public provider; one W a request; 1 + ${n} requests on the helper`, async () => {
    const { ws } = await boughtWs(n);
    const t = await positions(ws, false);
    const m = await positions(ws, true);
    assert.deepEqual(m.got, t.got);
    assert.equal(m.got.whole, true);
    assert.equal(m.got.positions.length, 1);
    // the testnet reader names each W to both public RPCs (why mainnet must not use it)
    assert.equal(t.calls.filter((c) => named(c, ws).length > 0).length, 2 * n);
    const helper = m.calls.filter((c) => c.host.startsWith(TRADE_HELPER));
    const pub = m.calls.filter((c) => !c.host.startsWith(TRADE_HELPER));
    for (const c of pub) assert.deepEqual(named(c, ws), [], `${c.host} ${c.method} names a W`);
    for (const c of m.calls) assert.ok(named(c, ws).length <= 1, `${c.host} ${c.method} names two Ws`);
    // the helper: one block, then one balanceOf per W at its hash; the public pair: the token's decimals only
    assert.equal(helper.length, 1 + n);
    assert.deepEqual(helper.map((c) => c.method), ["eth_getBlockByNumber", ...Array(n).fill("eth_call")]);
    assert.equal(pub.length, 2);
    assert.ok(pub.every((c) => (c.params[0] as { data?: string }).data === "0x313ce567"));
  });
}

test("a sale's finding on mainnet: the same plan as the testnet reader's on the same chain answers, every W read on the helper alone at one block's hash, one W a request", async () => {
  for (const n of [1, 3, 8]) {
    const { ws, store } = await boughtWs(n);
    const bal = held(ws);
    const recs = records(ws);
    const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: TOKEN, amount: n === 1 ? 1_000_000n : 4_000_000n, slippageBps: 100, decimals: 6 };
    const host = (mainnet: boolean) => ({
      chain: "base" as const,
      scope: SCOPE,
      rpcs: [publicRpc(PUBLIC[0]!, bal), publicRpc(PUBLIC[1]!, bal)] as const,
      ...(mainnet ? { finder: helperRpc(bal) } : {}),
      notes: async () => store,
      seed64: async () => SEED.slice(),
      holdings: async () => recs,
    });
    calls.length = 0;
    const t = await planEvmSell(host(false), ask);
    const tc = [...calls];
    calls.length = 0;
    const m = await planEvmSell(host(true), ask);
    const mc = [...calls];
    assert.deepEqual(m, t, `${n} Ws`);
    assert.equal(tc.filter((c) => named(c, ws).length > 0).length, 2 * n);
    for (const c of mc) {
      if (!c.host.startsWith(TRADE_HELPER)) assert.deepEqual(named(c, ws), [], `${c.host} ${c.method} names a W`);
      assert.ok(named(c, ws).length <= 1, `${c.method} names two Ws`);
    }
    assert.equal(mc.length, 1 + n);
    assert.ok(mc.every((c) => c.host.startsWith(TRADE_HELPER)));
  }
});

test("the helper's per-caller share holds a pass of 8 Ws: the device's own pace on the route asks at most 12 in any 10 s, under base's and robinhood's 30 (apps/helper/src/rpc/rpc.ts RPC_PAGE_NEED)", () => {
  // the route's queue (buy-wallets.ts HOLDINGS_RPC_LIMIT): `total` calls in any `windowMs`, the positions, a sale's
  // finding and a restore's W reads together
  const per10s = Math.ceil(10_000 / HOLDINGS_RPC_LIMIT.windowMs) * HOLDINGS_RPC_LIMIT.total;
  assert.ok(per10s <= 30, `${per10s} a 10 s window`);
  // a pass of 8 Ws is 9 requests, 8 of them eth_call at perMethod a window: done in ceil(8 / perMethod) windows
  const windows = Math.ceil(8 / HOLDINGS_RPC_LIMIT.perMethod!);
  assert.ok(windows * HOLDINGS_RPC_LIMIT.windowMs <= 12_000);
});
