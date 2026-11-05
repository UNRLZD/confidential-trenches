// node --test apps/helper/src/data/evm/swaps-hook.test.ts: a v4 pool whose hook takes a cut of the swapper's leg
// (card helper-robinhood-swaps). The fixture (fixtures/swaps-robinhood-hook.json, built 2026-11-04 20:2xZ from
// robinhood.drpc.org and robinhood.daybreak-rpc.network, every answer the same on both) holds the five receipts the
// helper's live check sampled in run 41899807434 (19:49Z) on token 0xe23c6618... and its native ETH pool 0x996abff8...,
// whose hook PonsV2MemeHook 0xe5e70264... takes 2.75% of a buy's token leg after the PoolManager logs `Swap`, and the
// ETH / USDG price pool's logs before them. The live check failed 3 of 5 there: each buy's tape amount was the pool's,
// which no Transfer moved; the buyer got the pool's less the hook's take.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBook, type Event } from "../candles.ts";
import { createSwaps, decodeRef, decodeSwap, hookOf, hookTakes, poolFilters, ROBINHOOD_VENUES, TOPIC, traderLeg, v4Key, type Log, type Pool } from "./swaps.ts";

type RecLog = { a: string; t: string[]; d: string; b: number; i: number; tx: string; ts: number };
type Fix = { head: number; headTime: number; receipts: Record<string, { from: string; status: string; logs: RecLog[] }>; ref: RecLog[] };
const FIX = JSON.parse(readFileSync(new URL("./fixtures/swaps-robinhood-hook.json", import.meta.url), "utf8")) as Fix;
const COIN = "0xe23c6618091c137f56d8486d25492311ccf33ab8";
const ID = "0x996abff8b56cc8a0b3491fd991cf0ff43ebff7248c7d0e8a0fe1580120fa8ec7";
const HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
const PM = ROBINHOOD_VENUES.poolManager;
const POOL: Pool = { venue: "v4", id: ID, token: COIN, tokenIs0: false, quote: { kind: "eth", decimals: 18 }, hook: HOOK };
const toLog = (l: RecLog): Log => ({ block: l.b, index: l.i, tx: l.tx, address: l.a, topics: l.t, data: l.d, t: l.ts });
const txLogs = Object.values(FIX.receipts).flatMap((r) => r.logs);
const addr = (w: string) => `0x${w.slice(26)}`;
const isTransfer = (l: RecLog) => l.a === COIN && l.t[0] === TOPIC.transfer && l.t.length === 3;

/** What each sampled trade's trader got or paid in the token, by its receipt: a buy, the PoolManager's transfer to anyone
 *  but the hook; a sell, the transfer into the PoolManager. */
const truth = new Map(
  Object.entries(FIX.receipts).map(([tx, r]) => {
    const out = r.logs.filter((l) => isTransfer(l) && addr(l.t[1]!) === PM && addr(l.t[2]!) !== HOOK);
    const into = r.logs.filter((l) => isTransfer(l) && addr(l.t[2]!) === PM);
    const [m] = out.length === 1 ? out : into;
    return [tx, { side: out.length === 1 ? "b" : "s", amt: BigInt(m!.d) }];
  }),
);

test("the fixture is the live check's red: five succeeded receipts with one swap of the pool each, three buys and two sells, each buy's Swap leg more than any Transfer moved", () => {
  assert.equal(Object.keys(FIX.receipts).length, 5);
  let buys = 0;
  for (const [tx, r] of Object.entries(FIX.receipts)) {
    assert.equal(r.status, "0x1", tx);
    const swaps = r.logs.map(toLog).filter((l) => decodeSwap(POOL, l, "robinhood") !== null);
    assert.equal(swaps.length, 1, tx);
    const s = decodeSwap(POOL, swaps[0]!, "robinhood")!;
    assert.equal(s.side, truth.get(tx)!.side, tx);
    if (s.side === "b") {
      buys++;
      assert.ok(!r.logs.some((l) => isTransfer(l) && BigInt(l.d) === s.amt), `${tx}: no transfer of the pool's leg`);
    }
  }
  assert.equal(buys, 3);
});

test("hookOf: the pool's real key (it hashes to the id) names the hook, whose address carries afterSwap's return-delta flag; a hook with neither flag, or none, is no hook", () => {
  const r = FIX.receipts["0x2446469cca353ce4afab4f4c99cfef6f79db7cb5095705b07b5f42a5cd9883a0"]!;
  const swap = r.logs.find((l) => l.t[0] === TOPIC.swap4 && l.t[1] === ID)!;
  const key = v4Key(ID, COIN, Number(BigInt(`0x${swap.d.slice(2 + 64 * 5)}`)), r.logs.map((l) => l.a), "robinhood");
  assert.ok(key !== null, "the key is found and hashes to the id");
  assert.equal(hookOf(key!), HOOK);
  const withHook = (h: string) => `${key!.slice(0, 2 + 64 * 4)}${h.slice(2).padStart(64, "0")}`;
  assert.equal(hookOf(withHook(`0x${"0".repeat(40)}`)), undefined);
  assert.equal(hookOf(withHook(`0x${"1".repeat(36)}0040`)), undefined, "afterSwap alone, no return delta");
  assert.equal(hookOf(withHook(`0x${"1".repeat(36)}0008`)), `0x${"1".repeat(36)}0008`, "beforeSwap's return delta");
  assert.equal(hookOf("0x12"), undefined);
});

test("poolFilters: a hooked pool's read is three filters with one address each: the pool's swaps with its other PoolManager calls (one topic list, the pool's id, and its siblings' ids when the discovery found any), every transfer of the token, and the PoolManager's ERC-6909 claims of the token (card helper-v4-hook-liquidity: what each swap's sender took or paid, and a hook's cut minted as claims); an unhooked pool's, its swaps alone", () => {
  const f = poolFilters(POOL, 10, 109, "robinhood");
  assert.equal(f.length, 3);
  assert.deepEqual(f[0], { address: PM, topics: [[TOPIC.swap4, TOPIC.initialize, TOPIC.modifyLiquidity, TOPIC.donate], ID], fromBlock: "0xa", toBlock: "0x6d" });
  assert.deepEqual(f[1], { address: COIN, topics: [TOPIC.transfer], fromBlock: "0xa", toBlock: "0x6d" });
  assert.deepEqual(f[2], { address: PM, topics: [TOPIC.claims, null, null, `0x${COIN.slice(2).padStart(64, "0")}`], fromBlock: "0xa", toBlock: "0x6d" });
  const sib = `0x${"5".repeat(64)}`;
  assert.deepEqual(poolFilters({ ...POOL, siblings: [sib] }, 10, 109, "robinhood")[0], { address: PM, topics: [[TOPIC.swap4, TOPIC.initialize, TOPIC.modifyLiquidity, TOPIC.donate], [ID, sib]], fromBlock: "0xa", toBlock: "0x6d" });
  const { hook: _, ...plain } = POOL;
  assert.deepEqual(poolFilters(plain, 10, 109, "robinhood"), [{ address: PM, topics: [TOPIC.swap4, ID], fromBlock: "0xa", toBlock: "0x6d" }]);
});

test("hookTakes and traderLeg on the real receipts: each buy's leg is the pool's less the hook's take, exactly what the buyer was sent; a sell's is the pool's", () => {
  const logs = txLogs.map(toLog).sort((a, b) => a.block - b.block || a.index - b.index);
  const takes = hookTakes(POOL, logs, "robinhood");
  for (const l of logs) {
    const s = decodeSwap(POOL, l, "robinhood");
    if (s === null) continue;
    const want = truth.get(l.tx)!;
    assert.equal(traderLeg(s, takes.get(`${l.tx}:${l.index}`)) ?? s.amt, want.amt, l.tx);
    if (s.side === "s") assert.equal(takes.get(`${l.tx}:${l.index}`), undefined, `${l.tx}: the hook takes a sell's cut in ETH`);
  }
  // an unhooked pool, a hook's own swap, and a cut that would leave nothing: the pool's leg stands
  const { hook: _, ...plain } = POOL;
  assert.equal(hookTakes(plain, logs, "robinhood").size, 0);
  const self = logs.map((l) => (l.topics[0] === TOPIC.swap4 ? { ...l, topics: [l.topics[0], l.topics[1]!, `0x${HOOK.slice(2).padStart(64, "0")}`] } : l));
  assert.equal(hookTakes(POOL, self, "robinhood").size, 0);
  assert.equal(traderLeg({ side: "b", amt: 5n }, 5n), undefined);
  assert.equal(traderLeg({ side: "s", amt: 5n }, 2n), 7n, "a hook that takes a sell's token: the seller paid more");
});

/** Two providers that answer the fixture alike. */
function fakeChain() {
  const all = [...txLogs, ...FIX.ref];
  const match = (want: unknown, have: string | undefined) => want === null || want === undefined || (Array.isArray(want) ? want.includes(have) : want === have);
  return async (_url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const out = reqs.map((r) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      if (r.method === "eth_getBlockByNumber") return ok({ number: `0x${FIX.head.toString(16)}`, timestamp: `0x${FIX.headTime.toString(16)}` });
      if (r.method === "eth_getLogs") {
        const q = r.params[0] as { address: string; topics: unknown[]; fromBlock: string; toBlock: string };
        const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
        if (typeof q.address !== "string" || to - from + 1 > 100) return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "invalid_params" } };
        const hits = all.filter((l) => l.a === q.address && l.b >= from && l.b <= to && q.topics.every((t, i) => match(t, l.t[i])));
        return ok(hits.sort((a, b) => a.b - b.b || a.i - b.i).map((l) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${l.ts.toString(16)}`, removed: false })));
      }
      if (r.method === "eth_getTransactionByHash") return ok({ hash: r.params[0], from: FIX.receipts[r.params[0] as string]?.from });
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no" } };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("the helper's tape of the hooked pool: every trade's amt is the token its trader got or paid, the Transfer the live check looks for; its bars are the pool's own legs", async () => {
  const s = createSwaps("robinhood", { fetch: fakeChain(), now: () => 1_000_000, listed: async () => true, rpcs: ["https://a.test", "https://b.test"], pools: new Map([[COIN, { pool: POOL, decimals: 18 }]]), tickMs: 0 });
  const tape = JSON.parse((await s.trades(COIN, 50)).body);
  const bars = JSON.parse((await s.candles(COIN, "1m", null, 60)).body);
  s.stop();
  assert.equal(tape.trades.length, 5, JSON.stringify(tape));
  for (const t of tape.trades) {
    const want = truth.get(t.tx)!;
    assert.equal(t.side, want.side, t.tx);
    const [w, f = ""] = t.amt.split(".");
    assert.equal(BigInt(w + f.padEnd(18, "0")), want.amt, `${t.tx}: amt ${t.amt}`);
    assert.equal(t.trader, FIX.receipts[t.tx]!.from);
  }
  // the bars: the same swaps with the pool's legs, as a rebuild from decodeSwap alone gives them
  const events: Event[] = [];
  for (const l of txLogs.map(toLog)) {
    const x = decodeSwap(POOL, l, "robinhood");
    if (x !== null) events.push({ ...x, t: l.t! });
  }
  for (const l of FIX.ref.map(toLog)) {
    const x = decodeRef(l, "robinhood");
    if (x !== null) events.push(x);
  }
  events.sort((a, b) => a.block - b.block || a.index - b.index);
  const book = createBook({ decimals: 18, quote: POOL.quote });
  book.ingest(0, events, FIX.head);
  assert.deepEqual(bars.candles, book.candles("1m", null, 60));
});
