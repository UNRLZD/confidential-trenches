// The exit tool's reads of the Solana pool: public RPCs only, with no server of ours in the path (card exit-pool-notes).
//
// - Two RPCs of two operators read every account the restore uses (the pool's pages and every mark) by address, with
//   getMultipleAccounts, and must give the same bytes (the wallet's solanaMarksListed and solanaTreeSync).
// - One RPC lists the marks with getProgramAccounts, in buckets of public counters, and only names addresses: nothing
//   it answers is taken until both RPCs read it. The second mainnet RPC refuses getProgramAccounts ("Indexed requests
//   require a personal token", solana-rpc.publicnode.com, read 9 Nov 2026 18:40Z), and every keyless mainnet RPC tried
//   then was keyed, off the free plan or rate-limited, except api.mainnet-beta.solana.com, which served it. So the
//   lister is api.mainnet-beta.solana.com; on devnet, api.devnet.solana.com. A user may name another lister, any https RPC
//   that serves getProgramAccounts: each RPC's own pages must count the listed marks and their counters run with no hole
//   (the wallet's restore), so a lister that hides a mark is refused whoever runs it, its own RPC's operator included.
// - Each pool is the release's: its program from its deploy record (contracts/pool-solana/deployments/mainnet.json,
//   scripts/live-checks/pool-sol-deploy.devnet.json, program_id), so the 12 words alone read either cluster's pool.
// - Every call is paced to the keyless limit (the kit's solanaPacedRpc: 100 calls per 10 s, 40 per method).
import { solanaJsonRpc, solanaPacedRpc, type SolanaRpc } from "@blindfill/kit";

export type ExitSolCluster = "mainnet" | "devnet";

/** Per cluster: the release's pool program, its two RPCs and its lister. */
export const EXIT_SOL_CLUSTERS: Readonly<Record<ExitSolCluster, { readonly program: string; readonly rpcs: readonly [string, string]; readonly lister: string }>> = Object.freeze({
  mainnet: Object.freeze({
    program: "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF",
    rpcs: Object.freeze(["https://api.mainnet-beta.solana.com/", "https://solana-rpc.publicnode.com/"] as const),
    lister: "https://api.mainnet-beta.solana.com/",
  }),
  devnet: Object.freeze({
    program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8",
    rpcs: Object.freeze(["https://api.devnet.solana.com/", "https://solana-devnet.api.onfinality.io/public"] as const),
    lister: "https://api.devnet.solana.com/",
  }),
});

/** How long one RPC answer may take. */
export const EXIT_SOL_TIMEOUT_MS = 15_000;

/** A refusal before anything is read: an unknown cluster, a pair that is not the release's, a lister not on https. */
export class ExitSolRefused extends Error {
  constructor(detail: string) {
    super(`exit: ${detail}`);
    this.name = "ExitSolRefused";
  }
}

/** A transport fault (HTTP 429 or 5xx, a timeout) is tried again, backing off from 1 s, for up to a minute: a keyless
 * RPC answers a burst with 429 (solana-devnet.api.onfinality.io/public and api.mainnet-beta.solana.com, 9 Nov 2026). */
export const EXIT_SOL_RETRY = Object.freeze({ deadlineMs: 60_000, backoffMs: 1_000 });

/** A public Solana RPC by URL, paced to the keyless limit, its transport faults tried again (EXIT_SOL_RETRY). */
export function exitSolRpc(url: string, fetchFn: typeof fetch = fetch): SolanaRpc {
  return solanaPacedRpc(solanaJsonRpc(url, { fetch: fetchFn, timeoutMs: EXIT_SOL_TIMEOUT_MS, retry: EXIT_SOL_RETRY, init: { credentials: "omit", referrerPolicy: "no-referrer" } }));
}

const href = (url: string | undefined): string | undefined => {
  try {
    return url === undefined ? undefined : new URL(url).href;
  } catch {
    return undefined;
  }
};

/** The release's cluster entry, or a refusal. */
export function exitSolCluster(cluster: string): (typeof EXIT_SOL_CLUSTERS)[ExitSolCluster] {
  if (!Object.hasOwn(EXIT_SOL_CLUSTERS, cluster)) throw new ExitSolRefused(`no Solana cluster named ${JSON.stringify(cluster)}`);
  return EXIT_SOL_CLUSTERS[cluster as ExitSolCluster];
}

/**
 * The cluster's two RPCs and lister: the release's, fetched with `fetchFn`, unless given. Given RPCs must be the
 * release's two URLs, in order. A given lister is any https RPC.
 */
export function exitSolReads(cluster: string, given: { rpcs?: readonly [SolanaRpc, SolanaRpc]; lister?: SolanaRpc; fetchFn?: typeof fetch } = {}): { program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; lister: SolanaRpc } {
  const net = exitSolCluster(cluster);
  const fetchFn = given.fetchFn ?? fetch;
  const rpcs = given.rpcs ?? ([exitSolRpc(net.rpcs[0], fetchFn), exitSolRpc(net.rpcs[1], fetchFn)] as const);
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || rpcs.some((r, k) => typeof r !== "function" || href(r.url) !== net.rpcs[k]))
    throw new ExitSolRefused(`the two RPCs on ${cluster} are ${net.rpcs.join(" and ")}`);
  const lister = given.lister ?? exitSolRpc(net.lister, fetchFn);
  const at = href(lister.url);
  if (typeof lister !== "function" || at === undefined || !at.startsWith("https://")) throw new ExitSolRefused("the lister: an https RPC URL");
  return { program: net.program, rpcs, lister };
}
