// A withdrawal request (card vault-kit-messages; the vault paper 7.1, docs/plan1/vault.md l.1259, and 2.5.2): the
// `withdrawal` argument of withdraw(withdrawal, proof, public_signals), exactly the frozen VaultWithdrawal, with a
// fresh 16-byte salt, and the `context` its proof must carry.
//
// - The salt is 16 random bytes from the device's crypto.getRandomValues, drawn anew on every call, so each attempt has
//   its own context (wallet paper §2.3). It is written as 32 lowercase hex characters, the vault's one form. No caller
//   can supply the source or the salt: an argument this builder does not name is refused.
// - The scope is the vault's own, computed from the vault and its token as the vault computes it (vaultScopeOf; the
//   vault's scope() is scope_for(current_account_id, TOKEN)), so no caller can pair a vault with another scope.
// - Every field is refused where the vault would refuse it, before the device spends a proof on it
//   (vaultWithdrawalProblems: the form of each field, recipient or fee_recipient the vault or intents.near, a deadline
//   already passed, withdrawn 0 or over a u128, relay_fee over the backstop).
// - The context is vaultContextOf over the withdrawal as the vault reads it (vaultContextInput), so it is the one
//   vaultWithdrawInput (inputs.ts) computes from the same withdrawal, vault and scope.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultContextInput, vaultContextOf, vaultScopeOf, vaultWithdrawalProblems, type VaultWithdrawal } from "./shapes.ts";

/** What the device knows when it asks for a withdrawal. */
export type VaultWithdrawRequestArgs = {
  /** The vault's account id (the context's processor) and its token, which give the vault's scope. */
  vaultId: string;
  token: string;
  recipient: string;
  /** NEAR, in yocto, for the recipient's token registration: 0 for a registered account. */
  registerDeposit: bigint;
  feeRecipient: string;
  /** The fee, in the token's base units; 0 when the user sends the withdrawal. */
  relayFee: bigint;
  refundPrecommitment: bigint;
  /** In the vault's block time, ms. */
  deadlineMs: number;
  /** The amount the proof withdraws, checked against the fee's backstop. */
  withdrawn: bigint;
  /** The time now, ms: a whole number, 0 or more. */
  nowMs: number;
};

const ARGS = ["vaultId", "token", "recipient", "registerDeposit", "feeRecipient", "relayFee", "refundPrecommitment", "deadlineMs", "withdrawn", "nowMs"] as const;

/** withdraw's first argument and the context, a decimal, that its proof's last public signal must equal. */
export type VaultWithdrawRequest = { withdrawal: VaultWithdrawal; context: string };

/** A withdrawal request with a fresh salt, refused with every problem the vault would find in it. */
export function vaultWithdrawRequest(a: VaultWithdrawRequestArgs): VaultWithdrawRequest {
  for (const k of Object.keys(a)) {
    if (!(ARGS as readonly string[]).includes(k)) throw new Error(`${k}: not an argument of the request`);
  }
  for (const k of ["registerDeposit", "relayFee", "refundPrecommitment", "withdrawn"] as const) {
    if (typeof a[k] !== "bigint") throw new Error(`${k}: not a bigint`);
  }
  if (!Number.isSafeInteger(a.nowMs) || a.nowMs < 0) throw new Error("nowMs: not a whole number, 0 or more");
  const scope = vaultScopeOf(keccak_256, a.vaultId, a.token);
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const withdrawal: VaultWithdrawal = {
    recipient: a.recipient,
    register_deposit: a.registerDeposit.toString(),
    fee_recipient: a.feeRecipient,
    relay_fee: a.relayFee.toString(),
    refund_precommitment: a.refundPrecommitment.toString(),
    deadline_ms: a.deadlineMs,
    salt: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
  const problems = vaultWithdrawalProblems(withdrawal, a.withdrawn, a.vaultId, a.nowMs);
  if (problems.length > 0) throw new Error(`withdrawal: ${problems.join("; ")}`);
  const context = vaultContextOf(keccak_256, vaultContextInput(a.vaultId, withdrawal), scope);
  return { withdrawal, context: context.toString() };
}
