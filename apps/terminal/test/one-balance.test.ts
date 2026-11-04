// One balance (card app-portfolio-mount): the header, the deposit sheet, the withdraw screen, the restore screen and
// Portfolio's Cash tile all draw one number, the cash in Portfolio's totals() (the design-lock-r5 header shows Cash), so
// they can never differ. Held two ways: no file but the portfolio model sums the signing page's balances, and the
// header's model given that number draws exactly Portfolio's Cash on states where a second sum would differ (a USDC
// pool, money on the way, a priced position).
//   node --test apps/terminal/test/one-balance.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { balanceOf, NO_DATA, portfolio } from "../src/screens/portfolio/model.ts";
import type { PortfolioData } from "../src/screens/portfolio/model.ts";
import { headerModel, restoreModel } from "../src/screens/signin/model.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));

// Code that reads the vault's cash, and why it is not a second total. Comments do not count.
const NOT_A_TOTAL: Record<string, string> = {
  "screens/trade/TradeBox.tsx": "the buy side's Bal: the vault's cash a buy spends from, one field, never a total",
};
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("no second sum: only the portfolio model reads the balances the total is made of", () => {
  const readers = walk(SRC)
    .filter((f) => /\.tsx?$/.test(f) && /\bvault_balance\b/.test(code(f)))
    .map((f) => path.relative(SRC, f))
    .filter((f) => !(f in NOT_A_TOTAL));
  assert.deepEqual(readers, ["screens/portfolio/model.ts"]);
});

const NOW = Date.parse("2026-11-03T12:00:00Z");
const state = (over: Partial<SignpageState> = {}): SignpageState => ({
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "40.50",
  wallets: [
    { chain: "solana", address: "a", role: "fresh", size: "20.12", state: "READY" },
    { chain: "base", address: "b", role: "fresh", size: "10.12", state: "ARMING" },
  ],
  positions: [
    { chain: "solana", token: "PRICED", amount: "1000", cost: "3.06", wallets: ["a"] },
    { chain: "solana", token: "NOPRICE", amount: "5", cost: "2.00", wallets: ["a"] },
  ],
  orders: [],
  held: [],
  ops: [],
  pools: [{ chain: "near", asset: "USDC", balance: "7.25" }, { chain: "solana", asset: "SOL", balance: "0.5" }],
  ...over,
});
const snap = (s: SignpageState): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", stale: false, state: s });
const PRICED: PortfolioData = { ...NO_DATA, market: (_c, t) => (t === "PRICED" ? { symbol: "P", name: "P", price: "0.01", route: true } : null) };

test("the header draws Portfolio's Cash, the one number, where a second sum would differ", () => {
  for (const [name, s, d] of [
    ["no market reads (live today)", state(), NO_DATA],
    ["a priced position", state(), PRICED],
    ["no pools sent", state({ pools: undefined }), PRICED],
    ["nothing on the way", state({ wallets: [] }), NO_DATA],
  ] as const) {
    const cash = portfolio(snap(s), d, NOW).totals!.cash;
    const b = balanceOf(snap(s), d, NOW);
    assert.equal(b, cash, name);
    assert.equal(headerModel(snap(s), b).cents, cash, name);
    assert.equal(headerModel(snap(s), b).kind, "balance", name);
  }
  // the values: 40.50 vault + 7.25 USDC pool + 20.12 ready; never the 10.12 on the way or the positions, priced or not
  assert.equal(balanceOf(snap(state()), NO_DATA, NOW), 6787n);
  assert.equal(balanceOf(snap(state()), PRICED, NOW), 6787n);
  assert.equal(balanceOf(snap(state({ pools: undefined })), PRICED, NOW), 6062n);
  assert.equal(balanceOf(snap(state({ wallets: [] })), NO_DATA, NOW), 4775n);
});

test("signed out or before the first state there is no balance, and the header says so", () => {
  assert.equal(balanceOf({ status: "connecting", release: null, stale: false, state: null } as unknown as SignpageClientSnapshot, NO_DATA, NOW), null);
  assert.equal(headerModel(snap(state({ signed_in: false })), balanceOf(snap(state({ signed_in: false })), NO_DATA, NOW)).kind, "out");
  assert.equal(headerModel(snap(state({ vault_balance: "0", wallets: [], positions: [], pools: [] })), 0n).kind, "empty");
});

test("the restore screen counts the same number", () => {
  const s = state({ ops: [{ id: "r", kind: "restore", stage: "scanning", txs: [] }] as SignpageState["ops"] });
  assert.equal(restoreModel(s, balanceOf(snap(s), NO_DATA, NOW))!.cents, 6787n);
});
