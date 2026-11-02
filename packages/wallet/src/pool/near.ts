// The NEAR vault as the first pool (card wallet-pool-ladder; architecture v2, M349: the NEAR vault stays the USDC home
// and the stop between chains). It implements ./pool.ts with the vault's own rules, so the queue proves NEAR notes the
// way it will prove Solana and EVM ones.
//
// - scope: the vault's own, vaultScopeOf(vault, token), as the vault computes scope_for(current_account_id, TOKEN).
// - W: W_{near, l, j}, a NEAR implicit account (its 64-hex public key). The context function refuses an address that is
//   not the hex of the public key it was handed.
// - bind: the kit's vaultWithdrawRequest, the one the vault recomputes (vaultContextOf over vaultContextInput, the
//   vault as processor): recipient W, register_deposit read for W on two RPCs, the release's fee recipient, the
//   relayer's fee (exact on this vault) refused above the device's own fee_max (../withdraw/feemax.ts) or at or above
//   the chunk, refund note (l, j)'s precommitment, a fresh salt, and the queue's deadline_ms on the epoch grid. The
//   request it returns is withdraw()'s first argument as is. The relayer's fee is its fee for the epoch.
// - now: the newest final block's timestamp_nanosec, the lower of two RPCs, in ms; never the device clock.
// - Epochs of 60 s and a life of 270 s: one epoch to use the set, one epoch to make it again, the relayer's 120 s
//   check 9 margin (markets.md H3.4) and 30 s of slack, twice the queue's take slack (pool.ts TAKE_SLACK_MS), so a
//   take anywhere in the next epoch still has the margin + 15 s left; well inside the device's 10 minute cap on deadline_ms
//   (../withdraw/request.ts WITHDRAW_DEADLINE_MAX_MS). The vault keeps every root, so an epoch root stays valid.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf, vaultWithdrawRequest, type VaultWithdrawal } from "@blindfill/kit";
import { NEAR_NETWORKS, type NearNetwork } from "../deposit/account.ts";
import { type FeeRpc, readWithdrawFeeMax } from "../withdraw/feemax.ts";
import { blockTimeMsOf, WITHDRAW_DEADLINE_MAX_MS, WITHDRAW_SEND_MARGIN_MS } from "../withdraw/request.ts";
import type { Ladder } from "./ladder.ts";
import { TAKE_SLACK_MS, type Pool, type PoolTrees } from "./pool.ts";

/** USDC's ladder: $1 = 10^6 base units, from $2 (owner pick ladder, OD:268). */
export const USDC_LADDER: Ladder = Object.freeze({ one: 1_000_000n, min: 2_000_000n });
/** E and L on the NEAR vault, ms. */
export const NEAR_EPOCH_MS = 60_000n;
export const NEAR_LIFE_MS = 2n * NEAR_EPOCH_MS + BigInt(WITHDRAW_SEND_MARGIN_MS) + 2n * TAKE_SLACK_MS;
if (NEAR_LIFE_MS > BigInt(WITHDRAW_DEADLINE_MAX_MS)) throw new Error("the NEAR life is past the 10 minute cap");

export type NearVaultPoolArgs = {
  vaultId: string;
  /** The network's USDC: fee_max is in its unit. */
  token: string;
  network: NearNetwork;
  rpcs: readonly [FeeRpc, FeeRpc];
  priceRpcs: readonly [FeeRpc, FeeRpc];
  /** The release's relayer fee recipient, never a helper's answer. */
  feeRecipient: string;
  /** The relayer's published fee for one withdrawal in the epoch starting at epochStartMs, in USDC base units, in
   * coarse steps; refused above the device's fee_max. */
  relayFee: (epochStartMs: bigint) => Promise<bigint>;
  /** register_deposit for an account on `token`, read on two RPCs (arming/accounts.ts armingRegisterDepositOf). */
  registerDepositOf: (accountId: string, token: string) => Promise<bigint>;
  /** The newest final block's header.timestamp_nanosec, a decimal string: the lower of two RPCs'. */
  blockTimestampNanosec: (signal?: AbortSignal) => Promise<string>;
  /** The vault's trees holding only the leaves that landed before beforeMs, and their roots, from the sync on two RPCs. */
  trees: (beforeMs: bigint, signal?: AbortSignal) => Promise<PoolTrees>;
};

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function nearVaultPool(a: NearVaultPoolArgs): Pool<VaultWithdrawal> {
  if (typeof a.network !== "string" || !Object.hasOwn(NEAR_NETWORKS, a.network)) throw new Error(`network: unknown ${String(a.network)}`);
  if (a.token !== NEAR_NETWORKS[a.network].usdc) throw new Error("token: not the network's own (fee_max is in its unit)");
  const { vaultId, token } = a;
  return {
    id: `near:${vaultId}:${token}`,
    chain: "near",
    scope: vaultScopeOf(keccak_256, vaultId, token),
    ladder: USDC_LADDER,
    epochMs: NEAR_EPOCH_MS,
    lifeMs: NEAR_LIFE_MS,
    sendMarginMs: BigInt(WITHDRAW_SEND_MARGIN_MS),
    async now(signal) {
      return BigInt(blockTimeMsOf(await a.blockTimestampNanosec(signal)));
    },
    trees: (beforeMs, signal) => a.trees(beforeMs, signal),
    async bind({ chunk, wallet, refundPrecommitment, epochStartMs, deadlineMs }, signal) {
      if (!(wallet.publicKey instanceof Uint8Array) || wallet.publicKey.length !== 32 || wallet.address !== hex(wallet.publicKey))
        throw new Error("wallet: a NEAR W is the 64-hex id of its ed25519 public key");
      const ns = await a.blockTimestampNanosec(signal);
      const nowMs = blockTimeMsOf(ns);
      if (typeof deadlineMs !== "bigint" || deadlineMs !== epochStartMs + NEAR_LIFE_MS || deadlineMs <= BigInt(nowMs) + BigInt(WITHDRAW_SEND_MARGIN_MS))
        throw new Error("deadlineMs: not on the epoch grid, or too close to send");
      const registerDeposit = await a.registerDepositOf(wallet.address, token);
      if (typeof registerDeposit !== "bigint") throw new Error("registerDepositOf: not a bigint");
      const relayFee = await a.relayFee(epochStartMs);
      if (typeof relayFee !== "bigint" || relayFee < 0n) throw new Error("relayFee: not a bigint, 0 or more");
      if (relayFee >= chunk) throw new Error("relayFee: at or above the chunk");
      const feeMax = await readWithdrawFeeMax({ network: a.network, rpcs: a.rpcs, priceRpcs: a.priceRpcs, registerDeposit });
      if (relayFee > feeMax) throw new Error("relayFee: above the device's fee_max");
      const req = vaultWithdrawRequest({
        vaultId,
        token,
        recipient: wallet.address,
        registerDeposit,
        feeRecipient: a.feeRecipient,
        relayFee,
        refundPrecommitment,
        deadlineMs: Number(deadlineMs),
        withdrawn: chunk,
        nowMs,
      });
      return { context: BigInt(req.context), feeCap: relayFee, request: req.withdrawal };
    },
  };
}
