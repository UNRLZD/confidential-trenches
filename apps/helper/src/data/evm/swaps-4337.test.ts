// node --test apps/helper/src/data/evm/swaps-4337.test.ts: a trade sent through an ERC-4337 smart account names that
// account as its trader on the tape, never the bundler that sent the transaction (card helper-tape-4337-trader).
// The fixtures hold real bundles, each transaction, receipt and block read alike on two providers, with the ETH price
// pool's swaps over the blocks a first read asks:
// - fixtures/swaps-4337-base.json (2026-11-05 11:02Z, base-rpc.publicnode.com and base.gateway.tenderly.co): Base tx
//   0xb2cabb87...2d00 to EntryPoint v0.7 from bundler 0xac7ca4b0..., two user operations, each one swapping on the
//   Slipstream WETH pool 0xb5f0b4ae... of token 0xbaa5cc21...: log 53 in account 0x8ef7a1b1...'s run (BeforeExecution at
//   44, its UserOperationEvent at 64), log 73 in account 0x6ef19e98...'s (its UserOperationEvent at 82).
// - fixtures/swaps-4337-robinhood.json (11:01Z, robinhood.drpc.org and robinhood.daybreak-rpc.network): Robinhood tx
//   0x85c994df...4bfd to EntryPoint v0.8 from bundler 0x4337316b..., one user operation of account 0x4a6dca90... that
//   sold token 0x7c612597... on its Pons curve 0x2b855f01... (log 9). The deployed helper's tape named the bundler
//   0x4337316b... as that trade's trader (read 2026-11-05 10:5xZ).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AGGREGATOR_CHANGED, BEFORE_EXECUTION, ENTRY_POINTS, traderAt, txTraders, USER_OP_EVENT } from "./index.ts";
import { createSwaps, type Pool } from "./swaps.ts";

type RLog = { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string; blockTimestamp?: string };
type Receipt = { transactionHash: string; from: string; to: string; status: string; blockNumber: string; blockTimestamp: string; logs: RLog[] };
type Tx = { hash: string; from: string; to: string; blockNumber: string };
type Fix = { chain: "base" | "robinhood"; coin: string; head: number; headTime: number; txs: Record<string, { tx: Tx; receipt: Receipt }>; ref: RLog[] };
const load = (c: string) => JSON.parse(readFileSync(new URL(`./fixtures/swaps-4337-${c}.json`, import.meta.url), "utf8")) as Fix;
const BASE = load("base");
const RH = load("robinhood");
const BUNDLE = "0xb2cabb877cc05d89ac226756978c621cba2df01d52131bc865a523f175a92d00";
const SOLD = "0x85c994dfee3d927d706d891733a807831faf810d819abf431112f483cabc4bfd";
const ACCOUNTS = { first: "0x8ef7a1b184a0aea45afd9cd0e8d85ede1fb0e8a4", second: "0x6ef19e98a6ceb81c3747c01662af806f8422cf2f", robinhood: "0x4a6dca900fade300dec1d795b065268dc216f69a" };
const BASE_POOL: Pool = { venue: "v3", id: "0xb5f0b4ae66c14f7efaa9aa1468e8fc536a3e288c", token: BASE.coin, tokenIs0: false, quote: { kind: "eth", decimals: 18 } };
const RH_POOL: Pool = { venue: "curve", id: "0x2b855f015723e0e4542afe16d6f66303d824eebf", token: RH.coin, tokenIs0: false, quote: { kind: "eth", decimals: 18 } };
const word = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const hex = (n: number) => `0x${n.toString(16)}`;

test("the recorded bundles: every one goes to an EntryPoint from its bundler, and the EntryPoint's own logs mark each user operation's run", () => {
  const b = BASE.txs[BUNDLE]!;
  assert.equal(b.tx.to, "0x0000000071727de22e5e9d8baf0edac6f37da032");
  assert.equal(b.tx.from, "0xac7ca4b036b55399cc8a4826347750bb29b3e9fe");
  const marks = b.receipt.logs.filter((l) => l.address === b.tx.to).map((l) => [parseInt(l.logIndex, 16), l.topics[0]]);
  assert.deepEqual(marks, [
    [44, BEFORE_EXECUTION],
    [64, USER_OP_EVENT],
    [82, USER_OP_EVENT],
  ]);
  const r = RH.txs[SOLD]!;
  assert.equal(r.tx.to, "0x4337084d9e255ff0702461cf8895ce9e3b5ff108");
  assert.equal(r.tx.from, "0x4337316b905049c7742687800dcce8833b1dbc2e");
  for (const f of [BASE, RH]) for (const { tx, receipt } of Object.values(f.txs)) assert.ok(ENTRY_POINTS.has(tx.to) && receipt.status === "0x1", tx.hash);
});

test("txTraders and traderAt on the real receipts: each swap's trader is the account whose user operation's run holds its log, never the bundler", () => {
  const b = BASE.txs[BUNDLE]!;
  const t = txTraders(b.tx, b.receipt);
  assert.deepEqual(t, { ops: [{ lo: 44, hi: 64, sender: ACCOUNTS.first }, { lo: 64, hi: 82, sender: ACCOUNTS.second }] });
  assert.equal(traderAt(t!, 53), ACCOUNTS.first);
  assert.equal(traderAt(t!, 73), ACCOUNTS.second);
  assert.equal(traderAt(t!, 44), null, "the EntryPoint's own mark is no operation's log");
  assert.equal(traderAt(t!, 40), null, "before BeforeExecution: validation, no operation's run");
  const r = RH.txs[SOLD]!;
  assert.equal(traderAt(txTraders(r.tx, r.receipt)!, 9), ACCOUNTS.robinhood);
});

test("txTraders: a transaction to no EntryPoint is its sender's, with no receipt read; a bundle with no receipt, another transaction's, or a malformed one has none, never the bundler's", () => {
  const b = BASE.txs[BUNDLE]!;
  const plain = { ...b.tx, to: "0x1111111111111111111111111111111111111111" };
  assert.deepEqual(txTraders(plain, null), { from: b.tx.from });
  assert.equal(traderAt(txTraders(plain, null)!, 53), b.tx.from);
  assert.equal(txTraders(b.tx, null), null);
  assert.equal(txTraders(b.tx, { ...b.receipt, transactionHash: SOLD }), null);
  assert.equal(txTraders(b.tx, { ...b.receipt, to: plain.to }), null);
  assert.equal(txTraders(b.tx, { ...b.receipt, logs: "no" }), null);
  const badSender = b.receipt.logs.map((l) => (l.logIndex === hex(64) ? { ...l, topics: [l.topics[0]!, l.topics[1]!, `0x${"f".repeat(64)}`, l.topics[3]!] } : l));
  assert.equal(txTraders(b.tx, { ...b.receipt, logs: badSender }), null, "a sender topic that is no address");
  assert.equal(traderAt(undefined, 53), null);
});

test("txTraders: only the EntryPoint's own logs mark a run: a UserOperationEvent or BeforeExecution any other contract logs moves nothing", () => {
  const b = BASE.txs[BUNDLE]!;
  const fake = (i: number, t: string[]): RLog => ({ address: "0x2222222222222222222222222222222222222222", topics: t, data: "0x", blockNumber: b.receipt.blockNumber, logIndex: hex(i), transactionHash: BUNDLE });
  // a contract inside the first operation's run logs a forged UserOperationEvent naming another account, at index 50
  const logs = [...b.receipt.logs.filter((l) => parseInt(l.logIndex, 16) < 50), fake(50, [USER_OP_EVENT, `0x${"1".repeat(64)}`, word("0x3333333333333333333333333333333333333333"), word("0x0000000000000000000000000000000000000000")]), fake(51, [BEFORE_EXECUTION]), ...b.receipt.logs.filter((l) => parseInt(l.logIndex, 16) > 51)];
  const t = txTraders(b.tx, { ...b.receipt, logs })!;
  assert.equal(traderAt(t, 53), ACCOUNTS.first);
  assert.equal(traderAt(t, 73), ACCOUNTS.second);
});

test("txTraders: handleAggregatedOps: each aggregator's group runs after its SignatureAggregatorChanged, so a group's first operation's run starts there", () => {
  const b = BASE.txs[BUNDLE]!;
  const ep = b.tx.to;
  // the second operation in a group of its own: the EntryPoint logs SignatureAggregatorChanged at 66 (after the first
  // operation's UserOperationEvent at 64); a log at 65 is between the groups, in no operation's run
  const logs = b.receipt.logs.map((l) => (l.logIndex === hex(66) ? { ...l, address: ep, topics: [AGGREGATOR_CHANGED, word("0x4444444444444444444444444444444444444444")], data: "0x" } : l));
  const t = txTraders(b.tx, { ...b.receipt, logs })!;
  assert.deepEqual(t, { ops: [{ lo: 44, hi: 64, sender: ACCOUNTS.first }, { lo: 66, hi: 82, sender: ACCOUNTS.second }] });
  assert.equal(traderAt(t, 65), null);
  assert.equal(traderAt(t, 73), ACCOUNTS.second);
});

/** Providers that answer a fixture (with `plain` swaps of the same pool in transactions to no EntryPoint), counting each
 *  method asked; `lie` changes one provider's receipts. */
function fakeChain(f: Fix, opts: { plain?: { hash: string; from: string; log: RLog }[]; lie?: (url: string, r: Receipt) => Receipt } = {}) {
  const asked = new Map<string, number>();
  const byTx = new Map<string, { tx: Tx; receipt: Receipt | null }>(Object.entries(f.txs));
  const logs: RLog[] = [...f.ref];
  for (const { receipt } of Object.values(f.txs)) logs.push(...receipt.logs.map((l) => ({ ...l, blockTimestamp: receipt.blockTimestamp })));
  for (const p of opts.plain ?? []) {
    logs.push(p.log);
    byTx.set(p.hash, { tx: { hash: p.hash, from: p.from, to: "0x5555555555555555555555555555555555555555", blockNumber: p.log.blockNumber }, receipt: null });
  }
  const match = (want: unknown, have: string | undefined) => want === null || want === undefined || (Array.isArray(want) ? want.includes(have) : want === have);
  const span = f.chain === "robinhood" ? 100 : 1000;
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const out = reqs.map((r) => {
      asked.set(r.method, (asked.get(r.method) ?? 0) + 1);
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      if (r.method === "eth_getBlockByNumber") return ok({ number: hex(f.head), timestamp: hex(f.headTime) });
      if (r.method === "eth_getLogs") {
        const q = r.params[0] as { address: string; topics: unknown[]; fromBlock: string; toBlock: string };
        const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
        if (typeof q.address !== "string" || to - from + 1 > span) return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "invalid_params" } };
        const hits = logs.filter((l) => l.address === q.address && parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to && q.topics.every((t, i) => match(t, l.topics[i])));
        return ok(hits.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)).map((l) => ({ ...l, removed: false })));
      }
      if (r.method === "eth_getTransactionByHash") return ok(byTx.get(r.params[0] as string)?.tx ?? null);
      if (r.method === "eth_getTransactionReceipt") {
        const x = byTx.get(r.params[0] as string)?.receipt ?? null;
        return ok(x === null || opts.lie === undefined ? x : opts.lie(url, x));
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no" } };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, asked };
}

async function tape(f: Fix, pool: Pool, chain = fakeChain(f)) {
  const s = createSwaps(f.chain, { fetch: chain.fetchFn, now: () => (f.headTime + 5) * 1000, listed: async () => true, rpcs: ["https://a.test", "https://b.test"], pools: new Map([[f.coin, { pool, decimals: 18 }]]), tickMs: 0 });
  const r = await s.trades(f.coin, 50);
  s.stop();
  assert.equal(r.status, 200, r.body);
  return (JSON.parse(r.body) as { trades: { tx: string; trader: string | null; side: string }[] }).trades;
}

test("Base: a bundle of two user operations on the token's tape names each swap's own account, never the bundler 0xac7ca4b0", async () => {
  const trades = await tape(BASE, BASE_POOL);
  const mine = trades.filter((t) => t.tx === BUNDLE);
  assert.equal(mine.length, 2, JSON.stringify(trades));
  // newest first: log 73, then log 53
  assert.deepEqual(
    mine.map((t) => t.trader),
    [ACCOUNTS.second, ACCOUNTS.first],
  );
});

test("Robinhood: a trade sent through a smart account (EntryPoint v0.8) names the account 0x4a6dca90 on the tape, never the bundler 0x4337316b", async () => {
  const trades = await tape(RH, RH_POOL);
  assert.equal(trades.length, 1, JSON.stringify(trades));
  assert.equal(trades[0]!.tx, SOLD);
  assert.equal(trades[0]!.trader, ACCOUNTS.robinhood);
});

test("the receipt costs one read more for a transaction sent to an EntryPoint only: a plain swap's trader is its sender, with no receipt asked for it", async () => {
  const b = BASE.txs[BUNDLE]!;
  const swap = b.receipt.logs.find((l) => l.logIndex === hex(53))!;
  const hash = `0x${"7".repeat(64)}`;
  const from = "0x6666666666666666666666666666666666666666";
  const plain = [{ hash, from, log: { ...swap, logIndex: hex(90), transactionHash: hash, blockTimestamp: b.receipt.blockTimestamp } }];
  const chain = fakeChain(BASE, { plain });
  const trades = await tape(BASE, BASE_POOL, chain);
  assert.equal(trades.find((t) => t.tx === hash)?.trader, from);
  // two providers asked the one bundle's receipt, alike; never the plain transaction's
  assert.equal(chain.asked.get("eth_getTransactionReceipt"), 2);
});

test("a receipt two providers do not give alike names no trader: the bundle's trades show none, never the bundler", async () => {
  const lie = (url: string, r: Receipt): Receipt => (url !== "https://b.test" ? r : { ...r, logs: r.logs.map((l) => (l.logIndex === hex(64) ? { ...l, topics: [l.topics[0]!, l.topics[1]!, word("0x9999999999999999999999999999999999999999"), l.topics[3]!] } : l)) });
  const trades = await tape(BASE, BASE_POOL, fakeChain(BASE, { lie }));
  const mine = trades.filter((t) => t.tx === BUNDLE);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((t) => t.trader === null), JSON.stringify(mine));
});
