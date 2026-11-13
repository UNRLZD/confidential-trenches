// The pool kinds' pins and providers in the testnet build (card signpage-pool-flow; ../../wallet/src/pool/network.ts).
// - Solana: the devnet pool SOL_POOLS pins in that build, read on two devnet RPCs of different operators, the pair
//   scripts/live-checks/helper-pool-senders.mjs reads the devnet Rent sysvar on (RENT_RPCS.devnet).
// - Base Sepolia and Robinhood testnet: the two RPCs each testnet pin was read on (scripts/live-checks/pool-evm-deploy.mjs
//   CHAINS, card evm-venues-pin), each answered as the app's "base" and "robinhood". A chain is pinned only when the
//   wallet's EVM_POOLS holds its testnet pool (SIGN_HOST's build: its mainnet one, card evm-pools-on-mainnet).
// - The flow (card signpage-pool-notes): pool.deposit on the devnet pool (src/pool-deposit.ts), with the page's own
//   note store and seed; on Base or Robinhood (card pool-deposits) pool.deposit goes to src/pool-deposit-evm.ts when that
//   chain's EVM pin exists on the page's network and the page has its two RPCs (else refused not_allowed). One rule holds
//   every chain (poolWayOut, card evm-deposit-on-mainnet): a pool's deposit address, its deposit and its every trade
//   open only where this build carries its withdraw. On mainnet the EVM positions read each W on the helper's route alone
//   (pageEvmPassReads), and a sale's finding reads, on the pool's two RPCs, only the Ws whose buy record names its token
//   (planEvmSell). A signed-in load
//   finishes the pool's INCOMING notes, and so does each state read of the page while one is open (card
//   signpage-pool-notes-2), one pass at a time.
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
//   of the pool's SPENT and RESERVED notes (../../wallet/src/pool/buy-wallets.ts spentNotesOf, derivedBuyWallets), the
//   holdings read only of the Ws with no buy record (wantedBuyWallets; a recorded W is its mint's seller or no seller:
//   pool-sell.ts planPoolSell, card wallets-found-in-one-read). A testnet-only choice: those holdings are read on ONE devnet RPC (solanaHoldingsAt on the first),
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
import { SOLANA_RPC_RETRY, SOLANA_RPC_WINDOW_RETRY, solanaJsonRpc, solanaPacedRpc, solanaWrappedRpc, type SolanaRpc, type SolanaRpcRetry } from "../../kit/src/trade/solana/send.ts";
import { lanedRpc, pageHelperRpc, pageHelperRpcStopped, pageRpc, seatHosts, seatRpc, type ReadKind } from "./page-rpc.ts";
import { holdHosts, laneFetch, stopHostLaneWaits } from "../../wallet/src/throttle.ts";
import { HELPER_FETCH_INIT, HELPER_V1_PATHS } from "../../kit/src/helper/v1.ts";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { openNoteStore, readNotes, readReservedMarks, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { chainNow, failAs, type Pool, type ReadyProof } from "../../wallet/src/pool/pool.ts";
import { openProofQueue, PassFail, type ProofQueue, type QueuePass } from "../../wallet/src/pool/queue.ts";
import { poolDepositKind, type PoolDepositFrom, type PoolDepositHost } from "./pool-deposit.ts";
import { proverHost } from "./prover-host.ts";
import { SOLANA_PUBLIC_SEAT, TRADE_HELPER, type TradeStore } from "./trade.ts";
import { SOL_EPOCH_MS, SOL_LIFE_MS, SOL_POOL_TABLES, SOL_POOLS, solanaNow, solanaPool, solanaPoolOf, type SolanaFeeAnswer, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { SOL_MARK_READ_BATCH, SOL_MARK_READ_BATCH_MAX, solanaSettleReserved, solanaSettleSpent, solanaSettleSpentSet, type SolanaPoolCache } from "../../wallet/src/pool/solana-restore.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { askWhileBusy, type BusyOpts } from "../../wallet/src/busy.ts";
import { lateBuyEnd, POOL_SEND_BUSY_WAIT_MS, PoolSendBusy, PoolSendRefused, poolBuyKind, resumePieces, type OwedPieces, type PiecesOwed, type PoolBuyHost } from "./pool-buy.ts";
import { heldWs, ownWs } from "./pool-found.ts";
import { boughtSincePass, keptHeldOf, type StoreWs } from "./pool-sell-dry.ts";
import { BUY_MINTS_KEY, buyMints, keptSells, owedRentBacks, poolSellKind, READS_NONE, resumeRentBacks, settleDeadSellOps, settlePoolSells, settleSellOps, type OwedRentBack, type PoolSellKindHost } from "./pool-sell.ts";
import { derivedBuyWallets, evmHelperKeyedRpc, evmHelperRpc, solanaHelperHoldings, solanaHoldingsAt, spentNotesOf, wantedBuyWallets, type BuyWallet, type HoldingsReader, type ListedBuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { keptListed, keptPositions, POSITION_COSTS_KEY, POSITIONS_KEPT_KEY, POSITIONS_SOLD_KEY, POSITIONS_SOLD_TX_KEY, POSITIONS_UNLANDED_KEY, positionsCache, positionsPass, recordBoughtOut, solanaAssetHeld, recordPoolBuy, routeInto, type BuyRecordStore, type FoundWallet, type PoolBuyFacts, type Position, type PositionCosts } from "./positions.ts";
import { evmStoredHold } from "../../wallet/src/pool/evm-hold-store.ts";
import { EVM_CHAIN_IDS, EVM_EPOCH_MS, EVM_LIFE_MS, EVM_POOLS, evmFeeHold, evmNow, evmPair, evmRetryLag, evmPool as walletEvmPool, evmPoolScopeOf, evmTreeSync, type EvmFeeAnswer, type EvmFeeHold, type EvmPoolOf, type EvmPoolPin, type EvmPoolRequest, type EvmRpc, type EvmSyncHold, type EvmTreeSync } from "../../wallet/src/pool/evm.ts";
import { evmSettleOpen, evmSettleReserved } from "../../wallet/src/pool/evm-settle.ts";
import type { LandedRelease } from "../../wallet/src/pool/balances.ts";
import { spendOwner } from "./pool-spend.ts";
import { evmPoolFee, evmPoolGas } from "../../kit/src/trade/evm/pool-fee.ts";
import { poolDepositEvmKind, type EvmDepositRound } from "./pool-deposit-evm.ts";
import { EVM_POSITION_COSTS_KEY, evmBuyHost, followPendingEvmBuys, poolBuyEvmKind, type EvmBuyPage } from "./pool-buy-evm.ts";
import { EVM_POSITIONS_REARM_MS, EVM_POSITIONS_STAGGER_MS, evmPositionsPass, evmPositionsRetryMs, evmSaleHolds, staggered, type EvmSaleHolds } from "./positions-evm.ts";
import { EVM_OPEN_SELLS_KEY, evmSellHost, followEvmSells, poolSellEvmKind } from "./pool-sell-evm.ts";
import { EvmSendBusy } from "./evm-send.ts";
import { keptTokenDecimals, PAGE_TOKEN_DECIMALS, type PoolKindsDeps, type PoolRpc } from "./pool-kinds.ts";
import { checkPoolRequest, tokenDecimalsShown, type PoolAsk, type PoolChain, type PoolRequest } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import { readSolanaRent, solanaPoolFee } from "../../kit/src/trade/solana/pool-buy.ts";
import type { PoolStatePrice, TxRef, WithdrawStage } from "../../kit/src/signpage/messages.ts";
import { WITHDRAW_BOUNDARY_LAG_MS, finishPoolOnward, runPoolWithdraw, solanaOnwardFee, solanaWithdrawMinPart, withdrawSources, type Arrivals, type HistoryPlaces, type PendingOnward } from "./pool-withdraw.ts";
import { EVM_WITHDRAW_BOUNDARY_LAG_MS, evmKeptOnwards, evmWithdrawFunds, finishEvmOnward, runEvmPoolWithdraw, type EvmFinishState, type EvmHeldOnW, type EvmPendingOnward, type EvmWithdrawHost } from "./pool-withdraw-evm.ts";
import { evmPoolSend } from "./evm-send.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import type { PoolFunds, PoolReady, PoolWithdrawFormDeps } from "./withdraw/pool-form.ts";
import { EVM_POOL_HISTORY } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { solanaBuysAt, solanaHelperBuys } from "../../wallet/src/pool/buy-wallets.ts";
import { BUY_NONE_KEY, solBuyRecords, tradesDone, tradesFrom, writeTradeOps, type TradesStore } from "./sol-buy-records.ts";
import { fillTradeOps, type FillStore } from "./trade-fill.ts";
import { POOL_USD_FEEDS } from "../../kit/src/price/pool-usd.ts";

// The freezes are marked pure, so SIGN_HOST's build, which never reads these, drops them whole (scripts/build-network.test.mjs).
/** Each chain's two testnet RPCs, as the app names the chain. Solana's are mainnet's shape (main.ts: a public provider
 *  and the helper's /v1/rpc/solana): the public devnet endpoint and the helper's /v1/rpc/solana-devnet, whose keyed
 *  provider is another operator's (card pool-buy-send-fast: the public second provider before it, onfinality, answers 1
 *  request a second and 1000 a day per IP, and held the 5 Nov 13:50:55Z buy 11.2 s in these reads). Devnet's public seat
 *  is api.devnet alone, with no spare as mainnet's has (src/trade.ts SOLANA_PUBLIC_SEAT): read from Chrome on 2026-11-11
 *  05:19Z, Tatum's devnet gateway answered 5 reads, then 429 to each; PublicNode's devnet RPC refuses a page's CORS;
 *  Ankr asks a key and dRPC a paid plan. The spare's tests run on fake providers (test/page-rpc.test.ts). */
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
export const testnetRpc = (url: string, helperRetry: SolanaRpcRetry = SOLANA_RPC_RETRY, kind: ReadKind = "trade"): SolanaRpc =>
  url.startsWith(`${TRADE_HELPER}/`) ? lanedRpc(url, { kind, retry: helperRetry, init: HELPER_FETCH_INIT }) : pageRpc(url, kind);
/** The rent backs' retry while a W is left to try (card round-trip-costs-less): the first wait and the most, doubling. */
export const BACKS_FIRST_MS = 30_000;
export const BACKS_MAX_MS = 600_000;
/** A load's first run of the rent backs, at the first state read past a time drawn once a load from [MIN, MAX] after it
 *  (review P2-1 of 024e8a89d): no leftover W's pass goes at the instant a page opens, which a network could tie to the
 *  page's own first reads. */
export const BACKS_LOAD_MIN_MS = 15_000;
export const BACKS_LOAD_MAX_MS = 60_000;
const drawLoadStart = (): number => {
  const span = BACKS_LOAD_MAX_MS - BACKS_LOAD_MIN_MS + 1;
  const b = new Uint32Array(1);
  const max = Math.floor(0x1_0000_0000 / span) * span;
  do globalThis.crypto.getRandomValues(b);
  while (b[0]! >= max);
  return BACKS_LOAD_MIN_MS + (b[0]! % span);
};
/** When the rent backs run (card round-trip-costs-less): one run at a time, on a state read once due; a run that leaves
 *  a W to try again books the next at a wait doubling from BACKS_FIRST_MS to BACKS_MAX_MS, one that leaves none (or the
 *  run's own failure: the next load's) books none, until `again` (a full sell wrote a new owed record). No timer: a run
 *  only ever starts on a state read the page makes anyway. */
export function backsSchedule(now: () => number = () => Date.now(), first: number = drawLoadStart()) {
  let running = false;
  // the load's first run: not before the drawn start, a full sell's `again` included
  const start = now() + first;
  let at = start;
  let wait = BACKS_FIRST_MS;
  return {
    /** Whether a run starts now; if so, it is marked running. */
    take(): boolean {
      if (running || now() < at) return false;
      running = true;
      return true;
    },
    /** The run ended: `more`, a W left to try again. */
    ended(more: boolean): void {
      running = false;
      if (more) {
        at = now() + wait;
        wait = Math.min(wait * 2, BACKS_MAX_MS);
      } else {
        at = Number.POSITIVE_INFINITY;
        wait = BACKS_FIRST_MS;
      }
    },
    /** A full sell wrote a new owed record: the next state read runs. */
    again(): void {
      at = start;
      wait = BACKS_FIRST_MS;
    },
  };
}
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
/** The read of each W's asset_held (card portfolio-counts-money-an-open-buy-holds) on the finder's own route, never a
 *  public provider: on mainnet the helper's keyed route with the pass's stop in its every fetch, so nothing of a
 *  signed-out account's is sent after the sign out, queued or tried again (as the pass's decimals read); in the testnet
 *  build the devnet RPC the finder reads (POOL_TESTNET folded at build time, so SIGN_HOST's bundle names no devnet RPC). */
export const pageAssetHeldRpc = (signal: AbortSignal): SolanaRpc =>
  solanaPacedRpc(POOL_TESTNET ? testnetRpc(TESTNET_RPCS.solana[0], SOLANA_RPC_RETRY, "pass") : pageHelperRpcStopped(TRADE_HELPER, signal, "pass"));

/** Where a mainnet W's balance is read for its positions (decision M359): the helper's route alone (POST
 *  /v1/rpc/{chain}, the wallet's evmHelperRpc, the holdings readers' one paced queue, which the restore's W reads share),
 *  so a provider the device reaches itself is never named a W of it, nor two in one burst. A sale reads none of it: its
 *  finding gates its signature, so it reads on the pool's two RPCs (src/pool-sell-evm.ts planEvmSell). None in the
 *  testnet build, whose helper has no route for the chain: there the pool's two RPCs read each W, as before. */
export const pageEvmWalletRpc = (chain: "base" | "robinhood", testnet: boolean = POOL_TESTNET): EvmRpc | undefined => {
  if (testnet) return undefined;
  let r = WALLET_RPCS.get(chain);
  if (r === undefined) {
    const route = evmHelperRpc(TRADE_HELPER, chain);
    WALLET_RPCS.set(chain, (r = Object.assign((method: string, params: readonly unknown[]) => route(method, params), { url: `${TRADE_HELPER}/v1/rpc/${chain}` }) as EvmRpc));
  }
  return r;
};
const WALLET_RPCS = new Map<"base" | "robinhood", EvmRpc>();
/** A positions pass's readers (src/positions-evm.ts): the pool's pass pair, and on SIGN_HOST's build the helper's route
 *  as `one`, every W's balance read on it alone; the pair alone in the testnet build. */
export const pageEvmPassReads = (chain: "base" | "robinhood", rpcs: readonly [EvmRpc, EvmRpc], testnet: boolean = POOL_TESTNET): { rpcs: readonly [EvmRpc, EvmRpc]; one?: EvmRpc } => {
  const one = pageEvmWalletRpc(chain, testnet);
  return one === undefined ? { rpcs } : { rpcs, one };
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
export const pageEvmPoolRpcs = (chain: "base" | "robinhood", kind: ReadKind = "trade"): readonly EvmRpc[] | null => {
  const urls = pageEvmPoolUrls(chain);
  return urls.length < 2 ? null : urls.map((u) => testnetRpc(u, SOLANA_RPC_RETRY, kind));
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
export const pageEvmFeeRpcs = (chain: "base" | "robinhood", kind: ReadKind = "trade"): readonly EvmRpc[] => (POOL_TESTNET ? TESTNET_EVM_FEE_RPCS[chain] : MAINNET_EVM_FEE_RPCS[chain]).map((u) => testnetRpc(u, SOLANA_RPC_RETRY, kind));
/** The kit's epoch fee rule (../../wallet/src/pool/evm.ts EvmEpochFeeRule): the helper's own (apps/helper pool/evm.ts). */
export const evmEpochFee = (at: { baseFeePerGas: bigint; depth: number; chainFee: bigint }): bigint => evmPoolFee({ gas: evmPoolGas(at.depth), gasPrice: at.baseFeePerGas, chainFee: at.chainFee });
/** The Solana pool the page's network pins: SOL_POOLS.devnet in the testnet build, SOL_POOLS.mainnet (card sol-pools-mainnet-pin) on SIGN_HOST's. */
export const PAGE_SOL_PIN: SolanaPoolPin | undefined = POOL_TESTNET ? SOL_POOLS.devnet : SOL_POOLS.mainnet;
/** The page's Solana cluster: the fee route's and pool.buy's (its tip). */
export const PAGE_CLUSTER: "mainnet" | "devnet" = POOL_TESTNET ? "devnet" : "mainnet";
/** The pool chains whose withdraw this build carries (card evm-deposit-on-mainnet): Solana's, Base's and Robinhood's
 *  (src/pool-withdraw-evm.ts) on both builds. */
export const POOL_WITHDRAW_BUILT: Readonly<Record<"solana" | "base" | "robinhood", boolean>> = Object.freeze({ solana: true, base: true, robinhood: true });
/** The one rule (card evm-deposit-on-mainnet): a pool's deposit address (main.ts pageAddressPools), its deposit and its
 *  every trade open only on a chain whose withdraw is in the same build, so money never goes where the page cannot take
 *  it out. `built`: POOL_WITHDRAW_BUILT, or a test's plant. */
export const poolWayOut = (chain: PoolChain, built: Readonly<Partial<Record<PoolChain, boolean>>> = POOL_WITHDRAW_BUILT): boolean => built[chain] === true;
/** The codes a proof pass's console line names, in its order (the queue's PassReason and its notes under the least rung). */
export const PASS_CODES = ["network", "fee_refused", "prover_failed", "too_small", "held_elsewhere"] as const;
/**
 * A proof pass's console line (card buy-spends-several-pieces): `pool pass: <chain> failed <code>=<count> ...`, for a
 * pass whose notes failed (each by the step the queue names, ../../wallet/src/pool/queue.ts PassFail), that left notes
 * under the pool's smallest rung unproved, or that failed whole at a pool read (`thrown`); null when none. Codes and
 * counts only: never a note, an address, an amount, an epoch or an error's text, so DevTools and a walk read why no proof
 * is ready and nothing of the account.
 */
export function passLine(chain: string, pass: QueuePass | undefined, thrown?: unknown): string | null {
  const n = new Map<string, number>();
  const add = (code: string, k = 1): void => void n.set(code, (n.get(code) ?? 0) + k);
  for (const f of pass?.failed ?? []) if (f.reason !== undefined) add(f.reason);
  if (pass?.small !== undefined && pass.small > 0) add("too_small", pass.small);
  if (thrown instanceof PassFail) add(thrown.reason);
  const parts = PASS_CODES.filter((c) => n.has(c)).map((c) => `${c}=${n.get(c)}`);
  return parts.length === 0 ? null : `pool pass: ${chain} failed ${parts.join(" ")}`;
}

/** The buys of several pieces owed their end (pool-buy.ts OwedPieces), in the wallet store's meta/owed/pieces-sol (meta/owed/
 *  is never read or listed by the frame), by W's address. */
export const piecesOwedOf = (store: () => Promise<Pick<TradeStore, "get" | "update">>): PiecesOwed => {
  const KEY = "owed/pieces-sol";
  type All = Record<string, OwedPieces>;
  return {
    list: async () => Object.values(((await (await store()).get("meta", KEY)) as All | undefined) ?? {}),
    put: async (r) =>
      void (await (await store()).update("meta", KEY, (v) => ({ ...((v as All | undefined) ?? {}), [r.address]: r }))),
    drop: async (address) =>
      void (await (await store()).update("meta", KEY, (v) => {
        const all = { ...((v as All | undefined) ?? {}) };
        if (!Object.hasOwn(all, address)) return undefined;
        delete all[address];
        return all;
      })),
  };
};

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
export const pageSolanaRpcs = (kind: ReadKind = "trade"): readonly [SolanaRpc, SolanaRpc] =>
  POOL_TESTNET
    ? [solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[0], SOLANA_RPC_RETRY, kind)), solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[1], SOLANA_RPC_RETRY, kind))]
    : [solanaPacedRpc(seatRpc(SOLANA_PUBLIC_SEAT, kind)), solanaPacedRpc(pageHelperRpc(TRADE_HELPER, SOLANA_RPC_RETRY, kind))];
/** The page's mark lister (the wallet's solanaMarksListed): MAINNET_MARKS_ROUTE, paced, on mainnet; none in the testnet
 *  build, where the wallet lists on the pair's first devnet RPC. It only names addresses: the pair reads each. */
export const pageSolanaLister = (kind: ReadKind = "trade"): SolanaRpc | undefined => (POOL_TESTNET ? undefined : solanaPacedRpc(testnetRpc(MAINNET_MARKS_ROUTE, SOLANA_RPC_RETRY, kind)));
/** The pair every Solana pool settle and the restore read the marks and pages on (review P2-1 of e3489b3b): pageSolanaRpcs'
 *  two providers, in their same paced queues, the helper's seat with SOLANA_RPC_WINDOW_RETRY. The helper answers a
 *  caller's 17th call in a 10 s window with 429 and a Retry-After of up to 10 s (apps/helper/src/rpc/rpc.ts
 *  RPC_CLIENT_MAX), past the page's 3.5 s, so a cold read of a few hundred marks failed at its first window and never
 *  closed; these reads have no quote to age, so they wait the window out. A buy, sell or withdraw keeps pageSolanaRpcs. */
export const pageSolanaSettleRpcs = (kind: ReadKind = "trade"): readonly [SolanaRpc, SolanaRpc] =>
  POOL_TESTNET
    ? [solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[0], SOLANA_RPC_RETRY, kind)), solanaPacedRpc(testnetRpc(TESTNET_RPCS.solana[1], SOLANA_RPC_WINDOW_RETRY, kind))]
    : [solanaPacedRpc(seatRpc(SOLANA_PUBLIC_SEAT, kind)), solanaPacedRpc(pageHelperRpc(TRADE_HELPER, SOLANA_RPC_WINDOW_RETRY, kind))];
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
/** One pair whose every call goes as `kind()` says at that call: `of.trade`'s or `of.pass`'s seat (card
 *  sell-right-after-a-buy: a pool buy's reads are a trade's to its early "sent", a background pass's after it). Each seat
 *  stays its provider to the kit (solanaWrappedRpc: its URL, its one queue, solanaSameProvider). */
export function kindSwitched(of: Readonly<Record<ReadKind, readonly [SolanaRpc, SolanaRpc]>>, kind: () => ReadKind): readonly [SolanaRpc, SolanaRpc] {
  return [0, 1].map((i) => solanaWrappedRpc(of.trade[i]!, (method, params) => of[kind()][i]!(method, params))) as unknown as readonly [SolanaRpc, SolanaRpc];
}
/** A pool buy's reads (card sell-right-after-a-buy): one pair, each call a trade's until its transaction landed (both
 *  RPCs read it back as succeeded, the reads that tell Filled among them: pool-buy.ts landed) and a background pass's
 *  from then on, `kind()` the same for its settle; its hosts' hold (`give`, once) given back at its early "sent"
 *  (release), else its end. Sent can come before landed (a meta not yet whole on one RPC, review of 29a9e506 P2), so the
 *  two are apart. */
export function buyReads(of: Readonly<Record<ReadKind, readonly [SolanaRpc, SolanaRpc]>>, give: () => void): { rpcs: readonly [SolanaRpc, SolanaRpc]; kind(): ReadKind; release(): void; landed(): void } {
  let kind: ReadKind = "trade";
  return {
    rpcs: kindSwitched(of, () => kind),
    kind: () => kind,
    release: give,
    landed: () => {
      kind = "pass";
    },
  };
}

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
  w: { stage?: WithdrawStage; txs?: readonly TxRef[]; arrived?: Arrivals; owe?: string; clear?: string; feeNeeded?: string; cause?: string; held?: EvmHeldOnW },
): Record<string, unknown> {
  const r = { ...(v as Record<string, unknown>) };
  const was = STAGE_RANK[r.stage as WithdrawStage] ?? -1;
  const ours = w.clear === undefined || r.owed === undefined || r.owed === w.clear;
  if (w.stage !== undefined && STAGE_RANK[w.stage] >= was && ours) r.stage = w.stage;
  if (w.feeNeeded !== undefined) r.fee_needed = w.feeNeeded;
  if (w.cause !== undefined) r.cause = w.cause;
  // why an earlier run ended is no longer the op's once it ends sent
  if (r.stage === "sent") delete r.cause;
  // a part left on W by a send that reverted: its W, index and amount, by note (src/pool-withdraw-evm.ts EvmHeldOnW)
  if (w.held !== undefined) r.held = { ...((r.held as Record<string, EvmHeldOnW> | undefined) ?? {}), [w.held.noteId]: w.held };
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
/** An EVM part's owed send kept (its release read back, W's send's hash before it leaves), only while it is still this
 *  attempt's: every W send hash signed for it stays in `onwards` (and every resend after a revert in `resends`), so
 *  whichever lands (a reload's, another tab's) is read back. One that is no longer this attempt's throws, so no send leaves unkept. */
export const keepEvmSend = async (w: WalletStore, opId: string, q: EvmPendingOnward): Promise<void> => {
  const got = await w.update("meta", owedKey(opId), (v) => {
    const r = v as OwedSends | undefined;
    const had = (r !== undefined && Object.hasOwn(r, q.noteId) ? r[q.noteId] : undefined) as EvmPendingOnward | undefined;
    if (had === undefined || had.attempt !== q.attempt) return undefined;
    const onwards = evmKeptOnwards({ onwards: [...evmKeptOnwards(had), ...evmKeptOnwards(q)] });
    const onward = q.onward ?? had.onward;
    // every resend after a revert, by hash, each with its nonce (src/pool-withdraw-evm.ts resendHeld)
    const resends = [...(had.resends ?? []), ...(q.resends ?? [])].filter((x, i, all) => all.findIndex((y) => y.hash === x.hash) === i);
    return { ...r, [q.noteId]: { ...had, ...q, ...(onward !== undefined ? { onward } : {}), ...(onwards.length > 0 ? { onwards } : {}), ...(resends.length > 0 ? { resends } : {}) } };
  });
  if (got === undefined) throw new Error("owed send: not this attempt's");
};
/** The op's owed send for `noteId` dropped, once the op no longer owes it; a later part's stays (one compare-and-set). */
export const dropSend = (w: WalletStore, opId: string, noteId: string): Promise<unknown> =>
  w.update("meta", owedKey(opId), (v) => {
    const r = v as OwedSends | undefined;
    if (r === undefined || !Object.hasOwn(r, noteId)) return undefined;
    const { [noteId]: _gone, ...rest } = r;
    return rest;
  });
/** meta's record of the notes each running withdraw (any tab's) has planned, by op id, each with the time (the device's
 *  clock, ms) until which it stands: out of every proof queue's pass and every other plan until the run ends, or, for a
 *  run that crashed, until that time (card pool-tree-read-waits-for-its-second). Every write tells the other tabs
 *  (the store's change event), whose state read runs their queue's pass, which lets go of these notes (queue.ts skip). */
export const WITHDRAW_PLANNED_KEY = "owed/withdraw-sol";
type WithdrawPlanned = Record<string, { notes: string[]; until_ms: string }>;
/** The longest span any withdraw run writes (the Solana run's keepSpan, the EVM run's evmKeepSpan, on their pools'
 *  epochs and lives): an entry whose deadline is further from now than this was written on a clock since set back. */
export const WITHDRAW_KEEP_MAX_MS = [SOL_EPOCH_MS + WITHDRAW_BOUNDARY_LAG_MS + SOL_LIFE_MS, EVM_EPOCH_MS + EVM_WITHDRAW_BOUNDARY_LAG_MS + EVM_LIFE_MS].reduce((a, b) => (a > b ? a : b));
/** An entry that stands at `nowMs`: its deadline still to come, and no further than the longest span. */
const standing = (e: { until_ms?: unknown } | undefined, nowMs: bigint): boolean =>
  typeof e?.until_ms === "string" && /^[0-9]{1,20}$/.test(e.until_ms) && BigInt(e.until_ms) > nowMs && BigInt(e.until_ms) <= nowMs + WITHDRAW_KEEP_MAX_MS;
/** The op's planned notes written to stand for `spanMs` from `nowMs` ([] drops its entry); another op's entry kept
 *  while it stands (a dead run's past its deadline, or one from a clock set back, dropped). */
export const keepOutNotes = (w: WalletStore, opId: string, noteIds: readonly string[], nowMs: bigint, spanMs: bigint): Promise<unknown> =>
  w.update("meta", WITHDRAW_PLANNED_KEY, (v) => {
    const { [opId]: _was, ...was } = (v as WithdrawPlanned | undefined) ?? {};
    const r = Object.fromEntries(Object.entries(was).filter(([, e]) => standing(e, nowMs)));
    return noteIds.length === 0 ? r : { ...r, [opId]: { notes: [...noteIds], until_ms: (nowMs + spanMs).toString() } };
  });
/** The notes a withdraw run still holds out at `nowMs`: every entry that stands. */
export async function keptOutNotes(w: WalletStore, nowMs: bigint): Promise<Set<string>> {
  const r = ((await w.get("meta", WITHDRAW_PLANNED_KEY)) as WithdrawPlanned | undefined) ?? {};
  const out = new Set<string>();
  for (const e of Object.values(r)) if (standing(e, nowMs)) for (const id of e.notes ?? []) out.add(id);
  return out;
}
/** An EVM run's stage written (its stage hook): the stage, its txs and arrivals, and `held` (a part left on W by a send
 *  that reverted) in one merge, so a page closed after it never loses `held`; with no owed send left (`cleared`, the
 *  note it owed), that note's owed send cleared and dropped. */
export async function writeEvmStage(ops: WalletStore, opId: string, w: { stage: WithdrawStage; txs: TxRef[]; arrived: Arrivals; held?: EvmHeldOnW | undefined }, cleared: string | null): Promise<void> {
  await ops.update("ops", opId, (v) => mergeWithdrawOp(v, { stage: w.stage, txs: w.txs, arrived: w.arrived, ...(w.held ? { held: w.held } : {}), ...(cleared ? { clear: cleared } : {}) }));
  if (cleared) await dropSend(ops, opId, cleared);
}
/** An EVM finish's answer written (src/pool-withdraw-evm.ts finishEvmOnward): in_transit (the fee it needs, or a part
 *  held on W) merged with `fee_needed` and `held` in one write, the owed send kept for the next pass (true); any other end
 *  merged and the owed send for `noteId` cleared and dropped (false). */
export async function writeEvmFinish(ops: WalletStore, opId: string, noteId: string, got: { stage: WithdrawStage; txs: TxRef[]; arrived: Arrivals; feeNeeded?: string; held?: EvmHeldOnW }): Promise<boolean> {
  const w = { stage: got.stage, txs: got.txs, arrived: got.arrived, ...(got.feeNeeded !== undefined ? { feeNeeded: got.feeNeeded } : {}), ...(got.held ? { held: got.held } : {}) };
  if (got.stage === "in_transit") {
    await ops.update("ops", opId, (v) => mergeWithdrawOp(v, w));
    return true;
  }
  await ops.update("ops", opId, (v) => mergeWithdrawOp(v, { ...w, clear: noteId }));
  await dropSend(ops, opId, noteId);
  return false;
}
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

/** The page network's deps for poolKinds, with `flow` the ops' flow (none: every checked request is refused). `rpcs` is
 *  each chain's pair, which the sell's decimals read and the page's USD price (src/pool-price.ts, the trade box's Buy)
 *  read on: on mainnet's EVM chains the pool list's two seats (pageEvmPoolRpcs, card evm-pools-on-mainnet). */
export function testnetPoolDeps(flow?: PoolKindsDeps["flow"], stop?: PoolKindsDeps["stop"]): PoolKindsDeps {
  return {
    pinned: (chain) => (chain === "solana" ? PAGE_SOL_PIN !== undefined : EVM_POOLS[POOL_TESTNET ? EVM_TESTNET[chain] : chain] !== undefined),
    rpcs: (chain) =>
      chain === "solana"
        ? (pageSolanaRpcs() as unknown as readonly [PoolRpc, PoolRpc])
        : POOL_TESTNET
          ? (TESTNET_RPCS[chain].map((u) => testnetRpc(u) as PoolRpc) as unknown as readonly [PoolRpc, PoolRpc])
          : ((pageEvmPoolRpcs(chain)?.slice(0, 2) as unknown as readonly [PoolRpc, PoolRpc] | undefined) ?? null),
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
  /** A test's two queue pools: the pass's and the one a landing's pass reads (card evm-first-proof-inside-ten-seconds). */
  evmQueuePools?: (chain: "base" | "robinhood") => { pass: Pool<unknown>; trade: Pool<unknown> };
  /** The longest the deposit's round waits for the pool's history read (EVM_WARM_WAIT_MS otherwise; tests). */
  evmWarmWaitMs?: number;
  /** The EVM turn pass's clock, timers, spread draw and tab visibility (the page's own otherwise; tests). */
  evmTurn?: EvmTurnDeps;
  /** The deposit kinds (poolDepositKind, poolDepositEvmKind otherwise): a test reads the hosts this page wires into them
   *  (its sign-out signal and its pass, fold review 3). */
  depositKinds?: { solana?: typeof poolDepositKind; evm?: typeof poolDepositEvmKind };
  /** The trade kinds (poolBuyKind, poolSellKind otherwise): a test reads the hosts this page wires into them (W's buy
   *  record, written by the buy host and read by the sell host; delta review 8 of 5697d7a1). */
  tradeKinds?: { buy?: typeof poolBuyKind; sell?: typeof poolSellKind; evmBuy?: typeof poolBuyEvmKind; evmSell?: typeof poolSellEvmKind };
  /** The buy wallets' finder reader for the page's RPCs (the helper's or a devnet RPC's otherwise; tests). */
  holdings?: (rpcs: readonly [SolanaRpc, SolanaRpc]) => HoldingsReader;
  /** The route of each W's asset_held read (src/positions.ts solanaAssetHeld): the finder's own otherwise. A test that
   *  plants `holdings` and not this gets no asset_held read, so no test reaches a real provider. */
  assetHeldRpc?: SolanaRpc;
  /** The positions cache's retry and timers (src/positions.ts; tests). */
  positions?: Parameters<typeof positionsCache>[1];
  /** The clock of a state read's ask of a spent EVM chain's pass (Date.now otherwise; tests). */
  positionsNow?: () => number;
  /** The chains whose withdraw the build carries (POOL_WITHDRAW_BUILT otherwise; tests plant a build with none). */
  withdrawBuilt?: Readonly<Partial<Record<PoolChain, boolean>>>;
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
export const helperPoolSend = (pool: string, tx: Uint8Array, fetchFn: typeof fetch = laneFetch()): Promise<unknown> =>
  helperPoolPost("/v1/pool/solana/send", { pool, tx: base64.encode(tx) }, fetchFn);
/** POST /v1/pool/solana/pieces (card buy-spends-several-pieces): a buy's pieces, every release first and the buy last,
 *  sent by the helper as one bundle, all landing or none; its answer as it came (pool-buy.ts reads each back on two
 *  RPCs). The same timeout, busy and size rules as one send. */
export const helperPoolSendPieces = (pool: string, txs: readonly Uint8Array[], fetchFn: typeof fetch = laneFetch()): Promise<unknown> =>
  helperPoolPost("/v1/pool/solana/pieces", { pool, txs: txs.map((t) => base64.encode(t)) }, fetchFn);
async function helperPoolPost(path: "/v1/pool/solana/send" | "/v1/pool/solana/pieces", payload: unknown, fetchFn: typeof fetch): Promise<unknown> {
  const window = new AbortController();
  const t = setTimeout(() => window.abort(new DOMException(`pool send: no answer in ${POOL_SEND_TIMEOUT_MS} ms`, "TimeoutError")), POOL_SEND_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${TRADE_HELPER}${path}`, {
      ...HELPER_FETCH_INIT,
      redirect: "error",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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
    // refused before anything was sent (any other 4xx: a shape, wallet, fee, blockhash or simulation the helper refused,
    // or a route an older helper does not have, 404): pool-buy.ts ends the run at once, its notes RESERVED until the
    // state reads free them
    if (res.status >= 400 && res.status < 500) {
      const body = new Uint8Array(await res.arrayBuffer());
      let code = "refused";
      try {
        const c = body.length <= 4_096 ? (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as { error?: { code?: unknown } })?.error?.code : undefined;
        if (typeof c === "string" && /^[a-z_]{1,40}$/.test(c)) code = c;
      } catch {
        // a body that is not the helper's: still its refusal
      }
      throw new PoolSendRefused(res.status, code);
    }
    if (res.status !== 200) throw new Error(`pool send: HTTP ${res.status}`);
    const SEND_ANSWER_MAX = HELPER_V1_PATHS.find((p) => p.method === "POST" && p.path === path)!.limitBytes!;
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
export async function poolRelayFee(pool: string, epochStartMs: bigint, signal?: AbortSignal, fetchFn: typeof fetch = laneFetch(), sleep?: BusyOpts["sleep"]): Promise<SolanaFeeAnswer> {
  return (await helperFee(`${TRADE_HELPER}/v1/pool/fee?cluster=${PAGE_CLUSTER}&pool=${encodeURIComponent(pool)}&epoch=${epochStartMs}`, signal, fetchFn, sleep)) as SolanaFeeAnswer;
}
/** GET /v1/pool/fee for an EVM pool (the helper keys it by the pool's lowercase address) and one epoch, as evmPool's
 *  relayFee: the answer as the helper gave it, which evmPool's bind refuses unless every field is this pool's, this
 *  epoch's and the fee the device computes from its own reads. The same waits and refusals as poolRelayFee. */
export async function evmPoolRelayFee(pool: string, epochStartMs: bigint, signal?: AbortSignal, fetchFn: typeof fetch = laneFetch(), sleep?: BusyOpts["sleep"]): Promise<EvmFeeAnswer> {
  return (await helperFee(`${TRADE_HELPER}/v1/pool/fee?pool=${encodeURIComponent(pool.toLowerCase())}&epoch=${epochStartMs}`, signal, fetchFn, sleep)) as EvmFeeAnswer;
}
async function helperFee(url: string, signal: AbortSignal | undefined, fetchFn: typeof fetch, sleep: BusyOpts["sleep"] | undefined): Promise<unknown> {
  const res = await askWhileBusy(() => {
    const timeout = AbortSignal.timeout(FEE_TIMEOUT_MS);
    return fetchFn(url, { ...HELPER_FETCH_INIT, redirect: "error", method: "GET", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  }, { signal, sleep }).catch(failAs("network"));
  // a fee read that got no answer (no connection, no answer in time, still busy: a 429 or a 5xx) is "network" on the
  // pass's line; the helper's refusal (any other status) and an answer the bind refuses are fee_refused
  if (res.status === 429 || res.status >= 500) throw new PassFail("network", new Error(`pool fee: HTTP ${res.status}`));
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
  /** pool.deposit on the page's pool of the request's chain (Solana's; Base's and Robinhood's on their pins, card
   *  evm-deposit-route-mainnet) from one fixed U_{s,i} (card pool-deposit-follow, review H1: the follow of a quote into
   *  U_X): the request checked by the pool rule as the kind's own, then run with `from`; never another U. */
  depositFrom(params: Record<string, unknown>, from: PoolDepositFrom, ctx: KindContext): HostRefusal | Running<"pool.deposit">;
  /** Base's or Robinhood's pool on this page (card evm-deposit-route-mainnet): its pin (the wallet's EVM_POOLS on the
   *  page's network) and the deposit's own pair, the reads a pool quote's floor and follow make; null with no pin. */
  evmPoolOf(chain: "base" | "robinhood"): { pin: EvmPoolPin; rpcs: readonly [EvmRpc, EvmRpc] } | null;
  /** The deposit run's host (a new one per run): its `landed` runs the proof queue's pass. */
  host(): PoolDepositHost;
  /** The INCOMING notes finished (src/pool-deposit.ts settlePoolDeposits), one pass at a time: a signed-in load. */
  settle(): Promise<void>;
  /** A signed-in state read, when no pass runs: settle the pool's INCOMING notes, then its RESERVED ones. */
  stateRead(): Promise<void>;
  /** state.positions (src/positions.ts): the last pass, or the kept one before it, null before either; the first
   *  signed-in read starts a pass. */
  positions(): Promise<readonly Position[] | null>;
  /** A restore wrote buy records of `chain`: its positions read again. */
  evmHoldingsRestored(chain: "base" | "robinhood"): void;
  /** The positions as held (positions.ts get()): the last pass, or the kept one read before it; null before either or
   *  signed out. Starts nothing: no pass, no seed read, no store write (the sell box's preview, src/pool-sell-dry.ts). */
  positionsNow(): readonly Position[] | null;
  /** The Ws whose rent back is owed, as their records stand (src/positions.ts returningWallets). */
  returning(): Promise<OwedRentBack[]>;
  /** The Ws bought since the last whole pass that name `token` (pool-sell-dry.ts boughtSincePass: W's buy mint, the kept
   *  pass, W's buy record, the full sells noted) and each W's amount as the kept pass holds it (keptHeldOf: the order a
   *  sale takes them in), from the store alone: no read, no seed; the store as held (page.held),
   *  never opened again for it (another tab's sign out may have closed it). Signed out: none. */
  boughtSince(token: string): Promise<StoreWs>;
  /** The proof queue's pass, the queue opened first when none is: what each landed note runs. Called by the restore once
   *  it wrote its notes (src/main.ts `written`), so it also starts the buy records' rebuild (src/sol-buy-records.ts). */
  proofs(): Promise<QueuePass | null>;
  /** state.pools' `ready` (src/pools.ts) with `read`'s notes, in one turn of the queue's view (queue.ts readyWith), so
   * a remake's swap never falls between the two (card pool-ready-no-flicker); `ready` undefined while no queue is open.
   * `open`: the ids of the pools whose queue is open, so a chain with no open queue reads no ready (src/pools.ts
   * withPools). `read` waits for nothing of the queue's. `making`: the notes each open queue makes a first proof for now
   * (queue.ts readyWith; card buy-spends-several-pieces), for state.pools' making. */
  readyWith<T>(read: () => Promise<T>): Promise<{ ready: readonly ReadyProof[] | undefined; value: T; open: ReadonlySet<string>; landed?: ReadonlyMap<string, LandedRelease>; making?: ReadonlySet<string> }>;
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
type OpenQueue = { queue: ProofQueue<unknown>; notes: NoteStore; poolId: string; hold?: (signal?: AbortSignal, seen?: (now: bigint) => void) => Promise<void>; landing?: () => AbortSignal };

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
/** The longest a Base or Robinhood deposit's round waits for the pool's history read the page started when it was
 *  first asked for the pool (card evm-first-proof-inside-ten-seconds): on a Base mainnet copy of 13 Nov that read took
 *  54 s with the follow's fee reads filling its hosts' pass budget and about 15 s without them. Past it, the round
 *  reads the history itself, as before. */
export const EVM_WARM_WAIT_MS = 20_000;
/** One stop for `signal` (when given) and `session`: it fires with the first one's reason; `off` takes its listeners
 *  off both, so a round that ends leaves none on a signal that outlives it. */
function eitherStop(signal: AbortSignal | undefined, session: AbortSignal): { stop: AbortSignal; off: () => void } {
  if (signal === undefined) return { stop: session, off: () => {} };
  const c = new AbortController();
  const fire = (): void => c.abort(signal.aborted ? signal.reason : session.reason);
  if (signal.aborted || session.aborted) {
    fire();
    return { stop: c.signal, off: () => {} };
  }
  signal.addEventListener("abort", fire, { once: true });
  session.addEventListener("abort", fire, { once: true });
  return { stop: c.signal, off: () => (signal.removeEventListener("abort", fire), session.removeEventListener("abort", fire)) };
}
export type EvmTurnDeps = {
  now?: () => number;
  random?: () => number;
  setTimeout?: (f: () => unknown, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  visibility?: { hidden: () => boolean; onShow: (f: () => unknown) => void } | null;
};

export function testnetPool(page: TestnetPage, over: TestnetOver = {}): TestnetPool {
  const pin = over.pin === null ? undefined : (over.pin ?? PAGE_SOL_PIN);
  // the one rule (poolWayOut): a chain's deposit and its trades open only where this build carries its withdraw
  const wayOut = (chain: PoolChain): boolean => poolWayOut(chain, over.withdrawBuilt);
  // each read a trade's own ("trade") unless it is a background pass's ("pass": the proof pass, the positions pass and
  // the state reads' settles), which waits on its host while a trade holds it (card signpage-passes-yield-to-a-trade,
  // src/page-rpc.ts)
  const rpcs = (kind: ReadKind = "trade"): readonly [SolanaRpc, SolanaRpc] => over.rpcs ?? pageSolanaRpcs(kind);
  // every settle's pair: the same two seats, the helper's waiting out its window (pageSolanaSettleRpcs)
  const settleRpcs = (kind: ReadKind = "trade"): readonly [SolanaRpc, SolanaRpc] => over.rpcs ?? pageSolanaSettleRpcs(kind);
  // the marks' lister: a test's planted pair lists on its own first RPC unless it plants a lister
  const lister = (kind: ReadKind = "trade"): SolanaRpc | undefined => over.lister ?? (over.rpcs === undefined ? pageSolanaLister(kind) : undefined);
  // a trade's hold on the hosts its reads go to, from its host's making to its run's end (the host's end): every pass
  // read on those hosts waits for it
  const holdTrade = (): (() => void) => holdHosts([...rpcs(), ...settleRpcs(), lister()].flatMap((r) => seatHosts(r)));
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
    // and the notes a withdraw run (any tab's) has planned, until it ends
    for (const id of await keptOutNotes(ops, BigInt(Date.now()))) out.add(id);
    return out;
  };
  // the proof queue: opened at the first landing, closed at sign out
  let open: Promise<OpenQueue> | null = null;
  const openQueue = async (): Promise<OpenQueue> => {
    const notes = await openNoteStore(await page.store());
    let seed64: Uint8Array | null = null;
    try {
      seed64 = await page.seed64();
      // the pass's reads on their hosts' budget; the time a buy's take reads is the trade's own, so a buy never waits on itself
      const passPool = solanaPool({ pin: pin!, rpcs: rpcs("pass"), relayFee: (e, s) => poolRelayFee(solanaPoolOf(pin!.program).pool, e, s, over.fetch) });
      const pool = over.pool ?? { ...passPool, now: (signal?: AbortSignal) => solanaNow(rpcs(), signal) };
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
  // each chain's last "pool pass:" line, printed again only when it changes (card buy-spends-several-pieces)
  const passLines = new Map<string, string>();
  const logPass = (chain: string, pass: QueuePass | undefined, thrown?: unknown): void => {
    const line = passLine(chain, pass, thrown) ?? "";
    if (line === (passLines.get(chain) ?? "")) return;
    passLines.set(chain, line);
    if (line !== "") console.log(line);
  };
  // a release read landed on both RPCs (a Solana or EVM buy's, a withdraw's): what it took out of the pool goes on the
  // note's mark in the store (../../wallet/src/notes/store.ts ReservedMark), so every tab and a reload count only the
  // note's change until the settle writes it (../../wallet/src/pool/balances.ts landed); then the app reads the state
  // again (an owed/ write tells no store listener)
  const markLanded = async (noteId: string, attempt: string, withdrawn: bigint, block?: bigint): Promise<void> => {
    const ns = await openNoteStore(await page.store());
    try {
      await ns.landed(noteId, attempt, withdrawn, block);
    } finally {
      ns.close();
    }
    for (const f of watchers) f();
  };
  const proofs = async (): Promise<QueuePass | null> => {
    const p = (open ??= openQueue());
    try {
      const pass = await (await p).queue.refresh();
      logPass("solana", pass);
      if (pass.made.length > 0 || pass.remade.length > 0) for (const f of watchers) f();
      return pass;
    } catch (e) {
      logPass("solana", undefined, e);
      // a queue that could not open (no seed: signed out) is dropped, so the next landing opens it again
      if (open === p) await p.then(() => {}, () => void (open = null));
      return null;
    }
  };
  // the deposit ends' reads after a run (pool-deposit-sent-end): stopped when the page leaves the deposit (sign out)
  let follows = new AbortController();
  // A sign out's stops, this tab's (signingOut, at its tap) and another tab's (signedOut alone, as main.ts hears it) alike
  // (card sign-out-stops-the-pages-reads: another tab's sign out left the EVM reads bound to evmStop and signOuts running):
  // the buy records' rebuild, the late buys, the turn pass, every read waiting for its turn on a host (card
  // signpage-passes-yield-to-a-trade), every Solana settle, and every EVM read on evmStop or the sign-out count. The
  // page's gate (nothing more sent past the page's origin) is main.ts's: it closes it once the store's sign out holds the
  // seed lock, or at another tab's, and the page then reloads
  function stopReads(): void {
    buyRecords.stop();
    lateBuys.clear();
    stopTurn();
    stopHostLaneWaits();
    signOuts++;
    stopSolana();
    evmStop.abort();
    evmStop = new AbortController();
  }
  const signedOut = async (): Promise<void> => {
    stopReads();
    clears++;
    positions.clear();
    for (const c of evmPositionsCaches.values()) c?.clear();
    evmHolds.clear();
    evmWarms.clear();
    evmWarmed.clear();
    evmWarmFails.clear();
    evmFeeHolds.clear();
    evmShownGen.clear();
    evmRearmed.clear();
    // the decimals this account's buys read: never the next account's
    boughtDecimals.clear();
    awaited.clear();
    follows.abort();
    follows = new AbortController();
    // the fill's reads of this account's trades end with it: none in flight answered, none sent after (fillTrades)
    fillStop.abort();
    fillStop = new AbortController();
    fillAgain = false;
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

  // a deposit's own run reads as a trade, and so does the state reads' settle of the INCOMING notes (settleSolana): it
  // holds POOL_DEPOSIT_LOCK, which a deposit tapped meanwhile waits for (a reader that holds what a trade can wait for
  // never reads as a pass, ../../wallet/src/throttle.ts HostLane)
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
  // `passList` and `passRpcs`: the same list as a background pass reads it (the proof queue's pool), which waits on its
  // hosts while a trade holds them (card signpage-passes-yield-to-a-trade); a test's planted list is both. `passSync`: the
  // pool's sync on that pass pair, the background's (the RESERVED and unfinal settle's rounds), each read on its host's
  // budget (card evm-deposit-on-mainnet: on the trade pair, a fresh landing's settle took 18 of every 30 requests per
  // 10 s on each host and the proof queue's first pass waited 75 s for room); `sync` itself when the lists are one
  const evmPools = new Map<"base" | "robinhood", { pin: EvmPoolPin; list: readonly EvmRpc[]; rpcs: readonly [EvmRpc, EvmRpc]; passList: readonly EvmRpc[]; passRpcs: readonly [EvmRpc, EvmRpc]; sync: Pick<EvmTreeSync, "events">; passSync: Pick<EvmTreeSync, "events">; round: () => Promise<EvmDepositRound>; scope: bigint } | null>();
  const evmPool = (chain: "base" | "robinhood") => {
    if (!evmPools.has(chain)) {
      const p = evmPin(chain);
      const r = p === undefined ? null : evmRpcs(chain);
      // one pair for the deposit's reads and its sync's (review of evm-pool-lists-mainnet, P3-1)
      const pair = r === null || r.length < 2 ? null : evmPair(r);
      const sync = p === undefined || r === null || pair === null ? null : evmSyncOf(p, pair, r);
      const passList = over.evmRpcs || r === null ? r : (pageEvmPoolRpcs(chain, "pass") ?? r);
      const passRpcs = passList === null || passList === r ? pair : evmPair(passList);
      evmPools.set(chain, p === undefined || r === null || pair === null || sync === null || passList === null || passRpcs === null ? null : { pin: p, list: r, rpcs: pair, passList, passRpcs, sync, passSync: passList === r ? sync : evmSyncOf(p, passRpcs, passList), round: over.evmRound ? over.evmRound(p, pair, r) : ((one) => async (signal?: AbortSignal) => {
              // the round ends at its own signal or at a sign out, whichever fires first (review of 584af1495, P3-1: the
              // end follow's signal fires only at signedOut, so a round on it read on after the tap); both listeners go
              // when the round ends
              const session = evmStop.signal;
              const { stop, off } = eitherStop(signal, session);
              try {
                await evmWarmWait(chain, stop);
                stop.throwIfAborted();
                const got = await one(stop);
                // the deposit's own sync has read the pool (its hold kept): every later round of this session reads on
                // from it, so none waits for the history read again (review of 584af1495, P2-1); a round of a session
                // signed out meanwhile marks nothing
                if (!session.aborted) evmWarmed.add(chain);
                return got;
              } finally {
                off();
              }
            })(roundOf(sync)), scope: evmPoolScopeOf(p.pool, EVM_CHAIN_IDS[p.network]) });
    }
    return evmPools.get(chain)!;
  };
  // each EVM pool's proof queue (card signpage-evm-proof-queue), as the Solana pool's above: opened at its first landing
  // or at a state read that finds its notes landed, on the page's one prover, the page's note store and a copy of the
  // seed; the pool is the wallet's evmPool over the chain's pool list (its seats the deposit's pair), the page's hold
  // and sources, the kit's fee pair, the helper's GET /v1/pool/fee and the kit's epoch fee rule. Closed at sign out.
  const evmQueues = new Map<"base" | "robinhood", Promise<OpenQueue>>();
  // card evm-first-proof-inside-ten-seconds: each chain's one period fee hold, for every wallet pool the page makes of its
  // pin (the queue's pass pool, the landing pass's pool on the deposit's pair, a withdraw's): a bind on any of them
  // binds on the fee the turn's pass held, never on the period's first block read again past what a keyless operator
  // keeps (a landing or a withdraw 30 s into a period waited out its bind's lag retries)
  const evmFeeHolds = new Map<string, EvmFeeHold>();
  const evmFeeHoldOf = (pin: EvmPoolPin): EvmFeeHold => {
    const k = `${pin.network}:${pin.pool.toLowerCase()}`;
    let h = evmFeeHolds.get(k);
    if (h === undefined) evmFeeHolds.set(k, (h = evmFeeHold(pin)));
    return h;
  };
  const openEvmQueue = async (chain: "base" | "robinhood"): Promise<OpenQueue> => {
    const e = evmPool(chain);
    if (e === null) throw new Error(`no ${chain} pool on this page's network`);
    const notes = await openNoteStore(await page.store());
    let seed64: Uint8Array | null = null;
    try {
      seed64 = await page.seed64();
      // the pass's reads on their hosts' budget; the time a buy's take reads is the trade's own, so a buy never waits on itself
      const passPool =
        over.evmQueuePool?.(chain) ??
        walletEvmPool({
          pin: e.pin,
          rpcs: e.passRpcs,
          feeRpcs: pageEvmFeeRpcs(chain, "pass"),
          feeHold: evmFeeHoldOf(e.pin),
          held: pageEvmHold(e.pin, () => (page.held ? page.held() : page.store())),
          history: [...e.passList, ...pageEvmHistory(e.pin)],
          // card evm-deposit-on-mainnet: the trees and depths on the pool's pass sync, the settle's, so the two keep one
          // history and the queue's first pass reads only past the rounds the settle made (a test's planted sync of
          // `events` alone leaves the pool its own)
          ...(typeof (e.passSync as Partial<EvmTreeSync>).trees === "function" ? { sync: e.passSync as EvmTreeSync } : {}),
          relayFee: (ep, s) => evmPoolRelayFee(e.pin.pool, ep, s, over.fetch),
          epochFee: evmEpochFee,
        });
      // card evm-first-proof-inside-ten-seconds: the one pass a landing of the device's own deposit starts reads as that
      // deposit's last step, the trade's (its pool on the deposit's pair and its sync, the round that read the landing),
      // so it never waits for a window the landing's own reads filled (a Base mainnet copy of 13 Nov 05:38Z: 152 requests
      // per host in the 10 s before it, its first read waited 9.1 s). That pass is the one whose signal `landing` made;
      // every other pass, the settle's rounds and the restore's read on the pass pool, on their hosts' budget
      const planted = over.evmQueuePools?.(chain);
      const passBase = planted?.pass ?? passPool;
      const tradePool: Pool<unknown> | null =
        planted?.trade ??
        (over.evmQueuePool
          ? null
          : walletEvmPool({
              pin: e.pin,
              rpcs: e.rpcs,
              feeRpcs: pageEvmFeeRpcs(chain),
              feeHold: evmFeeHoldOf(e.pin),
              held: pageEvmHold(e.pin, () => (page.held ? page.held() : page.store())),
              history: [...e.list, ...pageEvmHistory(e.pin)],
              ...(typeof (e.sync as Partial<EvmTreeSync>).trees === "function" ? { sync: e.sync as EvmTreeSync } : {}),
              relayFee: (ep, s) => evmPoolRelayFee(e.pin.pool, ep, s, over.fetch),
              epochFee: evmEpochFee,
            }));
      const landings = new WeakSet<AbortSignal>();
      const on = (s?: AbortSignal): boolean => s !== undefined && tradePool !== null && landings.has(s);
      const passNow = planted !== undefined || over.evmQueuePool ? (s?: AbortSignal) => passBase.now(s) : (s?: AbortSignal) => evmRetryLag(() => evmNow(e.rpcs, s), undefined, s);
      const pool: Pool<unknown> =
        tradePool === null
          ? over.evmQueuePool ? passPool : { ...passPool, now: passNow }
          : {
              ...passBase,
              now: (s?: AbortSignal) => (on(s) ? tradePool.now(s) : passNow(s)),
              trees: (b, s, o) => (on(s) ? tradePool : passBase).trees(b, s, o),
              bind: (x, s) => (on(s) ? tradePool : passBase).bind(x, s),
            };
      const landing = (): AbortSignal => {
        const c = new AbortController();
        landings.add(c.signal);
        return c.signal;
      };
      const hardwareConcurrency = over.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency;
      // the period's fee held at the turn (the wallet's evmPool holdFee), at the pool's own time's period
      const holdFee = (passPool as Partial<Pick<EvmPoolOf, "holdFee">>).holdFee;
      // `seen` gets the pool's time it read, the newest block's, before the fee is read, so the turn's timer takes its
      // offset and its period from it whether or not the fee read succeeds (delta review of 3e13d4e2, P3-2)
      const hold = typeof holdFee === "function" ? async (s?: AbortSignal, seen?: (now: bigint) => void): Promise<void> => {
        const now = await passPool.now(s);
        seen?.(now);
        await holdFee.call(passPool, now - (now % passPool.epochMs), s);
      } : undefined;
      return { queue: openProofQueue({ seed64, notes, pool, provers: [prover.vault], hardwareConcurrency, skip: owedNotes }), notes, poolId: pool.id, ...(hold ? { hold } : {}), ...(tradePool !== null ? { landing } : {}) };
    } catch (err) {
      notes.close();
      throw err;
    } finally {
      seed64?.fill(0); // the queue keeps its own copy
    }
  };
  /** The EVM chain's queue pass, the queue opened first when none is; null with no pool or no queue. `landing`: the one
   *  pass the device's own landed deposit starts (evmKind's landed), read as that deposit's (openEvmQueue). */
  const evmProofs = async (chain: "base" | "robinhood", landing = false): Promise<QueuePass | null> => {
    if (evmPool(chain) === null) return null;
    let p = evmQueues.get(chain);
    if (p === undefined) evmQueues.set(chain, (p = openEvmQueue(chain)));
    try {
      const q = await p;
      const pass = await q.queue.refresh(landing ? q.landing?.() : undefined);
      logPass(chain, pass);
      if (pass.made.length > 0 || pass.remade.length > 0) for (const f of watchers) f();
      return pass;
    } catch (e) {
      logPass(chain, undefined, e);
      // a queue that could not open (no seed: signed out) is dropped, so the next landing opens it again
      const q = p;
      if (evmQueues.get(chain) === q) await q.then(() => {}, () => void (evmQueues.get(chain) === q && evmQueues.delete(chain)));
      return null;
    }
  };
  // card evm-first-proof-inside-ten-seconds: the pool's history read once a deposit is in sight (a quote's floor, its
  // follow, a restore: each asks evmPoolOf), on the pass sync and its hosts' budget while the money is on its way, and
  // kept in the page's hold (pageEvmHold), so the landing's own round reads only the blocks past it. On a page that
  // never synced the pool, that round read it whole from the deploy block at the landing (a Base mainnet copy of 13 Nov
  // 05:38Z: 51 log pages per host in its second). Once a page; a read that fails is asked again at the next deposit
  // each chain's read, in flight or done (true); one that fails (false) is let go, so the next ask reads again, and
  // counted (evmWarmFails: the failures since the last read that held)
  const evmWarms = new Map<"base" | "robinhood", Promise<boolean>>();
  const evmWarmed = new Set<"base" | "robinhood">();
  const evmWarmFails = new Map<"base" | "robinhood", number>();
  const evmWarm = (chain: "base" | "robinhood"): Promise<boolean> | null => {
    const e = evmPool(chain);
    if (e === null) return null;
    let w = evmWarms.get(chain);
    if (w === undefined) {
      const session = evmStop.signal;
      const read: Promise<boolean> = e.passSync.events(session).then(
        // an answer after a sign out (its reads stopped, these maps cleared) is not this session's: neither counted nor
        // kept, and a failure whose stop fired is no failure of the read (review of 584af1495, P3-1)
        () => (!session.aborted && evmWarms.get(chain) === read && (evmWarmFails.delete(chain), evmWarmed.add(chain)), true),
        () => (!session.aborted && evmWarms.get(chain) === read && (evmWarms.delete(chain), evmWarmFails.set(chain, (evmWarmFails.get(chain) ?? 0) + 1)), false),
      );
      evmWarms.set(chain, (w = read));
    }
    return w;
  };
  // the deposit's round waits for that read (its hold then read by the round's own sync, at its first round), at most
  // EVM_WARM_WAIT_MS from the round's start; a read that fails is asked again once. After a second failure in a row
  // (any ask's), or the bound, the round reads as it did before (the pool from its deploy block on the deposit's own
  // pair), so a deposit never waits on it longer. None when the deposit's sync is the pass sync (one list): its rounds
  // already queue behind it. The wait ends at `stop` (the round's signal, else the page's reads' stop as it was at the
  // call), and once it has fired no read is asked again: a sign out tapped meanwhile ends the round (its reason thrown,
  // never a pool read after the tap)
  const evmWarmWaitMs = over.evmWarmWaitMs ?? EVM_WARM_WAIT_MS;
  const evmWarmWait = async (chain: "base" | "robinhood", stop: AbortSignal): Promise<void> => {
    const e = evmPool(chain);
    if (e === null || e.passSync === e.sync || evmWarmed.has(chain)) return;
    const by = Date.now() + evmWarmWaitMs;
    for (let k = 0; k < 3 && !stop.aborted; k++) {
      const w = evmWarms.get(chain) ?? ((evmWarmFails.get(chain) ?? 0) < 2 ? evmWarm(chain) : null);
      const left = by - Date.now();
      if (w === null || left <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let off = (): void => {};
      const ended = new Promise<"ended">((r) => {
        timer = setTimeout(() => r("ended"), left);
        const f = (): void => r("ended");
        stop.addEventListener("abort", f, { once: true });
        off = () => stop.removeEventListener("abort", f);
      });
      const got = await Promise.race([w, ended]).finally(() => (clearTimeout(timer), off()));
      if (got !== false) return;
    }
  };
  // the chains whose landing pass is asked in this tick (evmKind's landed)
  const evmLandingAsked = new Set<"base" | "robinhood">();
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
        // each landed note runs the chain's queue pass, as the Solana deposit's does: the notes one round claims (one
        // tick) start one pass, the deposit's own (evmProofs' landing). Only this host's landed starts one: the deposit
        // kind calls it once the round on the pool's two RPCs holds the note's Deposited (pool-deposit-evm.ts)
        landed: () => {
          if (evmLandingAsked.has(chain)) return;
          evmLandingAsked.add(chain);
          queueMicrotask(() => {
            evmLandingAsked.delete(chain);
            void evmProofs(chain, true);
          });
        },
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
  // the kit-call deposit: open only where this build carries the chain's withdraw (poolWayOut, as the deposit-address
  // path in main.ts), both builds since card evm-deposit-on-mainnet. No exit tool reads these pools yet: money leaves
  // them through this page's withdraw, the helper relaying its release (card exit-evm-pool adds the way out with no
  // server of ours). The RESERVED settle above is a deposit's own end and stays on every pinned network
  const evmDeposit = (chain: "base" | "robinhood") => (wayOut(chain) ? evmKind(chain) : null);
  // pool.buy on an EVM chain (card signpage-evm-pool-buy, src/pool-buy-evm.ts): the chain's queue, the kit's quote and
  // build, the helper's send, the deposit's pair for the read-back, and the chain's RESERVED settle; on each build whose
  // network pins the chain's pool (card evm-pools-on-mainnet: SIGN_HOST's too). The buy names no W to a pool RPC
  // (src/pool-buy-evm.ts, who learns what)
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
    // and the chain's positions read again: every end of a buy, its run's and the load's follow's (followPendingEvmBuys)
    settle: () => {
      void reserveEvm(chain).catch(() => {});
      evmPositions(chain)?.refresh();
    },
    testnet: POOL_TESTNET,
    signal: follows.signal,
    stopped: ((at) => () => signOuts !== at)(signOuts),
    // as the Solana buy's: the balance counts the note's change from its release's read-back (card
    // pool-buy-record-never-stays-sent)
    landed: (noteId, attempt, withdrawn, block) => void markLanded(noteId, attempt, withdrawn, block).catch(() => {}),
    marks: async () => readReservedMarks(await page.store()),
  });
  const evmBuy = (chain: "base" | "robinhood") => {
    // first, alone: the testnet build only, folded at build time, so SIGN_HOST's bundle carries none of the buy. On
    // mainnet a swap that misses its floor leaves the chunk on W with no way back yet, so the buy stays closed there
    if (!POOL_TESTNET) return null;
    // and only where the build carries the chain's withdraw (poolWayOut)
    if (!wayOut(chain)) return null;
    const e = evmPool(chain);
    if (e === null) return null;
    // the buy holds the list's hosts from its run's start to its end: the passes' reads wait, the buy's own go first
    return (over.tradeKinds?.evmBuy ?? poolBuyEvmKind)(() => {
      const release = holdHosts(e.list.map((r) => r.url));
      return { ...evmBuyHost(chain, e.pin, e.rpcs, evmBuyClaims, evmBuyPage(chain)), end: release };
    });
  };
  // an EVM buy's or sell's run: the chain's positions read again at its end stage (both kinds post it as progress, the
  // late one too), as Solana's are (recordedBuy, recordedSell); a sale's token is held by its open sale (evmHolds) from
  // its record on. A sale refused not_funded: read again, since the row it sold from may be one a spent round left
  const evmEnds = (chain: "base" | "robinhood", ctx: KindContext): KindContext => ({
    ...ctx,
    progress: (stage) => {
      ctx.progress(stage);
      if (EVM_TRADE_ENDS.has(stage)) evmPositions(chain)?.refresh();
    },
  });
  const evmRun = <R,>(chain: "base" | "robinhood", ask: PoolAsk, ctx: KindContext, kind: ((a: PoolAsk, c: KindContext) => R) | undefined): R | { error: "not_allowed" } => {
    if (kind === undefined) return { error: "not_allowed" };
    const run = kind(ask, evmEnds(chain, ctx)) as R;
    const r = run as { after?: Promise<void>; answer?: () => unknown } & { error?: string };
    const refused = (a: unknown): boolean => typeof a === "object" && a !== null && (a as { error?: unknown }).error === "not_funded";
    if (ask.kind === "pool.sell") {
      if (refused(r)) evmPositions(chain)?.refresh();
      else if (r.after) void r.after.then(() => (refused(r.answer?.()) ? evmPositions(chain)?.refresh() : undefined));
    }
    return run;
  };
  const EVM_TRADE_ENDS: ReadonlySet<string> = new Set(["filled", "part_filled", "not_landed"]);
  // each chain's open sales for its positions (src/positions-evm.ts evmSaleHolds): from a sale's record on, its token
  // shows no amount agreed under the sale's floor (its Deposited's block, the one both RPCs' verdict named)
  const evmHolds = new Map<"base" | "robinhood", EvmSaleHolds>();
  const evmHoldsOf = (chain: "base" | "robinhood"): EvmSaleHolds => {
    let h = evmHolds.get(chain);
    if (h === undefined) evmHolds.set(chain, (h = evmSaleHolds(chain)));
    return h;
  };
  const saleNow = (): number => (over.positionsNow ?? Date.now)();
  // the holds' change each chain's shown rows were read after (EvmSaleHolds.gen): a sale newer than it hides its token
  const evmShownGen = new Map<"base" | "robinhood", number>();
  // a buy whose tab ended before its end (the pending record's own follow died with it): followed from its record at
  // each state read, until filled, withdrawn or not_landed (src/pool-buy-evm.ts followPendingEvmBuys); as the buy is
  const evmBuyFollow = (chain: "base" | "robinhood"): void => {
    // the testnet build only, as the buy (folded at build time)
    if (!POOL_TESTNET) return;
    // and only where the build carries the chain's withdraw (poolWayOut)
    if (!wayOut(chain)) return;
    const e = evmPool(chain);
    if (e === null) return;
    void followPendingEvmBuys(evmBuyHost(chain, e.pin, e.rpcs, evmBuyClaims, evmBuyPage(chain))).catch(() => {});
  };
  // pool.sell on an EVM chain (card signpage-evm-pool-sell, src/pool-sell-evm.ts): the Ws the chain's spent notes pay,
  // their buy records, the kit's sell quote and build, the helper's sell sender, the pool's pair and round; testnet build
  // only until the mainnet pins' card. One note store per run, closed at its end
  const evmSellFollowing = new Set<string>();
  const evmSellSending = new Set<string>();
  const evmSellOf = (chain: "base" | "robinhood", e: NonNullable<ReturnType<typeof evmPool>>) => {
    let notes: Promise<NoteStore> | null = null;
    // the store is closed once the tap has ended and every part it handed on (a send past the tap's bound, a
    // read-back) has ended too (review P2-1: a sale that lands after the tap still writes its note)
    let ended = false;
    let kept = 0;
    const close = (): void => {
      if (ended && kept === 0) void notes?.then((n) => n.close(), () => {});
    };
    const host = evmSellHost(chain, e.pin, e.scope, e.rpcs, {
      following: evmSellFollowing,
      sending: evmSellSending,
      keep: (p) => {
        kept++;
        void p.finally(() => {
          kept--;
          close();
        });
      },
      notes: () => (notes ??= page.store().then(openNoteStore)),
      seed64: page.seed64,
      held: () => (page.held ? page.held() : Promise.reject(new Error("no wallet store is open"))),
      round: () => e.sync.events(),
      testnet: POOL_TESTNET,
      fetch: over.fetch,
      signal: follows.signal,
      // the session's sign out (signingOut, at its tap): it ends a wait between the sale's reads' attempts
      stop: evmStop.signal,
      stopped: ((at) => () => signOuts !== at)(signOuts),
    });
    // a sale's record written: its token held (evmHolds), the chain read again
    const record: typeof host.record = async (o) => {
      await host.record(o);
      if (evmHoldsOf(chain).record(o)) {
        evmPositions(chain)?.refresh();
        for (const f of watchers) f();
      }
    };
    // a send's end, the helper's hash or no answer (a busy one is waited out and sent again): a pass started after it
    // takes the sale's floor past the lower newest block, until the sale's Deposited names its own
    const send: typeof host.send = async (body) => {
      try {
        const hash = await host.send(body);
        evmHoldsOf(chain).sendEnded(body.w, saleNow());
        return hash;
      } catch (e) {
        if (!(e instanceof EvmSendBusy)) evmHoldsOf(chain).sendEnded(body.w, saleNow());
        throw e;
      }
    };
    // the sale's Deposited, the same on both RPCs: its block the floor
    const deposited: NonNullable<typeof host.deposited> = (o, block) => {
      evmHoldsOf(chain).deposited(o, block, saleNow());
      evmPositions(chain)?.refresh();
    };
    // an open sale dropped at its end (the run's or the load's follow's, followEvmSells): one with no Deposited read
    // holds nothing more, and the chain's positions are read again
    const unrecord: typeof host.unrecord = async (note, deadline) => {
      await host.unrecord(note, deadline);
      if ((await host.open().catch(() => null))?.[note] === undefined) evmHoldsOf(chain).dropped(note);
      evmPositions(chain)?.refresh();
    };
    return {
      ...host,
      record,
      send,
      deposited,
      unrecord,
      end: () => {
        ended = true;
        close();
      },
    };
  };
  const evmSell = (chain: "base" | "robinhood") => {
    // first, alone: the testnet build only, folded at build time, so SIGN_HOST's bundle carries none of the sale (on
    // mainnet nothing can be bought, and a restored device holds no buy record to sell from). The sale's finding reads,
    // on the pool's two RPCs at one agreed block, only the Ws whose own buy record names the token sold (planEvmSell)
    if (!POOL_TESTNET) return null;
    // and only where the build carries the chain's withdraw (poolWayOut)
    if (!wayOut(chain)) return null;
    const e = evmPool(chain);
    if (e === null) return null;
    return (over.tradeKinds?.evmSell ?? poolSellEvmKind)(() => evmSellOf(chain, e));
  };
  // a sale whose tab ended before its end: followed from its open record at each state read (followEvmSells)
  const evmSellFollow = (chain: "base" | "robinhood"): void => {
    // the testnet build only, as the sale (folded at build time)
    if (!POOL_TESTNET) return;
    // and only where the build carries the chain's withdraw (poolWayOut)
    if (!wayOut(chain)) return;
    const e = evmPool(chain);
    if (e === null) return;
    const h = evmSellOf(chain, e);
    void followEvmSells(h).catch(() => {}).finally(h.end);
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
    // only where the build carries the chain's withdraw (poolWayOut), as the deposit itself (review P3-1)
    const kind = wayOut(chain) ? evmKind(chain, done) : null;
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
  // an EVM pool's RESERVED and unfinal notes settled (../../wallet/src/pool/evm-settle.ts evmSettleReserved: spent with
  // its change once the newest block both RPCs agree on shows the release, freed once that block's time is past the
  // deadline with none, backed out when a reorg drops a leaf, else held), on the chain's sync, under the seed's shared lock as the Solana pass; a freed note or a change written is
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
        // the wallet's own rule for when a pass reads (a RESERVED note, a note in the store's tail, or one a reorg backed
        // out): nothing open, no seed read and no round (card evm-money-shows-and-spends-at-once)
        if (!evmSettleOpen(await notes.list(), await notes.landings(), e.scope)) return;
        seed64 = await page.seed64();
        // a pass: its rounds on the pool's pass sync, every read on its host's budget, a trade's first. No trade waits on
        // it: reserveEvm's callers never await it but a state read's, and the seed lock it holds is shared
        const pass = await evmSettleReserved({ seed64, notes, scope: e.scope, round: (s) => e.passSync.events(s), signal });
        // a freed note's release never landed: a withdraw op owing its send is settled stopped, nothing sent
        if (pass.freed.length > 0) await settleFreedOps(await page.store(), pass.freed);
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
  // a time per chain) while the queue is open or the chain's notes are landed, and its settle (RESERVED and unfinal notes)
  const evmPassing = new Map<"base" | "robinhood", Promise<unknown>>();
  // a read that finds the chain's pass running asks for one more after it (one, never a queue): that pass began before
  // what woke the read (a withdraw's kept-out record, any tab's) and read the queue's skip before it, so only a pass
  // after it lets those notes go (queue.ts skip)
  const evmPassAgain = new Set<"base" | "robinhood">();
  const evmPass = (chain: "base" | "robinhood", stop: AbortSignal): void => {
    if (evmPassing.has(chain)) return void evmPassAgain.add(chain);
    evmPassing.set(
      chain,
      evmProofs(chain).finally(() => {
        evmPassing.delete(chain);
        if (evmPassAgain.delete(chain) && !stop.aborted) evmPass(chain, stop);
      }),
    );
  };
  const evmRead = async (): Promise<void> => {
    const stop = evmStop.signal;
    await settleEvmOpen().catch(() => {});
    const chains = (["base", "robinhood"] as const).filter((c) => evmPool(c) !== null);
    if (chains.length === 0) return;
    // each chain's buys whose tab ended before their end, from their pending records (never awaited)
    for (const chain of chains) evmBuyFollow(chain);
    // and each chain's sales whose tab ended before their end, from their open records (never awaited)
    for (const chain of chains) evmSellFollow(chain);
    const all = await readNotes(await page.store());
    await Promise.all(
      chains.map(async (chain) => {
        const mine = all.filter((n) => n.scope === evmPool(chain)!.scope);
        // a sign out since the read began: no pass, and the settle stops on its signal
        if (!stop.aborted && (evmQueues.has(chain) || mine.some((n) => n.state === "UNSPENT" || n.state === "HELD"))) evmPass(chain, stop);
        // the settle on every chain holding a note of the scope: it reads a round only while the wallet's rule finds one
        // open (evmSettleOpen), so a reorg that drops a fresh deposit or a release after its change was written is
        // healed with nothing RESERVED (card evm-money-shows-and-spends-at-once, review G)
        if (mine.length > 0) await reserveEvm(chain, stop).catch(() => {});
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
        if (!evmPassing.has(chain)) evmPass(chain, signal);
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
  const buyHost = (): PoolBuyHost & { release(): void; end(): void; follow(post: (stage: "filled" | "not_landed") => void): void } => {
    let notes: NoteStore | null = null;
    // the buy holds its hosts from its run's start to its early "sent" (pool-buy.ts poolBuyKind: release), else its
    // end: the passes' reads wait, the buy's own go first; given back once (holdHosts), whichever comes first. From its
    // land on (pool-buy.ts landed) its reads to Final (the read-backs, the settle and its lister) are a background
    // pass's, on the host's budget and its floor (card sell-right-after-a-buy: run 11's 20 throttles at a sell tapped
    // 1 s after Filled were these reads as a trade's), so a trade tapped then reads first (buyReads)
    const reads = buyReads({ trade: rpcs("trade"), pass: rpcs("pass") }, holdTrade());
    const release = reads.release;
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
    // the proof this run's take handed out: what a follow of its note reads (pool-buy.ts poolBuyKind follow)
    let taken: ReadyProof<SolanaReleaseRequest> | null = null;
    return {
      pin: pin!,
      tables,
      cluster: PAGE_CLUSTER,
      rpcs: reads.rpcs,
      claimed,
      // a sign out ends the buy's waits before its signature (read-waits.ts waitUnless): this session's stop
      signal: solanaStop.signal,
      // none ready (a page that has landed no deposit since it loaded has run no pass): a pass starts for the next tap
      ready: async (early) => {
        const queue = await q();
        const list = early === undefined ? queue.ready() : await queue.readyAt(early);
        if (list.length === 0) void proofs();
        return list;
      },
      take: async (id, attempt, early, lastHeight) => (taken = await (await q()).take(id, attempt, early, lastHeight)),
      chainNow: () => chainNow(over.pool ?? { now: (signal) => solanaNow(rpcs(), signal) }),
      // a buy's pieces, all RESERVED or none (card buy-spends-several-pieces); the run's buy is the last, its tag 3
      takeSet: async (items, early, lastHeight) => {
        const got = await (await q()).takeSet(items, early, lastHeight);
        taken = got[got.length - 1] ?? null;
        return got;
      },
      // the run ended "sent": its note is followed by the state reads' pass until its end is known (followBuys)
      follow: (post) => {
        if (taken === null) return;
        lateBuys.set(taken.noteId, { r: taken, post, places: new Map() });
        void settleReserved().catch(() => {});
      },
      seed64: page.seed64,
      // W's buy mint, written before the send: the rent back after a later sell holds while W holds any of it
      bought: buyMints(page.store),
      send: (pool, tx) => helperPoolSend(pool, tx, over.fetch),
      sendPieces: (pool, txs) => helperPoolSendPieces(pool, txs, over.fetch),
      // a buy of several pieces' owed record, before its take (resumePieces, on the state reads)
      piecesOwed: piecesOwedOf(page.store),
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
          const kind = reads.kind();
          return await solanaSettleSpent({ seed64, notes, noteId, program: pin!.program, minSlots, rpcs: settleRpcs(kind), lister: lister(kind), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES });
        } finally {
          seed64.fill(0);
        }
      },
      // a buy of several pieces: every piece's note on one read of the marks a round
      settleSet: async (noteIds, minSlots) => {
        const signal = solanaStop.signal;
        const seed64 = await page.seed64();
        try {
          notes ??= await openNoteStore(await page.store());
          const kind = reads.kind();
          return await solanaSettleSpentSet({ seed64, notes, noteIds, program: pin!.program, minSlots, rpcs: settleRpcs(kind), lister: lister(kind), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES });
        } finally {
          seed64.fill(0);
        }
      },
      release,
      // the release read landed on both RPCs: the balance counts only the note's change until the settle writes it
      // (../../wallet/src/pool/balances.ts landed), and the app reads the state again
      landed: (noteId, attempt, withdrawn) => {
        reads.landed();
        void markLanded(noteId, attempt, withdrawn).catch(() => {});
      },
      end: () => {
        release();
        notes?.close();
        // the run's note settled now, not on the next state read: a buy that ended not landed has read its blockhash past
        // on both RPCs, so the pass frees its note at once (card pool-buy-record-never-stays-sent)
        void settleReserved().catch(() => {});
      },
    };
  };
  // each buy's W and the decimals of the token it received, told by the run (pool-buy.ts outDecimals) until its records
  // are written; a W takes one buy only
  const boughtDecimals = new Map<string, number>();
  // each buy whose run ended "sent" (its end not known), by note id: its taken proof, where to post its end, and W's
  // history places read so far (card pool-buy-record-never-stays-sent)
  const lateBuys = new Map<string, { r: ReadyProof<SolanaReleaseRequest>; post: (stage: "filled" | "not_landed") => void; places: HistoryPlaces }>();
  // each followed buy's end, from its note as the pass left it: still RESERVED by its attempt, not known yet; out of it
  // and not SPENT, freed (both RPCs read its transaction past its last height, or its deadline, with no spent mark: it
  // can never land), not_landed; SPENT, filled only once both RPCs read the spend as this attempt's (pool-spend.ts
  // spendOwner, as the run's own spentBy), another's not_landed, a read that fails not known yet
  const followBuys = async (notes: NoteStore): Promise<void> => {
    for (const [id, b] of lateBuys) {
      const end = await lateBuyEnd(await notes.get(id).catch(() => undefined), b.r.attempt, async () => {
        const rs = settleRpcs("pass");
        const slots = await Promise.all(rs.map((rpc) => rpc("getSlot", [{ commitment: "finalized" }])));
        if (!slots.every((x) => Number.isSafeInteger(x))) return null;
        return spendOwner(rs, { program: b.r.binding.request.program, feePayer: b.r.binding.request.feePayer }, b.r.wallet.address, BigInt(b.r.publicSignals[1]), b.r.binding.context.toString(), Math.max(...(slots as number[])), undefined, b.places);
      });
      if (end === null) continue;
      lateBuys.delete(id);
      b.post(end);
    }
  };
  const buy = (over.tradeKinds?.buy ?? poolBuyKind)(() => buyHost());
  let settling: Promise<void> | null = null;
  // a signed-in load also gets back the buy records a restore left owed, in the background (src/sol-buy-records.ts)
  const settle = (): Promise<void> => (buyRecords.run(), fillTrades(), Promise.all([settleSolana(), settleEvmOpen().catch(() => {})]).then(() => {}));
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
  // a sell's list: every W derived, the finder reading only those `read` asks for (buy-wallets.ts wantedBuyWallets)
  const poolBuyWallets = async (notes: NoteStore, r: readonly [SolanaRpc, SolanaRpc], read: (address: string) => boolean | Promise<boolean> = () => true, signal?: AbortSignal): Promise<ListedBuyWallet[]> => {
    const spent = await spentNotesOf(notes, scope!);
    if (spent.length === 0) return [];
    const seed64 = await page.seed64();
    let derived: ReturnType<typeof derivedBuyWallets>;
    try {
      derived = derivedBuyWallets(seed64, [{ id: pin!.program, chain: "sol", spent, reader: finderOf(r) }]);
    } finally {
      seed64.fill(0);
    }
    if (derived.failed.length > 0) throw new Error("the buy wallets could not be derived");
    // side by side in the finder's steps (card pool-sell-legs-side-by-side)
    const got = await wantedBuyWallets(derived, read, { together: true, ...(signal ? { signal } : {}) });
    // a read refused by its provider: its transport fault, so the sale answers "down" (its waits count it)
    if (got.failed.length > 0) throw got.fault ?? new Error("the buy wallets' holdings could not be read");
    return got.wallets;
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
      const r = rpcs("pass");
      const heldRpc = over.holdings !== undefined ? over.assetHeldRpc : pageAssetHeldRpc(run.signal);
      const st = await page.store();
      const meta = async (k: string): Promise<Record<string, unknown>> => {
        const v = await st.get("meta", k);
        return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
      };
      return await positionsPass({
        signal: run.signal,
        // the sell's own read of the Ws it read when one was fed, the finder's read of the rest with a buy record (a sell
        // reads only the Ws that can hold its token: card wallets-found-in-one-read)
        wallets: async (only, o = {}) => {
          const fed = (run.found ?? []).filter((w) => only.has(w.address));
          for (const w of fed) o.each?.(w);
          const rest = new Set([...only].filter((a) => !fed.some((w) => w.address === a)));
          return [...fed, ...(rest.size === 0 ? [] : await recordedWallets(st, r, rest, run.signal, o))];
        },
        ...(run.shown ? { shown: run.shown } : {}),
        // each W's SOL beside its token (asset_held), one batch for the pass on the finder's own route (pageAssetHeldRpc)
        ...(heldRpc === undefined ? {} : { assetHeld: (ws: readonly { address: string; mint: string }[], signal?: AbortSignal) => solanaAssetHeld(heldRpc, ws, signal) }),
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
          const rpc = POOL_TESTNET ? r[0] : over.rpcs ? r[1] : solanaPacedRpc(pageHelperRpcStopped(TRADE_HELPER, run.signal, "pass"));
          run.signal.throwIfAborted();
          return tokenDecimalsShown("solana", await rpc("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]));
        },
      }, memo);
    },
    {
      ...over.positions,
      // a sale's own read of the Ws stops the buy records' rebuild too, which runs again after it (its reads share the
      // finder's queue: review of 42a99f81, P2)
      preempted: () => buyRecords.hold(),
      kept: async () => {
        if (scope === null) return null;
        const st = await page.store();
        return keptPositions(await st.get("meta", POSITIONS_KEPT_KEY), (await st.get("meta", POSITION_COSTS_KEY)) ?? {}, (await st.get("meta", BUY_MINTS_KEY)) ?? {});
      },
    },
  );
  // state.positions on each EVM chain with a pool (src/positions-evm.ts, card signpage-positions-evm): each filled buy
  // record's W read on the pool's two RPCs (SIGN_HOST's build: on the helper's route alone, pageEvmPassReads), in the
  // cache Solana's runs in; each chain's pass staggered after Solana's (Base one step, Robinhood two), so the three never
  // fire in the same tick, on each build whose network pins the chain's pool
  const evmPositionsCaches = new Map<"base" | "robinhood", ReturnType<typeof positionsCache> | null>();
  // when a state read last asked a spent chain for a pass
  const evmRearmed = new Map<"base" | "robinhood", number>();
  // the sign outs' clears of the positions (signedOut), so a read they overtook answers null
  let clears = 0;
  const evmPositions = (chain: "base" | "robinhood"): ReturnType<typeof positionsCache> | null => {
    if (!evmPositionsCaches.has(chain)) {
      const e = evmPool(chain);
      const step = chain === "base" ? 1 : 2;
      const timer = over.positions?.setTimer ?? ((f: () => void, ms: number) => (setTimeout(f, ms) as { unref?: () => void }).unref?.());
      evmPositionsCaches.set(
        chain,
        // only on a list of exactly two providers: on more, the pair's walking seats can both land on one provider, whose
        // word alone would then read as two agreeing (a stuck or throttled seat leaves the rows waiting instead)
        e === null || e.passList.length !== 2
          ? null
          : positionsCache(
              (memo, run) =>
                staggered(EVM_POSITIONS_STAGGER_MS * step, run.signal, async () => {
                  const started = saleNow();
                  const hs = evmHoldsOf(chain);
                  const g = hs.gen();
                  const st = await page.store();
                  // a background read: the pass pair, which waits while a trade holds the hosts (page-rpc.ts)
                  const got = await evmPositionsPass({
                    chain,
                    ...pageEvmPassReads(chain, e.passRpcs),
                    signal: run.signal,
                    // the open sales: this page's, and the records a load finds
                    holds: async (heads) => {
                      const v = await st.get("meta", EVM_OPEN_SELLS_KEY);
                      return evmHoldsOf(chain).at(typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}, heads, started, saleNow());
                    },
                    holdings: async () => {
                      const v = await st.get("meta", EVM_POSITION_COSTS_KEY);
                      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
                    },
                    decimals: (token, rpcs) => keptTokenDecimals(chain, token, rpcs, { waits: 0 }),
                  }, memo);
                  if (!run.signal.aborted && evmHolds.get(chain) === hs) evmShownGen.set(chain, g);
                  return got;
                }, timer),
              { retryMs: evmPositionsRetryMs, ...over.positions, kept: undefined },
            ),
      );
      // a change of this chain's positions reads the page's state again, as Solana's does (positions.watch below)
      evmPositionsCaches.get(chain)?.watch(() => {
        for (const f of watchers) f();
      });
    }
    return evmPositionsCaches.get(chain)!;
  };
  // The Ws of `only` as the finder reads them. Derived under the seed's shared lock, the seed copy zeroed as soon as
  // they are (a sign out waits only for that derive, never for a read), then read with the pass's stop: one W's failed
  // read is that W's alone (the finder fails a whole pool on one; a sell keeps that rule). No Web Locks: no read.
  const recordedWallets = async (st: WalletStore, r: readonly [SolanaRpc, SolanaRpc], only: ReadonlySet<string>, signal: AbortSignal, o: { first?: ReadonlySet<string>; each?: (w: FoundWallet) => void } = {}): Promise<FoundWallet[]> => {
    if (!locks) throw new Error("no Web Locks: the seed is not read");
    const inner = finderOf(r);
    const unread = new Set<string>();
    const reader: HoldingsReader = {
      chain: inner.chain,
      read: async (address, s, by) => {
        try {
          // the finder takes the host's pass turn at each of its rounds (buy-wallets.ts inTurn), and its route's bound on a
          // throttle holds (HOLDINGS_THROTTLE_MAX_MS): past it every W after is refused without asking, so the pass ends
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
    const found = (w: BuyWallet): FoundWallet => ({ address: w.address, tokens: unread.has(w.address) ? null : new Map([...w.holdings.tokens].map(([m, h]) => [m, h.amount] as const)) });
    // the open buys' Ws first, each told to the pass as it is read (card wallets-found-in-one-read)
    const got = await derived.read({ signal, only, ...(o.first ? { first: o.first } : {}), ...(o.each ? { each: (w) => o.each!(found(w)) } : {}) });
    if (got.failed.length > 0) throw new Error("the buy wallets could not be derived");
    return got.wallets.map(found);
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
        // a full sell's new record (written before its send, no pass yet): the rent backs run again at the next state
        // read, whatever the last run booked (card round-trip-costs-less)
        if (rec.passes === 0) backs.again();
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
  // W's buy records back after a restore (card restore-rebuilds-buy-records, src/sol-buy-records.ts): the Ws of the
  // pool's SPENT and RESERVED notes, each read on the finder's paced route with its own gate, each call on the host's
  // pass turn (buy-wallets.ts solanaHelperBuys), one W a request
  const buyRecords = solBuyRecords({
    // the finder's derive with a reader that reads nothing: the addresses only, the seed zeroed as soon as they are
    wallets: async (signal) => {
      if (scope === null) return [];
      if (!locks) throw new Error("no Web Locks: the seed is not read");
      const notes = await openNoteStore(await page.store());
      let spent: Awaited<ReturnType<typeof spentNotesOf>>;
      try {
        spent = await spentNotesOf(notes, scope);
      } finally {
        notes.close();
      }
      if (spent.length === 0) return [];
      const none: HoldingsReader = { chain: "sol", read: async () => ({ native: 0n, tokens: new Map(), unreadable: [] }) };
      const derived = await locks.request(WALLET_SEED_LOCK, { mode: "shared", signal }, async () => {
        const seed64 = await page.seed64();
        try {
          return derivedBuyWallets(seed64, [{ id: pin!.program, chain: "sol", spent, reader: none }]);
        } finally {
          seed64.fill(0);
        }
      });
      const got = await derived.read({ signal });
      if (got.failed.length > 0) throw new Error("the buy wallets could not be derived");
      return got.wallets.map((w) => w.address);
    },
    // a rebuilt record is read again for W's trades until its final "trades read" mark (sol-buy-records.ts, card
    // closed-positions-after-a-restore): a device restored before that card has the records and none of the trades
    done: async () => tradesDone(await page.store(), BUY_MINTS_KEY),
    from: async () => tradesFrom(await page.store()),
    // through the store only while it is open (page.held): another tab's sign out never lands a write in a store made
    // afresh (review of 42a99f81, d)
    write: async (address, buy) => {
      if (!page.held) throw new Error("no wallet store is open");
      const st = await page.held();
      if (buy === "none") {
        await st.update("meta", BUY_NONE_KEY, (v) => ({ ...asRecord(v), [address]: true }));
        return false;
      }
      let wrote = false;
      await st.update("meta", BUY_MINTS_KEY, (v) => {
        // the store may run this again on a race: each run decides afresh
        const all = asRecord(v);
        wrote = !Object.hasOwn(all, address);
        if (!wrote) return undefined;
        // marked rebuilt: one provider's word, which the rent back counts as no record (pool-sell.ts rentBackOwed)
        return { ...all, [address]: { mint: buy.mint, program: buy.program, rebuilt: true } };
      });
      return wrote;
    },
    // W's trade ops (card closed-positions-after-a-restore), through the store only while it is open, as the record's
    // write: each only where no op names its signature, then the figures from their transactions (fillTrades)
    trades: async (address, buy) => {
      if (!page.held) throw new Error("no wallet store is open");
      const wrote = await writeTradeOps((await page.held()) as unknown as TradesStore, address, buy);
      if (wrote) fillTrades();
      return wrote;
    },
    reader: {
      read: (address, signal, from) => (POOL_TESTNET ? solanaBuysAt(TESTNET_RPCS.solana[0], pin!.program) : solanaHelperBuys(TRADE_HELPER, pin!.program)).read(address, signal, from),
    },
    wrote: () => positions.refresh(),
  });
  positions.watch(() => {
    for (const f of watchers) f();
  });
  // each filled Solana trade's units and SOL from its own transaction (src/trade-fill.ts, card portfolio-shows-pool-trades):
  // after each pool trade's end and at each signed-in load, so a record from before them is filled too; one run at a
  // time, one asked meanwhile runs once more after it; a write tells the app's state watchers
  let filling: Promise<void> | null = null;
  let fillAgain = false;
  // the sign out's stop (signedOut): in the reader's every fetch and in the fill's loop over the ops
  let fillStop = new AbortController();
  const fillTrades = (): void => {
    if (pin === undefined) return;
    if (filling) return void (fillAgain = true);
    const signal = fillStop.signal;
    // one reader, the helper's route (the positions finder's): no read names a W or a signature to a public provider
    const reader = POOL_TESTNET ? rpcs("pass")[0] : over.rpcs ? over.rpcs[1] : solanaPacedRpc(pageHelperRpcStopped(TRADE_HELPER, signal, "pass"));
    // every reader asks only before the stop (the testnet build's and a test's carry none of their own)
    const one: SolanaRpc = (method, params) => (signal.throwIfAborted(), reader(method, params));
    const read = (sig: string): Promise<unknown> => one("getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    filling = (async () => {
      const store = (await page.store()) as unknown as FillStore;
      // an old sale's USD at its own block: the page's SOL/USD feed account's writes before it (trade-fill.ts blockPrice)
      const feedBefore = async (sig: string): Promise<readonly string[]> => {
        const l = await one("getSignaturesForAddress", [POOL_USD_FEEDS.solana.account, { before: sig, limit: 100, commitment: "finalized" }]);
        return Array.isArray(l) ? l.flatMap((e) => (e !== null && typeof e === "object" && (e as { err?: unknown }).err === null && typeof (e as { signature?: unknown }).signature === "string" ? [(e as { signature: string }).signature] : [])) : [];
      };
      if (await fillTradeOps({ store, read, feedBefore, price: () => page.price?.("solana") ?? null, now: Date.now, signal })) for (const f of watchers) f();
    })()
      .catch(() => {})
      .finally(() => {
        filling = null;
        if (fillAgain) {
          fillAgain = false;
          fillTrades();
        }
      });
  };
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
    // W's buy record from the read-back on (card sell-right-after-a-buy): written once the run tells the amount W
    // received, so the sale's plan, the sell box's preview and the positions have W's token before the buy is final;
    // the end's records are written after it, so a not_landed end takes it back
    let early: Promise<void> = Promise.resolve();
    const out = (): void => {
      if (done || facts.wallet === undefined || facts.out === undefined) return;
      facts.decimals ??= boughtDecimals.get(facts.wallet);
      const f = { ...facts };
      early = (async () => recordBoughtOut((await page.store()) as unknown as BuyRecordStore, f))()
        .catch(() => {})
        .finally(() => positions.refresh());
    };
    const finish = (end: Parameters<typeof recordPoolBuy>[3]): void => {
      if (done) return;
      done = true;
      if (facts.wallet !== undefined) {
        facts.decimals = boughtDecimals.get(facts.wallet) ?? facts.decimals;
        boughtDecimals.delete(facts.wallet);
        if (end !== null && "result" in end && end.result.stage !== "not_landed") awaited.set(facts.wallet, ctx.id);
      }
      void early
        .then(async () => recordPoolBuy((await page.store()) as unknown as BuyRecordStore, ctx.id, facts, end))
        .catch(() => {})
        .finally(() => (positions.refresh(), fillTrades()));
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
    const into = routeInto(facts, ctx.route);
    r = buy(ask, { ...ctx, progress, route: (x) => (into(x), "out" in x && out()) });
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
      if (stage === "filled") fillTrades();
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
  // `trade`: the sell kind's run, which holds its hosts until its end (a rent back resumed at load holds none)
  const sellHost = (trade = false): PoolSellKindHost & { end(): void } => {
    const r = rpcs();
    const release = trade ? holdTrade() : () => {};
    // the sign outs asked before this host: one asked after it stops its sales before their signatures (review P3-5 of
    // 77055f4e)
    const outs = signOuts;
    // a sign out ends the sale's waits (read-waits.ts waitUnless) and its finder list's reads
    const signal = solanaStop.signal;
    let notes: Promise<NoteStore> | null = null;
    const store = (): Promise<NoteStore> => (notes ??= page.store().then((w) => openNoteStore(w)));
    return {
      pin: pin!,
      // mainnet: W's sell pays a priority fee (pool-sell.ts solanaSellBudget)
      cluster: PAGE_CLUSTER,
      rpcs: r,
      notes: store,
      ops: page.store,
      seed64: page.seed64,
      // the sell's own read holds the positions' passes off while it runs (the running one stopped, a booked retry
      // dropped: one finder queue, so it never waits behind the display), then is the next pass's read; a read that
      // fails still ends the hold, and the next pass reads the finder (a rent back at load reads here too)
      wallets: async (read) => {
        // a load's rent backs list the account's Ws with nothing read (READS_NONE): no hold (review of 20ba2481b, P3-8);
        // they hold the passes off themselves while a W is read (preempt, below)
        const hold = read === READS_NONE ? null : positions.preempt();
        let found: FoundWallet[] | null = null;
        try {
          // a sale's list (cards wallets-found-in-one-read, pool-sell-legs-side-by-side): every W the pool's spent notes
          // paid, derived from the seed; the finder reads those `read` asks for, side by side in its steps, and with no
          // `read` only the Ws neither a buy record nor the last whole positions pass names (a buy from before a sign
          // out or a restore: the store is new, so no pass lists it), so with every W recorded or listed no finder read
          // starts at the tap (review of 55d4c6eb, P2-A). Each W the finder did not read has the tokens the listing names
          // it holding, else none read (null). The sale reads each W it sells from itself (pool-sell.ts planReads, one W
          // per request). The listing is what this tab last read of each W (positions.listed(): the memo, loaded from the
          // kept pass and written by every read after it), so a W read after the kept pass is never fed or hinted at the
          // kept pass's older amount (review P2 of 8da6b97f); the kept pass's own only before the memo has loaded it. No
          // whole pass kept yet (a restored device before its first pass), or a load's rent back: no listing
          const listed = trade ? (positions.listed() ?? keptListed(await (await page.store()).get("meta", POSITIONS_KEPT_KEY))) : null;
          let ask = read;
          if (ask === undefined) {
            const records = ((await (await page.store()).get("meta", BUY_MINTS_KEY)) as Record<string, unknown> | undefined) ?? {};
            ask = (a) => !Object.hasOwn(records, a) && listed?.has(a) !== true;
          }
          const got = await poolBuyWallets(await store(), r, ask, signal);
          const kept = (a: string) => (listed?.has(a) ? new Map(listed.get(a)) : null);
          // the Ws the finder read, and those the listing names: the next pass's read (a W in neither: the pass reads it)
          found = got.flatMap((w) => {
            const tokens = w.holdings === null ? kept(w.address) : new Map([...w.holdings.tokens].map(([m, h]) => [m, h.amount] as const));
            return tokens === null ? [] : [{ address: w.address, tokens }];
          });
          return got.map((w) => {
            const k = w.holdings === null ? kept(w.address) : null;
            return k === null ? w : { ...w, holdings: { native: 0n, tokens: new Map([...k].map(([m, a]) => [m, { amount: a, frozen: false }] as const)), unreadable: [] } };
          });
        } finally {
          // read, or named by the listing: the next pass's read; failed (the sell refuses, or a rent back at load
          // waits): the next pass reads
          if (found === null) hold?.release();
          else hold?.feed(found);
        }
      },
      // the rent backs owed (card sol-buy-rent-back), run again at the next load while owed
      owed: owedNoted(page.store),
      bought: buyMints(page.store),
      // the restore's rebuild's "read, no buy" mark (sol-buy-records.ts), proven by the rent back before it holds W
      buyNone: async (address) => Object.hasOwn(asRecord(await (await page.store()).get("meta", BUY_NONE_KEY)), address),
      // a load's rent backs hold the positions' passes off only while a W of theirs is read (review of 20ba2481b, P3-8)
      preempt: () => {
        const hold = positions.preempt();
        return () => hold.release();
      },
      // each rent-back fault and end, on the page's console: public words only (W's address, a step, a fault's name)
      told: (t) => console.warn(`rent back ${t.address} ${t.step} ${t.state}: ${t.detail}`),
      // the sells with no deposit back (kept on W) sent and not settled yet, settled at the next load
      kept: keptSells(page.store),
      // a sale settled outside a request's run (the load's rent back settles the note it finds INCOMING first): its
      // stage on the record that names it, so no record stays "sent" for good (review P2-2 of 77055f4e); a request's
      // run puts its own over this one (poolSellKind)
      settled: async (signature, stage) => settleSellOps(await page.store(), signature, stage),
      stopped: () => signOuts !== outs,
      signal,
      end: () => {
        release();
        void notes?.then((n) => n.close(), () => {});
      },
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
        // a trade's reads: it holds POOL_SELL_LOCK, which a sell tapped meanwhile waits for
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
  // included) gets the same promise and never starts a second read (its proof pass part: statePass). No follow-up read:
  // a note turns INCOMING only in an ask's run, which holds POOL_DEPOSIT_LOCK and finishes that note itself; a later
  // state read settles what it leaves.
  let reading: Promise<void> | null = null;
  // a state read's proof pass, while it runs (a landing's or a tap's pass runs on its own)
  let passing: Promise<unknown> | null = null;
  // a read that finds that pass running (or comes while another read runs, the queue open) asks for one more after it
  // (one, never a queue): the running pass read the queue's skip before what woke the read (a withdraw's kept-out
  // record, any tab's), so only a pass after it lets those notes go (queue.ts skip)
  let passAgain = false;
  const statePass = (): void => {
    if (passing !== null) return void (passAgain = true);
    const stop = solanaStop.signal;
    passing = proofs().finally(() => {
      passing = null;
      const again = passAgain;
      passAgain = false;
      if (again && !stop.aborted) statePass();
    });
  };
  // the dead pending sell records are settled once per page load, not on every state read (a re-ask settles its own)
  let deadSettled = false;
  // the rent backs (card round-trip-costs-less): backsSchedule
  const backs = backsSchedule();
  let foundScanned = false;
  const piecesOwed = piecesOwedOf(page.store);
  // W's history places a buy of several pieces' owner read has reached, by W (spendOwner's HistoryPlaces)
  const piecesPlaces = new Map<string, HistoryPlaces>();
  /** The buys of several pieces owed their end, decided from their notes' states (pool-buy.ts resumePieces): a W whose
   *  pieces paid it and whose buy can no longer land is owed a rent back (merged into W's own record, the buy's mint
   *  among its mints), which this load's background run of resumeRentBacks sweeps into the pool with no tap. Run on each
   *  state read and from followBuys (the settle pass a buy that ended "sent" starts). */
  const resumeOwedPieces = async (state: (noteId: string) => Promise<string | undefined>): Promise<void> => {
    if ((await piecesOwed.list().catch(() => [])).length === 0) return;
    const stranded = await resumePieces({
      owed: piecesOwed,
      state,
      // whose spend the buy's own note is, on both RPCs at finalized (pool-spend.ts spendOwner, as followBuys reads a
      // buy's): this buy's tag 3, another's, or not known yet; W's history read on across the state reads from piecesPlaces
      owner: async (r) => {
        const rs = settleRpcs("pass");
        const slots = await Promise.all(rs.map((rpc) => rpc("getSlot", [{ commitment: "finalized" }])));
        if (!slots.every((x) => Number.isSafeInteger(x))) return null;
        let places = piecesPlaces.get(r.address);
        if (!places) piecesPlaces.set(r.address, (places = new Map()));
        const o = await spendOwner(rs, { program: r.spend.program, feePayer: r.spend.feePayer }, r.address, BigInt(r.spend.nullifier), r.spend.context, Math.max(...(slots as number[])), undefined, places);
        return o === null ? null : o === "other" ? "other" : "mine";
      },
      strand: async (r) => {
        const o = owedNoted(page.store);
        const had = (await o.list()).find((x) => x.address === r.address);
        await o.put({ ...(had ?? { passes: 0 }), address: r.address, l: r.l, j: r.j, mints: [...(had?.mints ?? []).filter((m) => m.mint !== r.mint), { mint: r.mint, program: r.program }] });
      },
    }).catch(() => 0);
    if (stranded > 0) backs.again();
  };
  /** The scan of pool-found.ts on `mine` (under the seed's shared lock, the caller's): each W holding SOL that no owed
   *  record names gets one, `found`. */
  const findHeldWs = async (mine: readonly NoteRecord[]): Promise<void> => {
    // no note whose own W the scan reads: the seed is not read
    if (scope === null || !mine.some((n) => n.scope === scope && (n.state === "UNSPENT" || n.state === "HELD") && n.leaf !== undefined)) return;
    const o = owedNoted(page.store);
    const skip = new Set([...(await o.list()).map((x) => x.address), ...(await piecesOwed.list()).map((x) => x.address)]);
    const seed64 = await page.seed64();
    let ws: ReturnType<typeof ownWs>;
    try {
      ws = ownWs(seed64, mine, scope, skip);
    } finally {
      seed64.fill(0);
    }
    if (ws.length === 0) return;
    // the helper's seat for the batch (never a public provider); the testnet build, with none, one W a request
    const batch = POOL_TESTNET ? null : over.rpcs ? over.rpcs[1] : solanaPacedRpc(pageHelperRpc(TRADE_HELPER, SOLANA_RPC_RETRY, "pass"));
    for (const w of await heldWs(ws, batch, rpcs("pass")[0])) await o.put({ address: w.address, l: w.l.toString(), j: w.j, mints: [], passes: 0, found: true });
  };
  // the RESERVED notes a buy left (filled, refused, never answered, or its page closed mid-send): settled spent, freed
  // once both RPCs' finalized height is past the signed transaction's last height, or their block time past the
  // deadline, with no spent mark, or held (../../wallet/src/pool/solana-restore.ts solanaSettleReserved); a freed note is
  // proved again by the open queue's next pass
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
        const pass = await solanaSettleReserved({ seed64, notes, program: pin!.program, rpcs: settleRpcs("pass"), lister: lister("pass"), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES });
        await followBuys(notes);
        await resumeOwedPieces(async (id) => (await notes.get(id))?.state);
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
  let finishing: Promise<void> | null = null;
  const finishOnward = (): Promise<void> => (finishing ??= finishOnwardOnce().finally(() => (finishing = null)));
  const finishOnwardOnce = async (): Promise<void> => {
    if (!locks || !owedScan) return;
    owedScan = false;
    const ops = await page.store();
    const owed: [string, PendingOnward, EvmHeldOnW | undefined][] = [];
    for (const k of await ops.keys("ops")) {
      if (withdrawing.has(k)) continue;
      const rec = (await ops.get("ops", k)) as { kind?: unknown; owed?: unknown; pending?: PendingOnward; held?: Record<string, EvmHeldOnW> } | undefined;
      if (rec?.kind !== "withdraw") continue;
      if (rec.pending) await moveLegacyPending(ops, k, rec.pending);
      const id = rec.pending?.noteId ?? rec.owed;
      // any stage: `owed` names the note whose send the op owes (a tab closed during the release leaves "proving");
      // its send is meta/owed/<op id>'s record (none yet: written but not marked, or the other way: read again later)
      const p = typeof id === "string" ? await owedSendOf(ops, k, id) : undefined;
      // a part held on W (its send reverted): the finish sends it at W's next nonce, never at 0 again
      if (p) owed.push([k, p, rec.held !== undefined && typeof rec.held === "object" && Object.hasOwn(rec.held, p.noteId) ? rec.held[p.noteId] : undefined]);
      else if (typeof id === "string") owedScan = true;
    }
    if (owed.length === 0) return;
    const notes = await openNoteStore(await page.store());
    try {
      for (const [k, pending, held] of owed) {
        const retry = owedRetry.get(k);
        if (retry && Date.now() < retry.at) {
          owedScan = true;
          continue;
        }
        const evmChain = (pending as Partial<EvmPendingOnward>).chain;
        // an EVM pool's owed send: its chain's finish (src/pool-withdraw-evm.ts); a chain with no pool or no withdraw here
        // is read again
        if (evmChain === "base" || evmChain === "robinhood") {
          const eh = evmWithdrawHost(evmChain, notes);
          // the finish's own send kept as the run's is, before it leaves
          const got = eh === null ? null : await locks.request(WALLET_SEED_LOCK, { mode: "shared" }, () => finishEvmOnward({ ...eh, keep: (q) => keepEvmSend(ops, k, q) }, pending as EvmPendingOnward, evmStopsOf(k), held));
          if (got !== null && !(await writeEvmFinish(ops, k, pending.noteId, got))) {
            owedRetry.delete(k);
            evmStops.delete(k);
          } else {
            const waitMs = Math.min(Math.max(2_000, (retry?.waitMs ?? 1_000) * 2), 60_000);
            owedRetry.set(k, { at: Date.now() + waitMs, waitMs });
            owedScan = true;
          }
          continue;
        }
        if (pin === undefined) continue;
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
    const evm = evmRead().then(() => finishOnward()).catch(() => {});
    if (scope === null) return evm;
    return Promise.all([evm, solanaRead()]).then(() => {});
  };
  const solanaRead = (): Promise<void> => {
    if (reading) {
      // this read's own pass part, though the read itself is the running one's
      if (open !== null) statePass();
      return reading;
    }
    const p = (async () => {
      try {
        const mine = (await readNotes(await page.store())).filter((n) => n.scope === scope);
        // the next buy's proofs (card signpage-pool-pins) before any settle step: a page that loads with the pool's
        // notes landed opens the queue, and each read while it is open makes the epoch's proofs again, one pass at a
        // time; a settle that throws or waits (a deposit run, a sell's verdict, a buy's owed pieces) never holds them back
        if (open !== null || mine.some((n) => n.state === "UNSPENT" || n.state === "HELD")) statePass();
        if (settling) return await settling;
        if (mine.some((n) => n.state === "INCOMING")) await settleSolana();
        // a failed reserved pass never holds back a send owed (the money on W): the finish below still runs
        if (mine.some((n) => n.state === "RESERVED") || lateBuys.size > 0) await settleReserved().catch(() => {});
        // a buy of several pieces whose pieces paid W and whose buy can no longer land: what W holds goes back into the
        // pool by the rent back (W's own owed record), run in this load's background below, with no tap
        if ((await piecesOwed.list().catch(() => [])).length > 0) {
          const now = new Map((await readNotes(await page.store())).map((n) => [n.id, n.state]));
          await resumeOwedPieces(async (id) => now.get(id));
        }
        // a sell's note left INCOMING, or a sell with no deposit back (no note) left sent: both settled by the sell's verdict
        if (mine.some((n) => n.state === "INCOMING" && (n.ref.kind === "return" || (n.ref.kind === "second" && n.ref.id.id === "R"))) || (await keptSells(page.store).list().catch(() => [])).length > 0) await settleSells();
        // a note a settle step landed (INCOMING -> UNSPENT) is proved too: one more pass after the running one
        if (mine.some((n) => n.state === "INCOMING") && (open !== null || (await readNotes(await page.store())).some((n) => n.scope === scope && n.state === "UNSPENT"))) statePass();
        await finishOnward();
        // a sell request whose page closed before it signed: refused "failed", so its id is never id_reused for good
        if (locks && !deadSettled) {
          await settleDeadSellOps(await page.store(), locks);
          deadSettled = true;
        }
        // the rent backs a closed page or a provider's fault left owed (card sol-buy-rent-back), and every W of the
        // account's another browser left (card round-trip-costs-less): at the load's first state read, then on a state
        // read past the run's backoff while one is left to try, after the sells settle, in the background (it reads,
        // checks and sends), under the seed's shared lock and the sell lock
        if (locks && backs.take()) {
          const scan = !foundScanned;
          foundScanned = true;
          void locks
            .request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
              const h = sellHost();
              try {
                // once a load: the own W of each UNSPENT or HELD note that holds SOL (pool-found.ts), owed a rent back
                // that sweeps it only while both RPCs read it owning no token account; a restored device finds there a
                // buy of several pieces whose pieces paid W and whose buy never landed
                if (scan) await findHeldWs(mine).catch(() => {});
                return await resumeRentBacks(h, locks);
              } finally {
                h.end();
              }
            })
            .then(
              (more) => backs.ended(more === true),
              () => backs.ended(false),
            );
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
      const fee = solanaPoolFee(rent);
      const wFee = await solanaOnwardFee(r, pin!);
      const owed = await owedNotes();
      return { notes: withdrawSources(await notes.list(), scope!).filter((n) => !owed.has(n.id)), fee, wFee, minPart: solanaWithdrawMinPart(rent, fee, wFee) };
    } finally {
      notes.close();
    }
  };
  const withdraw = async (ready: PoolReady, opId: string): Promise<void> => {
    if (!locks || !wayOut(ready.chain) || (ready.chain === "solana" ? pin === undefined : evmPool(ready.chain) === null)) return;
    withdrawing.add(opId);
    try {
      await (ready.chain === "solana" ? withdrawRun(ready, opId) : evmWithdrawRun(ready.chain, ready, opId));
    } finally {
      withdrawing.delete(opId);
    }
  };
  // pool.withdraw on Base or Robinhood (src/pool-withdraw-evm.ts): the chain's pool (its pin decides: none, no
  // withdraw), the wallet's evmPool on the trade's pair for the bind, the page's prover and note store, the helper's
  // send, the chain's RESERVED settle; the op record and its owed send as Solana's (meta/owed/<op id>)
  const evmStops = new Map<string, EvmFinishState>();
  const evmStopsOf = (k: string): EvmFinishState => {
    let s = evmStops.get(k);
    if (!s) evmStops.set(k, (s = { stops: [null, null], noneAt: null }));
    return s;
  };
  const evmWithdrawHost = (chain: "base" | "robinhood", notes: NoteStore): EvmWithdrawHost | null => {
    // on every build that carries the chain's withdraw (poolWayOut: SIGN_HOST's too, card evm-deposit-on-mainnet)
    if (!wayOut(chain)) return null;
    const e = evmPool(chain);
    if (e === null) return null;
    const pool =
      (over.evmQueuePool?.(chain) as Pool<EvmPoolRequest> | undefined) ??
      walletEvmPool({
        pin: e.pin,
        rpcs: e.list,
        feeRpcs: pageEvmFeeRpcs(chain),
        feeHold: evmFeeHoldOf(e.pin),
        held: pageEvmHold(e.pin, () => (page.held ? page.held() : page.store())),
        history: [...e.list, ...pageEvmHistory(e.pin)],
        relayFee: (ep, sg) => evmPoolRelayFee(e.pin.pool, ep, sg, over.fetch),
        epochFee: evmEpochFee,
      });
    return {
      chain,
      testnet: POOL_TESTNET,
      pin: e.pin,
      venues: evmPoolVenues(),
      rpcs: e.rpcs,
      pool,
      prover: prover.vault,
      notes: async () => notes,
      seed64: page.seed64,
      send: (body) => evmPoolSend(TRADE_HELPER, body, over.fetch),
      settle: () => void reserveEvm(chain).catch(() => {}),
      owedNotes,
      ...(over.now ? { now: over.now } : {}),
      ...(over.wait ? { wait: over.wait } : {}),
    };
  };
  const evmQueueOf = async (chain: "base" | "robinhood"): Promise<ProofQueue<EvmPoolRequest> | null> => {
    const q = evmQueues.get(chain);
    return q ? (((await q.catch(() => null))?.queue as ProofQueue<EvmPoolRequest> | undefined) ?? null) : null;
  };
  // the rule is evmWithdrawHost's (no withdraw in the build: no host, "no pool for this chain")
  const evmFunds = async (chain: "base" | "robinhood", to?: string): Promise<PoolFunds> => {
    const notes = await openNoteStore(await page.store());
    try {
      const h = evmWithdrawHost(chain, notes);
      if (h === null) throw new Error("no pool for this chain");
      return await evmWithdrawFunds(h, to);
    } finally {
      notes.close();
    }
  };
  const evmWithdrawRun = async (chain: "base" | "robinhood", ready: PoolReady, opId: string): Promise<void> => {
    if (!wayOut(chain) || !locks) return;
    const ops = await page.store();
    const created_ms = Date.now();
    let writes: Promise<unknown> = ops.put("ops", opId, { kind: "withdraw", stage: "proving", txs: [], created_ms }).catch(() => {});
    let owedNote: string | null = null;
    const write = (stage: WithdrawStage, txs: TxRef[], pending: PendingOnward | null, arrived: Arrivals, held?: EvmHeldOnW) => {
      const cleared = pending ? null : owedNote;
      void (writes = writes.then(() => writeEvmStage(ops, opId, { stage, txs, arrived, held }, cleared)).catch(() => {}));
    };
    const owe = async (pending: EvmPendingOnward): Promise<void> => {
      owedNote = pending.noteId;
      const w = writes.then(async () => {
        await oweSend(ops, opId, pending);
        await ops.update("ops", opId, (v) => mergeWithdrawOp(v, { stage: "in_transit", owe: pending.noteId }));
      });
      writes = w.catch(() => {});
      await w;
    };
    const keep = async (q: EvmPendingOnward): Promise<void> => {
      const w = writes.then(() => keepEvmSend(ops, opId, q));
      writes = w.catch(() => {});
      await w;
    };
    await locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
      const notes = await openNoteStore(await page.store());
      try {
        const h = evmWithdrawHost(chain, notes);
        if (h === null) return write("stopped", [], null, {});
        const q = await evmQueueOf(chain);
        const ask = { kind: "pool.withdraw", chain, token: null, amount: 0n, slippageBps: 0, decimals: 18 } as const;
        // the run's planned notes out of every tab's proof queue and every other plan until it ends (as the Solana run's)
        const keepOut = async (ids: readonly string[], spanMs: bigint): Promise<void> => void (await keepOutNotes(ops, opId, ids, BigInt(Date.now()), spanMs));
        const end = await runEvmPoolWithdraw({ ...h, ...(q ? { drop: (id: string) => q.drop(id) } : {}), stage: write, owe, keep, keepOut }, { ...ask }, ready.to, ready.amount, ready.maxFee);
        write(end.stage, end.txs, end.pending, end.arrived, end.held);
        if (end.feeNeeded !== undefined) void (writes = writes.then(() => ops.update("ops", opId, (v) => mergeWithdrawOp(v, { feeNeeded: end.feeNeeded! }))).catch(() => {}));
        // why a run or a part ended on a throw, on the record and the page's console (public words only: legCause), as
        // the Solana run's
        if (end.cause !== undefined) {
          console.warn(`withdraw ${end.stage}: ${end.cause}`);
          void (writes = writes.then(() => ops.update("ops", opId, (v) => mergeWithdrawOp(v, { cause: end.cause! }))).catch(() => {}));
        }
        if (end.pending) owedScan = true;
      } finally {
        notes.close();
      }
    });
    await writes;
    if (evmQueues.has(chain)) void evmProofs(chain);
  };
  const evmWithdrawDeps = (chain: "base" | "robinhood", opId: string): PoolWithdrawFormDeps => {
    const e = wayOut(chain) ? evmPool(chain) : null;
    return {
      chain,
      keys: { pool: e?.pin.pool ?? "" },
      funds: (to?: string) => (e === null ? Promise.reject(new Error("no flow for this chain")) : evmFunds(chain, to)),
      ...(e !== null && locks ? { handoff: (r: PoolReady) => void withdraw(r, opId), owedFees, redraw } : {}),
    };
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
            keepOut: async (ids, spanMs) => void (await keepOutNotes(ops, opId, ids, BigInt(Date.now()), spanMs)),
            // the release's withdrawn value is on the note's mark: the app reads the state again, as after a buy's
            marked: () => {
              for (const f of watchers) f();
            },
          },
          { ...ask },
          ready.to,
          ready.amount,
          ready.maxFee,
        );
        write(end.stage, end.txs, end.pending, end.arrived);
        if (end.feeNeeded !== undefined) void (writes = writes.then(() => ops.update("ops", opId, (v) => mergeWithdrawOp(v, { feeNeeded: end.feeNeeded! }))).catch(() => {}));
        // why a run ended on a throw, on the record and the page's console (public words only: legCause)
        if (end.cause !== undefined) {
          console.warn(`withdraw ${end.stage}: ${end.cause}`);
          void (writes = writes.then(() => ops.update("ops", opId, (v) => mergeWithdrawOp(v, { cause: end.cause! }))).catch(() => {}));
        }
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
  const withdrawDeps = (chain: PoolChain, opId: string): PoolWithdrawFormDeps => chain !== "solana" ? evmWithdrawDeps(chain, opId) : ({
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
            ? evmRun(ask.chain, ask, ctx, evmBuy(ask.chain) ?? undefined)
            : ask.kind === "pool.sell"
              ? evmRun(ask.chain, ask, ctx, evmSell(ask.chain) ?? undefined)
              : ask.kind === "pool.withdraw" && wayOut(ask.chain) && page.openWithdraw && evmPool(ask.chain) !== null
                ? (page.openWithdraw(ask.chain, ctx) ?? { error: "not_allowed" })
                : { error: "not_allowed" }
        : pin === undefined || !wayOut("solana")
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
      // Base and Robinhood (card evm-deposit-route-mainnet): the chain's EVM kind with the same fixed source, on its pin
      if (ask.chain !== "solana") return evmDeposit(ask.chain)?.(ask, ctx, from) ?? { error: "not_allowed" };
      return pin === undefined || !wayOut("solana") ? { error: "not_allowed" } : deposit(ask, ctx, from);
    },
    evmPoolOf: (chain) => ((e) => (e === null ? null : (evmWarm(chain), { pin: e.pin, rpcs: e.rpcs })))(evmPool(chain)),
    host: () => host(),
    settle,
    stateRead,
    // Solana's, then Base's and Robinhood's; null when a sign out overtook the read, or when no chain has a row yet and
    // Solana's first pass has not answered (the state keeps its own [] then, as before any pass). An EVM row is never
    // held back for Solana's first pass: the state then sends [] for Solana, as it did before any pass, and Solana's
    // rows once it answers. An EVM chain whose last pass was not whole and whose round
    // of retries is spent is asked one more pass (not a new round), at most once per EVM_POSITIONS_REARM_MS
    positions: async () => {
      const outs = signOuts;
      const was = clears;
      const [sol, ...evm] = await Promise.all([positions.read(), ...(["base", "robinhood"] as const).map((c) => evmPositions(c)?.read() ?? Promise.resolve([]))]);
      if (signOuts !== outs || clears !== was) return null;
      const now = (over.positionsNow ?? Date.now)();
      for (const c of ["base", "robinhood"] as const) {
        const cache = evmPositions(c);
        if (cache?.spent() && now - (evmRearmed.get(c) ?? -Infinity) >= EVM_POSITIONS_REARM_MS) {
          evmRearmed.set(c, now);
          cache.once();
        }
      }
      // a sale newer than the pass a chain's rows came from: its token's rows hidden (that pass read them before it)
      const rows = (["base", "robinhood"] as const).flatMap((c, i) => {
        const hide = evmHolds.get(c)?.newer(evmShownGen.get(c) ?? 0);
        return (evm[i] ?? []).filter((p) => hide === undefined || !hide.has(p.token.toLowerCase()));
      });
      return sol === null && rows.length === 0 ? null : [...(sol ?? []), ...rows];
    },
    // the Ws whose rent back is owed, as their records stand (src/positions.ts returningWallets: those a pass read listed
    // returning); a store read, never a chain read
    returning: () => owedRentBacks(page.store).list(),
    // a restore wrote buy records of `chain` (src/pool-restore.ts, restoreEvmHoldings): its positions read again
    evmHoldingsRestored: (chain: "base" | "robinhood") => void evmPositions(chain)?.refresh(),
    positionsNow: () => positions.get(),
    boughtSince: async (token: string) => {
      const st = await (page.held ? page.held() : page.store());
      const [mints, kept, costs, sold] = await Promise.all([st.get("meta", BUY_MINTS_KEY), st.get("meta", POSITIONS_KEPT_KEY), st.get("meta", POSITION_COSTS_KEY), st.get("meta", POSITIONS_SOLD_KEY)]);
      return { since: boughtSincePass(token, mints, kept, costs, sold), held: keptHeldOf(token, kept) };
    },
    // the restore's notes written: each Solana W with no buy record gets it back from its own buy, in the background
    proofs: () => (buyRecords.run(), proofs()),
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
      // the landed releases on the notes' marks, as any tab wrote them, read after the notes (a mark whose note the notes
      // read shows out of RESERVED counts nothing: balances.ts takes a RESERVED note's mark of its own attempt only)
      const landed = async (): Promise<ReadonlyMap<string, LandedRelease>> => {
        const m = await readReservedMarks(await page.store()).catch(() => new Map());
        return new Map([...m].flatMap(([id, x]) => (x.withdrawn === undefined ? [] : [[id, { attempt: x.attempt, withdrawn: x.withdrawn }] as const])));
      };
      if (qs.length === 0) {
        const value = await read();
        return { ready: undefined, value, open: ids, landed: await landed() };
      }
      const ready: ReadyProof[] = [];
      const making = new Set<string>();
      const turn = async (i: number): Promise<T> => {
        if (i === qs.length) return read();
        const r = await qs[i]!.readyWith(() => turn(i + 1));
        ready.unshift(...r.ready);
        for (const id of r.making) making.add(id);
        return r.value;
      };
      const value = await turn(0);
      return { ready, value, open: ids, landed: await landed(), making };
    },
    watch: (fn) => void watchers.add(fn),
    signingOut: stopReads,
    signedOut,
    // the session's sign out: aborted at the next one (this tab's or another's), as every Solana settle's stop
    outSignal: () => solanaStop.signal,
    withdrawDeps,
    withdraw,
  };
}
