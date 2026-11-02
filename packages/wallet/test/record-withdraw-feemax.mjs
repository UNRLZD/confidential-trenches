// Records the answers test/withdraw-feemax.test.ts replays (card wallet-withdraw-feemax): read-only calls on each
// network's release pair (one FastNEAR URL and dRPC), no key, no secret.
//   node test/record-withdraw-feemax.mjs test/vectors/withdraw-feemax.json   (from packages/wallet)
// Per network: the final block on both providers, then the block at the lower of the two heights on both (its header
// only: height, hash, gas_price, timestamp_nanosec; the rest of a block answer is not read). On mainnet also Ref's
// pool 4512 (USDC/wNEAR) at that block on both. On testnet the token's ft_metadata (its decimals).
import { writeFileSync } from "node:fs";

const PAIRS = {
  mainnet: { a: "https://rpc.mainnet.fastnear.com", b: "https://near.drpc.org" },
  testnet: { a: "https://test.rpc.fastnear.com", b: "https://near-testnet.drpc.org" },
};
const TESTNET_USDC = "bf-usdc-20261101t022248.testnet"; // contracts/vault/deployments/testnet-usdc.json
const arg = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const call = async (url, method, params) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "wallet-withdraw-feemax", method, params }),
  });
  return { url, status: r.status, json: await r.json() };
};
const headerOnly = (a) => {
  const h = a.json?.result?.header;
  return h ? { ...a, json: { ...a.json, result: { header: { height: h.height, hash: h.hash, gas_price: h.gas_price, timestamp_nanosec: h.timestamp_nanosec } } } } : a;
};
const out = { recorded_at: new Date().toISOString(), answers: {} };
for (const [net, pair] of Object.entries(PAIRS)) {
  const o = (out.answers[net] = {});
  o.final = { a: headerOnly(await call(pair.a, "block", { finality: "final" })), b: headerOnly(await call(pair.b, "block", { finality: "final" })) };
  const h = Math.min(o.final.a.json.result.header.height, o.final.b.json.result.header.height);
  o.at = { a: headerOnly(await call(pair.a, "block", { block_id: h })), b: headerOnly(await call(pair.b, "block", { block_id: h })) };
  if (net === "mainnet") {
    const q = { request_type: "call_function", account_id: "v2.ref-finance.near", method_name: "get_pool", args_base64: arg({ pool_id: 4512 }), block_id: h };
    o.pool = { a: await call(pair.a, "query", q), b: await call(pair.b, "query", q) };
  } else {
    const q = { request_type: "call_function", account_id: TESTNET_USDC, method_name: "ft_metadata", args_base64: arg({}), finality: "final" };
    o.metadata = { a: await call(pair.a, "query", q), b: await call(pair.b, "query", q) };
  }
}
writeFileSync(process.argv[2], `${JSON.stringify(out, null, 1)}\n`);
console.log(out.recorded_at);
