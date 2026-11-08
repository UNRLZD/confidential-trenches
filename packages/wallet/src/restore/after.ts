// Restore step 7's two steps that look for money after a height (card wallet-restore-id-reader; docs/plan1/wallet.md
// §2.3 "Restore" step 7 l.327-342, block time from the chain l.346-348; review R1, delta review 5):
//
// - rereadOnOpen: on each open, the ids afterRestore (./wallets.ts) listed are read again, for REREAD_MS of block time
//   past the restore's pass block.
// - secondScan: steps 3 and 5 once more, once secondScanDue (./arms.ts) says both of its bounds are past.
//
// Each step owns its reads. It takes the network, the two providers and the restore's own pass (one openRestorePass
// opened, on these very provider objects), and nothing else that names a block or a time. Inside, it:
// - reads both providers' final blocks for `now` (`block`, never the device clock);
// - reads the restore block's time by its height (both headers must name the pass's hash), and for the second scan the
//   time of its bound block (secondScanBoundHeight);
// - checks due;
// - opens its own pass above its height (openRestorePass `after`), builds its readers on it, reads, and returns only
//   what it read. No reader leaves.
//
// A provider lying about time can only delay: due needs both finals past the bound (secondScanDue), the bound's time is
// the later of the two, a missing bound block is replaced by the next one up, and the re-reads stop only once both
// finals are past REREAD_MS.
//
// Step 4 of the second scan (the wallets' history) waits on a HistoryReader, which a later card builds (its contract is
// on the type, ./wallets.ts). Until then the R reads are those of the restore's own wallets (`wallets`).
import { vaultScopeOf, VAULT_SYNC_LAG_MAX, type VaultSyncRpc } from "@blindfill/kit";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../deposit/account.ts";
import { restoreNotes, type NoteRestore, type RestoreArgs } from "../notes/restore.ts";
import { blockTimeMsOf } from "../withdraw/request.ts";
import { restoreArmAccounts, secondScanBoundHeight, secondScanDue, type ArmRestore, type FinalPair } from "./arms.ts";
import { isRestorePass, nearBalanceReader, nearIdReader, openRestorePass, type IdReaderOpts, type PassOpts, type RestorePass } from "./id-reader.ts";
import { REREAD_MS, restoreDepositIds, type AfterRestore, type DepositIds, type IdState, type WalletRestore } from "./wallets.ts";

/** A NEAR provider for views (`query`) and block headers (`block`), named by its exact URL (../withdraw/relay.ts relayRpc). */
export type AfterRpc = NearRpc &
  VaultSyncRpc & { block(params: { block_id: number } | { finality: "final" }, signal?: AbortSignal): Promise<unknown> };
/** The reads' options (tests): retries, waits and the provider read first. Never a block, a height or a time. */
export type AfterOpts = Omit<PassOpts, "after"> & Pick<IdReaderOpts, "first" | "indexer">;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const why = (e: unknown): string => (e instanceof Error ? e.message : "the read failed").slice(0, 200);
const NO_BLOCK = Symbol("no block");

// one provider's block header: its height, hash and time (ms); NO_BLOCK when a height has no block (NEAR skips heights)
async function headerOf(r: AfterRpc, params: { block_id: number } | { finality: "final" }, what: string): Promise<{ h: number; hash: string; ms: number } | typeof NO_BLOCK> {
  const a = await r.block(params);
  if (!isObj(a)) throw new Error(`${r.name}: ${what}: not a JSON-RPC answer`);
  if (a.error !== undefined) {
    const cause = isObj(a.error) && isObj(a.error.cause) ? a.error.cause.name : undefined;
    if ("block_id" in params && cause === "UNKNOWN_BLOCK") return NO_BLOCK;
    throw new Error(`${r.name}: ${what}: ${String(isObj(a.error) ? (a.error.name ?? a.error.message) : "an error")}`.slice(0, 200));
  }
  const h = isObj(a.result) && isObj(a.result.header) ? a.result.header : undefined;
  if (!h || !Number.isSafeInteger(h.height) || (h.height as number) <= 0 || typeof h.hash !== "string" || typeof h.timestamp_nanosec !== "string")
    throw new Error(`${r.name}: ${what}: not a block header`);
  if ("block_id" in params && h.height !== params.block_id) throw new Error(`${r.name}: ${what}: answered block ${String(h.height)}, not ${params.block_id}`);
  return { h: h.height as number, hash: h.hash, ms: blockTimeMsOf(h.timestamp_nanosec) };
}

// both providers' final blocks, now
async function finalsNow(rpcs: readonly [AfterRpc, AfterRpc]): Promise<FinalPair> {
  const x = await Promise.all(rpcs.map((r) => headerOf(r, { finality: "final" }, "the final block")));
  const [a, b] = x as { h: number; ms: number }[];
  return { heights: [a!.h, b!.h], timesMs: [a!.ms, b!.ms] };
}

// the restore pass block's time: both headers at its height name its hash, and agree on the time
async function restoreTimeMs(rpcs: readonly [AfterRpc, AfterRpc], pass: RestorePass): Promise<number> {
  const x = await Promise.all(rpcs.map((r) => headerOf(r, { block_id: pass.h }, "the restore's block")));
  for (const [k, y] of x.entries()) if (y === NO_BLOCK || y.hash !== pass.hash) throw new Error(`${rpcs[k]!.name}: the restore's block ${pass.h} is not the pass's ${pass.hash}`);
  const [a, b] = x as { ms: number }[];
  if (a!.ms !== b!.ms) throw new Error(`the RPCs' times of the restore's block ${pass.h} differ`);
  return a!.ms;
}

// each provider's time of the bound block, or of the first block above it when its height was skipped (later: safe)
async function boundTimesMs(rpcs: readonly [AfterRpc, AfterRpc], height: number): Promise<[number, number]> {
  const one = async (r: AfterRpc): Promise<number> => {
    for (let k = height; k <= height + VAULT_SYNC_LAG_MAX; k++) {
      const y = await headerOf(r, { block_id: k }, "the bound block");
      if (y !== NO_BLOCK) return y.ms;
    }
    throw new Error(`${r.name}: no block from ${height} to ${height + VAULT_SYNC_LAG_MAX}`);
  };
  return (await Promise.all(rpcs.map(one))) as [number, number];
}

const passOpts = (o: AfterOpts, after: number): PassOpts => ({ ...pick(o), ...(o.passTries === undefined ? {} : { passTries: o.passTries }), ...(o.passWaitMs === undefined ? {} : { passWaitMs: o.passWaitMs }), after });
const pick = (o: AfterOpts): Omit<IdReaderOpts, "indexer" | "first"> => ({
  ...(o.tries === undefined ? {} : { tries: o.tries }),
  ...(o.backoffMs === undefined ? {} : { backoffMs: o.backoffMs }),
  ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
});
const readerOpts = (o: AfterOpts): IdReaderOpts => ({ ...pick(o), ...(o.first === undefined ? {} : { first: o.first }), ...(o.indexer === undefined ? {} : { indexer: o.indexer }) });

function ownPass(restored: unknown, network: NearNetwork, rpcs: readonly [AfterRpc, AfterRpc]): asserts restored is RestorePass {
  if (!isRestorePass(restored, { network, rpcs })) throw new Error("restored: the pass is not one openRestorePass opened on these RPCs");
}

/** One re-read: the id's state, or the read's error (the id stays to be read on the next open). */
export type Reread = { lane: number; i: number; id: string } & ({ state: IdState } | { error: string });
export type RereadResult = { due: false } | { due: true; ids: Reread[] };

/**
 * Step 7, on each open: the ids `plan` lists (afterRestore, made on `restored`) read again on a pass of this step's own,
 * above the restore's block, while either provider's final block time is within REREAD_MS of the restore block's.
 */
export async function rereadOnOpen(a: { network: NearNetwork; rpcs: readonly [AfterRpc, AfterRpc]; restored: RestorePass; plan: AfterRestore; opts?: AfterOpts }): Promise<RereadResult> {
  const { network, rpcs, restored, plan } = a;
  const o = a.opts ?? {};
  ownPass(restored, network, rpcs);
  if (plan?.after !== restored.h) throw new Error("plan: not the restore's (its block is not the pass's)");
  const [restoreMs, now] = await Promise.all([restoreTimeMs(rpcs, restored), finalsNow(rpcs)]);
  if (Math.min(...now.timesMs) >= restoreMs + REREAD_MS) return { due: false };
  const pass = await openRestorePass(network, rpcs, passOpts(o, restored.h));
  const read = await nearIdReader(network, rpcs, pass, readerOpts(o));
  const ids: Reread[] = [];
  for (const x of plan.rereads) {
    try {
      ids.push({ lane: x.lane, i: x.i, id: x.id, state: await read(x.id) });
    } catch (e) {
      ids.push({ lane: x.lane, i: x.i, id: x.id, error: why(e) });
    }
  }
  return { due: true, ids };
}

export type SecondScanResult = { due: false } | { due: true; notes: NoteRestore; ids: DepositIds; arms: ArmRestore };

/**
 * Step 7, the second scan: once secondScanDue holds on this step's own reads (the restore block's time, both finals
 * now, the bound block's times), step 3 reads the vault at or past the bound block (restoreNotes `atLeast`), and step 5
 * reads the deposit ids and the arm ids on a pass of this step's own above the bound block. The network's own vault and
 * token; `wallets` is the restore's step 4 (see the file's head).
 */
export async function secondScan(
  a: {
    seed64: Uint8Array;
    network: NearNetwork;
    rpcs: readonly [AfterRpc, AfterRpc];
    restored: RestorePass;
    wallets: Pick<WalletRestore, "wallets" | "unread">;
    opts?: AfterOpts & { margin?: number; pick?: (n: number) => number };
  } & Pick<RestoreArgs, "gap" | "reach" | "walk" | "signal">,
): Promise<SecondScanResult> {
  const { network, rpcs, restored } = a;
  const o = a.opts ?? {};
  ownPass(restored, network, rpcs);
  const restoreMs = await restoreTimeMs(rpcs, restored);
  const at: FinalPair = { heights: [restored.h, restored.h], timesMs: [restoreMs, restoreMs] };
  const now = await finalsNow(rpcs);
  const bound = secondScanBoundHeight(at);
  const boundMs = now.heights.every((h) => h >= bound) ? await boundTimesMs(rpcs, bound) : null;
  if (!secondScanDue(at, now, boundMs)) return { due: false };
  const { vault, usdc: token } = NEAR_NETWORKS[network];
  const notes = await restoreNotes({
    seed64: a.seed64,
    vault,
    token,
    rpcs,
    atLeast: bound,
    ...(a.gap === undefined ? {} : { gap: a.gap }),
    ...(a.reach === undefined ? {} : { reach: a.reach }),
    ...(a.walk === undefined ? {} : { walk: a.walk }),
    ...(a.signal === undefined ? {} : { signal: a.signal }),
  });
  const pass = await openRestorePass(network, rpcs, passOpts(o, bound));
  const scope = vaultScopeOf(keccak_256, vault, token);
  const ids = await restoreDepositIds(a.seed64, scope, notes, await nearIdReader(network, rpcs, pass, readerOpts(o)), o.margin === undefined ? {} : { margin: o.margin });
  const arms = await restoreArmAccounts(a.seed64, notes, a.wallets, await nearBalanceReader(network, rpcs, pass, { ...pick(o), ...(o.first === undefined ? {} : { first: o.first }) }), o.pick === undefined ? {} : { pick: o.pick });
  return { due: true, notes, ids, arms };
}
