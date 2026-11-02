// The signing page's deposit rules: what SIGN_HOST will sign, or take as checked, for money going into the vault
// (card signpage-deposit-kinds; docs/plan1/wallet.md §2.8 at research ffcba5e: the deposit quote row W:888, the deposit
// call row W:889, the storage prepay row W:890; §2.4 steps 2 and 7, W:408 and W:413; tests WU-05, W:1044; row W4.4,
// W:1117). Every input but the device's own is hostile: the app's request, the RPC answers and the quote are checked
// against what the device itself derived and read, and a refusal is "not_allowed" with nothing signed.
//
// - Deposit call (W:889). The one carrier into the vault is the moving one-time id's own NEP-366
//   TOKEN.ft_transfer_call(vault, amount, msg), 1 yocto, 180 Tgas (W:394-400). The same rule holds for U_{s,i},
//   R_{c,l,j} and V_{l,j}: the id is whichever one-time id's key signs (M322 (1), research 11-merge-notes.md:330, which
//   replaces M306 (2)'s ft_withdraw for R and V, :314). checkDepositCall reads the exact bytes the key will sign,
//   borsh(DelegateAction), decodes them strictly (one action, a FunctionCall, no byte left over) and checks every field
//   against the context. So an intents.near ft_withdraw into the vault, from any id, is refused by its receiver and its
//   method, and so is any delegate to the vault itself.
// - Storage prepay (W:890): nothing for the device to sign. The relayer pays it from its own gas key; this file has no
//   rule that passes one, and a storage_prepay delegate is refused by the deposit call rule like any other receiver.
// - Deposit quote (W:888, §2.4 steps 2-3): the device's own 1Click request for a deposit must name U, the id §2.3's
//   deposit index rule names, as `recipient` (DESTINATION_CHAIN) and as `refundTo` (INTENTS), the vault's asset as the
//   destination and nothing the request does not need; then the answer goes through the kit's one 1Click check with
//   the output into the vault (signature, echo, floors, MIN_DEPOSIT). None of it while a no-PRF seed has not saved its
//   backup (OD:20).
//
// Not here: the reads themselves (packages/wallet/src/deposit/account.ts reads them on two RPCs), the signing, and the
// postMessage wiring (src/api.ts refuses every signing kind until it is wired). A pending `Pause` request on USDC is not
// readable on chain yet (vault SB run (4); M333): `pausePending` is refused when a read says so.
import {
  checkOneClickQuote,
  type OneClickCheckOptions,
  type OneClickChecked,
  type OneClickRequest,
} from "../../../kit/src/checks/oneclick.ts";
import { HELPER_BIND_DEPOSIT_CAP } from "../../../kit/src/helper/v1.ts";
import { VAULT_CONSTANTS, VAULT_DEPOSIT_CARRIER, VAULT_TOKEN_CODE_HASH } from "../../../kit/src/vault/shapes.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../../wallet/src/deposit/account.ts";
import { RELEASE_BIND_URL } from "../../../wallet/src/deposit/delegate.ts";

/** Wd: max_block_height is the lower of the two RPC heights + this (W:413: 120 blocks until vault SB run (6) sets it). */
export const DEPOSIT_WINDOW_BLOCKS = 120n;
/** The deposit call's gas: 180 Tgas (W:889). */
export const DEPOSIT_GAS = BigInt(VAULT_DEPOSIT_CARRIER.gas_tgas) * 1_000_000_000_000n;
/** The vault's asset on 1Click: NEAR USDC, the release's token (§2.4 step 2). */
export const DEPOSIT_DESTINATION_ASSET = `nep141:${VAULT_CONSTANTS.TOKEN}`;

const IMPLICIT = /^[0-9a-f]{64}$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A refusal: the answer is "not_allowed" (W:889's "not allowed"); `rule` names the field for the device's own log. */
export class DepositRuleRefused extends Error {
  readonly code = "not_allowed";
  readonly rule: string;
  constructor(rule: string) {
    super(`deposit not allowed: ${rule}`);
    this.name = "DepositRuleRefused";
    this.rule = rule;
  }
}
const refuse = (rule: string): never => {
  throw new DepositRuleRefused(rule);
};

// ---------- the deposit call (W:889) ----------

/** One RPC's reads of the moving id and the token, made on the device just before it signs. */
export interface DepositRead {
  /** The final block height this RPC answered. */
  height: bigint;
  /** view_access_key_list(id): every public key, "ed25519:<base58>". */
  keys: readonly string[];
  /** The nonce of the id's own key. */
  nonce: bigint;
  /** ft_balance_of(id) on the token, or "paused" when the view failed with "FiatToken: paused" (a halt, never a zero). */
  balance: bigint | "paused";
  /** storage_balance_of(vault) on the token is not null. */
  vaultRegistered: boolean;
  /** The token's code hash. */
  codeHash: string;
  /** A `Pause` request on the token is pending. */
  pausePending: boolean;
  /** The vault's `deposits` pages hold this call's P. */
  precommitmentInVault: boolean;
  /** The `deposits` pages hold this id's call before this one (true for its first). */
  priorInVault: boolean;
}

export interface DepositCallContext {
  /** Names the token and the vault: the release's, never the app's. */
  network: NearNetwork;
  /** The one-time id whose key signs (U, R or V), derived on the device: its 64-hex id and its 32-byte public key. */
  signer: { id: string; publicKey: Uint8Array };
  /** This call's note in §2.4's split: its precommitment P and its amount in the token's base units. */
  note: { precommitment: bigint; amount: bigint };
  /** The same reads on two RPCs. */
  reads: readonly [DepositRead, DepositRead];
  /**
   * The nonce of this id's earlier call that has not landed (§2.4 "Nothing landed"), when there is one: the new call
   * re-signs at that same nonce, the read nonce + 1, and one above it is refused (two could both land, W:906).
   */
  unlandedNonce?: bigint;
  /** Where the signed call goes. */
  route: string;
}

/** The decoded delegate the rule passed, with `bytes`: the rule's own copy of what it checked, the bytes to sign. */
export interface DepositCall {
  bytes: Uint8Array;
  sender_id: string;
  receiver_id: string;
  method_name: string;
  args: string;
  gas: bigint;
  deposit: bigint;
  nonce: bigint;
  max_block_height: bigint;
  public_key: Uint8Array;
}

/** borsh(DelegateAction) decoded only in the one shape a deposit call has: exactly one FunctionCall, no byte left. */
function decodeDepositDelegate(bytes: Uint8Array): Omit<DepositCall, "bytes"> {
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (at + n > bytes.length) refuse("payload");
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const uint = (n: number): bigint => {
    const b = take(n);
    let v = 0n;
    for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[k]);
    return v;
  };
  const blob = (): Uint8Array => take(Number(uint(4)));
  // ignoreBOM: a leading U+FEFF is kept as nearcore keeps it (and the relayer, apps/helper/src/bind/checks.ts), never
  // dropped, so a BOM-prefixed field is refused instead of read as the canonical one.
  const text = (): string => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob());
    } catch {
      return refuse("payload");
    }
  };
  const sender_id = text();
  const receiver_id = text();
  if (uint(4) !== 1n) refuse("actions"); // exactly one action
  if (take(1)[0] !== 2) refuse("action"); // Action::FunctionCall
  const method_name = text();
  const args = text();
  const gas = uint(8);
  const deposit = uint(16);
  const nonce = uint(8);
  const max_block_height = uint(8);
  if (take(1)[0] !== 0) refuse("public_key"); // KeyType::ED25519
  const public_key = Uint8Array.from(take(32));
  if (at !== bytes.length) refuse("payload");
  return { sender_id, receiver_id, method_name, args, gas, deposit, nonce, max_block_height, public_key };
}

function base58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, k) => x === b[k]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (o: Record<string, unknown>, ks: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === ks.length && ks.every((k) => Object.hasOwn(o, k));
};

/**
 * Checks the deposit call a one-time id (U, R or V) is about to sign: `delegate` is borsh(DelegateAction), the exact
 * bytes under the NEP-366 prefix. The rule copies them first and returns that copy as `bytes`: the caller signs those
 * bytes, so a change to `delegate` after the check reaches nothing signed. Throws DepositRuleRefused otherwise.
 */
export function checkDepositCall(delegate: Uint8Array, ctx: DepositCallContext): DepositCall {
  // The release's relayer only: never self-submitted, never another relayer.
  if (ctx.route !== RELEASE_BIND_URL) refuse("route");
  const release = Object.hasOwn(NEAR_NETWORKS, ctx.network) ? NEAR_NETWORKS[ctx.network] : refuse("network");
  if (release.vault === null) refuse("vault");
  const vault = release.vault as string;

  // The signer is a one-time NEAR-implicit id: its id is its own 32-byte public key in lowercase hex.
  const { signer, note, reads } = ctx;
  if (!IMPLICIT.test(signer.id) || signer.id !== hex(signer.publicKey)) refuse("signer");
  const ownKey = `ed25519:${base58(signer.publicKey)}`;

  const bytes = delegate instanceof Uint8Array ? Uint8Array.from(delegate) : refuse("payload");
  const d = decodeDepositDelegate(bytes);
  if (d.sender_id !== signer.id) refuse("sender_id");
  if (!sameBytes(d.public_key, signer.publicKey)) refuse("public_key");
  if (d.receiver_id !== release.usdc) refuse("receiver_id");
  if (d.method_name !== VAULT_DEPOSIT_CARRIER.method) refuse("method");
  if (d.deposit !== VAULT_DEPOSIT_CARRIER.deposit_yocto) refuse("deposit");
  if (d.gas !== DEPOSIT_GAS) refuse("gas");

  // args: exactly {receiver_id: the release's vault, amount, msg}, msg exactly {"precommitment": P, "depositor": id}.
  let args: unknown;
  try {
    args = JSON.parse(d.args);
  } catch {
    refuse("args");
  }
  if (!isObj(args)) refuse("args");
  const a = args as Record<string, unknown>;
  if (a.receiver_id !== vault) refuse("args.receiver_id");
  if (a.amount !== note.amount.toString()) refuse("args.amount");
  let msg: unknown;
  try {
    msg = typeof a.msg === "string" ? JSON.parse(a.msg) : undefined;
  } catch {
    refuse("msg");
  }
  if (!isObj(msg) || !keysAre(msg, ["precommitment", "depositor"])) refuse("msg");
  const m = msg as Record<string, unknown>;
  if (m.depositor !== signer.id) refuse("msg.depositor");
  if (m.precommitment !== note.precommitment.toString()) refuse("msg.precommitment");
  // One spelling only: no space, no repeated key, no other order, so every JSON reader sees the same call.
  const canonicalMsg = JSON.stringify({ precommitment: note.precommitment.toString(), depositor: signer.id });
  if (d.args !== JSON.stringify({ receiver_id: vault, amount: note.amount.toString(), msg: canonicalMsg })) refuse("args");

  // The amount: this note's, at least MIN_DEPOSIT, at most the beta cap (the kit's one constant: the device never signs
  // a deposit the relayer will not carry, kit/src/vault/messages.ts) and at most the id's balance on both RPCs.
  if (note.amount < VAULT_CONSTANTS.MIN_DEPOSIT) refuse("amount");
  if (note.amount > HELPER_BIND_DEPOSIT_CAP) refuse("cap");
  // Each read by its type, never by truthiness: a missing or odd field is refused, and a halt is never a zero.
  for (const r of reads) {
    if (typeof r.balance !== "bigint") refuse(r.balance === "paused" ? "halted" : "balance");
    if (r.pausePending !== false) refuse("pause_pending");
    if (r.codeHash !== VAULT_TOKEN_CODE_HASH) refuse("code_hash");
    if (note.amount > (r.balance as bigint)) refuse("balance");
    // The id exists, holding its own key and no other.
    if (!Array.isArray(r.keys) || r.keys.length !== 1 || r.keys[0] !== ownKey) refuse("keys");
    if (r.vaultRegistered !== true) refuse("vault_storage");
    if (r.precommitmentInVault !== false) refuse("precommitment_used");
    if (r.priorInVault !== true) refuse("prior_note");
    if (typeof r.nonce !== "bigint") refuse("nonce");
    if (typeof r.height !== "bigint") refuse("max_block_height");
  }

  // The nonce: the key nonce both RPCs read + 1, always. An earlier call that has not landed holds that same nonce (a
  // re-sign at it, §2.4 "Nothing landed"); one held above it would leave two calls that can both land, so it is refused.
  const [r0, r1] = reads;
  if (r0.nonce !== r1.nonce) refuse("nonce");
  if (d.nonce !== r0.nonce + 1n) refuse("nonce");
  if (ctx.unlandedNonce !== undefined && (typeof ctx.unlandedNonce !== "bigint" || ctx.unlandedNonce > r0.nonce + 1n)) refuse("nonce");

  // The height bound: the lower of the two heights + Wd, never further.
  const lower = r0.height < r1.height ? r0.height : r1.height;
  if (d.max_block_height !== lower + DEPOSIT_WINDOW_BLOCKS) refuse("max_block_height");
  return { ...d, bytes };
}

// ---------- the deposit quote (W:888) ----------

/** The request keys a deposit quote may carry (§2.4 step 2): no sessionId, connectedWallets or customRecipientMsg. */
const QUOTE_KEYS = new Set([
  "dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo",
  "refundType", "recipient", "recipientType", "deadline", "quoteWaitingTimeMs", "referral",
]);

export interface DepositQuoteContext {
  /** The stored seed's public status: its source and whether its backup is saved. */
  seed: { source: string | null; code_saved: boolean };
  /** U, the one-time id §2.3's deposit index rule names, derived on the device. */
  depositId: string;
  /** The kit's 1Click check options but the output's place: a deposit's output always goes into the vault. */
  check: Omit<OneClickCheckOptions, "intoVault">;
}

/**
 * Checks the device's own 1Click request for a deposit and the answer to it. Returns the kit's checked quote (its
 * signed deposit address on a live answer) when every rule holds; throws DepositRuleRefused, or the kit's
 * OneClickQuoteError for the signature, echo and floors, otherwise.
 */
export function checkDepositQuote(request: OneClickRequest, answer: unknown, ctx: DepositQuoteContext): OneClickChecked {
  // The backup gate (OD:20): a swapped app cannot skip it.
  if (ctx.seed.source !== "prf" && ctx.seed.code_saved !== true) refuse("backup");
  const u = ctx.depositId;
  if (!IMPLICIT.test(u)) refuse("deposit_id");
  if (!isObj(request)) refuse("request");
  // One read of each field: the rule and the kit's echo see the same request, whatever getters `request` has.
  const req = { ...request } as OneClickRequest;
  if (Object.keys(req).some((k) => !QUOTE_KEYS.has(k))) refuse("request");
  if (req.swapType !== "EXACT_INPUT") refuse("swapType");
  if (req.depositType !== "ORIGIN_CHAIN") refuse("depositType");
  if (req.destinationAsset !== DEPOSIT_DESTINATION_ASSET) refuse("destinationAsset");
  // 1Click delivers on the token to U's own NEAR account; a refund lands under U inside intents.near.
  if (req.recipient !== u) refuse("recipient");
  if (req.recipientType !== "DESTINATION_CHAIN") refuse("recipientType");
  if (req.refundTo !== u) refuse("refundTo");
  if (req.refundType !== "INTENTS") refuse("refundType");
  return checkOneClickQuote(req, answer, { ...ctx.check, intoVault: true });
}
