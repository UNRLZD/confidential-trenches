// Records the reads test/sol-pool-mainnet-pin.test.ts holds SOL_POOLS.mainnet to (card sol-pools-mainnet-pin):
// read-only, no key, no secret, nothing sent.
//   node test/record-sol-pool-pin.mjs test/vectors/sol-pool-mainnet-pin.json      (from packages/wallet)
// - The helper as SIGN_HOST reads it: GET /v1/pool/fee?cluster=mainnet&pool=<the deploy record's pool> (its program,
//   pool and fee_payer), with Origin SIGN_HOST, as the page's poolRelayFee asks it.
// - On two keyless mainnet RPCs of two operators (the helper-sol-fee-payer-mainnet check's RPCS), at finalized: the
//   deploy record's program (an executable of the upgradeable loader), its pool account (owned by the program), and the
//   fee payer the helper named (a system account with no data), each getAccountInfo answer kept whole but its data.
import { readFileSync, writeFileSync } from "node:fs";

const HELPER = "https://ct-api.unrealized.trade";
const ORIGIN = "https://confidential.unrealized.trade";
const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const [out] = process.argv.slice(2);
if (!out) throw new Error("usage: node test/record-sol-pool-pin.mjs <out.json>");

const record = JSON.parse(readFileSync(new URL("../../../contracts/pool-solana/deployments/mainnet.json", import.meta.url), "utf8"));
const url = `${HELPER}/v1/pool/fee?cluster=mainnet&pool=${record.pool}`;
const r = await fetch(url, { headers: { origin: ORIGIN }, redirect: "error", signal: AbortSignal.timeout(15_000) });
const fee = { url, origin: ORIGIN, status: r.status, commit: r.headers.get("x-helper-commit"), body: JSON.parse(await r.text()) };
const payer = fee.body?.fee_payer;
if (typeof payer !== "string" || !B58.test(payer)) throw new Error(`the helper names no fee payer: ${JSON.stringify(fee.body)}`);

const account = async (rpc, address) => {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } }] }),
    signal: AbortSignal.timeout(15_000),
  });
  return { url: rpc, status: res.status, json: await res.json() };
};
const reads = async (address) => ({ address, getAccountInfo: await Promise.all(RPCS.map((u) => account(u, address))) });

const v = { recorded_at: new Date().toISOString(), helper: { fee }, program: await reads(record.program_id), pool: await reads(record.pool), fee_payer: await reads(payer) };
writeFileSync(out, `${JSON.stringify(v, null, 1)}\n`);
console.log(`recorded ${out}: helper ${fee.status} at ${fee.commit}, fee payer ${payer}`);
