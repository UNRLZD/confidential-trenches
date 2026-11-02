// The signing-page client tests' fixtures: one valid request and answer per kind of the seventeen, typed against
// messages.ts so the kit's tsc refuses a fixture that drifts from the frozen shapes or a kind with none.
import type { SignpageKind, SignpageParams, SignpageResults, SignpageState } from "../src/signpage/messages.ts";

export const STATE: SignpageState = {
  release: "sp-1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "125.5",
  wallets: [{ chain: "solana", address: "So1aNa", role: "fresh", size: "50", state: "READY" }],
  positions: [{ chain: "base", token: "0xabc", amount: "10", cost: "5.25", wallets: ["0xw1"] }],
  orders: [
    {
      order_id: "o1",
      chain: "near",
      wallet: "w.near",
      token: "tok.near",
      group_id: "g1",
      trigger: { kind: "stop", pool: "p1", venue: "ref", direction: "lte", price: "0.5", quote_asset: "usdc" },
      state: "ARMED",
      last_check: 1761955200000,
    },
  ],
  held: [{ id: "h1", asset: "usdc", amount: "1" }],
  ops: [
    { id: "op1", kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: "5ig" }] },
    { id: "op2", kind: "deposit", stage: "done", txs: [] },
  ],
};

/** One valid request and answer per kind. */
export const FIXTURES = {
  "deposit.quote": {
    params: { origin_asset: "nep141:usdc", amount: "100" },
    result: { deposit_address: "dep1", origin_asset: "nep141:usdc", amount_in: "100", min_amount_out: "99.5", deadline: "2026-11-01T03:00:00.000Z", time_estimate_s: 20 },
  },
  "deposit.confirm": { params: { deposit_address: "dep1" }, result: { stage: "waiting" } },
  arm: { params: { chain: "solana", amount: "50" }, result: { stage: "queued" } },
  buy: { params: { chain: "solana", token: "Tok", side: "buy", amount: "25", slippage_bps: 100 }, result: { stage: "sent", txs: [{ chain: "solana", hash: "5ig" }] } },
  hop: { params: { from: "solana", to: "base", amount: "10" }, result: { stage: "in_flight", txs: [] } },
  "orders.set": {
    params: { chain: "solana", token: "Tok", slippage_bps: 300, tp: { trigger_price: "2", share_bps: 5000 }, sl: { trigger_price: "0.5", share_bps: 10000 } },
    result: { orders: [{ order_id: "o1", group_id: "g1", kind: "take_profit", state: "SIGNED" }] },
  },
  "orders.cancel": { params: { order_ids: ["o1"] }, result: { orders: [{ order_id: "o1", state: "CANCELLED" }], txs: [] } },
  return: { params: { chain: "base", wallet: "0xw1" }, result: { stage: "signed", txs: [] } },
  "withdraw.open": { params: { return_key: "withdraw", from_id: "h1" }, result: { pending: true } },
  "signin.open": { params: { return_key: "deposit", way: "passkey" }, result: { pending: true } },
  "backup.open": { params: { return_key: "settings" }, result: { pending: true } },
  "export.open": { params: { return_key: "settings", chain: "near", address: "w.near" }, result: { pending: true } },
  signout: { params: { return_key: "settings" }, result: { pending: true } },
  restore: { params: {}, result: { stage: "started" } },
  state: { params: {}, result: STATE },
  nav: { params: { path: "/token/solana/So11111111111111111111111111111111111111112?tab=trades" }, result: {} },
  reload: { params: {}, result: {} },
} satisfies { [K in SignpageKind]: { params: SignpageParams[K]; result: SignpageResults[K] } };

