#!/usr/bin/env node
// Live check of card relayer-withdraw-fee: HELPER_HOST quotes an absolute relay fee the device can take (markets paper
// LD5, M:96; H3.3, M:1068-1082; the route row, M:3361; the kit's HelperWithdrawFeeAnswer, packages/kit/src/helper/v1.ts).
// It reads GET /v1/withdraw/fee for mainnet USDC, for the testnet token, and for another token, with Origin APP_HOST;
// then, as the device does, its own fee_max for each network from its own reads (wallet src/withdraw/feemax.ts): the
// gas_price of one final block both of the network's release RPCs hold (finals at most 30 blocks apart, one hash, one
// price), Ref pool 4512 on mainnet at one such block, byte-equal on both, its USDC side at 250,000 USDC or more, and the
// token's storage_balance_bounds().min (the register_deposit a fresh A pays). It passes only when, for each network:
//   - the answer is 200 with exactly the kit's 7 fields, each in the form the device's parser takes (askWithdrawFee):
//     relay_fee, gp and g_w canonical decimals, relay_fee below 2^128, px a decimal, valid_until_block a height;
//   - relayer_account and fee_recipient are the release's relayer, byte for byte: the pair packages/wallet/src/withdraw/
//     relay.ts RELEASE_WITHDRAW_RELAYER writes for the network, read from this checkout's source (live.yml checks out the
//     deployed commit) by wallet-mainnet-relayer-pins.mjs's loadWithdrawPins, never from the helper; a network the
//     release names no relayer on FAILs;
//   - relay_fee is at most the fee_max the device computes now (and P1's half of it is printed);
//   - valid_until_block is still open at the device's agreed height and at most 100 + 30 blocks past it;
// and another token answers 404 not_found, every answer under 1 KB with a full-sha X-Helper-Commit and APP_HOST echoed.
// After: helper
//   node scripts/live-checks/relayer-withdraw-fee.mjs [--base <url>] [--fastnear-mainnet <url>] [--fastnear-testnet <url>]
//     [--record <file>] [--answer <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { loadWithdrawPins } from "./wallet-mainnet-relayer-pins.mjs";

const KEY = "relayer-withdraw-fee";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = { mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", testnet: "bf-usdc-20261101t022248.testnet" }; // gitleaks:allow (public account ids)
export const OTHER = "usdt.tether-token.near";
export const PAIRS = { mainnet: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"], testnet: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"] };
/** The device's FastNEAR side may be either of FastNEAR's URLs (wallet deposit/account.ts NEAR_NETWORKS): --fastnear picks one. */
export const FASTNEAR = { mainnet: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"], testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] }; // near-rpc-operators: one operator (FastNEAR's alternatives; --fastnear picks one, paired with dRPC)
/** The release's withdrawal relayer on each network: relay.ts's RELEASE_WITHDRAW_RELAYER, the one source. */
export const RELEASE_RELAYER = Object.freeze(loadWithdrawPins());
const FIELDS = ["relayer_account", "fee_recipient", "relay_fee", "gp", "px", "g_w", "valid_until_block"];
const DEC = /^(0|[1-9][0-9]{0,38})$/;
const PX = /^(0|[1-9][0-9]{0,38})(\.[0-9]{1,39})?$/;
const SHA = /^[0-9a-f]{40}$/;
const WINDOW = 100;
const SPREAD = 30;

// The device's fee_max (wallet src/withdraw/feemax.ts withdrawFeeMax; its constants, held by this check's test to the
// device's figures): ceil((G_cap × gp × 1.5 + S_cap) × poolToken / poolNear).
const G_CAP = 185_010_000_000_000n;
const B_CAP = 858n;
const YOCTO_PER_BYTE = 10n ** 19n;
const G_SETTLE_CAP = 104_475_000_000_000n;
const G_ARM_CAP = 100_000_000_000_000n;
const A_FUND = 182n * YOCTO_PER_BYTE + 7n * 10n ** 21n;
const POOL_MIN = 250_000_000_000n;
export function deviceFeeMax({ gasPrice: gp, poolToken, poolNear, registerDeposit }) {
  const aCap = A_FUND + G_ARM_CAP * gp;
  const sCap = 2n * (B_CAP * YOCTO_PER_BYTE + registerDeposit + G_SETTLE_CAP * gp + aCap);
  const num = (G_CAP * gp * 3n + 2n * sCap) * poolToken;
  const den = 2n * poolNear;
  return (num + den - 1n) / den;
}

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/**
 * The check on one recorded run: { reads: [{ asked, status, headers, body }], device: { mainnet, testnet } }, each
 * device entry { height, gasPrice, poolToken, poolNear, registerDeposit } as decimal strings or an { error }.
 */
export function judge(run, relayer) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const network of ["mainnet", "testnet"]) {
    const tag = `[${network}]`;
    const r = run.reads.find((x) => x.asked === TOKENS[network]);
    const rel = relayer?.[network];
    if (!r) {
      say(false, `${tag} no read`);
      continue;
    }
    say(r.status === 200, `${tag} GET /v1/withdraw/fee answers ${r.status}`);
    const b = json(r.body);
    const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
    say(keys.length === FIELDS.length && FIELDS.every((k) => keys.includes(k)), `${tag} fields: ${show(keys)}`);
    const fee = typeof b?.relay_fee === "string" && DEC.test(b.relay_fee) && BigInt(b.relay_fee) < 1n << 128n ? BigInt(b.relay_fee) : null;
    say(fee !== null, `${tag} relay_fee ${show(b?.relay_fee)}: an absolute amount in base units, a u128 decimal`);
    say(typeof b?.gp === "string" && DEC.test(b.gp) && typeof b?.g_w === "string" && DEC.test(b.g_w), `${tag} gp ${show(b?.gp)} and g_w ${show(b?.g_w)}: decimals`);
    say(typeof b?.px === "string" && PX.test(b.px), `${tag} px ${show(b?.px)}: a decimal`);
    say(Number.isSafeInteger(b?.valid_until_block) && b.valid_until_block > 0, `${tag} valid_until_block ${show(b?.valid_until_block)}: a height`);
    if (!rel) say(false, `${tag} the release's relayer: relay.ts names none on ${network}`);
    else say(b?.relayer_account === rel.relayer_account && b?.fee_recipient === rel.fee_recipient, `${tag} relayer_account ${show(b?.relayer_account)}, fee_recipient ${show(b?.fee_recipient)}: the release's ${rel.relayer_account}, ${rel.fee_recipient}`);
    say(Buffer.byteLength(r.body) <= 1024, `${tag} ${Buffer.byteLength(r.body)} bytes, within 1 KB (H7)`);
    const d = run.device?.[network];
    if (!d || d.error !== undefined) {
      say(false, `${tag} the device's own reads: ${d ? d.error : "missing"}`);
    } else {
      const max = deviceFeeMax({ gasPrice: BigInt(d.gasPrice), poolToken: BigInt(d.poolToken), poolNear: BigInt(d.poolNear), registerDeposit: BigInt(d.registerDeposit) });
      say(fee !== null && fee <= max, `${tag} relay_fee ${fee} <= the device's fee_max ${max} (gp ${d.gasPrice}, pool ${d.poolToken} / ${d.poolNear}); ${fee === null ? "" : `ratio ${(Number(fee) / Number(max)).toFixed(4)}, P1's bound 0.5`}`);
      const h = Number(d.height);
      say(Number.isSafeInteger(b?.valid_until_block) && b.valid_until_block >= h && b.valid_until_block <= h + WINDOW + SPREAD, `${tag} valid_until_block ${show(b?.valid_until_block)} open at the device's block ${h}, at most ${WINDOW + SPREAD} past it`);
    }
  }
  const o = run.reads.find((x) => x.asked === OTHER);
  say(o?.status === 404 && json(o.body)?.error?.code === "not_found", `token=${OTHER} answers ${o?.status} ${o?.body?.slice(0, 80)}`);
  for (const r of run.reads) {
    say(SHA.test(r.headers["x-helper-commit"] ?? ""), `[${r.asked.slice(0, 12)}] X-Helper-Commit: ${show(r.headers["x-helper-commit"])}`);
    say(r.headers["access-control-allow-origin"] === APP && r.headers["access-control-allow-credentials"] === undefined, `[${r.asked.slice(0, 12)}] Access-Control-Allow-Origin: ${show(r.headers["access-control-allow-origin"])}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ---- The device's own reads ----

async function rpc(url, method, params, fetchFn) {
  const r = await fetchFn(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "lc", method, params }), signal: AbortSignal.timeout(10_000) });
  const a = await r.json();
  if (a.error !== undefined || a.result === undefined) throw new Error(`${url} ${method}: ${JSON.stringify(a.error ?? "no result").slice(0, 200)}`);
  return a.result;
}

async function agreed(urls, fetchFn) {
  const finals = await Promise.all(urls.map((u) => rpc(u, "block", { finality: "final" }, fetchFn)));
  const hs = finals.map((f) => f.header.height);
  if (Math.abs(hs[0] - hs[1]) > SPREAD) throw new Error(`finals ${hs.join(", ")} more than ${SPREAD} apart`);
  const height = Math.min(...hs);
  const [x, y] = (await Promise.all(urls.map((u) => rpc(u, "block", { block_id: height }, fetchFn)))).map((b) => b.header);
  if (x.height !== height || y.height !== height || x.hash !== y.hash || x.gas_price !== y.gas_price) throw new Error(`block ${height}: the RPCs disagree`);
  return { height, hash: x.hash, gasPrice: x.gas_price };
}

async function viewBoth(urls, b, account, method, args, fetchFn) {
  const params = { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), block_id: b.height };
  const rs = await Promise.all(urls.map((u) => rpc(u, "query", params, fetchFn)));
  for (const r of rs) if (r.block_height !== b.height || r.block_hash !== b.hash) throw new Error(`${method}: not at block ${b.height}`);
  const [p, q] = rs.map((r) => Buffer.from(r.result));
  if (!p.equals(q)) throw new Error(`${method}: the RPCs' bytes differ`);
  return JSON.parse(p.toString("utf8"));
}

export async function deviceReads(network, fetchFn = fetch) {
  try {
    const [b, price] = await Promise.all([agreed(PAIRS[network], fetchFn), network === "mainnet" ? null : agreed(PAIRS.mainnet, fetchFn)]);
    const pool = await viewBoth(PAIRS.mainnet, price ?? b, "v2.ref-finance.near", "get_pool", { pool_id: 4512 }, fetchFn);
    if (pool.pool_kind !== "SIMPLE_POOL" || pool.token_account_ids?.[0] !== TOKENS.mainnet || pool.token_account_ids?.[1] !== "wrap.near") throw new Error("not the USDC / wNEAR pool");
    if (!DEC.test(pool.amounts?.[0] ?? "") || !DEC.test(pool.amounts?.[1] ?? "") || BigInt(pool.amounts[0]) < POOL_MIN) throw new Error("the pool's amounts are not two decimals over its floor");
    const bounds = await viewBoth(PAIRS[network], b, TOKENS[network], "storage_balance_bounds", {}, fetchFn);
    if (!DEC.test(bounds.min ?? "")) throw new Error("storage_balance_bounds: no min");
    return { height: String(b.height), gasPrice: b.gasPrice, poolToken: pool.amounts[0], poolNear: pool.amounts[1], registerDeposit: bounds.min };
  } catch (e) {
    return { error: e.message.slice(0, 300) };
  }
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  for (const token of [TOKENS.mainnet, TOKENS.testnet, OTHER]) {
    const readAt = new Date().toISOString();
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/withdraw/fee?token=${encodeURIComponent(token)}`, { method: "GET", redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
    const headers = {};
    for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
    reads.push({ asked: token, readAt, status: r.status, headers, body: await r.text() });
  }
  const device = { mainnet: await deviceReads("mainnet", fetchFn), testnet: await deviceReads("testnet", fetchFn) };
  return { base, reads, device };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  for (const n of ["mainnet", "testnet"]) {
    const u = opt(`--fastnear-${n}`);
    if (u === undefined) continue;
    if (!FASTNEAR[n].includes(u)) {
      console.error(`live-check ${KEY}: ERROR: --fastnear-${n} must be one of ${FASTNEAR[n].join(", ")}`);
      process.exit(2);
    }
    PAIRS[n][0] = u;
  }
  try {
    const run = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : await read(opt("--base", BASE));
    if (!opt("--answer")) {
      run.relayer = RELEASE_RELAYER;
      run.pairs = PAIRS;
    }
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run, RELEASE_RELAYER);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
