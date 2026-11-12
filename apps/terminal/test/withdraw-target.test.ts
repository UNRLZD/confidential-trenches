// Which withdraw form a Withdraw tap opens (card withdraw-form-shows-what-you-can-send): the form of the place that
// holds the money, never the NEAR vault's form for money in the Solana pool (the owner's run, release 120: a Solana
// address read as a NEAR account, the amount against the empty vault).
//   node --test apps/terminal/test/withdraw-target.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { withdrawOpen, withdrawPlaces } from "../src/screens/withdraw/target.ts";

const state = (vault: string, pools: { chain: "solana" | "base" | "robinhood" | "near"; asset: "SOL" | "ETH" | "USDC"; balance: string }[]): SignpageState =>
  ({ vault_balance: vault, pools }) as unknown as SignpageState;

test("money in the Solana pool only: the tap opens the Solana pool's form, not the vault's", () => {
  const s = state("0", [{ chain: "solana", asset: "SOL", balance: "0.0289" }, { chain: "base", asset: "ETH", balance: "0" }]);
  assert.deepEqual(withdrawOpen(s), { to: "open", place: { kind: "pool.withdraw", chain: "solana", balance: "0.0289", symbol: "SOL" } });
});

test("money in the vault only: the vault's form", () => {
  assert.deepEqual(withdrawOpen(state("12.5", [{ chain: "solana", asset: "SOL", balance: "0" }])), {
    to: "open",
    place: { kind: "withdraw.open", chain: "near", balance: "12.5", symbol: "USDC" },
  });
});

test("money in several places: a pick of each, the vault first, then the pools in the kit's order", () => {
  const s = state("3", [{ chain: "robinhood", asset: "ETH", balance: "0.2" }, { chain: "solana", asset: "SOL", balance: "1.5" }]);
  const o = withdrawOpen(s);
  assert.equal(o.to, "pick");
  assert.deepEqual(o.to === "pick" && o.places.map((p) => [p.kind, p.chain, p.balance, p.symbol]), [
    ["withdraw.open", "near", "3", "USDC"],
    ["pool.withdraw", "solana", "1.5", "SOL"],
    ["pool.withdraw", "robinhood", "0.2", "ETH"],
  ]);
});

test("no money, or no state read: the vault's form as before; a NEAR pool row or a bad balance is no place", () => {
  assert.deepEqual(withdrawOpen(null), { to: "open", place: null });
  assert.deepEqual(withdrawOpen(state("0", [])), { to: "open", place: null });
  assert.deepEqual(withdrawPlaces(state("0.000", [{ chain: "near", asset: "USDC", balance: "5" }, { chain: "solana", asset: "SOL", balance: "-1" }])), []);
});

// review of 3e8422132 (P2): a row's open runs alone and closes the pick only on the shell's ok; a refused or silent open
// leaves the pick up (its HopLine draws why), and no second row starts a second open meanwhile.
test("the pick's row: one open at a time, the pick closed only on ok", async () => {
  const { pickRunner } = await import("../src/screens/withdraw/target.ts");
  const log: string[] = [];
  let answer: (r: { ok: boolean } | null) => void = () => {};
  const run = pickRunner((p: string) => (log.push(`open ${p}`), new Promise((r) => (answer = r))), { busy: (b) => log.push(`busy ${b}`), close: () => log.push("close") });
  const first = run("solana");
  await run("base"); // a second row while the first is under way: nothing
  answer({ ok: false });
  await first;
  assert.deepEqual(log, ["busy true", "open solana", "busy false"], "refused: the pick stays up");
  log.length = 0;
  const silent = run("base");
  answer(null);
  await silent;
  assert.deepEqual(log, ["busy true", "open base", "busy false"], "no answer: the pick stays up");
  log.length = 0;
  const ok = run("near");
  answer({ ok: true });
  await ok;
  assert.deepEqual(log, ["busy true", "open near", "busy false", "close"]);
});
