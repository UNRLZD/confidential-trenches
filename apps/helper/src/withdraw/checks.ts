// POST /v1/withdraw's checks 1-4 (markets paper H3.4, M:1079-1110; the Privacy Pools relayer baseline, F26), run in
// that order before anything is spent: no Transfer, no send and no gas happens unless every check here passed.
//
// 1. The body's shape: exact keys and sizes, every number one canonical decimal below its field, ids as NEAR reads them.
// 2. `context` recomputed from the withdrawal with the kit's own builder (vaultContextInput + vaultContextOf, the code
//    the device proves with and VT-U02's vectors hold the vault's context.rs to), the vault as processor and the
//    vault's scope; it must equal the proof's last public signal, else `bad_proof`.
// 3. `fee_recipient` is the release's, else `bad_fee_recipient`; `relay_fee >= fee_min`, else `fee_too_low`; the vault's
//    5,000 bps backstop (the kit's vaultRelayFeeWithinBackstop), else `fee_above_cap`.
// 4. The proof verifies off chain against the pinned withdraw.vkey (V:522), the same equation as the vault's
//    verifier.rs: e(-A, B) e(alpha, beta) e(vk_x, gamma) e(C, delta) = 1. A point off the curve or outside its
//    subgroup is refused, as the vault's host functions refuse it. A Groth16 proof can be re-randomised ((-A, -B, C)
//    verifies too), so nothing here or after keys on the proof's bytes: the verdict carries the nullifier's value.
//
// Not here: checks 5-10 (the index, the in-flight set and funding rows, register_deposit, recipient, deadline, the
// token's halt), H3.7 and the send. fee_min and the scope come from the caller, so this file holds no key, no store
// and no network.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bn254 } from "@noble/curves/bn254.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  VAULT_FIELD_P,
  VAULT_FIELD_Q,
  vaultContextInput,
  vaultContextOf,
  vaultRelayFeeWithinBackstop,
  type HelperWithdrawCode,
  type VaultWithdrawal,
} from "@blindfill/kit";

// ---- Values ----

/** The codes checks 1-4 answer, in H3.4's order (each is in the kit's HELPER_WITHDRAW_CODES). */
export const WITHDRAW_CHECK_CODES = ["bad_shape", "bad_proof", "bad_fee_recipient", "fee_too_low", "fee_above_cap"] as const satisfies readonly HelperWithdrawCode[];
export type WithdrawCheckCode = (typeof WITHDRAW_CHECK_CODES)[number];

/** sha256 of the ceremony's withdraw.vkey (the kit's ZK_SETUP_FILES pin; V:522). The file beside this one must hash to it. */
export const WITHDRAW_VKEY_SHA256 = "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e"; // gitleaks:allow (a public file hash)
/** The vault's MAX_TREE_DEPTH (rows 4 and 7). */
export const MAX_TREE_DEPTH = 32n;

const KEYS = ["withdrawal", "proof", "public_signals", "fund_recipient", "token"] as const;
const OPTIONAL: ReadonlySet<string> = new Set(["fund_recipient"]);
const WITHDRAWAL_KEYS = ["recipient", "register_deposit", "fee_recipient", "relay_fee", "refund_precommitment", "deadline_ms", "salt"] as const;
const PROOF_KEYS = ["a", "b", "c"] as const;
const U128 = 1n << 128n;

// ---- Inputs ----

export type WithdrawConfig = {
  /** The release's vault account: the context's processor. */
  vault: string;
  /** The vault's token (V5): the one token this relayer carries. */
  token: string;
  /** The vault's scope, read from its config() view on two NEAR RPCs that agree (it has no setter, so it never changes). */
  scope: bigint;
  /** The release's fee recipient (ours, H3.5): the only one this relayer carries. */
  feeRecipient: string;
};

export type WithdrawReads = {
  /** H3.3's fee_min for this request, in the token's base units, priced from the relayer's own reads. */
  feeMin(w: CheckedWithdraw): Promise<bigint>;
};

/** A request that passed checks 1-4: every number as its value, so later checks key on values, never on strings. */
export type CheckedWithdraw = {
  withdrawal: VaultWithdrawal;
  recipient: string;
  register_deposit: bigint;
  fee_recipient: string;
  relay_fee: bigint;
  refund_precommitment: bigint;
  deadline_ms: number;
  newCommitmentHash: bigint;
  existingNullifierHash: bigint;
  withdrawnValue: bigint;
  stateRoot: bigint;
  stateTreeDepth: bigint;
  ASPRoot: bigint;
  ASPTreeDepth: bigint;
  context: bigint;
  /** Absent, true or false: H3.7 item 1 answers fund_recipient_wrong after these checks. */
  fund_recipient: boolean | undefined;
  /** The request's proof and signals as received, carried to the vault unchanged. */
  proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };
  public_signals: [string, string, string, string, string, string, string, string];
};

export type WithdrawVerdict = { ok: true; withdraw: CheckedWithdraw } | { ok: false; code: WithdrawCheckCode; why: string };

// ---- The checks, in order ----

export async function checkWithdraw(request: unknown, cfg: WithdrawConfig, reads: WithdrawReads): Promise<WithdrawVerdict> {
  if (typeof cfg.scope !== "bigint" || cfg.scope < 0n || cfg.scope >= VAULT_FIELD_P) throw new Error("scope: not a field element");
  const no = (code: WithdrawCheckCode, why: string): WithdrawVerdict => ({ ok: false, code, why });

  // 1. Shape: exact keys and sizes, canonical decimals, ids as NEAR reads them.
  const shaped = shape(request, cfg);
  if (typeof shaped === "string") return no("bad_shape", shaped);
  const w = shaped;

  // 2. Context: the vault's row 3, from the withdrawal, with the vault as processor and its scope.
  // Check 1 refused every form the kit's builder refuses, so a throw here is the relayer's own fault: it propagates and
  // the caller holds the call, never answering the client bad_shape for it.
  if (withdrawContext(cfg.vault, w.withdrawal, cfg.scope) !== w.context) return no("bad_proof", "context: not the withdrawal's");

  // 3. The fee: ours, at least fee_min, within the vault's backstop.
  if (w.fee_recipient !== cfg.feeRecipient) return no("bad_fee_recipient", "fee_recipient: not this relayer's");
  const feeMin = await reads.feeMin(w);
  if (typeof feeMin !== "bigint" || feeMin < 0n) throw new Error("feeMin: not a bigint, 0 or more");
  if (w.relay_fee < feeMin) return no("fee_too_low", "relay_fee: under fee_min");
  if (!vaultRelayFeeWithinBackstop(w.relay_fee, w.withdrawnValue)) return no("fee_above_cap", "relay_fee: over the vault's 5,000 bps backstop");

  // 4. The proof, against the pinned withdraw.vkey.
  const signals = [w.newCommitmentHash, w.existingNullifierHash, w.withdrawnValue, w.stateRoot, w.stateTreeDepth, w.ASPRoot, w.ASPTreeDepth, w.context];
  if (!verifyWithdrawProof(w.proof, signals)) return no("bad_proof", "proof: does not verify");

  return { ok: true, withdraw: w };
}

// ---- Check 1 ----

function shape(r: unknown, cfg: WithdrawConfig): CheckedWithdraw | string {
  const keys = exactKeys(r, KEYS, OPTIONAL);
  if (keys) return `body: ${keys}`;
  const b = r as Record<(typeof KEYS)[number], unknown>;
  if (b.token !== cfg.token) return "token: not the vault's token";
  if (b.fund_recipient !== undefined && typeof b.fund_recipient !== "boolean") return "fund_recipient: not a boolean";

  const wk = exactKeys(b.withdrawal, WITHDRAWAL_KEYS);
  if (wk) return `withdrawal: ${wk}`;
  const wd = b.withdrawal as Record<(typeof WITHDRAWAL_KEYS)[number], unknown>;
  if (!isAccountId(wd.recipient)) return "withdrawal.recipient: not a NEAR account id";
  if (!isAccountId(wd.fee_recipient)) return "withdrawal.fee_recipient: not a NEAR account id";
  const register_deposit = decimal(wd.register_deposit, U128);
  if (register_deposit === null) return "withdrawal.register_deposit: not a u128 decimal";
  const relay_fee = decimal(wd.relay_fee, U128);
  if (relay_fee === null) return "withdrawal.relay_fee: not a u128 decimal";
  const refund_precommitment = decimal(wd.refund_precommitment, VAULT_FIELD_P);
  if (refund_precommitment === null) return "withdrawal.refund_precommitment: not a decimal below p";
  if (refund_precommitment === 0n) return "withdrawal.refund_precommitment: 0";
  if (typeof wd.deadline_ms !== "number" || !Number.isSafeInteger(wd.deadline_ms) || wd.deadline_ms < 0) return "withdrawal.deadline_ms: not a whole number, 0 or more";
  if (typeof wd.salt !== "string" || !/^[0-9a-f]{32}$/.test(wd.salt)) return "withdrawal.salt: not 32 lowercase hex characters";

  const pk = exactKeys(b.proof, PROOF_KEYS);
  if (pk) return `proof: ${pk}`;
  const p = b.proof as Record<(typeof PROOF_KEYS)[number], unknown>;
  const coords: unknown[] = [];
  if (!pair(p.a) || !pair(p.c) || !Array.isArray(p.b) || p.b.length !== 2 || !pair(p.b[0]) || !pair(p.b[1])) return "proof: not a = [x, y], b = [[x0, x1], [y0, y1]], c = [x, y]";
  coords.push(...p.a, ...p.b[0], ...p.b[1], ...p.c);
  for (const c of coords) if (decimal(c, VAULT_FIELD_Q) === null) return "proof: a coordinate not one canonical decimal below q";

  const ps = b.public_signals;
  if (!Array.isArray(ps) || ps.length !== 8) return "public_signals: not 8";
  const s: bigint[] = [];
  for (const [i, x] of ps.entries()) {
    const v = decimal(x, VAULT_FIELD_P);
    if (v === null) return `public_signals[${i}]: not one canonical decimal below p`;
    s.push(v);
  }
  const [newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context] = s as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  if (newCommitmentHash === 0n) return "newCommitmentHash: 0";
  if (withdrawnValue === 0n) return "withdrawnValue: 0";
  if (withdrawnValue >= U128) return "withdrawnValue: not a u128";
  if (stateTreeDepth > MAX_TREE_DEPTH) return "stateTreeDepth: over 32";
  if (ASPTreeDepth > MAX_TREE_DEPTH) return "ASPTreeDepth: over 32";

  const recipient = wd.recipient;
  const fee_recipient = wd.fee_recipient;
  return {
    withdrawal: {
      recipient,
      register_deposit: wd.register_deposit as string,
      fee_recipient,
      relay_fee: wd.relay_fee as string,
      refund_precommitment: wd.refund_precommitment as string,
      deadline_ms: wd.deadline_ms,
      salt: wd.salt,
    },
    recipient,
    register_deposit,
    fee_recipient,
    relay_fee,
    refund_precommitment,
    deadline_ms: wd.deadline_ms,
    newCommitmentHash,
    existingNullifierHash,
    withdrawnValue,
    stateRoot,
    stateTreeDepth,
    ASPRoot,
    ASPTreeDepth,
    context,
    fund_recipient: b.fund_recipient as boolean | undefined,
    proof: { a: [...p.a] as [string, string], b: [[...p.b[0]], [...p.b[1]]] as [[string, string], [string, string]], c: [...p.c] as [string, string] },
    public_signals: [...ps] as CheckedWithdraw["public_signals"],
  };
}

/** Null when `o` is a plain object with exactly `want`'s keys (the optional ones may be missing), else why not. */
function exactKeys(o: unknown, want: readonly string[], optional: ReadonlySet<string> = new Set()): string | null {
  if (typeof o !== "object" || o === null || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype) return "not an object";
  const have = Object.keys(o);
  for (const k of have) if (!want.includes(k)) return `${JSON.stringify(k).slice(0, 40)}: not a field`;
  for (const k of want) if (!have.includes(k) && !optional.has(k)) return `${k}: missing`;
  return null;
}

function pair(x: unknown): x is [unknown, unknown] {
  return Array.isArray(x) && x.length === 2;
}

/** One canonical decimal below `bound`: digits only, no sign, no leading zero (0 alone excepted). Else null. */
function decimal(x: unknown, bound: bigint): bigint | null {
  if (typeof x !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(x)) return null;
  const v = BigInt(x);
  return v < bound ? v : null;
}

/** The kit's account id rule (vaultAccountId): 2 to 64 characters, lowercase letters and digits, - or _ joining parts, dots between. */
export function isAccountId(s: unknown): s is string {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

/**
 * keccak256 (Keccak's padding, not SHA3's): @noble/hashes' keccak_256, the one the kit proves with. Never node:crypto's
 * "keccak-256", which some Node builds lack (24.12.0 with OpenSSL 3.5.4: "Digest method not supported"), so every
 * honest withdrawal would be refused there.
 */
export function keccak256(b: Uint8Array): Uint8Array {
  return keccak_256(b);
}

/** The vault's row 3: the kit's context of `withdrawal` with `vault` as processor, under `scope`. Throws on a bad form. */
export function withdrawContext(vault: string, withdrawal: VaultWithdrawal, scope: bigint): bigint {
  return vaultContextOf(keccak256, vaultContextInput(vault, withdrawal), scope);
}

// ---- Check 4: Groth16 on BN254, snarkjs's equation, with the ceremony's withdraw.vkey ----

type G1 = InstanceType<typeof bn254.G1.Point>;
type G2 = InstanceType<typeof bn254.G2.Point>;
const { Fp2, Fp12 } = bn254.fields;

function g1(x: unknown, y: unknown): G1 {
  const p = bn254.G1.Point.fromAffine({ x: field(x, VAULT_FIELD_Q), y: field(y, VAULT_FIELD_Q) });
  p.assertValidity();
  return p;
}

/** snarkjs's G2: [[x.c0, x.c1], [y.c0, y.c1]], c0 real, c1 imaginary (the vault's verifier.rs reads it the same way). */
function g2(x: [unknown, unknown], y: [unknown, unknown]): G2 {
  const f = (c: [unknown, unknown]) => Fp2.fromBigTuple([field(c[0], VAULT_FIELD_Q), field(c[1], VAULT_FIELD_Q)]);
  const p = bn254.G2.Point.fromAffine({ x: f(x), y: f(y) });
  p.assertValidity();
  return p;
}

function field(x: unknown, bound: bigint): bigint {
  const v = decimal(x, bound);
  if (v === null) throw new Error("not one canonical decimal below the field");
  return v;
}

type Vkey = { alpha: G1; beta: G2; gamma: G2; delta: G2; ic: G1[] };

/** Reads withdraw.vkey beside this file, refused unless it hashes to the pin and takes the circuit's 8 signals. */
export function loadWithdrawVkey(bytes: Uint8Array = readFileSync(new URL("./withdraw.vkey", import.meta.url))): Vkey {
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== WITHDRAW_VKEY_SHA256) throw new Error(`withdraw.vkey: sha256 ${got}, not the pinned ${WITHDRAW_VKEY_SHA256}`);
  const v = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const pt1 = (a: unknown): G1 => {
    const p = a as [string, string, string];
    if (p[2] !== "1") throw new Error("withdraw.vkey: a G1 point not affine");
    return g1(p[0], p[1]);
  };
  const pt2 = (a: unknown): G2 => {
    const p = a as [[string, string], [string, string], [string, string]];
    if (p[2][0] !== "1" || p[2][1] !== "0") throw new Error("withdraw.vkey: a G2 point not affine");
    return g2(p[0], p[1]);
  };
  if (v.protocol !== "groth16" || v.curve !== "bn128" || v.nPublic !== 8 || !Array.isArray(v.IC) || v.IC.length !== 9) throw new Error("withdraw.vkey: not Groth16 on bn128 with 8 public signals");
  return { alpha: pt1(v.vk_alpha_1), beta: pt2(v.vk_beta_2), gamma: pt2(v.vk_gamma_2), delta: pt2(v.vk_delta_2), ic: v.IC.map(pt1) };
}

const VKEY = loadWithdrawVkey();

/**
 * Groth16 verify of a withdraw proof against its 8 signals (snarkjs order), each below p. False for anything that
 * does not verify: a coordinate not below q, a point off the curve or outside its subgroup, a point at infinity
 * (no honest proof has one), a wrong count.
 */
export function verifyWithdrawProof(proof: { a: readonly unknown[]; b: readonly (readonly unknown[])[]; c: readonly unknown[] }, signals: readonly bigint[]): boolean {
  try {
    if (signals.length !== VKEY.ic.length - 1) return false;
    const a = g1(proof.a[0], proof.a[1]);
    const b = g2([proof.b[0]![0], proof.b[0]![1]], [proof.b[1]![0], proof.b[1]![1]]);
    const c = g1(proof.c[0], proof.c[1]);
    let vkx = VKEY.ic[0]!;
    for (const [i, s] of signals.entries()) {
      if (typeof s !== "bigint" || s < 0n || s >= VAULT_FIELD_P) return false;
      vkx = vkx.add(VKEY.ic[i + 1]!.multiplyUnsafe(s));
    }
    const product = bn254.pairingBatch([
      { g1: a.negate(), g2: b },
      { g1: VKEY.alpha, g2: VKEY.beta },
      { g1: vkx, g2: VKEY.gamma },
      { g1: c, g2: VKEY.delta },
    ]);
    return Fp12.eql(product, Fp12.ONE);
  } catch {
    return false;
  }
}
