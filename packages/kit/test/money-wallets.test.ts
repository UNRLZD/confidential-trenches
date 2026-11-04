// moneyWallets (card app-export-every-wallet): the kit names every address that holds the user's money, so an app can
// put an export on each one and no money sits on a wallet the user cannot take out. And state.deposit_wallets, the
// deposit wallets with money left, checked by the client's state schema like every other field.
//   node --test test/money-wallets.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { moneyWallets } from "@blindfill/kit";
import type { SignpageState } from "@blindfill/kit";
import { SIGNPAGE_RESULT_SCHEMAS } from "../src/signpage/schema.ts";

const BASE: SignpageState = {
  release: "sp-1",
  api: 1,
  signed_in: true,
  code_saved: true,
  vault_balance: "0",
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
};

const STATE: SignpageState = {
  ...BASE,
  wallets: [
    { chain: "solana", address: "SoReady", role: "fresh", size: "20", state: "READY" },
    { chain: "solana", address: "SoPos1", role: "fresh", size: "10", state: "IN_POSITION" },
    { chain: "base", address: "0xarming", role: "fresh", size: "5", state: "ARMING" },
    { chain: "near", address: "back.near", role: "hop", size: "2", state: "RETURNING" },
    { chain: "solana", address: "SoEmpty", role: "fresh", size: "10", state: "EMPTY" },
    { chain: "base", address: "0xplanned", role: "fresh", size: "10", state: "PLANNED" },
  ],
  positions: [
    { chain: "solana", token: "MintA", amount: "100", cost: "3", wallets: ["SoPos1", "SoPos2"] },
    { chain: "solana", token: "MintB", amount: "5", cost: "1", wallets: ["SoPos1"] },
    { chain: "base", token: "0xtok", amount: "7", cost: "2", wallets: ["0xpos"] },
  ],
  deposit_wallets: [
    { chain: "solana", address: "SoU3", asset: "SOL", amount: "0.02" },
    { chain: "solana", address: "SoU4", asset: "SOL", amount: "0" },
    { chain: "near", address: "u.near", asset: "USDC", amount: "1.5" },
  ],
};

test("every address that holds money, once each: the position wallets, the funded fresh and hop wallets, the deposit wallets with money left", () => {
  assert.deepEqual(moneyWallets(STATE), [
    { chain: "solana", address: "SoPos1", role: "trade", tokens: ["MintA", "MintB"] },
    { chain: "solana", address: "SoPos2", role: "trade", tokens: ["MintA"] },
    { chain: "solana", address: "SoReady", role: "trade", tokens: [] },
    { chain: "solana", address: "SoU3", role: "deposit", tokens: [] },
    { chain: "base", address: "0xpos", role: "trade", tokens: ["0xtok"] },
    { chain: "base", address: "0xarming", role: "trade", tokens: [] },
    { chain: "near", address: "back.near", role: "trade", tokens: [] },
    { chain: "near", address: "u.near", role: "deposit", tokens: [] },
  ]);
});

test("an EMPTY or PLANNED wallet and a deposit wallet holding 0 are not named; a state with none names none", () => {
  const names = moneyWallets(STATE).map((w) => w.address);
  for (const a of ["SoEmpty", "0xplanned", "SoU4"]) assert.ok(!names.includes(a), a);
  assert.deepEqual(moneyWallets(BASE), []);
  assert.deepEqual(moneyWallets({ ...BASE, deposit_wallets: [{ chain: "solana", address: "SoU", asset: "SOL", amount: "0.000" }] }), []);
});

test("a wallet named both as a position's and a deposit wallet is named once, as the trade wallet that holds the tokens", () => {
  const s: SignpageState = { ...BASE, positions: [{ chain: "solana", token: "M", amount: "1", cost: "1", wallets: ["X"] }], deposit_wallets: [{ chain: "solana", address: "X", asset: "SOL", amount: "1" }] };
  assert.deepEqual(moneyWallets(s), [{ chain: "solana", address: "X", role: "trade", tokens: ["M"] }]);
});

test("one address on two chains is two wallets", () => {
  const s: SignpageState = { ...BASE, positions: [{ chain: "base", token: "T", amount: "1", cost: "1", wallets: ["0xsame"] }, { chain: "robinhood", token: "T", amount: "1", cost: "1", wallets: ["0xsame"] }] };
  assert.deepEqual(moneyWallets(s).map((w) => `${w.chain}:${w.address}`), ["base:0xsame", "robinhood:0xsame"]);
});

test("a page of an earlier release, whose state has no deposit_wallets key, still passes the schema, and moneyWallets of it names the position and fresh wallets only", () => {
  const { deposit_wallets: _, ...earlier } = STATE;
  assert.equal(Object.hasOwn(earlier, "deposit_wallets"), false);
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(earlier), true);
  const named = moneyWallets(earlier as SignpageState);
  assert.deepEqual(named.map((w) => `${w.chain}:${w.address}`), ["solana:SoPos1", "solana:SoPos2", "solana:SoReady", "base:0xpos", "base:0xarming", "near:back.near"]);
  assert.ok(named.every((w) => w.role === "trade"));
});

test("state.deposit_wallets: optional; each entry exact, its asset its chain's pool asset, its amount within the asset's decimals, one entry per wallet", () => {
  const ok = SIGNPAGE_RESULT_SCHEMAS.state;
  assert.equal(ok(BASE), true, "a state without deposit_wallets passes");
  assert.equal(ok(STATE), true, "a state with them passes");
  assert.equal(ok({ ...BASE, deposit_wallets: [] }), true, "an empty list passes");
  for (const [chain, asset] of [["solana", "SOL"], ["base", "ETH"], ["robinhood", "ETH"], ["near", "USDC"]]) {
    assert.equal(ok({ ...BASE, deposit_wallets: [{ chain, address: "a", asset, amount: "1" }] }), true, `${asset} on ${chain}`);
  }
  const bad: [string, unknown][] = [
    ["an asset that is not its chain's", [{ chain: "solana", address: "a", asset: "ETH", amount: "1" }]],
    ["an extra key", [{ chain: "solana", address: "a", asset: "SOL", amount: "1", key: "x" }]],
    ["a missing address", [{ chain: "solana", asset: "SOL", amount: "1" }]],
    ["an empty address", [{ chain: "solana", address: "", asset: "SOL", amount: "1" }]],
    ["more digits than the asset has", [{ chain: "near", address: "a", asset: "USDC", amount: "0.0000001" }]],
    ["a negative amount", [{ chain: "solana", address: "a", asset: "SOL", amount: "-1" }]],
    ["an unknown chain", [{ chain: "eth", address: "a", asset: "ETH", amount: "1" }]],
    ["one wallet twice", [{ chain: "solana", address: "a", asset: "SOL", amount: "1" }, { chain: "solana", address: "a", asset: "SOL", amount: "2" }]],
    ["not a list", { chain: "solana", address: "a", asset: "SOL", amount: "1" }],
  ];
  for (const [why, v] of bad) assert.equal(ok({ ...BASE, deposit_wallets: v }), false, why);
});
