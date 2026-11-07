// The arrival of a withdrawal the vault pays straight to the NEAR account the user typed (card wallet-withdraw-move-out;
// the vault's payout, contracts/vault/src/payout.rs: one receipt on the token that registers the recipient when
// register_deposit > 0 and pays it, all or none, then on_payout writes the spend record's status from that receipt).
//
// The arrival is read from the vault's spends pages on the release pair, at one block, byte for byte (the kit's
// vaultSync, as relayWithdraw reads its landing), never from the relayer's answer, a tx hash or one RPC:
//   - "paid", or "settled" with refund_value 0 (anyone may settle a paid spend): the token paid the recipient in the
//     payout receipt, so the money is at the typed account. Arrived only when the row's recipient is the one typed.
//   - "refund_pending", or "settled" with refund_value above 0: the payout receipt failed whole, nothing reached the
//     recipient, and the withdrawn value is the refund note's in the vault (Dev 4). Refunded.
//   - a recipient other than the one typed: another device on the seed spent the note elsewhere. Elsewhere.
//   - "in_flight" (on_payout has not run yet), or no row yet: read again next round.
// A read that fails, or two RPCs that disagree, concludes nothing that round. Nothing here sends or signs anything, so a
// page that dies here and a rerun cost reads only. Nothing here logs.
import { vaultSync, vaultSyncStart, type VaultSpendRow, type VaultSyncRpc } from "@blindfill/kit";
import { NEAR_NETWORKS, type NearNetwork, nearPairNetwork, nearPairRule } from "../deposit/account.ts";

export type ArrivalOutcome =
  | { kind: "arrived"; spend: VaultSpendRow }
  | { kind: "refunded"; spend: VaultSpendRow }
  | { kind: "elsewhere"; spend: VaultSpendRow };

export type ArrivalArgs = {
  network: NearNetwork;
  /** The network's release pair. */
  rpcs: readonly [VaultSyncRpc, VaultSyncRpc];
  /** The spent note's nullifier hash (public signal 1 of the withdrawal). */
  nullifierHash: bigint;
  /** The NEAR account the user typed, the withdrawal's recipient. */
  recipient: string;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

export const ARRIVAL_POLL_MS = 1_000;

/** What one spends row says of the payout to `recipient`; null while it can still change (in_flight). */
export function arrivalOf(row: VaultSpendRow, recipient: string): ArrivalOutcome | null {
  if (row.recipient !== recipient) return { kind: "elsewhere", spend: row };
  if (row.status === "paid" || (row.status === "settled" && row.refundValue === 0n)) return { kind: "arrived", spend: row };
  if (row.status === "refund_pending" || row.status === "settled") return { kind: "refunded", spend: row };
  return null;
}

/** Follows the spend of `nullifierHash` on the vault's pages until its payout has run; stops on `signal`. */
export async function withdrawArrival(a: ArrivalArgs): Promise<ArrivalOutcome> {
  const { network, rpcs, nullifierHash, recipient, signal } = a;
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new Error(`network: unknown ${String(network)}`);
  const vault = NEAR_NETWORKS[network].vault;
  if (vault === null) throw new Error(`the release names no vault on ${network}`);
  if (nearPairNetwork(rpcs) !== network) throw new Error(nearPairRule(network));
  if (typeof nullifierHash !== "bigint" || typeof recipient !== "string" || recipient.length === 0) throw new Error("nullifierHash or recipient: not given");
  const sleep = a.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  for (;;) {
    signal?.throwIfAborted();
    try {
      const s = await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["spends"], ...(signal ? { signal } : {}) });
      const row = s.spends.find((r) => r.nullifierHash === nullifierHash);
      const out = row === undefined ? null : arrivalOf(row, recipient);
      if (out !== null) return out;
    } catch {
      signal?.throwIfAborted(); // one RPC down, behind or disagreeing: nothing concluded this round
    }
    await sleep(a.pollMs ?? ARRIVAL_POLL_MS);
  }
}
