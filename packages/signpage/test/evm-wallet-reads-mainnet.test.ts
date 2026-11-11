// A mainnet W's balance on Base and Robinhood (decision M359, card evm-pools-on-mainnet): its positions read each W on
// the helper's route alone (src/pool-testnet.ts pageEvmWalletRpc), never on the pool RPCs a device reaches itself, and
// equal the testnet reader's (each W on the pool's two RPCs) on the same recorded chain answers; a helper that lies, 429s
// or is out changes no kept amount; a sale's finding, which gates its signature, reads on the pool's two RPCs only, the
// Ws whose own buy record names the token, never the helper; one request names one W; and what a holding of 1, 3 and 8
// Ws costs the helper's route per pass. Every chain is
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
import { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS, pageEvmPassReads, pageEvmWalletRpc } from "../src/pool-testnet.ts";
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
/** The helper's route, answering the same recorded state: one block, then each balance only at its hash. `o.number`:
 *  the block number it names (a lying helper's); `o.down`: the error each call meets (a 429, an outage). */
function helperRpc(bal: ReadonlyMap<string, bigint>, o: { number?: bigint; down?: () => Error | null } = {}): EvmRpc {
  const host = `${TRADE_HELPER}/v1/rpc/base`;
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ host, method, params });
      const e = o.down?.();
      if (e) throw e;
      const c = params[0] as { data?: string } | undefined;
      if (method === "eth_getBlockByNumber" && params[0] === "latest") return { number: hex(o.number ?? HEAD), hash: HASH };
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

async function positions(ws: readonly string[], mainnet: boolean, o: { memo?: ReturnType<typeof passMemo>; helper?: EvmRpc; random?: (out: Uint32Array) => void } = {}) {
  const bal = held(ws);
  calls.length = 0;
  const rpcs = [publicRpc(PUBLIC[0]!, bal), publicRpc(PUBLIC[1]!, bal)] as const;
  const got = await evmPositionsPass(
    {
      chain: "base",
      rpcs,
      ...(mainnet ? { one: o.helper ?? helperRpc(bal) } : {}),
      ...(o.random ? { random: o.random } : {}),
      signal: new AbortController().signal,
      holdings: async () => records(ws),
      decimals: async (token, r) => {
        const [a, b] = await Promise.all(r.map((rpc) => rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])));
        assert.equal(a, b);
        return Number(BigInt(a as string));
      },
    },
    o.memo ?? passMemo(),
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
    // the helper: one block, then one balanceOf per W at its hash; the public pair: its heads and the token's decimals
    assert.equal(helper.length, 1 + n);
    assert.deepEqual(helper.map((c) => c.method), ["eth_getBlockByNumber", ...Array(n).fill("eth_call")]);
    assert.equal(pub.length, 4);
    assert.ok(pub.every((c) => c.method === "eth_blockNumber" || (c.params[0] as { data?: string }).data === "0x313ce567"));
  });
}

/** A sale's plan as the page's host gives it: the pool's two RPCs answering `pair`, and a helper route answering
 *  `helper` set where a page could still hand one (`finder`, `one`): a sale must never ask it. */
const planHost = (store: NoteStore, recs: Record<string, unknown>, pair: ReadonlyMap<string, bigint>, helper: ReadonlyMap<string, bigint>, random?: (out: Uint32Array) => void) => {
  const h = {
    chain: "base" as const,
    scope: SCOPE,
    rpcs: [publicRpc(PUBLIC[0]!, pair), publicRpc(PUBLIC[1]!, pair)] as const,
    finder: helperRpc(helper),
    one: helperRpc(helper),
    notes: async () => store,
    seed64: async () => SEED.slice(),
    holdings: async () => recs,
    ...(random ? { random } : {}),
  };
  return h;
};
const share = (bps: number): PoolAsk => ({ kind: "pool.sell", chain: "base", token: TOKEN, amount: 0n, slippageBps: 100, decimals: 6, shareBps: bps });
const OTHER_TOKEN = "0x" + "0d".repeat(20);

test("a sale's share is sized on the pool's two RPCs, never the helper's word: W holds 1,000, the helper says 4,000, a 25 % sale signs 250; no request of the sale goes to the helper", async () => {
  const { ws, store } = await boughtWs(1);
  calls.length = 0;
  const plan = await planEvmSell(planHost(store, records(ws), new Map([[ws[0]!, 1_000n]]), new Map([[ws[0]!, 4_000n]])), share(2_500));
  assert.equal(plan.total, 1_000n);
  assert.equal(plan.units, 250n);
  assert.deepEqual(plan.legs.map((l) => l.units), [250n]);
  assert.deepEqual(calls.filter((c) => c.host.startsWith(TRADE_HELPER)), []);
});

test("a W the helper hides is still sold on a 100 % sale (its own buy record names it); a W the helper invents never becomes a leg nor is named", async () => {
  const { ws, store } = await boughtWs(2);
  const invented = "0x" + "e1".repeat(20);
  calls.length = 0;
  const plan = await planEvmSell(planHost(store, records(ws), new Map([[ws[0]!, 1_000n], [ws[1]!, 500n]]), new Map([[ws[0]!, 1_000n], [ws[1]!, 0n], [invented, 9_000n]])), share(10_000));
  assert.equal(plan.units, 1_500n);
  assert.deepEqual(plan.legs.map((l) => l.w.w).sort(), [...ws].sort());
  assert.ok(calls.every((c) => named(c, [invented]).length === 0));
  assert.deepEqual(calls.filter((c) => c.host.startsWith(TRADE_HELPER)), []);
});

test("a sale names to the public pair only the Ws whose own buy record names the token sold, one W a request, at one agreed block, in the order the random source gives", async () => {
  // W0 and W2 bought the token, W1 another token, W3 has no record at all
  const { ws, store } = await boughtWs(4);
  const recs = { ...records([ws[0]!, ws[2]!]), [ws[1]!]: { ...records([ws[1]!])[ws[1]!], mint: OTHER_TOKEN } };
  const bal = new Map(ws.map((w) => [w, 700n]));
  calls.length = 0;
  // all zeros: Fisher-Yates swaps each place i (from the last) with place 0
  const plan = await planEvmSell(planHost(store, recs, bal, bal, (out) => out.fill(0)), share(10_000));
  assert.equal(plan.units, 1_400n);
  const balanceReads = calls.filter((c) => c.method === "eth_call");
  for (const c of calls) assert.ok(named(c, ws).length <= 1, `${c.method} names two Ws`);
  assert.deepEqual([...new Set(balanceReads.flatMap((c) => named(c, ws)))].sort(), [ws[0]!, ws[2]!].sort());
  assert.ok(balanceReads.every((c) => c.params[1] === hex(HEAD)));
  assert.deepEqual(calls.filter((c) => c.host.startsWith(TRADE_HELPER)), []);
  // the order the reads were asked in, on the first RPC, follows the random source: the identity draws (place i kept)
  // give the plan's own order, every draw 0 swaps place i (from the last) with place 0
  const asked = () => calls.filter((c) => c.method === "eth_call" && c.host === PUBLIC[0]).flatMap((c) => named(c, ws));
  const zeros = asked();
  calls.length = 0;
  await planEvmSell(planHost(store, recs, bal, bal, (out) => out.forEach((_, i) => (out[i] = i))), share(10_000));
  const want = asked();
  for (let i = want.length - 1; i > 0; i--) [want[i], want[0]] = [want[0]!, want[i]!];
  assert.equal(want.length, 2);
  assert.deepEqual(zeros, want);
});

test("positions on a helper 429 or outage: the pass keeps the last kept amounts, waits (not whole, so it runs again), never asks a public provider for a W", async () => {
  const { ws } = await boughtWs(3);
  const memo = passMemo();
  const first = await positions(ws, true, { memo });
  assert.equal(first.got.whole, true);
  for (const down of [() => Object.assign(new Error("HTTP 429"), { status: 429 }), () => new Error("the helper did not answer")]) {
    const m = await positions(ws, true, { memo, helper: helperRpc(held(ws), { down }) });
    assert.equal(m.got.whole, false);
    assert.deepEqual(m.got.positions, first.got.positions);
    for (const c of m.calls.filter((c) => !c.host.startsWith(TRADE_HELPER))) assert.deepEqual(named(c, ws), [], `${c.host} ${c.method} names a W`);
  }
  // the helper back: whole again, the same rows
  const back = await positions(ws, true, { memo });
  assert.equal(back.got.whole, true);
  assert.deepEqual(back.got.positions, first.got.positions);
});

test("a helper naming a block far ahead never freezes positions: the floor is the lower of its block and the pool pair's heads", async () => {
  const { ws } = await boughtWs(2);
  const memo = passMemo();
  const lied = await positions(ws, true, { memo, helper: helperRpc(held(ws), { number: 10n ** 9n }) });
  assert.equal(lied.got.whole, true);
  const next = await positions(ws, true, { memo });
  assert.equal(next.got.whole, true);
  assert.deepEqual(next.got.positions, lied.got.positions);
});

test("positions name the Ws to the helper in the order the random source gives", async () => {
  const { ws } = await boughtWs(8);
  const m = await positions(ws, true, { random: (out) => out.fill(0) });
  // Fisher-Yates with every draw 0: place i (from the last) swapped with place 0
  const want = [...ws];
  for (let i = want.length - 1; i > 0; i--) [want[i], want[0]] = [want[0]!, want[i]!];
  assert.deepEqual(m.calls.filter((c) => c.host.startsWith(TRADE_HELPER) && c.method === "eth_call").flatMap((c) => named(c, ws)), want);
});

test("the page's pass readers: on SIGN_HOST's build the pool pair and the helper's route as `one`; on the testnet build no helper route is made", () => {
  const pair = [publicRpc(PUBLIC[0]!, new Map()), publicRpc(PUBLIC[1]!, new Map())] as const;
  for (const chain of ["base", "robinhood"] as const) {
    const main = pageEvmPassReads(chain, pair);
    assert.equal(main.rpcs, pair);
    assert.equal(main.one, pageEvmWalletRpc(chain));
    assert.equal(main.one?.url, `${TRADE_HELPER}/v1/rpc/${chain}`);
    const test = pageEvmPassReads(chain, pair, true);
    assert.deepEqual(Object.keys(test), ["rpcs"]);
    assert.equal(pageEvmWalletRpc(chain, true), undefined);
  }
});

test("the helper's per-caller share holds a pass of 8 Ws: the device's own pace on the route asks at most 12 in any 10 s, under base's and robinhood's 30 (apps/helper/src/rpc/rpc.ts RPC_PAGE_NEED)", () => {
  // the route's queue (buy-wallets.ts HOLDINGS_RPC_LIMIT): `total` calls in any `windowMs`, the positions and a
  // restore's W reads together (a sale reads no W on the helper)
  const per10s = Math.ceil(10_000 / HOLDINGS_RPC_LIMIT.windowMs) * HOLDINGS_RPC_LIMIT.total;
  assert.ok(per10s <= 30, `${per10s} a 10 s window`);
  // a pass of 8 Ws is 9 requests, 8 of them eth_call at perMethod a window: done in ceil(8 / perMethod) windows
  const windows = Math.ceil(8 / HOLDINGS_RPC_LIMIT.perMethod!);
  assert.ok(windows * HOLDINGS_RPC_LIMIT.windowMs <= 12_000);
});
