// POST /v1/bind's checks for a deposit delegate (markets paper H4.3 checks 1-7, M:1707-1758, with M284's R1-R3,
// M:1816-1834; vault paper 2.10 (e)'s message clauses, V:693-703; the beta cap per deposit, OD:262), run in that
// order before anything is spent: no storage_prepay and no send happens unless every check here passed.
//
// What passes is one call only: a 64-hex NEAR-implicit id's own TOKEN.ft_transfer_call(vault, amount, msg) with
// msg = {"precommitment":"<decimal>","depositor":"<account>"}, 1 yocto and 180 Tgas to G_bind_cap, signed by that id as
// a NEP-366 SignedDelegateAction (the kit's VAULT_DEPOSIT_CARRIER). The deposit id U, a return id R and a refund id V
// all send this same call from their own NEAR accounts, so each runs every check with the id in U's place (M:1711-1713;
// M322 (1), MN:330). Every other kind /v1/bind will take (M:3342) is refused here, by its shape: an id's clean-up (one
// DeleteAccount) gets not_one_action, a plain move out (ft_transfer) not_ft_transfer_call, an onward delegate
// (receiver_id intents.near) bad_receiver. A's move back to the vault (WM-11) is this same call from A (M:2822, "in
// the same shape"; wallet.md WM-11, depositor = A), so no shape check can tell it from U's: decided by the CO 07:16Z, A's
// move passes as U's does.
//
// Not here (card relayer-prepay): check 8's two-RPC simulation, the prepay and the send; check 9's token hold
// (token-status/status.ts tokenHeld); R4's margin again after the prepay; R5-R7, R7's atomic create-if-absent write
// included. The reads and the ledger are passed in, so this file holds no key, no store and no network.
//
// The helper image is built from apps/helper alone (Dockerfile), so the kit's values below are written again;
// checks.test.ts compares each with the kit's public entry (packages/kit/src/index.ts).

import { createHash, createPublicKey, verify } from "node:crypto";

// ---- The kit's values (packages/kit/src/helper/v1.ts and vault/shapes.ts), compared in checks.test.ts ----

/** HELPER_V1_PATHS' POST /v1/bind limitBytes, the route's body limit; here it also caps the decoded SignedDelegateAction. */
export const BIND_MAX_BYTES = 4_096;
/** HELPER_BIND_DEPOSIT_CODES, in H4.3's order, with the cap's code after amount_too_low. */
export const BIND_DEPOSIT_CODES = [
  "bad_shape",
  "bad_signature",
  "no_account",
  "bad_key",
  "bad_nonce",
  "sender_struck",
  "expired",
  "resign_needed",
  "not_one_action",
  "not_ft_transfer_call",
  "token_not_accepted",
  "deposit_not_1_yocto",
  "gas_too_low",
  "gas_too_high",
  "bad_receiver",
  "amount_too_low",
  "amount_above_cap",
  "amount_above_balance",
  "bad_msg",
  "p_used",
  "p_bound",
  "prepay_open",
  "in_flight",
  "token_halted",
  "relayer_low",
] as const;
/** VAULT_CONSTANTS.TOKEN: the vault's one token (V5), Circle's USDC on NEAR mainnet. */
export const VAULT_TOKEN = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
/** VAULT_CONSTANTS.MIN_DEPOSIT: 1 USDC in base units. */
export const MIN_DEPOSIT = 1_000_000n;
/** HELPER_BIND_DEPOSIT_CAP: the beta cap per deposit, $1,000 in USDC base units (OD:262: in the kit and the relayer, never the vault). */
export const BIND_DEPOSIT_CAP = 1_000_000_000n;
/** VAULT_FIELD_P. */
export const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** VAULT_DEPOSIT_MESSAGE_FIELDS and VAULT_DEPOSIT_MESSAGE_MAX_BYTES. */
export const DEPOSIT_MESSAGE_FIELDS = ["precommitment", "depositor"] as const;
export const DEPOSIT_MESSAGE_MAX_BYTES = 1_024;
/** VAULT_DEPOSIT_CARRIER's method, args, deposit and gas. */
export const CARRIER = { method: "ft_transfer_call", args: ["receiver_id", "amount", "msg"], deposit_yocto: 1n, gas_tgas: 180 } as const;

// ---- The papers' values ----

/** H4.3 check 4: max_block_height at most 600 blocks ahead of the newest final height [design]. */
export const EXPIRY_MAX_BLOCKS = 600n;
/** H4.3 check 5: G_bind_cap = 2 × 101.563 Tgas, twice U's measured whole call at depth 32 (V@31d1b99:841). */
export const G_BIND_CAP = 203_126_000_000_000n;
/** NEP-366's signable prefix: 2^30 + 366, a little-endian u32 before the borsh DelegateAction it signs. */
export const NEP366_PREFIX = 2 ** 30 + 366;
/** nearcore's AccessKey::ACCESS_KEY_NONCE_RANGE_MULTIPLIER (2.14.0 core/primitives-core/src/account.rs l.812). */
export const NONCE_RANGE_MULTIPLIER = 1_000_000n;

const TGAS = 1_000_000_000_000n;

export type BindCode = (typeof BIND_DEPOSIT_CODES)[number];

// ---- Inputs ----

export type BindConfig = {
  /** The release's vault account. */
  vault: string;
  /** The vault's token (V5): VAULT_TOKEN on mainnet; a testnet vault names its testnet token. */
  token: string;
  /** R4's margin K in blocks, pinned in the release from vault SB run (6); no interim value (M:1839-1840). */
  marginK: bigint;
};

/**
 * What a read of the sender's key answered. `permission` is view_access_key's `permission` field passed through as
 * the RPC answered it, never mapped: only the exact string "FullAccess" signs a delegate. A gas key reads as
 * {GasKeyFullAccess: …} or {GasKeyFunctionCall: …} (nearcore 2.14.0 core/primitives/src/views.rs l.170-182) and nearcore
 * refuses a delegate signed by one (DelegateActionRequiresNonGasKey, runtime/runtime/src/actions.rs l.603-611).
 */
export type KeyRead = { kind: "no_account" } | { kind: "no_key" } | { kind: "key"; permission: unknown; nonce: bigint };

/**
 * The chain reads, each at final state on two NEAR providers that agree. A read that fails or disagrees throws, and
 * the caller holds the call: nothing is spent on an unknown.
 */
export type BindReads = {
  /** view_access_key(account, publicKey); publicKey is "ed25519:<base58>". */
  accessKey(account: string, publicKey: string): Promise<KeyRead>;
  /** The newest final block height (check 3's nonce bound and check 4). */
  finalHeight(): Promise<bigint>;
  /** TOKEN.ft_balance_of(account), read now. */
  ftBalance(account: string): Promise<bigint>;
  /** P is in the relayer's own index of the vault's deposits pages. */
  pUsed(precommitment: bigint): Promise<boolean>;
};

/** R1-R3's record (R7 keeps it), read by the sender id U and by P only, never by anything about the request's origin. */
export type BindLedger = {
  /** R3: U had three failed sends on one P. */
  struck(u: string): Promise<boolean>;
  /** R1: the U a prepaid P is bound to, or null. */
  boundTo(precommitment: bigint): Promise<string | null>;
  /** R2: U's prepaid P that the deposits pages do not hold yet, or null. */
  openP(u: string): Promise<bigint | null>;
  /** R7: a send of (U, P) is out. */
  inFlight(u: string, precommitment: bigint): Promise<boolean>;
};

export type BindDeposit = {
  sender_id: string;
  public_key: string;
  nonce: bigint;
  max_block_height: bigint;
  gas: bigint;
  amount: bigint;
  precommitment: bigint;
  depositor: string;
  /** The SignedDelegateAction's bytes, carried byte for byte. */
  signed_delegate: Uint8Array;
};

export type BindVerdict = { ok: true; deposit: BindDeposit } | { ok: false; code: BindCode; why: string };

// ---- The checks, in order ----

export async function checkBindDeposit(request: unknown, cfg: BindConfig, reads: BindReads, ledger: BindLedger): Promise<BindVerdict> {
  if (typeof cfg.marginK !== "bigint" || cfg.marginK < 1n || cfg.marginK > EXPIRY_MAX_BLOCKS) throw new Error("marginK: not pinned in 1..600");
  const no = (code: BindCode, why: string): BindVerdict => ({ ok: false, code, why });

  // 1. Decoding: {signed_delegate} alone, canonical base64, at most 4 KB, one borsh SignedDelegateAction and nothing after.
  if (typeof request !== "object" || request === null || Array.isArray(request)) return no("bad_shape", "body: not an object");
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== "signed_delegate") return no("bad_shape", "body: not {signed_delegate} alone");
  const b64 = (request as { signed_delegate: unknown }).signed_delegate;
  if (typeof b64 !== "string") return no("bad_shape", "signed_delegate: not a string");
  if (b64.length > Math.ceil(BIND_MAX_BYTES / 3) * 4) return no("bad_shape", "signed_delegate: over 4 KB of base64");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return no("bad_shape", "signed_delegate: not standard base64");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (Buffer.from(bytes).toString("base64") !== b64) return no("bad_shape", "signed_delegate: not canonical base64");
  if (bytes.length > BIND_MAX_BYTES) return no("bad_shape", "signed_delegate: over 4 KB");
  let d: Decoded;
  try {
    d = decodeSignedDelegate(bytes);
  } catch (e) {
    return no("bad_shape", `borsh: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Signature: ed25519 over sha256(u32le(2^30 + 366) || borsh(DelegateAction)), NEP-366's signable message.
  if (!signatureOk(d)) return no("bad_signature", "signature: does not verify over the delegate");

  // 3. Sender: a 64-hex implicit account that exists and holds public_key as a full-access key below the nonce.
  const u = d.sender_id;
  if (!/^[0-9a-f]{64}$/.test(u)) return no("no_account", "sender_id: not a 64-hex implicit account");
  const publicKey = `ed25519:${base58(d.public_key)}`;
  const key = await reads.accessKey(u, publicKey);
  if (key.kind === "no_account") return no("no_account", "sender_id: no such account");
  if (key.kind !== "key") return no("bad_key", "public_key: not on the sender");
  if (key.permission !== "FullAccess") return no("bad_key", "public_key: not a full-access key");
  if (d.nonce <= key.nonce) return no("bad_nonce", "nonce: not above the key's nonce");
  // nearcore refuses nonce >= the receipt's block height x 1,000,000 (DelegateActionNonceTooLarge, 2.14.0
  // runtime/runtime/src/actions.rs l.657-664); that height is at or above the final one, so this bound is the stricter.
  const final = await reads.finalHeight();
  if (d.nonce >= final * NONCE_RANGE_MULTIPLIER) return no("bad_nonce", "nonce: at or above the final height x 1,000,000");
  // R3, right after checks 1-3.
  if (await ledger.struck(u)) return no("sender_struck", "R3: sender struck");

  // 4. Expiry: ahead of the newest final height, at most 600 blocks ahead, and at least K ahead (R4).
  if (d.max_block_height <= final) return no("expired", "max_block_height: not ahead of the final height");
  if (d.max_block_height - final > EXPIRY_MAX_BLOCKS) return no("expired", "max_block_height: over 600 blocks ahead");
  if (d.max_block_height - final < cfg.marginK) return no("resign_needed", "R4: under the margin K");

  // 5. The inner action: one FunctionCall, ft_transfer_call on the vault's token, 1 yocto, 180 Tgas to G_bind_cap.
  if (d.actions.length !== 1) return no("not_one_action", "actions: not exactly one");
  const a = d.actions[0]!;
  if (a.kind !== "FunctionCall") return no("not_one_action", "action: not a FunctionCall");
  if (a.method_name !== CARRIER.method) return no("not_ft_transfer_call", "method_name: not ft_transfer_call");
  if (d.receiver_id !== cfg.token) return no("token_not_accepted", "receiver_id: not the vault's token");
  if (a.deposit !== CARRIER.deposit_yocto) return no("deposit_not_1_yocto", "deposit: not 1 yocto");
  if (a.gas < BigInt(CARRIER.gas_tgas) * TGAS) return no("gas_too_low", "gas: under 180 Tgas");
  if (a.gas > G_BIND_CAP) return no("gas_too_high", "gas: over G_bind_cap");

  // 6. Arguments: exactly {receiver_id, amount, msg} as the kit's carrier writes them, then each clause.
  const args = frozenArgs(a.args);
  if (args === null) return no("bad_shape", "args: not the frozen {receiver_id, amount, msg}");
  if (args.receiver_id !== cfg.vault) return no("bad_receiver", "args.receiver_id: not the vault");
  if (!/^(0|[1-9][0-9]{0,38})$/.test(args.amount) || BigInt(args.amount) >= 1n << 128n) return no("bad_shape", "args.amount: not a u128 decimal");
  const amount = BigInt(args.amount);
  if (amount < MIN_DEPOSIT) return no("amount_too_low", "amount: under MIN_DEPOSIT");
  if (amount > BIND_DEPOSIT_CAP) return no("amount_above_cap", "amount: over the $1,000 beta cap");
  if (amount > (await reads.ftBalance(u))) return no("amount_above_balance", "amount: over the sender's balance");
  // The vault's row 2 and 2.10 (e): exactly the two fields, at most 1,024 bytes, P below p, depositor valid, not the vault.
  const msg = args.msg;
  if (Buffer.byteLength(msg, "utf8") > DEPOSIT_MESSAGE_MAX_BYTES) return no("bad_msg", "msg: over 1,024 bytes");
  let m: unknown;
  try {
    m = JSON.parse(msg);
  } catch {
    return no("bad_msg", "msg: not JSON");
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return no("bad_msg", "msg: not an object");
  const mk = Object.keys(m);
  if (mk.length !== 2 || mk[0] !== DEPOSIT_MESSAGE_FIELDS[0] || mk[1] !== DEPOSIT_MESSAGE_FIELDS[1]) return no("bad_msg", "msg: not exactly {precommitment, depositor}");
  const { precommitment: ps, depositor } = m as { precommitment: unknown; depositor: unknown };
  if (JSON.stringify({ precommitment: ps, depositor }) !== msg) return no("bad_msg", "msg: not written as the kit writes it");
  if (typeof ps !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(ps)) return no("bad_msg", "msg.precommitment: not one canonical decimal");
  const p = BigInt(ps);
  if (p >= FIELD_P) return no("bad_msg", "msg.precommitment: not below p");
  if (!isAccountId(depositor)) return no("bad_msg", "msg.depositor: not a NEAR account id");
  if (depositor === cfg.vault) return no("bad_msg", "msg.depositor: the vault");
  // The depositor is the moving id itself in every flow (kit shapes.ts VaultDepositMessage; wallet.md WM-11; CO round 3).
  if (depositor !== u) return no("bad_msg", "msg.depositor: not the sender");
  if (await reads.pUsed(p)) return no("p_used", "P: in the vault's deposits pages");

  // 7. R1-R3 per sender and per P (R3 ran after check 3).
  const bound = await ledger.boundTo(p);
  if (bound !== null && bound !== u) return no("p_bound", "R1: P prepaid for another sender");
  const open = await ledger.openP(u);
  if (open !== null && open !== p) return no("prepay_open", "R2: the sender has another open P");
  if (await ledger.inFlight(u, p)) return no("in_flight", "R7: a send of (U, P) is out");

  return {
    ok: true,
    deposit: { sender_id: u, public_key: publicKey, nonce: d.nonce, max_block_height: d.max_block_height, gas: a.gas, amount, precommitment: p, depositor, signed_delegate: bytes },
  };
}

// ---- NEP-366 SignedDelegateAction, borsh (nearcore core/primitives/src/action/delegate.rs) ----
// DelegateAction { sender_id: String, receiver_id: String, actions: Vec<NonDelegateAction>, nonce: u64,
// max_block_height: u64, public_key: PublicKey }, then signature: Signature. Only the actions /v1/bind can carry are
// read (FunctionCall, tag 2; DeleteAccount, tag 7); any other tag, a key or signature that is not ed25519, a short
// read or a byte left over is refused at decoding.

type Action = { kind: "FunctionCall"; method_name: string; args: Uint8Array; gas: bigint; deposit: bigint } | { kind: "DeleteAccount"; beneficiary_id: string };
type Decoded = {
  sender_id: string;
  receiver_id: string;
  actions: Action[];
  nonce: bigint;
  max_block_height: bigint;
  public_key: Uint8Array;
  signature: Uint8Array;
  /** borsh(DelegateAction): the bytes the signature covers, after the prefix. */
  delegate: Uint8Array;
};

export function decodeSignedDelegate(b: Uint8Array): Decoded {
  let i = 0;
  const take = (n: number): Uint8Array => {
    if (n > b.length - i) throw new Error("short");
    const out = b.subarray(i, i + n);
    i += n;
    return out;
  };
  const uint = (n: number): bigint => {
    const s = take(n);
    let v = 0n;
    for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(s[k]!);
    return v;
  };
  const u32 = (): number => Number(uint(4));
  // ignoreBOM: a leading U+FEFF stays in the string, as nearcore reads the bytes; dropping it would pass a receiver,
  // sender or method that the chain then refuses after the prepay and the send.
  const str = (): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(take(u32()));
  const ed25519 = (len: number, what: string): Uint8Array => {
    if (take(1)[0] !== 0) throw new Error(`${what}: not ed25519`);
    return take(len);
  };
  const sender_id = str();
  const receiver_id = str();
  const count = u32();
  const actions: Action[] = [];
  for (let k = 0; k < count; k++) {
    const tag = take(1)[0];
    if (tag === 2) actions.push({ kind: "FunctionCall", method_name: str(), args: take(u32()), gas: uint(8), deposit: uint(16) });
    else if (tag === 7) actions.push({ kind: "DeleteAccount", beneficiary_id: str() });
    else throw new Error(`action: tag ${tag} is not carried`);
  }
  const nonce = uint(8);
  const max_block_height = uint(8);
  const public_key = ed25519(32, "public_key");
  const delegate = b.subarray(0, i);
  const signature = ed25519(64, "signature");
  if (i !== b.length) throw new Error("bytes after the signature");
  return { sender_id, receiver_id, actions, nonce, max_block_height, public_key, signature, delegate };
}

function signatureOk(d: Decoded): boolean {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(NEP366_PREFIX);
  const hash = createHash("sha256").update(prefix).update(d.delegate).digest();
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(d.public_key).toString("base64url") }, format: "jwk" });
    return verify(null, hash, key, d.signature);
  } catch {
    return false;
  }
}

/** The args as the kit's carrier writes them: JSON.stringify({receiver_id, amount, msg}), three strings, in that order. */
function frozenArgs(raw: Uint8Array): { receiver_id: string; amount: string; msg: string } | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); // a BOM is kept, as for str()
    // The text equals the three strings written back in the carrier's order, so no other key, order, space or
    // repeated key passes; a null body throws at the destructuring and is caught below.
    const { receiver_id, amount, msg } = JSON.parse(text) as Record<string, unknown>;
    if (typeof receiver_id !== "string" || typeof amount !== "string" || typeof msg !== "string") return null;
    return JSON.stringify({ receiver_id, amount, msg }) === text ? { receiver_id, amount, msg } : null;
  } catch {
    return null;
  }
}

/** The kit's vaultAccountId rule: 2 to 64 characters, lowercase letters and digits, parts joined by - or _, split by dots. */
export function isAccountId(s: unknown): s is string {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = "1" + out;
  }
  return out;
}
