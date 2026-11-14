// Every quote leg a device wallet pays in a pool coin refunds on its own chain (card refunds-land-on-the-devices-own-
// wallet). The Move's hosts (src/main.ts poolMoveAddress: another pool's coin into a pool; poolCoinQuote: a pool's coin
// into Cash, from a pool's run or a leftover's wallet) are given `refund`, U_{s,i}'s own address derived on the device
// (src/leftover-carry.ts ownRefundAddress): their request to the helper asks refundType ORIGIN_CHAIN to that address,
// never INTENTS, and the follow is handed it to record. Money from an outside wallet (the app's hosts, no `refund`) and
// Cash's NEAR USDC (no pool coin) keep INTENTS under the id. Each request is read as it leaves for the helper.
//   node --test test/origin-refund-legs.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

const { depositId, depositIdEvm } = await import("../../wallet/src/derive/keys.ts");
const { base58 } = await import("@scure/base");
const { poolAddressHost } = await import("../src/pool-deposit-address.ts");
const { depositQuoteHost } = await import("../src/deposit-wire.ts");
const { ownRefundAddress } = await import("../src/leftover-carry.ts");

const NOW = Date.parse("2026-11-14T07:00:00.000Z");
const SEED64 = new Uint8Array(64); // the all-zero test seed: no user's
const SOL_S = 31n, BASE_S = 32n, VAULT_S = 40n;
const ks = depositId(SEED64, SOL_S, 3), kb = depositId(SEED64, BASE_S, 4), ke = depositIdEvm(SEED64, BASE_S, 4);
const kv = depositId(SEED64, VAULT_S, 7), kve = depositIdEvm(SEED64, VAULT_S, 7), kse = depositIdEvm(SEED64, SOL_S, 3);
const SOL_ID = ks.id, SOL_U = base58.encode(ks.publicKey), BASE_ID = kb.id, BASE_U = ke.address, BASE_ID_SOL = base58.encode(kb.publicKey);
const V_ID = kv.id, V_SOL = base58.encode(kv.publicKey), V_EVM = kve.address, SOL_SCOPE_EVM = kse.address;
for (const k of [ks, kb, ke, kv, kve, kse]) k.secretKey.fill(0);
const SOL = "nep141:sol.omft.near", BASE_ETH = "nep141:base.omft.near", HOOD_ETH = "nep141:hood.omft.near";
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const STATUS = { source: "words", code_saved: true } as const;
const RECORDS: Record<string, unknown> = {
  [SOL_S.toString()]: { v: 1, scope: SOL_S.toString(), index: 3, id: SOL_ID },
  [BASE_S.toString()]: { v: 1, scope: BASE_S.toString(), index: 4, id: BASE_ID, evm: BASE_U },
  [VAULT_S.toString()]: { v: 1, scope: VAULT_S.toString(), index: 7, id: V_ID },
};
const own = async (chain: "solana" | "base" | "robinhood", s: bigint, i: number, id: string) => ownRefundAddress(SEED64, chain, s, i, id);

/** The request each host sends to the helper (answered 503: nothing is checked, no address goes out). */
async function poolLeg(origin: string, chain: "solana" | "base", withRefund: boolean) {
  const sent: Record<string, unknown>[] = [];
  const d = poolAddressHost({
    pools: () => [{ chain: "solana", scope: SOL_S }, { chain: "base", scope: BASE_S }],
    network: "mainnet",
    read: async (scope) => ({ status: STATUS as never, deposit: RECORDS[scope.toString()] as never }),
    named: async () => {},
    now: () => NOW,
    priced: () => ({ decimalsIn: origin === SOL ? 9 : origin === NEAR_USDC ? 6 : 18, pricing: { in: ["150", "150"], out: ["150", "150"] } }),
    floor: async () => 1n,
    checked: async () => {},
    confidential: true,
    hidden: async () => "hidden",
    fetch: (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    ...(withRefund ? { refund: own } : {}),
  })({ chain, origin_asset: origin, amount: "0.1" }, { id: "op-1" });
  await d.after;
  assert.equal(sent.length, 1, "one request to the helper");
  return sent[0]!;
}

async function cashLeg(origin: string, withRefund: boolean) {
  const sent: Record<string, unknown>[] = [];
  const d = depositQuoteHost({
    scope: () => VAULT_S,
    read: async (scope) => ({ status: STATUS as never, deposit: RECORDS[scope.toString()] as never }),
    named: async () => {},
    now: () => NOW,
    priced: () => ({ decimals: origin === SOL ? 9 : 18, pricing: { in: ["150", "150"], out: ["1", "1"] } }),
    checked: async () => {},
    confidential: true,
    hidden: async () => "hidden",
    fetch: (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    ...(withRefund ? { refund: own } : {}),
  })({ origin_asset: origin, amount: "0.1" }, { id: "op-2" });
  await d.after;
  assert.equal(sent.length, 1, "one request to the helper");
  return sent[0]!;
}

test("pool to pool, SOL into Base's pool: ORIGIN_CHAIN to base58 of Base's U_{s,i} on Solana", async () => {
  const r = await poolLeg(SOL, "base", true);
  assert.deepEqual([r.refundType, r.refundTo, r.recipient], ["ORIGIN_CHAIN", BASE_ID_SOL, BASE_U]);
});

test("pool to pool, Base ETH into Solana's pool: ORIGIN_CHAIN to Solana's U^evm_{s,i} on Base", async () => {
  const r = await poolLeg(BASE_ETH, "solana", true);
  assert.deepEqual([r.refundType, r.refundTo, r.recipient], ["ORIGIN_CHAIN", SOL_SCOPE_EVM, SOL_U]);
});

test("pool to pool, Robinhood ETH into Base's pool: ORIGIN_CHAIN to Base's U^evm_{s,i} on Robinhood", async () => {
  const r = await poolLeg(HOOD_ETH, "base", true);
  assert.deepEqual([r.refundType, r.refundTo], ["ORIGIN_CHAIN", BASE_U]);
});

test("pool to Cash and a leftover's carry: SOL into Cash refunds ORIGIN_CHAIN to base58 of U on Solana", async () => {
  const r = await cashLeg(SOL, true);
  assert.deepEqual([r.refundType, r.refundTo, r.recipient], ["ORIGIN_CHAIN", V_SOL, V_ID]);
});

test("pool to Cash and a leftover's carry from Base and Robinhood: ETH refunds ORIGIN_CHAIN to U^evm on its chain", async () => {
  for (const origin of [BASE_ETH, HOOD_ETH]) {
    const r = await cashLeg(origin, true);
    assert.deepEqual([r.refundType, r.refundTo], ["ORIGIN_CHAIN", V_EVM], origin);
  }
});

test("Cash to a pool (NEAR USDC: no device address on the vault's side) keeps INTENTS under U_{s,i}", async () => {
  const r = await poolLeg(NEAR_USDC, "solana", true);
  assert.deepEqual([r.refundType, r.refundTo], ["INTENTS", SOL_ID]);
});

test("money from an outside wallet (the app's hosts, no refund given) keeps INTENTS under the id", async () => {
  assert.deepEqual(Object.values((({ refundType, refundTo }) => ({ refundType, refundTo }))(await poolLeg(BASE_ETH, "solana", false))), ["INTENTS", SOL_ID]);
  assert.deepEqual(Object.values((({ refundType, refundTo }) => ({ refundType, refundTo }))(await cashLeg(SOL, false))), ["INTENTS", V_ID]);
});

test("the device's refund address is U_{s,i}'s own: a record whose id is not the seed's derives nothing", () => {
  assert.equal(ownRefundAddress(SEED64, "solana", VAULT_S, 7, V_ID), V_SOL);
  assert.equal(ownRefundAddress(SEED64, "base", VAULT_S, 7, V_ID), V_EVM);
  assert.throws(() => ownRefundAddress(SEED64, "solana", VAULT_S, 8, V_ID));
  assert.throws(() => ownRefundAddress(SEED64, "base", SOL_S, 3, V_ID));
});
