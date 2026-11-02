// The screen run's page (test/withdraw-screens/run.mjs): the real form (src/withdraw/form.ts) and its checks, mounted
// with stub reads, so every state can be drawn, ready included, which the live page does not reach yet (its fee bound
// is unread until the device's fee_max reads are built). Testnet, so the vault refusal is reachable: the stub RPCs carry
// the testnet pair's exact names, and they answer as the real ones do (view_account, 2026-11-02T08:11Z reads):
// alice.near exists; down.near is unanswered on both; every other named account is UNKNOWN_ACCOUNT.
import { NEAR_NETWORKS, type NearRpc } from "../../../wallet/src/near/networks.ts";
import { drawWithdrawForm, type CheckedWithdraw } from "../../src/withdraw/form.ts";

const T = NEAR_NETWORKS.testnet;
const VIEW = { jsonrpc: "2.0", result: { amount: "1", block_hash: "x", block_height: 222692520, code_hash: "11111111111111111111111111111111", locked: "0", storage_paid_at: 0, storage_usage: 100 } };
const UNKNOWN = { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, code: -32000 } };
const w = window as unknown as { __reads: string[]; __handed: CheckedWithdraw[]; __release: { vault: string; token: string } };
w.__release = { vault: T.vault, token: T.usdc }; // the run types these, so it follows NEAR_NETWORKS
w.__reads = [];
w.__handed = [];
const rpc = (name: string): NearRpc => ({
  name,
  async query(p) {
    w.__reads.push(String(p.account_id));
    if (p.account_id === "down.near") throw new Error("HTTP 503");
    return p.account_id === "alice.near" ? VIEW : UNKNOWN;
  },
});
const button = (action: string, label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
};
const root = document.createElement("main");
root.id = "signin";
root.dataset.signin = "withdraw";
root.append(
  drawWithdrawForm(
    document,
    {
      network: "testnet",
      rpcs: [rpc(T.fastnear[0]), rpc(T.drpc)],
      available: async () => 10_000_000n, // the largest unspent note: 10 USDC
      fee: async () => 120_000n, // the fee bound: 0.12 USDC
      handoff: (c) => void w.__handed.push(c),
    },
    button,
    (step) => void step(),
  ),
);
document.body.append(root);
