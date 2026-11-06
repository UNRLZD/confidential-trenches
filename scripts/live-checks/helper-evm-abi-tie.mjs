#!/usr/bin/env node
// Live check of card helper-evm-abi-tie: HELPER_HOST carries the withdraw each deployed EVM pool runs, and refuses the
// one it does not. For each testnet pool the kit pins (evmPoolVenues(): Base Sepolia, Robinhood testnet) it reads:
//   - the pool's code on both of the chain's RPCs (pool-evm-testnet-run.mjs RPCS), the same bytes on both, whose
//     dispatcher holds PUSH4 of each selector in CALLS (withdraw with W's signature, buy, deposit) and not withdraw's
//     three-argument selector, which no pool runs. The pinned sell delegates are not read here: on 6 Nov 14:45Z both
//     dispatched the ten-field sell (0xbea5695c) of the build before pool-review-3, not the source's eleven-field one
//     (0x0c2cb9ca), a redeploy this card does not make;
//   - a real withdraw that landed on that pool (the first withdraw of pool-evm-testnet-run.<network>.json), its input
//     read on both RPCs, the same on both;
//   - GET /v1/pool/fee?pool=<pool> (its fee_recipient), then three POST /v1/pool/evm/send, none of which can send: the
//     landed withdraw's calldata with its fee recipient word made the fee answer's, at the epoch now: its deadline is
//     past, so a helper that reads the pool's withdraw answers 422 epoch_off before any RPC call (and its nullifier is
//     spent, so nothing could land); the same request in the three-argument encoding (no signature): 400 bad_shape;
//     the landed calldata and one byte more: 400 bad_shape.
// It passes only when every read above holds and every helper answer carries one full-sha X-Helper-Commit, the same on
// every read of the run (one helper answered all of it, never two builds behind one host). The selectors
// are this file's strings, which contracts/pool-evm/test/abi-tie.test.mjs holds to contracts/pool-evm/abi.json.
//   node scripts/live-checks/helper-evm-abi-tie.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
// --in-process answers the fee read and the three POSTs from this checkout's apps/helper/src/pool/evm.ts
// evmPoolSender() (fee() on the kit's feeProviders, carry()), with a throwaway sender key holding nothing and the host's
// fee recipient, instead of the host: a constructed answer, marked so in the record, for a helper not deployed. Once the
// fix is deployed, `node scripts/live-checks/helper-evm-abi-tie.mjs --record <file>` records the host's real run.
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { RPCS } from "./pool-evm-testnet-run.mjs";

const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { keccak_256 } = req("@noble/hashes/sha3.js");

export const BASE = "https://api.confidential.unrealized.trade";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NETWORKS = ["base-sepolia", "robinhood-testnet"];
const selector = (sig) => Buffer.from(keccak_256(new TextEncoder().encode(sig))).subarray(0, 4).toString("hex");
const WITHDRAW = "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)";
/** The selector the helper sent before this card, which no pool runs. */
const WITHDRAW_3 = selector("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)");
/** What each contract's dispatcher must hold. */
export const CALLS = Object.freeze({
  pool: [WITHDRAW, "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)", "deposit(uint256,uint256)"],
});
/** Each POST, the status and the code it must get. */
export const PLANTS = [
  ["landed_withdraw", 422, "epoch_off"],
  ["three_argument", 400, "bad_shape"],
  ["trailing_byte", 400, "bad_shape"],
];
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const lower = (s) => String(s).toLowerCase();
/** True when `code` (0x hex) holds PUSH4 `sel` (8 hex). */
const pushes4 = (code, sel) => lower(code).includes(`63${sel}`);

/** The three bodies from a landed withdraw's calldata: its fee recipient (word 23) made `feeTo`. */
export function bodiesOf(input, pool, feeTo, epoch) {
  const h = lower(input).slice(2);
  const four = `${h.slice(0, 8 + 64 * 23)}${lower(feeTo).slice(2).padStart(64, "0")}${h.slice(8 + 64 * 24)}`;
  // the same Withdrawal, proof and fee in the three-argument encoding: head 18 words, no signature
  const words = Array.from({ length: (four.length - 8) / 64 }, (_, i) => four.slice(8 + 64 * i, 8 + 64 * (i + 1)));
  const three = `${WITHDRAW_3}${(18n * 32n).toString(16).padStart(64, "0")}${words.slice(1, 18).join("")}${words.slice(19, 28).join("")}`;
  return {
    landed_withdraw: { pool, data: `0x${four}`, epoch },
    three_argument: { pool, data: `0x${three}`, epoch },
    trailing_byte: { pool, data: `0x${four}00`, epoch },
  };
}

/** The check on one recorded run: { base, constructed?, pools: [{ network, pool, code: { pool }, landed, reads }] }. */
export function judge(run, { venues = evmPoolVenues() } = {}) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const pools = run.pools ?? [];
  say(NETWORKS.every((n) => pools.some((p) => p.network === n && p.pool === venues[n]?.pool)) && pools.length === NETWORKS.length, `pools read: ${show(pools.map((p) => `${p.network} ${p.pool}`))}, want the kit's pins on ${show(NETWORKS)}`);
  for (const p of pools) {
    const n = p.network;
    for (const [what, sigs] of Object.entries(CALLS)) {
      const reads = p.code?.[what] ?? [];
      const codes = reads.map((r) => lower(r.code));
      say(reads.length === 2 && reads.every((r) => RPCS[n].includes(r.url)) && new Set(reads.map((r) => r.url)).size === 2 && codes[0].length > 2 && codes[0] === codes[1], `[${n} ${what}] code on ${show(reads.map((r) => r.url))}: ${codes.map((c) => (c.length - 2) / 2).join(" and ")} bytes, the same on both`);
      for (const sig of sigs) say(codes.length === 2 && codes.every((c) => pushes4(c, selector(sig))), `[${n} ${what}] dispatches 0x${selector(sig)} ${sig}`);
      if (what === "pool") say(codes.length === 2 && codes.every((c) => !pushes4(c, WITHDRAW_3)), `[${n} pool] does not dispatch 0x${WITHDRAW_3}, withdraw with no signature`);
    }
    const l = p.landed ?? {};
    say(l.reads?.length === 2 && l.reads.every((r) => RPCS[n].includes(r.url) && lower(r.to) === p.pool && r.status === "0x1") && lower(l.reads[0].input) === lower(l.reads[1].input) && lower(l.reads[0].input).startsWith(`0x${selector(WITHDRAW)}`), `[${n} landed] ${l.hash}: to the pool, status 1, input 0x${lower(l.reads?.[0]?.input ?? "").slice(2, 10)} on both RPCs`);
    const f = p.reads?.find((r) => r.asked === "fee");
    const fee = json(f?.body ?? "");
    say(f?.status === 200 && fee?.pool === p.pool && ADDRESS.test(fee?.fee_recipient ?? ""), `[${n} fee] GET /v1/pool/fee answers ${f?.status}, fee_recipient ${show(fee?.fee_recipient)}`);
    for (const [asked, status, code] of PLANTS) {
      const r = p.reads?.find((x) => x.asked === asked);
      const e = json(r?.body ?? "");
      say(r?.status === status && e?.error?.code === code && e?.hash === undefined, `[${n} ${asked}] POST /v1/pool/evm/send answers ${r?.status} ${r?.body?.slice(0, 120)} (want ${status} ${code})`);
    }
    for (const r of p.reads ?? []) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${n} ${r.asked}] X-Helper-Commit: ${show(r.headers?.["x-helper-commit"])}`);
  }
  const commits = [...new Set(pools.flatMap((p) => (p.reads ?? []).map((r) => r.headers?.["x-helper-commit"] ?? null)))];
  say(commits.length === 1, `one X-Helper-Commit across the run: ${show(commits)}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ---- The reads ----

async function rpc(url, method, params) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    if (j.result !== undefined && j.result !== null) return j.result;
    if (i >= 3) throw new Error(`${url} ${method}: ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 1_000 * (i + 1)));
  }
}

const landedOf = (network) => JSON.parse(readFileSync(path.join(HERE, `pool-evm-testnet-run.${network}.json`), "utf8")).txs.find((t) => t.kind === "withdraw").hash;

async function collect(base, inProcess) {
  const venues = evmPoolVenues();
  const commit = inProcess ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).trim() : undefined;
  const carryOf = inProcess ? (await import("../../apps/helper/src/pool/evm.ts")).evmPoolSender : undefined;
  const pools = [];
  for (const network of NETWORKS) {
    const v = venues[network];
    const p = { network, pool: v.pool, code: {}, reads: [] };
    for (const what of Object.keys(CALLS)) p.code[what] = await Promise.all(RPCS[network].map(async (url) => ({ url, code: await rpc(url, "eth_getCode", [v[what], "latest"]) })));
    const hash = landedOf(network);
    p.landed = { hash, reads: await Promise.all(RPCS[network].map(async (url) => { const tx = await rpc(url, "eth_getTransactionByHash", [hash]); const rc = await rpc(url, "eth_getTransactionReceipt", [hash]); return { url, to: tx.to, input: tx.input, status: rc.status }; })) };
    const get = await fetch(`${base}/v1/pool/fee?pool=${v.pool}`, { signal: AbortSignal.timeout(20_000) });
    const hostFee = { status: get.status, headers: { "x-helper-commit": get.headers.get("x-helper-commit") }, body: await get.text() };
    const feeTo = json(hostFee.body)?.fee_recipient ?? `0x${"0".repeat(40)}`;
    const epoch = Math.floor(Date.now() / 60_000) * 60_000;
    const bodies = bodiesOf(p.landed.reads[0].input, v.pool, feeTo, epoch);
    // in-process: the branch's sender on the kit's fee providers, a throwaway key (no gas: nothing it signs could land)
    const sender = carryOf?.({ network, pool: v.pool, senderKey: new Uint8Array(32).fill(7), feeRecipient: feeTo }, v.feeProviders.map((url) => (method, params) => rpc(url, method, params)));
    if (sender) {
      p.feeRecipientFrom = { base, ...hostFee };
      const a = await sender.fee(Date.now());
      p.reads.push({ asked: "fee", status: a === null ? 503 : 200, headers: { "x-helper-commit": commit }, body: JSON.stringify(a) });
    } else p.reads.push({ asked: "fee", ...hostFee });
    for (const [asked] of PLANTS) {
      if (sender) {
        const a = await sender.carry(bodies[asked]);
        p.reads.push({ asked, status: a.status, headers: { "x-helper-commit": commit }, body: JSON.stringify(a.body) });
      } else {
        const r = await fetch(`${base}/v1/pool/evm/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodies[asked]), signal: AbortSignal.timeout(20_000) });
        p.reads.push({ asked, status: r.status, headers: { "x-helper-commit": r.headers.get("x-helper-commit") }, body: await r.text() });
      }
    }
    pools.push(p);
  }
  return { base: inProcess ? `in-process apps/helper/src/pool/evm.ts at ${commit} (constructed: not the deployed host)` : base, ...(inProcess ? { constructed: true } : {}), at: new Date().toISOString(), pools };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const run = await collect(opt("--base") ?? BASE, args.includes("--in-process"));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    console.log(lines.join("\n"));
    console.log(ok ? "PASS" : "FAIL");
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
