// The exit tool's read of the vault (vault paper 2.12 step 2 and V4.2, docs/plan1/vault.md l.926-928 and l.1231): the
// four lists, deposits, spends, leaves and labels, page by page, from two public NEAR RPCs of different operators at
// one block, with no server of ours in the path.
//
// - The read is the kit's own vaultSync, through the kit's public entry, so the exit and the app hold one rule: one
//   block on both RPCs, each answer's bytes equal on both, rows exactly as the vault writes them, cursors that never
//   skip a row (packages/kit/src/vault/sync.ts, its header). The tool stops (VaultSyncStopped) the moment the two
//   answers differ by one byte, and returns nothing from a stopped read.
// - The two RPCs are the release's pair: one FastNEAR URL and the dRPC URL of the network (the kit's nearPairNetwork,
//   the one rule for every path that reads NEAR on two RPCs). Two hosts of one operator are one read, so they are
//   refused, as is any other provider. The URLs are the ones the kit and the terminal's Verify screen already pin
//   (packages/kit/src/near/networks.ts, apps/terminal/src/screens/verify/release.ts); test/rpc.test.ts holds them to
//   the kit's rule.
// - The vault is the release's: each network's deploy record (contracts/vault/deployments/mainnet-v1.json and
//   testnet-v1.json, account_id), so the 12 words alone read either network's vault.
// - Pages any public RPC serves: the kit's read starts each list at a page of about 125 Tgas and halves it (at most
//   three times) when an RPC refuses it as too heavy (review R-03, the kit's VAULT_SYNC_PAGE and vaultViewTooHeavy),
//   so a long list reads whole on both RPCs.
// - Current state only (view calls at the final block), so no archive node is needed.
import {
  nearPairNetwork,
  nearPairRule,
  vaultSync,
  vaultSyncStart,
  type NearNetwork,
  type VaultSyncCursor,
  type VaultSyncList,
  type VaultSyncResult,
  type VaultSyncRpc,
} from "@blindfill/kit";

/** Per network: the release's vault and its pair of public RPCs. */
export const EXIT_NETWORKS: Readonly<Record<NearNetwork, { readonly vault: string; readonly rpcs: readonly [string, string] }>> = Object.freeze({
  mainnet: Object.freeze({ vault: "vault.confidential.unrlzd.near", rpcs: Object.freeze(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"] as const) }),
  testnet: Object.freeze({
    vault: "vault.bf-vt-20261102t071444.testnet", // gitleaks:allow (a public account id)
    rpcs: Object.freeze(["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"] as const),
  }),
});

/** How long one RPC answer may take before the read stops ("rpc"). */
export const EXIT_RPC_TIMEOUT_MS = 15_000;

/** A refusal before anything is read: an unknown network, a vault or a pair that is not the release's. */
export class ExitRpcRefused extends Error {
  constructor(detail: string) {
    super(`exit: ${detail}`);
    this.name = "ExitRpcRefused";
  }
}

/**
 * A public NEAR RPC by URL: one JSON-RPC `query` per call, its whole answer back. A status other than 200 or 408, a
 * body that is not JSON or no answer in `timeoutMs` throws, which the read turns into a stop. A 408's JSON body is the
 * answer: dRPC's free plan stops a view that way when it is busy (code 30), and the kit's read asks for the same page
 * again after a wait (as the kit's nearRpc does, packages/kit/src/near/networks.ts).
 */
export function exitRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = EXIT_RPC_TIMEOUT_MS): VaultSyncRpc {
  return {
    name: url,
    async query(params, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill-exit", method: "query", params }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (res.status !== 200 && res.status !== 408) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}

export type ExitReadArgs = {
  network: NearNetwork;
  /** The vault to read: the release's on `network`, the only one read (any other is refused, ExitRpcRefused). */
  vault?: string;
  /** The two RPCs; the release's pair on `network`, fetched with `fetchFn`, unless given. Either way the pair must be the release's. */
  rpcs?: readonly [VaultSyncRpc, VaultSyncRpc];
  /** Where to start: every list from 0 unless given (the cursor a last read returned, to read only new rows). */
  cursor?: VaultSyncCursor;
  /** The lists to read; all four unless given. */
  lists?: readonly VaultSyncList[];
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
};

/**
 * Reads the vault's four lists on the release's two RPCs at one block and returns the rows both gave, byte for byte.
 * Throws ExitRpcRefused before any read, or the kit's VaultSyncStopped when the two RPCs differ by a byte, one fails,
 * or a row is not the vault's own.
 */
export async function exitReadPages(args: ExitReadArgs): Promise<VaultSyncResult> {
  const { network } = args;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  const net = EXIT_NETWORKS[network];
  const vault = args.vault ?? net.vault;
  // the release's vault on the network and no other, so a typed or passed name cannot steer the read
  if (vault !== net.vault) throw new ExitRpcRefused(`the vault on ${network} is ${net.vault}, not ${JSON.stringify(vault)}`);
  const fetchFn = args.fetchFn ?? fetch;
  const rpcs = args.rpcs ?? ([exitRpc(net.rpcs[0], fetchFn), exitRpc(net.rpcs[1], fetchFn)] as const);
  if (nearPairNetwork(rpcs) !== network) throw new ExitRpcRefused(nearPairRule(network));
  return vaultSync({ vault, rpcs, cursor: args.cursor ?? vaultSyncStart(vault), lists: args.lists, signal: args.signal });
}
