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
// - Each pinned EVM pool's proof queue (card signpage-evm-proof-queue): the same queue on the same prover, with the
//   wallet's evmPool (../../wallet/src/pool/evm.ts: the chain's pool list, the page's hold and sources, the kit's fee
//   pair, the helper's GET /v1/pool/fee, the kit's epoch fee rule), opened at a landing or at a state read that finds
//   the pool's notes landed; readyWith gives every open queue's proofs, each under its pool's id. Each state read also
//   settles the pool's RESERVED notes on the chain's sync (../../wallet/src/pool/evm-settle.ts evmSettleReserved).
// - pool.buy (card signpage-pool-buy): src/pool-buy.ts on the queue's ready proofs, sent through the helper's POST
//   /v1/pool/solana/send and settled through the wallet's solanaSettleSpent once it reads back. A tag 3 loads its
//   accounts from its venue's pinned lookup table (PAGE_TABLES, the wallet's SOL_POOL_TABLES; card sol-pool-venue-tables). Each state read also settles the pool's RESERVED notes (solanaSettleReserved:
//   spent, freed past the deadline, or held), so no outcome of a send leaves a note RESERVED for good.
// - pool.sell (card signpage-pool-sell): src/pool-sell.ts on the devnet pool, W one of the page's buy wallets: the Ws
//   of the pool's SPENT and RESERVED notes (../../wallet/src/pool/buy-wallets.ts spentNotesOf, buyWallets) with their
//   holdings. A testnet-only choice: those holdings are read on ONE devnet RPC (solanaHoldingsAt on the first),
//   since devnet has no helper route, and a read naming W reaches that public RPC (mainnet reads them on the helper's
//   keyed route, buy-wallets.ts). They pick W and nothing more: the sell reads W's token account and lamports again on
//   both RPCs, and the rent back after it runs only on W's buy record (pool-buy.ts BuyMints, written by the buy before
//   its send), never on these holdings; with no record it holds (delta review 8 of 5697d7a1).
//   Its ops record goes in the page's wallet store, and each state read settles a sell a closed page left INCOMING
//   (pool-sell.ts settlePoolSells), writing its record's stage.
// - On the page's own network (card signpage-pool-mainnet): main.ts builds this on every build. Nothing differs between
//   SIGN_HOST's build and the testnet build but what the network pins and reads: the Solana pool's pin (SOL_POOLS.mainnet
//   or .devnet), its lookup tables by venue (PAGE_TABLES), the Solana pair (SIGN_HOST's provider A and the
//   helper's keyed route, main.ts's pair for every Solana read, or the two devnet RPCs), the fee route's cluster, the EVM
//   pins' networks, and where a sell reads its Ws' holdings (mainnet: the helper's keyed route, never a public RPC
//   naming W; the testnet choice above). With no pin on the page's network, every pool kind is refused not_allowed and
//   nothing is read: the state read, the queue and the flow all stop at the missing pin. The testnet constants sit
//   behind POOL_TESTNET, folded at build time, so SIGN_HOST's bundle carries none of them.
import { base58, base64 } from "@scure/base";
import { SOLANA_RPC_RETRY, SOLANA_RPC_WINDOW_RETRY, solanaJsonRpc, solanaPacedRpc, type SolanaRpc, type SolanaRpcRetry } from "../../kit/src/trade/solana/send.ts";
import { pageHelperRpc, pageHelperRpcStopped, pageRpc } from "./page-rpc.ts";
import { HELPER_FETCH_INIT, HELPER_V1_PATHS } from "../../kit/src/helper/v1.ts";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { openNoteStore, readNotes, type NoteStore } from "../../wallet/src/notes/store.ts";
import { chainNow, type Pool, type ReadyProof } from "../../wallet/src/pool/pool.ts";
import { openProofQueue, type ProofQueue, type QueuePass } from "../../wallet/src/pool/queue.ts";
import { poolDepositKind, type PoolDepositFrom, type PoolDepositHost } from "./pool-deposit.ts";
import { proverHost } from "./prover-host.ts";
import { SOLANA_PROVIDER_A, TRADE_HELPER } from "./trade.ts";
import { SOL_POOL_TABLES, SOL_POOLS, solanaNow, solanaPool, solanaPoolOf, type SolanaFeeAnswer, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { SOL_MARK_READ_BATCH, SOL_MARK_READ_BATCH_MAX, solanaSettleReserved, solanaSettleSpent, type SolanaPoolCache } from "../../wallet/src/pool/solana-restore.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { askWhileBusy, type BusyOpts } from "../../wallet/src/busy.ts";
import { POOL_SEND_BUSY_WAIT_MS, PoolSendBusy, poolBuyKind, type PoolBuyHost } from "./pool-buy.ts";
import { BUY_MINTS_KEY, buyMints, keptSells, owedRentBacks, poolSellKind, resumeRentBacks, settleDeadSellOps, settlePoolSells, settleSellOps, type PoolSellKindHost } from "./pool-sell.ts";
import { buyWallets, buyWalletsOf, derivedBuyWallets, evmHelperKeyedRpc, solanaHelperHoldings, solanaHoldingsAt, spentNotesOf, type HoldingsReader } from "../../wallet/src/pool/buy-wallets.ts";
import { keptListed, keptPositions, POSITION_COSTS_KEY, POSITIONS_KEPT_KEY, POSITIONS_SOLD_KEY, POSITIONS_SOLD_TX_KEY, POSITIONS_UNLANDED_KEY, positionsCache, positionsPass, recordPoolBuy, routeInto, type BuyRecordStore, type FoundWallet, type PoolBuyFacts, type Position, type PositionCosts } from "./positions.ts";
import { evmStoredHold } from "../../wallet/src/pool/evm-hold-store.ts";
import { EVM_CHAIN_IDS, EVM_EPOCH_MS, EVM_POOLS, evmPair, evmPool as walletEvmPool, evmPoolScopeOf, evmTreeSync, type EvmFeeAnswer, type EvmPoolOf, type EvmPoolPin, type EvmPoolRequest, type EvmRpc, type EvmSyncHold, type EvmTreeSync } from "../../wallet/src/pool/evm.ts";
import { evmSettleReserved } from "../../wallet/src/pool/evm-settle.ts";
import { evmPoolFee, evmPoolGas } from "../../kit/src/trade/evm/pool-fee.ts";
import { poolDepositEvmKind, type EvmDepositRound } from "./pool-deposit-evm.ts";
import { evmBuyHost, followPendingEvmBuys, poolBuyEvmKind, type EvmBuyPage } from "./pool-buy-evm.ts";
import { PAGE_TOKEN_DECIMALS, type PoolKindsDeps, type PoolRpc } from "./pool-kinds.ts";
import { checkPoolRequest, tokenDecimalsShown, type PoolAsk, type PoolChain, type PoolRequest } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import { readSolanaRent, solanaPoolFee } from "../../kit/src/trade/solana/pool-buy.ts";
import type { PoolStatePrice, TxRef, WithdrawStage } from "../../kit/src/signpage/messages.ts";
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
 *  other directly; both with the page's retry, the helper's route with `helperRetry` when a read names it (a pool
 *  settle's and restore's, pageSolanaSettleRpcs). */
export const testnetRpc = (url: string, helperRetry: SolanaRpcRetry = SOLANA_RPC_RETRY): SolanaRpc => (url.startsWith(`${TRADE_HELPER}/`) ? solanaJsonRpc(url, { retry: helperRetry, init: HELPER_FETCH_INIT }) : pageRpc(url));
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
/** Each EVM chain's fee list, the RPCs an EVM proof's bind reads the chain fee on at the epoch's first block, two
 *  operators of it agreeing (../../wallet/src/pool/evm.ts EvmPoolArgs feeRpcs, the kit's evmTwoOperators; card
 *  device-evm-fee-read-walks-operators): the kit's evmReadProvidersOf(evmPoolVenues()[network]), copied as
 *  MAINNET_POOL_RPCS is, so SIGN_HOST's build carries no testnet provider (scripts/build-network.test.mjs);
 *  test/pool-testnet-evm-queue.test.ts holds each equal to the kit's, and SIGN_HOST's connect-src allows each. A
 *  testnet's is its fee pair, two: no spare to walk to. */
export const TESTNET_EVM_FEE_RPCS: Readonly<Record<"base" | "robinhood", readonly string[]>> = /* @__PURE__ */ Object.freeze({
  base: /* @__PURE__ */ Object.freeze(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]),
  robinhood: /* @__PURE__ */ Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-testnet.drpc.org"]),
});
export const MAINNET_EVM_FEE_RPCS: Readonly<Record<"base" | "robinhood", readonly string[]>> = /* @__PURE__ */ Object.freeze({
  base: /* @__PURE__ */ Object.freeze(["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.api.pocket.network", "https://base.gateway.tenderly.co"]),
  robinhood: /* @__PURE__ */ Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org", "https://robinhood.api.pocket.network", "https://robinhood-rpc.publicnode.com"]),
});
/** An EVM chain's fee list as the page reads it (testnetRpc each). */
export const pageEvmFeeRpcs = (chain: "base" | "robinhood"): readonly EvmRpc[] => (POOL_TESTNET ? TESTNET_EVM_FEE_RPCS[chain] : MAINNET_EVM_FEE_RPCS[chain]).map((u) => testnetRpc(u));
/** The kit's epoch fee rule (../../wallet/src/pool/evm.ts EvmEpochFeeRule): the helper's own (apps/helper pool/evm.ts). */
export const evmEpochFee = (at: { baseFeePerGas: bigint; depth: number; chainFee: bigint }): bigint => evmPoolFee({ gas: evmPoolGas(at.depth), gasPrice: at.baseFeePerGas, chainFee: at.chainFee });
/** The Solana pool the page's network pins: SOL_POOLS.devnet in the testnet build, SOL_POOLS.mainnet (card sol-pools-mainnet-pin) on SIGN_HOST's. */
export const PAGE_SOL_PIN: SolanaPoolPin | undefined = POOL_TESTNET ? SOL_POOLS.devnet : SOL_POOLS.mainnet;
/** The page's Solana cluster: the fee route's and pool.buy's (its tip). */
export const PAGE_CLUSTER: "mainnet" | "devnet" = POOL_TESTNET ? "devnet" : "mainnet";
/** The helper's route for the mainnet mark list (card sol-pools-mainnet-pin): getProgramAccounts in the note restore's
 *  exact shape alone, answered by another company's provider than /v1/rpc/solana's (apps/helper/src/rpc/rpc.ts
 *  marksRoutes). No keyless mainnet provider answers that scan (publicnode 403 "Indexed requests require a personal
 *  token", api.mainnet-beta 403, read 9 Nov 17:23Z), so the page's lister is this route (pageSolanaLister). */
export const MAINNET_MARKS_ROUTE = `${TRADE_HELPER}/v1/rpc/solana-marks`;
/** The page's Solana pair: two devnet RPCs in the testnet build; on mainnet SIGN_HOST's provider A, read directly, and
 *  the helper's keyed route (src/trade.ts, the pair main.ts gives every Solana read, in SIGN_HOST's connect-src). The
 *  pair never lists the marks: it reads each mark the lister names by address (getMultipleAccounts) on both, with the
 *  same bytes (the wallet's solanaMarksListed). Provider A's reads never go through the helper, so a mark counts only
 *  when publicnode holds that account with those bytes: an address the helper makes up is no account there and the read
 *  is refused, and a spent mark it leaves out of the list fails each RPC's own pool count (solanaMarkCounts), so a spent
 *  note is never shown unspent nor freed. The helper alone can only stop a restore or a settle, never move money. Each
 *  paced where it is made (card solana-release-reads-paced): every pool buy, sell, withdraw, settle and restore read
 *  takes its turn in the provider's one queue, the trade's own with it. */
export const pageSolanaRpcs = (): readonly [SolanaRpc, SolanaRpc] =>
  POOL_TESTNET
    ? [solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[0])), solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[1]))]
    : [solanaPacedRpc(pageRpc(SOLANA_PROVIDER_A)), solanaPacedRpc(pageHelperRpc(TRADE_HELPER))];
/** The page's mark lister (the wallet's solanaMarksListed): MAINNET_MARKS_ROUTE, paced, on mainnet; none in the testnet
 *  build, where the wallet lists on the pair's first devnet RPC. It only names addresses: the pair reads each. */
export const pageSolanaLister = (): SolanaRpc | undefined => (POOL_TESTNET ? undefined : solanaPacedRpc(testnetRpc(MAINNET_MARKS_ROUTE)));
/** The pair every Solana pool settle and the restore read the marks and pages on (review P2-1 of e3489b3b): pageSolanaRpcs'
 *  two providers, in their same paced queues, the helper's seat with SOLANA_RPC_WINDOW_RETRY. The helper answers a
 *  caller's 17th call in a 10 s window with 429 and a Retry-After of up to 10 s (apps/helper/src/rpc/rpc.ts
 *  RPC_CLIENT_MAX), past the page's 3.5 s, so a cold read of a few hundred marks failed at its first window and never
 *  closed; these reads have no quote to age, so they wait the window out. A buy, sell or withdraw keeps pageSolanaRpcs. */
export const pageSolanaSettleRpcs = (): readonly [SolanaRpc, SolanaRpc] =>
  POOL_TESTNET
    ? [solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[0])), solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[1], SOLANA_RPC_WINDOW_RETRY))]
    : [solanaPacedRpc(pageRpc(SOLANA_PROVIDER_A)), solanaPacedRpc(pageHelperRpc(TRADE_HELPER, SOLANA_RPC_WINDOW_RETRY))];
/** Marks per getMultipleAccounts on pageSolanaSettleRpcs' two seats (the wallet's solanaMarksListed batches): the public
 *  provider's 10 (publicnode's cap; api.devnet.solana.com held to the same), the helper's route getMultipleAccounts' own
 *  100, so a cold read draws a tenth of the calls from the helper's share a user's trade reads also draw on. */
export const PAGE_SOL_MARK_BATCHES: readonly [number, number] = Object.freeze([SOL_MARK_READ_BATCH, SOL_MARK_READ_BATCH_MAX] as const);
/** The page's marks and pages of PAGE_SOL_PIN's pool on pageSolanaRpcs' pair (the wallet's SolanaPoolCache): every settle
 *  of the page and its restore read only the marks and pages none of them has read yet, so a settle after the first
 *  reads the newest page of each tree and the newest bucket of each mark size, at any pool size (review P2-2 of
 *  a34c1626: 510 getMultipleAccounts per seat at 5,000 marks on every settle before). Public chain data only: every
 *  mark of the pool, never which are the user's, so it is kept across a sign out. */
export const PAGE_SOL_CACHE: SolanaPoolCache = {};

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
export function testnetPoolDeps(flow?: PoolKindsDeps["flow"], stop?: PoolKindsDeps["stop"]): PoolKindsDeps {
  return {
    pinned: (chain) => (chain === "solana" ? PAGE_SOL_PIN !== undefined : EVM_POOLS[POOL_TESTNET ? EVM_TESTNET[chain] : chain] !== undefined),
    rpcs: (chain) =>
      chain === "solana"
        ? (pageSolanaRpcs() as unknown as readonly [PoolRpc, PoolRpc])
        : POOL_TESTNET
          ? (TESTNET_RPCS[chain].map((u) => testnetRpc(u) as PoolRpc) as unknown as readonly [PoolRpc, PoolRpc])
          : null,
    // the tokens' decimals kept this session: the sell's read and both buys' own (card sell-first-read-waits-out-a-throttle)
    decimals: PAGE_TOKEN_DECIMALS,
    ...(flow ? { flow } : {}),
    ...(stop ? { stop } : {}),
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
  /** The page's own USD price of a chain's pool asset (src/pool-price.ts), for a pool buy's cost; null when none is fresh. */
  price?(chain: PoolChain): PoolStatePrice | null;
};

/** Tests only: the pool, the prover, the RPCs, the fee's fetch and the thread count the page would use. */
export type TestnetOver = {
  pool?: Pool<unknown>;
  prover?: { vault: VaultProver; stop(): void };
  rpcs?: readonly [SolanaRpc, SolanaRpc];
  /** The marks' lister (the pair's first RPC when `rpcs` is planted, pageSolanaLister otherwise). */
  lister?: SolanaRpc;
  /** The Solana pool's cache (PAGE_SOL_CACHE on the page's own pin and pair, a new one when `rpcs` or `pin` is planted). */
  cache?: SolanaPoolCache;
  fetch?: typeof fetch;
  hardwareConcurrency?: number;
  /** The lookup tables pool.buy may load, by venue, generations oldest first (the network's, PAGE_TABLES, otherwise). */
  tables?: Readonly<Partial<Record<"pump-curve" | "pumpswap", readonly string[]>>>;
  /** Web Locks (navigator.locks otherwise); none: no RESERVED pass runs. */
  locks?: Pick<LockManager, "request" | "query"> | null;
  /** The Solana pool's pin (PAGE_SOL_PIN otherwise): tests run the page's own flow on a fake pool; null, none (a build
   *  with no Solana pin, as SIGN_HOST's until the pool deploys). */
  pin?: SolanaPoolPin | null;
  /** The withdraw run's clock and wait (the page's own otherwise): a test's read-back bound passes on its clock, so no
   *  run outlives its test (fold 5: each held node ~120 s on the wall clock). */
  now?: () => bigint;
  wait?: (ms: number) => Promise<void>;
  /** An EVM chain's pool pin (EVM_POOLS of the page's network otherwise), its pool list, seats first (pageEvmPoolRpcs
   *  otherwise), and its pool's event round (evmTreeSync over that list otherwise): tests run the EVM deposit flow on a fake pool. */
  evmPin?: (chain: "base" | "robinhood") => EvmPoolPin | undefined;
  evmRpcs?: (chain: "base" | "robinhood") => readonly EvmRpc[] | null;
  evmRound?: (pin: EvmPoolPin, rpcs: readonly [EvmRpc, EvmRpc], list?: readonly EvmRpc[]) => (signal?: AbortSignal) => Promise<EvmDepositRound>;
  /** An EVM chain's pool sync (evmTreeSync over its pair, the page's hold and its sources otherwise): the deposit's round
   *  and the RESERVED settle read it. */
  evmSync?: (pin: EvmPoolPin, rpcs: readonly [EvmRpc, EvmRpc], list: readonly EvmRpc[]) => Pick<EvmTreeSync, "events">;
  /** An EVM chain's pool for its proof queue (the wallet's evmPool over the chain's pool list otherwise). */
  evmQueuePool?: (chain: "base" | "robinhood") => Pool<unknown>;
  /** The EVM turn pass's clock, timers, spread draw and tab visibility (the page's own otherwise; tests). */
  evmTurn?: EvmTurnDeps;
  /** The deposit kinds (poolDepositKind, poolDepositEvmKind otherwise): a test reads the hosts this page wires into them
   *  (its sign-out signal and its pass, fold review 3). */
  depositKinds?: { solana?: typeof poolDepositKind; evm?: typeof poolDepositEvmKind };
  /** The trade kinds (poolBuyKind, poolSellKind otherwise): a test reads the hosts this page wires into them (W's buy
   *  record, written by the buy host and read by the sell host; delta review 8 of 5697d7a1). */
  tradeKinds?: { buy?: typeof poolBuyKind; sell?: typeof poolSellKind; evmBuy?: typeof poolBuyEvmKind };
  /** The buy wallets' finder reader for the page's RPCs (the helper's or a devnet RPC's otherwise; tests). */
  holdings?: (rpcs: readonly [SolanaRpc, SolanaRpc]) => HoldingsReader;
  /** The positions cache's retry and timers (src/positions.ts; tests). */
  positions?: Parameters<typeof positionsCache>[1];
};

/** The page network's lookup tables by venue (the wallet's SOL_POOL_TABLES of PAGE_CLUSTER): a pool buy loads one of
 *  its venue's own generations, and a venue with none is refused venue_not_pinned (card sol-pool-venue-tables). */
export const PAGE_TABLES: Readonly<Partial<Record<"pump-curve" | "pumpswap", readonly string[]>>> = SOL_POOL_TABLES[POOL_TESTNET ? "devnet" : "mainnet"] ?? {};
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
  return (await helperFee(`${TRADE_HELPER}/v1/pool/fee?cluster=${PAGE_CLUSTER}&pool=${encodeURIComponent(pool)}&epoch=${epochStartMs}`, signal, fetchFn, sleep)) as SolanaFeeAnswer;
}
/** GET /v1/pool/fee for an EVM pool (the helper keys it by the pool's lowercase address) and one epoch, as evmPool's
 *  relayFee: the answer as the helper gave it, which evmPool's bind refuses unless every field is this pool's, this
 *  epoch's and the fee the device computes from its own reads. The same waits and refusals as poolRelayFee. */
export async function evmPoolRelayFee(pool: string, epochStartMs: bigint, signal?: AbortSignal, fetchFn: typeof fetch = fetch, sleep?: BusyOpts["sleep"]): Promise<EvmFeeAnswer> {
  return (await helperFee(`${TRADE_HELPER}/v1/pool/fee?pool=${encodeURIComponent(pool.toLowerCase())}&epoch=${epochStartMs}`, signal, fetchFn, sleep)) as EvmFeeAnswer;
}
async function helperFee(url: string, signal: AbortSignal | undefined, fetchFn: typeof fetch, sleep: BusyOpts["sleep"] | undefined): Promise<unknown> {
  const res = await askWhileBusy(() => {
    const timeout = AbortSignal.timeout(FEE_TIMEOUT_MS);
    return fetchFn(url, { ...HELPER_FETCH_INIT, redirect: "error", method: "GET", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  }, { signal, sleep });
  if (res.status !== 200) throw new Error(`pool fee: HTTP ${res.status}`);
  // the helper's fee answer is this small (its v1 table's limit for GET /v1/pool/fee)
  const FEE_ANSWER_MAX = HELPER_V1_PATHS.find((p) => p.method === "GET" && p.path === "/v1/pool/fee")!.limitBytes!;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > FEE_ANSWER_MAX) throw new Error(`pool fee: an answer over ${FEE_ANSWER_MAX} B`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
  /** state.positions (src/positions.ts): the last pass, or the kept one before it, null before either; the first
   *  signed-in read starts a pass. */
  positions(): Promise<readonly Position[] | null>;
  /** The proof queue's pass, the queue opened first when none is: what each landed note runs. */
  proofs(): Promise<QueuePass | null>;
  /** state.pools' `ready` (src/pools.ts) with `read`'s notes, in one turn of the queue's view (queue.ts readyWith), so
   * a remake's swap never falls between the two (card pool-ready-no-flicker); `ready` undefined while no queue is open.
   * `open`: the ids of the pools whose queue is open, so a chain with no open queue reads no ready (src/pools.ts
   * withPools). `read` waits for nothing of the queue's. */
  readyWith<T>(read: () => Promise<T>): Promise<{ ready: readonly ReadyProof[] | undefined; value: T; open: ReadonlySet<string> }>;
  /** `fn` runs after each pass that made or remade a proof: a proof made changes no store record (its note was HELD
   * before it began), so the page's state is read again on this. */
  watch(fn: () => void): void;
  /** A sign out is starting: every Solana and EVM pool settle stops (each holds the seed lock shared, which the sign out
   *  waits for), its lock wait and its reads end, and it writes nothing after. */
  signingOut(): void;
  /** Sign out: the queue closed (its notes freed, its seed copy zeroed), its note store closed, the worker ended. */
  signedOut(): Promise<void>;
  /** The session's sign out, aborted at the next one: a pool kind's reads read it when a request comes (pool-kinds.ts). */
  outSignal(): AbortSignal;
  /** The pool withdraw screen's reads and run (src/withdraw/pool-form.ts) for the request's op id. */
  withdrawDeps(chain: PoolChain, opId: string): PoolWithdrawFormDeps;
  /** The withdraw run of a screen's checked answer, its op record written as it goes; settles at the run's end. */
  withdraw(r: PoolReady, opId: string): Promise<void>;
};

/** The testnet build's devnet pool on this page: the deposit flow, its settling and the next buy's proofs. */
/** An open proof queue, its note store and the id of the pool it proves for. */
type OpenQueue = { queue: ProofQueue<unknown>; notes: NoteStore; poolId: string; hold?: (signal?: AbortSignal, seen?: (now: bigint) => void) => Promise<void> };

/** The EVM turn pass (card evm-device-reads-need-no-old-state): this long past each period's turn, plus the page's
 *  spread, the period's first block is in on both seats (Base makes one every 2 s, Robinhood several a second) and still
 *  fresh: Pocket and publicnode refused its state 15 to 242 s back (read 2026-11-10 21:50-22:30Z). */
//  A page loaded mid-period binds at the period's first block too, on the walk of the kit's read list; where no two
//  operators still keep that block's state it waits for the next turn, at most 60 s + EVM_TURN_PASS_MS +
//  EVM_TURN_SPREAD_MS (65 s) after a load just past a turn: a fresh load has no proof until then, on the screen's
//  "Making proof", never an error (a page open in the period before keeps that period's proof takeable meanwhile, the
//  queue's rule, packages/wallet/src/pool/queue.ts:10-13); a measured residue, removed by card
//  device-evm-read-residuals. Robinhood at +55 s, 3
//  periods read 2026-11-10 23:20-23:29Z: two operators kept the block in 2 (robinhood.com with drpc.org, then with
//  pocket.network), robinhood.com alone in 1 (drpc.org "Unknown state", pocket.network and publicnode.com "historical
//  state ... is not available"); Base's four kept it in 5 of 5. The wait itself was bounded in a test, not timed live.
export const EVM_TURN_PASS_MS = 3_000;
/** Each page adds 0 to this to EVM_TURN_PASS_MS, drawn once a page load, so the open pages do not ask the same public
 *  operators in the same second. */
export const EVM_TURN_SPREAD_MS = 2_000;
export type EvmTurnDeps = {
  now?: () => number;
  random?: () => number;
  setTimeout?: (f: () => unknown, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  visibility?: { hidden: () => boolean; onShow: (f: () => unknown) => void } | null;
};

export function testnetPool(page: TestnetPage, over: TestnetOver = {}): TestnetPool {
  const pin = over.pin === null ? undefined : (over.pin ?? PAGE_SOL_PIN);
  const rpcs = (): readonly [SolanaRpc, SolanaRpc] => over.rpcs ?? pageSolanaRpcs();
  // every settle's pair: the same two seats, the helper's waiting out its window (pageSolanaSettleRpcs)
  const settleRpcs = (): readonly [SolanaRpc, SolanaRpc] => over.rpcs ?? pageSolanaSettleRpcs();
  // the marks' lister: a test's planted pair lists on its own first RPC unless it plants a lister
  const lister = (): SolanaRpc | undefined => over.lister ?? (over.rpcs === undefined ? pageSolanaLister() : undefined);
  // one cache for every Solana settle on this page (and its restore, src/pool-restore.ts pagePools), on one pair
  const cache: SolanaPoolCache = over.cache ?? (over.rpcs === undefined && over.pin === undefined ? PAGE_SOL_CACHE : {});
  // every Solana settle's stop: a sign out (this tab's, signingOut, or another's, signedOut) aborts it, so a settle on a
  // lister that stalls or names marks without end never holds the seed lock the sign out waits for (review P2-1)
  let solanaStop = new AbortController();
  const stopSolana = (): void => {
    solanaStop.abort();
    solanaStop = new AbortController();
  };
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
  let open: Promise<OpenQueue> | null = null;
  const openQueue = async (): Promise<OpenQueue> => {
    const notes = await openNoteStore(await page.store());
    let seed64: Uint8Array | null = null;
    try {
      seed64 = await page.seed64();
      const pool = over.pool ?? solanaPool({ pin: pin!, rpcs: rpcs(), relayFee: (e, s) => poolRelayFee(solanaPoolOf(pin!.program).pool, e, s, over.fetch) });
      const hardwareConcurrency = over.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency;
      return { queue: openProofQueue({ seed64, notes, pool, provers: [prover.vault], hardwareConcurrency, skip: owedNotes }), notes, poolId: pool.id };
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
    stopTurn();
    positions.clear();
    awaited.clear();
    follows.abort();
    follows = new AbortController();
    stopSolana();
    // every queue, Solana's and each EVM pool's: its notes freed, its seed copy zeroed, its note store closed
    const all = [open, ...evmQueues.values()];
    open = null;
    evmQueues.clear();
    prover.stop();
    for (const p of all) {
      if (!p) continue;
      const q = await p.catch(() => null);
      if (!q) continue;
      try {
        await q.queue.close();
      } finally {
        q.notes.close();
      }
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
      // the session's sign out (signingOut, at its tap): it ends a wait between the ask's attempts
      stop: solanaStop.signal,
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
  // the deposit's own pair (one evmPair, its seats bound by every read), the page's hold, and as sources the list's
  // providers, then the page's history
  const evmSyncOf = over.evmSync ?? ((p: EvmPoolPin, r: readonly [EvmRpc, EvmRpc], list: readonly EvmRpc[]) => evmTreeSync({ rpcs: r, pin: p, held: pageEvmHold(p, () => page.held ? page.held() : page.store()), history: [...list, ...pageEvmHistory(p)] }));
  const roundOf = (sync: Pick<EvmTreeSync, "events">) => async (signal?: AbortSignal): Promise<EvmDepositRound> => {
    const round = await sync.events(signal);
    return { events: round.events, finalBlock: round.fin.number };
  };
  // each EVM chain's pool on this page: its pin, its pool list and two RPCs, its sync (the deposit's round and the
  // RESERVED settle read it) and its scope, made once
  const evmPools = new Map<"base" | "robinhood", { pin: EvmPoolPin; list: readonly EvmRpc[]; rpcs: readonly [EvmRpc, EvmRpc]; sync: Pick<EvmTreeSync, "events">; round: () => Promise<EvmDepositRound>; scope: bigint } | null>();
  const evmPool = (chain: "base" | "robinhood") => {
    if (!evmPools.has(chain)) {
      const p = evmPin(chain);
      const r = p === undefined ? null : evmRpcs(chain);
      // one pair for the deposit's reads and its sync's (review of evm-pool-lists-mainnet, P3-1)
      const pair = r === null || r.length < 2 ? null : evmPair(r);
      const sync = p === undefined || r === null || pair === null ? null : evmSyncOf(p, pair, r);
      evmPools.set(chain, p === undefined || r === null || pair === null || sync === null ? null : { pin: p, list: r, rpcs: pair, sync, round: over.evmRound ? over.evmRound(p, pair, r) : roundOf(sync), scope: evmPoolScopeOf(p.pool, EVM_CHAIN_IDS[p.network]) });
    }
    return evmPools.get(chain)!;
  };
  // each EVM pool's proof queue (card signpage-evm-proof-queue), as the Solana pool's above: opened at its first landing
  // or at a state read that finds its notes landed, on the page's one prover, the page's note store and a copy of the
  // seed; the pool is the wallet's evmPool over the chain's pool list (its seats the deposit's pair), the page's hold
  // and sources, the kit's fee pair, the helper's GET /v1/pool/fee and the kit's epoch fee rule. Closed at sign out.
  const evmQueues = new Map<"base" | "robinhood", Promise<OpenQueue>>();
  const openEvmQueue = async (chain: "base" | "robinhood"): Promise<OpenQueue> => {
    const e = evmPool(chain);
    if (e === null) throw new Error(`no ${chain} pool on this page's network`);
    const notes = await openNoteStore(await page.store());
    let seed64: Uint8Array | null = null;
    try {
      seed64 = await page.seed64();
      const pool =
        over.evmQueuePool?.(chain) ??
        walletEvmPool({
          pin: e.pin,
          rpcs: e.rpcs,
          feeRpcs: pageEvmFeeRpcs(chain),
          held: pageEvmHold(e.pin, () => (page.held ? page.held() : page.store())),
          history: [...e.list, ...pageEvmHistory(e.pin)],
          relayFee: (ep, s) => evmPoolRelayFee(e.pin.pool, ep, s, over.fetch),
          epochFee: evmEpochFee,
        });
      const hardwareConcurrency = over.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency;
      // the period's fee held at the turn (the wallet's evmPool holdFee), at the pool's own time's period
      const holdFee = (pool as Partial<Pick<EvmPoolOf, "holdFee">>).holdFee;
      // `seen` gets the pool's time it read, the newest block's, before the fee is read, so the turn's timer takes its
      // offset and its period from it whether or not the fee read succeeds (delta review of 3e13d4e2, P3-2)
      const hold = typeof holdFee === "function" ? async (s?: AbortSignal, seen?: (now: bigint) => void): Promise<void> => {
        const now = await pool.now(s);
        seen?.(now);
        await holdFee.call(pool, now - (now % pool.epochMs), s);
      } : undefined;
      return { queue: openProofQueue({ seed64, notes, pool, provers: [prover.vault], hardwareConcurrency, skip: owedNotes }), notes, poolId: pool.id, ...(hold ? { hold } : {}) };
    } catch (err) {
      notes.close();
      throw err;
    } finally {
      seed64?.fill(0); // the queue keeps its own copy
    }
  };
  /** The EVM chain's queue pass, the queue opened first when none is; null with no pool or no queue. */
  const evmProofs = async (chain: "base" | "robinhood"): Promise<QueuePass | null> => {
    if (evmPool(chain) === null) return null;
    let p = evmQueues.get(chain);
    if (p === undefined) evmQueues.set(chain, (p = openEvmQueue(chain)));
    try {
      const pass = await (await p).queue.refresh();
      if (pass.made.length > 0 || pass.remade.length > 0) for (const f of watchers) f();
      return pass;
    } catch {
      // a queue that could not open (no seed: signed out) is dropped, so the next landing opens it again
      const q = p;
      if (evmQueues.get(chain) === q) await q.then(() => {}, () => void (evmQueues.get(chain) === q && evmQueues.delete(chain)));
      return null;
    }
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
        // each landed note runs the chain's queue pass, as the Solana deposit's does
        landed: () => void evmProofs(chain),
        settle: () => void settleEvm(chain),
        signal: follows.signal,
        // the session's sign out (signingOut, at its tap): it ends a wait between the ask's attempts
        stop: evmStop.signal,
        end: () => {
          notes?.close();
          end?.();
        },
      };
    });
  };
  const evmDeposit = (chain: "base" | "robinhood") => evmKind(chain);
  // pool.buy on an EVM chain (card signpage-evm-pool-buy, src/pool-buy-evm.ts): the chain's queue, the kit's quote and
  // build, the helper's send, the deposit's pair for the read-back, and the chain's RESERVED settle; testnet build only
  // until the mainnet pins' card (the mainnet build refuses it not_allowed)
  const evmBuyClaims = new Set<string>();
  // the Ws whose buy a run or the load's follow of this page is following now (followPendingEvmBuys skips them)
  const evmBuyFollowing = new Set<string>();
  const evmBuyPage = (chain: "base" | "robinhood"): EvmBuyPage => ({
    following: evmBuyFollowing,
    // the chain's queue, opened when it is not; one that cannot open (signed out) is dropped, so the next tap opens it
    // again
    queue: async () => {
      let p = evmQueues.get(chain);
      if (p === undefined) {
        const opening = openEvmQueue(chain);
        evmQueues.set(chain, (p = opening));
        opening.catch(() => {
          if (evmQueues.get(chain) === opening) evmQueues.delete(chain);
        });
      }
      return (await p).queue as ProofQueue<EvmPoolRequest>;
    },
    seed64: page.seed64,
    // the store only while it is open: a buy's write after a sign out fails, never opens it again (review P2-2)
    held: () => (page.held ? page.held() : Promise.reject(new Error("no wallet store is open"))),
    fetch: over.fetch,
    settle: () => void reserveEvm(chain).catch(() => {}),
    testnet: POOL_TESTNET,
    signal: follows.signal,
    stopped: ((at) => () => signOuts !== at)(signOuts),
  });
  const evmBuy = (chain: "base" | "robinhood") => {
    const e = evmPool(chain);
    if (e === null || !POOL_TESTNET) return null;
    return (over.tradeKinds?.evmBuy ?? poolBuyEvmKind)(() => evmBuyHost(chain, e.pin, e.rpcs, evmBuyClaims, evmBuyPage(chain)));
  };
  // a buy whose tab ended before its end (the pending record's own follow died with it): followed from its record at
  // each state read, until filled, withdrawn or not_landed (src/pool-buy-evm.ts followPendingEvmBuys); testnet build only
  const evmBuyFollow = (chain: "base" | "robinhood"): void => {
    const e = evmPool(chain);
    if (e === null || !POOL_TESTNET) return;
    void followPendingEvmBuys(evmBuyHost(chain, e.pin, e.rpcs, evmBuyClaims, evmBuyPage(chain))).catch(() => {});
  };
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
  // an EVM pool's RESERVED notes settled (../../wallet/src/pool/evm-settle.ts evmSettleReserved: spent with its change
  // once both RPCs show the release final, freed once both RPCs' final block time is past the deadline with none, else
  // held), on the chain's sync, under the seed's shared lock as the Solana pass; a freed note or a change written is
  // proved by the queue's next pass. One pass per chain at a time: a state read during one joins it. A sign out stops
  // it (signingOut): its lock wait and its round end at once, and it writes nothing after. No Web Locks: no pass.
  let evmStop = new AbortController();
  // the sign outs asked on this page (signingOut): a Solana sell's host stops its sales at the next one, and an EVM
  // buy's busy wait ends at once on one started after its tap (review P3-5)
  let signOuts = 0;
  // `stop`: the sign-out signal as it was when the state read began (review of 7fbf2af3, P3-a): one read after an await
  // takes the controller a sign out made since, and runs on
  const settleEvmReserved = async (chain: "base" | "robinhood", stop?: AbortSignal): Promise<void> => {
    const e = evmPool(chain);
    if (e === null || !locks) return;
    const signal = stop ?? evmStop.signal;
    await locks.request(WALLET_SEED_LOCK, { mode: "shared", signal }, async () => {
      const notes = await openNoteStore(await page.store());
      let seed64: Uint8Array | null = null;
      try {
        seed64 = await page.seed64();
        const pass = await evmSettleReserved({ seed64, notes, scope: e.scope, round: (s) => e.sync.events(s), signal });
        if (pass.freed.length > 0 || pass.spent.length > 0) void evmProofs(chain);
      } finally {
        seed64?.fill(0);
        notes.close();
      }
    });
  };
  const evmReserving = new Map<"base" | "robinhood", Promise<void>>();
  const reserveEvm = (chain: "base" | "robinhood", stop?: AbortSignal): Promise<void> => {
    let p = evmReserving.get(chain);
    if (p === undefined) {
      const run: Promise<void> = settleEvmReserved(chain, stop).finally(() => {
        if (evmReserving.get(chain) === run) evmReserving.delete(chain);
      });
      evmReserving.set(chain, (p = run));
    }
    return p;
  };
  // a state read's EVM part: its INCOMING notes, then per pinned chain, each beside the other, its queue's pass (one at
  // a time per chain) while the queue is open or the chain's notes are landed, and its RESERVED notes' settle
  const evmPassing = new Map<"base" | "robinhood", Promise<unknown>>();
  const evmRead = async (): Promise<void> => {
    const stop = evmStop.signal;
    await settleEvmOpen().catch(() => {});
    const chains = (["base", "robinhood"] as const).filter((c) => evmPool(c) !== null);
    if (chains.length === 0) return;
    // each chain's buys whose tab ended before their end, from their pending records (never awaited)
    for (const chain of chains) evmBuyFollow(chain);
    const all = await readNotes(await page.store());
    await Promise.all(
      chains.map(async (chain) => {
        const mine = all.filter((n) => n.scope === evmPool(chain)!.scope);
        // a sign out since the read began: no pass, and the settle stops on its signal
        if (!stop.aborted && !evmPassing.has(chain) && (evmQueues.has(chain) || mine.some((n) => n.state === "UNSPENT" || n.state === "HELD")))
          evmPassing.set(chain, evmProofs(chain).finally(() => evmPassing.delete(chain)));
        if (mine.some((n) => n.state === "RESERVED")) await reserveEvm(chain, stop).catch(() => {});
      }),
    );
  };
  // the EVM turn pass (card evm-device-reads-need-no-old-state): a keyless operator keeps a block's state seconds to
  // minutes, so each chain's period fee is read a few seconds past the period's turn, while its first block is fresh,
  // and held (the wallet's evmPool holdFee); then the chain's queue pass runs, whose binds take the held read, so a
  // first proof is ready within seconds of the turn with no tap. Only under evmRead's own condition (the chain's queue
  // open or its notes landed): a page with nothing on a chain reads nothing at the turn. It names nothing of the user:
  // block headers, the pool's logs and public views at a block hash. Armed at a state read and cleared at sign out. A
  // hidden tab reads nothing at the turn (its timers run late, and nobody taps there); shown again, it runs once at once.
  const turnDeps = over.evmTurn ?? {};
  const turnNow = turnDeps.now ?? (() => Date.now());
  // a timer that never holds a process open (Node's unref; a browser's has none)
  const turnSet = turnDeps.setTimeout ?? ((f: () => unknown, ms: number) => {
    const t = setTimeout(f, ms) as unknown as { unref?: () => void };
    t.unref?.();
    return t;
  });
  const turnClear = turnDeps.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const turnSpread = Math.floor((turnDeps.random ?? Math.random)() * EVM_TURN_SPREAD_MS);
  const turnSeen =
    turnDeps.visibility !== undefined ? turnDeps.visibility
    : typeof document !== "undefined" ? { hidden: () => document.visibilityState === "hidden", onShow: (f: () => unknown) => document.addEventListener("visibilitychange", () => void (document.visibilityState === "visible" && f())) }
    : null;
  let turnTimer: unknown = null;
  let turnMissed = false;
  let turnShowOn = false;
  // the pool's time less the device's, ms, from the newest block's time at the last hold (review P3-c): the timer is
  // armed on the pool's time, so a device clock minutes off still fires a few seconds past the pool's turn
  let turnOffset = 0;
  // the period (on the pool's time) the turn's pass last ran for: one a period, however early or late a timer fires
  // (review P3-b)
  let turnRan: number | null = null;
  const evmTurnPass = async (): Promise<void> => {
    // the sign-out signal before any await (review P3-a)
    const signal = evmStop.signal;
    const chains = (["base", "robinhood"] as const).filter((c) => evmPool(c) !== null);
    if (chains.length === 0) return;
    const all = await readNotes(await page.store());
    await Promise.all(
      chains.map(async (chain) => {
        const mine = all.filter((n) => n.scope === evmPool(chain)!.scope);
        if (signal.aborted || !(evmQueues.has(chain) || mine.some((n) => n.state === "UNSPENT" || n.state === "HELD"))) return;
        let p = evmQueues.get(chain);
        if (p === undefined) evmQueues.set(chain, (p = openEvmQueue(chain)));
        const q = await p.catch(() => null);
        // the fee first, then the pass: a read that fails leaves the pass to read it as before
        await q?.hold?.(signal, (now) => {
          const before = turnOffset;
          turnOffset = Number(now) - turnNow();
          // the period this pass ran for is the pool's (review P3-3): a device clock ahead marked the next one
          turnRan = Number(now - (now % EVM_EPOCH_MS));
          // the timer armed on the old offset is armed again on the pool's time
          if (Math.abs(turnOffset - before) > 1_000 && turnTimer !== null && !signal.aborted) {
            turnClear(turnTimer);
            turnTimer = null;
            armTurn();
          }
        }).catch(() => {});
        // a pass already running (begun before the turn, its binds of the period before) ends first; then this one,
        // unless this tab signed out meanwhile
        await evmPassing.get(chain)?.catch(() => {});
        if (signal.aborted) return;
        if (!evmPassing.has(chain)) evmPassing.set(chain, evmProofs(chain).finally(() => evmPassing.delete(chain)));
        await evmPassing.get(chain);
      }),
    );
  };
  const E_MS = Number(EVM_EPOCH_MS);
  // the turn's pass, once for the period it is in on the pool's time
  const runTurn = (): Promise<void> | undefined => {
    const t = turnNow() + turnOffset;
    const period = t - (t % E_MS);
    if (turnRan === period) return undefined;
    turnRan = period;
    return evmTurnPass().catch(() => {});
  };
  const armTurn = (): void => {
    if (turnTimer !== null) return;
    if (!turnShowOn && turnSeen !== null) {
      turnShowOn = true;
      turnSeen.onShow(() => {
        if (!turnMissed || turnTimer === null) return;
        turnMissed = false;
        return runTurn();
      });
    }
    // the pool's time: the device's plus the offset the last hold read
    const now = turnNow() + turnOffset;
    let at = now - (now % E_MS) + EVM_TURN_PASS_MS + turnSpread;
    if (at <= now) at += E_MS;
    turnTimer = turnSet(() => {
      turnTimer = null;
      armTurn();
      if (turnSeen?.hidden()) {
        turnMissed = true;
        return;
      }
      return runTurn();
    }, at - now);
  };
  const stopTurn = (): void => {
    if (turnTimer !== null) turnClear(turnTimer);
    turnTimer = null;
    turnMissed = false;
  };
  // pool.buy: the open queue's ready proofs; one run per tap, each picking a proof no other run of this page holds
  const tables = over.tables === undefined ? PAGE_TABLES : over.tables;
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
      tables,
      cluster: PAGE_CLUSTER,
      rpcs: rpcs(),
      claimed,
      // a sign out ends the buy's waits before its signature (read-waits.ts waitUnless): this session's stop
      signal: solanaStop.signal,
      // none ready (a page that has landed no deposit since it loaded has run no pass): a pass starts for the next tap
      ready: async () => {
        const list = (await q()).ready();
        if (list.length === 0) void proofs();
        return list;
      },
      take: async (id, attempt, early) => (await q()).take(id, attempt, early),
      chainNow: () => chainNow(over.pool ?? { now: (signal) => solanaNow(rpcs(), signal) }),
      seed64: page.seed64,
      // W's buy mint, written before the send: the rent back after a later sell holds while W holds any of it
      bought: buyMints(page.store),
      send: (pool, tx) => helperPoolSend(pool, tx, over.fetch),
      // the received token's decimals, for W's buy record (src/positions.ts recordPoolBuy), and kept for the session: read
      // on both RPCs with the amount, so a sell of it asks no decimals read (card sell-first-read-waits-out-a-throttle)
      outDecimals: (wallet, d, mint) => {
        boughtDecimals.set(wallet, d);
        PAGE_TOKEN_DECIMALS.keep("solana", mint, d);
      },
      // minSlots: the not_landed verdict's slots (pool-buy.ts pastAt), every read at or past them
      settle: async (noteId, minSlots) => {
        // the stop's signal of this call, taken before its first wait: a sign out during the seed read stops it
        const signal = solanaStop.signal;
        const seed64 = await page.seed64();
        try {
          notes ??= await openNoteStore(await page.store());
          return await solanaSettleSpent({ seed64, notes, noteId, program: pin!.program, minSlots, rpcs: settleRpcs(), lister: lister(), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES });
        } finally {
          seed64.fill(0);
        }
      },
      end: () => notes?.close(),
    };
  };
  // each buy's W and the decimals of the token it received, told by the run (pool-buy.ts outDecimals) until its records
  // are written; a W takes one buy only
  const boughtDecimals = new Map<string, number>();
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
  // the pool's Ws with their holdings, the one finder a sell and the positions use: on mainnet through the helper's keyed
  // route, in the testnet build on one devnet RPC (the header's testnet-only choice); none: no read
  const finderOf = (r: readonly [SolanaRpc, SolanaRpc]): HoldingsReader => over.holdings?.(r) ?? (POOL_TESTNET ? solanaHoldingsAt(TESTNET_RPCS.solana[0]) : solanaHelperHoldings(TRADE_HELPER));
  const poolBuyWallets = async (notes: NoteStore, r: readonly [SolanaRpc, SolanaRpc], reader: HoldingsReader = finderOf(r), together?: true) => {
    const spent = await spentNotesOf(notes, scope!);
    if (spent.length === 0) return [];
    const seed64 = await page.seed64();
    try {
      const got = await buyWallets(seed64, [{ id: pin!.program, chain: "sol", spent, reader }], together ? { together } : {});
      if (got.failed.length > 0) throw new Error("the buy wallets' holdings could not be read");
      return got.wallets;
    } finally {
      seed64.fill(0);
    }
  };
  // the Ws of the buys this page ran to filled or sent, this sign-in: the finder reads at finalized, so one it does not
  // list yet is looked for again (src/positions.ts awaited)
  const awaited = new Map<string, string>();
  // state.positions (src/positions.ts, card signpage-state-holdings): this device's buys (W's buy mint, written before
  // every send, and its buy record when the run told the amount), each from the finder's one read of its W (the
  // helper's keyed route on mainnet; no read here names a W to a public provider, nor a mint no buy of W's named); one
  // pass at a time, run at the sign-in's first state read and again when a pool buy or sell ends; the last whole pass
  // kept in the wallet store for the first read after a load
  const positions = positionsCache(
    async (memo, run) => {
      if (scope === null) return { positions: [], whole: true };
      const r = rpcs();
      const st = await page.store();
      const meta = async (k: string): Promise<Record<string, unknown>> => {
        const v = await st.get("meta", k);
        return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
      };
      return await positionsPass({
        signal: run.signal,
        // the sell's own read when one was fed, else the finder's read of the Ws with a buy record
        wallets: async (only) => (run.found ?? (await recordedWallets(st, r, only, run.signal))).filter((w) => only.has(w.address)),
        bought: async () => meta(BUY_MINTS_KEY),
        costs: async () => (await meta(POSITION_COSTS_KEY)) as PositionCosts,
        awaited: () => awaited,
        // each by the sell that marked it (its signatures), so a later sell of it is looked for afresh
        sold: async () => {
          const by = await meta(POSITIONS_SOLD_TX_KEY);
          return new Map(Object.entries(await meta(POSITIONS_SOLD_KEY)).flatMap(([a, ms]) => (Array.isArray(ms) ? ms.filter((m): m is string => typeof m === "string").map((m) => [`${a} ${m}`, String(by[`${a} ${m}`] ?? "")] as const) : [])));
        },
        kept: async () => st.get("meta", POSITIONS_KEPT_KEY),
        keep: async (k) => void (await st.put("meta", POSITIONS_KEPT_KEY, k)),
        // one read on the finder's own route (pageSolanaRpcs: the helper's keyed route is the second on mainnet, the
        // testnet finder's devnet RPC the first), never a public provider: a display's, never a sell's. On mainnet it
        // carries the pass's stop in its every fetch, in the helper route's own queue: nothing of a signed-out account's
        // is sent after the sign out, queued or tried again
        decimals: async (mint) => {
          const rpc = POOL_TESTNET ? r[0] : over.rpcs ? r[1] : solanaPacedRpc(pageHelperRpcStopped(TRADE_HELPER, run.signal));
          run.signal.throwIfAborted();
          return tokenDecimalsShown("solana", await rpc("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]));
        },
      }, memo);
    },
    {
      ...over.positions,
      kept: async () => {
        if (scope === null) return null;
        const st = await page.store();
        return keptPositions(await st.get("meta", POSITIONS_KEPT_KEY), (await st.get("meta", POSITION_COSTS_KEY)) ?? {}, (await st.get("meta", BUY_MINTS_KEY)) ?? {});
      },
    },
  );
  // The Ws of `only` as the finder reads them. Derived under the seed's shared lock, the seed copy zeroed as soon as
  // they are (a sign out waits only for that derive, never for a read), then read with the pass's stop: one W's failed
  // read is that W's alone (the finder fails a whole pool on one; a sell keeps that rule). No Web Locks: no read.
  const recordedWallets = async (st: WalletStore, r: readonly [SolanaRpc, SolanaRpc], only: ReadonlySet<string>, signal: AbortSignal): Promise<FoundWallet[]> => {
    if (!locks) throw new Error("no Web Locks: the seed is not read");
    const inner = finderOf(r);
    const unread = new Set<string>();
    const reader: HoldingsReader = {
      chain: inner.chain,
      read: async (address, s, by) => {
        try {
          // the list's bound from its start (buy-wallets.ts readDerived's `by`), as a sell's read keeps it
          return await inner.read(address, s, by);
        } catch (e) {
          if (s?.aborted) throw e;
          unread.add(address);
          return { native: 0n, tokens: new Map(), unreadable: [] };
        }
      },
    };
    const notes = await openNoteStore(st);
    let spent: Awaited<ReturnType<typeof spentNotesOf>>;
    try {
      spent = await spentNotesOf(notes, scope!);
    } finally {
      notes.close();
    }
    if (spent.length === 0) return [];
    const derived = await locks.request(WALLET_SEED_LOCK, { mode: "shared", signal }, async () => {
      const seed64 = await page.seed64();
      try {
        return derivedBuyWallets(seed64, [{ id: pin!.program, chain: "sol", spent, reader }]);
      } finally {
        seed64.fill(0);
      }
    });
    const got = await derived.read({ signal, only });
    if (got.failed.length > 0) throw new Error("the buy wallets could not be derived");
    return got.wallets.map((w) => ({ address: w.address, tokens: unread.has(w.address) ? null : new Map([...w.holdings.tokens].map(([m, h]) => [m, h.amount] as const)) }));
  };
  // a full sell this device signs (W's rent-back record names it, written before the sell leaves the device): noted for
  // the positions' gone rule (src/positions.ts header); a note that fails changes nothing in the sell. The store's own
  // rent-back records (pool-sell.ts owedRentBacks) underneath, as the host has always named them (scripts/live-checks/
  // sol-w-sweep.mjs reads the host's owed: and bought: from its store)
  const asRecord = (v: unknown): Record<string, unknown> => ({ ...(typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}) });
  const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // a signed Solana tx's signatures (base58): its count (one byte, under 128), then 64 bytes each
  const signaturesOf = (tx: string): string[] => {
    try {
      const b = base64.decode(tx);
      const n = b[0] ?? 0;
      if (n === 0 || n > 127 || b.length < 1 + 64 * n) return [];
      return Array.from({ length: n }, (_, i) => base58.encode(b.subarray(1 + 64 * i, 65 + 64 * i)));
    } catch {
      return [];
    }
  };
  // a sell that ended not landed (the chain's answer, never before it): its full-sell marks taken back, its signature
  // kept so the same sell never marks again; the positions read again after
  const unsold = async (signature: string): Promise<void> => {
    const st = await page.store();
    await st.update("meta", POSITIONS_UNLANDED_KEY, (v) => [...new Set([...asList(v), signature])]);
    const by = asRecord(await st.get("meta", POSITIONS_SOLD_TX_KEY));
    const gone = Object.entries(by).filter(([, sigs]) => typeof sigs === "string" && sigs.split(" ").includes(signature)).map(([k]) => k);
    if (gone.length === 0) return;
    await st.update("meta", POSITIONS_SOLD_KEY, (v) => {
      const all = asRecord(v);
      for (const k of gone) {
        const [a, m] = k.split(" ") as [string, string];
        all[a] = asList(all[a]).filter((x) => x !== m);
      }
      return all;
    });
    await st.update("meta", POSITIONS_SOLD_TX_KEY, (v) => {
      const all = asRecord(v);
      for (const k of gone) delete all[k];
      return all;
    });
  };
  const owedNoted = (store: TestnetPage["store"]): ReturnType<typeof owedRentBacks> => {
    const owed = owedRentBacks(store);
    return {
      ...owed,
      put: async (rec) => {
        await owed.put(rec);
        if (Object.keys(rec.sell ?? {}).length === 0) return;
        try {
          const st = await page.store();
          // a sell that ended not landed marks nothing again (a rent back's later write carries its record)
          const unlanded = new Set(asList(await st.get("meta", POSITIONS_UNLANDED_KEY)));
          const sells = Object.entries(rec.sell ?? {}).map(([m, by]) => [m, signaturesOf(by.tx)] as const).filter(([, sigs]) => !sigs.some((g) => unlanded.has(g)));
          if (sells.length === 0) return;
          await st.update("meta", POSITIONS_SOLD_TX_KEY, (v) => ({ ...asRecord(v), ...Object.fromEntries(sells.map(([m, sigs]) => [`${rec.address} ${m}`, sigs.join(" ")])) }));
          await st.update("meta", POSITIONS_SOLD_KEY, (v) => {
            const all = asRecord(v);
            all[rec.address] = [...new Set([...asList(all[rec.address]), ...sells.map(([m]) => m)])];
            return all;
          });
        } catch {
          /* a note that fails changes nothing in the sell */
        }
      },
    };
  };
  positions.watch(() => {
    for (const f of watchers) f();
  });
  const TRADE_ENDS: ReadonlySet<string> = new Set(["filled", "part_filled", "not_landed"]);
  // a pool buy, its records written once its run ends (src/positions.ts recordPoolBuy: its ops record, and W's buy record
  // for the cost), the positions read again after them; its W and the amount W received come from the run's own route
  // facts, the price is the page's own read at the request. The kind's `after` settles at its first answer, which may be
  // "sent" while the run goes on (poolBuyKind): the run's end stage is the progress it always posts at its end, so the
  // records wait for an end stage, from the answer or from that progress, whichever comes first; once.
  const recordedBuy = (ask: PoolAsk, ctx: KindContext): ReturnType<typeof buy> => {
    const facts: PoolBuyFacts = { token: ask.token!, spend: ask.amount, spendDecimals: ask.decimals, price: page.price?.("solana") ?? null, createdMs: Date.now() };
    let done = false;
    let r: ReturnType<typeof buy> | null = null;
    const finish = (end: Parameters<typeof recordPoolBuy>[3]): void => {
      if (done) return;
      done = true;
      if (facts.wallet !== undefined) {
        facts.decimals = boughtDecimals.get(facts.wallet);
        boughtDecimals.delete(facts.wallet);
        if (end !== null && "result" in end && end.result.stage !== "not_landed") awaited.set(facts.wallet, ctx.id);
      }
      void (async () => recordPoolBuy((await page.store()) as unknown as BuyRecordStore, ctx.id, facts, end))()
        .catch(() => {})
        .finally(() => positions.refresh());
    };
    const txsOf = (): TxRef[] => {
      const a = r && "answer" in r ? (r.answer() as { result?: { txs?: TxRef[] } }) : null;
      return a?.result?.txs ?? [];
    };
    const progress = (stage: Parameters<KindContext["progress"]>[0]): void => {
      ctx.progress(stage);
      if (TRADE_ENDS.has(stage)) finish({ result: { stage, txs: txsOf() } });
      // the run ended "sent" (its spend not read as final): no records, its W looked for, its decimals let go
      else if (stage === "sent" && !done && facts.wallet !== undefined) {
        boughtDecimals.delete(facts.wallet);
        awaited.set(facts.wallet, ctx.id);
        positions.refresh();
      }
    };
    r = buy(ask, { ...ctx, progress, route: routeInto(facts, ctx.route) });
    const run = r;
    if ("after" in run)
      void run.after.then(() => {
        const a = run.answer() as Parameters<typeof recordPoolBuy>[3];
        if (a !== null && ("error" in a || TRADE_ENDS.has(a.result.stage))) finish(a);
        else positions.refresh();
      });
    return run;
  };
  // a pool sell's run, the positions read again once it ends: its `after` settles at its first answer, which may be "sent"
  // while the run goes on (poolSellKind answers at the send), so as for the buy, an end stage from the answer or from the
  // progress the run posts at its end; a refusal ran nothing, read again all the same. A sell a closed page left is
  // read again when the settle on load writes its end (settleSells).
  const recordedSell = (ask: PoolAsk, ctx: KindContext): ReturnType<typeof sell> => {
    // not landed: its marks taken back first (the signature from its ops record, written before the send)
    const ended = (stage: string | undefined): void => {
      if (stage !== "not_landed") return positions.refresh();
      void (async () => {
        const hash = ((await (await page.store()).get("ops", ctx.id)) as { txs?: { hash?: unknown }[] } | undefined)?.txs?.[0]?.hash;
        if (typeof hash === "string") await unsold(hash);
      })()
        .catch(() => {})
        .finally(() => positions.refresh());
    };
    const progress = (stage: Parameters<KindContext["progress"]>[0]): void => {
      ctx.progress(stage);
      if (TRADE_ENDS.has(stage)) ended(stage);
    };
    const run = sell(ask, { ...ctx, progress });
    if ("after" in run)
      void run.after.then(() => {
        const a = run.answer() as { result?: { stage?: string } };
        if (a.result?.stage !== "sent") ended(a.result?.stage);
      });
    return run;
  };
  // pool.sell: W from the page's buy wallets; one run per tap, one at a time (the sell kind's lock)
  const sellHost = (sale = false): PoolSellKindHost & { end(): void } => {
    const r = rpcs();
    // the sign outs asked before this host: one asked after it stops its sales before their signatures (review P3-5 of
    // 77055f4e)
    const outs = signOuts;
    let notes: Promise<NoteStore> | null = null;
    const store = (): Promise<NoteStore> => (notes ??= page.store().then((w) => openNoteStore(w)));
    return {
      pin: pin!,
      rpcs: r,
      notes: store,
      ops: page.store,
      seed64: page.seed64,
      // the sell's own read holds the positions' passes off while it runs (the running one stopped, a booked retry
      // dropped: one finder queue, so it never waits behind the display), then is the next pass's read; a read that
      // fails still ends the hold, and the next pass reads the finder (a rent back at load reads here too)
      wallets: async () => {
        const hold = positions.preempt();
        let found: FoundWallet[] | null = null;
        try {
          // a sale's list with no read at the tap (card pool-sell-legs-side-by-side): every W the pool's spent notes
          // paid, derived from the seed, each with the tokens the last whole positions pass listed it holding; the sale
          // reads each W it sells from itself (pool-sell.ts planReads: the Ws a buy record or this listing names for the
          // token, one W per request); the passes' next read is the kept pass itself (a W it did not list: unread, so
          // it keeps its last), so no finder read starts beside the sale. No whole pass kept yet (a restored device
          // before its first pass), or a load's rent back: the finder's read, as before
          const listed = sale ? keptListed(await (await page.store()).get("meta", POSITIONS_KEPT_KEY)) : null;
          if (listed !== null) {
            const spent = await spentNotesOf(await store(), scope!);
            const seed64 = await page.seed64();
            let got: ReturnType<typeof buyWalletsOf>;
            try {
              got = buyWalletsOf(seed64, [{ id: pin!.program, chain: "sol", spent }]);
            } finally {
              seed64.fill(0);
            }
            if (got.failed.length > 0) throw new Error("the buy wallets could not be derived");
            found = got.wallets.map((w) => ({ address: w.address, tokens: listed.has(w.address) ? new Map(listed.get(w.address)) : null }));
            return got.wallets.map((w) => ({ ...w, holdings: { native: 0n, tokens: new Map([...(listed.get(w.address) ?? [])].map(([m, a]) => [m, { amount: a, frozen: false }] as const)), unreadable: [] } }));
          }
          // a sale's list: its Ws asked side by side (card pool-sell-legs-side-by-side)
          const got = await poolBuyWallets(await store(), r, undefined, true);
          found = got.map((w) => ({ address: w.address, tokens: new Map([...w.holdings.tokens].map(([m, h]) => [m, h.amount] as const)) }));
          return got;
        } finally {
          // read, or listed from the kept pass: the next pass's read; failed (the sell refuses, or a rent back at load
          // waits): the next pass reads
          if (found === null) hold.release();
          else hold.feed(found);
        }
      },
      // the rent backs owed (card sol-buy-rent-back), run again at the next load while owed
      owed: owedNoted(page.store),
      bought: buyMints(page.store),
      // each rent-back fault and end, on the page's console: public words only (W's address, a step, a fault's name)
      told: (t) => console.warn(`rent back ${t.address} ${t.step} ${t.state}: ${t.detail}`),
      // the sells with no deposit back (kept on W) sent and not settled yet, settled at the next load
      kept: keptSells(page.store),
      // a sale settled outside a request's run (the load's rent back settles the note it finds INCOMING first): its
      // stage on the record that names it, so no record stays "sent" for good (review P2-2 of 77055f4e); a request's
      // run puts its own over this one (poolSellKind)
      settled: async (signature, stage) => settleSellOps(await page.store(), signature, stage),
      stopped: () => signOuts !== outs,
      // a sign out ends the sale's waits (read-waits.ts waitUnless)
      signal: solanaStop.signal,
      end: () => void notes?.then((n) => n.close(), () => {}),
    };
  };
  const sell = (over.tradeKinds?.sell ?? poolSellKind)(() => sellHost(true));
  // the sells a closed or reloaded page left INCOMING: each settled by the run's own verdict rules, its ops record's
  // stage written; under the seed's shared lock, as every pass that writes the store (a sign out waits for it)
  const settleSells = async (): Promise<void> => {
    if (!locks) return;
    await locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
      const notes = await openNoteStore(await page.store());
      try {
        const ops = await page.store();
        // each sell's stage written before its record goes (a write that fails keeps it for the next read)
        await settlePoolSells({ pin: pin!, rpcs: rpcs(), notes: async () => notes, kept: keptSells(page.store), settled: async (signature, stage) => {
          await settleSellOps(ops, signature, stage);
          // a sell's end, written: its tokens read again (card signpage-state-holdings), a not landed one's marks back
          if (stage === "not_landed") await unsold(signature).catch(() => {});
          positions.refresh();
        } }, locks);
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
    // the stop's signal of this pass, taken before its first wait: a sign out while the pass waits for the lock or reads
    // the seed stops it (review P3-3 of e3489b3b)
    const signal = solanaStop.signal;
    await locks.request(WALLET_SEED_LOCK, { mode: "shared", signal }, async () => {
      const notes = await openNoteStore(await page.store());
      let seed64: Uint8Array | null = null;
      try {
        seed64 = await page.seed64();
        signal.throwIfAborted();
        const pass = await solanaSettleReserved({ seed64, notes, program: pin!.program, rpcs: settleRpcs(), lister: lister(), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES });
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
            settle: (noteId) => {
              const signal = solanaStop.signal;
              return withSeed((seed64) => solanaSettleSpent({ seed64, notes, noteId, program: pin.program, rpcs: settleRpcs(), lister: lister(), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES }));
            },
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
  // the EVM pools' open deposits, their RESERVED notes and their queues' passes run on every state read beside the
  // Solana pool's part (none pinned: only theirs): neither waits on the other, and one that fails or hangs never stops
  // the other
  const stateRead = (): Promise<void> => {
    armTurn();
    const evm = evmRead().catch(() => {});
    if (scope === null) return evm;
    return Promise.all([evm, solanaRead()]).then(() => {});
  };
  const solanaRead = (): Promise<void> => {
    if (reading) return reading;
    const p = (async () => {
      try {
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
            settle: async (noteId, minSlots) => {
              const signal = solanaStop.signal;
              const seed64 = await page.seed64();
              try {
                return await solanaSettleSpent({ seed64, notes, noteId, program: pin.program, minSlots, rpcs: settleRpcs(), lister: lister(), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES });
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
          : ask.kind === "pool.buy"
            ? (evmBuy(ask.chain)?.(ask, ctx) ?? { error: "not_allowed" })
            : { error: "not_allowed" }
        : pin === undefined
        ? { error: "not_allowed" }
        : ask.kind === "pool.deposit"
          ? deposit(ask, ctx)
          : ask.kind === "pool.buy" && Object.keys(tables).length > 0
            ? recordedBuy(ask, ctx)
            : ask.kind === "pool.sell"
              ? recordedSell(ask, ctx)
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
    positions: () => positions.read(),
    proofs,
    // every open queue's ready list (Solana's, then each EVM pool's; each proof names its pool) with `read`, in one turn
    // of every queue's view: each queue's readyWith holds its view while the next one's and then `read` run, always in
    // the same order, so no swap of any queue falls between its list and the notes
    readyWith: async <T,>(read: () => Promise<T>) => {
      const qs: ProofQueue<unknown>[] = [];
      const ids = new Set<string>();
      for (const p of [open, ...evmQueues.values()]) {
        const q = p ? await p.catch(() => null) : null;
        if (q) {
          qs.push(q.queue);
          ids.add(q.poolId);
        }
      }
      if (qs.length === 0) return { ready: undefined, value: await read(), open: ids };
      const ready: ReadyProof[] = [];
      const turn = async (i: number): Promise<T> => {
        if (i === qs.length) return read();
        const r = await qs[i]!.readyWith(() => turn(i + 1));
        ready.unshift(...r.ready);
        return r.value;
      };
      const value = await turn(0);
      return { ready, value, open: ids };
    },
    watch: (fn) => void watchers.add(fn),
    signingOut: () => {
      stopTurn();
      signOuts++;
      stopSolana();
      evmStop.abort();
      evmStop = new AbortController();
    },
    signedOut,
    // the session's sign out: aborted at the next one (this tab's or another's), as every Solana settle's stop
    outSignal: () => solanaStop.signal,
    withdrawDeps,
    withdraw,
  };
}
