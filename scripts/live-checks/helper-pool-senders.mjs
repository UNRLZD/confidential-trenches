#!/usr/bin/env node
// Live check of card helper-pool-senders: HELPER_HOST publishes its Solana pool fee and refuses a planted bad pool
// transaction without sending anything (apps/helper/src/pool/). It reads GET /v1/pool/fee for the pool twice, once
// with Origin APP_HOST and once with none (two callers), then POSTs /v1/pool/solana/send two transactions it builds for
// that pool and fee payer with a throwaway W key made here, each W-signed and good but for one field:
//   - "changed": a tag 2 release at the published fee, then one byte of the relay fee changed after W signed;
//   - "fee_off": the release at the published fee plus one step;
//   - "extra_instruction": the release, then a transfer out of the fee payer;
//   - "fee_payer_named": a tag 3 whose inner instruction names the fee payer (the pool instruction's account 2);
//   - "fee_payer_account": the release naming the fee payer as another pool account (its spent mark) too;
//   - "fee_below_cost": the release with a priority fee (1,400,000 CU at a price) over what the fee leaves;
//   - "inner_program": a tag 3 whose inner instruction invokes a program off the kit's list;
//   - "deadline_near": the release with a deadline one second away (under now plus 90 s).
// Each is refused before any read or send (apps/helper/src/pool/solana.ts checks them on the bytes alone), so the check
// never moves money. It passes only when:
//   - the fee answers 200 with exactly the kit's 10 fields, the pool and program asked, a fee_payer address, a 60 s
//     epoch with its start on the grid, a fee on its 100,000-lamport step and at least a release's worst cost
//     (1,026,000 lamports, a release's cost, apps/helper/src/pool/fee.ts, M352 (1)), and the same fee for both callers;
//   - every planted transaction answers 422 with its own code (PLANTS);
//   - every answer carries a full-sha X-Helper-Commit, and APP_HOST is echoed only to the read that sent it.
//   node scripts/live-checks/helper-pool-senders.mjs --pool <address> [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
const FIELDS = ["chain", "cluster", "program", "pool", "fee_payer", "epoch_ms", "epoch_start_ms", "fee", "step"];
export const COST_MIN = 1_026_000n;
/** Each planted transaction and the refusal it must get. */
export const PLANTS = [
  ["changed", "bad_signature"],
  ["fee_off", "fee_off"],
  ["extra_instruction", "extra_instruction"],
  ["fee_payer_named", "fee_payer_named"],
  ["fee_payer_account", "fee_payer_named"],
  ["fee_below_cost", "fee_below_cost"],
  ["inner_program", "inner_program"],
  ["deadline_near", "deadline_near"],
];
const STEP = 100_000n;
const SHA = /^[0-9a-f]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEC = /^[1-9][0-9]{0,18}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one recorded run: { pool, reads: [{ asked, origin, status, headers, body }] }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const fees = run.reads.filter((r) => r.asked === "fee");
  say(fees.length === 2, `two fee reads (${fees.length})`);
  const values = [];
  for (const r of fees) {
    const tag = `[fee ${r.origin ? "APP_HOST" : "no origin"}]`;
    say(r.status === 200, `${tag} GET /v1/pool/fee answers ${r.status}`);
    const b = json(r.body);
    const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
    say(keys.length === FIELDS.length && FIELDS.every((k) => keys.includes(k)), `${tag} fields: ${show(keys)}`);
    say(b?.chain === "solana" && b?.pool === run.pool && B58.test(b?.program ?? "") && B58.test(b?.fee_payer ?? ""), `${tag} pool ${show(b?.pool)} (asked ${run.pool}), program ${show(b?.program)}, fee payer ${show(b?.fee_payer)}`);
    say(b?.epoch_ms === 60_000 && Number.isSafeInteger(b?.epoch_start_ms) && b.epoch_start_ms % 60_000 === 0, `${tag} epoch ${show(b?.epoch_ms)} ms from ${show(b?.epoch_start_ms)}`);
    const fee = typeof b?.fee === "string" && DEC.test(b.fee) ? BigInt(b.fee) : null;
    say(fee !== null && b?.step === STEP.toString() && fee % STEP === 0n && fee >= COST_MIN, `${tag} fee ${show(b?.fee)} on its step ${show(b?.step)}, at least a release cost ${COST_MIN}`);
    values.push(b?.fee);
  }
  say(values.length === 2 && values[0] === values[1], `the same fee for both callers: ${show(values)}`);
  for (const [asked, code] of PLANTS) {
    const r = run.reads.find((x) => x.asked === asked);
    say(r?.status === 422 && json(r.body)?.error?.code === code, `planted ${asked}: POST /v1/pool/solana/send answers ${r?.status} ${r?.body?.slice(0, 100)} (want 422 ${code})`);
  }
  for (const r of run.reads) {
    say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${r.asked}] X-Helper-Commit: ${show(r.headers?.["x-helper-commit"])}`);
    const echo = r.headers?.["access-control-allow-origin"];
    say(r.origin ? echo === APP : echo === undefined, `[${r.asked}] Access-Control-Allow-Origin: ${show(echo)}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ---- The planted transactions ----

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(b) {
  let n = BigInt(`0x0${Buffer.from(b).toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = ALPHA[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = `1${s}`;
  }
  return s;
}
export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHA.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const lead = s.match(/^1*/)[0].length;
  const out = Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
  if (out.length !== 32) throw new Error("not a 32-byte key");
  return out;
}
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const compact = (n) => (n < 0x80 ? [n] : n < 0x4000 ? [(n & 0x7f) | 0x80, n >> 7] : [(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, n >> 14]);
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/**
 * A v0 transaction the fee payer pays and W signs: one tag 2 (or tag 3) release into `program` at `relayFee`, after a
 * compute unit limit, before nothing; its accounts the pool, W, the fee payer and throwaway keys (it is refused before
 * the program ever reads them). Slot 0 empty. `kind` plants one fault: "changed" (a relay fee byte changed after W
 * signed), "extra_instruction" (a transfer out of the fee payer after the release), "fee_payer_named" (tag 3, its inner
 * instruction names account 2), "fee_payer_account" (the fee payer as the spent mark too), "fee_below_cost" (1,400,000 CU priced over the fee), "inner_program" (tag 3, its inner
 * instruction invokes a throwaway program), "deadline_near" (a deadline 1 s away); "ok" plants none.
 */
export function plant({ program, pool, feePayer, relayFee, kind = "ok", nowMs = Date.now(), w = generateKeyPairSync("ed25519").privateKey }) {
  const wPub = createPublicKey(w).export({ format: "der", type: "spki" }).subarray(-32);
  const other = () => createPublicKey(generateKeyPairSync("ed25519").privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const [mark, page, tip, root, label, foreign] = [other(), other(), other(), other(), other(), other()];
  const system = Buffer.alloc(32);
  // static keys: writable signers (0 fee payer, 1 W); writable (2 pool, 3 mark, 4 page, 5 tip); readonly (6 root,
  // 7 label, 8 system, 9 program, 10 compute budget, 11 a throwaway program)
  const keys = [b58decode(feePayer), wPub, b58decode(pool), mark, page, tip, root, label, system, b58decode(program), b58decode(COMPUTE_BUDGET), foreign];
  const tag3 = kind === "fee_payer_named" || kind === "inner_program";
  const deadline = BigInt(nowMs) + (kind === "deadline_near" ? 1_000n : 270_000n);
  const fields = Buffer.concat([
    Buffer.alloc(31), Buffer.from([1]), // newCommitmentHash
    Buffer.alloc(31), Buffer.from([2]), // existingNullifierHash
    u64(50_000_000n),
    Buffer.from([5, 0, 0, 0, 3, 5, 0, 0, 0, 3]),
    u64(relayFee), u64(relayFee), u64(10_000n), u64(deadline),
    Buffer.alloc(16, 9),
  ]);
  // the pool instruction's accounts: pool, W, fee payer, mark, state root page, label root page, state page, system;
  // tag 3 adds the tip account (8) and the inner instruction's program (9: system, or the throwaway one)
  const accounts = [2, 1, 0, kind === "fee_payer_account" ? 0 : 3, 6, 7, 4, 8, ...(tag3 ? [5, kind === "inner_program" ? 11 : 8] : [])];
  const transfer = Buffer.concat([u32(2), u64(1_000n)]);
  const innerAccounts = kind === "fee_payer_named" ? [2, 8] : [1, 8];
  const data = tag3
    ? Buffer.concat([Buffer.from([3, 0]), Buffer.alloc(256, 7), fields, u64(0n), Buffer.from([1, 9, innerAccounts.length, ...innerAccounts, transfer.length, 0]), transfer])
    : Buffer.concat([Buffer.from([2]), Buffer.alloc(256, 7), fields]);
  const ix = (programIndex, accs, d) => Buffer.from([programIndex, ...compact(accs.length), ...accs, ...compact(d.length), ...d]);
  const ixs = [
    ix(10, [], Buffer.concat([Buffer.from([2]), u32(kind === "fee_below_cost" ? 1_400_000 : 400_000)])),
    ...(kind === "fee_below_cost" ? [ix(10, [], Buffer.concat([Buffer.from([3]), u64(((relayFee * 2n) * 1_000_000n) / 1_400_000n)]))] : []),
    ix(9, accounts, data),
    ...(kind === "extra_instruction" ? [ix(8, [0, 3], transfer)] : []),
  ];
  const message = Buffer.concat([
    Buffer.from([0x80, 2, 0, 6, keys.length]),
    ...keys,
    Buffer.alloc(32, 1), // blockhash
    Buffer.from(compact(ixs.length)),
    ...ixs,
    Buffer.from([0]), // no lookup table
  ]);
  const sig = sign(null, message, w);
  const wire = Buffer.concat([Buffer.from([2]), Buffer.alloc(64), sig, message]);
  if (kind === "changed") wire[wire.length - 1 - 16 - 8 * 4] ^= 1; // the relay fee's low byte, after W signed
  return wire;
}

// ---- The reads ----

export async function read(base, pool, fetchFn = fetch) {
  const reads = [];
  const get = async (asked, origin, url, init = {}) => {
    const r = await fetchFn(url, { ...init, redirect: "error", headers: { ...(origin ? { origin: APP } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
    const body = await r.text();
    reads.push({ asked, origin, readAt: new Date().toISOString(), status: r.status, headers: Object.fromEntries(r.headers), body });
    return json(body);
  };
  const feeUrl = `${base}/v1/pool/fee?pool=${encodeURIComponent(pool)}`;
  const f = await get("fee", true, feeUrl);
  await get("fee", false, feeUrl);
  if (typeof f?.fee === "string" && DEC.test(f.fee) && B58.test(f.program ?? "") && B58.test(f.fee_payer ?? "")) {
    const cfg = { program: f.program, pool, feePayer: f.fee_payer };
    const post = (asked, wire) =>
      get(asked, true, `${base}/v1/pool/solana/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool, tx: wire.toString("base64") }) });
    for (const [asked] of PLANTS) await post(asked, asked === "fee_off" ? plant({ ...cfg, relayFee: BigInt(f.fee) + STEP }) : plant({ ...cfg, relayFee: BigInt(f.fee), kind: asked }));
  }
  return { pool, reads };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i < 0 ? undefined : args[i + 1];
  };
  const pool = opt("--pool");
  if (!pool || !B58.test(pool)) {
    console.error("helper-pool-senders: --pool <the pool account> is required");
    process.exit(2);
  }
  try {
    const run = await read(opt("--base") ?? BASE, pool);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS helper-pool-senders" : "FAIL helper-pool-senders");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`helper-pool-senders: ${e.message}`);
    process.exit(2);
  }
}
