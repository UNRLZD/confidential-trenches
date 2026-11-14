// Portfolio's taps (card app-portfolio-mount): Deposit opens the deposit sheet, Withdraw SIGN_HOST's withdraw, Export
// SIGN_HOST's key export for the one wallet its row names, when the kit's moneyWallets names it (card
// app-export-every-wallet); the taps whose screens other cards mount do nothing.
//   node --test apps/terminal/test/portfolio-mount.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { tapOf } from "../src/routes/portfolio-taps.ts";

const held = (chain: string, address: string) => (chain === "solana" && address === "So1Wallet") || (chain === "near" && address === "u.near");

test("Deposit, Withdraw and Export go where they belong", () => {
  assert.deepEqual(tapOf({ kind: "deposit" }, held), { to: "deposit" });
  assert.deepEqual(tapOf({ kind: "withdraw" }, held), { to: "withdraw" });
  assert.deepEqual(tapOf({ kind: "export", chain: "solana", address: "So1Wallet" }, held), { to: "export", chain: "solana", address: "So1Wallet" });
  assert.deepEqual(tapOf({ kind: "export", chain: "near", address: "u.near" }, held), { to: "export", chain: "near", address: "u.near" });
});

test("Export of a wallet the kit does not name opens nothing (another chain, another address); sell, exit plan, share and view key wait for their screens", () => {
  assert.deepEqual(tapOf({ kind: "export", chain: "base", address: "So1Wallet" }, held), { to: "none" });
  assert.deepEqual(tapOf({ kind: "export", chain: "solana", address: "NotOurs" }, held), { to: "none" });
  for (const a of [
    { kind: "sell", chain: "solana", token: "T", part: "100" },
    { kind: "exit", chain: "solana", token: "T" },
    { kind: "share", chain: "solana", token: "T" },
    { kind: "view-key", id: "op1" },
  ] as const) assert.deepEqual(tapOf(a, held), { to: "none" }, a.kind);
});

test("a row's Sell opens its token's page (its sell box sells it); a chain with no token page opens nothing", () => {
  assert.deepEqual(tapOf({ kind: "sell", chain: "solana", token: "So1Mint", part: "box" }, held), { to: "token", href: "/token/solana/So1Mint" });
  assert.deepEqual(tapOf({ kind: "sell", chain: "base", token: "0xAbC", part: "box" }, held), { to: "token", href: "/token/base/0xAbC" });
  assert.deepEqual(tapOf({ kind: "sell", chain: "moon" as never, token: "T", part: "box" }, held), { to: "none" });
});

test("a pool row's Withdraw opens the app's own Withdraw on that pool (card withdraw-in-app-to-any-chain): never SIGN_HOST's own pool form", () => {
  for (const chain of ["solana", "base", "robinhood"] as const) assert.deepEqual(tapOf({ kind: "pool-withdraw", chain }, held), { to: "withdraw", from: chain }, chain);
  // a chain with no pool opens nothing
  assert.deepEqual(tapOf({ kind: "pool-withdraw", chain: "near" } as never, held), { to: "none" });
});
