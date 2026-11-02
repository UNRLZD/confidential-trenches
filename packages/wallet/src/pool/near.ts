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
//   the chunk, refund note (l, j)'s precommitment, a fresh salt, and deadline_ms = T + 600,000 - r in block time
//   (../withdraw/request.ts withdrawDeadlineMs). The request it returns is withdraw()'s first argument as is.
// - now: the newest final block's timestamp_nanosec, the lower of two RPCs, in ms; never the device clock.
// - remake margin: 120 s (the relayer's check 9 margin, markets.md H3.4), so a ready proof is always one the relayer
//   still takes, with a proof's time to spare.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf, vaultWithdrawRequest, type VaultWithdrawal } from "@blindfill/kit";
import { NEAR_NETWORKS, type NearNetwork } from "../deposit/account.ts";
import { type FeeRpc, readWithdrawFeeMax } from "../withdraw/feemax.ts";
import { blockTimeMsOf, WITHDRAW_SEND_MARGIN_MS, withdrawDeadlineMs } from "../withdraw/request.ts";
import type { Ladder } from "./ladder.ts";
import type { Pool, PoolTrees } from "./pool.ts";

/** USDC's ladder: $1 = 10^6 base units, from $2 (owner pick ladder, OD:268). */
export const USDC_LADDER: Ladder = Object.freeze({ one: 1_000_000n, min: 2_000_000n });

export type NearVaultPoolArgs = {
  vaultId: string;
  /** The network's USDC: fee_max is in its unit. */
  token: string;
  network: NearNetwork;
  rpcs: readonly [FeeRpc, FeeRpc];
  priceRpcs: readonly [FeeRpc, FeeRpc];
  /** The release's relayer fee recipient, never a helper's answer. */
  feeRecipient: string;
  /** The relayer's fee for one withdrawal, in USDC base units; refused above the device's fee_max. */
  relayFee: () => Promise<bigint>;
  /** register_deposit for an account on `token`, read on two RPCs (arming/accounts.ts armingRegisterDepositOf). */
  registerDepositOf: (accountId: string, token: string) => Promise<bigint>;
  /** The newest final block's header.timestamp_nanosec, a decimal string: the lower of two RPCs'. */
  blockTimestampNanosec: (signal?: AbortSignal) => Promise<string>;
  /** The vault's trees and newest roots from the sync (kit vault/sync.ts), on two RPCs. */
  trees: (signal?: AbortSignal) => Promise<PoolTrees>;
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
    remakeMarginMs: BigInt(WITHDRAW_SEND_MARGIN_MS),
    async now(signal) {
      return BigInt(blockTimeMsOf(await a.blockTimestampNanosec(signal)));
    },
    trees: (signal) => a.trees(signal),
    async bind({ chunk, wallet, refundPrecommitment }, signal) {
      if (!(wallet.publicKey instanceof Uint8Array) || wallet.publicKey.length !== 32 || wallet.address !== hex(wallet.publicKey))
        throw new Error("wallet: a NEAR W is the 64-hex id of its ed25519 public key");
      const ns = await a.blockTimestampNanosec(signal);
      const nowMs = blockTimeMsOf(ns);
      const deadlineMs = withdrawDeadlineMs(ns);
      const registerDeposit = await a.registerDepositOf(wallet.address, token);
      if (typeof registerDeposit !== "bigint") throw new Error("registerDepositOf: not a bigint");
      const relayFee = await a.relayFee();
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
        deadlineMs,
        withdrawn: chunk,
        nowMs,
      });
      return { context: BigInt(req.context), deadlineMs: BigInt(deadlineMs), feeCap: relayFee, request: req.withdrawal };
    },
  };
}
