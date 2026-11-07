#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The mainnet pastes' reads before and after a send (card vault-mainnet-deploy, review H1 and L2), on FastNEAR and
// dRPC at final. Each answer is read on both; a read that fails or disagrees stops the paste with nothing sent.
//   node reads.mjs sender <account> <need yocto>   exit 0 when the account can spend <need> on both RPCs (its amount
//                                                  minus storage_usage x 1e19), else 1 with what is short
//   node reads.mjs fee-before <token> <account> <min yocto>
//                                                  exit 0 when the token's storage_balance_bounds are min = max = <min>
//                                                  and <account> is unregistered on both, 4 when registered on both,
//                                                  1 otherwise
//   node reads.mjs fee-after <token> <account>     exit 0 when <account> is registered on both, else 1
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// FastNEAR and dRPC, mainnet's two operators (deploy.mjs MAINNET_RPCS, held equal by mainnet-v1-pastes.test.mjs)
export const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const BYTE = 10n ** 19n;
const N = (y) => `${y < 0n ? "-" : ""}${(y < 0n ? -y : y) / 10n ** 24n}.${String((y < 0n ? -y : y) % 10n ** 24n).padStart(24, "0").replace(/0+$/, "") || "0"} N`;

async function query(fetchFn, url, params) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { ...params, finality: "final" } }), signal: AbortSignal.timeout(30_000) });
  const j = await r.json();
  if (!j.result) throw new Error(`${params.request_type} on ${url}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return j.result;
}
const view = async (fetchFn, url, token, method, args) => JSON.parse(Buffer.from((await query(fetchFn, url, { request_type: "call_function", account_id: token, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })).result).toString("utf8"));

/** What keeps `account` from spending `need` yocto, read on both RPCs: [] when each reads enough. */
export async function senderProblems({ fetchFn = fetch, account, need, rpcs = RPCS, log = console.log }) {
  const p = [];
  for (const url of rpcs) {
    try {
      const a = await query(fetchFn, url, { request_type: "view_account", account_id: account });
      const spendable = BigInt(a.amount) - BigInt(a.storage_usage) * BYTE;
      log(`${account} on ${url}: amount ${N(BigInt(a.amount))}, storage ${a.storage_usage} B, can spend ${N(spendable)} (block ${a.block_height})`);
      if (spendable < need) p.push(`${account} can spend ${N(spendable)} on ${url}, short of ${N(need)} by ${N(need - spendable)}`);
    } catch (e) {
      p.push(e.message);
    }
  }
  return p;
}

/** The fee recipient's state on the token: "unregistered" or "registered" on both RPCs, else problems. With `min`, the
 * token's bounds must also be min = max = `min` on both. */
export async function registration({ fetchFn = fetch, token, account, min, rpcs = RPCS, log = console.log }) {
  const p = [];
  const bal = [];
  for (const url of rpcs) {
    try {
      if (min !== undefined) {
        const b = await view(fetchFn, url, token, "storage_balance_bounds", {});
        if (b?.min !== String(min) || b?.max !== String(min)) p.push(`${token} storage_balance_bounds on ${url} is ${JSON.stringify(b)}, not min = max = ${min}`);
      }
      bal.push(await view(fetchFn, url, token, "storage_balance_of", { account_id: account }));
      log(`${account} on ${token} on ${url}: ${JSON.stringify(bal.at(-1))}`);
    } catch (e) {
      p.push(e.message);
    }
  }
  if (p.length) return { problems: p };
  if (bal.every((b) => b === null)) return { state: "unregistered", problems: [] };
  if (bal.every((b) => b !== null)) return { state: "registered", problems: [] };
  return { problems: [`the RPCs disagree on ${account}'s registration: ${JSON.stringify(bal)}`] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...a] = process.argv.slice(2);
  try {
    if (mode === "sender" && a.length === 2) {
      const p = await senderProblems({ account: a[0], need: BigInt(a[1]) });
      for (const x of p) console.error(`reads: ${x}`);
      process.exit(p.length ? 1 : 0);
    }
    if ((mode === "fee-before" && a.length === 3) || (mode === "fee-after" && a.length === 2)) {
      const r = await registration({ token: a[0], account: a[1], min: mode === "fee-before" ? BigInt(a[2]) : undefined });
      for (const x of r.problems) console.error(`reads: ${x}`);
      if (r.problems.length) process.exit(1);
      if (mode === "fee-before") process.exit(r.state === "unregistered" ? 0 : 4);
      process.exit(r.state === "registered" ? 0 : 1);
    }
    throw new Error("usage: reads.mjs sender <account> <need yocto> | fee-before <token> <account> <min yocto> | fee-after <token> <account>");
  } catch (e) {
    console.error(`reads: ERROR: ${e.message}`);
    process.exit(2);
  }
}
