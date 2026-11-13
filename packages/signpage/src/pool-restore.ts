// The restore kind on SIGN_HOST (card pool-restore-wired): the 12 words on a new browser bring back every pool note and
// so every fresh wallet W (each W is derived from its note, ../../wallet/src/pool/buy-wallets.ts spentNotesOf).
// - The app asks `restore` (apps/terminal/src/screens/signin/source.tsx, kit schema.ts restore: {} in, {stage:
//   "started"} out). The answer is "started" at once; the run's stages go to its op record under the request's id
//   (kind "restore", src/state.ts's op contract: no secret in it) and, for a request, as its progress events: "reading"
//   at the start and again every RESTORE_BEAT_MS while it reads (the kit's client gives restore no timeout and the app
//   shows it stalled when progress stops: packages/kit/src/signpage/client.ts restore, at least every 10 s), then
//   "done" once every pinned pool's walk is read and its notes written, or "stalled" when any pool's walk failed or a
//   walked pool's ids or U_X are ones this build cannot read (POOL_UX_UNREAD_TESTNET, POOL_CHAIN_UNREAD: known before
//   step 5 starts, so never done first) (the app's Retry asks a new restore; a run again writes only what is missing). That is the whole wait the user sees
//   (card restore-first-sign-in-under-two-minutes): step 5 below reads on after it, in the same run, and a request that
//   comes while it does (a Retry, Sync) is told the walk's end at once.
// - A sign-in with the words (or a passkey that opens an existing account) on a note store with no note runs it once
//   with no tap (src/main.ts), under an op id of its own, so the app's sign-in sheet shows it (S19).
// - It runs on every pool the page's network pins (pagePools): the Solana pool through the wallet's solanaRestoreNotes
//   on the page's Solana pair, each EVM pool through evmRestoreNotes on its pool list, notes only (wallets: false: no W
//   is named to any provider, since the page keeps no W record; each Solana W's buy record comes back after the notes
//   are written, in the background, outside the restore's wait: src/sol-buy-records.ts, run by the notes' write). A pin
//   with no reads on this page (an EVM pin on mainnet, which has no EVM pool list yet) is a failed pool, never skipped:
//   the run ends stalled, so "done" always
//   means every pinned pool was read.
// - The NEAR vault of the page's network is walked with them (card signpage-restores-near-vault-notes: pagePools' vault
//   entry, nearVaultRestoreNotes at the end of this file, the exit tool's walk with the seed opened per use): its notes
//   are written and its deposit counter raised with the pools', a failed or lying read names the run stalled and writes
//   none of its notes. Step 5 reads no vault deposit id.
// - What they find goes to the note store through the wallet's writeRestored (parents first; a note the store holds in
//   flight is left as it is; an index this page planned that the walk finds landed is landed, E5), each pool's notes as
//   soon as its walk ends, the walks one at a time on the page's thread (card closed-positions-after-a-restore: three
//   pools' walks sharing the thread held every pool's balance until the last one ended). A pool that fails leaves the
//   others' notes written. Before the write each walked scope's deposit counter
//   goes past the walk's highest note in this store's lane plus two of the lane (step 7's, wallet.md l.319-322, on the
//   notes alone), so the naming the write sets off (src/main.ts notesMoved) names past them.
// - Then restore step 5 (card wallet-restore-id-reader-wired; docs/plan1/wallet.md §2.3 "Restore" step 5): each pool
//   walked has its deposit ids U_{s,i} read under its own scope s, in every lane up to the lane's highest with a note,
//   a trace or money, plus DEPOSIT_ID_MARGIN more (../../wallet/src/restore/wallets.ts restoreDepositIds), each lane held
//   to its walk's end (../../wallet/src/notes/restore.ts walkEnd at RESTORE_GAP, the pools' walk). A pool deposit's
//   refund lands under U_{s,i}'s id inside intents.near, so an id can hold money, or show it was used, where no note
//   does. Each id is read by the wallet's IdReader (../../wallet/src/restore/id-reader.ts nearIdReader) on the
//   release's pair on the network 1Click pays out on (pageIdReads: FastNEAR and dRPC on mainnet), every view at one
//   block agreed on both (openRestorePass, one pass for the whole run), the stronger answer of the two taken.
//   - A Retry reads on where the last run stopped (card wallet-id-reader-paced): the page keeps the pass and every id's
//     answer at it (keptIdReader, IdReadKeep), reused while the pass is fresh, so an id answered once is not asked
//     again; a stale pass opens a new one with nothing kept, and a sign out drops them all. The run's signal goes to
//     every view and every wait of the reader, so a sign out stops a provider's busy wait at once.
//   - The walk's notes are the floor: they are written before any id is read, whatever the ids then show.
//   - Step 5 takes minutes on mainnet (8 lanes x 21 ids of an empty scope, 3 views an id on each provider at FastNEAR's
//     0.39 a second: about 7.7 s an id, 21.5 minutes), so it runs after the walk's end and holds no lock a money kind
//     takes: the user deposits, buys, sells and withdraws on the notes the walk wrote meanwhile. RESTORE_LOCK is held
//     for the walk and its floor only; step 5 runs under RESTORE_IDS_LOCK, one tab's at a time, and a tab that finds
//     it held reads no id beside it (review P2-4 of 53f5e92f: a second tab's restore or Sync waited out step 5).
//   - Each scope's lanes are read from this store's own lane first; once that lane is read its counter goes past the
//     lane's highest with any history plus two of the lane (step 7's again; a counter only goes up). No deposit waits
//     for it. The residual, in plain words: the raise moves only an index planned after it. The index the page plans
//     and names at the sign-in (src/deposit-name.ts, before step 5 reads the lane) stays the one every quote names
//     until money reaches it, even when step 5 reads its id as used (review P3-1 of 53f5e92f, its probe zz1). So a
//     restored account whose lost store left a quote on that index names that same one-time id again, 1Click sees one
//     id quoted twice, and if both quotes are funded the two outside sends share it. Never a loss: the second deposit
//     on the precommitment goes in as the id's next note (src/pool-deposit.ts, taken).
//   - Each try's reasons are of two kinds (Step5Reasons). A read that did not answer (`retry`: an id unread on both
//     providers or read apart by them, the lane reading on past it; a pass the providers refuse; any read that throws)
//     writes nothing the user sees on the tries before the last: step 5 is asked again by itself after
//     STEP5_PAUSES_MS, five tries in all, and what the last still leaves unread is told as a finding (review P2-2 of
//     53f5e92f: never silent for good). A finding about the user's money (`named`) leaves the newest restore op
//     stalled at the end of each try that has one (a new stalled op when the newest is not), so the app's sheet shows
//     it with Retry (S19.5), and every request that joins the run after it is told stalled (review P2-1). Both go to
//     the host's `step5`.
//   - Step 5 is owed by a marker (RESTORE_IDS_KEY: the pinned pools' scopes) from the walk's end until a try reads
//     every id and finds nothing; a signed-in load that finds it runs the restore again in the background, no op
//     written (resume).
//   - The testnet build reads no deposit id: it makes no 1Click quote (src/pool-deposit-address.ts), so no id of its
//     pools can hold a trace on NEAR.
//   - A pool deposit's money can also wait at its one-time account U_X on the pool's own chain (1Click's delivery there,
//     or a refund carry moved back there; card wallet-restore-reads-ux). On a chain whose pool follow has reads on this
//     page (the host's `ux`, restoreUxOf: the follow's own reader on two public operators, never our helper relay, and
//     the follow's own deposit; today Solana's on mainnet), step 5 reads each id's U_X (uxOf: on Solana the base58 of
//     the id's own 32 bytes, on Base and Robinhood U^evm_{s,i}) beside the id's NEAR read, at finalized on both, one U_X
//     per request, paced per provider, so no request names two of the user's wallets and the reads spread over the
//     minutes step 5 takes: both must give the same balance, else the id is unread and the run ends stalled by name. A U_X
//     holding any balance is history (the id reads "money"), so its lane is read DEPOSIT_ID_MARGIN past it.
//     Once a scope's ids are read, each U_X that covers one deposit (the follow's floor) and whose index has a deposit
//     note in the store (the page's pool.deposit pays from U_{s,i} only on one; a U_X with none on this device, as a
//     delivery the lost store's quote named, is named with its balance and the run ends stalled) is carried into the
//     pool as the follow carries it (askOf's largest ask, the page's pool.deposit from that U_{s,i}), read again after each deposit
//     and carried on while it still covers one; a carry that does not fill, or a balance a filled deposit did not lower,
//     ends the run stalled with the U_X named. Less than one deposit's floor (the rent a carried U_X keeps) is left, as
//     the follow leaves it. A pool on a chain with no U_X reads here (Base and Robinhood until the EVM follow's reads
//     land) is never "done" (POOL_CHAIN_UNREAD): the run ends stalled by name, so no run says done while a U_X is unread.
//     The testnet build reads no deposit id nor any U_X (devnet has no two public operators), so a run there that walked
//     a pool ends stalled by name (POOL_UX_UNREAD_TESTNET), never done.
//   - Each id NEAR reads as money (a refund 1Click left under U_{s,i} inside intents.near, or the token) is read again by
//     asset on both NEAR providers at the same block (the wallet's nearIdHeldReader): an asset above the base unit a move
//     out keeps (ID_KEEP, the way out's own), or one the two read apart, is named and the run ends stalled; only the kept
//     unit is a moved-out id. No restore carries that money yet (card restore-carries-pool-refund).
//   - Every deposit note the walk gave for a pool is of that pool's scope; one of another scope is a drift that stalls
//     the run by name, and that pool's ids are not read on it.
//   - Each reason a run ends stalled is named (the host's `ended`, told once however the run ends: an abort and a throw
//     included); the op record holds the kit's stage only.
// - No request names a note: each restore reads its pool's whole public set and finds the seed's own notes on the
//   device (solana-restore.ts, evm-restore.ts headers). The seed is opened only for one use at a time (a SeedUse,
//   ../../wallet/src/notes/restore.ts): under the store's seed lock, shared, after a check that it is still stored and
//   still this run's own (an in-memory HMAC of it under a key drawn for the run, taken at its first use: words signed
//   in by another tab between two uses stop the run), for one walk's match or one window of a lane's deposit ids (at
//   most DEPOSIT_ID_MARGIN of them), and zeroed when that use ends; no read and no wait holds
//   the lock (review P2-2: held for the whole run, it made a queued seed write, and every pool.buy, sell, deposit and
//   follow behind it, wait for step 5). The floor's write runs under the same lock and check, so a sign out in another
//   tab is never written over; this tab's sign out aborts the run, checked before every id.
// - One run at a time on the page: a request while one runs is answered "started" and follows that run. Across tabs,
//   runs take RESTORE_LOCK in turn, so two tabs' writes never race on one note.
// - A run's op records stay "started" or "reading" only while it lives: each follower holds RESTORE_LOCK/<op id> for
//   the run's life, and settle() (each signed-in load, src/main.ts landed) writes "stalled" on any record still
//   running whose lock no tab holds (its page was closed or reloaded mid-run), so the app offers Retry, never a scan
//   that never ends.
// - "Empty" for the run with no tap: no note but PLANNED ones (a deposit index this page named ahead, src/deposit-name.ts,
//   holds no money until it lands).
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import type { PoolChain, RestoreStage } from "../../kit/src/signpage/messages.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { NEAR_NETWORKS, type NearRpc } from "../../wallet/src/deposit/account.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { POOL_DEPOSIT_NETWORK } from "../../wallet/src/deposit/quote.ts";
import { readConfig, RESTORE_GAP, RESTORE_LANES, restorePagesSteps, slices, walkEnd, withSeed, writeRestored, type LaneWalk, type PagesRestored, type RestoredNote, type SeedUse } from "../../wallet/src/notes/restore.ts";
import { walkLanes, type WalkPort } from "../../wallet/src/restore/walk.ts";
import { masters } from "../../wallet/src/derive/notes.ts";
import { vaultSync, vaultSyncStart, type VaultSyncRpc } from "../../kit/src/vault/sync.ts";
import { nearPairNetwork, nearPairRule, type NearNetwork } from "../../kit/src/near/networks.ts";
import { pacedNearRpc } from "../../wallet/src/pace.ts";
import { PAGE_NETWORK } from "./withdraw/handoff.ts";
import { vaultScope } from "./withdraw/checks.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { evmRestoreNotes } from "../../wallet/src/pool/evm-restore.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPair, evmPoolScopeOf, type EvmNetwork, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { restoreEvmHoldings, type EvmBuySpend } from "./pool-sell-evm.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { solanaRestoreNotes, type SolanaPoolCache } from "../../wallet/src/pool/solana-restore.ts";
import { idReadKeep, keptIdReader, nearIdHeldReader, type IdHeld, type IdReaderOpts, type IdReadKeep, type PassOpts } from "../../wallet/src/restore/id-reader.ts";
import { ID_KEEP } from "../../wallet/src/deposit/moveout.ts";
import { coverTo, restoreDepositIds, type DepositIds, type IdReader, type LaneIds } from "../../wallet/src/restore/wallets.ts";
import { relayRpc } from "../../wallet/src/withdraw/relay.ts";
import { base58, hex } from "@scure/base";
import type { Deferred, KindContext } from "./api.ts";
import { askOf, evmPoolFollowDeps, solanaPoolFollowDeps, type PoolUx, type PoolUxReads } from "./pool-deposit-follow.ts";
import { pageRpc } from "./page-rpc.ts";
import { solanaPacedRpc } from "../../kit/src/trade/solana/send.ts";
import { PAGE_SOL_CACHE, PAGE_SOL_MARK_BATCHES, PAGE_SOL_PIN, pageEvmHistory, pageEvmHold, pageEvmPoolRpcs, pageSolanaLister, pageSolanaSettleRpcs } from "./pool-testnet.ts";

/** The Web Lock a run holds (each tab's runs in turn); RESTORE_LOCK/<op id>: one follower's op, held while it runs. */
export const RESTORE_LOCK = "ct-pool/restore";
/** Step 5's own lock (one tab's step 5 at a time), apart from RESTORE_LOCK: never `${RESTORE_LOCK}/<op id>`, a follower's. */
export const RESTORE_IDS_LOCK = "ct-pool/restore-ids";

/** The gap between two "reading" progress events: within the 10 s the kit's client names. */
export const RESTORE_BEAT_MS = 5_000;

/** One pinned pool to restore, with its scope (its deposit ids') and its reads (null when this page has none for it: the
 *  run ends stalled); a Solana pool's `lister` names its marks for the pair to read (the pair's first RPC when none), and
 *  its `cache` holds the marks and pages the page's settles already read on that pair (pool-testnet.ts PAGE_SOL_CACHE). */
export type RestorePool =
  | { chain: "near"; network: NearNetwork; scope: bigint; rpcs: (() => readonly [VaultSyncRpc, VaultSyncRpc]) | null }
  | { chain: "solana"; program: string; scope: bigint; rpcs: (() => readonly [SolanaRpc, SolanaRpc]) | null; lister?: () => SolanaRpc | undefined; cache?: SolanaPoolCache; markBatches?: readonly [number, number] }
  | { chain: "evm"; pin: EvmPoolPin; scope: bigint; rpcs: (() => readonly EvmRpc[]) | null };

/** Step 5's reads: the NEAR pair, the readers' options and each scope's answer (tests only, both). */
export type IdReads = {
  rpcs: () => readonly [NearRpc, NearRpc];
  opts?: Omit<PassOpts, "after"> & IdReaderOpts;
  read?: (scope: bigint, ids: DepositIds) => void;
};

/**
 * Where this build reads the deposit ids: the release pair (one FastNEAR URL and dRPC, ../../kit's NEAR_NETWORKS) on
 * POOL_DEPOSIT_NETWORK, the network 1Click pays a pool deposit out and refunds it on, each provider reading block headers
 * too (relayRpc), so the pass keeps its block's time. null on the testnet build, which quotes no deposit.
 */
export function pageIdReads(): IdReads | null {
  if (POOL_TESTNET) return null;
  const net = NEAR_NETWORKS[POOL_DEPOSIT_NETWORK];
  return { rpcs: () => [relayRpc(net.fastnear[0]), relayRpc(net.drpc)] };
}

/**
 * Why a pool scope's step 5 is not done on a chain whose U_X this page does not read (card wallet-restore-reads-ux: every
 * chain but Solana): its deposits' one-time accounts U_X on the pool's own chain are not read, so money 1Click delivered
 * there, or a refund carry moved back there, is not seen.
 */
export const POOL_CHAIN_UNREAD = "the pool's own chain is not read for a deposit's money (each id's U_X there), so the restore is not done";

/**
 * Why the testnet build's restore is never done once it walked a pool (review P3 of card wallet-restore-reads-ux): its
 * pool.address answers a devnet pool's same-chain U_X with no quote (src/pool-deposit-address.ts, the `!quoted` answer
 * comes before the network check), so a devnet send can wait there, and this build reads no deposit id nor any U_X:
 * devnet has no two public operators to read it on (9 Nov 04:55Z: api.devnet.solana.com 200; PublicNode's and Pocket's
 * devnet hosts 404; the page's other devnet RPC is our helper's relay), so it never says done before it has looked.
 */
export const POOL_UX_UNREAD_TESTNET = "this build reads no deposit id nor its one-time wallet on the pool's own chain (devnet has no two public operators for it), so the restore is not done";

/** Which of a try's lists a reason goes on (Step5Reasons). */
export type ReasonKind = "retry" | "held" | "named";
/** An unread id whose U_X holds a balance its pool chain's two RPCs read apart: money is there, its amount unread. */
const UX_APART = /^its U_X reads \d+ and \d+ on the pool chain's two RPCs$/;

/**
 * Why step 5 on one scope is not done (empty: every id read and every lane at its margin), each reason named, with the
 * list it goes on: a lane stopped past its note walk's end is a finding (`named`); its ids unread are a read to try
 * again (`retry`), those whose U_X held a balance read apart on its two RPCs apart (`held`: money is there).
 */
export function idsUndoneOf(r: DepositIds): { why: string; kind: ReasonKind }[] {
  const out: { why: string; kind: ReasonKind }[] = [];
  const unread = (lane: number, xs: DepositIds["lanes"][number]["unread"], kind: ReasonKind): void =>
    void (xs.length > 0 && out.push({ why: `lane ${lane}: ${xs.length} id${xs.length === 1 ? "" : "s"} unread (${xs[0]!.error})`, kind }));
  for (const x of r.lanes) {
    if (x.reach !== null) out.push({ why: `lane ${x.lane} stopped at ${x.reach}, past the note walk's end: restore again from there`, kind: "named" });
    unread(x.lane, x.unread.filter((u) => UX_APART.test(u.error)), "held");
    unread(x.lane, x.unread.filter((u) => !UX_APART.test(u.error)), "retry");
  }
  if (!r.complete && out.length === 0) out.push({ why: "the ids' read is unfinished", kind: "retry" });
  return out;
}
/** idsUndoneOf's reasons alone. */
export function idsUndone(r: DepositIds): string[] {
  return idsUndoneOf(r).map((x) => x.why);
}

/**
 * Each lane's highest deposit note of `scope` and its walk's end, as the pools' walk read it (walkLane at RESTORE_GAP
 * from the lane's first index, no reach: ../../wallet/src/pool/solana-restore.ts, evm-restore.ts).
 */
export function lanesOf(notes: readonly RestoredNote[], scope: bigint): { laneHighest: (number | null)[]; laneWalked: number[] } {
  const laneHighest: (number | null)[] = Array<number | null>(RESTORE_LANES).fill(null);
  for (const n of notes) if (n.ref.kind === "deposit" && n.ref.s === scope) laneHighest[n.ref.i % RESTORE_LANES] = Math.max(laneHighest[n.ref.i % RESTORE_LANES] ?? n.ref.i, n.ref.i);
  return { laneHighest, laneWalked: laneHighest.map((h, lane) => walkEnd(lane, h === null ? [] : [h], RESTORE_GAP)) };
}

/**
 * Each reason one try of step 5 is not done, as found, on one of three lists (so a throw keeps the reasons before it):
 * - `retry`: a read that did not answer (an id unread on both providers, a pass refused, any throw), asked again by
 *   itself; on the page's last try it is told as a finding, and the marker stays;
 * - `held`: a read about money that is there (a U_X or an id holding something, its amount unread or read apart on the
 *   two RPCs), asked again the same way; past the page's tries it is a finding, so money on a one-time id is never left
 *   with nothing on screen;
 * - `named`: a finding a read again does not change (a U_X or an id holding what no restore carries, a carry that did
 *   not fill, a scope drift, a chain whose U_X this page cannot read, a lane past its walk's end), which the run tells
 *   the user of: one stalled op, the sheet's Retry (S19.5).
 * Never all empty while a pool scope's U_X is unread (POOL_CHAIN_UNREAD, named).
 */
export type Step5Reasons = { retry: string[]; held: string[]; named: string[] };

/**
 * One try of step 5 on every pool walked, in order, on one pass and one IdReader, each reason it is not done pushed to
 * `out`. The first id unread on both providers stops every read after it (each throws at once, so its lane ends with
 * restoreDepositIds's error); a sign out stops them the same way, checked before each id (the id in flight then ends
 * its lane, and the run's end checks it again). `seed` opens the seed for each window of a lane's ids only. Each scope's
 * lanes are read from `own.lane` (this store's) first, and once that lane is read to its margin its deposit counter is
 * raised past the lane's highest with any history (`own.raise`, step 7's, wallet.md l.319-322; only up).
 */
async function readDepositIds(
  seed: SeedUse,
  walked: readonly Walked[],
  ids: IdReads,
  keep: IdReadKeep,
  signal: AbortSignal,
  out: Step5Reasons,
  noted: (scope: bigint) => Promise<ReadonlySet<number>>,
  own: { lane: number; raise(scope: bigint, min: number): Promise<void> },
  kept: { of(scope: bigint, laneHighest: readonly (number | null)[]): Promise<ReadonlyMap<number, number>>; add(scope: bigint, lane: number, readTo: number, highest: number | null): Promise<void> },
): Promise<void> {
  const { rpcs, pass, reader } = await letGo(keptIdReader(POOL_DEPOSIT_NETWORK, ids.rpcs, keep, { ...ids.opts, signal }), signal);
  // what an id read as money holds, by asset on both providers at the same pass, opened now beside the id reader on the
  // pass it reads at (the kept one while fresh, else the one just opened): nearIdHeldReader refuses a pass
  // VAULT_SYNC_LAG_MAX blocks old, and step 5 takes minutes
  const held = await letGo(nearIdHeldReader(POOL_DEPOSIT_NETWORK, rpcs, pass, { ...ids.opts, signal }), signal);
  const heldOf: typeof held = (id) => letGo(held(id), signal);
  // each id on the run's signal; an id unread leaves the ids after it read (review P2-2 of 53f5e92f): the lane names
  // it unread and reads on, as restoreDepositIds does past any unread id
  const holds: IdReader = async (u, i) => {
    signal.throwIfAborted();
    return letGo(reader(u, i), signal);
  };
  const undone = (label: string, r: DepositIds): void => {
    for (const y of idsUndoneOf(r)) out[y.kind].push(`${label}: ${y.why}`);
  };
  // this store's lane first; once read whole (no lane stopped past its walk's end) its counter goes past its highest
  // a lane read whole with nothing to tell (no reach, nothing unread, no id holding money: no finding can come of it)
  // is kept on the marker, so the next run reads only the others (review P2-3 of 53f5e92f)
  const lanes = async (scope: bigint, notes: readonly RestoredNote[]) => {
    const { laneHighest } = lanesOf(notes, scope);
    return {
      first: own.lane,
      signal,
      done: await kept.of(scope, laneHighest),
      laneRead: async (x: LaneIds) => {
        if (x.lane === own.lane && x.reach === null) await own.raise(scope, coverTo(x));
        if (x.reach === null && x.unread.length === 0 && x.money.length === 0) await kept.add(scope, x.lane, x.readTo, laneHighest[x.lane] ?? null);
      },
    };
  };
  for (const w of walked) {
    // the walk's deposit notes are all of its pool's scope: one of another is a drift, never read on
    const drift = w.notes.filter((n) => n.ref.kind === "deposit" && n.ref.s !== w.scope);
    if (drift.length > 0) {
      out.named.push(`${w.label}: ${drift.length} deposit note${drift.length === 1 ? "" : "s"} of scope ${String((drift[0]!.ref as { s: bigint }).s)} in the walk of scope ${w.scope}; its ids are not read`);
      continue;
    }
    // a chain this build gives no deposit address on: no id of it can hold money, nothing to read
    if (!w.addressed) continue;
    const ux = w.ux;
    if (ux === null) {
      const r = await restoreDepositIds(seed, w.scope, { notes: [...w.notes], ...lanesOf(w.notes, w.scope) }, holds, await lanes(w.scope, w.notes));
      ids.read?.(w.scope, r);
      undone(w.label, r);
      out.named.push(`${w.label}: ${POOL_CHAIN_UNREAD}`);
      continue;
    }
    // each id's U_X on the pool's own chain read beside it, on both of its RPCs; any balance there is history of the id
    const chain = w.chain;
    const held = new Map<number, PoolUx>();
    // each id NEAR reads as holding money (a refund 1Click left under U_{s,i} inside intents.near, or the token), by index
    const nearMoney = new Map<number, string>();
    // the id's NEAR read and its U_X read side by side, each paced by its own providers, so the U_X reads spread over
    // the minutes the NEAR reads take and add no wall time (card wallet-restore-reads-ux)
    const both: IdReader = async (id, i) => {
      if (i === undefined) throw new Error("no deposit index for its U_X");
      const u = await uxOf(seed, chain, w.scope, i, id);
      const [near, [a, b]] = await Promise.all([holds(id, i), ux.balances({ u })]);
      if (near === "money") nearMoney.set(i, id);
      if (a !== b) throw new Error(`its U_X reads ${String(a)} and ${String(b)} on the pool chain's two RPCs`);
      if (a === 0n) return near;
      held.set(i, { chain, s: w.scope.toString(), i, u, refund_id: id });
      return "money";
    };
    const r = await restoreDepositIds(seed, w.scope, { notes: [...w.notes], ...lanesOf(w.notes, w.scope) }, both, await lanes(w.scope, w.notes));
    ids.read?.(w.scope, r);
    undone(w.label, r);
    // each U_X found holding a balance, in index order, carried into the pool or named. The page's pool.deposit pays
    // from U_{s,i} only on a deposit note the store holds for its index (src/pool-deposit.ts runPoolDeposit's fixed
    // source); a U_X whose index has none on this device (a delivery the lost store's quote named) is named, never
    // carried here and never done
    const has = held.size === 0 ? new Set<number>() : await noted(w.scope);
    for (const f of [...held.values()].sort((x, y) => x.i - y.i)) {
      signal.throwIfAborted();
      const c = await carryUx(ux, f, has.has(f.i), signal);
      if (c !== null) (c.retry ? out.held : out.named).push(`${w.label}: deposit index ${f.i}'s one-time wallet ${f.u} ${c.why}`);
    }
    // each id NEAR reads as holding money, in index order: what it holds above the base unit a move out keeps
    // (ID_KEEP, the way out's own) is named and the scope never done, since no restore carries it yet (card
    // restore-carries-pool-refund); only the kept unit, read alike on both providers, is a moved-out id
    for (const [i, id] of [...nearMoney].sort((x, y) => x[0] - y[0])) {
      signal.throwIfAborted();
      for (const y of await nearHeldNamed(heldOf, id)) (y.retry ? out.held : out.named).push(`${w.label}: deposit index ${i}'s id ${id} ${y.why}`);
    }
  }
}

/** The token a deposit id holds on its own on NEAR (ft_balance_of): the pool deposit network's release USDC. */
const POOL_TOKEN = NEAR_NETWORKS[POOL_DEPOSIT_NETWORK].usdc;

/**
 * Why a deposit id NEAR read as holding money keeps its scope from done (review P1 of card wallet-restore-reads-ux): each
 * asset it holds above ID_KEEP on NEAR at the pass's block, both providers agreeing, any amount of one that is not a
 * fungible token (review P3-4), or an asset the two read apart, or its holdings unread (those two a read to try again);
 * empty when it holds at most the kept unit of each asset on both.
 */
async function nearHeldNamed(heldOf: (u: string) => Promise<IdHeld[]>, id: string): Promise<{ why: string; retry: boolean }[]> {
  let assets: IdHeld[];
  try {
    assets = await heldOf(id);
  } catch (e) {
    return [{ why: `holds money on NEAR whose amount is unread (${e instanceof Error ? e.message : String(e)}): restore again to read it`, retry: true }];
  }
  const out: { why: string; retry: boolean }[] = [];
  for (const { asset, amounts: [a, b] } of assets) {
    if (a !== b) out.push({ why: `holds ${String(a)} and ${String(b)} of ${asset} on NEAR's two RPCs: read again`, retry: true });
    // the kept unit is a fungible token's (the token on its own, or a nep141 one inside intents.near): one of an NFT
    // (nep171) or a multi-token (nep245) is never moved-out dust
    else if (asset !== POOL_TOKEN && !asset.startsWith("nep141:")) out.push({ why: `holds ${String(a)} of ${asset} on NEAR, not a fungible token a move out keeps a unit of; a restore does not carry it yet, and it stays under the 12 words`, retry: false });
    else if (a > ID_KEEP) out.push({ why: `holds ${String(a)} of ${asset} on NEAR, above the ${String(ID_KEEP)} a move out keeps; a restore does not carry it yet, and it stays under the 12 words`, retry: false });
  }
  return out;
}

/**
 * U_X of deposit index `i` on the pool's chain (src/deposit-name.ts names it the same way): on Solana the base58 of
 * U_{s,i}'s 32-byte id (the same ed25519 key, no seed opened); on Base and Robinhood U^evm_{s,i}'s EIP-55 address, its
 * key derived under one use of the seed and zeroed at once.
 */
async function uxOf(seed: SeedUse, chain: PoolChain, scope: bigint, i: number, id: string): Promise<string> {
  if (chain === "solana") return base58.encode(hex.decode(id));
  return seed((s) => {
    const e = depositIdEvm(s, scope, i);
    e.secretKey.fill(0);
    return e.address;
  });
}

/**
 * One U_X carried into its pool as the follow carries it (src/pool-deposit-follow.ts followPoolQuote's round): its lower
 * balance on the two RPCs, and while it covers one deposit (the follow's floor), askOf's largest ask through the page's
 * pool.deposit, read again after each. null when what is left is under one deposit's floor; else why it is not carried
 * (`noted` false: the store holds no deposit note for its index, which pool.deposit's fixed source pays from), a read to
 * try again (`retry`) only when its two RPCs read it apart before any deposit from it.
 */
async function carryUx(ux: PoolUxReads, f: PoolUx, noted: boolean, signal: AbortSignal): Promise<{ why: string; retry: boolean } | null> {
  let before: bigint | null = null;
  for (;;) {
    const [a, b] = await ux.balances(f);
    if (a !== b) return { why: `reads ${String(a)} and ${String(b)} on the pool chain's two RPCs: read again`, retry: before === null };
    if (before !== null && a >= before) return { why: `holds ${String(a)} after a deposit from it filled: read again`, retry: false };
    if (a < ux.ladder.min) return null;
    const c = await ux.costs(f);
    if (a < c.floor) return null;
    const amount = askOf(ux.ladder, a, c.perRung, c.keep);
    if (amount === 0n) return null;
    if (!noted) return { why: `holds ${String(a)}, with no deposit note on this device for its index to carry it into the pool`, retry: false };
    signal.throwIfAborted();
    const { end } = await ux.deposit(f, amount, signal);
    if (end !== "filled" && end !== "part_filled") return { why: `holds ${String(a)}; its carry into the pool ended ${end}: restore again to carry it`, retry: false };
    before = a;
  }
}

/**
 * The restore's U_X pair on Solana (card wallet-restore-reads-ux): two public operators, never our helper relay,
 * since one restore asks for every one of a user's U_X in a row and our server is not the RPC provider wallet.md §2.3
 * step 5 lets see some ids (one per request, spread over both providers and over minutes). PublicNode and Pocket's
 * gateway, the pair Verify reads the Solana pool on (d8657094): Solana's own api.mainnet-beta.solana.com answers any
 * request with an Origin header 403 "Access forbidden" (read 2026-11-08 20:10Z from the app's origin, and 9 Nov 04:41Z
 * and 04:42Z from SIGN_HOST's), so a page cannot read it. Each on its URL's own queue at the kit's keyless limit
 * (SOLANA_KEYLESS_RPC_LIMIT, for a keyless provider that publishes none), so every page read of one operator shares one
 * budget. Mainnet only: 1Click pays a pool deposit out there alone (POOL_DEPOSIT_NETWORK), and devnet has no keyless
 * second operator (probes 9 Nov about 04:37Z: PublicNode 404, dRPC paid plan only, Helius and Ankr a key), so the
 * testnet build reads no U_X, as it reads no deposit id.
 */
export const RESTORE_UX_SOLANA = Object.freeze(["https://solana-rpc.publicnode.com", "https://solana.api.pocket.network"] as const);
export function restoreUxSolanaRpcs(): readonly [SolanaRpc, SolanaRpc] | null {
  if (POOL_TESTNET) return null;
  return [solanaPacedRpc(pageRpc(RESTORE_UX_SOLANA[0])), solanaPacedRpc(pageRpc(RESTORE_UX_SOLANA[1]))];
}

/**
 * A pool chain's U_X reads for the restore: the follow's own reader (solanaPoolFollowDeps' balances, costs and ladder)
 * on the restore's public pair (restoreUxSolanaRpcs), and the follow's own deposit (`follow`: the page's pool.deposit
 * from U_{s,i}, which reads and sends on the pool kinds' pair as a live deposit does). On Base and Robinhood (card
 * evm-deposit-on-mainnet) the EVM follow's own reader (evmPoolFollowDeps with no wallet reader: each U_X's balance on
 * both of the pool's two public RPCs, `evm`, the pool kinds' pair, each paced as Solana's pair), for Solana's reason: one restore asks for every one
 * of a user's U_X in a row, so never our helper relay; mainnet only, as Solana's (1Click pays a pool deposit out there
 * alone). null on a chain with no pair or no follow here.
 */
export function restoreUxOf(chain: PoolChain, follow: PoolUxReads | null, program: string | undefined, rpcs: (() => readonly [SolanaRpc, SolanaRpc] | null) = restoreUxSolanaRpcs, evm: (chain: "base" | "robinhood") => { pin: EvmPoolPin; rpcs: readonly [EvmRpc, EvmRpc] } | null = () => null): PoolUxReads | null {
  if (chain !== "solana") {
    const e = follow === null || POOL_TESTNET ? null : evm(chain);
    if (e === null) return null;
    // each of the pair on its own provider's queue at the kit's keyless limit, as Solana's (restoreUxSolanaRpcs): one U_X
    // a request, never a lane's ids in one burst to a provider (review P2-3)
    const r = evmPoolFollowDeps({ rpcs: [solanaPacedRpc(e.rpcs[0]), solanaPacedRpc(e.rpcs[1])], pin: e.pin, deposit: follow!.deposit });
    return { balances: r.balances, costs: r.costs, ladder: r.ladder, deposit: follow!.deposit };
  }
  if (follow === null || program === undefined) return null;
  const pair = rpcs();
  if (pair === null) return null;
  const r = solanaPoolFollowDeps({ rpcs: pair, program, deposit: follow.deposit });
  return { balances: r.balances, costs: r.costs, ladder: r.ladder, deposit: follow.deposit };
}

/** A pool walked: its label, chain, scope, notes, and its U_X reads on its own chain (null: none on this page). */
type Walked = { label: string; chain: PoolChain; scope: bigint; notes: readonly RestoredNote[]; ux: PoolUxReads | null; addressed: boolean };

/** A pinned pool's chain: Solana, or the app chain of its EVM network (Base Sepolia is Base's, as src/pools.ts names it). */
const chainOf = (p: Exclude<RestorePool, { chain: "near" }>): PoolChain => (p.chain === "solana" ? "solana" : p.pin.network === "base" || p.pin.network === "base-sepolia" ? "base" : "robinhood");

const EVM_PAGE: Readonly<Record<"base" | "robinhood", EvmNetwork>> = POOL_TESTNET ? { base: "base-sepolia", robinhood: "robinhood-testnet" } : { base: "base", robinhood: "robinhood" };

/** Every pool the page's network pins (PAGE_SOL_PIN, EVM_POOLS on the page's networks), each with the page's reads.
 *  `evmPins` is EVM_POOLS unless a test plants pins (as pools.ts's pagePoolsOf). */
export function pagePools(evmPins: Readonly<Partial<Record<EvmNetwork, EvmPoolPin>>> = EVM_POOLS): RestorePool[] {
  const out: RestorePool[] = [];
  // the NEAR vault of the page's network (NEAR_NETWORKS' vault and USDC, the scope withdraw/checks.ts computes), on the
  // release pair the withdraw reads it on (withdraw/handoff.ts: one FastNEAR URL and dRPC, at the provider's pace)
  const vault = vaultScope(PAGE_NETWORK);
  if (vault !== null) out.push({ chain: "near", network: PAGE_NETWORK, scope: vault, rpcs: () => [pacedNearRpc(NEAR_NETWORKS[PAGE_NETWORK].fastnear[0]), pacedNearRpc(NEAR_NETWORKS[PAGE_NETWORK].drpc)] });
  if (PAGE_SOL_PIN !== undefined) out.push({ chain: "solana", program: PAGE_SOL_PIN.program, scope: solanaPoolOf(PAGE_SOL_PIN.program).scope, rpcs: pageSolanaSettleRpcs, lister: pageSolanaLister, cache: PAGE_SOL_CACHE, markBatches: PAGE_SOL_MARK_BATCHES });
  for (const chain of ["base", "robinhood"] as const) {
    const pin = evmPins[EVM_PAGE[chain]];
    if (pin === undefined) continue;
    const net = pin.network;
    // the pool's scope as src/pools.ts names it (evmPoolScopeOf on the pool's lowercased address and chain id)
    const scope = evmPoolScopeOf(pin.pool.toLowerCase(), EVM_CHAIN_IDS[net]);
    // the page's pool list (pageEvmPoolRpcs, the deposit's too): the testnet pair on the testnet build, folded at build
    // time, so SIGN_HOST's bundle carries none of it; on mainnet the kit's pool list (card evm-pool-lists-mainnet). A
    // chain with no list is read by no one, and the run says so (stalled), never done
    out.push({ chain: "evm", pin, scope, rpcs: pageEvmPoolRpcs(chain) === null ? null : () => pageEvmPoolRpcs(chain)! });
  }
  return out;
}

/**
 * The pauses between step 5's tries in one page life when a try ends on a read to try again (Step5Reasons `retry`): five
 * tries, the last minutes apart. Past them the marker (RESTORE_IDS_KEY) has the next signed-in load read again.
 */
export const STEP5_PAUSES_MS: readonly number[] = Object.freeze([30_000, 120_000, 300_000, 600_000]);

/**
 * The marker that step 5 is owed (meta, under owed/, which the frame never reads or lists: ../../wallet/src/store): the
 * pinned pools' scopes, public and nothing else (no id, no index, no secret). Written once the walk's notes are written,
 * removed once a try of step 5 has read every id and found nothing, by the run that wrote it only (`run`: a tab never
 * removes the marker another tab's later walk wrote); a sign out deletes it with the store. It keeps each lane a try
 * read whole with nothing to tell (no reach, no id unread, none holding money), with the index it read to and its
 * highest note then, by scope (`read`), and a resume (a load, a landing) reads only the others while their notes are
 * unchanged (review P2-3 of 53f5e92f; delta review P2-A: a lane whose notes moved is read whole again). A run the user
 * asks for (a Sync, a Retry) writes it fresh and reads every lane; a `read` of any other shape is dropped whole. A signed-in
 * load that finds it runs the restore again in the background (resume), so a page closed during step 5 never leaves it
 * unread for good.
 */
export const RESTORE_IDS_KEY = "owed/restore-ids";
/**
 * The marker: the pools' scopes; by scope each lane read whole, with the index it read to and its highest note when it
 * was kept (null: none); and the run that wrote it, so a run keeps lanes on and removes only its own marker.
 */
type IdsOwed = { scopes: string[]; read?: Record<string, [number, number, number | null][]>; run?: string };
// a kept lane as the marker holds it: its lane, an index of the lane it read to within u32, its highest note at or below
// that (or null); any other entry drops the marker's `read` whole, so a broken marker reads more, never less (delta
// review P3-A)
const keptEntry = (x: unknown): boolean =>
  Array.isArray(x) &&
  x.length === 3 &&
  Number.isInteger(x[0]) &&
  x[0] >= 0 &&
  x[0] < RESTORE_LANES &&
  Number.isInteger(x[1]) &&
  x[1] >= 0 &&
  x[1] <= 0xffff_ffff &&
  x[1] % RESTORE_LANES === x[0] &&
  (x[2] === null || (Number.isInteger(x[2]) && x[2] >= 0 && x[2] <= x[1] && x[2] % RESTORE_LANES === x[0]));
const owedOf = (v: unknown): IdsOwed | null => {
  const o = v as IdsOwed;
  if (typeof v !== "object" || v === null || !Array.isArray(o.scopes) || !o.scopes.every((x) => typeof x === "string")) return null;
  const r = o.read as unknown;
  const read = typeof r === "object" && r !== null && !Array.isArray(r) && Object.values(r).every((xs) => Array.isArray(xs) && xs.every(keptEntry));
  return { scopes: o.scopes, ...(read ? { read: o.read } : {}), ...(typeof o.run === "string" ? { run: o.run } : {}) };
};

/**
 * One try of step 5's end: its reasons, the try's number, and whether no try follows it in this page life. On the last
 * try what was `held` is told as `named` (a finding), and `held` is empty.
 */
export type Step5End = { retry: readonly string[]; held: readonly string[]; named: readonly string[]; tries: number; last: boolean };

/** The run's seed is gone (a sign out, or other words signed in, in this tab or another): the run stops, never retried. */
export class SeedGone extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedGone";
  }
}

/** What the restore reads on, each called when a run starts. */
export type PoolRestoreHost = {
  store(): Promise<WalletStore>;
  /** The wallet store while one is open, never opening one (TestnetPage.held): the pool syncs' holds; tests without it
   *  give store(). */
  held?(): Promise<WalletStore>;
  seed64(): Promise<Uint8Array>;
  /** Whether a seed is stored: a restore asked with none is refused not_allowed, and nothing is read. */
  signedIn(): Promise<boolean>;
  /** The pools to read (pagePools unless given). */
  pools?: () => readonly RestorePool[];
  /** Web Locks (navigator.locks otherwise). */
  locks?: Pick<LockManager, "request" | "query">;
  /** After the notes are written: the page's proof queue's pass, so a restored note can pay the next buy. */
  written?: () => void;
  /** After a chain's buy records are written (any W): that chain's positions read again, so they show with no reload. */
  holdingsWritten?: (chain: "base" | "robinhood") => void;
  /** After the NEAR vault's notes are written: the page's NEAR buy records rebuilt from them (card near-holdings-restore,
   *  src/near-buy.ts nearHoldingsPass), started and never awaited, so it holds back no other pool's restore. */
  nearWalked?: () => void;
  /** Step 5's reads (pageIdReads unless given; null: no deposit id is read). */
  ids?: IdReads | null;
  /** A pool chain's U_X reads and carry (the pool follow's own, src/main.ts), or null when the page has none there: that
   *  pool's scope then ends stalled, POOL_CHAIN_UNREAD. None given: null on every chain. */
  ux?: (chain: PoolChain) => PoolUxReads | null;
  /** Whether this build gives a deposit address on a pool chain (pool.address: main.ts pageAddressPools). A chain it gives
   *  none on has no deposit id nor U_X that money could have reached, so its ids and U_X are not read and are no reason
   *  the restore is not done; its pool's notes are walked as any other's. None given: every chain. */
  addressed?: (chain: PoolChain) => boolean;
  /** The walk's end and each reason it is not done (empty when done), told once a run: the op record holds the kit's
   *  stage only. */
  ended?: (stage: RestoreStage, why: readonly string[]) => void;
  /** Each try of step 5's end, with its reasons (both empty: every id read and nothing named). */
  step5?: (end: Step5End) => void;
  /** Tests only: the beat, the clock, step 5's pauses and the two restores (the wallet's otherwise). */
  beatMs?: number;
  now?: () => number;
  pausesMs?: readonly number[];
  solana?: typeof solanaRestoreNotes;
  evm?: typeof evmRestoreNotes;
  /** The NEAR vault's walk (nearVaultRestoreNotes unless given: a test's own gap). */
  vault?: typeof nearVaultRestoreNotes;
  /** The page's walk Workers (card restore-shows-the-balance-in-seconds: src/walk-workers.ts walkWorkerPort), handed to
   *  every pool's walk; none, every lane on the page's thread. */
  walkers?: () => WalkPort;
};

/** A run: its first end (the walk's notes written: what every follower is told), its whole end (step 5 included). */
type Run = { first: Promise<RestoreStage>; done: Promise<void>; follow(id: string, progress?: (s: RestoreStage) => void): void };

export type PoolRestore = {
  /** The `restore` kind's handler: "started" once the seed is read as stored (else not_allowed), the run's stages after. */
  kind(params: Record<string, unknown>, ctx: KindContext): Deferred<"restore">;
  /** After a sign-in: a run under its own op id when the note store holds no note; resolves to its walk's end (or null). */
  auto(): Promise<RestoreStage | null>;
  /** A signed-in load: a run with no op when step 5 is owed (RESTORE_IDS_KEY); resolves to its walk's end (or null). */
  resume(): Promise<RestoreStage | null>;
  /** This tab signed out: the run in flight stops. */
  signedOut(): void;
  /** A signed-in load: every restore op still running whose run no tab holds is written stalled. */
  settle(): Promise<void>;
  /** The run in flight's whole end, step 5 included (resolved when none runs). */
  idle(): Promise<void>;
};

/**
 * A read of the run's, waited on only while its signal lasts: at the signal's end it rejects with its reason at once and
 * the run waits on the read no more (the read's own answer, when it comes, is dropped), so a sign out never waits on a
 * provider. Each read the run makes goes through it: the walk's whole call (its pool's RPCs are the page's own, kept
 * across runs with its cache, so they are not bound to one run's signal; the walk checks the signal before each new
 * read) and each of step 5's NEAR reads (card restore-first-sign-in-under-two-minutes: release 114's walk ran on after a
 * sign out until its getProgramAccounts answered).
 */
export function letGo<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return (read.catch(() => {}), Promise.reject(signal.reason));
  return new Promise<T>((ok, no) => {
    const stop = (): void => no(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    read.then(ok, no).finally(() => signal.removeEventListener("abort", stop));
  });
}

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    signal.throwIfAborted();
    const t = setTimeout(() => (signal.removeEventListener("abort", stop), res()), ms);
    const stop = (): void => (clearTimeout(t), rej(signal.reason));
    signal.addEventListener("abort", stop, { once: true });
  });

export function poolRestore(h: PoolRestoreHost): PoolRestore {
  const beat = h.beatMs ?? RESTORE_BEAT_MS;
  const now = h.now ?? Date.now;
  const locks = (): Pick<LockManager, "request" | "query"> => h.locks ?? navigator.locks;
  let run: Run | null = null;
  let abort: AbortController | null = null;
  // step 5's pass and answers, kept across this page's runs (a Retry reads on) and dropped at a sign out
  let keep = idReadKeep();

  // one run: the walk, its notes written (the floor), `first` told; then step 5, tried again by itself on a read that did
  // not answer. `owed`: a load's resume, which reads nothing when another tab removed the marker meanwhile
  const read = async (signal: AbortSignal, owed: boolean, first: (stage: RestoreStage) => void, run: { finding: boolean }): Promise<void> => {
    const pools = (h.pools ?? pagePools)();
    const solana = h.solana ?? solanaRestoreNotes;
    const evm = h.evm ?? evmRestoreNotes;
    const vaultWalk = h.vault ?? nearVaultRestoreNotes;
    const ids = h.ids === undefined ? pageIdReads() : h.ids;
    // each reason the walk is not done, as found; the walk's end is told once with them (`ended`), a throw or an abort
    // included (review of e31892ef, P3-5)
    const why: string[] = [];
    let told = false;
    const end = (stage: RestoreStage): void => {
      if (told) return;
      told = true;
      h.ended?.(stage, why);
      first(stage);
    };
    // the run's seed: an HMAC of it under a key drawn for this run, taken at its first use and held in memory only
    // (never stored, logged or sent), so a sign out and a sign in with other words in another tab between two uses
    // stops the run before one more use, never deriving those words' ids on this run's lanes nor writing this run's
    // notes into that store (review of e31892ef, P3-2)
    const runKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    let mark = null as Uint8Array | null;
    // under the seed lock, shared, while this run's seed is still the one stored: a sign out (exclusive) never runs
    // inside a use; `fn` gets the seed, zeroed when it ends
    const seedHeld = <T,>(fn: (seed64: Uint8Array) => Promise<T>): Promise<T> =>
      locks().request(WALLET_SEED_LOCK, { mode: "shared", signal }, async () => {
        signal.throwIfAborted();
        if (!(await h.signedIn())) throw new SeedGone("signed out during the restore");
        const s = await h.seed64();
        try {
          const m = hmac(sha256, runKey, s);
          if (mark === null) mark = m;
          else {
            const same = m.length === mark.length && m.every((x, k) => x === mark![k]);
            m.fill(0);
            if (!same) throw new SeedGone("other words were signed in during the restore");
          }
          return await fn(s);
        } finally {
          s.fill(0);
        }
      }) as Promise<T>;
    // the seed for one use
    const seed: SeedUse = (use) => seedHeld(async (s) => use(s));
    // this run's own id on the marker it writes (a lane kept, the marker removed, only on its own: delta review P3-D)
    const runId = crypto.randomUUID();
    // step 5 of this run, set at the walk's end and run after the restore lock is let go
    let step5: (() => Promise<void>) | null = null;
    // the restore lock, held for the walk and its floor (each tab's walks in turn), never for step 5 (review P2-4 of
    // 53f5e92f: a second tab's restore or Sync waited out the whole of step 5); the seed's lock only for each use of it
    return locks().request(RESTORE_LOCK, { mode: "exclusive", signal }, async (): Promise<void> => {
      try {
        // a load's resume that another tab's run finished first: nothing is owed
        if (owed && (await (await h.store()).get("meta", RESTORE_IDS_KEY)) === undefined) return end("done");
        // each pool on its own: one that fails leaves the others' notes found
        const label = (p: RestorePool): string => (p.chain === "near" ? "near vault" : p.chain === "solana" ? "solana" : p.pin.network);
        const evmHoldingsOwed: { chain: "base" | "robinhood"; pin: EvmPoolPin; list: readonly EvmRpc[]; buys: EvmBuySpend[] }[] = [];
        // card closed-positions-after-a-restore: every pool's reads go side by side, but each walk (RESTORE_LANES lanes
        // of RESTORE_GAP indices on the page's one thread, the run's whole cost) takes the page's turn, one pool after
        // another in the order their reads end, so the first pool's notes are written one walk in, never after every
        // pool's walk shared the thread
        // card restore-shows-the-balance-in-seconds: with the lanes in Workers a walk takes every core, so the walks still
        // go one at a time, and Solana's goes first among those waiting when its reads are ready (its balance is the one
        // the user waits for at a sign-in): a walk already running is never stopped for it
        let busy = false;
        const waiting: { first: boolean; go: () => void }[] = [];
        const next = (): void => {
          const w = waiting.shift();
          if (w) w.go();
          else busy = false;
        };
        const turn = <T,>(walk: () => Promise<T>, first = false): Promise<T> =>
          new Promise<void>((go) => {
            if (!busy) return void ((busy = true), go());
            const at = first ? waiting.findIndex((w) => !w.first) : -1;
            waiting.splice(at < 0 ? waiting.length : at, 0, { first, go });
          })
            .then(walk)
            // a walk that throws at once frees the turn too (review of 9de383865, P3)
            .finally(next);
        const solanaTurn = <T,>(walk: () => Promise<T>): Promise<T> => turn(walk, true);
        const walkers = h.walkers ? { walkers: h.walkers } : {};
        // the floor, a pool at a time as its walk ends: its scope's deposit counter past the walk's highest note in this
        // store's lane (step 7's, on the notes alone; step 5 raises it again once the lane's ids are read, and a counter
        // only goes up), so the naming the notes' write sets off names past them, then its notes, each pool's write after
        // the one before, so the balance (src/pools.ts, read on each change of the store) shows a pool's notes as soon as
        // they are found. A floor that throws (a sign out, other words signed in, a write refused) stops the run as one
        // write of every pool's notes did: no floor after it writes, and the run ends on its error once the walks settle
        let floors: Promise<unknown> = Promise.resolve();
        let floorFailed: { e: unknown } | null = null;
        // Once a pool's floor has written, the page says so in one line, the chain's name alone (card
        // restore-shows-the-balance-in-seconds: the live check reads when the first balance is the restored one); a
        // floor that fails, or one after a failed one, says nothing
        const floor = (chain: "solana" | "near" | "base" | "robinhood", scope: bigint, notes: readonly RestoredNote[]): Promise<void> => {
          const r = floors.then(async () => {
            if (floorFailed !== null) return;
            await seedHeld(async () => {
              const st = await h.store();
              await st.raiseDepositIndex(scope, coverTo({ lane: st.lane, highest: lanesOf(notes, scope).laneHighest[st.lane]! }));
              if (notes.length === 0) return;
              const ns = await openNoteStore(st);
              try {
                await writeRestored(ns, { notes: [...notes] });
              } finally {
                ns.close();
              }
            });
            console.info(`restore: ${chain} walked`);
            if (notes.length > 0) h.written?.();
          }).catch((e: unknown) => void (floorFailed ??= { e }));
          floors = r;
          return r;
        };
        const reads = pools.map(async (p): Promise<RestoredNote[]> => {
          if (p.rpcs === null) throw new Error("no reads on this page");
          if (p.chain === "near") {
            const notes = (await letGo(vaultWalk({ network: p.network, rpcs: p.rpcs(), seed64: seed, signal, turn, ...walkers }), signal)).notes;
            await floor("near", p.scope, notes);
            // a host's hook that throws never ends this walk
            if (floorFailed === null && notes.some((n) => n.state === "SPENT")) {
              try {
                h.nearWalked?.();
              } catch {
                /* the next load's pass reads it */
              }
            }
            return notes;
          }
          if (p.chain === "solana") {
            const lister = p.lister?.();
            const notes = (await letGo(solana({ seed64: seed, program: p.program, rpcs: p.rpcs(), ...(lister ? { lister } : {}), ...(p.cache ? { cache: p.cache } : {}), ...(p.markBatches ? { markBatches: p.markBatches } : {}), signal, turn: solanaTurn, ...walkers }), signal)).notes;
            await floor("solana", p.scope, notes);
            return notes;
          }
          // the notes only: no W's Transfer logs are read (wallets: false)
          // the page's hold (the deposit's sync's too) and its history sources (card evm-pool-leaves-any-source)
          const r = await letGo(evm({ seed64: seed, pin: p.pin, rpcs: p.rpcs(), signal, wallets: false, held: pageEvmHold(p.pin, () => h.held ? h.held() : h.store()), history: pageEvmHistory(p.pin), turn, ...walkers }), signal);
          await floor(chainOf(p), p.scope, r.notes);
          // each buy's record again from its own transaction, so a restored W sells on its buy's route (card
          // signpage-evm-pool-sell, pool-sell-evm.ts restoreEvmHoldings: no read names W or a transaction); the testnet
          // build only: it asks the pool's public RPCs for the Bought logs and the whole block at each of one device's
          // buys together, which on a quiet mainnet pool tells a provider which buys are one device's (card
          // evm-pools-on-mainnet leaves it closed; a restored mainnet W is not sold until its record is back)
          const buys = POOL_TESTNET ? r.spends.flatMap((x) => (x.token === null ? [] : [{ w: x.w, token: x.token, block: x.block, blockHash: x.blockHash, logIndex: x.logIndex }])) : [];
          const chain = chainOf(p);
          if (POOL_TESTNET && buys.length > 0 && chain !== "solana") evmHoldingsOwed.push({ chain, pin: p.pin, list: p.rpcs(), buys });
          return r.notes;
        });
        const walked: Walked[] = [];
        // the NEAR vault's notes, walked and written with the pools' (each by `floor` as its walk ends), with no step 5
        // read. On a restored device nothing on the page reads a vault deposit id the lost device left money on; that
        // was so before this walk too
        const settled = await Promise.allSettled(reads);
        settled.forEach((r, k) => {
          const p = pools[k]!;
          if (p.chain === "near") {
            if (r.status !== "fulfilled") why.push(`${label(p)}: ${r.reason instanceof Error ? r.reason.message : "the walk failed"}`);
            return;
          }
          if (r.status === "fulfilled") {
            const chain = chainOf(p);
            walked.push({ label: label(p), chain, scope: p.scope, notes: r.value, ux: h.ux?.(chain) ?? null, addressed: h.addressed?.(chain) ?? true });
            // a failed walk stalls the run, but not on a chain this build gives no deposit address on (nor a deposit: the
            // two open together), which holds no note of this device: it holds back no other chain's restore
          } else if (h.addressed?.(chainOf(p)) ?? true) why.push(`${label(p)}: ${r.reason instanceof Error ? r.reason.message : "the walk failed"}`);
        });
        // a floor that threw ends the run on its error, after every other pool's reason is in `why` (the catch below
        // adds its own)
        if (floorFailed !== null) throw (floorFailed as { e: unknown }).e;
        signal.throwIfAborted();
        // a walk that failed: the next load walks that pool again, so step 5 stays owed after it (the marker)
        const walkFailed = why.length > 0;
        // what this build cannot read for a walked pool is known before step 5 starts, so the walk's end names it and
        // is stalled, never done (review P3 of card wallet-restore-reads-ux): the testnet build reads no deposit id nor
        // any U_X (no 1Click quote there); a pool chain with no U_X reads on this page leaves its ids' money unread.
        // Step 5 still reads what it can after it; a lane past the walk's end is known only from an id read, so that
        // one is a finding of step 5 (`named`), told after done
        for (const w of walked) {
          if (ids === null) {
            if (POOL_TESTNET) why.push(`${w.label}: ${POOL_UX_UNREAD_TESTNET}`);
          } else if (w.ux === null && w.addressed) why.push(`${w.label}: ${POOL_CHAIN_UNREAD}`);
        }
        // the floor: every walked pool's notes, and the vault's, were written as its walk ended (`floor` above), before
        // any id is read
        // the buy records, once the notes are written: a W whose read fails keeps none, and is not sold until a later
        // restore reads it
        if (POOL_TESTNET) for (const o of evmHoldingsOwed) {
          signal.throwIfAborted();
          // the run's signal ends it at once, as every read of the run (letGo); a chain whose records it wrote reads its
          // positions again (card signpage-positions-evm)
          const wrote = await letGo(restoreEvmHoldings({ chain: o.chain, testnet: POOL_TESTNET, pin: o.pin, rpcs: evmPair(o.list), store: await (h.held ? h.held() : h.store()), spends: o.buys, signal }).catch((): string[] => []), signal);
          if (wrote.length > 0) h.holdingsWritten?.(o.chain);
        }
        // step 5 is owed from here until a try reads every id (the marker, the pools' scopes alone)
        const idPools = pools.filter((p) => p.chain !== "near");
        const owes = ids !== null && idPools.length > 0;
        // (a resume, a load's or a landing's, keeps the lanes a marker for the same scopes holds read whole, so it reads
        // only the others; a run the user asks for, a Sync or a Retry, writes it fresh and reads every lane whole: delta
        // review P2-A)
        const scopes = idPools.map((p) => p.scope.toString());
        if (owes)
          await seedHeld(async () =>
            (await h.store()).update("meta", RESTORE_IDS_KEY, (v) => {
              const o = owedOf(v);
              return owed && o !== null && JSON.stringify(o.scopes) === JSON.stringify(scopes) ? { ...o, run: runId } : { scopes, run: runId };
            }),
          );
        signal.throwIfAborted();
        // the wait the user sees ends here: their notes are back, shown and spendable
        const stage: RestoreStage = why.length > 0 ? "stalled" : "done";
        end(stage);
        step5 = async (): Promise<void> => {

        // step 5, after the walk's end: it holds no lock a money kind takes, and tells the user of a finding about
        // their money (`named`); a read that did not answer is asked again by itself, the pauses growing, and told the
        // same way on the last try (review P2-2 of 53f5e92f: never silent for good). A finding told holds for the run
        // (review P2-1): every request that joins it from then on ends stalled (start's follow), and at each try's end
        // with one the newest restore op is stalled (one written when it is not), so a Retry tapped meanwhile never
        // leaves the screen saying done
        const tell = async (r: Step5End): Promise<void> => {
          h.step5?.(r);
          if (r.named.length === 0) {
            // the run's last try read every id with nothing to tell after a finding was told: the newest restore op is
            // done again, so the stalled sheet never stands on nothing (delta review P3-B)
            if (!r.last || !run.finding) return;
            run.finding = false;
            await seedHeld(async () => (await h.store()).put("ops", crypto.randomUUID(), { kind: "restore", stage: "done", txs: [], created_ms: now() }));
            return;
          }
          run.finding = true;
          await seedHeld(async () => {
            const st = await h.store();
            const ops = await Promise.all((await st.keys("ops")).map(async (k) => (await st.get("ops", k)) as { kind?: unknown; stage?: unknown; created_ms?: unknown } | undefined));
            const newest = ops.filter((o) => o?.kind === "restore").sort((x, y) => Number(x!.created_ms) - Number(y!.created_ms)).at(-1);
            if (newest?.stage !== "stalled") await st.put("ops", crypto.randomUUID(), { kind: "restore", stage: "stalled", txs: [], created_ms: now() });
          });
        };
        // the testnet build: named at the walk's end above, nothing for step 5 to read
        if (ids === null) return;
        if (walked.length === 0) return;
        // the scope's deposit indices the note store holds now (the floor's notes among them), for the U_X carry
        const noted = async (scope: bigint): Promise<ReadonlySet<number>> => {
          const notes = await openNoteStore(await h.store());
          try {
            return new Set((await notes.list()).flatMap((n) => (n.ref.kind === "deposit" && n.ref.s === scope ? [n.ref.i] : [])));
          } finally {
            notes.close();
          }
        };
        const own = { lane: (await h.store()).lane, raise: (scope: bigint, min: number) => seedHeld(async () => void (await (await h.store()).raiseDepositIndex(scope, min))) };
        // the lanes the marker keeps read whole, by scope; a lane is added only while the marker is there (never one
        // written again after a try removed it)
        // the lanes this run's marker keeps read whole, by scope: one is skipped only while its notes are what they were
        // when it was kept (its highest note the same: delta review P2-A); a lane is added only to this run's own marker
        const lanesKept = {
          of: async (scope: bigint, laneHighest: readonly (number | null)[]): Promise<ReadonlyMap<number, number>> => {
            const o = owedOf(await seedHeld(async () => (await h.store()).get("meta", RESTORE_IDS_KEY)));
            if (o?.run !== runId) return new Map();
            return new Map((o.read?.[scope.toString()] ?? []).filter(([l, , hi]) => hi === (laneHighest[l] ?? null)).map(([l, to]) => [l, to]));
          },
          add: (scope: bigint, lane: number, readTo: number, highest: number | null): Promise<void> =>
            seedHeld(async () =>
              void (await (await h.store()).update("meta", RESTORE_IDS_KEY, (v) => {
                const o = owedOf(v);
                if (o === null || o.run !== runId) return undefined;
                const k = scope.toString();
                return { ...o, read: { ...o.read, [k]: [...(o.read?.[k] ?? []).filter(([l]) => l !== lane), [lane, readTo, highest]] } };
              })),
            ),
        };
        const pauses = h.pausesMs ?? STEP5_PAUSES_MS;
        for (let t = 1; ; t++) {
          const out: Step5Reasons = { retry: [], held: [], named: [] };
          await readDepositIds(seed, walked, ids, keep, signal, out, noted, own, lanesKept).catch((e: unknown) => {
            // the run's seed gone (a sign out, other words signed in): the run stops, and no try of it reads again
            if (e instanceof SeedGone || signal.aborted) throw e;
            out.retry.push(`step 5 did not finish: ${e instanceof Error ? e.message : "it threw"}`);
          });
          signal.throwIfAborted();
          const answered = out.retry.length === 0 && out.held.length === 0;
          const last = answered || t > pauses.length;
          // past the tries, what is still not read is told as a finding: the user sees it (the sheet's Retry)
          await tell(last ? { retry: [], held: [], named: [...out.named, ...out.held, ...out.retry], tries: t, last } : { ...out, tries: t, last });
          if (answered) {
            // every id read and nothing found: nothing is owed, unless a pool's walk failed (the next load walks it and
            // reads its ids); a finding keeps the marker, so the next load reads again (review P2-1)
            if (!walkFailed && out.named.length === 0)
              await seedHeld(async () => {
                const st = await h.store();
                if (owedOf(await st.get("meta", RESTORE_IDS_KEY))?.run === runId) await st.delete("meta", RESTORE_IDS_KEY);
              });
            return;
          }
          if (last) return;
          await pause(pauses[t - 1]!, signal);
        }
        };
      } catch (e) {
        runKey.fill(0);
        mark?.fill(0);
        throw e;
      }
    })
      .then(async () => {
        try {
          // step 5 under a lock of its own, one tab at a time: a tab whose step 5 another tab runs reads no id beside
          // it (that tab's run reads them, and removes the marker once every id is read)
          const go = step5 as (() => Promise<void>) | null;
          if (go !== null) await locks().request(RESTORE_IDS_LOCK, { mode: "exclusive", ifAvailable: true }, async (l) => void (l !== null && (signal.throwIfAborted(), await go())));
        } finally {
          runKey.fill(0);
          mark?.fill(0);
        }
      })
      .catch((e: unknown): never => {
      why.push(`the restore stopped: ${e instanceof Error ? e.message : "it threw"}`);
      end("stalled");
      throw e;
    }) as Promise<void>;
  };

  const start = (owed: boolean): Run => {
    if (run) return run;
    // each follower's op record, its writes in order (a stage never lands before the one it follows)
    type Follower = { id: string; created: number; writes: Promise<void>; progress?: (s: RestoreStage) => void; told: () => void; fin: Promise<void> };
    const followers: Follower[] = [];
    const write = (f: Follower, stage: RestoreStage): void => {
      f.writes = f.writes.then(async () => (await h.store()).put("ops", f.id, { kind: "restore", stage, txs: [], created_ms: f.created })).catch(() => {});
    };
    const ctl = (abort = new AbortController());
    let stage: RestoreStage | null = null;
    // a follower's end: its record's end written, then posted, so a reader of the op after the end never reads it
    // behind; a run this tab's sign out stopped writes nothing more (its records went with the store)
    const tell = (f: Follower, s: RestoreStage): void => {
      if (!ctl.signal.aborted) {
        write(f, s);
        f.writes = f.writes.then(() => f.progress?.(s));
      }
      void f.writes.then(f.told);
    };
    // the beat posts "reading" again and writes nothing, until the walk's end
    const timer = setInterval(() => {
      for (const f of followers) f.progress?.("reading");
    }, beat);
    let firstOf: (s: RestoreStage) => void = () => {};
    const first = new Promise<RestoreStage>((r) => (firstOf = r));
    const post = (s: RestoreStage): void => {
      if (stage !== null) return;
      stage = s;
      clearInterval(timer);
      for (const f of followers) tell(f, s);
      // the walk's end is its followers' records' end: each one's write landed (or failed)
      void Promise.all(followers.map((f) => f.writes)).then(() => firstOf(s));
    };
    const state = { finding: false };
    const done = read(ctl.signal, owed, post, state)
      .catch(() => {})
      .then(async () => {
        post("stalled");
        clearInterval(timer);
        run = null;
        if (abort === ctl) abort = null;
        await first;
      });
    const r: Run = {
      first,
      done,
      follow: (id, progress) => {
        let told: () => void = () => {};
        const fin = new Promise<void>((x) => (told = x));
        const f: Follower = { id, created: now(), writes: Promise.resolve(), ...(progress ? { progress } : {}), told, fin };
        followers.push(f);
        // held until its record's end: a record whose lock no tab holds is a dead run's (settle)
        void locks().request(`${RESTORE_LOCK}/${id}`, { mode: "exclusive" }, () => Promise.race([fin, done.catch(() => {})]));
        write(f, "started");
        write(f, "reading");
        progress?.("reading");
        // a request after the walk's end (a Retry, a Sync while step 5 reads on) is told that end at once, stalled once
        // step 5 has told a finding in this run (review P2-1)
        if (stage !== null) tell(f, state.finding ? "stalled" : stage);
      },
    };
    run = r;
    return r;
  };

  return {
    kind: (_params, ctx) => {
      let yes = false;
      const after = h.signedIn().then((s) => {
        if (!(yes = s)) return;
        start(false).follow(ctx.id, (stage) => ctx.progress(stage));
      });
      return { after, answer: () => (yes ? { result: { stage: "started" } } : { error: "not_allowed" }) };
    },
    auto: async () => {
      if (run) return null;
      const notes = await openNoteStore(await h.store());
      let empty: boolean;
      try {
        empty = (await notes.list()).every((n) => n.state === "PLANNED");
      } finally {
        notes.close();
      }
      if (!empty || run) return null;
      const r = start(false);
      r.follow(crypto.randomUUID());
      return r.first;
    },
    resume: async () => {
      if (run || !(await h.signedIn())) return null;
      const owed = (await (await h.store()).get("meta", RESTORE_IDS_KEY)) !== undefined;
      if (!owed || run) return null;
      return start(true).first;
    },
    signedOut: () => {
      abort?.abort();
      keep = idReadKeep();
    },
    settle: async () => {
      const ops = await h.store();
      const q = await locks().query();
      const alive = new Set([...(q.held ?? []), ...(q.pending ?? [])].map((l) => l.name));
      for (const k of await ops.keys("ops")) {
        if (alive.has(`${RESTORE_LOCK}/${k}`)) continue;
        await ops.update("ops", k, (v) => {
          const r = v as { kind?: unknown; stage?: unknown } | undefined;
          return r?.kind === "restore" && (r.stage === "started" || r.stage === "reading") ? { ...r, stage: "stalled" } : undefined;
        });
      }
    },
    idle: () => run?.done ?? Promise.resolve(),
  };
}

/**
 * The NEAR vault's notes of these words (card signpage-restores-near-vault-notes), as the exit tool restores them
 * (packages/exit scan.ts: the wallet's restoreNotes), with the seed opened only for each use, as the pools' walks:
 * - the vault's deposits, spends and leaves read whole on the page's release pair at one block, each answer's bytes
 *   equal on both (the kit's vaultSync: a provider that differs by one byte, or a page past the list's length, stops
 *   the read, and nothing is returned), and the vault's config read on both: its scope the one computed from the
 *   page's pinned vault and USDC, its asset that USDC (the wallet's readConfig);
 * - each lane walked off the deposit masters of one short use of the seed (walkLaneYielding), then the notes from the
 *   pages (restorePagesSteps): every note of the scope with its state, UNSPENT or SPENT, parents first. The walk and
 *   the notes run on one clock of slices (slices): the seed is opened for one slice's work at a time (WALK_SLICE_MS),
 *   the page's thread given a turn and the signal checked between slices, so no history, however long, holds either
 *   for more than a slice.
 * A read that fails throws: the run names the vault stalled and writes none of its notes; the next run reads it again.
 */
export async function nearVaultRestoreNotes(a: { network: NearNetwork; rpcs: readonly [VaultSyncRpc, VaultSyncRpc]; seed64: SeedUse; signal?: AbortSignal; gap?: number; walkers?: () => WalkPort; turn?: <T>(walk: () => Promise<T>) => Promise<T> }): Promise<{ scope: bigint; notes: RestoredNote[] }> {
  const net = NEAR_NETWORKS[a.network];
  const scope = vaultScope(a.network);
  if (net.vault === null || scope === null) throw new Error(`no vault on ${a.network}`);
  if (nearPairNetwork(a.rpcs) !== a.network) throw new Error(nearPairRule(a.network));
  const s = await vaultSync({ vault: net.vault, rpcs: a.rpcs, cursor: vaultSyncStart(net.vault), lists: ["deposits", "spends", "leaves"], ...(a.signal ? { signal: a.signal } : {}) });
  if (s.leaves.length !== s.stateTree.size) throw new Error("the leaves read are not the whole state tree");
  await readConfig(a.rpcs, net.vault, net.usdc, scope, s.height, a.signal);
  const gap = a.gap ?? RESTORE_GAP;
  // the walk and the notes in the page's turn, its 8 lanes in the page's walk Workers when it gives them (the wallet's
  // walkLanes); restorePagesSteps checks each walk again (checkedWalk) before a note is taken
  return await (a.turn ?? ((walk) => walk()))(async () => {
    const m = await withSeed(a.seed64, (seed64) => masters(seed64, "deposit"));
    const slice = slices(a.signal);
    const lanes: LaneWalk[] = await walkLanes({ m, scope, match: { kind: "pre", precommitments: s.deposits.map((r) => r.precommitment) }, gap, ...(a.signal ? { signal: a.signal } : {}), slice, ...(a.walkers ? { spawn: a.walkers } : {}) });
    a.signal?.throwIfAborted();
    const steps = restorePagesSteps(scope, s, { gap, lanes });
    let step = steps.next();
    while (!step.done) {
      const at = step;
      step = await withSeed(a.seed64, (seed64) => {
        let r: IteratorResult<void, PagesRestored> = at;
        do r = steps.next(seed64);
        while (!r.done && !slice.due());
        return r;
      });
      if (!step.done) await slice.pass();
    }
    return { scope, notes: step.value.notes };
  });
}
