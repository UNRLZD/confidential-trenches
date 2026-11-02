// Verify's reads (app.md A7, :103; A3.3): seven view calls, sent to two RPCs at one block. The kit has no Verify read
// helper yet, so the panel sends them through the kit's VaultSyncRpc, the same `query` shape vaultSync reads, at the
// lower of the two final heights (vaultSync's rule). Every answer is kept whole, a failed one as { error }; the model
// (model.ts) judges them. Nothing here throws on an RPC's answer.
import { nearPairNetwork, nearPairRule, type VaultSyncRpc } from "@blindfill/kit";

export const VERIFY_READS = ["keys", "account", "config", "totals", "balance", "registration", "token"] as const;
export type VerifyReadId = (typeof VERIFY_READS)[number];

/** What the panel checks against: the vault, its asset (the token it holds), the release's code hash and the asset's. */
export type VerifyPins = {
  vault: string;
  asset: string;
  /** The released vault code's hash (base58), as view_account names it. */
  release: string;
  /** The asset (token) contract's code hash (base58); the kit's VAULT_TOKEN_CODE_HASH on mainnet. */
  assetRelease: string;
  assetSymbol: string;
  assetDecimals: number;
};

/** One RPC's answers: each read's whole JSON-RPC answer, or { error } when the query failed. */
export type VerifyRpcReads = { name: string; answers: Partial<Record<VerifyReadId, unknown>> };
export type VerifyReads = { height: number; rpcs: [VerifyRpcReads, VerifyRpcReads] };

const arg = (o: object) => btoa(JSON.stringify(o));

/** The params of one read at `at`. */
export function verifyQuery(id: VerifyReadId, pins: VerifyPins, at: { block_id: number } | { finality: "final" }): Record<string, unknown> {
  const view = (method_name: string, account_id: string, a: object) => ({ request_type: "call_function", account_id, method_name, args_base64: arg(a), ...at });
  switch (id) {
    case "keys":
      return { request_type: "view_access_key_list", account_id: pins.vault, ...at };
    case "account":
      return { request_type: "view_account", account_id: pins.vault, ...at };
    case "config":
      return view("config", pins.vault, {});
    case "totals":
      return view("totals", pins.vault, {});
    case "balance":
      return view("ft_balance_of", pins.asset, { account_id: pins.vault });
    case "registration":
      return view("storage_balance_of", pins.asset, { account_id: pins.vault });
    case "token":
      return { request_type: "view_account", account_id: pins.asset, ...at };
  }
}

const failed = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

function finalHeight(a: unknown): number | null {
  const h = (a as { result?: { block_height?: unknown } } | null)?.result?.block_height;
  return Number.isSafeInteger(h) && (h as number) > 0 ? (h as number) : null;
}

/**
 * Reads the seven views on both RPCs at one block: the lower of their final heights, or the one final height read
 * when the other RPC did not answer. Refuses a pair the kit's one rule refuses (nearPairRule's words, thrown before any
 * read: exactly one FastNEAR URL and the network's dRPC, each named by the URL it reads), or no final height from either.
 */
export async function readVerify(rpcs: readonly [VaultSyncRpc, VaultSyncRpc], pins: VerifyPins, signal?: AbortSignal): Promise<VerifyReads> {
  if (nearPairNetwork(rpcs) === null) throw new Error(nearPairRule());
  const probe = verifyQuery("keys", pins, { finality: "final" });
  const finals = await Promise.all(rpcs.map((r) => r.query(probe, signal).then(finalHeight, () => null)));
  const known = finals.filter((h): h is number => h !== null);
  if (known.length === 0) throw new Error("Verify read no final height on either RPC");
  const height = Math.min(...known);
  const at = { block_id: height };
  const one = async (rpc: VaultSyncRpc): Promise<VerifyRpcReads> => {
    const got = await Promise.all(VERIFY_READS.map((id) => rpc.query(verifyQuery(id, pins, at), signal).catch(failed)));
    return { name: rpc.name, answers: Object.fromEntries(VERIFY_READS.map((id, i) => [id, got[i]])) };
  };
  const [a, b] = await Promise.all([one(rpcs[0]), one(rpcs[1])]);
  return { height, rpcs: [a, b] };
}
