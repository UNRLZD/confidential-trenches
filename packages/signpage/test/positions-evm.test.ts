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
const { EVM_POSITIONS_IN_FLIGHT, EVM_POSITIONS_REARM_MS, EVM_POSITIONS_STAGGER_MS, EVM_SALE_FLOOR_MS, evmPositionsPass, evmPositionsRetryMs, evmSaleHolds, staggered } = await import("../src/positions-evm.ts");
const { passMemo, positionsCache, withPositions } = await import("../src/positions.ts");
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
const rec = (chain: string, state: "pending" | "filled" | "withdrawn", mint = TOKEN, decimals = 6, block = "90") => ({
  mint,
  decimals,
  chain,
  state,
  route: { venue: "uniswap-v3", adapter: "0x" + "ad".repeat(20), path: { kind: "v3", fee: 500 }, ...(state === "filled" ? { tx: "0x" + "11".repeat(32), block } : {}) },
  ...(state === "filled" ? { received: "999000000" } : {}),
  ...(state === "pending" ? { buy: { nullifier: "1", from: "100", deadlineMs: "1", minOut: "1", value: "1", feeCap: "1", feeRecipient: "0x0" } } : {}),
});

/** Two RPCs of one chain: each its own balances (by W, lower case), newest block, decimals, failure and receipts (by
 *  hash: a block, each RPC its own); every call kept with the clock's time; `slow` answers a turn later, `most` the calls in flight at
 *  once over both. */
function fakeChain() {
  const bal = [new Map<string, bigint>(), new Map<string, bigint>()];
  const head = [100n, 101n];
  const decimals = [6, 6];
  const down = [false, false];
  const receipts = [new Map<string, bigint>(), new Map<string, bigint>()];
  const calls: { method: string; data?: string; at?: unknown; t: number }[][] = [[], []];
  const o = { slow: false, busy: 0, most: 0, clock: () => 0 };
  const rpc = (i: 0 | 1): EvmRpc =>
    Object.assign(
      async (method: string, params: readonly unknown[]) => {
        const c = params[0] as { to?: string; data?: string } | undefined;
        calls[i].push({ method, ...(c?.data ? { data: c.data, at: params[1] } : {}), t: o.clock() });
        o.most = Math.max(o.most, ++o.busy);
        try {
          if (o.slow) await new Promise((r) => setTimeout(r, 1));
        } finally {
          o.busy--;
        }
        if (down[i]) throw new Error("the RPC did not answer");
        if (method === "eth_getTransactionReceipt") {
          const b = receipts[i]!.get(String(params[0]));
          return b === undefined ? null : { blockNumber: hex(b), status: "0x1" };
        }
        if (method === "eth_blockNumber") return hex(head[i]!);
        if (method === "eth_call" && c?.data === "0x313ce567") return word(decimals[i]!);
        if (method === "eth_call" && c?.data?.startsWith("0x70a08231")) return word(bal[i]!.get(`0x${c.data.slice(-40)}`) ?? 0n);
        throw new Error(`no such read: ${method}`);
      },
      { url: i === 0 ? "https://a.example" : "https://b.example" },
    );
  const set = (w: string, a: bigint, b = a) => (bal[0].set(w.toLowerCase(), a), bal[1].set(w.toLowerCase(), b));
  return Object.assign(o, { rpcs: [rpc(0), rpc(1)] as const, bal, head, decimals, down, calls, set, receipts });
}

/** The pass's reads over `c` with `records` as the store holds them; decimals on both RPCs, the same, else thrown. */
const reads = (chain: "base" | "robinhood", c: ReturnType<typeof fakeChain>, records: Record<string, unknown>, more: Partial<EvmPositionsReads> = {}): EvmPositionsReads => ({
  ...more,
  chain,
  rpcs: c.rpcs,
  signal: new AbortController().signal,
  holdings: async () => records,
  decimals: async (token, rpcs) => {
    const [a, b] = await Promise.all((rpcs ?? c.rpcs).map(async (rpc) => Number(BigInt((await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])) as string))));
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
    assert.deepEqual([per(c, 0).balanceOf, per(c, 1).balanceOf], [1, 1], "read once: the pass's retry is the re-read, none within the pass");
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

  test(`(${chain}) the floor, a buy: filled at block 120 and read at heads 125/118, nothing from before it is shown and the pass is not whole (tried again); at 125/121 it shows`, async () => {
    const c = fakeChain();
    c.head[0] = 125n;
    c.head[1] = 118n;
    c.set(W1, 5_000_000n);
    const records = { [W1]: rec(chain, "filled", TOKEN, 6, "120") };
    const memo = passMemo();
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [], whole: false });
    assert.equal(per(c, 0).balanceOf ?? 0, 0, "no balance read under the floor");
    c.head[1] = 121n;
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [{ chain, token: TOKEN, amount: "5", cost: "0", wallets: [W1], decimals: 6 }], whole: true });
    assert.ok(c.calls[0]!.filter((x) => x.data?.startsWith("0x70a08231")).every((x) => x.at === hex(121n)));
  });

  test(`(${chain}) the floor, a full sell: sold at block 200 and read at heads 205/197, the sold row is not shown and the pass is not whole (tried again); at 205/201 it reads none`, async () => {
    const c = fakeChain();
    c.head[0] = 191n;
    c.head[1] = 190n;
    c.set(W1, 5_000_000n);
    const records = { [W1]: rec(chain, "filled") };
    const memo = passMemo();
    assert.deepEqual((await evmPositionsPass(reads(chain, c, records), memo)).positions.map((p) => p.amount), ["5"]);
    // the sale at block 200: the provider behind it still answers the holding from before it
    c.head[0] = 205n;
    c.head[1] = 197n;
    c.set(W1, 0n, 5_000_000n);
    const sold = { holds: async () => new Map([[TOKEN, 200n]]) };
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records, sold), memo), { positions: [], whole: false });
    assert.equal(per(c, 0).balanceOf, 1, "no balance read under the sale's block");
    c.head[1] = 201n;
    c.set(W1, 0n);
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records, sold), memo), { positions: [], whole: true });
    // a pass never reads under the block a pass before it read at (a provider that falls behind)
    c.head[0] = 199n;
    c.set(W1, 0n, 5_000_000n);
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [], whole: false });
  });

  test(`(${chain}) a provider stuck 50 blocks back: alone it never stops a pass being whole; past a buy the rows wait (not whole, the last agreed kept), never a number one provider gave alone`, async () => {
    const c = fakeChain();
    c.head[0] = 150n;
    c.head[1] = 200n;
    c.set(W1, 5_000_000n);
    const memo = passMemo();
    // stuck, nothing past it: whole, at the stuck block (both answer for it)
    assert.deepEqual((await evmPositionsPass(reads(chain, c, { [W1]: rec(chain, "filled", TOKEN, 6, "140") }), memo)).whole, true);
    // a buy at 190, past the stuck provider: not whole, the last agreed row kept, the new amount never shown on the
    // provider past it alone
    c.set(W1, 5_000_000n, 7_000_000n);
    const records = { [W1]: rec(chain, "filled", TOKEN, 6, "190") };
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [{ chain, token: TOKEN, amount: "5", cost: "0", wallets: [W1], decimals: 6 }], whole: false });
    assert.deepEqual(per(c, 1).balanceOf, 1, "no balance read past the stuck one's block on the other provider alone");
    // it moves on: read at the lower of the two
    c.head[0] = 195n;
    c.set(W1, 7_000_000n);
    assert.deepEqual(await evmPositionsPass(reads(chain, c, records), memo), { positions: [{ chain, token: TOKEN, amount: "7", cost: "0", wallets: [W1], decimals: 6 }], whole: true });
  });

  test(`(${chain}) an open sale's token: no amount agreed under its floor, none while it has none (a kept one dropped too), and a sale's record written while a pass reads holds its token in that pass`, async () => {
    const c = fakeChain();
    c.set(W1, 5_000_000n);
    c.set(W2, 3_000_000n);
    const records = { [W1]: rec(chain, "filled"), [W2]: rec(chain, "filled", OTHER) };
    const memo = passMemo();
    const rows = async (holds?: EvmPositionsReads["holds"]) => {
      const got = await evmPositionsPass(reads(chain, c, records, holds === undefined ? {} : { holds }), memo);
      return { rows: got.positions.map((p) => `${p.token === TOKEN ? "token" : "other"} ${p.amount}`), whole: got.whole };
    };
    assert.deepEqual(await rows(), { rows: ["token 5", "other 3"], whole: true });
    // no floor yet: the kept 5 is not shown (one RPC down too), the other token is
    c.down[1] = true;
    assert.deepEqual(await rows(async () => new Map([[TOKEN, null]])), { rows: ["other 3"], whole: false });
    c.down[1] = false;
    assert.deepEqual(await rows(async () => new Map([[TOKEN, null]])), { rows: ["other 3"], whole: false });
    // the record written while the pass read (first ask: none; the end's: held): the amount it read is not shown
    let asks = 0;
    assert.deepEqual(await rows(async () => (asks++ === 0 ? new Map() : new Map([[TOKEN, null]]))), { rows: ["other 3"], whole: false });
    // a floor past the lower newest block (100): not read; at it, read
    c.set(W1, 2_000_000n);
    assert.deepEqual(await rows(async () => new Map([[TOKEN, 101n]])), { rows: ["other 3"], whole: false });
    assert.deepEqual(await rows(async (heads) => (assert.deepEqual(heads, [100n, 101n]), new Map([[TOKEN, 100n]]))), { rows: ["token 2", "other 3"], whole: true });
    // and an amount agreed past it is kept while a read fails
    c.down[0] = true;
    assert.deepEqual(await rows(async () => new Map([[TOKEN, 100n]])), { rows: ["token 2", "other 3"], whole: false });
  });

  test(`(${chain}) ten holdings: at most ${EVM_POSITIONS_IN_FLIGHT} of a pass's calls in flight at once over both RPCs, each RPC one eth_blockNumber, ten balanceOf, one decimals`, async () => {
    const c = fakeChain();
    c.slow = true;
    const ws = Array.from({ length: 10 }, (_, i) => "0x" + (i + 1).toString(16).padStart(2, "0").repeat(20));
    for (const w of ws) c.set(w, 1_000_000n);
    const got = await evmPositionsPass(reads(chain, c, Object.fromEntries(ws.map((w) => [w, rec(chain, "filled")]))), passMemo());
    assert.equal(got.positions[0]?.amount, "10");
    assert.ok(c.most <= EVM_POSITIONS_IN_FLIGHT && c.most > 1, `in flight at once: ${c.most}`);
    for (const i of [0, 1] as const) assert.deepEqual(per(c, i), { eth_blockNumber: 1, balanceOf: 10, decimals: 1 });
  });
}

test("the sale holds: no floor until the send ends (a pass started after it takes one past its lower newest block), the Deposited's block then; not landed holds nothing; a load's record takes one 60 s past its deadline; two sales of one token, the higher floor and none while either has none; a floor above both heads dropped once 60 s old", () => {
  const sale = (note: string, deadline: string, token = TOKEN) => ({ note, chain: "base", w: W1, token, deadline });
  const h = evmSaleHolds("base");
  const heads = [100n, 103n] as const;
  assert.equal(h.record(sale("a", "1000")), true);
  assert.equal(h.record(sale("a", "1000")), false, "the same sale again: not new");
  assert.equal(h.record({ ...sale("x", "1000"), chain: "robinhood" }), false, "another chain's: not held");
  assert.deepEqual(h.at({}, heads, 0, 0), new Map([[TOKEN, null]]));
  h.sendEnded(W1.toUpperCase(), 5_000);
  assert.deepEqual(h.at({}, heads, 4_999, 5_000), new Map([[TOKEN, null]]), "a pass started before the send ended takes none");
  assert.deepEqual(h.at({}, heads, 5_000, 5_000), new Map([[TOKEN, 101n]]));
  h.deposited(sale("a", "1000"), 102n, 6_000);
  assert.deepEqual(h.at({}, heads, 6_000, 6_000), new Map([[TOKEN, 102n]]), "the Deposited's block");
  h.dropped("a");
  assert.deepEqual(h.at({}, heads, 6_000, 6_000), new Map([[TOKEN, 102n]]), "a sale with a Deposited read is kept at its end");
  // not landed: nothing held
  const n = evmSaleHolds("base");
  n.record(sale("b", "1000"));
  n.dropped("b");
  assert.deepEqual(n.at({}, heads, 0, 0), new Map());
  // a record a load finds: none until 60 s past its deadline (1000 s), then one past the lower newest block
  const l = evmSaleHolds("base");
  const open = { c: sale("c", "1000"), junk: { note: "j", chain: "base", w: "no", token: TOKEN, deadline: "1" } };
  assert.deepEqual(l.at(open, heads, 1_059_999, 1_059_999), new Map([[TOKEN, null]]));
  assert.deepEqual(l.at(open, heads, 1_060_000, 1_060_000), new Map([[TOKEN, 101n]]));
  // a second sale of the token: none while it has none, then the higher of the two
  l.record(sale("d", "2000"));
  assert.deepEqual(l.at(open, heads, 1_060_000, 1_060_000), new Map([[TOKEN, null]]));
  l.deposited(sale("d", "2000"), 99n, 1_061_000);
  assert.deepEqual(l.at(open, heads, 1_061_000, 1_061_000), new Map([[TOKEN, 101n]]));
  // a floor above both heads: held until it is 60 s old, then dropped; the same Deposited read again keeps it dropped
  const t = evmSaleHolds("base");
  t.deposited(sale("e", "1000", OTHER), 2n ** 64n - 1n, 0);
  assert.deepEqual(t.at({}, heads, 0, EVM_SALE_FLOOR_MS - 1), new Map([[OTHER, 2n ** 64n - 1n]]));
  assert.deepEqual(t.at({}, heads, 0, EVM_SALE_FLOOR_MS), new Map());
  t.deposited(sale("e", "1000", OTHER), 2n ** 64n - 1n, EVM_SALE_FLOOR_MS);
  assert.deepEqual(t.at({}, heads, 0, EVM_SALE_FLOOR_MS), new Map());
  assert.deepEqual([...t.newer(0)], []);
});

test("a pass stopped while its calls wait their turn ends, and sends none of them", async () => {
  const c = fakeChain();
  c.slow = true;
  const ws = Array.from({ length: 10 }, (_, i) => "0x" + (i + 0x41).toString(16).padStart(2, "0").repeat(20));
  for (const x of ws) c.set(x, 1n);
  const stop = new AbortController();
  let ended = false;
  const p = evmPositionsPass({ ...reads("base", c, Object.fromEntries(ws.map((x) => [x, rec("base", "filled")]))), signal: stop.signal }, passMemo()).finally(() => (ended = true));
  p.catch(() => {});
  await until(() => per(c, 0).balanceOf !== undefined);
  stop.abort();
  const sent = c.calls[0]!.length + c.calls[1]!.length;
  await until(() => ended);
  assert.ok(c.calls[0]!.length + c.calls[1]!.length <= sent + EVM_POSITIONS_IN_FLIGHT, "only the calls already in flight");
});

test("the retries back off 5, 10, 20 s, then 20 s each; a pass under the floor books one; a round spent books none, and spent() says so", async () => {
  assert.deepEqual([0, 1, 2, 3, 11].map(evmPositionsRetryMs), [5_000, 10_000, 20_000, 20_000, 20_000]);
  const c = fakeChain();
  c.head[0] = 125n;
  c.head[1] = 118n;
  c.set(W1, 5_000_000n);
  const timers: { f: () => void; ms: number }[] = [];
  const cache = positionsCache((memo) => evmPositionsPass(reads("base", c, { [W1]: rec("base", "filled", TOKEN, 6, "120") }), memo), { retryMs: evmPositionsRetryMs, retries: 4, setTimer: (f, ms) => (timers.push({ f, ms }), f), clearTimer: () => {} });
  cache.first();
  await cache.idle();
  assert.deepEqual(timers.map((t) => t.ms), [5_000], "a pass under the floor is tried again");
  for (let i = 0; i < 4; i++) {
    timers.at(-1)!.f();
    await cache.idle();
  }
  assert.deepEqual(timers.map((t) => t.ms), [5_000, 10_000, 20_000, 20_000]);
  assert.equal(cache.spent(), true, "the round is spent: nothing booked");
  c.head[1] = 121n;
  cache.refresh();
  await cache.idle();
  assert.equal(cache.spent(), false);
  assert.deepEqual(((await cache.read()) ?? []).map((p) => p.amount), ["5"]);
});

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

// the page's own clock for the positions: every timer the caches book (their stagger and retries) and the re-arm's
// clock; `go(ms)` moves the clock on and runs every timer due by then, in order
function pageClock() {
  let now = 0;
  const due: { at: number; f: () => void; ms: number }[] = [];
  const setTimer = (f: () => void, ms: number) => (due.push({ at: now + ms, f, ms }), f);
  const go = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      for (let i = 0; i < 20; i++) await tick();
      due.sort((a, b) => a.at - b.at);
      if (due.length === 0 || due[0]!.at > end) break;
      const x = due.shift()!;
      now = x.at;
      x.f();
    }
    now = end;
  };
  return { setTimer, go, now: () => now, due };
}

test("the page: Solana's first pass never holds back the EVM rows; a spent round is asked one pass per 30 s from a state read; a sale refused not_funded and a restore read the chain again; a sale's record drops its row at once, and its Deposited's block is read at, never under", async () => {
  const w = await wallet();
  const ch = { base: fakeChain(), robinhood: fakeChain() };
  ch.base.set(W1, 5_000_000n);
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W1]: rec("base", "filled") }));
  const { POSITIONS_SOLD_TX_KEY } = await import("../src/positions.ts");
  const clock = pageClock();
  // Solana's pass's read of its sold marks never answers: its first pass never ends (the EVM pass reads its own records)
  const held = new Proxy(w, {
    get(o, k) {
      if (k === "get") return (store: string, key: string) => (key === POSITIONS_SOLD_TX_KEY ? new Promise(() => {}) : o.get(store as never, key as never));
      const v = Reflect.get(o, k);
      return typeof v === "function" ? v.bind(o) : v;
    },
  });
  const SALE = "0x" + "5a".repeat(32);
  let sellAnswer: () => unknown = () => ({ error: "not_funded" });
  let progress: ((stage: string) => void) | null = null;
  const hosts: SellHost[] = [];
  const t = testnetPool({ store: async () => held, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => PINS[c],
    evmRpcs: (c) => ch[c].rpcs,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => fakeEvmPool(),
    fetch: (async () => new Response(JSON.stringify({ hash: SALE }), { status: 200 })) as typeof fetch,
    positions: { setTimer: clock.setTimer, clearTimer: () => {}, retries: 2 },
    positionsNow: clock.now,
    tradeKinds: {
      evmBuy: () => () => ({ error: "not_allowed" }),
      evmSell: (host) => (_ask, ctx) => {
        hosts.push(host());
        progress = (ctx as { progress: (s: string) => void }).progress;
        const a = sellAnswer();
        return a !== null && typeof a === "object" && "error" in a ? (a as never) : { running: true, after: Promise.resolve(), answer: () => a as never };
      },
    },
  });
  const baseOf = async () => ((await t.positions()) ?? []).filter((p) => p.chain === "base").map((p) => p.amount);
  const balanceReads = () => per(ch.base, 0).balanceOf ?? 0;

  // Small-2: Solana's first pass still runs; Base's row is there all the same, and Solana's is none yet
  await t.positions();
  await clock.go(1_000);
  assert.deepEqual(await baseOf(), ["5"], "the EVM rows while Solana's first pass runs");
  assert.equal(((await t.positions()) ?? []).filter((p) => p.chain === "solana").length, 0);

  // a restore wrote Base's records: Base read again
  const r0 = balanceReads();
  t.evmHoldingsRestored("base");
  await clock.go(1_000);
  assert.equal(balanceReads(), r0 + 1, "a restore's records read at once");

  // P2-a: one RPC down; a refresh, then its round of 2 retries (5 s, 10 s) spent; the last agreed row kept
  ch.base.down[1] = true;
  t.evmHoldingsRestored("base");
  await clock.go(60_000);
  const spentAt = ch.base.calls[0]!.length;
  assert.deepEqual(await baseOf(), ["5"], "the last agreed amount while the RPC is down");
  // the RPC is back: a state read asks one pass (the round is spent), the next within 30 s none, the one after 30 s one
  ch.base.down[1] = false;
  ch.base.set(W1, 6_000_000n);
  await t.positions();
  await clock.go(1_000);
  assert.deepEqual(await baseOf(), ["6"], "a spent round is asked one pass from a state read");
  ch.base.down[1] = true;
  t.evmHoldingsRestored("base");
  await clock.go(60_000);
  const n0 = ch.base.calls[0]!.length;
  await t.positions();
  await clock.go(1_000);
  const n1 = ch.base.calls[0]!.length;
  assert.equal(n1, n0 + 1, "one pass asked (its eth_blockNumber fails: the RPC is down), no new round");
  await t.positions();
  await clock.go(20_000);
  await t.positions();
  await clock.go(1_000);
  assert.equal(ch.base.calls[0]!.length, n1, "no second ask within 30 s, and no retry of the asked pass");
  await clock.go(EVM_POSITIONS_REARM_MS);
  await t.positions();
  await clock.go(1_000);
  assert.equal(ch.base.calls[0]!.length, n1 + 1, "one ask again after 30 s");
  assert.ok(spentAt > 0);
  ch.base.down[1] = false;

  // a sale refused not_funded (the row it sold from may be a spent round's): Base read again
  sellAnswer = () => ({ error: "not_funded" });
  const r1 = balanceReads();
  const refused = t.flow({ kind: "pool.sell", chain: "base", token: TOKEN, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s1", sha: "00", progress: () => {} } as never);
  assert.deepEqual(refused, { error: "not_funded" });
  await clock.go(1_000);
  assert.equal(balanceReads(), r1 + 1, "not_funded reads the chain again");

  // P1: a full sale whose Deposited both RPCs name at block 200, read at heads 205/197: the sold row goes at its record,
  // nothing is shown from the provider behind it, and the pass is tried again until both are past it
  sellAnswer = () => ({ result: { stage: "sent", txs: [] } });
  const s2 = t.flow({ kind: "pool.sell", chain: "base", token: TOKEN, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s2", sha: "00", progress: () => {} } as never);
  assert.ok("running" in s2);
  const sale = openSale("n-p1", clock.now());
  await hosts.at(-1)!.record(sale);
  await clock.go(1_000);
  assert.deepEqual(await baseOf(), [], "the row goes at the sale's record");
  assert.equal(await hosts.at(-1)!.send(sendBody), SALE);
  ch.base.head[0] = 205n;
  ch.base.head[1] = 197n;
  ch.base.set(W1, 0n, 6_000_000n);
  const r2 = balanceReads();
  hosts.at(-1)!.deposited?.(sale, 200n);
  progress!("filled");
  await clock.go(1_000);
  assert.deepEqual(await baseOf(), [], "the sold row is not shown on a provider behind the sale");
  assert.equal(balanceReads(), r2, "no balance read under the sale's block");
  assert.ok(clock.due.some((x) => x.ms === 5_000), "the pass under the floor is tried again");
  ch.base.head[1] = 201n;
  ch.base.set(W1, 0n);
  await clock.go(6_000);
  assert.deepEqual(await baseOf(), []);
  assert.ok(balanceReads() > r2, "read once both are past the sale");
  assert.ok(ch.base.calls[0]!.filter((x) => x.data?.startsWith("0x70a08231")).slice(r2).every((x) => BigInt(x.at as string) >= 200n), "never under it");
  await t.signedOut();
});

type SellHost = {
  send: (b: never) => Promise<string>;
  record: (o: never) => Promise<void>;
  unrecord: (note: string, deadline: string) => Promise<void>;
  deposited?: (o: never, block: bigint) => void;
};
const sendBody = { pool: PINS.base.pool, w: W1, data: new Uint8Array(1), authorization: { chainId: 84532, address: "0x" + "ee".repeat(20), nonce: 0n, yParity: 0, r: "0x1", s: "0x1" } } as never;
/** W1's open sale of TOKEN as the run writes it before its send (pool-sell-evm.ts EvmOpenSell), its deadline 300 s on. */
const openSale = (note: string, nowMs: number) =>
  ({ note, chain: "base", w: W1, token: TOKEN, amount: "5000000", precommitment: "7", nonce: "0", deadline: String(Math.floor(nowMs / 1000) + 300), from: "90", least: "1" }) as never;

/** A page over Base with W1's 5 TOKEN, the sell kind a stand-in handing the test its host; `send` the helper's answer. */
async function salePage(send: () => Promise<Response>) {
  const w = await wallet();
  const ch = { base: fakeChain(), robinhood: fakeChain() };
  ch.base.set(W1, 5_000_000n);
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W1]: rec("base", "filled") }));
  const clock = pageClock();
  const hosts: SellHost[] = [];
  let progress: ((stage: string) => void) | null = null;
  const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => PINS[c],
    evmRpcs: (c) => ch[c].rpcs,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => fakeEvmPool(),
    fetch: send as typeof fetch,
    positions: { setTimer: clock.setTimer, clearTimer: () => {} },
    positionsNow: clock.now,
    tradeKinds: {
      evmBuy: () => () => ({ error: "not_allowed" }),
      evmSell: (host) => (_ask, ctx) => {
        hosts.push(host() as unknown as SellHost);
        progress = (ctx as { progress: (s: string) => void }).progress;
        return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
    },
  });
  const rows = async () => ((await t.positions()) ?? []).filter((p) => p.chain === "base").map((p) => `${p.token === TOKEN ? "token" : "other"} ${p.amount}`);
  await t.positions();
  await clock.go(1_000);
  assert.deepEqual(await rows(), ["token 5"]);
  const sell = async () => {
    assert.ok("running" in t.flow({ kind: "pool.sell", chain: "base", token: TOKEN, amount: 5_000_000n, slippageBps: 100, decimals: 6 }, { id: "s", sha: "00", progress: () => {} } as never));
    return { host: hosts.at(-1)!, progress: progress! };
  };
  return { w, ch, clock, t, rows, sell };
}

test("P2-2a: a sale's floor above both RPCs' newest blocks (one RPC's receipt of its hash at 2^64-1, a Deposited at 2^64-1): the rows come back once it is 60 s old, and a later filled buy shows", async () => {
  const SALE = "0x" + "5b".repeat(32);
  const { w, ch, clock, t, rows, sell } = await salePage(async () => new Response(JSON.stringify({ hash: SALE }), { status: 200 }));
  const TOP = 2n ** 64n - 1n;
  const { host, progress } = await sell();
  const sale = openSale("n-top", clock.now());
  await host.record(sale);
  assert.equal(await host.send(sendBody), SALE);
  ch.base.receipts[1]!.set(SALE, TOP);
  // a part sale: 5 to 2, read on both RPCs at their newest blocks
  ch.base.set(W1, 2_000_000n);
  host.deposited?.(sale, TOP);
  progress("part_filled");
  await clock.go(1_000);
  assert.deepEqual(await rows(), [], "held while its floor is new");
  await clock.go(30_000);
  assert.deepEqual(await rows(), [], "still held at 31 s");
  // past the bound: the next pass (a retry, or a state read once the round is spent) shows what W holds now
  await clock.go(30_000);
  await t.positions();
  await clock.go(21_000);
  assert.deepEqual(await rows(), ["token 2"], "the rows come back within the bound and a pass");
  // a later buy, filled at block 95 (both RPCs past it): shown
  const W3 = "0x" + "a3".repeat(20);
  ch.base.set(W3, 7_000_000n);
  await w.update("meta", EVM_POSITION_COSTS_KEY, (v) => ({ ...(v as object), [W3]: rec("base", "filled", OTHER, 6, "95") }));
  t.evmHoldingsRestored("base");
  await clock.go(1_000);
  assert.deepEqual((await rows()).sort(), ["other 7", "token 2"], "a later filled buy shows");
  await t.signedOut();
});

test("P2-2b: a full sale whose send's answer is lost: never the old amount as agreed, a retry booked, until a pass reads past the lower newest block taken after the send ended; its Deposited, read later, holds the row again until both RPCs are past it", async () => {
  const { ch, clock, t, rows, sell } = await salePage(async () => {
    throw new TypeError("the connection closed");
  });
  const seen: string[][] = [];
  const look = async () => (seen.push(await rows()), seen.at(-1)!);
  const { host } = await sell();
  const sale = openSale("n-lost", clock.now());
  await host.record(sale);
  assert.deepEqual(await look(), [], "no row from the record on, before a pass reads again");
  await assert.rejects(host.send(sendBody));
  // the sale lands on one RPC, the other behind it
  ch.base.set(W1, 0n, 5_000_000n);
  await clock.go(1_000);
  assert.deepEqual(await look(), [], "the row waits");
  assert.ok(clock.due.some((x) => x.ms >= 5_000), "a retry is booked");
  // both move past the lower newest block (100) taken after the send ended: read there, sold in full
  ch.base.head[0] = 101n;
  ch.base.head[1] = 102n;
  ch.base.set(W1, 0n);
  await clock.go(20_000);
  assert.deepEqual(await look(), [], "read past it: none held");
  // the read-back's verdict then names the sale's Deposited at block 110: held again until both are past it
  ch.base.set(W1, 0n, 5_000_000n);
  host.deposited?.(sale, 110n);
  await clock.go(40_000);
  assert.deepEqual(await look(), []);
  ch.base.head[0] = 111n;
  ch.base.head[1] = 111n;
  ch.base.set(W1, 0n);
  await clock.go(40_000);
  await t.positions();
  await clock.go(1_000);
  assert.deepEqual(await look(), []);
  assert.ok(seen.every((r) => !r.includes("token 5")), `never the old amount: ${JSON.stringify(seen)}`);
  await t.signedOut();
});

test("the worst minute: ten holdings whose two RPCs disagree, a state read every second for ten minutes, the busiest 60 s on one Base RPC", async () => {
  const w = await wallet();
  const ch = { base: fakeChain(), robinhood: fakeChain() };
  const T10 = "0x" + "0d".repeat(20); // a token no other test's page read the decimals of (they are kept page-wide)
  const ws = Array.from({ length: 10 }, (_, i) => "0x" + (i + 0x31).toString(16).padStart(2, "0").repeat(20));
  for (const x of ws) ch.base.set(x, 1n, 2n);
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => Object.fromEntries(ws.map((x) => [x, rec("base", "filled", T10)])));
  const clock = pageClock();
  ch.base.clock = clock.now;
  const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => PINS[c],
    evmRpcs: (c) => ch[c].rpcs,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => fakeEvmPool(),
    positions: { setTimer: clock.setTimer, clearTimer: () => {} },
    positionsNow: clock.now,
  });
  for (let s = 0; s < 600; s++) {
    await t.positions();
    await clock.go(1_000);
  }
  await t.signedOut();
  const times = ch.base.calls[0]!.map((x) => x.t);
  let worst = 0;
  for (const a of times) worst = Math.max(worst, times.filter((b) => b >= a && b < a + 60_000).length);
  const tail = times.filter((b) => b >= 300_000).length / 5;
  console.log(`worst minute, 10 holdings, one Base RPC: ${worst} requests; a minute once the round is spent: ${tail}`);
  // the first minute: passes at 0.3, 5.3, 15.3, 35.3 and 55.3 s, each one eth_blockNumber and ten balanceOf, and the
  // token's decimals once; once the round is spent, one pass per 30 s from the state reads
  assert.equal(worst, 5 * 11 + 1);
  assert.equal(tail, 2 * 11);
});
