// The testnet build's restore of EVM buy records (card signpage-evm-pool-sell, src/pool-restore.ts with
// src/pool-sell-evm.ts restoreEvmHoldings): a wiped browser's restore writes each EVM buy's record again, its route read
// from the buy's own transaction on the pool's two RPCs, so the restored W sells on the route its buy took, and a W
// written tells the page its chain (holdingsWritten), which reads that chain's positions again with no reload (card
// signpage-positions-evm: these lines came in at its merge of 534c703a, and are its own). Its own
// file: the network is read once, at import, so this process runs as the testnet build does
// (test/pool-restore.test.ts runs the mainnet one, which writes none).
//   node --test test/pool-restore-evm-holdings.test.ts      (from packages/signpage)
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { openWalletStore } from "@blindfill/wallet/store";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { poolRestore } = await import("../src/pool-restore.ts");
const { evmPoolVenues, pinnedBuild } = await import("../../kit/src/trade/evm/buy-unpinned.ts");
const { BOUGHT, TOKEN } = await import("../../kit/test/evm-sell-quote-fx.ts");
const { evmBuyCalldata } = await import("../src/evm-send.ts");
const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { EVM_POOL_EVENTS } = await import("../../wallet/src/pool/evm.ts");
type Host = Parameters<typeof poolRestore>[0];

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
const V = evmPoolVenues()["base-sepolia"]!;
const POOL = V.pool!.toLowerCase();
const W = "0x00000000000000000000000000000000000000aa";
const TX = "0x" + "b0".repeat(32);
const BH = "0x" + "cd".repeat(32);
const w32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const T_BOUGHT = "0x" + Buffer.from(keccak_256(new TextEncoder().encode(EVM_POOL_EVENTS.Bought))).toString("hex");

test("restore: an EVM buy's record is written again from its own transaction, the route the buy took; a read that fails writes none; a W with a route keeps it; a written one reads its chain's positions again (card signpage-positions-evm)", async () => {
  const built = pinnedBuild(evmPoolVenues(), "base-sepolia", V.adapters!.v4!, BOUGHT as never, 5n, TOKEN, true);
  const relay = { recipient: W, feeRecipient: "0x0000000000000000000000000000000000000fee", feeCap: 1n, deadlineMs: 1n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16) };
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const input = "0x" + Buffer.from(evmBuyCalldata(POOL, relay as never, proof as never, ["1", "2", "3", "4", "5", "6", "7", "8"] as never, 1n, built, new Uint8Array(65))).toString("hex");
  const asked: string[] = [];
  const rpc = (down: boolean) => async (method: string, params: readonly unknown[]): Promise<unknown> => {
    asked.push(JSON.stringify(params).toLowerCase());
    if (down) throw new Error("HTTP 503");
    if (method === "eth_getLogs") return [{ address: POOL, topics: [T_BOUGHT, w32(BigInt(W))], data: "0x", blockNumber: "0x100", blockHash: BH, logIndex: "0x3", transactionHash: TX, transactionIndex: "0x0", removed: false }];
    if (method === "eth_getBlockByNumber") return { hash: BH, transactions: [{ hash: TX, to: POOL, input }] };
    if (method === "eth_call") return w32(18n);
    throw new Error(`no ${method}`);
  };
  const ROUTE = { venue: "uniswap-v4", adapter: V.adapters!.v4!.toLowerCase(), path: BOUGHT, tx: TX, block: "256" };
  for (const [what, down, had] of [
    ["read", false, undefined],
    ["down", true, undefined],
    ["kept", false, { mint: TOKEN, decimals: 18, chain: "base", state: "filled", route: { ...ROUTE, tx: "0x" + "11".repeat(32) } }],
  ] as const) {
    const store = await openWalletStore({ name: `evm-holdings-${what}`, indexedDB: new IDBFactory() });
    closers.push(() => store.close());
    if (had) await store.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W]: had }));
    const ends: string[] = [];
    const told: string[] = [];
    const spends = [{ l: 202n, j: 0, note: "n", w: W, withdrawn: 1n, block: 0x100n, token: TOKEN, blockHash: BH, logIndex: 3n }];
    const host: Host = {
      store: async () => store,
      seed64: async () => new Uint8Array(64).fill(7),
      signedIn: async () => true,
      pools: () => [{ chain: "evm", pin: { network: "base-sepolia", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }, scope: 22n, rpcs: () => [rpc(down), rpc(down)] }],
      ids: null,
      ended: (stage, why) => void ends.push(`${stage} ${why.join(",")}`),
      holdingsWritten: (chain) => void told.push(chain),
      step5: () => {},
      pausesMs: [],
      solana: (async () => ({ notes: [], spends: [] })) as never,
      evm: (async () => ({ notes: [], spends, elsewhere: [], wallets: [], block: 1n })) as never,
    };
    const r = poolRestore(host);
    // the testnet build's restore ends "stalled" by its own rule (no deposit id reads on a testnet pool's chain); the
    // notes and the buy records are written before that end
    await r.auto();
    assert.ok(ends.every((e) => e.startsWith("done") || e.includes("reads no deposit id")), `${what}: ${ends.join(" | ")}`);
    await r.idle();
    const rec = (await store.get("meta", EVM_POSITION_COSTS_KEY)) as Record<string, unknown> | undefined;
    if (what === "read") assert.deepEqual(rec?.[W], { mint: TOKEN, decimals: 18, chain: "base", state: "filled", route: ROUTE }, "the restored route is the one the buy stored");
    if (what === "down") assert.equal(rec, undefined, "a read that fails writes no record: the W is not sold until a later restore reads it");
    if (what === "kept") assert.deepEqual(rec?.[W], had, "a record with a route is never replaced");
    assert.deepEqual(told, what === "read" ? ["base"] : [], `${what}: the chain's positions read again once its records are written, with no reload`);
  }
  assert.ok(asked.every((a) => !a.includes(W.slice(2)) && !a.includes(TX.slice(2))), "no read names W or the transaction");
});

// card restore-first-sign-in-under-two-minutes's rule holds for the buy records' reads too: a sign out while one is in
// flight ends the run at once though the read never answers, and nothing is read after it
test("restore: a sign out while a buy record's read is in flight ends the run at once, nothing read after", { timeout: 5_000 }, async () => {
  const store = await openWalletStore({ name: "evm-holdings-sign-out", indexedDB: new IDBFactory() });
  closers.push(() => store.close());
  let r: ReturnType<typeof poolRestore> | null = null;
  const asked: string[] = [];
  // two providers whose reads never answer and never look at a signal (a fetch in flight)
  const hang = () => async (method: string): Promise<unknown> => {
    asked.push(method);
    if (asked.length === 1) setTimeout(() => r!.signedOut(), 20);
    return new Promise(() => {});
  };
  const spends = [{ l: 202n, j: 0, note: "n", w: W, withdrawn: 1n, block: 0x100n, token: TOKEN, blockHash: BH, logIndex: 3n }];
  const host: Host = {
    store: async () => store,
    seed64: async () => new Uint8Array(64).fill(7),
    signedIn: async () => true,
    pools: () => [{ chain: "evm", pin: { network: "base-sepolia", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }, scope: 22n, rpcs: () => [hang(), hang()] }],
    ids: null,
    ended: () => {},
    step5: () => {},
    pausesMs: [],
    solana: (async () => ({ notes: [], spends: [] })) as never,
    evm: (async () => ({ notes: [], spends, elsewhere: [], wallets: [], block: 1n })) as never,
  };
  r = poolRestore(host);
  await r.auto().catch(() => null).then(() => r!.idle());
  assert.ok(asked.length > 0, "a buy record's read was in flight");
  const at = asked.length;
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(asked.length, at, "no read after it");
  assert.equal(await store.get("meta", EVM_POSITION_COSTS_KEY), undefined, "no record written");
});
