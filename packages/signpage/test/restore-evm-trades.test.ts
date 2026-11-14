// Card closed-positions-show-every-trade: a device restored from the 12 words, or signed in again, gets its Base and
// Robinhood round trips back as trade ops, so Portfolio's closed positions show them. The owner's CASHCAT round trip on
// Robinhood, 13 Nov (fixtures/evm-trades/cashcat.json: the pool's Bought and Deposited logs, their blocks and the token's
// decimals, the same answers on rpc.mainnet.chain.robinhood.com and robinhood.api.pocket.network): the buy
// 0xd55fa259 (21:05:12Z) and the sale's deposit back 0x6de337ed (21:06:40Z). The restore's spend and deposit back are
// what ../../wallet/src/pool/evm-restore.ts gives for them (the release's _value, _fee and _out; the deposit's _value).
//   node --test test/restore-evm-trades.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore } from "@blindfill/wallet/store";
import type { Operation } from "../../kit/src/signpage/messages.ts";
import * as evmSell from "../src/pool-sell-evm.ts";
import { evmTradeKey, evmTradeOp, writeEvmTradeOp } from "../src/pool-buy-evm.ts";
import { opOf } from "../src/state.ts";
import { closedRows, tradeBook, type PortfolioData } from "../../../apps/terminal/src/screens/portfolio/model.ts";

type Log = { topics: string[]; data: string; logIndex: string; transactionIndex: string; blockNumber: string; blockHash: string; transactionHash: string };
type Rec = { status: string; block: { number: string; hash: string; timestamp: string }; logs: Log[] };
const FIX = JSON.parse(readFileSync(new URL("./fixtures/evm-trades/cashcat.json", import.meta.url), "utf8")) as { pool: string; erc20: string; decimals: string; rpcs: Record<string, Record<string, Rec>> };
const BUY = "0xd55fa259c2122c23fb906ee25de6b55edc58aa2c1fd2abf1149adf62fb09c6df";
const SALE = "0x6de337eda1b3bcecc05171709977929b7585f84a458e4933cd2d3205fb867a83";
const TOPIC_BOUGHT = "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d";
const TOPIC_DEPOSITED = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
const [A, B] = Object.values(FIX.rpcs);
const words = (d: string): bigint[] => d.slice(2).match(/.{64}/g)!.map((w) => BigInt(`0x${w}`));

test("the recorded answers are the same on both RPCs, each transaction succeeded", () => {
  assert.deepEqual(A, B);
  for (const t of [BUY, SALE]) assert.equal(A![t]!.status, "0x1");
});

// the restore's spend and deposit back, from the pool's own logs
const bought = A![BUY]!.logs.find((l) => l.topics[0] === TOPIC_BOUGHT)!;
const deposited = A![SALE]!.logs.find((l) => l.topics[0] === TOPIC_DEPOSITED)!;
const W = `0x${bought.topics[1]!.slice(26)}`;
const bw = words(bought.data);
const dw = words(deposited.data);
const spend = { l: 7n, j: 0, note: "deposit:1:0", w: W, withdrawn: bw[1]!, block: BigInt(bought.blockNumber), token: `0x${bw[5]!.toString(16).padStart(40, "0")}`, blockHash: bought.blockHash, logIndex: BigInt(bought.logIndex), tx: bought.transactionHash, fee: bw[2]!, out: bw[6]! };
const back = { l: 7n, j: 0, note: "deposit:1:0", tx: deposited.transactionHash, block: BigInt(deposited.blockNumber), value: dw[2]! };

/** One RPC answering from the recorded answers: a block by number, the token's decimals. */
const recorded = (calls: string[]) => async (method: string, params: readonly unknown[]): Promise<unknown> => {
  calls.push(method);
  if (method === "eth_getBlockByNumber") {
    const r = Object.values(A!).find((x) => x.block.number === params[0]);
    return r ? { number: r.block.number, hash: r.block.hash, timestamp: r.block.timestamp } : null;
  }
  if (method === "eth_call" && (params[0] as { to: string }).to.toLowerCase() === FIX.erc20) return FIX.decimals;
  throw new Error(`not recorded: ${method}`);
};

const opsOf = async (w: Awaited<ReturnType<typeof openWalletStore>>): Promise<Operation[]> =>
  (await Promise.all((await w.keys("ops")).map(async (k) => opOf(k, await w.get("ops", k))))).filter((o): o is Operation => o !== null);

test("a restore writes the CASHCAT buy and its sale as the device that traded would: one closed position at their blocks' times", async () => {
  const restoreEvmTrades = (evmSell as Record<string, unknown>).restoreEvmTrades as typeof evmSell.restoreEvmTrades | undefined;
  assert.equal(typeof restoreEvmTrades, "function", "the restore writes the EVM trades");
  assert.equal(spend.token, FIX.erc20);
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  try {
    const calls: string[] = [];
    const wrote = await restoreEvmTrades!({ chain: "robinhood", read: recorded(calls) as never, store: w, spends: [spend], returns: [back] });
    assert.equal(wrote, 2);
    const buy = (await w.get("ops", evmTradeKey("robinhood", BUY))) as Record<string, unknown>;
    const sale = (await w.get("ops", evmTradeKey("robinhood", SALE))) as Record<string, unknown>;
    // 78.20499874395625728 CASHCAT for 0.002 ETH less the 0.00006 fee; 0.001880137434291065 ETH home
    assert.deepEqual(buy, { kind: "buy", stage: "filled", txs: [{ chain: "robinhood", hash: BUY }], created_ms: Date.parse("2026-11-13T21:05:12Z"), chain: "robinhood", token: FIX.erc20, units: "78.20499874395625728", pool_amount: "0.00194" });
    assert.deepEqual(sale, { kind: "sell", stage: "filled", txs: [{ chain: "robinhood", hash: SALE }], created_ms: Date.parse("2026-11-13T21:06:40Z"), chain: "robinhood", token: FIX.erc20, pool_amount: "0.001880137434291065" });
    const o = await opsOf(w);
    assert.equal(o.length, 2, "both pass the op schema");
    const closed = tradeBook(o, []).closed;
    assert.equal(closedRows({ closed, market: () => null } as unknown as PortfolioData).length, 1, "one closed position");
    assert.deepEqual([closed[0]!.opened_at, closed[0]!.closed_at, closed[0]!.bought_asset, closed[0]!.sold_asset], [Date.parse("2026-11-13T21:05:12Z"), Date.parse("2026-11-13T21:06:40Z"), "0.00194", "0.001880137434291065"]);
    // no read names W or a transaction: blocks and the token only
    assert.deepEqual([...new Set(calls)].sort(), ["eth_call", "eth_getBlockByNumber"]);
    // a second restore writes nothing twice
    assert.equal(await restoreEvmTrades!({ chain: "robinhood", read: recorded([]) as never, store: w, spends: [spend], returns: [back] }), 0);
  } finally {
    w.close();
  }
});

test("the device that traded keeps its own ops (with their USD): the restore writes none beside them", async () => {
  const restoreEvmTrades = (evmSell as Record<string, unknown>).restoreEvmTrades as typeof evmSell.restoreEvmTrades;
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  try {
    const own = evmTradeOp("buy", "robinhood", BUY, FIX.erc20, spend.out, 18, spend.withdrawn - spend.fee, { price: "310000000000", expo: -8, published_s: 1, read_ms: 1 }, 1);
    await writeEvmTradeOp(w, own);
    assert.equal(await restoreEvmTrades({ chain: "robinhood", read: recorded([]) as never, store: w, spends: [spend], returns: [back] }), 1, "the sale only");
    assert.deepEqual(await w.get("ops", evmTradeKey("robinhood", BUY)), own);
  } finally {
    w.close();
  }
});

test("a deposit back before the buy, under another note, or with no block read is no sale; a block the read cannot give is no op", async () => {
  const restoreEvmTrades = (evmSell as Record<string, unknown>).restoreEvmTrades as typeof evmSell.restoreEvmTrades;
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  try {
    const early = { ...back, block: spend.block - 1n };
    const other = { ...back, j: 1 };
    const lost = { ...back, block: back.block + 1n };
    assert.equal(await restoreEvmTrades({ chain: "robinhood", read: recorded([]) as never, store: w, spends: [spend], returns: [early, other, lost] }), 1, "the buy only");
    assert.deepEqual((await w.keys("ops")).sort(), [evmTradeKey("robinhood", BUY)]);
  } finally {
    w.close();
  }
});
