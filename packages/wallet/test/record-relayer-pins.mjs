// Records the reads test/release-relayer-pins.test.ts holds the release's mainnet relayer pins to (card
// wallet-mainnet-relayer-pins): read-only, no key, no secret, nothing sent.
//   node test/record-relayer-pins.mjs test/vectors/mainnet-relayer-pins.json   (from packages/wallet)
// - The release's helper, as anyone reads it: GET /v1/health (its `bind.mainnet`, the deposit carry's gas account that
//   apps/helper/deploy/bind-relayer-key.sh made) and GET /v1/withdraw/fee for mainnet USDC (its relayer_account and
//   fee_recipient, once withdraw-relayer-key.sh's relayer runs; not_found until then).
// - Mainnet's release pair (one FastNEAR URL and dRPC, the kit's NEAR_NETWORKS.mainnet): view_account and
//   view_access_key_list of each relayer account the helper names, and storage_balance_of on mainnet USDC for the fee
//   recipient the owner named (fees.unrlzd.near, owner 7 Nov 09:27Z) and for the one the fee answer names.
import { writeFileSync } from "node:fs";

const HELPER = "https://api.confidential.unrealized.trade";
const ORIGIN = "https://sign.confidential.unrealized.trade";
const PAIR = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const FEE_RECIPIENT = "fees.unrlzd.near";
const out = process.argv[2];
if (!out) throw new Error("usage: node test/record-relayer-pins.mjs <out.json>");

const get = async (path) => {
  const r = await fetch(`${HELPER}${path}`, { headers: { origin: ORIGIN }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  return { path, status: r.status, commit: r.headers.get("x-helper-commit"), body: JSON.parse(await r.text()) };
};
const query = async (url, params) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "wallet-mainnet-relayer-pins", method: "query", params: { finality: "final", ...params } }),
    signal: AbortSignal.timeout(15_000),
  });
  return { url, status: r.status, json: await r.json() };
};
const account = async (id) => ({
  id,
  view_account: await Promise.all(PAIR.map((u) => query(u, { request_type: "view_account", account_id: id }))),
  view_access_key_list: await Promise.all(PAIR.map((u) => query(u, { request_type: "view_access_key_list", account_id: id }))),
});
const registered = async (id) => ({
  id,
  storage_balance_of: await Promise.all(
    PAIR.map((u) => query(u, { request_type: "call_function", account_id: USDC, method_name: "storage_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: id })).toString("base64") })),
  ),
});

const health = await get("/v1/health");
const fee = await get(`/v1/withdraw/fee?token=${USDC}`);
const bind = typeof health.body?.bind?.mainnet === "string" ? health.body.bind.mainnet : null;
const relayer = fee.status === 200 && typeof fee.body?.relayer_account === "string" ? fee.body.relayer_account : null;
const answerRecipient = fee.status === 200 && typeof fee.body?.fee_recipient === "string" ? fee.body.fee_recipient : null;
const v = {
  recorded_at: new Date().toISOString(),
  helper: { health: { status: health.status, commit: health.commit, bind: health.body?.bind ?? null }, fee },
  bind: bind === null ? null : await account(bind),
  withdraw_relayer: relayer === null ? null : await account(relayer),
  fee_recipients: await Promise.all([...new Set([FEE_RECIPIENT, answerRecipient].filter((a) => a !== null))].map(registered)),
};
writeFileSync(out, `${JSON.stringify(v, null, 2)}\n`);
console.log(`recorded ${out}: bind ${bind ?? "none"}, withdraw relayer ${relayer ?? `none (fee answer ${fee.status})`}`);
