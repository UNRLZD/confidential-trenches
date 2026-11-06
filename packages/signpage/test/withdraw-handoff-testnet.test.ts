// The testnet build's withdraw form (card signpage-withdraw-handoff): with __SIGN_NETWORK__ "testnet", as
// scripts/build-app.mjs folds it for the testnet build, the form's network is testnet, its pair the testnet release
// pair, and the hand-off is offered (the testnet release names a vault and a relayer). Its own process: the build's
// network is read once, when the module loads.
//   node --test test/withdraw-handoff-testnet.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { NEAR_NETWORKS } = await import("../../kit/src/near/networks.ts");
const { PAGE_NETWORK, withdrawFormDeps } = await import("../src/withdraw/handoff.ts");

test("the testnet build's form reads and hands off on testnet only", () => {
  assert.equal(PAGE_NETWORK, "testnet");
  const no = async () => {
    throw new Error("not read");
  };
  const d = withdrawFormDeps({ store: no, notes: no, seed64: no, prover: { load: no, prove: no } });
  assert.equal(d.network, "testnet");
  assert.deepEqual(d.rpcs.map((r) => r.name), [NEAR_NETWORKS.testnet.fastnear[0], NEAR_NETWORKS.testnet.drpc]);
  assert.equal(typeof d.handoff, "function");
});
