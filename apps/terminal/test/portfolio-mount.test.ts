// Portfolio's taps (card app-portfolio-mount): Deposit opens the deposit sheet, Withdraw SIGN_HOST's withdraw, Export
// SIGN_HOST's key export for the wallet that holds the position; the taps whose screens other cards mount do nothing.
//   node --test apps/terminal/test/portfolio-mount.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { tapOf } from "../src/routes/portfolio-taps.ts";

const held = (chain: string, token: string) => (chain === "solana" && token === "T" ? ["So1Wallet"] : []);

test("Deposit, Withdraw and Export go where they belong", () => {
  assert.deepEqual(tapOf({ kind: "deposit" }, held), { to: "deposit" });
  assert.deepEqual(tapOf({ kind: "withdraw" }, held), { to: "withdraw" });
  assert.deepEqual(tapOf({ kind: "export", chain: "solana", token: "T" }, held), { to: "export", chain: "solana", address: "So1Wallet" });
});

test("Export with no wallet known opens nothing; sell, exit plan, share and view key wait for their screens", () => {
  assert.deepEqual(tapOf({ kind: "export", chain: "base", token: "T" }, held), { to: "none" });
  for (const a of [
    { kind: "sell", chain: "solana", token: "T", part: "100" },
    { kind: "exit", chain: "solana", token: "T" },
    { kind: "share", chain: "solana", token: "T" },
    { kind: "view-key", id: "op1" },
  ] as const) assert.deepEqual(tapOf(a, held), { to: "none" }, a.kind);
});
