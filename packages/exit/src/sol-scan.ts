// The exit tool's scan of the Solana pool (card exit-pool-notes): from the 12 words alone, every note the wallet has in
// the pool, each followed through its spends, on public RPCs (./sol-rpc.ts).
//
// - The walk is the wallet's own Solana restore (packages/wallet/src/pool/solana-restore.ts solanaRestoreNotes),
//   reached through the kit's ./core export and run unchanged, as ./scan.ts runs the vault's: nothing here derives a
//   note or matches a mark. Its marks are listed by the lister and read by both RPCs (solanaMarksListed), so neither RPC
//   learns which marks are the user's, and a lister that hides a mark or lists none stops the restore at the leaf count
//   (the pages, read on both RPCs, count every deposit and release).
// - The 12 words become seed64 as ./scan.ts withSeed64 makes it, zeroed when the scan ends, on every path.
import { RESTORE_GAP, solanaPoolOf, solanaRestoreNotes, type SolanaRestoredNote, type SolanaRestoredSpend } from "@blindfill/kit/core";
import type { SolanaRpc } from "@blindfill/kit";
import { exitSolReads, ExitSolRefused, type ExitSolCluster } from "./sol-rpc.ts";
import { withSeed64 } from "./scan.ts";

export type ExitSolScanArgs = {
  /** the 12 words, as typed */
  words: string;
  cluster: ExitSolCluster;
  /** the release's two RPCs on `cluster` unless given; given ones must be named by its two URLs */
  rpcs?: readonly [SolanaRpc, SolanaRpc];
  /** the release's lister unless given (./sol-rpc.ts exitSolReads holds which one may be) */
  lister?: SolanaRpc;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
};

export type ExitSolScan = { notes: SolanaRestoredNote[]; spends: SolanaRestoredSpend[]; cluster: ExitSolCluster; program: string; pool: string };

/**
 * Every note of the 12 words in the release's pool on `cluster`, at the release's RESTORE_GAP. Throws ExitSolRefused
 * before any read for an unknown cluster, RPCs not the release's or a lister of the second RPC's operator; the wallet's
 * restore stops on two RPCs that differ by a byte, a listed mark not on both, or pages that do not count the marks.
 */
export async function exitSolScan(a: ExitSolScanArgs): Promise<ExitSolScan> {
  if (Object.hasOwn(a, "gap")) throw new ExitSolRefused("the exit scan reads the release's RESTORE_GAP and takes no gap");
  return solScanAtGap(a, RESTORE_GAP);
}

/** Tests only: exitSolScan at a gap of the test's. The exit tool calls exitSolScan. */
export async function solScanAtGap(a: ExitSolScanArgs, gap: number): Promise<ExitSolScan> {
  const { program, rpcs, lister } = exitSolReads(a.cluster, { ...(a.rpcs ? { rpcs: a.rpcs } : {}), ...(a.lister ? { lister: a.lister } : {}), ...(a.fetchFn ? { fetchFn: a.fetchFn } : {}) });
  const r = await withSeed64(a.words, (seed64) => solanaRestoreNotes({ seed64, program, rpcs, lister, gap, ...(a.signal ? { signal: a.signal } : {}) }));
  return { ...r, cluster: a.cluster, program, pool: solanaPoolOf(program).pool };
}
