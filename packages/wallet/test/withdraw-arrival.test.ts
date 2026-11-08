// The arrival of a withdrawal the vault pays straight to the typed NEAR account (card wallet-withdraw-move-out): what one
// spends row, read on two RPCs, says of the payout. The pages themselves are read through the kit's vaultSync, tested
// with the hand-off on a model vault (packages/signpage/test/withdraw-handoff.test.ts).
//   node --test test/withdraw-arrival.test.ts   (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VaultSpendRow } from "@blindfill/kit";
import { arrivalOf, withdrawArrival } from "../src/withdraw/arrival.ts";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";

const row = (over: Partial<VaultSpendRow> = {}): VaultSpendRow => ({
  index: 1, nullifierHash: 41n, withdrawn: 3_188_142n, newLeafIndex: 9n, refundPrecommitment: 5n, refundValue: 0n, refundLabel: 0n,
  refundLeafIndex: 0n, status: "paid", payer: "r.testnet", reserve: 0n, recipient: "bob.testnet", fee: 188_142n, context: 43n, ...over,
});

test("paid, or settled with no refund, to the typed account: arrived", () => {
  assert.equal(arrivalOf(row(), "bob.testnet")?.kind, "arrived");
  assert.equal(arrivalOf(row({ status: "settled", refundValue: 0n }), "bob.testnet")?.kind, "arrived");
});
test("the payout failed (refund_pending, or settled with the withdrawn value refunded): refunded, never arrived", () => {
  assert.equal(arrivalOf(row({ status: "refund_pending", refundValue: 3_188_142n }), "bob.testnet")?.kind, "refunded");
  assert.equal(arrivalOf(row({ status: "settled", refundValue: 3_188_142n }), "bob.testnet")?.kind, "refunded");
});
test("a spend paid to another account: elsewhere, whatever its status", () => {
  for (const status of ["paid", "in_flight", "settled", "refund_pending"] as const) assert.equal(arrivalOf(row({ status, recipient: "eve.testnet" }), "bob.testnet")?.kind, "elsewhere");
});
test("in_flight (on_payout not run yet): nothing concluded", () => {
  assert.equal(arrivalOf(row({ status: "in_flight" }), "bob.testnet"), null);
});
test("withdrawArrival reads the release pair only, and stops on the caller's signal", async () => {
  const rpc = (name: string) => ({ name, query: async () => ({ error: { name: "x" } }) });
  await assert.rejects(withdrawArrival({ network: "testnet", rpcs: [rpc("https://a.example"), rpc("https://b.example")], nullifierHash: 41n, recipient: "bob.testnet" }), /pair|release|FastNEAR|dRPC/i);
  const T = NEAR_NETWORKS.testnet;
  const stop = new AbortController();
  let rounds = 0;
  const going = withdrawArrival({
    network: "testnet", rpcs: [rpc(T.fastnear[0]), rpc(T.drpc)], nullifierHash: 41n, recipient: "bob.testnet", signal: stop.signal,
    sleep: async () => {
      if (++rounds === 3) stop.abort();
    },
  });
  await assert.rejects(going);
  assert.equal(rounds, 3, "a read that fails concludes nothing: it reads again until stopped");
});

// review of c19ad399, L4: a round reads from the last round's cursor, never from the vault's first spend again
test("withdrawArrival keeps its cursor across rounds: each round starts where the last one's read ended", async () => {
  const T = NEAR_NETWORKS.testnet;
  const rpc = (name: string) => ({ name, query: async () => ({}) });
  const asked: number[] = [];
  let round = 0;
  const out = await withdrawArrival({
    network: "testnet", rpcs: [rpc(T.fastnear[0]), rpc(T.drpc)], nullifierHash: 41n, recipient: "bob.testnet", sleep: async () => {},
    sync: (async (a: { cursor: { spends: number } }) => {
      asked.push(a.cursor.spends);
      round++;
      // round 1: rows 0-6 settled and row 7 in flight, so the cursor stops at 7; round 2: row 7 paid
      const spends = round === 1 ? [row({ index: 7, status: "in_flight" })] : [row({ index: 7 })];
      return { spends, cursor: { ...a.cursor, spends: 7 } };
    }) as never,
  });
  assert.equal(out.kind, "arrived");
  assert.deepEqual(asked, [0, 7], "round 2 reads from round 1's cursor");
});
