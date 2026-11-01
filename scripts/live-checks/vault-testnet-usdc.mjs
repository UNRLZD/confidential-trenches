#!/usr/bin/env node
// Live check of card vault-testnet-usdc: a team testnet account runs the same USDC wasm as mainnet, with test accounts
// in its roles. From contracts/vault/deployments/testnet-usdc.json it takes the token's id, the holder, the amount
// minted and the txs, and on two testnet RPCs it reads:
//   - view_account of the token: its code hash is mainnet USDC's, DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q (pinned
//     here from vault.md's Pinned sources, never taken from the record);
//   - ft_metadata(): it answers spec ft-1.0.0, symbol USDC, 6 decimals;
//   - ft_balance_of(holder): it equals the amount the record says was minted;
// and every tx the record lists reads ok (succeeded, final, on or after 2026-11-01) on two of the money gate's testnet
// RPCs, by the money gate's own readTx, and failed on none it asked.
//   node scripts/live-checks/vault-testnet-usdc.mjs [--account <id>] [--deployment <file>] [--record <file>]
//     [--live <file>]   PASS exit 0, FAIL exit 1, error exit 2
// --account checks another account against the same record (the recorded bad answer). --record writes every RPC answer
// the run read to <file>, so the check's test can replay it (each NEAR signature replaced, as money-gate-testnet does).
// --live writes the card's live record (CARD / live: PASS|FAIL, Money path: yes, one Tx line per tx) for the money gate.
import "../net-window.mjs";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS as GATE_RPCS, okOperators, oneOperator, operatorOf, readTx } from "../ci/money-gate.mjs";

const KEY = "vault-testnet-usdc";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = path.join(HERE, "../../contracts/vault/deployments/testnet-usdc.json");
// vault.md Pinned sources, USDC row: the code hash of mainnet 17208628…33a1's deployed code
export const USDC_CODE_HASH = "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q";
export const RPCS = GATE_RPCS["near-testnet"];

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// a 429 is waited out (2 s, 4 s, 8 s), never read as an answer
async function query(fetchFn, url, params, sleep = pause) {
  let r, json;
  for (let i = 0; ; i++) {
    r = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method: "query", params }),
    });
    json = r.status === 429 ? null : await r.json();
    if (r.status !== 429 && json?.error?.code !== -429) break;
    if (i === 3) throw new Error("rate limited 4 times in a row");
    await sleep(2000 * 2 ** i);
  }
  if (json.error) throw new Error(`${json.error.name ?? "error"}: ${json.error.cause?.name ?? json.error.message ?? ""}`);
  if (json.result?.error) throw new Error(String(json.result.error).split("\n")[0].slice(0, 200));
  if (!json.result) throw new Error(`HTTP ${r.status}, no result`);
  return json.result;
}
const callView = async (fetchFn, url, account, method, args, sleep) => {
  const r = await query(fetchFn, url, { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "final" }, sleep);
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};

export async function check({ deployment, account = deployment.account_id, fetchFn = fetch, rpcs = RPCS, sleep }) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
  };
  const state = rpcs.slice(0, 2);
  if (state.length < 2) say(false, `only ${state.length} RPC(s); want two`);
  for (const url of state) {
    const at = `on ${url}`;
    try {
      const a = await query(fetchFn, url, { request_type: "view_account", account_id: account, finality: "final" }, sleep);
      say(a.code_hash === USDC_CODE_HASH, `${account} code hash ${a.code_hash} is mainnet USDC's ${USDC_CODE_HASH} ${at} at block ${a.block_height}`);
    } catch (e) {
      say(false, `${account} view_account ${at}: ${e.message}`);
    }
    try {
      const m = await callView(fetchFn, url, account, "ft_metadata", {}, sleep);
      say(m.spec === "ft-1.0.0" && m.symbol === "USDC" && m.decimals === 6, `ft_metadata answers ${at}: spec ${m.spec}, name ${m.name}, symbol ${m.symbol}, decimals ${m.decimals}`);
    } catch (e) {
      say(false, `ft_metadata ${at}: ${e.message}`);
    }
    try {
      const b = await callView(fetchFn, url, account, "ft_balance_of", { account_id: deployment.holder }, sleep);
      say(typeof b === "string" && /^[1-9]\d*$/.test(deployment.minted) && b === deployment.minted, `ft_balance_of(${deployment.holder}) is ${b}, the ${deployment.minted} minted, ${at}`);
    } catch (e) {
      say(false, `ft_balance_of(${deployment.holder}) ${at}: ${e.message}`);
    }
  }
  const txs = Array.isArray(deployment.txs) ? deployment.txs : [];
  say(txs.length > 0, `the record lists ${txs.length} tx(s)`);
  for (const t of txs) {
    // in order until two operators read ok: the third host (rate-limited, FastNEAR's again) is asked only when one of
    // the first two cannot; two hosts of one operator are one read. A tx older than dRPC keeps passes on one operator
    // by the money gate's own rule (oneOperator), said so.
    const tx = { chain: "near-testnet", hash: t.hash, signer: t.signer };
    const reads = [];
    for (const url of rpcs) {
      const ops = okOperators("near-testnet", reads);
      if (ops.size >= 2) break;
      const out = {};
      // a 429 is waited out only when this host could add an operator, as in the gate
      const r = await readTx(fetchFn, url, tx, undefined, sleep, !ops.has(operatorOf("near-testnet", url)), out);
      reads.push({ url, r, height: out.height, time: out.time });
    }
    const decisive = reads.some((x) => /^(failed|old)/.test(x.r));
    const ops = okOperators("near-testnet", reads).size;
    const one = !decisive && ops === 1 ? await oneOperator(fetchFn, tx, reads, sleep) : null;
    say(!decisive && (ops >= 2 || one !== null), `tx ${t.hash} (${t.what}) ${reads.map((x) => `${x.r} on ${x.url}`).join(", ")}${one ? `; ${one}` : ""}`);
  }
  return { ok, lines };
}

const SIGNATURE = "ed25519:<a signature, not kept>";
const unsigned = (json) => JSON.parse(JSON.stringify(json).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/g, SIGNATURE));

// a fetch that keeps every answer it reads, its signatures dropped: { url, method, params, status, json }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const json = r.status === 429 ? null : await r.json();
    answers.push({ url, method, params, status: r.status, json: json && unsigned(json) });
    return { ok: r.ok, status: r.status, headers: r.headers, json: async () => json };
  };
  return { answers, fetchFn: wrapped };
}

export const liveRecord = (deployment, r) =>
  [`CARD ${KEY} / live: ${r.ok ? "PASS" : "FAIL"}`, "Money path: yes", ...deployment.txs.map((t) => `Tx: near-testnet ${t.hash} ${t.signer}`), "", ...r.lines.map((l) => `    ${l}`), ""].join("\n");

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const deployment = JSON.parse(readFileSync(opt("--deployment", DEPLOYMENT), "utf8"));
    if (typeof deployment.account_id !== "string" || typeof deployment.holder !== "string") throw new Error("deployment: want account_id and holder");
    const rec = recorder();
    const r = await check({ deployment, account: opt("--account", deployment.account_id), fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    if (opt("--live")) writeFileSync(opt("--live"), liveRecord(deployment, r));
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
