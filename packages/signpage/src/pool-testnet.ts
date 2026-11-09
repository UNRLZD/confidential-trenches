// The pool kinds' pins and providers in the testnet build (card signpage-pool-flow; ../../wallet/src/pool/network.ts).
// - Solana: the devnet pool SOL_POOLS pins in that build, read on two devnet RPCs of different operators, the pair
//   scripts/live-checks/helper-pool-senders.mjs reads the devnet Rent sysvar on (RENT_RPCS.devnet).
// - Base Sepolia and Robinhood testnet: the two RPCs each testnet pin was read on (scripts/live-checks/pool-evm-deploy.mjs
//   CHAINS, card evm-venues-pin), each answered as the app's "base" and "robinhood". A chain is pinned only when the
//   wallet's EVM_POOLS holds its testnet pool, so until then every EVM pool kind is refused, as on mainnet.
// - The flow (card signpage-pool-notes): pool.deposit on the devnet pool (src/pool-deposit.ts), with the page's own
//   note store and seed; on Base or Robinhood (card pool-deposits) pool.deposit goes to src/pool-deposit-evm.ts when that
//   chain's EVM pin exists on the page's network and the page has its two RPCs (EVM_POOLS is empty today, so it is
//   refused not_allowed); every other op is refused until its card. A signed-in load finishes the pool's INCOMING notes,
//   and so does each state read of the page while one is open (card signpage-pool-notes-2), one pass at a time.
// - The next buy's proof (card signpage-pool-notes-2): each landed deposit note runs a pass of the wallet's proof queue
//   (../../wallet/src/pool/queue.ts openProofQueue), opened at the first landing on the page's prover
//   (src/prover-host.ts, its `vault`), its own note store and a copy of the seed, with the devnet pool
//   (../../wallet/src/pool/solana.ts solanaPool: the pin, the two devnet RPCs, the helper's GET /v1/pool/fee). The queue
//   proves only UNSPENT notes, so none for a note still INCOMING. Sign out (this tab's or another's) closes the queue,
//   which frees its notes and zeroes its seed copy, and ends the prover's worker; a landing after it finds no seed.
// - pool.buy (card signpage-pool-buy): src/pool-buy.ts on the queue's ready proofs, sent through the helper's POST
//   /v1/pool/solana/send and settled through the wallet's solanaSettleSpent once it reads back. A tag 3 loads its
//   accounts from the pin's lookup table (DEVNET_TABLE, card signpage-pool-flow-run). Each state read also settles the pool's RESERVED notes (solanaSettleReserved:
//   spent, freed past the deadline, or held), so no outcome of a send leaves a note RESERVED for good.
// - pool.sell (card signpage-pool-sell): src/pool-sell.ts on the devnet pool, W one of the page's buy wallets: the Ws
//   of the pool's SPENT and RESERVED notes (../../wallet/src/pool/buy-wallets.ts spentNotesOf, buyWallets) with their
//   holdings. A testnet-only choice: those holdings are read on ONE devnet RPC (solanaHoldingsReader on the first),
//   since devnet has no helper route, and a read naming W reaches that public RPC (mainnet reads them on the helper's
//   keyed route, buy-wallets.ts). They pick W and nothing more: the sell reads W's token account and lamports again on
//   both RPCs, and the rent back after it runs only on W's buy record (pool-buy.ts BuyMints, written by the buy before
//   its send), never on these holdings; with no record it holds (delta review 8 of 5697d7a1).
//   Its ops record goes in the page's wallet store, and each state read settles a sell a closed page left INCOMING
//   (pool-sell.ts settlePoolSells), writing its record's stage.
// - On the page's own network (card signpage-pool-mainnet): main.ts builds this on every build. Nothing differs between
//   SIGN_HOST's build and the testnet build but what the network pins and reads: the Solana pool's pin (SOL_POOLS.mainnet
//   or .devnet), its lookup table (MAINNET_TABLE or DEVNET_TABLE), the Solana pair (SIGN_HOST's provider A and the
//   helper's keyed route, main.ts's pair for every Solana read, or the two devnet RPCs), the fee route's cluster, the EVM
//   pins' networks, and where a sell reads its Ws' holdings (mainnet: the helper's keyed route, never a public RPC
//   naming W; the testnet choice above). With no pin on the page's network, every pool kind is refused not_allowed and
//   nothing is read: the state read, the queue and the flow all stop at the missing pin. The testnet constants sit
//   behind POOL_TESTNET, folded at build time, so SIGN_HOST's bundle carries none of them.
import { base64 } from "@scure/base";
import { SOLANA_RPC_RETRY, solanaJsonRpc, solanaPacedRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { pageHelperRpc, pageRpc } from "./page-rpc.ts";
import { HELPER_FETCH_INIT, HELPER_V1_PATHS } from "../../kit/src/helper/v1.ts";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { openNoteStore, readNotes, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool, ReadyProof } from "../../wallet/src/pool/pool.ts";
import { openProofQueue, type ProofQueue, type QueuePass } from "../../wallet/src/pool/queue.ts";
import { poolDepositKind, type PoolDepositFrom, type PoolDepositHost } from "./pool-deposit.ts";
import { proverHost } from "./prover-host.ts";
import { SOLANA_PROVIDER_A, TRADE_HELPER } from "./trade.ts";
import { SOL_POOLS, solanaPool, solanaPoolOf, type SolanaFeeAnswer, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { solanaSettleReserved, solanaSettleSpent } from "../../wallet/src/pool/solana-restore.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { askWhileBusy, type BusyOpts } from "../../wallet/src/busy.ts";
import { POOL_SEND_BUSY_WAIT_MS, PoolSendBusy, poolBuyKind, type PoolBuyHost } from "./pool-buy.ts";
import { buyMints, keptSells, owedRentBacks, poolSellKind, resumeRentBacks, settleDeadSellOps, settlePoolSells, settleSellOps, type PoolSellKindHost } from "./pool-sell.ts";
import { buyWallets, evmHelperKeyedRpc, solanaHelperHoldings, solanaHoldingsReader, spentNotesOf } from "../../wallet/src/pool/buy-wallets.ts";
import { evmStoredHold } from "../../wallet/src/pool/evm-hold-store.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPair, evmPoolScopeOf, evmTreeSync, type EvmPoolPin, type EvmRpc, type EvmSyncHold } from "../../wallet/src/pool/evm.ts";
import { poolDepositEvmKind, type EvmDepositRound } from "./pool-deposit-evm.ts";
import type { PoolKindsDeps, PoolRpc } from "./pool-kinds.ts";
import { checkPoolRequest, type PoolAsk, type PoolChain, type PoolRequest } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import { readSolanaRent, solanaPoolFee } from "../../kit/src/trade/solana/pool-buy.ts";
import type { TxRef, WithdrawStage } from "../../kit/src/signpage/messages.ts";
import { finishPoolOnward, runPoolWithdraw, solanaOnwardFee, solanaWithdrawMinPart, withdrawSources, type Arrivals, type HistoryPlaces, type PendingOnward } from "./pool-withdraw.ts";
import type { PoolFunds, PoolReady, PoolWithdrawFormDeps } from "./withdraw/pool-form.ts";
import { EVM_POOL_HISTORY } from "../../kit/src/trade/evm/buy-unpinned.ts";

// The freezes are marked pure, so SIGN_HOST's build, which never reads these, drops them whole (scripts/build-network.test.mjs).
/** Each chain's two testnet RPCs, as the app names the chain. Solana's are mainnet's shape (main.ts: a public provider
 *  and the helper's /v1/rpc/solana): the public devnet endpoint and the helper's /v1/rpc/solana-devnet, whose keyed
 *  provider is another operator's (card pool-buy-send-fast: the public second provider before it, onfinality, answers 1
 *  request a second and 1000 a day per IP, and held the 5 Nov 13:50:55Z buy 11.2 s in these reads). */
export const TESTNET_RPCS: Readonly<Record<PoolChain, readonly [string, string]>> = /* @__PURE__ */ Object.freeze({
  solana: /* @__PURE__ */ Object.freeze(["https://api.devnet.solana.com", `${TRADE_HELPER}/v1/rpc/solana-devnet`] as const),
  // the kit's Base Sepolia pool pair (evmPoolVenues()["base-sepolia"].providers, card notes-per-pool-evm-base-hang):
  // sepolia.base.org caps a log page at 200 blocks, about 8,250 pages for the pool's life at 200 ms blocks (read
  // 2026-11-06 04:27-04:35Z); PublicNode pages 50,000 and Pocket 100,000, and both answer this page's CORS preflight
  // with 204 (04:42Z)
  base: /* @__PURE__ */ Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://base-testnet.api.pocket.network"] as const),
  robinhood: /* @__PURE__ */ Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"] as const),
});
/** One testnet RPC as the page reads it: the helper's route with the kit's HELPER_FETCH_INIT (as pageHelperRpc), any
 *  other directly; both with the page's retry. */
export const testnetRpc = (url: string): SolanaRpc => (url.startsWith(`${TRADE_HELPER}/`) ? solanaJsonRpc(url, { retry: SOLANA_RPC_RETRY, init: HELPER_FETCH_INIT }) : pageRpc(url));
const EVM_TESTNET = /* @__PURE__ */ Object.freeze({ base: "base-sepolia", robinhood: "robinhood-testnet" } as const);
/** Each EVM pool's synced tree on this device (card evm-pool-leaves-any-source; card evm-pool-sync-holds: in the wallet
 *  store, ../../wallet/src/pool/evm-hold-store.ts): one hold per pool, which the deposit's sync and the restore's both
 *  keep and read, on this page and every later one, so each reads only the blocks past the last one's and a new page
 *  never needs the pool's deploy block once a page synced it. A sign out deletes it with the store. */
const EVM_HOLDS = new Map<string, EvmSyncHold>();
/** `store`: the page's wallet store when one is open, never opening one (TestnetPage.held, review of 7eb8cfb9, P2-2). */
export const pageEvmHold = (pin: EvmPoolPin, store: () => Promise<WalletStore>): EvmSyncHold => {
  const key = `${pin.network}:${pin.pool.toLowerCase()}`;
  let h = EVM_HOLDS.get(key);
  if (h === undefined) EVM_HOLDS.set(key, (h = evmStoredHold(store, pin)));
  return h;
};
/** The deep public sources past each chain's pool list (card evm-pool-sync-holds): the kit's EVM_POOL_HISTORY (its
 *  reads cited there), in SIGN_HOST's connect-src; scripts/live-checks/evm-pool-sync-holds.mjs reads each one's floor. */
export const MAINNET_POOL_HISTORY: Readonly<Record<"base" | "robinhood", readonly string[]>> = EVM_POOL_HISTORY;
const HISTORY = new Map<string, readonly EvmRpc[]>();
/** Where else an EVM pool's logs are read when its seats cannot give them (evm.ts EvmSyncArgs history): on mainnet the
 *  helper's route in its keyed-only mode (POST /v1/rpc/{chain}?keyed=only, its archive providers alone, never its public
 *  fallback: a keyless seat keeps a window of logs only), one operator, then MAINNET_POOL_HISTORY's, each held to the
 *  pool's root at the head like any source and never taken on its word alone; none on a testnet, whose helper has no
 *  route for the chain. The same RPCs each time (one pace per provider). */
export const pageEvmHistory = (pin: EvmPoolPin): readonly EvmRpc[] => {
  if (pin.network !== "base" && pin.network !== "robinhood") return [];
  let h = HISTORY.get(pin.network);
  if (h === undefined) HISTORY.set(pin.network, (h = Object.freeze([evmHelperKeyedRpc(TRADE_HELPER, pin.network), ...MAINNET_POOL_HISTORY[pin.network].map((u) => pageRpc(u))])));
  return h;
};
/** Tests only: forget this page's hold objects (EVM_HOLDS; each pool's record stays in the wallet store, as on a new
 *  page). */
export const resetPageEvmHolds = (): void => EVM_HOLDS.clear();
/** Each EVM chain's mainnet pool list, the pool sync's seats first (card evm-pool-lists-mainnet): the kit's
 *  evmPoolProvidersOf(evmPoolVenues()[chain]), copied, as TESTNET_RPCS copies the testnet pairs, since the venue table
 *  carries every network's providers and SIGN_HOST's build carries no testnet one (scripts/build-network.test.mjs);
 *  test/pool-restore.test.ts holds each equal to the kit's. Its seats page the pool's logs from its deploy block, never
 *  the quote list's 10-block blastapi; SIGN_HOST's connect-src allows each (scripts/live-checks/page-evm-rpc-csp.mjs). */
export const MAINNET_POOL_RPCS: Readonly<Record<"base" | "robinhood", readonly string[]>> = /* @__PURE__ */ Object.freeze({
  base: /* @__PURE__ */ Object.freeze(["https://base-rpc.publicnode.com", "https://base.api.pocket.network"]),
  robinhood: /* @__PURE__ */ Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"]),
});
/** An EVM chain's pool list as the page reads it: the testnet pair in the testnet build, MAINNET_POOL_RPCS on mainnet. */
export const pageEvmPoolUrls = (chain: "base" | "robinhood"): readonly string[] => (POOL_TESTNET ? TESTNET_RPCS[chain] : MAINNET_POOL_RPCS[chain]);
/** The pool list as RPCs (pageRpc each, testnetRpc on the testnet build), or null with fewer than two. */
export const pageEvmPoolRpcs = (chain: "base" | "robinhood"): readonly EvmRpc[] | null => {
  const urls = pageEvmPoolUrls(chain);
  return urls.length < 2 ? null : urls.map((u) => testnetRpc(u));
};
/** The Solana pool the page's network pins: none on mainnet until pool-sol-deploy-mainnet pins it. */
export const PAGE_SOL_PIN: SolanaPoolPin | undefined = POOL_TESTNET ? SOL_POOLS.devnet : SOL_POOLS.mainnet;
/** The page's Solana cluster: the fee route's and pool.buy's (its tip). */
export const PAGE_CLUSTER: "mainnet" | "devnet" = POOL_TESTNET ? "devnet" : "mainnet";
/** The page's Solana pair: two devnet RPCs in the testnet build; SIGN_HOST's provider A and the helper's keyed route
 *  (src/trade.ts, the pair main.ts gives every Solana read, in SIGN_HOST's connect-src) on mainnet. Each paced where it
 *  is made (card solana-release-reads-paced): every pool buy, sell, withdraw, settle and restore read takes its turn in
 *  the provider's one queue, the trade's own with it. */
export const pageSolanaRpcs = (): readonly [SolanaRpc, SolanaRpc] => {
  const [a, b] = POOL_TESTNET ? [testnetRpc(TESTNET_RPCS.solana[0]), testnetRpc(TESTNET_RPCS.solana[1])] : [pageRpc(SOLANA_PROVIDER_A), pageHelperRpc(TRADE_HELPER)];
  return [solanaPacedRpc(a), solanaPacedRpc(b)];
};

/** A withdraw stage's order: a write never moves an op back (review #232b LOW 1). A stale finish's stopped never
 *  overwrites sent, nor a later part's proving its earlier part's in_transit. */
const STAGE_RANK: Readonly<Record<WithdrawStage, number>> = { proving: 0, submitted: 1, in_transit: 1, stopped: 2, refunded: 2, sent: 3 };

/** A withdraw op record's next state, merged into what the store holds (another tab may have written it since): the
 *  stage (never back, STAGE_RANK), every tx either wrote (by hash, never one dropped), every arrival, the fee a send
 *  over its ceiling needs (`fee_needed`), and `owed`, the note whose onward send the op still owes: set by `owe`,
 *  cleared by `clear` only while it is still that note's (a later part's, another tab's, stays), and its fee_needed
 *  with it. A stage written with `clear` is that note's verdict: it applies only while the op owes that note's send or
 *  none, never over a later part still owed (round-3 review probe3-merge). The owed send itself (its attempt, context,
 *  To and fee ceiling) is in meta under owed/<op id>, which the frame never reads (src/state.ts op contract);
 *  the op names only the note's random id. */
export function mergeWithdrawOp(
  v: unknown,
  w: { stage?: WithdrawStage; txs?: readonly TxRef[]; arrived?: Arrivals; owe?: string; clear?: string; feeNeeded?: string },
): Record<string, unknown> {
  const r = { ...(v as Record<string, unknown>) };
  const was = STAGE_RANK[r.stage as WithdrawStage] ?? -1;
  const ours = w.clear === undefined || r.owed === undefined || r.owed === w.clear;
  if (w.stage !== undefined && STAGE_RANK[w.stage] >= was && ours) r.stage = w.stage;
  if (w.feeNeeded !== undefined) r.fee_needed = w.feeNeeded;
  const txs = [...((r.txs as TxRef[] | undefined) ?? [])];
  for (const t of w.txs ?? []) if (!txs.some((x) => x.hash === t.hash)) txs.push(t);
  r.txs = txs;
  if (w.arrived && Object.keys(w.arrived).length > 0) r.arrived = { ...((r.arrived as Arrivals | undefined) ?? {}), ...w.arrived };
  if (w.owe !== undefined) r.owed = w.owe;
  else if (w.clear !== undefined && r.owed === w.clear) {
    delete r.owed;
    delete r.fee_needed;
  }
  // a record from before meta/owed/<op id> holds its send in `pending`: cleared the same way
  if (w.clear !== undefined && (r.pending as PendingOnward | undefined)?.noteId === w.clear) delete r.pending;
  return r;
}

/** meta/owed/<op id>, the wallet store's record of one op's owed onward sends, each note's by note id: in meta, which
 *  the frame's reader neither reads nor lists (packages/wallet/src/store WALLET_OWED_PREFIX). */
const owedKey = (opId: string): `owed/${string}` => `owed/${opId}`;
/** One op's owed onward sends: each note's by note id. */
export type OwedSends = Record<string, PendingOnward>;
/** The op's owed send for `noteId` written (awaited before its release leaves); the record's others kept. */
export const oweSend = (w: WalletStore, opId: string, p: PendingOnward): Promise<unknown> =>
  w.update("meta", owedKey(opId), (v) => ({ ...((v as OwedSends | undefined) ?? {}), [p.noteId]: p }));
/** The release's own signature added to the op's owed send for `noteId` of `attempt`, only while that send is still
 *  stored: one another tab dropped stays dropped, and the stored one keeps its own fields (fold 4, LOW). */
export const keepRelease = (w: WalletStore, opId: string, noteId: string, attempt: string, release: string): Promise<unknown> =>
  w.update("meta", owedKey(opId), (v) => {
    const r = v as OwedSends | undefined;
    const p = r !== undefined && Object.hasOwn(r, noteId) ? r[noteId] : undefined;
    if (p === undefined || p.attempt !== attempt || p.release === release) return undefined;
    return { ...r, [noteId]: { ...p, release } };
  });
/** The op's owed send for `noteId` dropped, once the op no longer owes it; a later part's stays (one compare-and-set). */
export const dropSend = (w: WalletStore, opId: string, noteId: string): Promise<unknown> =>
  w.update("meta", owedKey(opId), (v) => {
    const r = v as OwedSends | undefined;
    if (r === undefined || !Object.hasOwn(r, noteId)) return undefined;
    const { [noteId]: _gone, ...rest } = r;
    return rest;
  });
/** The op's owed send for `noteId`, or none. */
export async function owedSendOf(w: WalletStore, opId: string, noteId: string): Promise<PendingOnward | undefined> {
  const r = (await w.get("meta", owedKey(opId))) as OwedSends | undefined;
  return r !== undefined && Object.hasOwn(r, noteId) ? r[noteId] : undefined;
}
/** The reserved pass freed these notes (no release of theirs landed by their deadline): each withdraw op owing one's
 *  send is settled stopped, nothing sent, before the note can be spent again, and the send it owed dropped. */
export async function settleFreedOps(ops: WalletStore, freed: readonly string[]): Promise<void> {
  for (const k of await ops.keys("ops")) {
    const rec = (await ops.get("ops", k)) as { kind?: unknown; owed?: unknown; pending?: PendingOnward } | undefined;
    const owed = rec?.kind !== "withdraw" ? undefined : typeof rec.owed === "string" ? rec.owed : rec.pending?.noteId;
    if (owed === undefined || !freed.includes(owed)) continue;
    await ops.update("ops", k, (v) => mergeWithdrawOp(v, { stage: "stopped", clear: owed }));
    await dropSend(ops, k, owed);
  }
}
/** An op record from before meta/owed/<op id> (its pending in the op, which the frame reads): moved there. */
async function moveLegacyPending(w: WalletStore, opId: string, p: PendingOnward): Promise<void> {
  await oweSend(w, opId, p);
  await w.update("ops", opId, (v) => {
    const r = { ...(v as Record<string, unknown>) };
    if ((r.pending as PendingOnward | undefined)?.noteId !== p.noteId) return undefined;
    delete r.pending;
    r.owed = p.noteId;
    return r;
  });
}

/** The page network's deps for poolKinds, with `flow` the ops' flow (none: every checked request is refused). Mainnet
 *  reads EVM pools on no pair yet (signpage-evm-pool-trade), as main.ts did before. */
export function testnetPoolDeps(flow?: PoolKindsDeps["flow"]): PoolKindsDeps {
  return {
    pinned: (chain) => (chain === "solana" ? PAGE_SOL_PIN !== undefined : EVM_POOLS[POOL_TESTNET ? EVM_TESTNET[chain] : chain] !== undefined),
    rpcs: (chain) =>
      chain === "solana"
        ? (pageSolanaRpcs() as unknown as readonly [PoolRpc, PoolRpc])
        : POOL_TESTNET
          ? (TESTNET_RPCS[chain].map((u) => testnetRpc(u) as PoolRpc) as unknown as readonly [PoolRpc, PoolRpc])
          : null,
    ...(flow ? { flow } : {}),
  };
}

/** What the page gives the testnet flow: its wallet store and the seed, each opened when a run needs it. */
export type TestnetPage = {
  store(): Promise<WalletStore>;
  /** The wallet store while one is open, and a rejection once none is (signed out here or on another tab): never one
   *  opened, so a sync still running after a sign out never makes the store again (review of 7eb8cfb9, P2-2). The pool
   *  syncs' holds are read and written through it alone; tests without it give store(). */
  held?(): Promise<WalletStore>;
  seed64(): Promise<Uint8Array>;
  /** pool.withdraw: the page's own screen opened for the chain and the request's op id (src/main.ts); null refuses. */
  openWithdraw?(chain: PoolChain, ctx: KindContext): HostAnswer<"pool.withdraw"> | null;
};

/** Tests only: the pool, the prover, the RPCs, the fee's fetch and the thread count the page would use. */
export type TestnetOver = {
  pool?: Pool<unknown>;
  prover?: { vault: VaultProver; stop(): void };
  rpcs?: readonly [SolanaRpc, SolanaRpc];
  fetch?: typeof fetch;
  hardwareConcurrency?: number;
  /** The lookup table pool.buy loads (the network's, PAGE_TABLE, otherwise). */
  table?: string | null;
  /** Web Locks (navigator.locks otherwise); none: no RESERVED pass runs. */
  locks?: Pick<LockManager, "request" | "query"> | null;
  /** The Solana pool's pin (PAGE_SOL_PIN otherwise): tests run the page's own flow on a fake pool. */
  pin?: SolanaPoolPin;
  /** The withdraw run's clock and wait (the page's own otherwise): a test's read-back bound passes on its clock, so no
   *  run outlives its test (fold 5: each held node ~120 s on the wall clock). */
  now?: () => bigint;
  wait?: (ms: number) => Promise<void>;
  /** An EVM chain's pool pin (EVM_POOLS of the page's network otherwise), its pool list, seats first (pageEvmPoolRpcs
   *  otherwise), and its pool's event round (evmTreeSync over that list otherwise): tests run the EVM deposit flow on a fake pool. */
  evmPin?: (chain: "base" | "robinhood") => EvmPoolPin | undefined;
  evmRpcs?: (chain: "base" | "robinhood") => readonly EvmRpc[] | null;
  evmRound?: (pin: EvmPoolPin, rpcs: readonly [EvmRpc, EvmRpc], list?: readonly EvmRpc[]) => (signal?: AbortSignal) => Promise<EvmDepositRound>;
  /** The deposit kinds (poolDepositKind, poolDepositEvmKind otherwise): a test reads the hosts this page wires into them
   *  (its sign-out signal and its pass, fold review 3). */
  depositKinds?: { solana?: typeof poolDepositKind; evm?: typeof poolDepositEvmKind };
  /** The trade kinds (poolBuyKind, poolSellKind otherwise): a test reads the hosts this page wires into them (W's buy
   *  record, written by the buy host and read by the sell host; delta review 8 of 5697d7a1). */
  tradeKinds?: { buy?: typeof poolBuyKind; sell?: typeof poolSellKind };
};

/** The devnet pool's lookup table (card signpage-pool-flow-run, packages/signpage/scripts/pool-table-devnet.mjs): the pool,
 *  its pages to entry 2,047, the token programs, wSOL and the pump curve venue's program-wide accounts, created by devnet
 *  tx 4M7F8EG164qLBH4Noecx6TW22Tak9nH9oVhFeLidfbgf7W7BNfYtvULwCYRm8SzcgyaLWkDrYRvLCxGA7iszjFe8 for the pool 92YuYhb4… and read back the same on
 *  both devnet RPCs (scripts/live-checks/signpage-pool-flow.mjs reads it after every deploy). */
export const DEVNET_TABLE: string | null = "6bbfV79efN889c4iRTSTf4htv6EnurCJuz5CjMftjsyZ";
/** The mainnet pool's lookup table: none until pool-sol-deploy-mainnet makes it, so pool.buy is refused until then. */
export const MAINNET_TABLE: string | null = null;
/** The page network's lookup table. */
const PAGE_TABLE: string | null = POOL_TESTNET ? DEVNET_TABLE : MAINNET_TABLE;
/** The pool send's own window: the helper answers a tag 3 only once it has simulated and sent it, and a send may wait
 *  out a blockhash's life (~60 to 90 s), so this is over 90 s, never the client's 10 s for the pool.buy kind's answer
 *  (the kit's SIGNPAGE_TIMEOUT_MS["pool.buy"]: the run answers once both RPCs read its transaction back, or at its
 *  end, and goes on whatever the client waits; its final stage also goes out as progress). */
export const POOL_SEND_TIMEOUT_MS = 120_000;

/** POST /v1/pool/solana/send: the helper's answer as it came (pool-buy.ts reads it back on two RPCs). */
export async function helperPoolSend(pool: string, tx: Uint8Array, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const window = new AbortController();
  const t = setTimeout(() => window.abort(new DOMException(`pool send: no answer in ${POOL_SEND_TIMEOUT_MS} ms`, "TimeoutError")), POOL_SEND_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${TRADE_HELPER}/v1/pool/solana/send`, {
      ...HELPER_FETCH_INIT,
      redirect: "error",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool, tx: base64.encode(tx) }),
      signal: window.signal,
    });
    if (res.status === 429) {
      // busy (the helper's rate_limited or in_flight, or its per-caller throttle): its Retry-After (whole seconds) and
      // its code, read from a body no larger than the route's limit; pool-buy.ts sends the same bytes again after it
      const header = res.headers.get("retry-after");
      const after = header === null || header.trim() === "" ? Number.NaN : Number(header);
      const ms = Number.isInteger(after) && after >= 0 && after <= 3_600 ? after * 1_000 : POOL_SEND_BUSY_WAIT_MS.min;
      const body = new Uint8Array(await res.arrayBuffer());
      let code: PoolSendBusy["code"] = "throttled";
      try {
        const c = body.length <= 4_096 ? (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as { error?: { code?: unknown } })?.error?.code : undefined;
        if (c === "rate_limited" || c === "in_flight") code = c;
      } catch {
        // a body that is not the helper's: still its 429
      }
      throw new PoolSendBusy(code, ms);
    }
    if (res.status !== 200) throw new Error(`pool send: HTTP ${res.status}`);
    const SEND_ANSWER_MAX = HELPER_V1_PATHS.find((p) => p.method === "POST" && p.path === "/v1/pool/solana/send")!.limitBytes!;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > SEND_ANSWER_MAX) throw new Error(`pool send: an answer over ${SEND_ANSWER_MAX} B`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(t);
  }
}

const FEE_TIMEOUT_MS = 10_000;

/** GET /v1/pool/fee for the page network's pool and one epoch, as solanaPool's relayFee: the answer as the helper gave it, which
 *  solanaPool's bind refuses unless every field is this pool's, this epoch's and the fee the device computes. A busy
 *  helper (429 rate_limited, 503 upstream) is waited out and asked again, bounded (wallet busy.ts, card
 *  withdraw-fee-busy-waits); any other status refuses at once. */
export async function poolRelayFee(pool: string, epochStartMs: bigint, signal?: AbortSignal, fetchFn: typeof fetch = fetch, sleep?: BusyOpts["sleep"]): Promise<SolanaFeeAnswer> {
  const url = `${TRADE_HELPER}/v1/pool/fee?cluster=${PAGE_CLUSTER}&pool=${encodeURIComponent(pool)}&epoch=${epochStartMs}`;
  const res = await askWhileBusy(() => {
    const timeout = AbortSignal.timeout(FEE_TIMEOUT_MS);
    return fetchFn(url, { ...HELPER_FETCH_INIT, redirect: "error", method: "GET", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  }, { signal, sleep });
  if (res.status !== 200) throw new Error(`pool fee: HTTP ${res.status}`);
  // the helper's fee answer is this small (its v1 table's limit for GET /v1/pool/fee)
  const FEE_ANSWER_MAX = HELPER_V1_PATHS.find((p) => p.method === "GET" && p.path === "/v1/pool/fee")!.limitBytes!;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > FEE_ANSWER_MAX) throw new Error(`pool fee: an answer over ${FEE_ANSWER_MAX} B`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as SolanaFeeAnswer;
}

export type TestnetPool = {
  /** The pool kinds' flow: pool.deposit, pool.buy and pool.sell on the devnet pool. */
  flow: NonNullable<PoolKindsDeps["flow"]>;
  /** pool.deposit on the page's Solana pool from one fixed U_{s,i} (card pool-deposit-follow, review H1: the follow of a
   *  quote into U_X): the request checked by the pool rule as the kind's own, then run with `from`; never another U. */
  depositFrom(params: Record<string, unknown>, from: PoolDepositFrom, ctx: KindContext): HostRefusal | Running<"pool.deposit">;
  /** The deposit run's host (a new one per run): its `landed` runs the proof queue's pass. */
  host(): PoolDepositHost;
  /** The INCOMING notes finished (src/pool-deposit.ts settlePoolDeposits), one pass at a time: a signed-in load. */
  settle(): Promise<void>;
  /** A signed-in state read, when no pass runs: settle the pool's INCOMING notes, then its RESERVED ones. */
  stateRead(): Promise<void>;
  /** The proof queue's pass, the queue opened first when none is: what each landed note runs. */
  proofs(): Promise<QueuePass | null>;
  /** state.pools' `ready` (src/pools.ts) with `read`'s notes, in one turn of the queue's view (queue.ts readyWith), so
   * a remake's swap never falls between the two (card pool-ready-no-flicker); `ready` undefined while no queue is open.
   * `read` waits for nothing of the queue's. */
  readyWith<T>(read: () => Promise<T>): Promise<{ ready: readonly ReadyProof[] | undefined; value: T }>;
  /** `fn` runs after each pass that made or remade a proof: a proof made changes no store record (its note was HELD
   * before it began), so the page's state is read again on this. */
  watch(fn: () => void): void;
  /** Sign out: the queue closed (its notes freed, its seed copy zeroed), its note store closed, the worker ended. */
  signedOut(): Promise<void>;
  /** The pool withdraw screen's reads and run (src/withdraw/pool-form.ts) for the request's op id. */
  withdrawDeps(chain: PoolChain, opId: string): PoolWithdrawFormDeps;
  /** The withdraw run of a screen's checked answer, its op record written as it goes; settles at the run's end. */
  withdraw(r: PoolReady, opId: string): Promise<void>;
};

/** The testnet build's devnet pool on this page: the deposit flow, its settling and the next buy's proofs. */
export function testnetPool(page: TestnetPage, over: TestnetOver = {}): TestnetPool {
  const pin = over.pin ?? PAGE_SOL_PIN;
  const rpcs = (): readonly [SolanaRpc, SolanaRpc] => over.rpcs ?? pageSolanaRpcs();
  const prover = over.prover ?? proverHost();
  const solanaDepositKind = over.depositKinds?.solana ?? poolDepositKind;
  const evmDepositKind = over.depositKinds?.evm ?? poolDepositEvmKind;

  // the notes a withdraw op (any tab's) still owes an onward send for: out of every plan and of the proof queue until
  // that op is settled, since a note's W is the same for every spend of it (review #232b MEDIUM 1)
  const owedNotes = async (): Promise<ReadonlySet<string>> => {
    const ops = await page.store();
    const out = new Set<string>();
    for (const k of await ops.keys("ops")) {
      const rec = (await ops.get("ops", k)) as { kind?: unknown; owed?: unknown; pending?: PendingOnward } | undefined;
      if (rec?.kind !== "withdraw") continue;
      if (typeof rec.owed === "string") out.add(rec.owed);
      if (rec.pending) out.add(rec.pending.noteId);
    }
    return out;
  };
  // the proof queue: opened at the first landing, closed at sign out
  let open: Promise<{ queue: ProofQueue<unknown>; notes: NoteStore }> | null = null;
  const openQueue = async (): Promise<{ queue: ProofQueue<unknown>; notes: NoteStore }> => {
    const notes = await openNoteStore(await page.store());
    let seed64: Uint8Array | null = null;
    try {
      seed64 = await page.seed64();
      const pool = over.pool ?? solanaPool({ pin: pin!, rpcs: rpcs(), relayFee: (e, s) => poolRelayFee(solanaPoolOf(pin!.program).pool, e, s, over.fetch) });
      const hardwareConcurrency = over.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency;
      return { queue: openProofQueue({ seed64, notes, pool, provers: [prover.vault], hardwareConcurrency, skip: owedNotes }), notes };
    } catch (e) {
      notes.close();
      throw e;
    } finally {
      seed64?.fill(0); // the queue keeps its own copy
    }
  };
  const watchers = new Set<() => void>();
  const proofs = async (): Promise<QueuePass | null> => {
    const p = (open ??= openQueue());
    try {
      const pass = await (await p).queue.refresh();
      if (pass.made.length > 0 || pass.remade.length > 0) for (const f of watchers) f();
      return pass;
    } catch {
      // a queue that could not open (no seed: signed out) is dropped, so the next landing opens it again
      if (open === p) await p.then(() => {}, () => void (open = null));
      return null;
    }
  };
  // the deposit ends' reads after a run (pool-deposit-sent-end): stopped when the page leaves the deposit (sign out)
  let follows = new AbortController();
  const signedOut = async (): Promise<void> => {
    follows.abort();
    follows = new AbortController();
    const p = open;
    open = null;
    prover.stop();
    if (!p) return;
    const q = await p.catch(() => null);
    if (!q) return;
    try {
      await q.queue.close();
    } finally {
      q.notes.close();
    }
  };

  const host = (end?: () => void): PoolDepositHost => {
    let notes: NoteStore | null = null;
    return {
      pin: pin!,
      rpcs: rpcs(),
      notes: async () => (notes = await openNoteStore(await page.store())),
      records: async () => readNotes(await page.store()),
      seed64: page.seed64,
      landed: () => void proofs(),
      settle: () => void settleSolana(),
      signal: follows.signal,
      end: () => {
        notes?.close();
        end?.();
      },
    };
  };

  const deposit = solanaDepositKind(() => host());
  // pool.deposit on Base or Robinhood: only with the chain's pin on the page's network and its two RPCs
  const evmPin = over.evmPin ?? ((chain: "base" | "robinhood") => EVM_POOLS[POOL_TESTNET ? EVM_TESTNET[chain] : chain]);
  // the chain's pool list (pageEvmPoolRpcs): the sync reads all of it, seats and spares; the deposit's own reads its seats
  const evmRpcs = over.evmRpcs ?? pageEvmPoolRpcs;
  const evmRound =
    over.evmRound ??
    ((p: EvmPoolPin, r: readonly [EvmRpc, EvmRpc], list: readonly EvmRpc[] = []) => {
      // the deposit's own pair (one evmPair, its seats bound by every read), the page's hold, and as sources the list's
      // providers, then the page's history
      const sync = evmTreeSync({ rpcs: r, pin: p, held: pageEvmHold(p, () => page.held ? page.held() : page.store()), history: [...list, ...pageEvmHistory(p)] });
      return async (signal?: AbortSignal): Promise<EvmDepositRound> => {
        const round = await sync.events(signal);
        return { events: round.events, finalBlock: round.fin.number };
      };
    });
  // each EVM chain's pool on this page: its pin, its two RPCs and its round, made once
  const evmPools = new Map<"base" | "robinhood", { pin: EvmPoolPin; rpcs: readonly [EvmRpc, EvmRpc]; round: () => Promise<EvmDepositRound>; scope: bigint } | null>();
  const evmPool = (chain: "base" | "robinhood") => {
    if (!evmPools.has(chain)) {
      const p = evmPin(chain);
      const r = p === undefined ? null : evmRpcs(chain);
      // one pair for the deposit's reads and its sync's (review of evm-pool-lists-mainnet, P3-1)
      const pair = r === null || r.length < 2 ? null : evmPair(r);
      evmPools.set(chain, p === undefined || r === null || pair === null ? null : { pin: p, rpcs: pair, round: evmRound(p, pair, r), scope: evmPoolScopeOf(p.pool, EVM_CHAIN_IDS[p.network]) });
    }
    return evmPools.get(chain)!;
  };
  const evmKind = (chain: "base" | "robinhood", end?: () => void) => {
    const e = evmPool(chain);
    if (e === null) return null;
    return evmDepositKind(() => {
      let notes: NoteStore | null = null;
      return {
        pin: e.pin,
        testnet: POOL_TESTNET,
        rpcs: e.rpcs,
        round: e.round,
        notes: async () => (notes = await openNoteStore(await page.store())),
        records: async () => readNotes(await page.store()),
        seed64: page.seed64,
        settle: () => void settleEvm(chain),
        signal: follows.signal,
        end: () => {
          notes?.close();
          end?.();
        },
      };
    });
  };
  const evmDeposit = (chain: "base" | "robinhood") => evmKind(chain);
  // an EVM pool's INCOMING notes finished with no ask (src/pool-deposit-evm.ts, the Solana pass's rule), one pass per
  // chain at a time: on a signed-in load and on each state read while such a note is open
  const evmSettling = new Map<"base" | "robinhood", Promise<void>>();
  const settleEvm = (chain: "base" | "robinhood"): Promise<void> => {
    const now = evmSettling.get(chain);
    if (now) return now;
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r)).finally(() => {
      if (evmSettling.get(chain) === p) evmSettling.delete(chain);
    });
    evmSettling.set(chain, p);
    const kind = evmKind(chain, done);
    const r = kind === null ? ({ error: "not_allowed" } as const) : kind(null, null);
    if ("error" in r) done();
    else
      // a pass that meets a take not final yet rejects (EvmNotFinalError): the settle ends, the note stays open
      void r.after.then(
        () => {
          const a = r.answer();
          if (a === null || "error" in a) done();
        },
        () => done(),
      );
    return p;
  };
  /** The EVM chains whose pool has an INCOMING note of its own scope in the store. */
  const evmOpen = async (): Promise<("base" | "robinhood")[]> => {
    const pools = (["base", "robinhood"] as const).filter((c) => evmPool(c) !== null);
    if (pools.length === 0) return [];
    const all = await readNotes(await page.store());
    return pools.filter((c) => all.some((n) => n.scope === evmPool(c)!.scope && n.state === "INCOMING"));
  };
  const settleEvmOpen = async (): Promise<void> => {
    await Promise.all((await evmOpen()).map(settleEvm));
  };
  // pool.buy: the open queue's ready proofs; one run per tap, each picking a proof no other run of this page holds
  const table = over.table === undefined ? PAGE_TABLE : over.table;
  const claimed = new Set<string>();
  const buyHost = (): PoolBuyHost & { end(): void } => {
    let notes: NoteStore | null = null;
    // the queue, opened when it is not; one that cannot open (signed out) is dropped, so the next tap opens it again
    const q = async (): Promise<ProofQueue<SolanaReleaseRequest>> => {
      const p = (open ??= openQueue());
      try {
        return (await p).queue as ProofQueue<SolanaReleaseRequest>;
      } catch (e) {
        if (open === p) open = null;
        throw e;
      }
    };
    return {
      pin: pin!,
      table,
      cluster: PAGE_CLUSTER,
      rpcs: rpcs(),
      claimed,
      // none ready (a page that has landed no deposit since it loaded has run no pass): a pass starts for the next tap
      ready: async () => {
        const list = (await q()).ready();
        if (list.length === 0) void proofs();
        return list;
      },
      take: async (id, attempt) => (await q()).take(id, attempt),
      seed64: page.seed64,
      // W's buy mint, written before the send: the rent back after a later sell holds while W holds any of it
      bought: buyMints(page.store),
      send: (pool, tx) => helperPoolSend(pool, tx, over.fetch),
      settle: async (noteId) => {
        const seed64 = await page.seed64();
        try {
          notes ??= await openNoteStore(await page.store());
          return await solanaSettleSpent({ seed64, notes, noteId, program: pin!.program, rpcs: rpcs() });
        } finally {
          seed64.fill(0);
        }
      },
      end: () => notes?.close(),
    };
  };
  const buy = (over.tradeKinds?.buy ?? poolBuyKind)(() => buyHost());
  let settling: Promise<void> | null = null;
  const settle = (): Promise<void> => Promise.all([settleSolana(), settleEvmOpen().catch(() => {})]).then(() => {});
  const settleSolana = (): Promise<void> => {
    if (pin === undefined) return Promise.resolve();
    if (settling) return settling;
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r)).finally(() => {
      if (settling === p) settling = null;
    });
    settling = p;
    const r = solanaDepositKind(() => host(done))(null, null);
    // refused before it ran (no Web Locks), or failed before its host was made: no end will come
    if ("error" in r) done();
    else
      void r.after.then(() => {
        const a = r.answer();
        if (a === null || "error" in a) done();
      });
    return p;
  };
  const scope = pin === undefined ? null : solanaPoolOf(pin.program).scope;
  // pool.sell: W from the page's buy wallets; one run per tap, one at a time (the sell kind's lock)
  const sellHost = (): PoolSellKindHost & { end(): void } => {
    const r = rpcs();
    let notes: Promise<NoteStore> | null = null;
    const store = (): Promise<NoteStore> => (notes ??= page.store().then((w) => openNoteStore(w)));
    return {
      pin: pin!,
      rpcs: r,
      notes: store,
      ops: page.store,
      seed64: page.seed64,
      // the pool's Ws with their holdings: on mainnet through the helper's keyed route, in the testnet build on one devnet
      // RPC (the header's testnet-only choice); none: no read
      wallets: async () => {
        const spent = await spentNotesOf(await store(), scope!);
        if (spent.length === 0) return [];
        const seed64 = await page.seed64();
        try {
          const got = await buyWallets(seed64, [{ id: pin!.program, chain: "sol", spent, reader: POOL_TESTNET ? solanaHoldingsReader(r[0]) : solanaHelperHoldings(TRADE_HELPER) }]);
          if (got.failed.length > 0) throw new Error("the buy wallets' holdings could not be read");
          return got.wallets;
        } finally {
          seed64.fill(0);
        }
      },
      // the rent backs owed (card sol-buy-rent-back), run again at the next load while owed
      owed: owedRentBacks(page.store),
      bought: buyMints(page.store),
      // each rent-back fault and end, on the page's console: public words only (W's address, a step, a fault's name)
      told: (t) => console.warn(`rent back ${t.address} ${t.step} ${t.state}: ${t.detail}`),
      // the sells with no deposit back (kept on W) sent and not settled yet, settled at the next load
      kept: keptSells(page.store),
      end: () => void notes?.then((n) => n.close(), () => {}),
    };
  };
  const sell = (over.tradeKinds?.sell ?? poolSellKind)(() => sellHost());
  // the sells a closed or reloaded page left INCOMING: each settled by the run's own verdict rules, its ops record's
  // stage written; under the seed's shared lock, as every pass that writes the store (a sign out waits for it)
  const settleSells = async (): Promise<void> => {
    if (!locks) return;
    await locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
      const notes = await openNoteStore(await page.store());
      try {
        const ops = await page.store();
        // each sell's stage written before its record goes (a write that fails keeps it for the next read)
        await settlePoolSells({ pin: pin!, rpcs: rpcs(), notes: async () => notes, kept: keptSells(page.store), settled: (signature, stage) => settleSellOps(ops, signature, stage) }, locks);
      } finally {
        notes.close();
      }
    });
  };
  // one state read's pass at a time: set before its first await, so a read that comes while it runs (its note read
  // included) gets the same promise and never starts a second pass. No follow-up pass: a note turns INCOMING only in an
  // ask's run, which holds POOL_DEPOSIT_LOCK and finishes that note itself; a later state read settles what it leaves.
  let reading: Promise<void> | null = null;
  // a state read's proof pass, while it runs (a landing's or a tap's pass runs on its own)
  let passing: Promise<unknown> | null = null;
  // the dead pending sell records are settled once per page load, not on every state read (a re-ask settles its own)
  let deadSettled = false;
  let backsResumed = false;
  // the RESERVED notes a buy left (filled, refused, never answered, or its page closed mid-send): settled spent, freed
  // once both RPCs' block time is past their deadline with no spent mark, or held (../../wallet/src/pool/solana-restore.ts
  // solanaSettleReserved); a freed note is proved again by the open queue's next pass
  // It holds a seed copy, so it runs under the seed's shared lock, as every run that does (a sign out, in any tab, waits
  // for it; one that came first leaves no seed, and the pass ends at its seed read). No Web Locks: no pass.
  const locks = over.locks === undefined ? (globalThis.navigator?.locks ?? null) : over.locks;
  const settleReserved = async (): Promise<void> => {
    if (!locks) return;
    await locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
      const notes = await openNoteStore(await page.store());
      let seed64: Uint8Array | null = null;
      try {
        seed64 = await page.seed64();
        const pass = await solanaSettleReserved({ seed64, notes, program: pin!.program, rpcs: rpcs() });
        // a freed note's release never landed: an op owing its send is settled stopped, nothing sent, before the note
        // can be spent again
        if (pass.freed.length > 0) await settleFreedOps(await page.store(), pass.freed);
        if (pass.freed.length > 0 && open !== null) void proofs();
      } finally {
        seed64?.fill(0);
        notes.close();
      }
    });
  };
  // a withdraw a crash or a lost send left in_transit (its part on W): W's send onward again, from W's own balance
  // (0: it was sent), under the seed's shared lock; never one this page's own run is still on (`withdrawing`). Two
  // tabs at once send the same balance: the first to land leaves W at 0, and the other cannot pay its fee.
  // The ops are read once per page load (a crash leaves one only across a load), and again after this page's own run
  // left one owed, until none is.
  const withdrawing = new Set<string>();
  let owedScan = true;
  // a finish that failed (a read, the send) is tried again after a wait that doubles, 2 s up to 60 s: the money is on
  // W, so it never gives up, and never hammers the RPCs either
  const owedRetry = new Map<string, { at: number; waitMs: number }>();
  // each owed op's places in W's history, kept from one pass to the next (the RPC functions are new on every pass):
  // a history of any length is read to its end, a share per pass (fold 4, review HIGH)
  const owedPlaces = new Map<string, HistoryPlaces>();
  const placesOf = (k: string): HistoryPlaces => {
    let p = owedPlaces.get(k);
    if (!p) owedPlaces.set(k, (p = new Map()));
    return p;
  };
  // one use of the seed under its shared lock, the lock let go after it: a sign out waits for a derive or a signature,
  // never for a blockhash (review #232b LOW 2)
  const withSeed = <T,>(f: (seed64: Uint8Array) => T | Promise<T>): Promise<T> =>
    locks!.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
      const seed64 = await page.seed64();
      try {
        return await f(seed64);
      } finally {
        seed64.fill(0);
      }
    });
  const finishOnward = async (): Promise<void> => {
    if (!locks || pin === undefined || !owedScan) return;
    owedScan = false;
    const ops = await page.store();
    const owed: [string, PendingOnward][] = [];
    for (const k of await ops.keys("ops")) {
      if (withdrawing.has(k)) continue;
      const rec = (await ops.get("ops", k)) as { kind?: unknown; owed?: unknown; pending?: PendingOnward } | undefined;
      if (rec?.kind !== "withdraw") continue;
      if (rec.pending) await moveLegacyPending(ops, k, rec.pending);
      const id = rec.pending?.noteId ?? rec.owed;
      // any stage: `owed` names the note whose send the op owes (a tab closed during the release leaves "proving");
      // its send is meta/owed/<op id>'s record (none yet: written but not marked, or the other way: read again later)
      const p = typeof id === "string" ? await owedSendOf(ops, k, id) : undefined;
      if (p) owed.push([k, p]);
      else if (typeof id === "string") owedScan = true;
    }
    if (owed.length === 0) return;
    const notes = await openNoteStore(await page.store());
    try {
      for (const [k, pending] of owed) {
        const retry = owedRetry.get(k);
        if (retry && Date.now() < retry.at) {
          owedScan = true;
          continue;
        }
        const got = await finishPoolOnward(
          {
            pin,
            rpcs: rpcs(),
            seed64: page.seed64,
            withSeed,
            places: placesOf(k),
            notes: async () => notes,
            settle: (noteId) => withSeed((seed64) => solanaSettleSpent({ seed64, notes, noteId, program: pin.program, rpcs: rpcs() })),
          },
          pending,
        );
        if (got?.feeNeeded !== undefined) {
          // over the drawn Max fee: still owed, the fee it needs in the op for the screen to draw again
          await ops.update("ops", k, (v) => mergeWithdrawOp(v, { feeNeeded: got.feeNeeded! }));
          const waitMs = Math.min(Math.max(2_000, (retry?.waitMs ?? 1_000) * 2), 60_000);
          owedRetry.set(k, { at: Date.now() + waitMs, waitMs });
          owedScan = true;
        } else if (got) {
          owedRetry.delete(k);
          owedPlaces.delete(k);
          await ops.update("ops", k, (v) => mergeWithdrawOp(v, { stage: got.stage, txs: got.txs, arrived: got.arrived, clear: pending.noteId }));
          await dropSend(ops, k, pending.noteId);
        } else {
          const waitMs = Math.min(Math.max(2_000, (retry?.waitMs ?? 1_000) * 2), 60_000);
          owedRetry.set(k, { at: Date.now() + waitMs, waitMs });
          owedScan = true;
        }
      }
    } finally {
      notes.close();
    }
  };
  const stateRead = (): Promise<void> => {
    // the EVM pools' open deposits settle on every state read, beside the Solana pool's (none pinned: only theirs)
    if (scope === null) return settleEvmOpen().catch(() => {});
    if (reading) return reading;
    const p = (async () => {
      try {
        await settleEvmOpen().catch(() => {});
        if (settling) return await settling;
        const mine = (await readNotes(await page.store())).filter((n) => n.scope === scope);
        if (mine.some((n) => n.state === "INCOMING")) await settleSolana();
        // a failed reserved pass never holds back a send owed (the money on W): the finish below still runs
        if (mine.some((n) => n.state === "RESERVED")) await settleReserved().catch(() => {});
        // a sell's note left INCOMING, or a sell with no deposit back (no note) left sent: both settled by the sell's verdict
        if (mine.some((n) => n.state === "INCOMING" && (n.ref.kind === "return" || (n.ref.kind === "second" && n.ref.id.id === "R"))) || (await keptSells(page.store).list().catch(() => [])).length > 0) await settleSells();
        // the next buy's proofs (card signpage-pool-pins): a page that loads with the pool's notes landed opens the
        // queue, and each read while it is open makes the epoch's proofs again, one pass at a time
        if (open !== null || mine.some((n) => n.state === "UNSPENT" || n.state === "HELD")) passing ??= proofs().finally(() => (passing = null));
        await finishOnward();
        // a sell request whose page closed before it signed: refused "failed", so its id is never id_reused for good
        if (locks && !deadSettled) {
          await settleDeadSellOps(await page.store(), locks);
          deadSettled = true;
        }
        // the rent backs a closed page or a provider's fault left owed (card sol-buy-rent-back): once per load, after
        // the sells settle, in the background (it reads, checks and sends), under the seed's shared lock and the sell lock
        if (locks && !backsResumed) {
          backsResumed = true;
          void locks
            .request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
              const h = sellHost();
              try {
                await resumeRentBacks(h, locks);
              } finally {
                h.end();
              }
            })
            .catch(() => {});
        }
      } catch {
        // a state read never fails for this; the next read tries again
      }
    })().finally(() => {
      if (reading === p) reading = null;
    });
    reading = p;
    return p;
  };
  // pool.withdraw (card signpage-pool-withdraw-form): the screen's funds are the pool's landed notes this page may
  // spend (UNSPENT, or HELD by its own queue for the next buy, dropped first by the run), the epoch fee and the
  // smallest part, from the Rent sysvar read on both RPCs; the run proves each part on demand (src/pool-withdraw.ts)
  const queued = async (): Promise<ProofQueue<SolanaReleaseRequest> | null> => (open ? ((await open.catch(() => null))?.queue as ProofQueue<SolanaReleaseRequest> | undefined) ?? null : null);
  const funds = async (): Promise<PoolFunds> => {
    const r = rpcs();
    const rent = await readSolanaRent(r);
    const notes = await openNoteStore(await page.store());
    try {
      const mine = new Set((await queued())?.ready().map((p) => p.noteId) ?? []);
      const fee = solanaPoolFee(rent);
      const wFee = await solanaOnwardFee(r, pin!);
      const owed = await owedNotes();
      return { notes: withdrawSources(await notes.list(), scope!, mine).filter((n) => !owed.has(n.id)), fee, wFee, minPart: solanaWithdrawMinPart(rent, fee, wFee) };
    } finally {
      notes.close();
    }
  };
  const withdraw = async (ready: PoolReady, opId: string): Promise<void> => {
    if (ready.chain !== "solana" || pin === undefined || !locks) return;
    withdrawing.add(opId);
    try {
      await withdrawRun(ready, opId);
    } finally {
      withdrawing.delete(opId);
    }
  };
  const withdrawRun = async (ready: PoolReady, opId: string): Promise<void> => {
    if (pin === undefined || !locks) return;
    const ops = await page.store();
    const created_ms = Date.now();
    let writes: Promise<unknown> = ops.put("ops", opId, { kind: "withdraw", stage: "proving", txs: [], created_ms }).catch(() => {});
    // the op keeps the onward send still owed (a part on W), for the state reads to finish after a crash; every write
    // merges into the record (mergeWithdrawOp), so another tab's finish of a part is never written over. Only owe()
    // names the note owed, once its send is stored: a stage write never does, so a run ending in_transit after another
    // tab settled the op never names a send with none behind it (fold 5, review LOW)
    let owedNote: string | null = null;
    const write = (stage: WithdrawStage, txs: TxRef[], pending: PendingOnward | null, arrived: Arrivals) => {
      const cleared = pending ? null : owedNote;
      void (writes = writes
        .then(async () => {
          await ops.update("ops", opId, (v) => mergeWithdrawOp(v, { stage, txs, arrived, ...(cleared ? { clear: cleared } : {}) }));
          if (cleared) await dropSend(ops, opId, cleared);
        })
        .catch(() => {}));
    };
    // written before the part's release leaves, and awaited: a failed write sends nothing; the send in the meta/owed/<op id>
    // store first, then the op's in_transit naming its note, so the stage is never "proving" while a release is out
    // (review #232b HIGH 1) and the op never names a send the store does not hold
    const owe = async (pending: PendingOnward): Promise<void> => {
      owedNote = pending.noteId;
      const w = writes.then(async () => {
        await oweSend(ops, opId, pending);
        await ops.update("ops", opId, (v) => mergeWithdrawOp(v, { stage: "in_transit", owe: pending.noteId }));
      });
      writes = w.catch(() => {});
      await w;
    };
    await locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
      const notes = await openNoteStore(await page.store());
      try {
        const q = await queued();
        const mine = new Set(q?.ready().map((p) => p.noteId) ?? []);
        const ask = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 } as const;
        const end = await runPoolWithdraw(
          {
            pin,
            rpcs: rpcs(),
            pool: (over.pool as Pool<SolanaReleaseRequest> | undefined) ?? solanaPool({ pin, rpcs: rpcs(), relayFee: (e, s) => poolRelayFee(solanaPoolOf(pin.program).pool, e, s, over.fetch) }),
            prover: prover.vault,
            notes: async () => notes,
            ...(q ? { drop: (id: string) => q.drop(id) } : {}),
            seed64: page.seed64,
            send: (p, tx) => helperPoolSend(p, tx, over.fetch),
            settle: async (noteId) => {
              const seed64 = await page.seed64();
              try {
                return await solanaSettleSpent({ seed64, notes, noteId, program: pin.program, rpcs: rpcs() });
              } finally {
                seed64.fill(0);
              }
            },
            stage: write,
            owe,
            ...(over.now ? { now: over.now } : {}),
            ...(over.wait ? { wait: over.wait } : {}),
            keepRelease: async (noteId, attempt, release) => void (await keepRelease(ops, opId, noteId, attempt, release)),
            owedNotes,
          },
          { ...ask },
          ready.to,
          ready.amount,
          ready.maxFee,
          mine,
        );
        write(end.stage, end.txs, end.pending, end.arrived);
        if (end.feeNeeded !== undefined) void (writes = writes.then(() => ops.update("ops", opId, (v) => mergeWithdrawOp(v, { feeNeeded: end.feeNeeded! }))).catch(() => {}));
        if (end.pending) owedScan = true;
      } finally {
        notes.close();
      }
    });
    await writes;
    // the change notes it wrote are proved for the next buy by the queue's next pass
    if (open !== null) void proofs();
  };
  // the sends owed whose fee rose past the Max fee drawn (fee_needed), for the screen to draw the Max fee again
  const owedFees = async (): Promise<{ opId: string; need: bigint }[]> => {
    const ops = await page.store();
    const out: { opId: string; need: bigint; t: number }[] = [];
    for (const k of await ops.keys("ops")) {
      const rec = (await ops.get("ops", k)) as { kind?: unknown; owed?: unknown; fee_needed?: unknown; created_ms?: unknown } | undefined;
      if (rec?.kind === "withdraw" && typeof rec.owed === "string" && typeof rec.fee_needed === "string" && /^(0|[1-9][0-9]{0,19})$/.test(rec.fee_needed)) {
        out.push({ opId: k, need: BigInt(rec.fee_needed), t: typeof rec.created_ms === "number" ? rec.created_ms : 0 });
      }
    }
    return out.sort((a, b) => a.t - b.t).map(({ opId, need }) => ({ opId, need }));
  };
  // the Max fee drawn again at `need`, the fee the screen showed: only while the op still owes that send at that fee;
  // its ceiling raised to it in meta/owed/<op id>, fee_needed cleared, and the finish tried again at once
  const redraw = async (opId: string, need: bigint): Promise<void> => {
    const ops = await page.store();
    const rec = (await ops.get("ops", opId)) as { owed?: unknown; fee_needed?: unknown } | undefined;
    const noteId = rec?.owed;
    if (typeof noteId !== "string" || rec?.fee_needed !== need.toString()) throw new Error("the fee shown is no longer the one owed");
    const raised = await ops.update("meta", owedKey(opId), (v) => {
      const r = v as OwedSends | undefined;
      const p = r !== undefined && Object.hasOwn(r, noteId) ? r[noteId]! : undefined;
      return p === undefined ? undefined : { ...r, [noteId]: { ...p, feeCap: need.toString() } };
    });
    if (raised === undefined) throw new Error("no send owed");
    await ops.update("ops", opId, (v) => {
      const r = { ...(v as Record<string, unknown>) };
      if (r.fee_needed !== need.toString()) return undefined;
      delete r.fee_needed;
      return r;
    });
    owedRetry.delete(opId);
    owedScan = true;
    await stateRead();
  };
  const withdrawDeps = (chain: PoolChain, opId: string): PoolWithdrawFormDeps => ({
    chain,
    keys: chain === "solana" && pin !== undefined ? { pool: solanaPoolOf(pin.program).pool, program: pin.program, feePayer: pin.feePayer } : { pool: "" },
    funds: () => (chain === "solana" && pin !== undefined ? funds() : Promise.reject(new Error("no flow for this chain"))),
    ...(chain === "solana" && pin !== undefined ? { handoff: (r: PoolReady) => void withdraw(r, opId), owedFees, redraw } : {}),
  });
  return {
    flow: (ask, ctx) =>
      ask.chain !== "solana"
        ? ask.kind === "pool.deposit"
          ? (evmDeposit(ask.chain)?.(ask, ctx) ?? { error: "not_allowed" })
          : { error: "not_allowed" }
        : pin === undefined
        ? { error: "not_allowed" }
        : ask.kind === "pool.deposit"
          ? deposit(ask, ctx)
          : ask.kind === "pool.buy" && table !== null
            ? buy(ask, ctx)
            : ask.kind === "pool.sell"
              ? sell(ask, ctx)
              : ask.kind === "pool.withdraw" && page.openWithdraw
                ? (page.openWithdraw(ask.chain, ctx) ?? { error: "not_allowed" })
                : { error: "not_allowed" },
    depositFrom: (params, from, ctx) => {
      let ask: PoolAsk;
      try {
        ask = checkPoolRequest({ ...params, kind: "pool.deposit" } as PoolRequest);
      } catch {
        return { error: "not_allowed" };
      }
      return ask.chain !== "solana" || pin === undefined ? { error: "not_allowed" } : deposit(ask, ctx, from);
    },
    host: () => host(),
    settle,
    stateRead,
    proofs,
    readyWith: async (read) => {
      const q = open ? (await open.catch(() => null))?.queue : undefined;
      return q ? q.readyWith(read) : { ready: undefined, value: await read() };
    },
    watch: (fn) => void watchers.add(fn),
    signedOut,
    withdrawDeps,
    withdraw,
  };
}
