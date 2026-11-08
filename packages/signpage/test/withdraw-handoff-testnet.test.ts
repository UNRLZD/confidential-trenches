// The testnet build's withdraw form (card signpage-withdraw-handoff): with __SIGN_NETWORK__ "testnet", as
// scripts/build-app.mjs folds it for the testnet build, the form's network is testnet and every read it makes, the
// fee's and the hand-off's, goes to the testnet release pair (mainnet's pair for the price only). The form offers the
// hand-off on this build, the one whose release names a relayer: the vault pays the typed account straight
// (wallet-withdraw-move-out). SIGN_HOST's build names no relayer and offers none (test/withdraw-form.test.ts).
// Its own process: the build's network is read once, when the module loads. Every read is answered "no" here: only
// where it goes is held.
//   node --test test/withdraw-handoff-testnet.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { NEAR_NETWORKS } = await import("../../kit/src/near/networks.ts");
const { PAGE_NETWORK, withdrawFormDeps, withdrawHandoff } = await import("../src/withdraw/handoff.ts");
const { RELEASE_WITHDRAW_RELAYER } = await import("../../wallet/src/withdraw/relay.ts");

const T = NEAR_NETWORKS.testnet;
const M = NEAR_NETWORKS.mainnet;
const HELPER = "https://api.confidential.unrealized.trade";
const no = async (): Promise<never> => {
  throw new Error("not read");
};
const page = { store: no, notes: no, seed64: no, prover: { load: no, prove: no } };

/** Every fetch's URL, each answered with an error, or by `answer` when it gives one. */
function recording(answer?: (url: string) => Response | undefined): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return answer?.(url) ?? new Response("{}", { status: 503 });
  }) as typeof fetch;
  return { urls, restore: () => void (globalThis.fetch = real) };
}

test("the testnet build's form is testnet's and offers the hand-off", () => {
  assert.equal(PAGE_NETWORK, "testnet");
  const d = withdrawFormDeps(page);
  assert.equal(d.network, "testnet");
  assert.deepEqual(d.rpcs.map((r) => r.name), [T.fastnear[0], T.drpc]);
  assert.equal(typeof d.handoff, "function");
  assert.ok(RELEASE_WITHDRAW_RELAYER.testnet, "the testnet build carries the testnet relayer");
});

test("the fee reads the testnet pair, mainnet's for the price, and no other host", async () => {
  const r = recording();
  try {
    const d = withdrawFormDeps({ ...page, store: async () => ({ keys: async () => [], get: async () => undefined }) as never });
    await assert.rejects(d.fee());
  } finally {
    r.restore();
  }
  const hosts = new Set(r.urls.map((u) => new URL(u).origin));
  for (const h of hosts) assert.ok([T.fastnear[0], T.drpc, M.fastnear[0], M.drpc, HELPER].includes(h), `the fee read reached ${h}`);
  assert.ok([...hosts].some((h) => h === T.fastnear[0] || h === T.drpc), "the fee read reads the testnet pair");
});

test("the kept hand-off reads the testnet pair", async () => {
  const quote = { relayer_account: RELEASE_WITHDRAW_RELAYER.testnet!.relayer_account, fee_recipient: RELEASE_WITHDRAW_RELAYER.testnet!.fee_recipient, relay_fee: "1", gp: "1", px: "1", g_w: "1", valid_until_block: 1 };
  const r = recording((u) => (u.startsWith(HELPER) ? new Response(JSON.stringify(quote), { status: 200, headers: { "content-type": "application/json" } }) : undefined));
  try {
    const h = withdrawHandoff(page);
    assert.ok(h);
    await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, 1n));
  } finally {
    r.restore();
  }
  const rpcs = r.urls.filter((u) => !u.startsWith(HELPER)).map((u) => new URL(u).origin);
  assert.ok(rpcs.length > 0, r.urls.join(" "));
  for (const h of rpcs) assert.ok(h === T.fastnear[0] || h === T.drpc, `the hand-off read ${h}`);
});
