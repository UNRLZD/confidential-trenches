#!/usr/bin/env node
// Live check of card near-buy-and-sell-run-for-real on NEAR mainnet. The card's NEAR buy and sell were run through the
// page's own code on a local copy of mainnet (the card's record): mainnet's code for the vault, Rhea, wNEAR, USDC and the
// token, each contract freshly initialised, and the route's two pools built with their live amounts and fee. That run
// proves the code it ran, so this check holds that the code is still the code mainnet runs, and that the route is still
// the route the copy built. On two operators (FastNEAR and dRPC), at each one's final block:
//   - each of the five accounts runs the code the copy ran (view_account code_hash equal to the run's);
//   - the vault has no access key (view_access_key_list: keys []);
//   - Rhea's pools 4512 (USDC/wNEAR) and 4771 (the token/wNEAR) hold the same two tokens, in the same order, with the
//     same fee as the copy built (amounts move with every trade and are not checked).
// A Rhea or USDC upgrade, a key on the vault or a pool's fee change fails it: the run no longer proves what users run.
// After: sign
//   node scripts/live-checks/near-buy-and-sell-run-for-real.mjs [--record <file>]
//   node scripts/live-checks/near-buy-and-sell-run-for-real.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2; the last line is "PASS near-buy-and-sell-run-for-real" or
// "FAIL near-buy-and-sell-run-for-real", each failure a "BAD ..." line.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "near-buy-and-sell-run-for-real";
export const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The code the copy ran: view_code at mainnet block 224268130 on FastNEAR and dRPC, each sha256 equal to the hash. */
export const CODE = Object.freeze({
  "vault.confidential.unrlzd.near": "C5fk3Fr9XZwSeDbu9Nc6pTMpYrWiKgBXVzJaK2mAzG3u",
  "v2.ref-finance.near": "GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi",
  "wrap.near": "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1",
  [USDC]: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q",
  "touched.tkn.near": "4AVV1KUVgi17XoXkqxUPzyMhERXu15mGawriPQvWmBKD",
});
export const VAULT = "vault.confidential.unrlzd.near";
export const REF = "v2.ref-finance.near";
/** The route's pools as the copy built them (get_pool at mainnet block 224268130). */
export const POOLS = Object.freeze({
  4512: { tokens: [USDC, "wrap.near"], fee: 30 },
  4771: { tokens: ["touched.tkn.near", "wrap.near"], fee: 30 },
});

/** The verdict on one answer: { ok, lines } with a BAD line per failure. */
export function judge(a) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  for (const url of RPCS) {
    const r = a?.reads?.[url];
    if (r === null || typeof r !== "object") {
      bad(`${url}: no answer`);
      continue;
    }
    for (const [account, hash] of Object.entries(CODE))
      if (r.code?.[account] !== hash) bad(`${url}: ${account} runs code ${r.code?.[account] ?? "none"}, not the code the run proved (${hash})`);
    if (!Array.isArray(r.vaultKeys) || r.vaultKeys.length !== 0) bad(`${url}: the vault has access keys ${JSON.stringify(r.vaultKeys ?? null)}`);
    for (const [id, want] of Object.entries(POOLS)) {
      const p = r.pools?.[id];
      if (p === null || typeof p !== "object") bad(`${url}: Rhea's pool ${id} gave no answer`);
      else if (JSON.stringify(p.token_account_ids) !== JSON.stringify(want.tokens) || p.total_fee !== want.fee)
        bad(`${url}: Rhea's pool ${id} is ${JSON.stringify(p.token_account_ids)} at fee ${p.total_fee}, not the route the run built (${JSON.stringify(want.tokens)} at ${want.fee})`);
    }
  }
  return { ok: lines.length === 0, lines };
}

async function query(url, params) {
  const res = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }), signal: AbortSignal.timeout(20_000) });
  const j = await res.json();
  if (j.error || !j.result) throw new Error(`${url}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return j.result;
}

/** One operator's reads, at its final block. */
async function readOne(url) {
  const code = {};
  for (const account of Object.keys(CODE)) code[account] = (await query(url, { request_type: "view_account", finality: "final", account_id: account })).code_hash;
  const vaultKeys = (await query(url, { request_type: "view_access_key_list", finality: "final", account_id: VAULT })).keys;
  const pools = {};
  for (const id of Object.keys(POOLS)) {
    const r = await query(url, { request_type: "call_function", finality: "final", account_id: REF, method_name: "get_pool", args_base64: Buffer.from(JSON.stringify({ pool_id: Number(id) })).toString("base64") });
    const p = JSON.parse(Buffer.from(r.result).toString());
    pools[id] = { token_account_ids: p.token_account_ids, total_fee: p.total_fee };
  }
  return { code, vaultKeys, pools };
}

export async function read() {
  const reads = {};
  for (const url of RPCS) {
    try {
      reads[url] = await readOne(url);
    } catch (e) {
      reads[url] = null;
      console.error(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { at: new Date().toISOString(), reads };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  try {
    const answer = at("--answer") ? JSON.parse(readFileSync(at("--answer"), "utf8")) : await read();
    if (at("--record")) writeFileSync(at("--record"), `${JSON.stringify(answer, null, 2)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
