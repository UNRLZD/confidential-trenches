// state.positions on Base and Robinhood (card signpage-positions-evm, src/positions-evm.ts): each filled buy record's W
// read on the pool's two RPCs, the two the same, never a number from the record alone; a pending record never shown;
// two RPCs that disagree show no position, never a wrong one; the requests per RPC per pass bounded; and on the page,
// the three chains' passes staggered, a buy's or a sell's end reading the chain again, a sign out reading nothing more.
// The page's answer with a Base position is recorded for the terminal's Sell test (apps/terminal/test/sell-live-evm.test.ts).
//   node --test test/positions-evm.test.ts
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import type { EvmPositionsReads } from "../src/positions-evm.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
// loaded after the network is set (a static import would load the wallet's network module first, as mainnet)
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { PAGE_POOLS, withPools } = await import("../src/pools.ts");
const { EVM_POSITIONS_STAGGER_MS, evmPositionsPass, staggered } = await import("../src/positions-evm.ts");
const { passMemo, withPositions } = await import("../src/positions.ts");
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const W1 = "0x" + "a1".repeat(20);
const W2 = "0x" + "A2".repeat(20); // a record keyed in upper case: read in lower case
const TOKEN = "0x" + "0c".repeat(20); // a token of 6 decimals (a made-up address: no secret scan reads it as a key)
const OTHER = "0x" + "77".repeat(20);
const CHAINS = ["base", "robinhood"] as const;
const PINS: Record<(typeof CHAINS)[number], EvmPoolPin> = {
  base: Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
  robinhood: Object.freeze({ network: "robinhood-testnet", pool: "0x00000000000000000000000000000000000F0022", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
};
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const word = (n: bigint | number) => `0x${n.toString(16).padStart(64, "0")}`;
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (f: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await f()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await f());
};

/** W's buy record as the buy's read-back (filled) or the run before its send (pending) writes it; its `decimals` the
 *  buy's own, which the pass never takes alone. */
const rec = (chain: string, state: "pending" | "filled" | "withdrawn", mint = TOKEN, decimals = 6) => ({
  mint,
  decimals,
  chain,
  state,
  route: { venue: "uniswap-v3", adapter: "0x" + "ad".repeat(20), path: { kind: "v3", fee: 500 }, ...(state === "filled" ? { tx: "0x" + "11".repeat(32), block: "120" } : {}) },
  ...(state === "filled" ? { received: "999000000" } : {}),
  ...(state === "pending" ? { buy: { nullifier: "1", from: "100", deadlineMs: "1", minOut: "1", value: "1", feeCap: "1", feeRecipient: "0x0" } } : {}),
});

/** Two RPCs of one chain: each its own balances (by W, lower case), newest block, decimals and failure; every call kept. */
function fakeChain() {
  const bal = [new Map<string, bigint>(), new Map<string, bigint>()];
  const head = [100n, 101n];
  const decimals = [6, 6];
  const down = [false, false];
  const calls: { method: string; data?: string; at?: unknown }[][] = [[], []];
  const rpc = (i: 0 | 1): EvmRpc =>
    Object.assign(
      async (method: string, params: readonly unknown[]) => {
        const c = params[0] as { to?: string; data?: string } | undefined;
        calls[i].push({ method, ...(c?.data ? { data: c.data, at: params[1] } : {}) });
        if (down[i]) throw new Error("the RPC did not answer");
        if (method === "eth_blockNumber") return hex(head[i]!);
        if (method === "eth_call" && c?.data === "0x313ce567") return word(decimals[i]!);
        if (method === "eth_call" && c?.data?.startsWith("0x70a08231")) return word(bal[i]!.get(`0x${c.data.slice(-40)}`) ?? 0n);
        throw new Error(`no such read: ${method}`);
      },
      { url: i === 0 ? "https://a.example" : "https://b.example" },
    );
  const set = (w: string, a: bigint, b = a) => (bal[0].set(w.toLowerCase(), a), bal[1].set(w.toLowerCase(), b));
  return { rpcs: [rpc(0), rpc(1)] as const, bal, head, decimals, down, calls, set };
}

/** The pass's reads over `c` with `records` as the store holds them; decimals on both RPCs, the same, else thrown. */
const reads = (chain: "base" | "robinhood", c: ReturnType<typeof fakeChain>, records: Record<string, unknown>): EvmPositionsReads => ({
  chain,
  rpcs: c.rpcs,
  signal: new AbortController().signal,
  holdings: async () => records,
  decimals: async (token) => {
    const [a, b] = await Promise.all(c.rpcs.map(async (rpc) => Number(BigInt((await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])) as string))));
    if (a !== b) throw new Error("decimals differ");
    return a!;
  },
});
const per = (c: ReturnType<typeof fakeChain>, i: 0 | 1) => {
  const n: Record<string, number> = {};
  for (const x of c.calls[i]!) {
    const k = x.method === "eth_call" ? (x.data === "0x313ce567" ? "decimals" : "balanceOf") : x.method;
    n[k] = (n[k] ?? 0) + 1;
  }
  return n;
};

for (const chain of CHAINS) {
  test(`(${chain}) held: each filled W's balanceOf on both RPCs at the lower newest block, summed; the chain's decimals, never the record's; another chain's record and a withdrawn one not shown`, async () => {
    const c = fakeChain();
    c.set(W1, 2_500_000n);
    c.set(W2, 1_000_000n);
    const other = chain === "base" ? "robinhood" : "base";
    const records = { [W1]: rec(chain, "filled", TOKEN, 18), [W2]: rec(chain, "filled"), ["0x" + "a3".repeat(20)]: rec(other, "filled"), ["0x" + "a4".repeat(20)]: rec(chain, "withdrawn") };
    const got = await evmPositionsPass(reads(chain, c, records), passMemo());
    assert.deepEqual(got, { positions: [{ chain, token: TOKEN, amount: "3.5", cost: "0", wallets: [W1, W2.toLowerCase()].sort(), decimals: 6 }], whole: true });
    for (const i of [0, 1] as const) {
      assert.ok(c.calls[i]!.filter((x) => x.data?.startsWith("0x70a08231")).every((x) => x.at === hex(100n)), "at the lower newest block");
      assert.ok(c.calls[i]!.filter((x) => x.data?.startsWith("0x70a08231")).every((x) => !x.data!.includes("a3".repeat(20)) && !x.data!.includes("a4".repeat(20))), "no read of another chain's W or a withdrawn one");
    }
    assert.ok(SIGNPAGE_RESULT_SCHEMAS.state({ ...SIGNED_IN, positions: got.positions }), "the kit's schema takes it");
  });

  test(`(${chain}) pending: never shown and not read; the follow fills it (landed): shown; the follow removes it (never landed): nothing`, async () => {
    const c = fakeChain();
    c.set(W1, 7_000_000n);
    const records: Record<string, unknown> = { [W1]: rec(chain, "pending") };
    const memo = passMemo();
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [], whole: true });
    assert.deepEqual(c.calls, [[], []], "a pending record asks nothing of the pass (its follow reads the pool's logs)");
    // landed: followPendingEvmBuys writes it filled (test/pool-buy-evm.test.ts "(pending end, dead tab)")
    records[W1] = rec(chain, "filled");
    assert.deepEqual((await evmPositionsPass(reads(chain, c, records), memo)).positions, [{ chain, token: TOKEN, amount: "7", cost: "0", wallets: [W1], decimals: 6 }]);
    // never landed: the follow removes it, so the note buys again
    delete records[W1];
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [], whole: true });
  });

  test(`(${chain}) two RPCs that disagree: no position, never a wrong one, the pass not whole (tried again); a W with an agreed read keeps it`, async () => {
    const c = fakeChain();
    c.set(W1, 5_000_000n, 6_000_000n);
    const memo = passMemo();
    const records = { [W1]: rec(chain, "filled") };
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [], whole: false });
    assert.deepEqual([per(c, 0).balanceOf, per(c, 1).balanceOf], [2, 2], "read again once, then failed");
    // they agree: shown
    c.set(W1, 5_000_000n);
    assert.deepEqual((await evmPositionsPass(reads(chain, c, records), memo)).positions.map((p) => p.amount), ["5"]);
    // they differ again: the last agreed amount, as Solana's pass keeps a W's last (src/positions.ts), not whole
    c.set(W1, 5_000_000n, 9_000_000n);
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [{ chain, token: TOKEN, amount: "5", cost: "0", wallets: [W1], decimals: 6 }], whole: false });
    // one RPC down on a fresh page: nothing shown
    const d = fakeChain();
    d.set(W1, 5_000_000n);
    d.down[1] = true;
    assert.deepEqual(await evmPositionsPass(reads(chain, d, records), passMemo()), { positions: [], whole: false });
  });

  test(`(${chain}) a token two Ws hold, one W's RPCs disagreeing: no position (never the part one W holds); decimals that differ: none`, async () => {
    const c = fakeChain();
    c.set(W1, 1_000_000n);
    c.set(W2, 2_000_000n, 3_000_000n);
    assert.deepEqual(await evmPositionsPass(reads(chain, c, { [W1]: rec(chain, "filled"), [W2]: rec(chain, "filled") }), passMemo()), { positions: [], whole: false });
    const d = fakeChain();
    d.set(W1, 1_000_000n);
    d.decimals[1] = 18;
    assert.deepEqual(await evmPositionsPass(reads(chain, d, { [W1]: rec(chain, "filled") }), passMemo()), { positions: [], whole: false });
    // a W sold in full (0 on both): no position, whole
    const e = fakeChain();
    assert.deepEqual(await evmPositionsPass(reads(chain, e, { [W1]: rec(chain, "filled") }), passMemo()), { positions: [], whole: true });
  });

  test(`(${chain}) the requests per RPC per pass: one eth_blockNumber, one balanceOf per filled W, decimals once per token per page; none with no filled record`, async () => {
    const c = fakeChain();
    const ws = Array.from({ length: 5 }, (_, i) => "0x" + (i + 1).toString(16).padStart(2, "0").repeat(20));
    const records: Record<string, unknown> = Object.fromEntries(ws.map((w) => [w, rec(chain, "filled")]));
    records[ws[4]!] = rec(chain, "filled", OTHER);
    for (const w of ws) c.set(w, 1n);
    const memo = passMemo();
    await evmPositionsPass(reads(chain, c, records), memo);
    for (const i of [0, 1] as const) assert.deepEqual(per(c, i), { eth_blockNumber: 1, balanceOf: 5, decimals: 2 }, "first pass: two tokens' decimals");
    c.calls[0] = [];
    c.calls[1] = [];
    await evmPositionsPass(reads(chain, c, records), memo);
    for (const i of [0, 1] as const) assert.deepEqual(per(c, i), { eth_blockNumber: 1, balanceOf: 5 }, "next pass: the decimals kept");
    c.calls[0] = [];
    c.calls[1] = [];
    await evmPositionsPass(reads(chain, c, { [W1]: rec(chain, "pending") }), memo);
    assert.deepEqual(c.calls, [[], []]);
  });
}

test("the live check's Deposited topic and pool RPCs are the page's own (scripts/live-checks/signpage-positions-evm.mjs reaches no package code)", async () => {
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { EVM_POOL_EVENTS } = await import("../../wallet/src/pool/evm.ts");
  const { TESTNET_RPCS } = await import("../src/pool-testnet.ts");
  const live = (await import(new URL("../../../scripts/live-checks/signpage-positions-evm.mjs", import.meta.url).href)) as { DEPOSITED: string };
  const buy = (await import(new URL("../../../scripts/live-checks/signpage-evm-pool-buy.mjs", import.meta.url).href)) as { RPCS: Record<string, readonly string[]> };
  assert.equal(live.DEPOSITED, `0x${Buffer.from(keccak_256(new TextEncoder().encode(EVM_POOL_EVENTS.Deposited))).toString("hex")}`);
  assert.deepEqual([...buy.RPCS["base-sepolia"]!], [...TESTNET_RPCS.base], "the pair the page reads Base Sepolia positions on");
});

test("the stagger: a pass starts its step after it is asked, and a stop before then runs nothing", async () => {
  const timers: { f: () => void; ms: number }[] = [];
  const setTimer = (f: () => void, ms: number) => void timers.push({ f, ms });
  let ran = 0;
  const go = new AbortController();
  const p = staggered(EVM_POSITIONS_STAGGER_MS, go.signal, async () => ++ran, setTimer);
  await tick();
  assert.deepEqual([ran, timers.map((t) => t.ms)], [0, [EVM_POSITIONS_STAGGER_MS]]);
  timers[0]!.f();
  assert.equal(await p, 1);
  const stop = new AbortController();
  const q = staggered(EVM_POSITIONS_STAGGER_MS, stop.signal, async () => ++ran, setTimer);
  stop.abort();
  timers[1]!.f();
  await assert.rejects(q);
  assert.equal(ran, 1, "a stopped pass never reads");
});

// ---- the page ----

const SIGNED_IN: SignpageState = { release: "sp-1", api: 1, signed_in: true, code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const LIVE_STATE = new URL("../../../apps/terminal/test/sell-positions/live-state-evm.json", import.meta.url);
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function wallet(): Promise<WalletStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  return w;
}
const fakeEvmPool = (): Pool<unknown> => ({ ready: async () => [] }) as unknown as Pool<unknown>;

test("the page: Base's and Robinhood's positions beside Solana's, staggered; a buy's settle, a sell's end and a dropped open sale read the chain again; a sign out reads nothing more", async () => {
  const w = await wallet();
  const ch = { base: fakeChain(), robinhood: fakeChain() };
  ch.base.set(W1, 12_345_678n);
  ch.robinhood.set(W2, 3_000_000n);
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W1]: rec("base", "filled"), [W2]: rec("robinhood", "filled") }));
  const timers: { f: () => void; ms: number }[] = [];
  const asked: number[] = [];
  const hosts: { settle?: () => void; unrecord?: (...a: never[]) => Promise<void> }[] = [];
  let progress: ((stage: string) => void) | null = null;
  const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => PINS[c],
    evmRpcs: (c) => ch[c].rpcs,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => fakeEvmPool(),
    positions: { setTimer: (f: () => void, ms: number) => (asked.push(ms), timers.push({ f, ms }), f), clearTimer: () => {} },
    tradeKinds: {
      evmBuy: (host) => () => {
        hosts.push(host());
        return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
      evmSell: (host) => (_ask, ctx) => {
        const h = host();
        hosts.push(h);
        progress = (ctx as { progress: (s: string) => void }).progress;
        return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
    },
  });
  let told = 0;
  t.watch(() => told++);
  const run = async () => {
    for (let i = 0; i < 50; i++) {
      await tick();
      for (const x of timers.splice(0)) if (x.ms > 0 && x.ms < 5_000) x.f();
    }
  };
  await t.positions();
  await run();
  const evmOf = async () => ((await t.positions()) ?? []).filter((p) => p.chain !== "solana");
  await until(async () => (await run(), (await evmOf()).length === 2));
  assert.deepEqual(await evmOf(), [
    { chain: "base", token: TOKEN, amount: "12.345678", cost: "0", wallets: [W1], decimals: 6 },
    { chain: "robinhood", token: TOKEN, amount: "3", cost: "0", wallets: [W2.toLowerCase()], decimals: 6 },
  ]);
  for (const c of CHAINS) assert.deepEqual(per(ch[c], 0), { eth_blockNumber: 1, balanceOf: 1, decimals: 1 }, `${c}: one pass, its reads bounded`);
  assert.ok(told >= 2, `the page's state is read again when an EVM chain's positions change (told ${told})`);
  assert.deepEqual(asked.filter((ms) => ms < 5_000).sort((a, b) => a - b), [EVM_POSITIONS_STAGGER_MS, 2 * EVM_POSITIONS_STAGGER_MS], "Base one step after Solana's pass, Robinhood two");
  // what SIGN_HOST then sends the app: the terminal's EVM sell test reads this very state
  const sent = withPositions(await withPools(SIGNED_IN, async () => [], PAGE_POOLS), ((await t.positions()) ?? []).filter((p) => p.chain === "base"));
  if (process.env.RECORD_LIVE_STATE === "1") writeFileSync(LIVE_STATE, `${JSON.stringify(sent, null, 2)}\n`);
  assert.deepEqual(sent, JSON.parse(readFileSync(LIVE_STATE, "utf8")), "the terminal's recorded state is the page's own");
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(sent), true);

  // a sell's end on Base: Base read again (sold in full: gone), Robinhood not read
  ch.base.set(W1, 0n);
  const before = per(ch.robinhood, 0).balanceOf;
  const r = t.flow({ kind: "pool.sell", chain: "base", token: TOKEN, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s1", sha: "00", progress: () => {} } as never);
  assert.ok("running" in r);
  await run();
  assert.equal((await evmOf()).length, 2, "nothing read again before the run ends");
  progress!("filled");
  await until(async () => (await run(), (await evmOf()).every((p) => p.chain !== "base")));
  assert.equal(per(ch.robinhood, 0).balanceOf, before, "only the chain whose sell ended is read again");

  // a buy's settle on Base (its run's end, or the load's follow of a pending record: filled or removed): read again
  ch.base.set(W1, 4_000_000n);
  const b = t.flow({ kind: "pool.buy", chain: "base", token: TOKEN, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "b1", sha: "00", progress: () => {} } as never);
  assert.ok("running" in b);
  hosts.at(-1)!.settle!();
  await until(async () => (await run(), (await evmOf()).some((p) => p.chain === "base" && p.amount === "4")));

  // an open sale dropped at its end (the run's or the load's follow's): read again
  ch.base.set(W1, 1_000_000n);
  t.flow({ kind: "pool.sell", chain: "base", token: TOKEN, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s2", sha: "00", progress: () => {} } as never);
  await (hosts.at(-1)!.unrecord as (n: string, d: string) => Promise<void>)("no-such-note", "0");
  await until(async () => (await run(), (await evmOf()).some((p) => p.chain === "base" && p.amount === "1")));

  // a sign out during a pass's stagger: nothing of it is read
  ch.base.set(W1, 2_000_000n);
  progress!("filled");
  const reads0 = ch.base.calls[0]!.length;
  await t.signedOut();
  for (const x of timers.splice(0)) x.f();
  await run();
  assert.equal(ch.base.calls[0]!.length, reads0, "a pass a sign out stopped reads nothing");
});
