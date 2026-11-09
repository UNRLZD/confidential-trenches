// The restore kind on SIGN_HOST (card pool-restore-wired): the 12 words on a new browser bring back every pool note and
// so every fresh wallet W (each W is derived from its note, ../../wallet/src/pool/buy-wallets.ts spentNotesOf).
// - The app asks `restore` (apps/terminal/src/screens/signin/source.tsx, kit schema.ts restore: {} in, {stage:
//   "started"} out). The answer is "started" at once; the run's stages go to its op record under the request's id
//   (kind "restore", src/state.ts's op contract: no secret in it) and, for a request, as its progress events: "reading"
//   at the start and again every RESTORE_BEAT_MS while it reads (the kit's client gives restore no timeout and the app
//   shows it stalled when progress stops: packages/kit/src/signpage/client.ts restore, at least every 10 s), then
//   "done", or "stalled" when any pool's read failed (the app's Retry asks a new restore; a run again writes only what
//   is missing).
// - A sign-in with the words (or a passkey that opens an existing account) on a note store with no note runs it once
//   with no tap (src/main.ts), under an op id of its own, so the app's sign-in sheet shows it (S19).
// - It runs on every pool the page's network pins (pagePools): the Solana pool through the wallet's solanaRestoreNotes
//   on the page's Solana pair, each EVM pool through evmRestoreNotes on its pool list, notes only (wallets: false: no W
//   is named to any provider, since the page keeps no W record). A pin with no reads on this page (an EVM pin on
//   mainnet, which has no EVM pool list yet) is a failed pool, never skipped: the run ends stalled, so "done" always
//   means every pinned pool was read.
// - What they find goes to the note store through the wallet's writeRestored (parents first; a note the store holds in
//   flight is left as it is), the pools' notes together. A pool that fails leaves the others' notes written.
// - Then restore step 5 (card wallet-restore-id-reader-wired; docs/plan1/wallet.md §2.3 "Restore" step 5): each pool
//   walked has its deposit ids U_{s,i} read under its own scope s, in every lane up to the lane's highest with a note,
//   a trace or money, plus DEPOSIT_ID_MARGIN more (../../wallet/src/restore/wallets.ts restoreDepositIds), each lane held
//   to its walk's end (../../wallet/src/notes/restore.ts walkEnd at RESTORE_GAP, the pools' walk). A pool deposit's
//   refund lands under U_{s,i}'s id inside intents.near, so an id can hold money, or show it was used, where no note
//   does. Each id is read by the wallet's IdReader (../../wallet/src/restore/id-reader.ts nearIdReader) on the
//   release's pair on the network 1Click pays out on (pageIdReads: FastNEAR and dRPC on mainnet), every view at one
//   block agreed on both (openRestorePass, one pass for the whole run), the stronger answer of the two taken.
//   - The walk's notes are the floor: they are written before any id is read, whatever the ids then show.
//   - An id unread on both providers (after the IdReader's retries) stops the reads at once: no id is read after it,
//     and the run ends stalled, never done, so the app's Retry reads again. A pass the providers refuse, a lane stopped
//     past its walk's end (the restore unfinished) or any read that throws ends it stalled the same way.
//   - The testnet build reads no deposit id: it makes no 1Click quote (src/pool-deposit-address.ts), so no id of its
//     pools can hold a trace on NEAR.
//   - A pool deposit's money can also wait at its one-time account U_X on the pool's own chain (1Click's delivery there,
//     or a refund carry moved back there; card wallet-restore-reads-ux). On a chain whose pool follow has reads on this
//     page (the host's `ux`: the follow's own balances, costs, ladder and deposit, src/main.ts; today Solana's), step 5
//     reads each id's U_X (uxOf: on Solana the base58 of the id's own 32 bytes, on Base and Robinhood U^evm_{s,i})
//     beside the id, at finalized on the pool's two RPCs, one U_X per request, so no request names two of the user's
//     wallets: both RPCs must give the same balance, else the id is unread and the run ends stalled by name. A U_X
//     holding any balance is history (the id reads "money"), so its lane is read DEPOSIT_ID_MARGIN past it.
//     Once a scope's ids are read, each U_X that covers one deposit (the follow's floor) and whose index has a deposit
//     note in the store (the page's pool.deposit pays from U_{s,i} only on one; a U_X with none on this device, as a
//     delivery the lost store's quote named, is named with its balance and the run ends stalled) is carried into the
//     pool as the follow carries it (askOf's largest ask, the page's pool.deposit from that U_{s,i}), read again after each deposit
//     and carried on while it still covers one; a carry that does not fill, or a balance a filled deposit did not lower,
//     ends the run stalled with the U_X named. Less than one deposit's floor (the rent a carried U_X keeps) is left, as
//     the follow leaves it. A pool on a chain with no U_X reads here (Base and Robinhood until the EVM follow's reads
//     land) is never "done" (POOL_CHAIN_UNREAD): the run ends stalled by name, so no run says done while a U_X is unread.
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
import { RESTORE_GAP, RESTORE_LANES, walkEnd, writeRestored, type RestoredNote, type SeedUse } from "../../wallet/src/notes/restore.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { evmRestoreNotes } from "../../wallet/src/pool/evm-restore.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPoolScopeOf, type EvmNetwork, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { solanaRestoreNotes } from "../../wallet/src/pool/solana-restore.ts";
import { nearIdReader, openRestorePass, type IdReaderOpts, type PassOpts } from "../../wallet/src/restore/id-reader.ts";
import { restoreDepositIds, type DepositIds, type IdReader } from "../../wallet/src/restore/wallets.ts";
import { relayRpc } from "../../wallet/src/withdraw/relay.ts";
import { base58, hex } from "@scure/base";
import type { Deferred, KindContext } from "./api.ts";
import { askOf, type PoolUx, type PoolUxReads } from "./pool-deposit-follow.ts";
import { PAGE_SOL_PIN, TESTNET_RPCS, pageSolanaRpcs, testnetRpc } from "./pool-testnet.ts";

/** The Web Lock a run holds (each tab's runs in turn); RESTORE_LOCK/<op id>: one follower's op, held while it runs. */
export const RESTORE_LOCK = "ct-pool/restore";

/** The gap between two "reading" progress events: within the 10 s the kit's client names. */
export const RESTORE_BEAT_MS = 5_000;

/** One pinned pool to restore, with its scope (its deposit ids') and its reads (null when this page has none for it: the run ends stalled). */
export type RestorePool =
  | { chain: "solana"; program: string; scope: bigint; rpcs: (() => readonly [SolanaRpc, SolanaRpc]) | null }
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

/** Why step 5 on one scope is not done (empty: every id read and every lane at its margin), each reason named. */
export function idsUndone(r: DepositIds): string[] {
  const why: string[] = [];
  for (const x of r.lanes) {
    if (x.reach !== null) why.push(`lane ${x.lane} stopped at ${x.reach}, past the note walk's end: restore again from there`);
    if (x.unread.length > 0) why.push(`lane ${x.lane}: ${x.unread.length} id${x.unread.length === 1 ? "" : "s"} unread (${x.unread[0]!.error})`);
  }
  if (!r.complete && why.length === 0) why.push("the ids' read is unfinished");
  return why;
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
 * Step 5 on every pool walked, in order, on one pass and one IdReader: each reason it is not done, named, pushed to `why`
 * as found (never none while a pool scope's U_X is unread: POOL_CHAIN_UNREAD), so a throw keeps the reasons before it. The first id unread on both providers stops every read
 * after it (each throws at once, so its lane ends with restoreDepositIds's error); a sign out stops them the same way,
 * checked before each id (the id in flight then ends its lane, and the run's end checks it again). `seed` opens the seed for each window of a lane's ids only.
 */
async function readDepositIds(seed: SeedUse, walked: readonly Walked[], ids: IdReads, signal: AbortSignal, why: string[], noted: (scope: bigint) => Promise<ReadonlySet<number>>): Promise<void> {
  const rpcs = ids.rpcs();
  const pass = await openRestorePass(POOL_DEPOSIT_NETWORK, rpcs, ids.opts ?? {});
  const reader = await nearIdReader(POOL_DEPOSIT_NETWORK, rpcs, pass, ids.opts ?? {});
  let stop: unknown;
  const holds: IdReader = async (u, i) => {
    signal.throwIfAborted();
    if (stop !== undefined) throw stop;
    try {
      return await reader(u, i);
    } catch (e) {
      stop ??= e;
      throw e;
    }
  };
  for (const w of walked) {
    // the walk's deposit notes are all of its pool's scope: one of another is a drift, never read on
    const drift = w.notes.filter((n) => n.ref.kind === "deposit" && n.ref.s !== w.scope);
    if (drift.length > 0) {
      why.push(`${w.label}: ${drift.length} deposit note${drift.length === 1 ? "" : "s"} of scope ${String((drift[0]!.ref as { s: bigint }).s)} in the walk of scope ${w.scope}; its ids are not read`);
      continue;
    }
    const ux = w.ux;
    if (ux === null) {
      const r = await restoreDepositIds(seed, w.scope, { notes: [...w.notes], ...lanesOf(w.notes, w.scope) }, holds);
      ids.read?.(w.scope, r);
      for (const y of idsUndone(r)) why.push(`${w.label}: ${y}`);
      why.push(`${w.label}: ${POOL_CHAIN_UNREAD}`);
      continue;
    }
    // each id's U_X on the pool's own chain read beside it, on both of its RPCs; any balance there is history of the id
    const chain = w.chain;
    const held = new Map<number, PoolUx>();
    const both: IdReader = async (id, i) => {
      if (i === undefined) throw new Error("no deposit index for its U_X");
      const near = await holds(id, i);
      const u = await uxOf(seed, chain, w.scope, i, id);
      const [a, b] = await ux.balances({ u });
      if (a !== b) throw new Error(`its U_X reads ${String(a)} and ${String(b)} on the pool chain's two RPCs`);
      if (a === 0n) return near;
      held.set(i, { chain, s: w.scope.toString(), i, u, refund_id: id });
      return "money";
    };
    const r = await restoreDepositIds(seed, w.scope, { notes: [...w.notes], ...lanesOf(w.notes, w.scope) }, both);
    ids.read?.(w.scope, r);
    for (const y of idsUndone(r)) why.push(`${w.label}: ${y}`);
    // each U_X found holding a balance, in index order, carried into the pool or named. The page's pool.deposit pays
    // from U_{s,i} only on a deposit note the store holds for its index (src/pool-deposit.ts runPoolDeposit's fixed
    // source); a U_X whose index has none on this device (a delivery the lost store's quote named) is named, never
    // carried here and never done
    const has = held.size === 0 ? new Set<number>() : await noted(w.scope);
    for (const f of [...held.values()].sort((x, y) => x.i - y.i)) {
      signal.throwIfAborted();
      const named = await carryUx(ux, f, has.has(f.i), signal);
      if (named !== null) why.push(`${w.label}: deposit index ${f.i}'s one-time wallet ${f.u} ${named}`);
    }
  }
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
 * (`noted` false: the store holds no deposit note for its index, which pool.deposit's fixed source pays from).
 */
async function carryUx(ux: PoolUxReads, f: PoolUx, noted: boolean, signal: AbortSignal): Promise<string | null> {
  let before: bigint | null = null;
  for (;;) {
    const [a, b] = await ux.balances(f);
    if (a !== b) return `reads ${String(a)} and ${String(b)} on the pool chain's two RPCs: read again`;
    if (before !== null && a >= before) return `holds ${String(a)} after a deposit from it filled: read again`;
    if (a < ux.ladder.min) return null;
    const c = await ux.costs(f);
    if (a < c.floor) return null;
    const amount = askOf(ux.ladder, a, c.perRung, c.keep);
    if (amount === 0n) return null;
    if (!noted) return `holds ${String(a)}, with no deposit note on this device for its index to carry it into the pool`;
    signal.throwIfAborted();
    const end = await ux.deposit(f, amount, signal);
    if (end !== "filled" && end !== "part_filled") return `holds ${String(a)}; its carry into the pool ended ${end}: restore again to carry it`;
    before = a;
  }
}

/** A pool walked: its label, chain, scope, notes, and its U_X reads on its own chain (null: none on this page). */
type Walked = { label: string; chain: PoolChain; scope: bigint; notes: readonly RestoredNote[]; ux: PoolUxReads | null };

/** A pinned pool's chain: Solana, or the app chain of its EVM network (Base Sepolia is Base's, as src/pools.ts names it). */
const chainOf = (p: RestorePool): PoolChain => (p.chain === "solana" ? "solana" : p.pin.network === "base" || p.pin.network === "base-sepolia" ? "base" : "robinhood");

const EVM_PAGE: Readonly<Record<"base" | "robinhood", EvmNetwork>> = POOL_TESTNET ? { base: "base-sepolia", robinhood: "robinhood-testnet" } : { base: "base", robinhood: "robinhood" };

/** Every pool the page's network pins (PAGE_SOL_PIN, EVM_POOLS on the page's networks), each with the page's reads. */
export function pagePools(): RestorePool[] {
  const out: RestorePool[] = [];
  if (PAGE_SOL_PIN !== undefined) out.push({ chain: "solana", program: PAGE_SOL_PIN.program, scope: solanaPoolOf(PAGE_SOL_PIN.program).scope, rpcs: pageSolanaRpcs });
  for (const chain of ["base", "robinhood"] as const) {
    const pin = EVM_POOLS[EVM_PAGE[chain]];
    if (pin === undefined) continue;
    const net = pin.network;
    // the pool's scope as src/pools.ts names it (evmPoolScopeOf on the pool's lowercased address and chain id)
    const scope = evmPoolScopeOf(pin.pool.toLowerCase(), EVM_CHAIN_IDS[net]);
    // the testnet lists sit behind POOL_TESTNET, folded at build time, so SIGN_HOST's bundle carries none of them
    if (POOL_TESTNET && (net === "base-sepolia" || net === "robinhood-testnet"))
      out.push({ chain: "evm", pin, scope, rpcs: () => TESTNET_RPCS[chain].map((u) => testnetRpc(u)) });
    // mainnet: the page has no EVM pool list yet (src/pool-testnet.ts testnetPoolDeps answers null), so a pin there is
    // read by no one until its list lands, and the run says so (stalled), never done
    else out.push({ chain: "evm", pin, scope, rpcs: null });
  }
  return out;
}

/** What the restore reads on, each called when a run starts. */
export type PoolRestoreHost = {
  store(): Promise<WalletStore>;
  seed64(): Promise<Uint8Array>;
  /** Whether a seed is stored: a restore asked with none is refused not_allowed, and nothing is read. */
  signedIn(): Promise<boolean>;
  /** The pools to read (pagePools unless given). */
  pools?: () => readonly RestorePool[];
  /** Web Locks (navigator.locks otherwise). */
  locks?: Pick<LockManager, "request" | "query">;
  /** After the notes are written: the page's proof queue's pass, so a restored note can pay the next buy. */
  written?: () => void;
  /** Step 5's reads (pageIdReads unless given; null: no deposit id is read). */
  ids?: IdReads | null;
  /** A pool chain's U_X reads and carry (the pool follow's own, src/main.ts), or null when the page has none there: that
   *  pool's scope then ends stalled, POOL_CHAIN_UNREAD. None given: null on every chain. */
  ux?: (chain: PoolChain) => PoolUxReads | null;
  /** The run's end and each reason it is not done (empty when done): the op record holds the kit's stage only. */
  ended?: (stage: RestoreStage, why: readonly string[]) => void;
  /** Tests only: the beat, the clock and the two restores (the wallet's otherwise). */
  beatMs?: number;
  now?: () => number;
  solana?: typeof solanaRestoreNotes;
  evm?: typeof evmRestoreNotes;
};

type Run = { done: Promise<RestoreStage>; follow(id: string, progress?: (s: RestoreStage) => void): void };

export type PoolRestore = {
  /** The `restore` kind's handler: "started" once the seed is read as stored (else not_allowed), the run's stages after. */
  kind(params: Record<string, unknown>, ctx: KindContext): Deferred<"restore">;
  /** After a sign-in: a run under its own op id when the note store holds no note; resolves to its end (or null). */
  auto(): Promise<RestoreStage | null>;
  /** This tab signed out: the run in flight stops. */
  signedOut(): void;
  /** A signed-in load: every restore op still running whose run no tab holds is written stalled. */
  settle(): Promise<void>;
};

export function poolRestore(h: PoolRestoreHost): PoolRestore {
  const beat = h.beatMs ?? RESTORE_BEAT_MS;
  const now = h.now ?? Date.now;
  const locks = (): Pick<LockManager, "request" | "query"> => h.locks ?? navigator.locks;
  let run: Run | null = null;
  let abort: AbortController | null = null;

  const read = async (signal: AbortSignal): Promise<RestoreStage> => {
    const pools = (h.pools ?? pagePools)();
    const solana = h.solana ?? solanaRestoreNotes;
    const evm = h.evm ?? evmRestoreNotes;
    const ids = h.ids === undefined ? pageIdReads() : h.ids;
    // each reason the run is not done, as found; the run's end is told once with them (`ended`), a throw or an abort
    // included (review of e31892ef, P3-5)
    const why: string[] = [];
    let told = false;
    const end = (stage: RestoreStage): RestoreStage => {
      if (!told) {
        told = true;
        h.ended?.(stage, why);
      }
      return stage;
    };
    // the restore lock, held for the run (each tab's runs in turn); the seed's lock only for each use of the seed
    return locks().request(RESTORE_LOCK, { mode: "exclusive", signal }, async (): Promise<RestoreStage> => {
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
          if (!(await h.signedIn())) throw new Error("signed out during the restore");
          const s = await h.seed64();
          try {
            const m = hmac(sha256, runKey, s);
            if (mark === null) mark = m;
            else {
              const same = m.length === mark.length && m.every((x, k) => x === mark![k]);
              m.fill(0);
              if (!same) throw new Error("other words were signed in during the restore");
            }
            return await fn(s);
          } finally {
            s.fill(0);
          }
        }) as Promise<T>;
      // the seed for one use
      const seed: SeedUse = (use) => seedHeld(async (s) => use(s));
      try {
        const found: RestoredNote[] = [];
        // each pool on its own: one that fails leaves the others' notes found
        const label = (p: RestorePool): string => (p.chain === "solana" ? "solana" : p.pin.network);
        const reads = pools.map(async (p): Promise<RestoredNote[]> => {
          if (p.rpcs === null) throw new Error("no reads on this page");
          if (p.chain === "solana") return (await solana({ seed64: seed, program: p.program, rpcs: p.rpcs(), signal })).notes;
          // the notes only: no W is read or named to a provider for a record the page keeps none of
          return (await evm({ seed64: seed, pin: p.pin, rpcs: p.rpcs(), signal, wallets: false })).notes;
        });
        const walked: Walked[] = [];
        (await Promise.allSettled(reads)).forEach((r, k) => {
          if (r.status === "fulfilled") {
            found.push(...r.value);
            const chain = chainOf(pools[k]!);
            walked.push({ label: label(pools[k]!), chain, scope: pools[k]!.scope, notes: r.value, ux: h.ux?.(chain) ?? null });
          } else why.push(`${label(pools[k]!)}: ${r.reason instanceof Error ? r.reason.message : "the walk failed"}`);
        });
        signal.throwIfAborted();
        // the floor: the walk's notes are written before any id is read
        if (found.length > 0) {
          await seedHeld(async () => {
            const notes = await openNoteStore(await h.store());
            try {
              await writeRestored(notes, { notes: found });
            } finally {
              notes.close();
            }
          });
          h.written?.();
        }
        // step 5 on each pool walked; each reason it is not done stalls the run, a throw among them
        // the scope's deposit indices the note store holds now (the floor's notes among them), for the U_X carry
        const noted = async (scope: bigint): Promise<ReadonlySet<number>> => {
          const notes = await openNoteStore(await h.store());
          try {
            return new Set((await notes.list()).flatMap((n) => (n.ref.kind === "deposit" && n.ref.s === scope ? [n.ref.i] : [])));
          } finally {
            notes.close();
          }
        };
        if (ids !== null && walked.length > 0) await readDepositIds(seed, walked, ids, signal, why, noted).catch((e: unknown) => void why.push(`step 5 did not finish: ${e instanceof Error ? e.message : "it threw"}`));
        signal.throwIfAborted();
        return end(why.length > 0 ? "stalled" : "done");
      } finally {
        runKey.fill(0);
        mark?.fill(0);
      }
    }).catch((e: unknown): never => {
      why.push(`the restore stopped: ${e instanceof Error ? e.message : "it threw"}`);
      end("stalled");
      throw e;
    }) as Promise<RestoreStage>;
  };

  const start = (): Run => {
    if (run) return run;
    // each follower's op record, its writes in order (a stage never lands before the one it follows)
    const followers: { id: string; created: number; writes: Promise<void>; progress?: (s: RestoreStage) => void }[] = [];
    const write = (f: (typeof followers)[number], stage: RestoreStage): void => {
      f.writes = f.writes.then(async () => (await h.store()).put("ops", f.id, { kind: "restore", stage, txs: [], created_ms: f.created })).catch(() => {});
    };
    const ctl = (abort = new AbortController());
    // the beat posts "reading" again and writes nothing: the record says reading until the run ends
    const timer = setInterval(() => {
      for (const f of followers) f.progress?.("reading");
    }, beat);
    const done = read(ctl.signal)
      .catch((): RestoreStage => "stalled")
      .then((stage) => {
        clearInterval(timer);
        run = null;
        if (abort === ctl) abort = null;
        // a run this tab's sign out stopped writes nothing more: its records went with the store. The end is posted
        // once its record landed, so a reader of the op after the end never reads it behind
        if (!ctl.signal.aborted)
          for (const f of followers) {
            write(f, stage);
            f.writes = f.writes.then(() => f.progress?.(stage));
          }
        // the run's end is its records' end: each follower's last write landed (or failed)
        return Promise.all(followers.map((f) => f.writes)).then(() => stage);
      });
    const r: Run = {
      done,
      follow: (id, progress) => {
        const f = { id, created: now(), writes: Promise.resolve(), ...(progress ? { progress } : {}) };
        followers.push(f);
        // held for the run's life: a record whose lock no tab holds is a dead run's (settle)
        void locks().request(`${RESTORE_LOCK}/${id}`, { mode: "exclusive" }, () => done.catch(() => {}));
        write(f, "started");
        write(f, "reading");
        progress?.("reading");
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
        start().follow(ctx.id, (stage) => ctx.progress(stage));
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
      const r = start();
      r.follow(crypto.randomUUID());
      return r.done;
    },
    signedOut: () => abort?.abort(),
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
  };
}
