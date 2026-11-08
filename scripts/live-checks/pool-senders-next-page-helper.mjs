#!/usr/bin/env node
// Live check of card pool-senders-next-page-helper: HELPER_HOST's Solana pool sender takes the forms the pool program takes
// since d3edab1 (contracts/pool-solana/src/release.rs:155, buy.rs:155-159): a tag 2 naming the next state page as its
// ninth account, and a tag 3 with flag bit 1 naming it after the tip account. For each pool the helper must serve
// (poolsToRead: each Solana cluster's deploy record pool, scripts/ci/helper-live-checks.mjs solanaPools, and on devnet
// each pool of the move, DEVNET_MOVE, each with its own program) it reads GET /v1/pool/fee for that pool, which must
// name that program, then POSTs /v1/pool/solana/send three releases it builds with
// the kit for that pool and fee payer, each signed by a throwaway W made here, at the published fee, a deadline 270 s
// away and a junk proof:
//   - "next_tag2": tag 2 with the release's eight accounts and the next state page (the kit's solanaPoolTag2Accounts);
//   - "next_tag3": tag 3, flag bit 1, the Jito tip account at 8 (a static key) and the next state page at 9, one inner
//     System transfer from W;
//   - "ten_tag2": tag 2 with a tenth account, which no form of the program takes.
// The two next-page forms pass every check the helper makes on the bytes and reach its simulation, which refuses the
// junk proof (422 simulation_failed); a helper that predates the card refuses them on the bytes (422 not_pool). The
// tenth account is refused on the bytes (422 not_pool) by both. Nothing is signed by the fee payer and nothing is sent.
//   node scripts/live-checks/pool-senders-next-page-helper.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_JITO_TIP_MIN,
  SOLANA_SYSTEM_PROGRAM,
  solanaCompileV0,
  solanaEncodePoolRelease,
  solanaEncodePoolTag3,
  solanaPoolPage,
  solanaPoolReleaseAccounts,
  SOLANA_POOL_PAGE_ENTRIES,
} from "../../packages/kit/src/index.ts";
import { solanaPools } from "../ci/helper-live-checks.mjs";
import { b58encode, BASE } from "./helper-pool-senders.mjs";

/** Each plant and the answer it must get from a helper with the card. */
export const PLANTS = [
  ["next_tag2", "simulation_failed"],
  ["next_tag3", "simulation_failed"],
  ["ten_tag2", "not_pool"],
];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEC = /^[1-9][0-9]{0,18}$/;
const SHA = /^[0-9a-f]{40}$/;
/** The devnet pools served side by side while the signing pages move from the one before the re-pin to today's (card
 *  pool-senders-next-page, the expand): a helper that serves one of them FAILs. The contract drops the old one here in
 *  the commit that drops its program from POOL_SOLANA_PROGRAM_DEVNET. */
export const DEVNET_MOVE = Object.freeze([
  Object.freeze({ program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr" }),
  Object.freeze({ program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", pool: "92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr" }),
]);
/** Each pool the check reads, { cluster, pool, program } (program null when only the deploy record names the pool):
 *  every cluster's record pool, and on devnet each pool of the move. */
export function poolsToRead(records = solanaPools()) {
  const out = [];
  for (const [cluster, pool] of Object.entries(records)) {
    const move = cluster === "devnet" ? DEVNET_MOVE : [];
    for (const m of move) out.push({ cluster, pool: m.pool, program: m.program });
    if (pool && !move.some((m) => m.pool === pool)) out.push({ cluster, pool, program: null });
  }
  return out;
}
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one recorded run: { pool, program?, reads: [{ asked, status, headers, body }] }; a run that names its
 *  program needs the fee answer to name that program. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const fee = run.reads.find((r) => r.asked === "fee");
  const f = json(fee?.body ?? "");
  say(fee?.status === 200 && f?.chain === "solana" && f?.pool === run.pool && B58.test(f?.program ?? "") && (run.program == null || f.program === run.program) && B58.test(f?.fee_payer ?? "") && DEC.test(f?.fee ?? ""), `GET /v1/pool/fee answers ${fee?.status}: pool ${f?.pool} (asked ${run.pool}), program ${f?.program}${run.program ? ` (want ${run.program})` : ""}, fee payer ${f?.fee_payer}, fee ${f?.fee}`);
  for (const [asked, code] of PLANTS) {
    const r = run.reads.find((x) => x.asked === asked);
    say(r?.status === 422 && json(r.body)?.error?.code === code, `planted ${asked}: POST /v1/pool/solana/send answers ${r?.status} ${r?.body?.slice(0, 120)} (want 422 ${code})`);
  }
  for (const r of run.reads) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${r.asked}] X-Helper-Commit: ${r.headers?.["x-helper-commit"]}`);
  return { ok: lines.length === PLANTS.length + 1 + run.reads.length && lines.every((l) => l.startsWith("ok ")), lines };
}

/** Every run: each PASS, at least one, and one for each pool of `want` (poolsToRead()) with its cluster and program. */
export function judgeAll(runs, want = poolsToRead()) {
  const lines = [];
  for (const w of want) if (!runs.some((r) => r.pool === w.pool && r.cluster === w.cluster && (r.program ?? null) === w.program)) lines.push(`BAD [${w.cluster}] no run for pool ${w.pool}${w.program ? ` (program ${w.program})` : ""}`);
  for (const run of runs) for (const l of judge(run).lines) lines.push(`${l.slice(0, 4)}[${run.cluster}] ${l.slice(4)}`);
  return { ok: runs.length > 0 && runs.every((run) => judge(run).ok) && !lines.some((l) => l.startsWith("BAD")), lines };
}

const field = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const u64 = (n) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));

/** One plant: a v0 transaction the fee payer pays (slot 0 empty) and a throwaway W signs. */
export function plant({ program, pool, feePayer, relayFee, kind, nowMs = Date.now(), w = generateKeyPairSync("ed25519").privateKey, nullifier = Uint8Array.from([0, ...randomBytes(31)]), blockhash = b58encode(Buffer.alloc(32, 1)) }) {
  const W = b58encode(createPublicKey(w).export({ format: "der", type: "spki" }).subarray(-32));
  const r = {
    proof: new Uint8Array(256).fill(7),
    newCommitmentHash: field(1),
    existingNullifierHash: nullifier,
    withdrawnValue: 50_000_000n,
    stateRootIndex: 5,
    stateTreeDepth: 3,
    labelRootIndex: 5,
    labelTreeDepth: 3,
    relayFee,
    relayFeeCap: relayFee,
    tipCap: 10_000n,
    deadlineMs: BigInt(nowMs) + 270_000n,
    salt: new Uint8Array(16).fill(9),
  };
  const cfg = { program, pool };
  // the next state page after the one holding entry 6 (src/state.rs page_for), writable: tag 2's ninth account, tag 3's after the tip
  const next = { key: solanaPoolPage(program, 0, (Math.floor(6 / SOLANA_POOL_PAGE_ENTRIES) + 1) * SOLANA_POOL_PAGE_ENTRIES), signer: false, writable: true };
  let accounts;
  let data;
  if (kind === "next_tag3") {
    accounts = [...solanaPoolReleaseAccounts(cfg, W, feePayer, r, 6), { key: SOLANA_JITO_TIP_ACCOUNTS[0], signer: false, writable: true }, next, { key: SOLANA_SYSTEM_PROGRAM, signer: false, writable: false }];
    // the inner System transfer of 1,000 lamports from W (1) to the tip account (8); its program at 10
    data = solanaEncodePoolTag3(r, false, SOLANA_JITO_TIP_MIN, [{ program: 10, accounts: [1, 8], data: Uint8Array.from([2, 0, 0, 0, ...u64(1_000n)]) }]);
    data[1] |= 2; // flag bit 1 (src/buy.rs FLAG_NEXT_PAGE): the next state page follows the tip account
  } else {
    accounts = [...solanaPoolReleaseAccounts(cfg, W, feePayer, r, 6), next];
    if (kind === "ten_tag2") accounts.push({ key: SOLANA_SYSTEM_PROGRAM, signer: false, writable: false });
    data = solanaEncodePoolRelease(r);
  }
  const cu = { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([2, 0x80, 0x1a, 0x06, 0]) }; // 400,000 CU
  const { message } = solanaCompileV0(feePayer, [cu, { program, accounts, data }], blockhash, [], [feePayer, W]);
  return Buffer.concat([Buffer.from([2]), Buffer.alloc(64), sign(null, message, w), Buffer.from(message)]);
}

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
    for (const [asked] of PLANTS) {
      const wire = plant({ program: f.program, pool, feePayer: f.fee_payer, relayFee: BigInt(f.fee), kind: asked });
      await get(asked, `${base}/v1/pool/solana/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool, tx: wire.toString("base64") }) });
    }
  }
  return { pool, reads };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i < 0 ? undefined : args[i + 1];
  };
  try {
    // each pool the helper must serve: every cluster's record pool, and on devnet each pool of the move
    const pools = poolsToRead();
    if (pools.length === 0) throw new Error("no Solana pool record");
    const runs = [];
    for (const { cluster, pool, program } of pools) runs.push({ cluster, program, ...(await read(opt("--base") ?? BASE, pool)) });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(runs, null, 1)}\n`);
    const r = judgeAll(runs);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS pool-senders-next-page-helper" : "FAIL pool-senders-next-page-helper");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`pool-senders-next-page-helper: ${e.message}`);
    process.exit(2);
  }
}
