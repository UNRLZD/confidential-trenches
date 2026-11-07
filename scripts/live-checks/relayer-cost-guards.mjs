#!/usr/bin/env node
// Live check of card relayer-cost-guards (audit V-03 and I-6): no user can make HELPER_HOST's relayers pay for a
// transaction that earns no fee. It moves no money: it reads, and posts two Solana releases the helper refuses.
//   NEAR, for mainnet USDC and the testnet token: the token's storage_balance_bounds().min on two RPCs of two operators
//   (relayer-withdraw-fee's PAIRS) at one final block, the same bytes on both, and GET /v1/withdraw/fee for the token
//   with Origin APP_HOST. It passes only while that minimum equals the pinned REGISTER_DEPOSIT_MAX of this checkout
//   (apps/helper/src/withdraw/fee.ts; live.yml checks out the deployed commit), the one register_deposit the relayer
//   carries: any other minimum FAILs, so a change to USDC's bounds raises an alarm instead of a quiet 503 (off the pin,
//   up or down, the helper holds every withdrawal). The quote answers 200,
//   or 404 not_found for a network the helper does not carry.
//   Solana, for each pool a deploy record names (helper-live-checks.mjs solanaPools): GET /v1/pool/fee, then POST
//   /v1/pool/solana/send two releases built as helper-pool-senders builds them (a throwaway W, W-signed, slot 0 empty):
//     "zero_fee": a release whose relay_fee is 0 (I-6: the program holds no fee floor) -> 422 fee_off, refused on the
//                 bytes (pool/solana.ts:269), before any read;
//     "program_fails": a release at the published fee on a recent blockhash of the cluster (read here on RENT_RPCS),
//                 passing every check on the bytes, whose pool instruction fails when simulated (its proof is junk) ->
//                 422 simulation_failed with an InstructionError detail: the simulation ran the program, and the helper
//                 refused before it signed (pool/solana.ts:559-570). A failing venue inside a tag 3 is the same
//                 InstructionError branch; it cannot be reached live without a valid proof, so the unit tests hold it
//                 (apps/helper/src/pool/solana.test.ts, I-6).
//   Neither answer may carry a signature (the fee payer's signature is only given for a release it carried).
//   Every answer carries a full-sha X-Helper-Commit, equal to --commit when given.
// Not readable live: check 7's refusal of a register_deposit other than the minimum (only a valid proof reaches check 7;
// apps/helper/src/withdraw/send.test.ts holds it).
//   node scripts/live-checks/relayer-cost-guards.mjs [--commit <sha>] [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { REGISTER_DEPOSIT_MAX } from "../../apps/helper/src/withdraw/fee.ts";
import { solanaPools } from "../ci/helper-live-checks.mjs";
import { b58decode, plant, RENT_RPCS } from "./helper-pool-senders.mjs";
import { PAIRS, TOKENS } from "./relayer-withdraw-fee.mjs";

const KEY = "relayer-cost-guards";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const PIN = REGISTER_DEPOSIT_MAX;
const SHA = /^[0-9a-f]{40}$/;
const DEC = /^(0|[1-9][0-9]{0,38})$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Each planted release and the refusal it must get. */
export const SOLANA_PLANTS = [
  ["zero_fee", "fee_off"],
  ["program_fails", "simulation_failed"],
];

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/**
 * The check on one recorded run: { commit?, near: { mainnet, testnet }, solana: [{ pool, fee, posts }] }, each NEAR
 * entry { bounds: [{ rpc, block_height, block_hash, result }] x2 or { error }, quote: { status, headers, body } }.
 */
export function judge(run, pin = PIN) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const answers = [];
  for (const network of ["mainnet", "testnet"]) {
    const tag = `[near ${network}]`;
    const n = run.near?.[network];
    const q = n?.quote;
    if (!q) {
      say(false, `${tag} no quote read`);
      continue;
    }
    answers.push([`${tag} GET /v1/withdraw/fee`, q]);
    const b = n.bounds;
    let min = null;
    if (!Array.isArray(b) || b.length !== 2) say(false, `${tag} storage_balance_bounds on two RPCs: ${b?.error ?? "missing"}`);
    else {
      const same = b[0].block_height === b[1].block_height && b[0].block_hash === b[1].block_hash && b[0].result === b[1].result && b[0].rpc !== b[1].rpc;
      const m = json(b[0].result)?.min;
      min = same && typeof m === "string" && DEC.test(m) ? BigInt(m) : null;
      say(min !== null, `${tag} storage_balance_bounds().min ${show(m)} on ${b[0].rpc} and ${b[1].rpc} at block ${b[0].block_height}: ${same ? "the same bytes" : "the RPCs disagree"}`);
    }
    say(min !== null && min === pin, `${tag} the token's minimum ${min ?? "unread"} equals the pinned REGISTER_DEPOSIT_MAX ${pin}, the one register_deposit carried`);
    const code = json(q.body)?.error?.code;
    say(q.status === 200 || (q.status === 404 && code === "not_found"), `${tag} GET /v1/withdraw/fee: ${q.status === 404 ? "not carried, " : ""}${q.status} ${q.status === 200 ? "quoted" : show(code)}`);
  }
  const pools = run.solana ?? [];
  say(pools.length > 0, `Solana pools read: ${pools.map((p) => p.pool).join(", ") || "none"}`);
  for (const p of pools) {
    const tag = `[solana ${p.pool.slice(0, 8)}]`;
    answers.push([`${tag} GET /v1/pool/fee`, p.fee]);
    const f = json(p.fee?.body);
    say(p.fee?.status === 200 && DEC.test(f?.fee ?? "") && B58.test(f?.fee_payer ?? ""), `${tag} GET /v1/pool/fee answers ${p.fee?.status}, fee ${show(f?.fee)}`);
    for (const [asked, want] of SOLANA_PLANTS) {
      const r = (p.posts ?? []).find((x) => x.asked === asked);
      if (!r) {
        say(false, `${tag} ${asked}: not posted`);
        continue;
      }
      answers.push([`${tag} ${asked}`, r]);
      const body = json(r.body);
      say(r.status === 422 && body?.error?.code === want, `${tag} ${asked}: ${r.status} ${show(body?.error?.code)}, want 422 ${want}`);
      if (asked === "program_fails") say(/^\{"InstructionError":/.test(body?.error?.detail ?? ""), `${tag} ${asked}: the simulation ran the program (${show(body?.error?.detail)})`);
      say(!/"signature"/.test(r.body ?? ""), `${tag} ${asked}: no signature in the answer`);
    }
  }
  for (const [what, r] of answers) {
    const c = r?.headers?.["x-helper-commit"];
    say(SHA.test(c ?? "") && (run.commit === undefined || c === run.commit), `${what}: X-Helper-Commit ${show(c)}${run.commit === undefined ? "" : `, asked ${run.commit}`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ---- The reads ----

async function rpc(url, method, params, fetchFn) {
  const r = await fetchFn(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "lc", method, params }), signal: AbortSignal.timeout(10_000) });
  const a = await r.json();
  if (a.error !== undefined || a.result === undefined) throw new Error(`${url} ${method}: ${JSON.stringify(a.error ?? "no result").slice(0, 200)}`);
  return a.result;
}

/** storage_balance_bounds() of `token` on both of `urls` at the lower of their two finals. */
export async function boundsAt(urls, token, fetchFn = fetch) {
  try {
    const finals = await Promise.all(urls.map((u) => rpc(u, "block", { finality: "final" }, fetchFn)));
    const height = Math.min(...finals.map((f) => f.header.height));
    const params = { request_type: "call_function", account_id: token, method_name: "storage_balance_bounds", args_base64: "e30=", block_id: height };
    return await Promise.all(urls.map(async (u) => {
      const r = await rpc(u, "query", params, fetchFn);
      return { rpc: u, block_height: r.block_height, block_hash: r.block_hash, result: Buffer.from(r.result).toString("utf8").slice(0, 300) };
    }));
  } catch (e) {
    return { error: e.message.slice(0, 300) };
  }
}

export async function read(base = BASE, { fetchFn = fetch, pools = solanaPools() } = {}) {
  const get = async (url, init = {}) => {
    const r = await fetchFn(url, { ...init, redirect: "error", headers: { origin: APP, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    return { readAt: new Date().toISOString(), status: r.status, headers: Object.fromEntries(r.headers), body: (await r.text()).slice(0, 2_000) };
  };
  const near = {};
  for (const network of ["mainnet", "testnet"]) {
    const quote = await get(`${base}/v1/withdraw/fee?token=${encodeURIComponent(TOKENS[network])}`);
    near[network] = { quote, bounds: await boundsAt(PAIRS[network], TOKENS[network], fetchFn) };
  }
  const solana = [];
  for (const pool of Object.values(pools).filter((p) => p !== null)) {
    const fee = await get(`${base}/v1/pool/fee?pool=${encodeURIComponent(pool)}`);
    const f = json(fee.body);
    const posts = [];
    if (fee.status === 200 && DEC.test(f?.fee ?? "") && B58.test(f?.program ?? "") && B58.test(f?.fee_payer ?? "") && RENT_RPCS[f?.cluster]) {
      const cfg = { program: f.program, pool, feePayer: f.fee_payer };
      // a recent blockhash of the cluster, so the simulation runs the program instead of stopping at the blockhash
      const bh = (await rpc(RENT_RPCS[f.cluster][0], "getLatestBlockhash", [{ commitment: "finalized" }], fetchFn))?.value?.blockhash;
      if (typeof bh !== "string" || !B58.test(bh)) throw new Error(`getLatestBlockhash on ${RENT_RPCS[f.cluster][0]}: no blockhash`);
      for (const [asked] of SOLANA_PLANTS) {
        const wire = plant({ ...cfg, relayFee: asked === "zero_fee" ? 0n : BigInt(f.fee), blockhash: b58decode(bh) });
        posts.push({ asked, ...(await get(`${base}/v1/pool/solana/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool, tx: wire.toString("base64") }) })) });
      }
    }
    solana.push({ pool, fee, posts });
  }
  return { base, near, solana };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const commit = opt("--commit");
  if (commit !== undefined && !SHA.test(commit)) {
    console.error(`live-check ${KEY}: ERROR: --commit must be a full 40-hex sha`);
    process.exit(2);
  }
  try {
    const run = { ...(await read(opt("--base") ?? BASE)), ...(commit !== undefined && { commit }) };
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
