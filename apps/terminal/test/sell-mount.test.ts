// The trade box's Sell side is live (card app-sell-mount): a held token sells from the box's Sell, from the pool. Red on
// a70ea92b, where the switch's Sell is drawn `disabled` with no handler and SellBox.tsx is imported by no screen.
// The position the Sell side sells is Portfolio's own Row of this chain and token (heldOf), never another chain's row of
// the same address; the sell asks pool.sell on a chain with a pool with the chain and the token amount only (the signing
// page picks the note, checks the quote and keeps a partial sell's deposit back over the floor); the box draws the one
// set of states in trade/States.tsx; and no new word.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { heldOf } from "../src/screens/portfolio/model.ts";
import type { Row } from "../src/screens/portfolio/model.ts";
import { sellAmount } from "../src/screens/positions/model.ts";
import { poolSellAsk } from "../src/screens/trade/model.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const MINT = "So1aNaMint1111111111111111111111111111111pump";
const EVM = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const row = (chain: Row["chain"], token: string, units: string): Row => ({
  key: `${chain}:${token}`, chain, token, symbol: "SYM", name: "Sym", units, cost: 100n, value: null, pnl: null, pnlBps: null,
  bought: 0n, sold: 0n, realized: 0n, mark: null, exit: null, wallets: 1, addresses: [], openedAt: null, selling: null,
});

test("the Sell side's position: this chain's row of this token, holding more than nothing", () => {
  const rows = [row("base", MINT, "5"), row("solana", MINT.toLowerCase(), "7"), row("solana", MINT, "1234.5"), row("robinhood", EVM.toLowerCase(), "2")];
  assert.equal(heldOf(rows, "solana", MINT)?.units, "1234.5");
  // a Solana mint is case-sensitive: the lower-cased one is another token
  assert.equal(heldOf([rows[1]!], "solana", MINT), null);
  // never another chain's row of the same address
  assert.equal(heldOf([rows[0]!], "solana", MINT), null);
  assert.equal(heldOf(rows, "base", EVM.toLowerCase()), null);
  // an EVM address matches in any case (its checksum is case alone)
  assert.equal(heldOf(rows, "robinhood", EVM)?.units, "2");
  // nothing held, no token, or an unreadable amount: no Sell side
  for (const u of ["0", "0.000", "", "x", "-1"]) assert.equal(heldOf([row("solana", MINT, u)], "solana", MINT), null, u);
  assert.equal(heldOf(rows, "solana", ""), null);
});

test("a partial sell asks pool.sell for the exact share of the row's own amount, on the row's chain, nothing else", () => {
  const pools = [{ chain: "solana" as const, asset: "SOL" as const, balance: "1" }, { chain: "base" as const, asset: "ETH" as const, balance: "1" }];
  const amount = sellAmount("1234.567891", 2500)!;
  assert.equal(amount, "308.641972");
  assert.deepEqual(poolSellAsk(pools, "solana", MINT, amount, 1000), { kind: "pool.sell", params: { chain: "solana", token: MINT, amount, slippage_bps: 1000 } });
  assert.deepEqual(poolSellAsk(pools, "base", EVM, "2", 1000)?.params.chain, "base");
  // no pool on the chain: no pool.sell
  assert.equal(poolSellAsk(pools, "robinhood", EVM, "2", 1000), null);
});

test("the switch's Sell is live: on with a held position, it draws SellBox from the box's one trade state", () => {
  const box = src("screens/trade/TradeBox.tsx");
  const sides = /<div className="trb-sides">([\s\S]*?)<\/div>/.exec(box)?.[1] ?? "";
  const sellBtn = sides.split("\n").find((l) => l.includes('<W id="sell" /></button>')) ?? "";
  assert.ok(sellBtn, "the switch has no Sell button");
  assert.doesNotMatch(sellBtn, / disabled(?=[ >])/, "the switch's Sell is drawn disabled whatever is held");
  assert.match(sellBtn, /disabled=\{t\.held === null \|\| running\}/, "Sell is not on exactly while a position is held and nothing runs");
  assert.match(sellBtn, /onClick=\{\(\) => t\.setSide\("sell"\)\}/, "Sell does not move the box to the sell side");
  // mounted: TradeBox imports SellBox and draws it for the sell side, with the box's footer
  assert.match(box, /^import \{ SellBox \} from "\.\.\/positions\/SellBox\.tsx";$/m, "SellBox is imported by no screen");
  assert.match(box, /if \(t\.onSell\) return <SellBox row=\{\{ \.\.\.t\.held!, symbol \}\} s=\{t\.sell\} slippageBps=\{slippageBps\} onBuy=\{\(\) => t\.setSide\("buy"\)\} footer=\{footer\} \/>;/);
  // the position is Portfolio's Row for this chain and token, signed in only; the sell is useSell's, one per trade state
  assert.match(box, /const heldNow = useHeld\(signedOut \? null : snapshot, chain, token\);/);
  assert.match(box, /const sell = useSell\(chain, token, slippageBps\);/);
  // the side never moves while a buy or a sell runs
  assert.match(box, /if \(!busy\(phaseRef\.current\) && !busy\(sell\.phase\)\) setSide\(x\);/);
  // the box asks the kit only through the buy's two sites: the sell's request is useSell's
  assert.equal(box.match(/kit\.request!\(/g)?.length, 2);
});

test("the sell asks pool.sell on a pool chain, from useSell only, and draws States.tsx's states", () => {
  const sell = src("screens/positions/source.tsx");
  assert.match(sell, /const ask = poolSellAsk\(src\.snapshot\.state\?\.pools, chain, token, amount, slippageBps\);/);
  assert.match(sell, /if \(!ready \|\| amount === null \|\| busy\(ref\.current\)\) return;/, "a double tap can send two sells");
  const sb = src("screens/positions/SellBox.tsx");
  assert.match(sb, /import \{ EndLine, hasRunLabel, RunLabel, stateId \} from "\.\.\/trade\/States\.tsx";/);
  assert.match(sb, /stateId\(s\.phase, now, "sell"\)/);
  assert.match(sb, /<EndLine phase=\{s\.phase\} side="sell" part=\{s\.part\} \/>/);
});

test("the phone bar's Sell opens the sheet on the sell side with a position, Buy on the buy side", () => {
  const page = src("screens/token/TokenPage.tsx");
  assert.match(page, /className="tkp-sell" onClick=\{\(\) => \{ if \(t\.held\) t\.setSide\("sell"\); sheet\.open\(\); \}\}/);
  assert.match(page, /className="tkp-buy" onClick=\{\(\) => \{ t\.setSide\("buy"\); sheet\.open\(\); \}\}/);
});

test("no new word: the sell side draws the trade box's and the positions table's words only", () => {
  for (const f of ["screens/trade/TradeBox.tsx", "screens/positions/SellBox.tsx"]) assert.doesNotMatch(src(f), />[A-Za-z][^<{]*</, `${f} draws a literal word`);
});
