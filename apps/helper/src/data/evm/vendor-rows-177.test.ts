// card trades-checks-pass-on-177: the two tape faults helper live run 43977576335 read on ad9337504, on the receipts
// recorded in fixtures/vendor-rows-177.json (each alike on two or three public providers).
// - Base tx 0xe47f536a (helper-v4-hook-liquidity): token 0x297cb7de launched and bought in one transaction. Router
//   contract 0xc3ace431 called swap() (Swap log 19: the pool's 4,484.672111760212450903 out), the pool's hook 0x5e320ea6
//   (return-delta flags set) had 5.929089540616572954 of it minted as claims to 0x5dd237d1 (log 26), and the PoolManager
//   sent 0xc3ace431 the rest, 4,478.743022219595877949 (log 29), which went on through 0x5c65823d to the transaction's
//   sender 0x7099fea6 (logs 30, 33). GeckoTerminal's row prints the pool's 4484.67211176021; the vendor row served that
//   Swap leg.
// - Robinhood tx 0x8d950a97 (helper-tape-4337-trader): a bundle to EntryPoint v0.7 from bundler 0xfb32a11a, one user
//   operation of account 0x3e9741fd (BeforeExecution log 13, UserOperationEvent log 23) that bought 141,411.85 of token
//   0x6a3c037a on Pons curve 0x9140dcce (Transfer log 20, CurveBuy log 21).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { exactRow, receiptFacts } from "./vendor-rows.ts";
import { traderAt, txTraders } from "./index.ts";
import { decodeSwap, hookTakes, traderLeg, VENUES, type Log, type Pool } from "./swaps.ts";

type RLog = { address: string; topics: string[]; data: string; logIndex: string };
type Case = { chain: "base" | "robinhood"; coin: string; decimals: number; pool: string; rows: { tx: string; side: "b" | "s"; amt: string; vendorTrader: string }[]; txs: Record<string, { tx: Record<string, unknown>; receipt: { blockNumber: string; logs: RLog[] } & Record<string, unknown> }> };
const F = JSON.parse(readFileSync(new URL("./fixtures/vendor-rows-177.json", import.meta.url), "utf8")) as { hookCut: Case; bundle: Case };
const SENDER = "0x7099fea6504f0ca7611333d3dee1114e477e9321";
const ROUTER = "0xc3ace43169bbf51752b1603067f91ef60f8a662a";
const ACCOUNT = "0x3e9741fdcc064a3aa0a4bf2f3b1b823b5cc45191";

/** The chain tape's row for a v4 swap log of `pool` in the receipt: the pool's amount less the hook's cut (swaps.ts
 *  hookTakes and traderLeg, as apply builds it), and its trader (traderAt the swap's log). */
function chainRow(c: Case, pool: Pool, tx: string, index: number): { amt: bigint; trader: string | null } {
  const { tx: t, receipt } = c.txs[tx]!;
  const logs: Log[] = receipt.logs.map((l) => ({ block: parseInt(receipt.blockNumber, 16), index: parseInt(l.logIndex, 16), tx, address: l.address.toLowerCase(), topics: l.topics.map((x) => x.toLowerCase()), data: l.data.toLowerCase() }));
  const swap = logs.find((l) => l.index === index)!;
  const s = decodeSwap(pool, swap, c.chain)!;
  const takes = hookTakes(pool, logs, c.chain);
  return { amt: traderLeg(s, takes.get(`${tx}:${index}`)) ?? s.amt, trader: traderAt(txTraders(t, receipt) ?? undefined, index) };
}

test("Base tx 0xe47f536a: the vendor's 4484.67211176021 (the pool's leg) is served as the 4,478.743022219595877949 the swap's sender settled after the hook's cut, the chain tape's amount, under the transaction's sender", () => {
  const c = F.hookCut;
  const r = c.rows[0]!;
  const f = receiptFacts(c.txs[r.tx]!.receipt, r.tx, c.coin, VENUES.base.poolManager);
  assert.ok(f !== null);
  const got = exactRow(r.side, r.amt, c.decimals, f);
  assert.deepEqual(got, { amt: "4478.743022219595877949", trader: SENDER });
  // the chain tape reads the same transaction the same way: the hook 0x5e320ea6 has both return-delta flags
  const pool: Pool = { venue: "v4", id: c.pool, token: c.coin, tokenIs0: true, quote: { kind: "usd", decimals: 6 }, hook: "0x5e320ea6278107968c119942e57d876c5f922acc" };
  const chain = chainRow(c, pool, r.tx, 19);
  assert.equal(chain.amt, 4478743022219595877949n);
  assert.equal(chain.trader, SENDER);
  assert.equal(got!.amt, "4478.743022219595877949", "vendor row and chain tape alike");
  // the trader is the transaction's sender, the EOA the token reached (log 33); the Swap log's sender 0xc3ace431 is the
  // router contract that called swap() and passed the token on (logs 29, 30): it is no trader
  assert.notEqual(got!.trader, ROUTER);
});

test("a v4 Swap leg with no settlement of its sender read stays the pool's amount (a pool with no hook settles exactly it); a settlement past the pool's amount the wrong way is no cut", () => {
  const traders = { from: `0x${"11".repeat(20)}` };
  const [pm, router] = [VENUES.base.poolManager, `0x${"33".repeat(20)}`];
  const swap = { index: 5, sender: router };
  // the sender settled nothing of the token in this receipt: the leg stands
  assert.deepEqual(exactRow("b", "100", 0, { traders, moves: [{ index: 5, raw: "100", tier: 2, swap: true }, { index: 9, raw: "100", tier: 1, from: pm, to: traders.from }], swaps: [swap], net: [], callers: [] }), { amt: "100", trader: traders.from });
  // the sender got 97 of the pool's 100: 97
  assert.deepEqual(exactRow("b", "100", 0, { traders, moves: [{ index: 5, raw: "100", tier: 2, swap: true }, { index: 9, raw: "97", tier: 1, from: router, to: traders.from }], swaps: [swap], net: [[router, "97"]], callers: [] }), { amt: "97", trader: traders.from });
  // a buy's sender that got more than the pool paid out is no hook's cut (hookTakes reads none): the leg stands
  assert.deepEqual(exactRow("b", "100", 0, { traders, moves: [{ index: 5, raw: "100", tier: 2, swap: true }, { index: 9, raw: "100", tier: 1, from: pm, to: traders.from }], swaps: [swap], net: [[router, "120"]], callers: [] }), { amt: "100", trader: traders.from });
  // a seller that paid 104 for the pool's 100 in: 104
  assert.deepEqual(exactRow("s", "100", 0, { traders, moves: [{ index: 5, raw: "100", tier: 2, swap: true }, { index: 3, raw: "104", tier: 1, from: traders.from, to: router }], swaps: [swap], net: [[router, "-104"]], callers: [] }), { amt: "104", trader: traders.from });
  // a sender with two swaps in the transaction settles them together: no one swap's leg read, the pool's stands
  assert.deepEqual(exactRow("b", "100", 0, { traders, moves: [{ index: 5, raw: "100", tier: 2, swap: true }, { index: 9, raw: "100", tier: 1, from: pm, to: traders.from }], swaps: [swap, { index: 7, sender: router }], net: [[router, "60"]], callers: [] }), { amt: "100", trader: traders.from });
});

test("Robinhood tx 0x8d950a97: the bundle's buy names the user operation's account 0x3e9741fd on both paths, never the bundler 0xfb32a11a, and the receipt costs the tape its one read more", () => {
  const c = F.bundle;
  const r = c.rows[0]!;
  const { tx, receipt } = c.txs[r.tx]!;
  // the vendor row path (swaps.ts noneTrades -> exactOf -> exactRow)
  const f = receiptFacts(receipt, r.tx, c.coin, VENUES.robinhood.poolManager)!;
  assert.deepEqual(exactRow(r.side, r.amt, c.decimals, f), { amt: "141411.849891061976553921", trader: ACCOUNT });
  // the chain tape's lookup (swaps.ts lookTraders: the transaction, then for a bundle its receipt, txTraders)
  assert.equal(txTraders(tx, null), null, "a bundle's traders wait for its receipt");
  const t = txTraders(tx, receipt);
  assert.deepEqual(t, { ops: [{ lo: 13, hi: 23, sender: ACCOUNT }] });
  assert.equal(traderAt(t!, 21), ACCOUNT, "the curve's CurveBuy log");
  assert.equal(traderAt(t!, 20), ACCOUNT, "the token's Transfer to the account");
});
