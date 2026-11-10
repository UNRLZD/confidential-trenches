#!/usr/bin/env node
// Live check of card helper-pool-senders: HELPER_HOST publishes its Solana pool fee and refuses a planted bad pool
// transaction without sending anything (apps/helper/src/pool/). It reads GET /v1/pool/fee for the pool twice, once
// with Origin APP_HOST and once with none (two callers), then POSTs /v1/pool/solana/send two transactions it builds for
// that pool and fee payer with a throwaway W key made here, each W-signed and good but for one field:
//   - "changed": a tag 2 release at the published fee, then one byte of the relay fee changed after W signed;
//   - "fee_off": the release at the published fee plus one step;
//   - "extra_instruction": the release, then an instruction of a throwaway program (a helper takes after a tag 2 only one
//     System Transfer from W, card signpage-pool-withdraw-form; a transfer out of the fee payer is fee_payer_named);
//   - "fee_payer_named": a tag 3 whose inner instruction names the fee payer (the pool instruction's account 2);
//   - "fee_payer_account": the release naming the fee payer as another pool account (its spent mark) too;
//   - "fee_below_cost": the release with a priority fee of exactly one lamport over the kit's budget for the fee
//     (solanaPoolPriorityBudget at the rent read below: 1,000,000 CU at budget + 1 micro-lamports a CU);
//   - "no_cu_limit": the release with a compute unit price and no compute unit limit;
//   - "inner_program": a tag 3 whose inner instruction invokes a program off the kit's list;
//   - "deadline_near": the release with a deadline one second away (under now plus 90 s);
//   - "tip_low", on a mainnet pool only: a tag 3 tipping one lamport under Jito's minimum (the kit's SOLANA_JITO_TIP_MIN).
// Every tag 3 plant tips the minimum to a Jito tip account named statically, as a mainnet helper asks (M369 (M2)), so
// each gets its own code from a mainnet helper as from a devnet one. A devnet helper asks no tip, so tip_low is planted
// only where it is refused on the bytes.
// Each is refused before any read or send (apps/helper/src/pool/solana.ts checks them on the bytes alone), so the check
// never moves money. It also reads the Rent sysvar on two public RPCs of the fee answer's cluster (RENT_RPCS). It passes
// only when:
//   - the fee answers 200 with exactly the kit's 9 fields, the pool and program asked, a fee_payer address, a 60 s
//     epoch with its start on the grid, and for both callers exactly the kit's solanaPoolFee for the rent both RPCs read
//     (M362 (2): every device refuses any other fee, so a helper publishing another one breaks every release);
//   - every planted transaction answers 422 with its own code (plantsFor: PLANTS, and tip_low on mainnet);
//   - every answer carries a full-sha X-Helper-Commit, and APP_HOST is echoed only to the read that sent it.
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (an EVM pool: the helper has no block in the epoch or the one before).
// An EVM pool (--pool 0x + 40 lower-case hex, card helper-evm-sender-2): the same two fee reads, each through
// evm-pool-fee-epoch.mjs (the epoch before when the helper has no block yet; a chain with none for that minute either is
// INCONCLUSIVE, exit 3, and its plants are not sent) (EvmFeeAnswer's fields,
// helper-evm-sender's FIELDS), then POST /v1/pool/evm/send { pool, data, epoch } four releases of that pool, each in
// solc's one ABI encoding, at the published fee for the answer's epoch, a fee cap above it, the answer's fee_recipient, a
// fresh nullifier and junk proof words (under the BN254 field), each refused on the request's bytes before a send:
//   - "evm_bad_signature": a withdraw whose signature is a throwaway W's (W the recipient) over the Withdraw of
//     value + 1 (bad_signature: W did not sign this release);
//   - "evm_buy_bad_signature": a buy whose signature is W's Withdraw of the same proof, the method swapped
//     (bad_signature);
//   - "evm_deadline_expired": a withdraw W signed whose deadlineMs is already past, at the epoch before now's
//     (deadline_near);
//   - "evm_recipient_code": a withdraw W signed whose W is anvil's account 0 (EVM.ANVIL0), its key derived here from the
//     published test mnemonic, an EIP-7702-delegated account on each network (recipient_code: the recipient has code).
// It reads eth_getCode of anvil's account 0 at latest on the venue's two feeProviders (the kit's evmPoolVenues()); it
// passes only when both are code (else it names why), the fee answers are right for both callers (the same fee within
// one epoch), every plant answers 422 with its own code, and the headers are as for a Solana pool.
// After: helper
//   node scripts/live-checks/helper-pool-senders.mjs --pool <address> [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHmac, createPublicKey, generateKeyPairSync, pbkdf2Sync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { evmPoolVenues, SOLANA_JITO_TIP_ACCOUNTS, SOLANA_JITO_TIP_MIN, solanaPoolFee, solanaPoolPriorityBudget, solanaRentOf } from "../../packages/kit/src/index.ts";
import { evmPoolFeeAsk, noBlockYet } from "./evm-pool-fee-epoch.mjs";
import { FIELDS as EVM_FIELDS } from "./helper-evm-sender.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

// @noble from the helper's own dependencies (apps/ is outside Blindfill), for W's keys, signatures and the digests
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { secp256k1 } = req("@noble/curves/secp256k1.js");
const { keccak_256 } = req("@noble/hashes/sha3.js");

export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
const FIELDS = ["chain", "cluster", "program", "pool", "fee_payer", "epoch_ms", "epoch_start_ms", "fee", "step"];
/** Two keyless RPCs per cluster the Rent sysvar is read on (both answered 2026-11-03 02:22Z). */
export const RENT_RPCS = {
  mainnet: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
  devnet: ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"],
};
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
/** Each planted transaction and the refusal it must get. */
export const PLANTS = [
  ["changed", "bad_signature"],
  ["fee_off", "fee_off"],
  ["extra_instruction", "extra_instruction"],
  ["fee_payer_named", "fee_payer_named"],
  ["fee_payer_account", "fee_payer_named"],
  ["fee_below_cost", "fee_below_cost"],
  ["no_cu_limit", "no_cu_limit"],
  ["inner_program", "inner_program"],
  ["deadline_near", "deadline_near"],
];
/** The plants a mainnet pool gets on top (a devnet helper sends no bundle, so it asks no tip). */
export const MAINNET_PLANTS = [["tip_low", "tip_low"]];
/** Each planted transaction a pool of `cluster` must refuse, with its code. */
export const plantsFor = (cluster) => (cluster === "mainnet" ? [...PLANTS, ...MAINNET_PLANTS] : PLANTS);
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

/** The rent one recorded getAccountInfo answer holds, or null. */
function rentOf(r) {
  const v = json(r?.body ?? "")?.result?.value;
  if (r?.status !== 200 || typeof v?.owner !== "string" || !Array.isArray(v?.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return null;
  try {
    return solanaRentOf({ owner: v.owner, data: new Uint8Array(Buffer.from(v.data[0], "base64")) });
  } catch {
    return null;
  }
}

/** The kit's fee for the rent both recorded RPC reads give, or null when they are not two agreeing reads of the cluster's pair. */
export function kitFee(run, cluster) {
  const urls = RENT_RPCS[cluster];
  const reads = run.rent ?? [];
  if (!urls || reads.length !== 2 || reads[0].url !== urls[0] || reads[1].url !== urls[1]) return null;
  const [a, b] = reads.map(rentOf);
  if (!a || !b || a.lamportsPerByte !== b.lamportsPerByte || a.factor !== b.factor) return null;
  const fee = solanaPoolFee(a);
  return { rent: a, fee, budget: solanaPoolPriorityBudget(a, fee) };
}

/** The check on one recorded run: { pool, rent: [{ url, status, body }] x2, reads: [{ asked, origin, status, headers, body }] }. */
export function judge(run) {
  if (EVM_POOL.test(run.pool ?? "")) return judgeEvm(run);
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const fees = run.reads.filter((r) => r.asked === "fee");
  const cluster = json(fees[0]?.body ?? "")?.cluster;
  const kit = kitFee(run, cluster);
  say(kit !== null, `the Rent sysvar on ${show(RENT_RPCS[cluster])} (cluster ${show(cluster)}): ${kit ? `${kit.rent.lamportsPerByte} a byte, factor ${kit.rent.factor}, the kit's fee ${kit.fee}` : "not two agreeing reads"}`);
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
    say(fee !== null && b?.step === STEP.toString() && kit !== null && fee === kit.fee && b?.cluster === cluster, `${tag} fee ${show(b?.fee)} on its step ${show(b?.step)}, the kit's fee for the rent read ${kit?.fee ?? "none"}`);
    values.push(b?.fee);
  }
  say(values.length === 2 && values[0] === values[1], `the same fee for both callers: ${show(values)}`);
  for (const [asked, code] of plantsFor(cluster)) {
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
 * signed), "extra_instruction" (a throwaway program's instruction after the release), "fee_payer_named" (tag 3, its inner
 * instruction names account 2), "fee_payer_account" (the fee payer as the spent mark too), "fee_below_cost" (a priority
 * fee of `budget` + 1 lamports: 1,000,000 CU at budget + 1 micro-lamports a CU), "no_cu_limit" (a compute unit price
 * and no limit), "inner_program" (tag 3, its inner instruction invokes a throwaway program), "deadline_near" (a
 * deadline 1 s away), "tip_low" (tag 3 tipping SOLANA_JITO_TIP_MIN - 1); "ok" plants none. A tag 3 tips
 * SOLANA_JITO_TIP_MIN to the first Jito tip account, a static key (M369 (M2)).
 */
export function plant({ program, pool, feePayer, relayFee, budget = 0n, kind = "ok", nowMs = Date.now(), w = generateKeyPairSync("ed25519").privateKey, blockhash = Buffer.alloc(32, 1) }) {
  const wPub = createPublicKey(w).export({ format: "der", type: "spki" }).subarray(-32);
  const other = () => createPublicKey(generateKeyPairSync("ed25519").privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const [mark, page, root, label, foreign] = [other(), other(), other(), other(), other()];
  const tip = b58decode(SOLANA_JITO_TIP_ACCOUNTS[0]);
  const system = Buffer.alloc(32);
  // static keys: writable signers (0 fee payer, 1 W); writable (2 pool, 3 mark, 4 page, 5 a Jito tip account); readonly (6 root,
  // 7 label, 8 system, 9 program, 10 compute budget, 11 a throwaway program)
  const keys = [b58decode(feePayer), wPub, b58decode(pool), mark, page, tip, root, label, system, b58decode(program), b58decode(COMPUTE_BUDGET), foreign];
  const tag3 = kind === "fee_payer_named" || kind === "inner_program" || kind === "tip_low";
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
    ? Buffer.concat([Buffer.from([3, 0]), Buffer.alloc(256, 7), fields, u64(kind === "tip_low" ? SOLANA_JITO_TIP_MIN - 1n : SOLANA_JITO_TIP_MIN), Buffer.from([1, 9, innerAccounts.length, ...innerAccounts, transfer.length, 0]), transfer])
    : Buffer.concat([Buffer.from([2]), Buffer.alloc(256, 7), fields]);
  const ix = (programIndex, accs, d) => Buffer.from([programIndex, ...compact(accs.length), ...accs, ...compact(d.length), ...d]);
  if (kind === "fee_below_cost" && budget <= 0n) throw new Error("fee_below_cost needs the budget");
  const ixs = [
    ...(kind === "no_cu_limit" ? [] : [ix(10, [], Buffer.concat([Buffer.from([2]), u32(kind === "fee_below_cost" ? 1_000_000 : 400_000)]))]),
    ...(kind === "fee_below_cost" ? [ix(10, [], Buffer.concat([Buffer.from([3]), u64(budget + 1n)]))] : []), // priority = price x 1,000,000 / 10^6
    ...(kind === "no_cu_limit" ? [ix(10, [], Buffer.concat([Buffer.from([3]), u64(1_000n)]))] : []),
    ix(9, accounts, data),
    ...(kind === "extra_instruction" ? [ix(11, [1, 3], transfer)] : []),
  ];
  const message = Buffer.concat([
    Buffer.from([0x80, 2, 0, 6, keys.length]),
    ...keys,
    Buffer.from(blockhash), // blockhash: none the cluster has unless the caller gives a recent one (relayer-cost-guards)
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
  if (EVM_POOL.test(pool)) return readEvm(base, pool, fetchFn);
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
  // the Rent sysvar on the cluster's two RPCs, as the device reads it, for the kit's fee and priority budget
  const rent = [];
  for (const url of RENT_RPCS[f?.cluster] ?? []) {
    const r = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [RENT_SYSVAR, { encoding: "base64", commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(15_000),
    });
    rent.push({ url, readAt: new Date().toISOString(), status: r.status, body: (await r.text()).slice(0, 2_000) });
  }
  const kit = kitFee({ rent }, f?.cluster);
  if (kit && typeof f?.fee === "string" && DEC.test(f.fee) && B58.test(f.program ?? "") && B58.test(f.fee_payer ?? "")) {
    const cfg = { program: f.program, pool, feePayer: f.fee_payer, budget: kit.budget };
    const post = (asked, wire) =>
      get(asked, true, `${base}/v1/pool/solana/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool, tx: wire.toString("base64") }) });
    for (const [asked] of plantsFor(f.cluster)) await post(asked, asked === "fee_off" ? plant({ ...cfg, relayFee: BigInt(f.fee) + STEP }) : plant({ ...cfg, relayFee: BigInt(f.fee), kind: asked }));
  }
  return { pool, rent, reads };
}

// ---- EVM pools (card helper-evm-sender-2): POST /v1/pool/evm/send { pool, data, epoch } ----

/** An EVM pool's address as the route takes it: 0x and 40 lower-case hex. */
export const EVM_POOL = /^0x[0-9a-f]{40}$/;
/** Each EVM plant and the refusal it must get, every one a 422. */
export const EVM_PLANTS = [
  ["evm_bad_signature", "bad_signature"],
  ["evm_buy_bad_signature", "bad_signature"],
  ["evm_deadline_expired", "deadline_near"],
  ["evm_recipient_code", "recipient_code"],
];
/** The headers an EVM run keeps of each answer: the ones the judge reads. */
const EVM_HEADERS = ["x-helper-commit", "access-control-allow-origin"];
const EVM_STEP = "10000000000000";
const EPOCH_MS = 60_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const WEI = /^[1-9][0-9]{0,77}$/;
const FIELD_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n; // BN254's scalar field
const ORDER_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1's group order
/** anvil's (and Hardhat's) account 0: m/44'/60'/0'/0/0 of the published test mnemonic. Each network has delegated it
 *  with EIP-7702 (eth_getCode 0xef0100..., read on both fee providers of base, robinhood, base-sepolia and
 *  robinhood-testnet on 2026-11-07), so it is a W that signs and still has code. */
const ANVIL0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
/** The pools' EIP-712 types (contracts/pool-evm/src/PrivacyPool.sol, PrivacyPoolSimple.sol; the test holds them equal). */
const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const WITHDRAW_TYPE = "Withdraw(uint256 nullifier,uint256 context,uint256 value)";
const BUY_TYPE = "Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)";

const hexOf = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const w32 = (n) => {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 256n) throw new Error(`${v} is no uint256`);
  return v.toString(16).padStart(64, "0");
};
const a32 = (a) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${a} is no address`);
  return a.slice(2).toLowerCase().padStart(64, "0");
};
const kText = (t) => hexOf(keccak_256(new TextEncoder().encode(t)));
const kHex = (h) => hexOf(keccak_256(unhex(h)));
const padRight = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, "0");
/** A bytes value's tail: its length, then its bytes padded to a word. */
const bytesTail = (h) => {
  const x = h.replace(/^0x/, "");
  if (x.length % 2 || /[^0-9a-f]/i.test(x)) throw new Error("not hex bytes");
  return w32(x.length / 2) + padRight(x.toLowerCase());
};
/** solc's head and tail encoding of a tuple: a static part inline, a dynamic one as its offset from the tuple's start. */
function tuple(parts) {
  const headLen = parts.reduce((s, p) => s + (p.dyn ? 32 : p.hex.length / 2), 0);
  let head = "";
  let tail = "";
  for (const p of parts) {
    if (p.dyn) {
      head += w32(headLen + tail.length / 2);
      tail += p.hex;
    } else head += p.hex;
  }
  return head + tail;
}
const selector = (sig) => kText(sig).slice(0, 8);
const WITHDRAW_SELECTOR = selector("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)");
const BUY_SELECTOR = selector("buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)");

/** abi.encode(RelayData): recipient, feeRecipient, feeCap, uint64 deadlineMs, refundPrecommitment, bytes16 salt (192 bytes). */
function relayData({ recipient, feeRecipient, feeCap, deadlineMs, refundPrecommitment, salt }) {
  if (BigInt(deadlineMs) >= 1n << 64n) throw new Error("deadlineMs is no uint64");
  if (!/^0x[0-9a-fA-F]{32}$/.test(salt)) throw new Error("salt is no bytes16");
  return `0x${a32(recipient)}${a32(feeRecipient)}${w32(feeCap)}${w32(deadlineMs)}${w32(refundPrecommitment)}${padRight(salt.slice(2).toLowerCase())}`;
}
/** WithdrawProof's 16 words in order: pA, pB (row by row), pC, pubSignals. */
function proofWords(p) {
  const words = [...p.pA, ...p.pB.flat(), ...p.pC, ...p.pubSignals];
  if (p.pA.length !== 2 || p.pB.length !== 2 || p.pB.some((r) => r.length !== 2) || p.pC.length !== 2 || p.pubSignals.length !== 8) throw new Error("not a withdraw proof's shape");
  return words.map(w32).join("");
}
const sig65 = (h) => {
  if (!/^0x[0-9a-f]{130}$/.test(h)) throw new Error("a signature is exactly 65 bytes");
  return h;
};
const withdrawalPart = (processooor, data) => ({ dyn: true, hex: tuple([{ hex: a32(processooor) }, { dyn: true, hex: bytesTail(data) }]) });
/** PrivacyPool.withdraw(Withdrawal, WithdrawProof, fee, signature) calldata. */
function withdrawCalldata({ processooor, data, proof, fee, signature }) {
  return `0x${WITHDRAW_SELECTOR}${tuple([withdrawalPart(processooor, data), { hex: proofWords(proof) }, { hex: w32(fee) }, { dyn: true, hex: bytesTail(sig65(signature)) }])}`;
}
/** PrivacyPoolSimple.buy(Withdrawal, WithdrawProof, fee, Buy, signature) calldata. */
function buyCalldata({ processooor, data, proof, fee, buy, signature }) {
  const b = { dyn: true, hex: tuple([{ hex: a32(buy.adapter) }, { dyn: true, hex: bytesTail(buy.data) }, { hex: w32(buy.minOut) }, { hex: a32(buy.token) }]) };
  return `0x${BUY_SELECTOR}${tuple([withdrawalPart(processooor, data), { hex: proofWords(proof) }, { hex: w32(fee) }, b, { dyn: true, hex: bytesTail(sig65(signature)) }])}`;
}
/** The pool's EIP-712 digest of a struct hash: domain { "Blindfill", "1", chainId, the pool }. */
const typedDigest = (chainId, pool, struct) => `0x${kHex(`1901${kHex(`${kText(DOMAIN_TYPE)}${kText("Blindfill")}${kText("1")}${w32(chainId)}${a32(pool)}`)}${struct}`)}`;
/** The Withdraw W signs: nullifier pubSignals[1], value pubSignals[2], context pubSignals[7] (ProofLib.sol). */
const withdrawDigest = ({ chainId, pool, nullifier, context, value }) => typedDigest(chainId, pool, kHex(`${kText(WITHDRAW_TYPE)}${w32(nullifier)}${w32(context)}${w32(value)}`));
/** The Buy W signs, its data hashed with keccak. */
const buyDigest = ({ chainId, pool, buy, nullifier, context, value }) =>
  typedDigest(chainId, pool, kHex(`${kText(BUY_TYPE)}${a32(buy.adapter)}${kHex(buy.data)}${w32(buy.minOut)}${a32(buy.token)}${w32(nullifier)}${w32(context)}${w32(value)}`));
/** r ‖ s ‖ v over a digest, s low, v 27 or 28, as PrivacyPool._signer reads it. */
function sign65(key, digest) {
  const rec = secp256k1.sign(unhex(digest), key, { prehash: false, lowS: true, format: "recovered" });
  return `0x${hexOf(rec.subarray(1, 65))}${(27 + rec[0]).toString(16)}`;
}
const addressOf = (key) => `0x${hexOf(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12))}`;
/** The address that signed `digest` (ecrecover), for the test. */
function recover(digest, sig) {
  const b = unhex(sig);
  const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(Uint8Array.from([b[64] - 27, ...b.subarray(0, 64)]), unhex(digest), { prehash: false })).toBytes(false);
  return `0x${hexOf(keccak_256(pub.subarray(1)).subarray(12))}`;
}
/** BIP-39's seed and BIP-32's m/44'/60'/0'/0/0 of the published test mnemonic, with node:crypto and @noble's
 *  secp256k1 (the test holds the address to cast's): anvil's account 0's key, made at run time and never written. */
function anvilKey() {
  const seed = pbkdf2Sync(Buffer.from(TEST_MNEMONIC.normalize("NFKD")), Buffer.from("mnemonic"), 2048, 64, "sha512");
  let I = createHmac("sha512", "Bitcoin seed").update(seed).digest();
  let k = BigInt(`0x${hexOf(I.subarray(0, 32))}`);
  let c = I.subarray(32);
  for (const [i, hard] of [[44, true], [60, true], [0, true], [0, false], [0, false]]) {
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(hard ? i + 0x80000000 : i);
    const kb = unhex(w32(k));
    const data = hard ? Buffer.concat([Buffer.of(0), kb, idx]) : Buffer.concat([secp256k1.getPublicKey(kb, true), idx]);
    I = createHmac("sha512", c).update(data).digest();
    const t = BigInt(`0x${hexOf(I.subarray(0, 32))}`);
    k = (t + k) % ORDER_N;
    if (t >= ORDER_N || k === 0n) throw new Error("bad child key");
    c = I.subarray(32);
  }
  return unhex(w32(k));
}
/** A throwaway secp256k1 key, made here and never written anywhere. */
const randomKey = () => secp256k1.utils.randomSecretKey();
/** A junk proof word, under the BN254 field and never 0. */
const randomField = () => (BigInt(`0x${randomBytes(32).toString("hex")}`) % (FIELD_P - 1n)) + 1n;
const epochStartOf = (ms) => ms - (ms % EPOCH_MS);

/**
 * The four EVM plants for `pool` on the venue `chainId`, as POST /v1/pool/evm/send bodies { pool, data, epoch }: each a
 * release at the published `fee` (a cap of twice it), paying `feeRecipient`, its own nullifier, context and junk proof
 * words, a deadline 300 s out at the answer's `epoch`, except where the plant says otherwise. W is a throwaway key, and
 * anvil's account 0 for evm_recipient_code. `adapter` is the buy's adapter (the venue's v4 adapter where the kit pins one).
 */
function evmPlants({ pool, chainId, feeRecipient, fee, epoch, adapter = "0x00000000000000000000000000000000000000ad", nowMs = Date.now(), wKey = randomKey(), anvil = anvilKey() }) {
  if (!EVM_POOL.test(pool) || !ADDRESS.test(feeRecipient)) throw new Error("the pool or the fee recipient is no lower-case address");
  const release = ({ key, deadlineMs = BigInt(nowMs) + 300_000n, at = epoch, kind = "withdraw" }) => {
    const nullifier = randomField();
    const context = randomField();
    const value = 10n ** 16n;
    const proof = { pA: [randomField(), randomField()], pB: [[randomField(), randomField()], [randomField(), randomField()]], pC: [randomField(), randomField()], pubSignals: [randomField(), nullifier, value, randomField(), 20n, randomField(), 20n, context] };
    const data = relayData({ recipient: addressOf(key), feeRecipient, feeCap: 2n * fee, deadlineMs, refundPrecommitment: randomField(), salt: `0x${randomBytes(16).toString("hex")}` });
    const d = { chainId, pool, nullifier, context, value };
    const base = { processooor: pool, data, proof, fee };
    let calldata;
    if (kind === "other_value") calldata = withdrawCalldata({ ...base, signature: sign65(key, withdrawDigest({ ...d, value: value + 1n })) });
    else if (kind === "buy_as_withdraw") calldata = buyCalldata({ ...base, buy: { adapter, data: "0x1234", minOut: 1_000n, token: "0x0000000000000000000000000000000000007070" }, signature: sign65(key, withdrawDigest(d)) });
    else calldata = withdrawCalldata({ ...base, signature: sign65(key, withdrawDigest(d)) });
    return { pool, data: calldata, epoch: at };
  };
  // a deadline already past: inside the epoch before now's, which is within the proof's life of both
  const before = epochStartOf(nowMs) - EPOCH_MS;
  return {
    evm_bad_signature: release({ key: wKey, kind: "other_value" }),
    evm_buy_bad_signature: release({ key: wKey, kind: "buy_as_withdraw" }),
    evm_deadline_expired: release({ key: wKey, deadlineMs: BigInt(before + 59_000), at: before }),
    evm_recipient_code: release({ key: anvil }),
  };
}

/** The pool's code reads of one recorded run, judged: null when both are code, else why not. */
function codeProblem(code, urls) {
  if (!Array.isArray(code) || code.length !== 2 || urls.length !== 2 || code[0]?.url !== urls[0] || code[1]?.url !== urls[1]) return `not the two reads of ${show(urls)} (read ${show((code ?? []).map((x) => x?.url))})`;
  const results = code.map((x) => {
    const r = json(x.body ?? "")?.result;
    return x.status === 200 && typeof r === "string" && /^0x([0-9a-f]{2})*$/i.test(r) ? r.toLowerCase() : null;
  });
  if (results.some((r) => r === null)) return `a read with no code answer: ${show(code.map((x) => `${x.status} ${String(x.body).slice(0, 80)}`))}`;
  if (results.some((r) => r === "0x")) return `no code on ${show(urls.filter((_, i) => results[i] === "0x"))}, so evm_recipient_code's recipient has none to be refused for`;
  return null;
}

/** The check on one recorded EVM run: { pool, code: [{ url, status, body }] x2, reads: [{ asked, origin, status, headers, body }] }. */
export function judgeEvm(run, { venues = evmPoolVenues() } = {}) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const fees = run.reads.filter((r) => r.asked === "fee");
  // the first fee read decides the network, the code reads and the plants; with no block in the epoch or the one before
  // there is nothing of them to judge
  const noFee = noBlockYet(fees[0]);
  const network = json(fees[0]?.body ?? "")?.network;
  const v = typeof network === "string" && Object.hasOwn(venues, network) ? venues[network] : undefined;
  if (!noFee) say(v !== undefined && Number.isSafeInteger(v.chainId) && v.feeProviders?.length === 2, `the kit's venue for network ${show(network)}: chain id ${show(v?.chainId)}, fee providers ${show(v?.feeProviders)}`);
  say(fees.length === 2, `two fee reads (${fees.length})`);
  const answers = [];
  for (const r of fees) {
    const tag = `[fee ${r.origin ? "APP_HOST" : "no origin"}]`;
    if (noBlockYet(r)) {
      // the chain made no block for over a minute: no fee answer to read
      quiet = true;
      lines.push(`QUIET ${tag} the helper has no block in the epoch or the one before (GET /v1/pool/fee answers ${r.status} index_behind)`);
      answers.push(null);
      continue;
    }
    say(r.status === 200, `${tag} GET /v1/pool/fee answers ${r.status}`);
    const b = json(r.body);
    const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
    say(keys.length === EVM_FIELDS.length && EVM_FIELDS.every((k) => keys.includes(k)), `${tag} fields: ${show(keys)}`);
    say(b?.chain === "evm" && b?.network === network && b?.pool === run.pool, `${tag} chain ${show(b?.chain)}, network ${show(b?.network)}, pool ${show(b?.pool)} (asked ${run.pool})`);
    say(typeof b?.fee_recipient === "string" && ADDRESS.test(b.fee_recipient), `${tag} fee recipient ${show(b?.fee_recipient)}`);
    say(b?.epoch_ms === EPOCH_MS && Number.isSafeInteger(b?.epoch_start_ms) && b.epoch_start_ms > 0 && b.epoch_start_ms % EPOCH_MS === 0, `${tag} epoch ${show(b?.epoch_ms)} ms from ${show(b?.epoch_start_ms)}`);
    const fee = typeof b?.fee === "string" && WEI.test(b.fee) ? BigInt(b.fee) : null;
    say(typeof b?.block === "string" && QUANTITY.test(b.block) && fee !== null && b?.step === EVM_STEP && fee % BigInt(EVM_STEP) === 0n, `${tag} block ${show(b?.block)}, fee ${show(b?.fee)} wei on its step ${show(b?.step)}`);
    answers.push(b);
  }
  const [a, b] = answers;
  if (answers.every((x) => x !== null)) say(answers.length === 2 && a?.fee_recipient === b?.fee_recipient && (a?.epoch_start_ms !== b?.epoch_start_ms || a?.fee === b?.fee), `the same fee recipient for both callers, and the same fee within one epoch: ${show(answers.map((x) => [x?.epoch_start_ms, x?.fee, x?.fee_recipient]))}`);
  if (!noFee) {
    const why = codeProblem(run.code, v?.feeProviders ?? []);
    say(why === null, `eth_getCode of anvil's account 0 (${ANVIL0}) at latest on ${show(v?.feeProviders)}: ${why ?? show((run.code ?? []).map((x) => json(x.body)?.result?.slice(0, 50)))}`);
    for (const [asked, code] of EVM_PLANTS) {
      const r = run.reads.find((x) => x.asked === asked);
      say(r?.status === 422 && json(r.body)?.error?.code === code, `planted ${asked}: POST /v1/pool/evm/send answers ${r?.status} ${r?.body?.slice(0, 100)} (want 422 ${code})`);
    }
  }
  // a first fee answer that was stepped back from (fee_first) is no answer the helper was judged on
  for (const r of run.reads.filter((x) => x.asked !== "fee_first")) {
    say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${r.asked}] X-Helper-Commit: ${show(r.headers?.["x-helper-commit"])}`);
    const echo = r.headers?.["access-control-allow-origin"];
    say(r.origin ? echo === APP : echo === undefined, `[${r.asked}] Access-Control-Allow-Origin: ${show(echo)}`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** An EVM pool's run: the two fee reads, the two code reads of anvil's account 0, then the four plants. */
export async function readEvm(base, pool, fetchFn = fetch, { venues = evmPoolVenues(), nowMs = () => Date.now() } = {}) {
  const reads = [];
  const get = async (asked, origin, url, init = {}) => {
    const r = await fetchFn(url, { ...init, redirect: "error", headers: { ...(origin ? { origin: APP } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
    const body = await r.text();
    // only what the judge reads: the two headers, and the body (an error or the fee answer, short)
    const read = { asked, origin, readAt: new Date().toISOString(), status: r.status, headers: Object.fromEntries(EVM_HEADERS.filter((h) => r.headers.has(h)).map((h) => [h, r.headers.get(h)])), body: body.slice(0, 1_000) };
    reads.push(read);
    return read;
  };
  // each caller's fee for the epoch and, when the helper has no block in it yet, the one before (evm-pool-fee-epoch.mjs);
  // the first answer of a stepped-back read is kept as "fee_first"
  const feeFor = async (origin) => {
    const { answer, first } = await evmPoolFeeAsk((url) => get("fee", origin, url), base, pool);
    if (first) first.asked = "fee_first";
    return answer;
  };
  const f = json((await feeFor(true)).body);
  await feeFor(false);
  const v = typeof f?.network === "string" && Object.hasOwn(venues, f.network) ? venues[f.network] : undefined;
  const code = [];
  for (const url of v?.feeProviders ?? []) {
    const r = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [ANVIL0, "latest"] }),
      signal: AbortSignal.timeout(15_000),
    });
    code.push({ url, readAt: new Date().toISOString(), status: r.status, body: (await r.text()).slice(0, 200) });
  }
  if (v && typeof f?.fee === "string" && WEI.test(f.fee) && Number.isSafeInteger(f.epoch_start_ms) && f.epoch_start_ms % EPOCH_MS === 0 && typeof f.fee_recipient === "string" && ADDRESS.test(f.fee_recipient)) {
    const plants = evmPlants({ pool, chainId: v.chainId, feeRecipient: f.fee_recipient, fee: BigInt(f.fee), epoch: f.epoch_start_ms, adapter: v.adapters?.v4, nowMs: nowMs() });
    for (const [asked] of EVM_PLANTS) await get(asked, true, `${base}/v1/pool/evm/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plants[asked]) });
  }
  return { pool, code, reads };
}

/** The EVM parts the test reads. */
export const EVM = { ANVIL0, WITHDRAW_TYPE, BUY_TYPE, anvilKey, addressOf, relayData, withdrawDigest, buyDigest, sign65, recover, withdrawCalldata, buyCalldata, plants: evmPlants, epochStartOf };

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i < 0 ? undefined : args[i + 1];
  };
  const pool = opt("--pool");
  if (!pool || !(B58.test(pool) || EVM_POOL.test(pool))) {
    console.error("helper-pool-senders: --pool <the pool account, or an EVM pool's address in lower case> is required");
    process.exit(2);
  }
  try {
    const run = await read(opt("--base") ?? BASE, pool);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    const verdict = r.verdict ?? (r.ok ? "PASS" : "FAIL");
    console.log(`${verdict} helper-pool-senders`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`helper-pool-senders: ${e.message}`);
    process.exit(2);
  }
}
