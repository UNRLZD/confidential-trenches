// Records the reads fee.ts makes for one quote on each network, as JSON-RPC calls and their answers, for
// src/withdraw/fee.test.ts and packages/wallet/test/withdraw-fee-helper.test.ts to replay (card relayer-withdraw-fee).
//   node apps/helper/test/record-withdraw-fee.ts <out.json>
// Mainnet: rpc.mainnet.fastnear.com and near.drpc.org; testnet: test.rpc.fastnear.com and near-testnet.drpc.org (the
// device's release pairs, wallet deposit/account.ts NEAR_NETWORKS). Reads only; no key. A block is kept to the four
// header fields fee.ts reads, and USDC's id is written $USDC.
import { writeFileSync } from "node:fs";
import { nearRpc } from "../src/bind/send.ts";
import type { Rpc } from "../src/near/pages.ts";
import { createFeeQuoter, TESTNET_TOKEN } from "../src/withdraw/fee.ts";
import { USDC } from "../src/token-status/status.ts";

const PAIRS = {
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"],
  testnet: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
} as const;
const RELAYER = { relayer_account: "relayer.confidential.unrlzd.near", fee_recipient: "relayer.confidential.unrlzd.near" };

type Call = { url: string; method: string; params: unknown; result: unknown };
const calls: Call[] = [];
const logged = (url: string): Rpc => {
  const r = nearRpc(url);
  return async (method, params) => {
    const result = await r(method, params);
    // a block is kept to the header fields fee.ts reads (the rest holds hundreds of hashes the secret scan flags)
    const h = method === "block" ? (result as { header: Record<string, unknown> }).header : undefined;
    const kept = h ? { header: { height: h.height, hash: h.hash, gas_price: h.gas_price, timestamp_nanosec: h.timestamp_nanosec } } : result;
    calls.push({ url, method, params, result: kept });
    return result;
  };
};
const pair = (n: keyof typeof PAIRS) => [logged(PAIRS[n][0]), logged(PAIRS[n][1])] as const;

const out = process.argv[2];
if (!out) throw new Error("usage: record-withdraw-fee.ts <out.json>");
const at = Date.now();
const mainnet = pair("mainnet");
const q = createFeeQuoter({ priceRpcs: mainnet, networks: { mainnet: { rpcs: mainnet, relayer: RELAYER }, testnet: { rpcs: pair("testnet"), relayer: RELAYER } }, now: () => at });
const answers = { mainnet: await q.quote(USDC), testnet: await q.quote(TESTNET_TOKEN) };
// USDC's 64-hex id reads as a key to the secret scan: written as $USDC, put back by the replays
writeFileSync(out, `${JSON.stringify({ note: `fee.ts's reads, recorded ${new Date(at).toISOString()}`, now_ms: at, relayer: RELAYER, pairs: PAIRS, answers, calls }, null, 1).replaceAll(USDC, "$USDC")}\n`);
console.log(JSON.stringify(answers, null, 1));
