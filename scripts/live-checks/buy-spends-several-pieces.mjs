#!/usr/bin/env node
// Live check of card buy-spends-several-pieces on HELPER_HOST: the helper carries a buy of several pieces (every release
// first, the buy last) only as one bundle to one W. For each pool the helper must serve (poolsToRead of
// pool-senders-next-page-helper.mjs: each Solana cluster's deploy record pool, and on devnet each pool of the move) it
// reads GET /v1/pool/fee and POSTs /v1/pool/solana/pieces three plants built with that check's plant() (the kit's
// accounts, the published fee, a junk proof, a blockhash no cluster made), each signed by throwaway Ws made here:
//   - "two_wallets": a tag 2 signed by one W, then a tag 3 signed by another: refused on the bytes, 422 wallets_differ;
//   - "one_tx": the tag 3 alone: no bundle of pieces, refused on the bytes, 400 bad_shape;
//   - "one_wallet": a tag 2 and a tag 3 of the same W: every check on the bytes passes, so the helper reaches its reads
//     and refuses the plant's junk blockhash, 422 blockhash_not_found (simulation_failed when a provider replaces it),
//     or, on mainnet at an epoch whose fee prices the plant's relay fee under the bundle's cost, fee_below_cost first.
// None answers a signature. A helper before the card has no such route: 404 for each, and FAILs. Nothing is sent and
// the fee payer signs none of them. It does not prove a bundle lands: only a mainnet buy of several pieces does, read
// on two RPCs (the run record's Tx lines).
// After: helper
//   node scripts/live-checks/buy-spends-several-pieces.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { BASE } from "./helper-pool-senders.mjs";
import { plant, poolsToRead } from "./pool-senders-next-page-helper.mjs";

const KEY = "buy-spends-several-pieces";
/** Each plant and the answer it must get: status and error code. */
export const WANT = Object.freeze({
  two_wallets: [[422, "wallets_differ"]],
  one_tx: [[400, "bad_shape"]],
  one_wallet: [
    [422, "blockhash_not_found"],
    [422, "simulation_failed"],
    [422, "fee_below_cost"],
  ],
});
const SHA = /^[0-9a-f]{40}$/;
const DEC = /^(0|[1-9]\d*)$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The plants' bodies for one pool at its published fee: each a list of base64 v0 transactions, every release first. */
export function plants({ program, pool, feePayer, relayFee }) {
  const w1 = generateKeyPairSync("ed25519").privateKey;
  const w2 = generateKeyPairSync("ed25519").privateKey;
  const nul = () => Uint8Array.from([0, ...randomBytes(31)]);
  const tx = (kind, w) => plant({ program, pool, feePayer, relayFee, kind, w, nullifier: nul() }).toString("base64");
  return {
    two_wallets: [tx("next_tag2", w1), tx("next_tag3", w2)],
    one_tx: [tx("next_tag3", w1)],
    one_wallet: [tx("next_tag2", w1), tx("next_tag3", w1)],
  };
}

/** One pool's reads: its fee, then each plant POSTed to the pieces route. */
export async function read(base, pool, fetchFn = fetch) {
  const reads = [];
  const get = async (asked, url, init = {}) => {
    const r = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const body = await r.text();
    reads.push({ asked, readAt: new Date().toISOString(), status: r.status, headers: Object.fromEntries(r.headers), body: body.slice(0, 2_000) });
    return json(body);
  };
  const f = await get("fee", `${base}/v1/pool/fee?pool=${encodeURIComponent(pool)}`);
  if (f && DEC.test(f.fee ?? "") && B58.test(f.program ?? "") && B58.test(f.fee_payer ?? "")) {
    for (const [asked, txs] of Object.entries(plants({ program: f.program, pool, feePayer: f.fee_payer, relayFee: BigInt(f.fee) }))) {
      await get(asked, `${base}/v1/pool/solana/pieces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool, txs }) });
    }
  }
  return { pool, reads };
}

/** The check on one recorded run { cluster, pool, reads: [{ asked, status, headers, body }] }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} [${run.cluster}] ${text}`);
  const fee = run.reads?.find((r) => r.asked === "fee");
  say(fee?.status === 200 && json(fee.body)?.pool === run.pool, `GET /v1/pool/fee ${run.pool} answers ${fee?.status}`);
  for (const [asked, want] of Object.entries(WANT)) {
    const r = run.reads?.find((x) => x.asked === asked);
    const b = json(r?.body ?? "");
    const hit = want.some(([s, c]) => r?.status === s && b?.error?.code === c);
    say(hit && !("signature" in (b ?? {})) && !("signatures" in (b ?? {})), `planted ${asked}: ${r?.status} ${r?.body?.slice(0, 120)} (want ${want.map(([s, c]) => `${s} ${c}`).join(" or ")})`);
  }
  for (const r of run.reads ?? []) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${r.asked}] X-Helper-Commit: ${r.headers?.["x-helper-commit"]}`);
  return { ok: lines.every((l) => l.startsWith("ok ")) && lines.length === 1 + Object.keys(WANT).length + (run.reads?.length ?? 0), lines };
}

/** Every run PASS, and one for each pool of `want`. */
export function judgeAll(runs, want = poolsToRead()) {
  const lines = [];
  for (const w of want) if (!runs.some((r) => r.pool === w.pool && r.cluster === w.cluster)) lines.push(`BAD [${w.cluster}] no run for pool ${w.pool}`);
  for (const run of runs) lines.push(...judge(run).lines);
  return { ok: runs.length > 0 && !lines.some((l) => l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.indexOf(k) < 0 ? undefined : args[args.indexOf(k) + 1]);
  try {
    const pools = poolsToRead();
    if (pools.length === 0) throw new Error("no Solana pool record");
    const runs = [];
    for (const { cluster, pool, program } of pools) runs.push({ cluster, program, ...(await read(opt("--base") ?? BASE, pool)) });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(runs, null, 1)}\n`);
    const r = judgeAll(runs);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
