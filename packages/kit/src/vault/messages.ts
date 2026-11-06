// The vault module's messages (card vault-kit-messages; the vault paper V4.1 and 7.1, docs/plan1/vault.md l.1230 and
// l.1257-1259): the one deposit call and its storage prepay here, the withdrawal request in request.ts. Both build
// only from the frozen shapes (shapes.ts) and add no field to them.
//
// - One deposit call for every mover. The deposit's id U, a return id R, a refund id V (and A's move back to the
//   vault) all move money in the same way: the moving NEAR-implicit account's own TOKEN.ft_transfer_call(vault,
//   amount, msg) with 1 yocto and 180 Tgas, signed by that account as a NEP-366 DelegateAction (VAULT_DEPOSIT_CARRIER,
//   VAULT_DEPOSIT_SIGNERS). So there is one builder, and the depositor is the mover itself: the message's depositor
//   and the delegate's sender_id come from one argument and cannot differ.
// - The call is the unsigned part of the helper's HelperBindDeposit (helper/v1.ts): sender_id, receiver_id and the one
//   FunctionCall action, written as POST /v1/bind decodes it. The signer adds nonce, max_block_height and public_key.
// - The amount is refused where the vault would refuse it (2.5.1 rows 4-5): under MIN_DEPOSIT, or not below u128::MAX,
//   and above the beta cap HELPER_BIND_DEPOSIT_CAP, which the relayer also refuses: the device never signs a deposit
//   the relayer will not carry. The cap is read from that one constant, so lifting it changes one line.
// - The vault refuses a depositor equal to itself (2.5.1 row 2) and the relayer refuses it too, so a 64-hex vault equal
//   to the mover is refused here; so is intents.near as the vault, since the vault's balance rests outside it.
// - The prepay keys the same canonical decimal as the message, so a prepay and its deposit name one record (2.5.1). It
//   takes a byte count: VAULT_STORAGE_PREPAY.min_bytes (756) or bytes_when_a_tree_may_grow (904) on a new record, and
//   any amount on a record that exists, such as the 148-byte top-up when a tree may grow after the first prepay.
import { HELPER_BIND_DEPOSIT_CAP, type HelperFtTransferCallArgs, type HelperFunctionCall } from "../helper/v1.ts";
import {
  VAULT_CONSTANTS,
  VAULT_DEPOSIT_CARRIER,
  VAULT_FIELD_P,
  VAULT_STORAGE_BYTE_COST,
  VAULT_STORAGE_PREPAY,
  vaultAccountId,
  vaultDepositMessage,
} from "./shapes.ts";

export * from "./request.ts";

const TGAS = 1_000_000_000_000;
const U128_MAX = (1n << 128n) - 1n;

/** What a move into the vault needs: the vault, its token, the moving id (64 hex), the amount and the note's precommitment. */
export type VaultDepositCallArgs = {
  vault: string;
  token: string;
  /** The moving NEAR-implicit id (U, R, V or A): the delegate's signer and the message's depositor. */
  mover: string;
  /** In the token's base units. */
  amount: bigint;
  precommitment: bigint;
};

/** The deposit delegate before it is signed: the mover's one ft_transfer_call on the token. */
export type VaultDepositCall = {
  sender_id: string;
  receiver_id: string;
  actions: [HelperFunctionCall<"ft_transfer_call", HelperFtTransferCallArgs>];
};

/**
 * The one deposit call, the same for U, R, V and A: mover's TOKEN.ft_transfer_call(vault, amount,
 * vaultDepositMessage(precommitment, mover)), 1 yocto, 180 Tgas. Refuses a vault or token that is not a NEAR account
 * id or names the other, intents.near as the vault, a mover that is not a lowercase 64-hex NEAR-implicit id or is the
 * vault, a precommitment not below p, an amount that is not a bigint, under MIN_DEPOSIT, over HELPER_BIND_DEPOSIT_CAP
 * or not below u128::MAX.
 */
export function vaultDepositCall(a: VaultDepositCallArgs): VaultDepositCall {
  const vault = vaultAccountId(a.vault, "vault");
  const token = vaultAccountId(a.token, "token");
  if (vault === token) throw new Error("vault: the token");
  if (vault === VAULT_CONSTANTS.INTENTS) throw new Error("vault: intents.near");
  if (a.mover === vault) throw new Error("mover: the vault");
  if (typeof a.amount !== "bigint") throw new Error("amount: not a bigint");
  if (a.amount < VAULT_CONSTANTS.MIN_DEPOSIT) throw new Error("amount: under MIN_DEPOSIT");
  if (a.amount > HELPER_BIND_DEPOSIT_CAP) throw new Error("amount: over HELPER_BIND_DEPOSIT_CAP");
  // The vault's own bound, which holds once the beta cap is lifted.
  if (a.amount >= U128_MAX) throw new Error("amount: not below u128::MAX");
  const msg = vaultDepositMessage(a.precommitment, a.mover);
  return {
    sender_id: a.mover,
    receiver_id: token,
    actions: [
      {
        FunctionCall: {
          method_name: VAULT_DEPOSIT_CARRIER.method,
          args: { receiver_id: vault, amount: a.amount.toString(), msg },
          gas: VAULT_DEPOSIT_CARRIER.gas_tgas * TGAS,
          deposit: "1",
        },
      },
    ],
  };
}

/** The storage prepay a deposit needs first, by anyone (the relayer): vault.storage_prepay({precommitment}). */
export type VaultStoragePrepay = {
  receiver_id: string;
  method: typeof VAULT_STORAGE_PREPAY.method;
  args: { precommitment: string };
  deposit_yocto: bigint;
};

/**
 * storage_prepay(precommitment) on the vault, attaching `bytes` × VAULT_STORAGE_BYTE_COST. The precommitment is written
 * as the deposit message writes it, in 1..p-1 as the vault takes it (0 refused, vault review R-01). bytes is a positive
 * whole number; the vault refuses under min_bytes on a new record.
 */
export function vaultStoragePrepay(vault: string, precommitment: bigint, bytes: number): VaultStoragePrepay {
  if (typeof precommitment !== "bigint" || precommitment <= 0n || precommitment >= VAULT_FIELD_P) throw new Error("precommitment: not in 1..p-1");
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("bytes: not a positive whole number");
  return {
    receiver_id: vaultAccountId(vault, "vault"),
    method: VAULT_STORAGE_PREPAY.method,
    args: { precommitment: precommitment.toString() },
    deposit_yocto: BigInt(bytes) * VAULT_STORAGE_BYTE_COST,
  };
}
