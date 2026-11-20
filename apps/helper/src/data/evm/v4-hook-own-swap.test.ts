// node --test apps/helper/src/data/evm/v4-hook-own-swap.test.ts: card helper-v4-hook-trade-is-what-its-trader-paid. Live
// run 44489623436 (helper-v4-hook-liquidity, 19 Nov 09:05Z) read coin 0x5084b942's tape and found Base tx 0xb4503a57's
// sell served as 12.385647098245463604 for the 1,548.205887280682950584 its trader paid. The receipt
// (fixtures/v4-hook-own-swap.json, alike on two providers) holds two Swap logs of the coin's pool 0x27363f20 (ZORA /
// coin, dynamic fee, tick spacing 200, hooks 0x0469a4bd...c0): log 95, sender the trader's router 0x8f10b468, the
// 1,548.21 sell the trader paid in (Transfer log 93); and log 98, sender the pool's own hook, which after its two
// ModifyLiquidity logs (96, 97) sold 12.39 of the fees it holds in the PoolManager. The hook's address sets beforeSwap
// (1 << 7) and afterSwap (1 << 6) and neither return-delta bit, so the helper kept no hook for the pool and the rule that
// takes a hook's own swap off the tape never applied: GeckoTerminal served both swaps as the trader's sells (src
// coingecko), and the vendor row matched log 98's leg.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { exactRow, receiptFacts } from "./vendor-rows.ts";
import * as swaps from "./swaps.ts";
import { createSwaps, decodeSwap, hookOf, hookTakes, poolFilters, TOPIC, VENUES, type Log, type Pool } from "./swaps.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

type RLog = { address: string; topics: string[]; data: string; logIndex: string };
type Fix = { coin: string; decimals: number; pool: string; key: string; rows: { tx: string; side: "b" | "s"; amt: string }[]; tx: { hash: string; from: string; to: string }; receipt: { transactionHash: string; status: string; from: string; to: string; blockNumber: string; logs: RLog[] } };
const F = JSON.parse(readFileSync(new URL("./fixtures/v4-hook-own-swap.json", import.meta.url), "utf8")) as Fix;
/** The proof the vendor rows take (named off the import, so the file loads where it is missing and its tests fail). */
/** Its pool's key as createSwaps poolKeyOf reads it once a pool (the recorded key, F.key; card
 *  helper-vendor-tapes-refresh-inside-15s), any other pool none. */
const provenHooks = (f: Parameters<typeof exactRow>[3], token: string): Promise<Parameters<typeof exactRow>[3]> =>
  (swaps as unknown as Record<string, (f: unknown, t: string, keyOf: (id: string) => Promise<string | null>) => Promise<Parameters<typeof exactRow>[3]>>).provenHooks!(f, token, async (id) => (id === F.pool ? F.key : null));
const HOOK = "0x0469a4bd3724dc86c9542f4694c976da13c450c0";
const ROUTER = "0x8f10b468b06c6fd214b65f87778827f7d113f996";
/** The user operation's account (the bundle went to EntryPoint v0.6): the trader every row names. */
const ACCOUNT = "0x26d7c9620185a972e35c79f94ef0be4a8ba2faa1";
const PAID = 1548205887280682950584n;
const PM = VENUES.base.poolManager;
const TX = F.receipt.transactionHash;
const BLOCK = parseInt(F.receipt.blockNumber, 16);
const logs: Log[] = F.receipt.logs.map((l) => ({ block: BLOCK, index: parseInt(l.logIndex, 16), tx: TX, address: l.address, topics: l.topics, data: l.data, t: 1_795_077_239 }));
const keccak = (hex: string) => `0x${Buffer.from(keccak_256(Buffer.from(hex.slice(2), "hex"))).toString("hex")}`;
/** The pool as the discovery builds one from its key (swaps.ts v4Pool): the coin is currency1, the hook as hookOf names it. */
const hook = hookOf(F.key);
const POOL: Pool = { venue: "v4", id: F.pool, token: F.coin, tokenIs0: false, quote: { kind: "usd", decimals: 18 }, ...(hook === undefined ? {} : { hook }) };

test("the recorded transaction: the key hashes to the pool id, its hook sets beforeSwap and afterSwap and no return-delta bit; log 95 is the trader's 1,548.21 sell and log 98 the hook's own 12.39", () => {
  assert.equal(keccak(F.key), F.pool);
  assert.equal(`0x${F.key.slice(-40)}`, HOOK);
  assert.equal(BigInt(HOOK) & 0xffn, 0xc0n, "bits 7 and 6 (beforeSwap, afterSwap), not 3 or 2 (their return deltas)");
  const swaps = logs.filter((l) => l.address === PM && l.topics[0] === TOPIC.swap4 && l.topics[1] === F.pool);
  assert.deepEqual(swaps.map((l) => [l.index, `0x${l.topics[2]!.slice(26)}`]), [[95, ROUTER], [98, HOOK]]);
  const paid = logs.find((l) => l.address === F.coin && l.topics[0] === TOPIC.transfer && `0x${l.topics[2]!.slice(26)}` === PM)!;
  assert.equal(BigInt(paid.data), PAID);
});

test("hookOf names a pool's hook whatever its flags; only a return-delta hook adds the hook's reads (poolFilters) and cuts (hookTakes)", () => {
  assert.equal(hookOf(F.key), HOOK);
  assert.deepEqual(poolFilters(POOL, BLOCK, BLOCK), [{ address: PM, topics: [TOPIC.swap4, F.pool], fromBlock: `0x${BLOCK.toString(16)}`, toBlock: `0x${BLOCK.toString(16)}` }], "no transfers or claims read for a hook that cannot change a swapper's amounts");
  assert.equal(hookTakes(POOL, logs).size, 0);
  assert.equal(hookOf(`${F.key.slice(0, 2 + 64 * 4)}${"0".repeat(64)}`), undefined, "no hook");
});

/** Two providers that answer the recorded receipt alike, and its block as the head. */
function fakeChain() {
  const match = (want: unknown, have: string | undefined) => want === null || want === undefined || (Array.isArray(want) ? want.includes(have) : want === have);
  return async (_url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const out = reqs.map((r) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      if (r.method === "eth_getBlockByNumber") return ok({ number: `0x${BLOCK.toString(16)}`, timestamp: `0x${(1_795_077_239).toString(16)}` });
      if (r.method === "eth_getLogs") {
        const q = r.params[0] as { address: string; topics: unknown[]; fromBlock: string; toBlock: string };
        const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
        if (typeof q.address !== "string") return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "invalid_params" } };
        const hits = F.receipt.logs.filter((l) => l.address === q.address && BLOCK >= from && BLOCK <= to && q.topics.every((t, i) => match(t, l.topics[i])));
        return ok(hits.map((l) => ({ ...l, blockNumber: F.receipt.blockNumber, transactionHash: TX, blockTimestamp: `0x${(1_795_077_239).toString(16)}`, removed: false })));
      }
      if (r.method === "eth_getTransactionByHash") return ok({ hash: TX, from: F.tx.from, to: F.tx.to });
      if (r.method === "eth_getTransactionReceipt") return ok(F.receipt);
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no" } };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("the chain tape of the pool: the trader's 1,548.21 sell is its one trade of the transaction; the hook's own 12.39 is in the bars, off the tape", async () => {
  const s = createSwaps("base", { fetch: fakeChain(), now: () => 1_795_077_300_000, listed: async () => true, rpcs: ["https://a.test", "https://b.test"], pools: new Map([[F.coin, { pool: POOL, decimals: F.decimals }]]), tickMs: 0 });
  const tape = JSON.parse((await s.trades(F.coin, 50)).body);
  const bars = JSON.parse((await s.candles(F.coin, "1m", null, 60)).body);
  s.stop();
  const rows = tape.trades.filter((t: { tx: string }) => t.tx === TX);
  assert.deepEqual(rows.map((t: { side: string; amt: string }) => [t.side, t.amt]), [["s", "1548.205887280682950584"]], JSON.stringify(tape).slice(0, 400));
  // the bars hold both swaps' volume: the pool's price moved by each
  const both = [95, 98].map((i) => decodeSwap(POOL, logs.find((l) => l.index === i)!)!.amt).reduce((a, b) => a + b, 0n);
  assert.equal(both, PAID + 12385647098245463604n);
  assert.ok(bars.candles.length > 0, JSON.stringify(bars).slice(0, 200));
});

test("the vendor's rows: the hook's own swap (proven: a key with the hook's address hashes to the pool id) is no trade; the trader's sell is served as the 1,548.21 its account paid", async () => {
  const f = receiptFacts(F.receipt, TX, F.coin, PM);
  assert.ok(f !== null);
  // before the proof the hook's leg matches the vendor's 12.39, as the deployed helper served it
  assert.deepEqual(exactRow("s", F.rows[0]!.amt, F.decimals, f), { amt: "12.385647098245463604", trader: ACCOUNT });
  const proven = await provenHooks(f, F.coin);
  assert.deepEqual(proven.swaps?.filter((s) => s.hook).map((s) => s.index), [98]);
  assert.equal(exactRow("s", F.rows[0]!.amt, F.decimals, proven), null, "the hook's own swap is never served");
  assert.deepEqual(exactRow("s", F.rows[1]!.amt, F.decimals, proven), { amt: "1548.205887280682950584", trader: ACCOUNT });
  // the router's swap is no hook's: a key with its address hashes to no pool id it swapped
  assert.equal(proven.swaps?.find((s) => s.index === 95)?.hook, undefined);
});

test("a swap is proven its pool's hook's only by the hash: a second sender of the pool whose address makes no key of the pool is left as it was", async () => {
  const f = receiptFacts(F.receipt, TX, F.coin, PM)!;
  const other = `0x${"7".repeat(36)}00c0`;
  const forged = { ...f, swaps: f.swaps!.map((s) => (s.index === 98 ? { ...s, sender: other } : s)) };
  const proven = await provenHooks(forged, F.coin);
  assert.equal(proven.swaps?.some((s) => s.hook), false);
  assert.deepEqual(exactRow("s", F.rows[0]!.amt, F.decimals, proven), { amt: "12.385647098245463604", trader: ACCOUNT }, "unproven: as before");
});
