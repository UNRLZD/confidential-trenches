// card pool-withdraws-to-any-chain: a pool payout to another chain. The run asks its host's exit for a checked 1Click
// quote's deposit address on the pool's chain, once, after the plan and before any note moves, with the run's first W as
// the refund address; every part of planPoolWithdraw's plan then pays that address exactly as it pays a typed To.
//   node --test test/pool-withdraw-exit.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPoolWithdraw } from "../src/pool-withdraw.ts";
import { ASK, COST, TO, lamportsOf, read, world } from "./pool-withdraw-world.ts";

// a 1Click deposit address on Solana (any key nobody in the run holds)
const DEPOSIT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

test("two notes to another chain: every part pays the quote's deposit address, the refund is the first W, asked before any release", async () => {
  const wd = await world([10_000_000n, 30_000_000n]);
  const asked: { refundTo: string; releasesBefore: number }[] = [];
  const host = { ...wd.host, exit: async (refundTo: string) => (asked.push({ refundTo, releasesBefore: wd.releases.length }), DEPOSIT) };
  const amount = 33_000_000n;
  // the To the screen hands over is the typed address on the other chain; the run never pays it
  const a = await runPoolWithdraw(host, ASK, TO, amount, 2n * COST);
  assert.equal(a.stage, "sent");
  assert.equal(asked.length, 1, "one quote a run");
  assert.equal(asked[0]!.releasesBefore, 0, "asked before any note moves");
  assert.equal(asked[0]!.refundTo, wd.binds[0]!.recipient, "the refund is the run's first W");
  const ons = wd.onwards().map(read);
  assert.equal(ons.length, 2);
  for (const o of ons) assert.equal(o.ixs[0]!.accounts[1], DEPOSIT);
  assert.equal(ons.reduce((t, o) => t + lamportsOf(o.ixs[0]!.data), 0n), amount, "the plan's parts sum to the payout, the quote's amountIn");
  assert.equal(wd.balance.get(DEPOSIT), amount);
  assert.equal(wd.balance.get(TO) ?? 0n, 0n);
});

test("a quote refused, or a deposit address that is one of the run's own Ws or the pool's: stopped, nothing bound, nothing sent", async () => {
  for (const exit of [
    async () => { throw new Error("quote check failed"); },
    async (refundTo: string) => refundTo, // the first W itself
  ]) {
    const wd = await world([30_000_000n]);
    const a = await runPoolWithdraw({ ...wd.host, exit }, ASK, TO, 2_000_000n, COST);
    assert.equal(a.stage, "stopped");
    assert.equal(wd.binds.length, 0);
    assert.equal(wd.releases.length, 0);
    assert.equal(wd.onwards().length, 0);
  }
});
