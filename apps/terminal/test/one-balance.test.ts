// One balance (card app-portfolio-mount): the header, the deposit sheet, the withdraw screen, the restore screen and
// Portfolio's Cash tile all draw one number, the cash in Portfolio's totals() (the design-lock-r5 header shows Cash), so
// they can never differ. Held two ways: no file but the portfolio model sums the signing page's balances, and the
// header's model given that number draws exactly Portfolio's Cash on states where a second sum would differ (a USDC
// pool, money on the way, a priced position). Cash holds every pool at the signing page's price (card
// portfolio-one-balance). The trade box's Bal is the vault path's part of it (Totals.offPool) on a chain with no pool, and
// the chain's pool balance on a chain with one (card trade-box-bal-cash); tradeBal names which.
//   node --test apps/terminal/test/one-balance.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { balanceOf, NO_DATA, portfolio } from "../src/screens/portfolio/model.ts";
import type { PortfolioData } from "../src/screens/portfolio/model.ts";
import { holdsNothing } from "../src/screens/portfolio/model.ts";
import { headerModel, restoreModel, usd } from "../src/screens/signin/model.ts";
import { poolView, tradeBal } from "../src/screens/trade/model.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));

// Code that reads the vault's cash, and why it is not a second total. Comments do not count.
const NOT_A_TOTAL: Record<string, string> = {
  // card withdraw-form-shows-what-you-can-send: whether the vault holds any, to open its withdraw form; never summed
  "screens/withdraw/target.ts": "which form a Withdraw opens: the vault's when it holds any",
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

test("the trade box's Bal: the vault path's part of Cash on a chain with no pool, the pool's balance on a chain with one", () => {
  const s = state();
  const cash = portfolio(snap(s), NO_DATA, NOW).totals!.offPool;
  // with no price for the SOL pool, the vault path's part is the whole of Cash
  assert.equal(cash, balanceOf(snap(s), NO_DATA, NOW));
  assert.equal(cash, 6787n);
  // Solana's pool is in the state but cannot be priced here (no price read): no pool view, so no Bal, never the Cash
  assert.deepEqual(tradeBal(false, null, cash), { from: "cash", cents: 6787n });
  assert.equal(tradeBal(false, null, cash).cents, headerModel(snap(s), cash).cents);
  assert.deepEqual(tradeBal(true, null, cash), { from: "pool", cents: null });
  const SOL = { price: 9_301_048_308n, expo: -8, decimals: 9 };
  const pv = poolView([{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608" }], "solana", SOL);
  assert.deepEqual(tradeBal(true, pv, cash), { from: "pool", cents: 93n });
  // signed out or before the first state: no Cash, no Bal
  assert.deepEqual(tradeBal(false, null, null), { from: "cash", cents: null });
});

test("the trade box's Bal and Cash with a priced pool: Cash is the vault path's part plus the pool's, each drawn once", () => {
  const price = { price: "15000000000", expo: -8, published_s: Math.floor(NOW / 1000) - 5, read_ms: NOW - 1000 };
  const s = state({ pools: [{ chain: "near", asset: "USDC", balance: "7.25" }, { chain: "solana", asset: "SOL", balance: "0.5", ready: "0.5", tap_max: "0.5", price }] });
  const t = portfolio(snap(s), NO_DATA, NOW).totals!;
  // 0.5 SOL at $150 is $75.00; the rest (40.50 + 7.25 + 20.12) is the vault path's
  assert.equal(t.offPool, 6787n);
  assert.equal(t.cash, 6787n + 7500n);
  assert.equal(balanceOf(snap(s), NO_DATA, NOW), t.cash);
  assert.equal(headerModel(snap(s), t.cash).cents, t.cash);
  // NEAR's Bal is the vault path's, never the pools' too; Solana's is its pool's
  assert.deepEqual(tradeBal(false, null, t.offPool), { from: "cash", cents: 6787n });
  const pv = poolView(s.pools, "solana", { price: 15_000_000_000n, expo: -8, decimals: 9 });
  assert.deepEqual(tradeBal(true, pv, t.offPool), { from: "pool", cents: 7500n });
  // Solana's part of Cash: its pool and the READY Solana wallet's 20.12
  assert.equal(t.parts.find((p) => p.chain === "solana")!.cents, pv!.balance + 2012n);
});

// card vault-balance-unread: from kit 1.21 the signing page sends no vault_balance while it could not read the vault's
// notes; before, it sent "0" and every balance drew $0 (on mainnet the pools are [] either way, so nothing told the two
// apart). Each figure made from it is unread (a dash), never $0 or the rest alone.
test("vault-balance-unread: a state with no vault_balance has no Cash, total, off-pool Cash or NEAR part, the header and restore draw a dash, the pools are unread, and it never reads as empty", () => {
  const restore = { id: "r1", kind: "restore", stage: "done", txs: [] } as unknown as SignpageState["ops"][number];
  for (const pools of [[], undefined, state().pools]) {
    const { vault_balance: _v, ...rest } = state({ pools, ops: [restore] });
    const s = rest as SignpageState;
    const name = JSON.stringify(pools);
    const t = portfolio(snap(s), NO_DATA, NOW).totals!;
    assert.equal(t.cash, null, name);
    assert.equal(t.total, null, name);
    assert.equal(t.offPool, null, name);
    assert.equal(t.parts.find((p) => p.chain === "near")?.cents, null, name);
    assert.equal(balanceOf(snap(s), NO_DATA, NOW), null, name);
    const h = headerModel(snap(s), balanceOf(snap(s), NO_DATA, NOW));
    assert.deepEqual([h.kind, h.cents, usd(h.cents)], ["balance", null, "\u2014"], name);
    assert.deepEqual(restoreModel(s, balanceOf(snap(s), NO_DATA, NOW)), { id: "r1", kind: "done", cents: null }, name);
    assert.equal(portfolio(snap(s), NO_DATA, NOW).pools.view, "unread", name);
    assert.equal(holdsNothing(s), false, name);
    // the trade box's Bal on a chain with no pool is Cash less the pools: unread too
    assert.equal(tradeBal(false, null, t.offPool).cents, null, name);
  }
  // a vault that holds nothing is still $0, the account empty
  const zero = state({ vault_balance: "0", wallets: [], positions: [], pools: [] });
  const z = portfolio(snap(zero), NO_DATA, NOW).totals!;
  assert.deepEqual([z.cash, z.total, z.offPool, z.parts.find((p) => p.chain === "near")?.cents], [0n, 0n, 0n, 0n]);
  assert.equal(headerModel(snap(zero), balanceOf(snap(zero), NO_DATA, NOW)).kind, "empty");
  assert.equal(holdsNothing(zero), true);
});
