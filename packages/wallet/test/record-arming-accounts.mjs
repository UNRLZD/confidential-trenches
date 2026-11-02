// Records the answers test/arming-accounts.test.ts replays (card wallet-arming-accounts): read-only `query` calls on two
// NEAR providers of two operators per network, no key, no secret.
//   node test/record-arming-accounts.mjs test/vectors/arming-accounts.json   (from packages/wallet)
// Every answer names the account it is for. GOOD is a real implicit USDC holder, so registered on USDC (the account
// test/vectors/deposit-account.json reads). TEST_A is A_{l,0} of the §A.8 test seed (test/vectors/a8.json), a public
// test account nobody registers.
import { readFileSync, writeFileSync } from "node:fs";

const MAINNET = { a: "https://rpc.mainnet.fastnear.com", b: "https://near.drpc.org" };
const TESTNET = { a: "https://test.rpc.fastnear.com", b: "https://near-testnet.drpc.org" };
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TESTNET_USDC = "bf-usdc-20261101t022248.testnet"; // contracts/vault/deployments/testnet-usdc.json
const GOOD = "45d8d8d26a4815e9e7f3b383a123aef5f3839dedc620eae54ba72f34816966ed";
const a8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8"));
const TEST_A = a8.ids.find((x) => x.name === "A_{l,0}").id;

const arg = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const view = (token, method_name, args) => ({ request_type: "call_function", account_id: token, method_name, args_base64: arg(args) });
// name: [providers, the account the answer is about, params]
const reads = {
  reg_set: [MAINNET, GOOD, view(USDC, "storage_balance_of", { account_id: GOOD })],
  reg_null: [MAINNET, TEST_A, view(USDC, "storage_balance_of", { account_id: TEST_A })],
  reg_panic: [MAINNET, USDC, view(USDC, "storage_balance_of", {})], // no account_id: USDC panics on the args
  bounds: [MAINNET, USDC, view(USDC, "storage_balance_bounds", {})],
  reg_null_testnet: [TESTNET, TEST_A, view(TESTNET_USDC, "storage_balance_of", { account_id: TEST_A })],
  bounds_testnet: [TESTNET, TESTNET_USDC, view(TESTNET_USDC, "storage_balance_bounds", {})],
};
const out = { recorded_at: new Date().toISOString(), good: GOOD, test_a: TEST_A, answers: {} };
for (const [name, [rpcs, account, params]] of Object.entries(reads)) {
  out.answers[name] = { for: account };
  for (const [side, url] of Object.entries(rpcs)) {
    const body = { jsonrpc: "2.0", id: "wallet-arming-accounts", method: "query", params: { ...params, finality: "final" } };
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    out.answers[name][side] = { url, status: r.status, json: await r.json() };
  }
}
writeFileSync(process.argv[2], `${JSON.stringify(out, null, 1)}\n`);
console.log(out.recorded_at);
