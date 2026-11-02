// The one-use arming accounts A_{l,j}, and the read of A's registration on the token before a withdrawal to A is proved
// (card wallet-arming-accounts; docs/plan1/wallet.md §2.2 key table l.65 and the encodings l.71-89, §2.5 step 4 l.649,
// W3.5 l.1128, vector set §A.8; markets.md H3.4 check 7 l.1365-1367 and H3.7 item 1 l.1537-1545; vault.md 2.5.2
// l.372-376; at research 8e9352d).
//
// - A_{l,j} is the arming account of the withdrawal that makes change note j of label l: its ed25519 seed is
//   HKDF-SHA512(seed64, salt "blindfill/v1", info "onetime/arm" ‖ l (32 B) ‖ j (4 B), 32 B) (W:65, W:82), the kit's
//   frozen path (../derive armAccount), and the account is the NEAR-implicit id of that key: the lowercase hex of its
//   public key (W:88). It is never a named account (W:65). Only the public side leaves this file: the secret key is
//   zeroed at once, and whoever signs from A later derives its own copy.
// - register_deposit (W:649; V 2.5.2, V:372-376; markets H3.4 check 7): 0 when storage_balance_of(A) on the vault's
//   asset is set, the token's storage_balance_bounds().min when it is null. Both views are read on two RPCs of two
//   operators: exactly one FastNEAR URL and the dRPC URL of the network, as deposit/account.ts pairs them (the operator
//   map is scripts/ci/near-rpc-operators.mjs). The device decides only when both RPCs answer every read and agree on
//   whether A is registered and on the minimum; one RPC down, an error answer, a malformed answer or a disagreement
//   throws ArmingRegistrationRefused, and no register_deposit is given, so nothing is proved.
// - A value the relayer would refuse is never a loss: check 7 answers register_deposit_wrong before anything is sent,
//   and the token sends any NEAR it does not need back to the vault (V:374-376).
// Nothing here logs. No request carries a key or the words: each read names A or the token only (§2.9).
import { base58, base64 } from "@scure/base";
import { armAccount } from "../derive/index.ts";
import { heightSpreadOver, NEAR_NETWORKS, nearPairNetwork, nearPairRule, type NearNetwork, type NearRpc } from "../deposit/account.ts";

/** A's public side: its 64-hex implicit id and its one key. */
export interface ArmingAccountId {
  account: string;
  publicKey: string; // ed25519:<base58>
}

/** A_{l,j} at the kit's frozen path, public side only (W:65). */
export function armingAccount(seed64: Uint8Array, l: bigint, j: number): ArmingAccountId {
  const a = armAccount(seed64, l, j);
  a.secretKey.fill(0);
  return { account: a.id, publicKey: `ed25519:${base58.encode(a.publicKey)}` };
}

export type ArmingRefusalCode = "input" | "rpc" | "disagree";
export class ArmingRegistrationRefused extends Error {
  readonly code: ArmingRefusalCode;
  constructor(code: ArmingRefusalCode, detail: string) {
    super(`arming registration not read (${code}): ${detail}`);
    this.name = "ArmingRegistrationRefused";
    this.code = code;
  }
}

/** What the two RPCs agreed on, and the register_deposit it sets, in yoctoNEAR. */
export interface ArmingRegistration {
  account: string;
  registered: boolean;
  /** The token's storage_balance_bounds().min, equal on both RPCs. */
  min: bigint;
  /** 0 when registered, min when not. */
  registerDeposit: bigint;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
const U128_MAX = (1n << 128n) - 1n;

/**
 * Reads A's registration on the network's token through one FastNEAR RPC and the dRPC RPC of that network (each
 * NearRpc's name is its exact URL), in either order, and decides register_deposit.
 */
export async function readArmingRegistration(
  account: string, network: NearNetwork, rpcs: readonly [NearRpc, NearRpc],
): Promise<ArmingRegistration> {
  if (typeof account !== "string" || !HEX64.test(account)) throw new ArmingRegistrationRefused("input", "A must be a lowercase 64-hex implicit account id");
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new ArmingRegistrationRefused("input", `unknown network ${String(network)}`);
  const net = NEAR_NETWORKS[network];
  if (nearPairNetwork(rpcs) !== network) throw new ArmingRegistrationRefused("input", nearPairRule(network));

  const view = (method_name: string, args: Obj) => ({
    request_type: "call_function",
    account_id: net.token,
    method_name,
    args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
    finality: "final",
  });
  const reads = { balance: view("storage_balance_of", { account_id: account }), bounds: view("storage_balance_bounds", {}) };
  const kinds = Object.keys(reads) as (keyof typeof reads)[];
  const settled = await Promise.all(rpcs.map((r) => Promise.allSettled(kinds.map((k) => r.query(reads[k])))));

  // Each view's return value, parsed from its bytes; any failure on either side stops the read.
  const value = (p: number, k: keyof typeof reads): unknown => {
    const s = settled[p]![kinds.indexOf(k)]!;
    const who = rpcs[p].name;
    if (s.status === "rejected") throw new ArmingRegistrationRefused("rpc", `${who} did not answer the ${k} read`);
    const a = s.value;
    const r = isObj(a) ? a.result : undefined;
    if (!isObj(a) || a.error !== undefined || !isObj(r) || r.error !== undefined) throw new ArmingRegistrationRefused("rpc", `${who}: the ${k} read failed`);
    const bytes = r.result;
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
      throw new ArmingRegistrationRefused("rpc", `${who}: the ${k} read has no bytes`);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes)));
    } catch {
      throw new ArmingRegistrationRefused("rpc", `${who}: the ${k} read is not JSON`);
    }
  };
  const u128 = (x: unknown): bigint | undefined => (typeof x === "string" && DIGITS.test(x) && BigInt(x) <= U128_MAX ? BigInt(x) : undefined);

  // NEP-145: storage_balance_of is null, or { total, available } as U128 strings.
  const registeredOn = (p: number): boolean => {
    const v = value(p, "balance");
    if (v === null) return false;
    if (isObj(v) && u128(v.total) !== undefined && u128(v.available) !== undefined) return true;
    throw new ArmingRegistrationRefused("rpc", `${rpcs[p].name}: storage_balance_of is neither null nor a storage balance`);
  };
  // NEP-145: storage_balance_bounds is { min, max }, min a U128 string.
  const minOn = (p: number): bigint => {
    const v = value(p, "bounds");
    const min = isObj(v) ? u128(v.min) : undefined;
    if (min === undefined) throw new ArmingRegistrationRefused("rpc", `${rpcs[p].name}: storage_balance_bounds has no min`);
    return min;
  };

  const [ra, rb] = [registeredOn(0), registeredOn(1)];
  const [ma, mb] = [minOn(0), minOn(1)];
  if (ra !== rb) throw new ArmingRegistrationRefused("disagree", "the two RPCs disagree on whether A is registered");
  if (ma !== mb) throw new ArmingRegistrationRefused("disagree", "the two RPCs disagree on the token's storage minimum");
  // every answer at a final block, and the four within HEIGHT_SPREAD_MAX: a provider's stale "final" is refused
  const heights = settled.flatMap((side) => side.map((s) => (s.status === "fulfilled" && isObj(s.value) && isObj(s.value.result) ? s.value.result.block_height : undefined)));
  if (!heights.every((h) => typeof h === "number" && Number.isSafeInteger(h) && h > 0)) throw new ArmingRegistrationRefused("rpc", "a read has no block height");
  const spread = heightSpreadOver(heights as number[]);
  if (spread !== null) throw new ArmingRegistrationRefused("disagree", spread);
  return { account, registered: ra, min: ma, registerDeposit: ra ? 0n : ma };
}

/**
 * withdrawRequest's registerDepositOf (withdraw/request.ts): A's register_deposit, read as readArmingRegistration. The
 * withdrawal's token must be the network's token, the one the read is made on; any other is refused before any read.
 */
export function armingRegisterDepositOf(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc]): (account: string, token: string) => Promise<bigint> {
  return async (account, token) => {
    if (typeof network === "string" && Object.hasOwn(NEAR_NETWORKS, network) && token !== NEAR_NETWORKS[network].token)
      throw new ArmingRegistrationRefused("input", `the withdrawal's token ${String(token)} is not the ${network} token the read is made on`);
    return (await readArmingRegistration(account, network, rpcs)).registerDeposit;
  };
}
