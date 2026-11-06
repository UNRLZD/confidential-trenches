// node --test apps/helper/src/data/evm/swaps-v4key.test.ts: a cold discovery never stops the helper's other reads while
// it works out a v4 pool's key (card robinhood-cold-open-fast). Read from the Mac 2026-11-05 16:3xZ on a fresh swaps
// instance, four listed Robinhood tokens opened at once: every post out to every provider sat 14 s and aborted at once
// while one discovery ran v4Key, which tries every pairing, fee, tick spacing and hook for a pool id the token's receipts
// name and blocked the event loop doing it (one miss: 0.7 s with no hook candidate, 1.7 s with 3, 5.4 s with 10, on the
// Mac). The ids it missed were pools the PositionManager knows whose key pairs other tokens (a route's other hop) or the
// token with no quote of ours (0x2e8c3116, 0x98096d17 and 0x42afa212 pair their own launchpad's quote token): their key
// already hashes to the id, so no search can find another.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, open, REC, timeAt, URLS } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { ROBINHOOD_VENUES, TOPIC } from "./swaps.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const hash = (k: string) => `0x${Buffer.from(keccak_256(Buffer.from(k.slice(2), "hex"))).toString("hex")}`;
const key = (c0: string, c1: string, fee: number, ts: number, hook: string) => `0x${w(c0).slice(2)}${w(c1).slice(2)}${int(BigInt(fee))}${int(BigInt(ts))}${w(hook).slice(2)}`;
const ZERO = `0x${"0".repeat(40)}`;
const PM = ROBINHOOD_VENUES.poolManager;
const USDG = ROBINHOOD_VENUES.usdg;

/** The token, priced on its v4 pool against USDG (the PositionManager's key, no hook), and a pool of a route's other hop
 *  that its swaps' transactions also log: two other tokens, a hook. Each transaction logs ten more contracts. */
const TOKEN = "0x00000000000000000000000000000000c0de0001";
const MAIN_KEY = key(TOKEN, USDG, 3000, 60, ZERO);
const MAIN = hash(MAIN_KEY);
const HOP_KEY = key("0x00000000000000000000000000000000aaaa0001", "0x00000000000000000000000000000000bbbb0001", 0x800000, 8, "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544");
const HOP = hash(HOP_KEY);
const AROUND = Array.from({ length: 10 }, (_, i) => `0x${(0xdead00 + i).toString(16).padStart(40, "0")}`);
const SWAPS = 20;

/** The fake chain (test/evm-swaps/robinhood.ts) with the token's transfers, swaps and receipts. `hopKnown`: the
 *  PositionManager holds the hop pool's key (else it answers none, as for a pool it never made). */
function rig(hopKnown: boolean) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const head = REC.lastHead;
  type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
  const transfers: L[] = [];
  const swaps: L[] = [];
  const receipts = new Map<string, L[]>();
  for (let k = 0; k < SWAPS; k++) {
    const b = head - 2_900 + k * 140;
    const tx = `0x${"cd".repeat(31)}${k.toString(16).padStart(2, "0")}`;
    const trader = `0x${tx.slice(26, 66)}`;
    const amt = 1_000n * 10n ** 18n + BigInt(k);
    const t: L = { b, i: 12, tx, a: TOKEN, t: [TOPIC.transfer, w(PM), w(trader)], d: `0x${int(amt)}` };
    // a buy: the swapper got the token (amount0, the token's, positive) and paid USDG
    const s: L = { b, i: 11, tx, a: PM, t: [TOPIC.swap4, MAIN, w(trader)], d: `0x${int(amt)}${int(-(5_000_000n + BigInt(k)))}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}${int(3000n)}` };
    const hop: L = { b, i: 10, tx, a: PM, t: [TOPIC.swap4, HOP, w(trader)], d: `0x${int(-5n)}${int(7n)}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}${int(0x2000n)}` };
    transfers.push(t);
    swaps.push(s);
    receipts.set(tx, [...AROUND.map((a, i): L => ({ b, i, tx, a, t: [TOPIC.transfer], d: "0x" })), hop, s, t]);
  }
  const wire = (l: L) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${timeAt(l.b).toString(16)}`, removed: false });
  const local = (r: { method: string; params: unknown[] }): unknown => {
    if (r.method === "eth_getLogs") {
      const q = r.params[0] as { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
      const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      const in_ = (l: L) => l.b >= from && l.b <= to;
      if (q.address === TOKEN) return { result: transfers.filter(in_).map(wire) };
      if (q.address === PM && q.topics?.[1] === MAIN) return { result: swaps.filter(in_).map(wire) };
      if (q.address === PM && q.topics?.[1] === HOP) return { result: [] };
      return undefined;
    }
    if (r.method === "eth_getTransactionReceipt") {
      const l = receipts.get(r.params[0] as string);
      return l === undefined ? undefined : { result: { transactionHash: r.params[0], logs: l.map(wire) } };
    }
    if (r.method === "eth_call") {
      const c = r.params[0] as { to: string; data: string };
      if (c.to !== ROBINHOOD_VENUES.positionManager) return undefined;
      if (c.data === `0x86b6be7d${MAIN.slice(2, 52).padEnd(64, "0")}`) return { result: MAIN_KEY };
      if (c.data === `0x86b6be7d${HOP.slice(2, 52).padEnd(64, "0")}`) return { result: hopKnown ? HOP_KEY : `0x${"0".repeat(320)}` };
      return undefined;
    }
    return undefined;
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map(local);
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch };
}

/** The longest the event loop went without running a 10 ms timer while `p` ran, and `p`'s value. */
async function stallOf<T>(p: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
  let last = performance.now();
  let stallMs = 0;
  const t = setInterval(() => {
    const at = performance.now();
    stallMs = Math.max(stallMs, at - last);
    last = at;
  }, 10);
  try {
    const value = await p();
    stallMs = Math.max(stallMs, performance.now() - last);
    return { value, stallMs };
  } finally {
    clearInterval(t);
  }
}

/** [design: 1 s, half a hedge (swaps.ts HEDGE_MS): a stall past it ages every post out toward a hedge that is no
 *  provider's fault; one v4Key miss with ten hook candidates stalled 5.4 s on the Mac, these tests' 3.1 s and 4.0 s at
 *  6509fd7, and a first run's own compile and collection pauses reached 344 ms (2 of 8 runs over 250 ms).] */
const STALL_MAX_MS = 1_000;

for (const hopKnown of [true, false]) {
  test(`card robinhood-cold-open-fast: a cold token whose swaps' transactions also log a route's other pool ${hopKnown ? "the PositionManager knows (its key pairs two other tokens)" : "the PositionManager never made (no key: worked out by search, which misses)"} is found and served while the event loop never stalls a second (red at 6509fd7: v4Key's search ran in one go, seconds)`, async () => {
    const r = rig(hopKnown);
    const clock = { get t() { return Date.now(); } };
    const s = open(r.chain, clock, { pools: new Map(), fetch: r.fetch as never });
    const { value: a, stallMs } = await stallOf(() => s.trades(TOKEN, 50));
    s.stop();
    assert.equal(a.status, 200, a.body);
    assert.equal((JSON.parse(a.body) as { trades: unknown[] }).trades.length, SWAPS, "the token's own tape, from its USDG pool");
    assert.ok(stallMs <= STALL_MAX_MS, `the event loop stalled ${Math.round(stallMs)} ms`);
  });
}

// A discovery's receipts (v4Seen) are one provider's read: at 6509fd7 the provider with the most free budget, which on
// Robinhood is robinhood.api.pocket.network (a 200-call burst), and the slowest: its three receipts took 3.4 s, 3.7 s
// and 1.1 s while every other provider answered in 0.3 s (the Mac, 2026-11-05 16:4xZ, four cold opens at once).
test("card robinhood-cold-open-fast: a discovery asks its receipts, and the tape its senders, of the providers expected to answer first, not of the one with the most free budget that answers 2 s late (red at 6509fd7: every receipt read went to it)", async () => {
  const r = rig(true);
  const SLOW = URLS[0]!;
  const receipts = new Map<string, number>();
  const senders = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = String(init.body);
    if (body.includes("eth_getTransactionReceipt")) receipts.set(url, (receipts.get(url) ?? 0) + 1);
    if (body.includes("eth_getTransactionByHash")) senders.set(url, (senders.get(url) ?? 0) + 1);
    await new Promise((go) => setTimeout(go, url === SLOW ? 2_000 : 50));
    return r.fetch(url, init);
  };
  const { value: a } = await onVirtualTime(9_000_000, async () => {
    // the slow one's bucket is the biggest: 1,000 calls (pocket's is 200, every other's 25 or less)
    const holds = providerHolds(() => Date.now(), { [SLOW]: { perS: 100, burst: 1_000, unit: "call" } });
    const s = open(r.chain, { get t() { return Date.now(); } }, { pools: new Map(), fetch: fetch as never, holds });
    const got = await s.trades(TOKEN, 50);
    s.stop();
    return got;
  });
  assert.equal(a.status, 200, a.body);
  assert.equal((JSON.parse(a.body) as { trades: unknown[] }).trades.length, SWAPS);
  assert.equal(receipts.get(SLOW) ?? 0, 0, `receipts asked of the slow provider: ${JSON.stringify([...receipts])}`);
  // the tape's senders (lookTraders) alike: at 439ab7b split by free budget, the slow one's share the biggest
  assert.equal(senders.get(SLOW) ?? 0, 0, `senders asked of the slow provider: ${JSON.stringify([...senders])}`);
});

test("card helper-restart-fresh: a cold v4 token whose PoolManager receipts no provider reads (each answers them with an error) answers 503 and is looked for again, never kept as \"no pool\" and served an empty tape; once the receipts read, its own tape is served (red at bfb9e938: 200 with no trades)", async () => {
  const r = rig(true);
  const st = { down: true, asked: 0 };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string }[];
    if (!st.down || !reqs.some((q) => q.method === "eth_getTransactionReceipt")) return r.fetch(url, init);
    st.asked++;
    // a busy provider's answer to each receipt: an error, the rest of the batch as the chain answers
    const out = (await (await r.fetch(url, init)).json()) as { id: number }[];
    const err = (id: number) => ({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } });
    return new Response(JSON.stringify(out.map((x) => (reqs.find((q) => q.id === x.id)?.method === "eth_getTransactionReceipt" ? err(x.id) : x))), { status: 200, headers: { "content-type": "application/json" } });
  };
  const s = open(r.chain, { get t() { return Date.now(); } }, { pools: new Map(), fetch: fetch as never });
  const unread = await s.trades(TOKEN, 50);
  st.down = false;
  const read = await s.trades(TOKEN, 50);
  s.stop();
  assert.ok(st.asked > 0, "the discovery asked for the receipts");
  assert.equal(unread.status, 503, `a discovery whose receipts went unread: ${unread.body}`);
  assert.deepEqual(JSON.parse(unread.body), { error: { code: "upstream" } });
  assert.equal(read.status, 200, read.body);
  assert.equal((JSON.parse(read.body) as { trades: unknown[] }).trades.length, SWAPS, "the token's own tape, found once its receipts read");
});
