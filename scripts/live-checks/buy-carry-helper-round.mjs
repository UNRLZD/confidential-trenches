#!/usr/bin/env node
// Live check of card buy-carry-helper-round on HELPER_HOST: the helper carries a lone round of a buy's releases (tag 2s
// to one W, no tag 3), so a buy can carry a note's change in the same tap, with every check a tag 2 gets inside a buy.
// For each pool the helper must serve (poolsHere: the mainnet pool of contracts/pool-solana/deployments/mainnet.json,
// which poolsToRead of pool-senders-next-page-helper.mjs does not read, and each pool poolsToRead names) it reads GET /v1/pool/fee and
// POSTs /v1/pool/solana/pieces four plants built with that check's plant() (the kit's accounts, the published fee, a
// junk proof, a blockhash no cluster made), each signed by throwaway Ws made here:
//   - "round": two tag 2s of one W, no tag 3: every check on the bytes passes (shape, W, fee, nullifiers), so the helper
//     reaches its reads and the plant is refused there, 422 blockhash_not_found (simulation_failed when a provider
//     replaces the blockhash); never on its shape;
//   - "round_one": one tag 2 alone: the same;
//   - "two_wallets": two tag 2s of two Ws: refused on the bytes, 422 wallets_differ;
//   - "nullifier_twice": two tag 2s of one W naming one nullifier: refused on the bytes, 400 bad_shape "a nullifier twice".
// None answers a signature, so nothing is sent and the fee payer signs none of them. A helper before the card refuses
// every round on its shape (400 bad_shape, "every transaction a tag 2 but the last, a tag 3" or "not 2 to 4
// transactions"), and FAILs. It does not prove a round lands: only a mainnet buy that carries its change does, read on
// two RPCs (the wallet card's run record).
// After: helper
//   node scripts/live-checks/buy-carry-helper-round.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { BASE } from "./helper-pool-senders.mjs";
import { loadRecord } from "./helper-sol-fee-payer-mainnet.mjs";
import { plant, poolsToRead } from "./pool-senders-next-page-helper.mjs";

const KEY = "buy-carry-helper-round";
/** Each plant and the answers it may get: [status, error code, detail or undefined for any]. */
export const WANT = Object.freeze({
  round: [
    [422, "blockhash_not_found"],
    [422, "simulation_failed"],
  ],
  round_one: [
    [422, "blockhash_not_found"],
    [422, "simulation_failed"],
  ],
  two_wallets: [[422, "wallets_differ"]],
  nullifier_twice: [[400, "bad_shape", "a nullifier twice"]],
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

/** Each pool the check reads, { cluster, pool, program }: the mainnet deploy record's first, then poolsToRead's. */
export function poolsHere(main = loadRecord(), others = poolsToRead()) {
  return [{ cluster: "mainnet", pool: main.pool, program: main.program }, ...others.filter((p) => p.pool !== main.pool)];
}

/** The plants' bodies for one pool at its published fee: each a list of base64 v0 tag 2s. */
export function plants({ program, pool, feePayer, relayFee }) {
  const w1 = generateKeyPairSync("ed25519").privateKey;
  const w2 = generateKeyPairSync("ed25519").privateKey;
  const nul = () => Uint8Array.from([0, ...randomBytes(31)]);
  const tx = (w, nullifier = nul()) => plant({ program, pool, feePayer, relayFee, kind: "next_tag2", w, nullifier }).toString("base64");
  const same = nul();
  return {
    round: [tx(w1), tx(w1)],
    round_one: [tx(w1)],
    two_wallets: [tx(w1), tx(w2)],
    nullifier_twice: [tx(w1, same), tx(w1, same)],
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
    const hit = want.some(([s, c, d]) => r?.status === s && b?.error?.code === c && (d === undefined || b?.error?.detail === d));
    say(hit && !("signature" in (b ?? {})) && !("signatures" in (b ?? {})), `planted ${asked}: ${r?.status} ${r?.body?.slice(0, 120)} (want ${want.map(([s, c, d]) => `${s} ${c}${d ? ` "${d}"` : ""}`).join(" or ")})`);
  }
  for (const r of run.reads ?? []) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${r.asked}] X-Helper-Commit: ${r.headers?.["x-helper-commit"]}`);
  return { ok: lines.every((l) => l.startsWith("ok ")) && lines.length === 1 + Object.keys(WANT).length + (run.reads?.length ?? 0), lines };
}

/** Every run PASS, and one for each pool of `want`. */
export function judgeAll(runs, want = poolsHere()) {
  const lines = [];
  for (const w of want) if (!runs.some((r) => r.pool === w.pool && r.cluster === w.cluster)) lines.push(`BAD [${w.cluster}] no run for pool ${w.pool}`);
  for (const run of runs) lines.push(...judge(run).lines);
  return { ok: runs.length > 0 && !lines.some((l) => l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.indexOf(k) < 0 ? undefined : args[args.indexOf(k) + 1]);
  try {
    const pools = poolsHere();
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
