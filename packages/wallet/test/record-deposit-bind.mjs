// Records the pages test/deposit-bind.test.ts replays (card wallet-deposit-bind): the release's testnet vault's
// `deposits` view, first page, on the two testnet providers of two operators, at final. Read-only, no key, no secret.
//   node test/record-deposit-bind.mjs test/vectors/deposit-bind-pages.json   (from packages/wallet)
// The vault is NEAR_NETWORKS.testnet.vault (contracts/vault/deployments/testnet-v1.json); it holds no deposit
// yet, so its page is empty and the tests put rows of the vault's DepositView shape (contracts/vault/src/lib.rs) into it.
import { writeFileSync } from "node:fs";

const TESTNET = { a: "https://test.rpc.fastnear.com", b: "https://near-testnet.drpc.org" };
const VAULT = "vault.bf-vt-20261102t071444.testnet"; // gitleaks:allow (a public account id)
const params = {
  request_type: "call_function",
  account_id: VAULT,
  method_name: "deposits",
  // the kit's first deposits page (VAULT_SYNC_PAGE.deposits, review R-03), as the device's scan asks it
  args_base64: Buffer.from(JSON.stringify({ from: 0, limit: 450 })).toString("base64"),
  finality: "final",
};
const out = { recorded_at: new Date().toISOString(), vault: VAULT, params, answers: {} };
for (const [side, url] of Object.entries(TESTNET)) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "wallet-deposit-bind", method: "query", params }) });
  out.answers[side] = { url, status: r.status, json: await r.json() };
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
