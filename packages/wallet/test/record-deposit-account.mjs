// Records the answers test/deposit-account.test.ts replays (card wallet-deposit-account): read-only `query` calls on
// two NEAR providers of two operators per network, no key, no secret.
//   node test/record-deposit-account.mjs test/vectors/deposit-account.json   (from packages/wallet)
// Every answer names the account it is for. The mainnet accounts are real implicit USDC holders (NearBlocks' holder
// list, read 2026-11-01T07:25Z): one with one full key of its own, one with a function-call key beside its full key,
// one with two full keys. test_u is U_{1,0} of a fixed test seed (64 bytes of 0x42), which does not exist on mainnet.
import { writeFileSync } from "node:fs";
import { depositId } from "../src/derive/keys.ts";

const MAINNET = { a: "https://rpc.mainnet.fastnear.com", b: "https://near.drpc.org" };
const TESTNET = { a: "https://test.rpc.fastnear.com", b: "https://near-testnet.drpc.org" };
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TESTNET_USDC = "bf-usdc-20261101t022248.testnet"; // contracts/vault/deployments/testnet-usdc.json
const GOOD = "45d8d8d26a4815e9e7f3b383a123aef5f3839dedc620eae54ba72f34816966ed";
const FA_FC = "35b4d174e4b3fe6f9dd9b60d0046ccc0a02dadc9981a637f127233da5657cbb7";
const FA_FA = "0d04229851cfaececfd8555b8951387197dee82f15d5f22a725e1d14b948c68a";
const TEST_U = depositId(new Uint8Array(64).fill(0x42), 1n, 0).id;

const arg = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const keys = (account) => ({ request_type: "view_access_key_list", account_id: account });
const balance = (token, a) => ({ request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: arg(a) });
const code = (token) => ({ request_type: "view_account", account_id: token });
// name: [providers, the account the answer is about, params]
const reads = {
  keys_good: [MAINNET, GOOD, keys(GOOD)],
  keys_fa_fc: [MAINNET, FA_FC, keys(FA_FC)],
  keys_fa_fa: [MAINNET, FA_FA, keys(FA_FA)],
  keys_no_account: [MAINNET, TEST_U, keys(TEST_U)],
  balance_good: [MAINNET, GOOD, balance(USDC, { account_id: GOOD })],
  balance_panic: [MAINNET, GOOD, balance(USDC, {})], // no account_id: USDC panics on the args
  code: [MAINNET, USDC, code(USDC)],
  code_testnet: [TESTNET, TESTNET_USDC, code(TESTNET_USDC)],
};
const out = { recorded_at: new Date().toISOString(), good: GOOD, test_u: TEST_U, answers: {} };
for (const [name, [rpcs, account, params]] of Object.entries(reads)) {
  out.answers[name] = { for: account };
  for (const [side, url] of Object.entries(rpcs)) {
    const body = { jsonrpc: "2.0", id: "wallet-deposit-account", method: "query", params: { ...params, finality: "final" } };
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    out.answers[name][side] = { url, status: r.status, json: await r.json() };
  }
}
writeFileSync(process.argv[2], `${JSON.stringify(out, null, 1)}\n`);
console.log(out.recorded_at);
