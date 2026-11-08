// Records the reads test/release-relayer-pins.test.ts holds the release's mainnet relayer pins to (card
// wallet-mainnet-relayer-pins): read-only, no key, no secret, nothing sent.
//   node test/record-relayer-pins.mjs test/vectors/mainnet-relayer-pins.json <deposit-carry> <withdraw-relayer>   (from packages/wallet)
// The two accounts are the ones the server scripts printed (apps/helper/deploy/bind-relayer-key.sh and
// withdraw-relayer-key.sh), given here, never taken from the helper: the chain reads decide each pin, and the helper's
// answers are recorded beside them only to be held equal.
// - Two public mainnet RPCs of two providers (rpc.mainnet.near.org, NEAR's own, and free.rpc.fastnear.com): view_account and
//   view_access_key_list of each account, and storage_balance_of on mainnet USDC for the fee recipient the owner named
//   (fees.unrlzd.near, owner 7 Nov 09:27Z) and for the one the fee answer names.
// - The release's helper, as SIGN_HOST reads it: GET /v1/health (its `bind.mainnet`) and GET /v1/withdraw/fee for
//   mainnet USDC (its relayer_account and fee_recipient).
import { writeFileSync } from "node:fs";

const HELPER = "https://ct-api.unrealized.trade";
const ORIGIN = "https://confidential.unrealized.trade";
const PAIR = ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"];
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const FEE_RECIPIENT = "fees.unrlzd.near";
const [out, carry, withdrawRelayer] = process.argv.slice(2);
const IMPLICIT = /^[0-9a-f]{64}$/;
if (!out || !IMPLICIT.test(carry ?? "") || !IMPLICIT.test(withdrawRelayer ?? ""))
  throw new Error("usage: node test/record-relayer-pins.mjs <out.json> <deposit-carry 64-hex> <withdraw-relayer 64-hex>");

// The fee path's query is mainnet USDC (asked as ?token=); it is recorded as `asset`, apart from the path.
const get = async (path, asset) => {
  const r = await fetch(`${HELPER}${path}${asset ? `?token=${asset}` : ""}`, { headers: { origin: ORIGIN }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  return { path, ...(asset ? { asset } : {}), status: r.status, commit: r.headers.get("x-helper-commit"), body: JSON.parse(await r.text()) };
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
const fee = await get("/v1/withdraw/fee", USDC);
const answerRecipient = fee.status === 200 && typeof fee.body?.fee_recipient === "string" ? fee.body.fee_recipient : null;
const v = {
  recorded_at: new Date().toISOString(),
  helper: { health: { status: health.status, commit: health.commit, bind: health.body?.bind ?? null }, fee },
  bind: await account(carry),
  withdraw_relayer: await account(withdrawRelayer),
  fee_recipients: await Promise.all([...new Set([FEE_RECIPIENT, answerRecipient].filter((a) => a !== null))].map(registered)),
};
writeFileSync(out, `${JSON.stringify(v, null, 2)}\n`);
console.log(`recorded ${out}: helper bind ${health.body?.bind?.mainnet ?? "none"}, helper fee answer ${fee.status} ${fee.body?.relayer_account ?? ""} ${answerRecipient ?? ""}`);
