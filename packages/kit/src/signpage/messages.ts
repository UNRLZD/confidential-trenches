// The signing page's postMessage API (wallet.md §7 item 4; app.md §2.1 A2-A4). The app talks to SIGN_HOST's hidden
// iframe only with these messages, the origin checked both ways. Every request kind has its wallet.md §2.8 row; the
// page refuses a kind with no row, a field its row does not allow, and a `v` other than 1. Answers and events carry
// addresses, balances, tx hashes and states only: never a key, the 12 words, a note secret or a signed-but-unsent
// payload (wallet.md §2.9 row 11).
//
// Every amount is a decimal string. A request's `id` is crypto.randomUUID(); a retry reuses it, and the page answers a
// repeated id with its first answer, never a second run, so a timeout and a retry can never buy twice.

import type { Chain, OrderTrigger } from "../orders/record.ts";
import { deepFreeze } from "../freeze.ts";

/**
 * The twenty-three request kinds, app to page. nav and reload are to SIGN_HOST's shell (card signpage-shell); the four
 * pool kinds (card signpage-pool-kinds) and the two deposit sheet reads, deposit.assets and deposit.dry (card
 * kit-deposit-assets-dry), were added after kit-v1 without changing any other kind. A page of an earlier release
 * refuses a kind it does not have "not_allowed".
 */
export const SIGNPAGE_KINDS = [
  "deposit.quote",
  "deposit.confirm",
  "arm",
  "buy",
  "hop",
  "orders.set",
  "orders.cancel",
  "return",
  "withdraw.open",
  "signin.open",
  "backup.open",
  "export.open",
  "signout",
  "restore",
  "state",
  "nav",
  "reload",
  "pool.deposit",
  "pool.buy",
  "pool.sell",
  "pool.withdraw",
  "deposit.assets",
  "deposit.dry",
] as const;
deepFreeze(SIGNPAGE_KINDS);

export type SignpageKind = (typeof SIGNPAGE_KINDS)[number];

/** The kinds that open a SIGN_HOST top-level screen: the app posts one, then moves the same tab to SIGN_HOST. */
export const OPEN_KINDS = ["withdraw.open", "signin.open", "backup.open", "export.open", "signout", "pool.withdraw"] as const satisfies readonly SignpageKind[];
deepFreeze(OPEN_KINDS);

/** The chains a pool runs on: NEAR's money is the vault's, never a pool's. */
export type PoolChain = "solana" | "base" | "robinhood";
export const POOL_CHAINS: readonly PoolChain[] = Object.freeze(["solana", "base", "robinhood"] as const);

/** The events, page to app. */
export const SIGNPAGE_EVENTS = ["ready", "state", "progress"] as const;
deepFreeze(SIGNPAGE_EVENTS);

export type SignpageEventType = (typeof SIGNPAGE_EVENTS)[number];

/** The way in for sign-in. */
export type SigninWay = "passkey" | "words" | "wallet";

/**
 * Where SIGN_HOST sends the tab back once a top-level flow ends: a key from the fixed list in the release (for example
 * "deposit", "withdraw", "settings", "position"). SIGN_HOST maps it to an APP_HOST URL; the URL never carries it.
 */
export type ReturnKey = string;

interface Open {
  return_key: ReturnKey;
}

/** The params of each kind, spread into the request envelope next to v, id and type. */
export interface SignpageParams {
  /**
   * Ask a deposit address for money from outside: the 1Click asset id the user sends, and how much of it. The request's
   * id is the deposit's op id in state.ops, where its stages and facts come (Operation, DepositFacts).
   */
  "deposit.quote": { origin_asset: string; amount: string };
  /** Read the state of a deposit by the address the quote answered. Signs nothing. */
  "deposit.confirm": { deposit_address: string };
  /** Get fresh wallets ready on a chain for the amount in the trade box. Answered at once; runs in the background. */
  arm: { chain: Chain; amount: string };
  /**
   * A trade by hand from fresh wallets: a buy spends `amount` of USDC from the ready set, a sell sells `amount` of the
   * token from the wallets that hold it. `slippage_bps` is the user's, within the release's control ranges.
   */
  buy: { chain: Chain; token: string; side: "buy" | "sell"; amount: string; slippage_bps: number };
  /** Move money from a ready wallet on one chain to a fresh wallet on another. */
  hop: { from: Chain; to: Chain; amount: string };
  /**
   * Sign the exits of a position in advance: a take-profit and a stop, each with its trigger price and the share of
   * the position it sells, in basis points.
   */
  "orders.set": {
    chain: Chain;
    token: string;
    slippage_bps: number;
    tp?: { trigger_price: string; share_bps: number };
    sl?: { trigger_price: string; share_bps: number };
  };
  /** Cancel orders by id. */
  "orders.cancel": { order_ids: string[] };
  /** Send what a fresh wallet holds back to the vault. */
  return: { chain: Chain; wallet: string };
  /** Open the withdraw form; with `from_id`, the move out of a one-time id or an arming account. The address is typed there. */
  "withdraw.open": Open & { from_id?: string };
  /** Open the sign-in for one way in. */
  "signin.open": Open & { way: SigninWay };
  /** Open the backup screen. */
  "backup.open": Open;
  /** Open the key export for one wallet of this seed. */
  "export.open": Open & { chain: Chain; address: string };
  /** Open sign-out (the backup first when the 12 words are not saved yet). */
  signout: Open;
  /** Rebuild the store from the chain. Signs nothing; reports `progress` at least every 10 s. */
  restore: Record<never, never>;
  /** Read the state. Signs nothing. */
  state: Record<never, never>;
  /**
   * Where the app is now: its path and query on APP_HOST. The shell puts it in the top window's address with
   * history.replaceState and never navigates, so the address bar, a reload and a shared link follow the app. A path
   * that is not APP_HOST's own path and query, or over SIGNPAGE_MAX_NAV_BYTES of UTF-8, is refused not_allowed.
   */
  nav: { path: string };
  /** Reload the top window: the shell and the app in it (a reload of the frame alone would keep the old shell). */
  reload: Record<never, never>;
  /** Move `amount` of the chain pool's asset (POOL_ASSET_DECIMALS) that the device holds on that chain into the pool. */
  "pool.deposit": { chain: PoolChain; amount: string };
  /** A release from the chain's pool to a fresh wallet that buys `token` with `amount` of the pool's asset. */
  "pool.buy": { chain: PoolChain; token: string; amount: string; slippage_bps: number };
  /** The fresh wallet sells `amount` of `token`; the proceeds go back into the chain's pool in the same transaction. */
  "pool.sell": { chain: PoolChain; token: string; amount: string; slippage_bps: number };
  /** Open SIGN_HOST's withdraw screen for the chain's pool. The address is typed there, never sent by the app. */
  "pool.withdraw": Open & { chain: PoolChain };
  /** The assets the device can quote a deposit from, each with its minimum and the most one deposit takes. Signs nothing
   *  and needs no sign-in. */
  "deposit.assets": Record<never, never>;
  /**
   * What `amount` of `origin_asset` (in its own units, as deposit.quote's) would land in the vault as, with no address:
   * a dry 1Click quote whose recipient and refund are DEPOSIT_DRY_PLACEHOLDER, so the request carries nothing of the
   * user's. Signs nothing and needs no sign-in.
   */
  "deposit.dry": { origin_asset: string; amount: string };
}

export interface TxRef {
  chain: Chain;
  hash: string;
}

/** A top-level flow is set up: the page wrote its one-use pending-flow record. Its outcome comes back in `state`. */
export interface OpenResult {
  pending: true;
}

/** The result of each kind. */
export interface SignpageResults {
  "deposit.quote": {
    deposit_address: string;
    origin_asset: string;
    amount_in: string;
    min_amount_out: string;
    /** ISO 8601: send before it. */
    deadline: string;
    time_estimate_s: number;
  };
  "deposit.confirm": { stage: DepositStage } & DepositFacts;
  arm: { stage: "queued" };
  /** Answered once every slice is signed and sent; the fill comes in `progress`. */
  buy: { stage: TradeStage; txs: TxRef[] };
  hop: { stage: HopStage; txs: TxRef[] };
  "orders.set": { orders: { order_id: string; group_id: string; kind: OrderTrigger["kind"]; state: OrderState }[] };
  "orders.cancel": { orders: { order_id: string; state: OrderState }[]; txs: TxRef[] };
  return: { stage: ReturnStage; txs: TxRef[] };
  "withdraw.open": OpenResult;
  "signin.open": OpenResult;
  "backup.open": OpenResult;
  "export.open": OpenResult;
  signout: OpenResult;
  restore: { stage: "started" };
  state: SignpageState;
  nav: Record<never, never>;
  reload: Record<never, never>;
  "pool.deposit": { stage: TradeStage; txs: TxRef[] };
  "pool.buy": { stage: TradeStage; txs: TxRef[] };
  "pool.sell": { stage: TradeStage; txs: TxRef[] };
  "pool.withdraw": OpenResult;
  "deposit.assets": { assets: DepositAsset[] };
  "deposit.dry": DepositDry;
}

/**
 * The public NEAR account a dry deposit quote names as its recipient and refundTo (card kit-deposit-assets-dry): the
 * 64-hex sha256 of "blindfill:deposit.dry:placeholder", an implicit id nobody holds a key to. It is not registered on
 * the vault's USDC (storage_balance_of null on two RPCs, 6 Nov 13:45Z), as no deposit's one-time id is, so 1Click
 * quotes it the same withdraw fee as a real deposit (the all-zero id is registered, and 1Click quotes it none).
 */
export const DEPOSIT_DRY_PLACEHOLDER = "4b742e2fa54135408f95d6be00483527709b33281f3d1836ae3e83371caae5c0";

/**
 * An asset deposit.quote takes (card kit-deposit-assets-dry): its 1Click asset id (deposit.quote's origin_asset), its
 * chain, symbol and decimals as 1Click's own list names them (checked against the device's), `min` the least amount in
 * its own units whose quote clears the vault's 1 USDC MIN_DEPOSIT after every fee (the device's floor, at 1Click's
 * withdraw fee as just quoted), and `max_usd` the most one deposit takes, in USD (the beta cap, HELPER_BIND_DEPOSIT_CAP).
 */
export interface DepositAsset {
  origin_asset: string;
  chain: Chain;
  symbol: string;
  decimals: number;
  min: string;
  max_usd: string;
}

/**
 * A dry quote's lines (card kit-deposit-assets-dry), in USD as decimal strings: what lands in the vault, the least it
 * may land as (1Click's min out after slippage), and the fees (the amount in, at USDC's 1, less what lands); then
 * 1Click's own time estimate, in seconds, from the dry answer. The device checked the answer as a live one is checked
 * (signature, echo, floors), less the address a dry answer does not have.
 */
export interface DepositDry {
  amount_out_usd: string;
  min_amount_out_usd: string;
  fee_usd: string;
  time_estimate_s: number;
}

/**
 * Why deposit.quote or deposit.dry was refused (card kit-deposit-assets-dry): below_min (under the asset's minimum:
 * refused on the device before any request, or once a checked answer shows the vault's MIN_DEPOSIT is not cleared),
 * above_max (over the beta cap), not_available (1Click or the helper refused it), busy (the helper is rate-limited:
 * HTTP 429), down (the helper is not answering: HTTP 503 or no answer), quote_check_failed (the answer failed the
 * device's checks), not_allowed (no rule allows the request). busy and down are "not now": the same request again runs.
 */
export type DepositRefusal = "below_min" | "above_max" | "not_available" | "busy" | "down" | "quote_check_failed" | "not_allowed";
export const DEPOSIT_REFUSALS: readonly DepositRefusal[] = Object.freeze(["below_min", "above_max", "not_available", "busy", "down", "quote_check_failed", "not_allowed"] as const);

/**
 * Why a request was refused: "not_allowed" (no wallet.md §2.8 row allows it), "quote_check_failed" (a quote failed the
 * device's checks), or a trade check's id from the markets paper.
 */
export type ErrorCode = "not_allowed" | "quote_check_failed" | (string & {});

export type SignpageRequest<K extends SignpageKind = SignpageKind> = {
  [P in K]: { v: 1; id: string; type: P } & SignpageParams[P];
}[K];

export type SignpageAnswer<K extends SignpageKind = SignpageKind> =
  | { v: 1; id: string; ok: true; result: SignpageResults[K] }
  | { v: 1; id: string; ok: false; error: { code: ErrorCode } };

/** The handshake: the first message the page posts once it listens. `api` is this file's version. */
export interface ReadyEvent {
  v: 1;
  type: "ready";
  /** The signing page's release tag, the one APP_HOST's build pins with its index.html sha384. */
  release: string;
  api: 1;
}

/**
 * The kit version this client names to the signing page (card kit-frame-version): the tag it is cut as, kit-v<version>.
 * The page sends a client only the states, stages and facts its version reads. A change to what the page may send
 * (a state field, an op kind, a stage, a fact) raises it, and the page maps the version before it down.
 */
export const SIGNPAGE_KIT_VERSION = "1.5";

/**
 * The client's half of the handshake, app to page (card kit-frame-version): its kit version, posted before every
 * handshake `state` request, so the page knows what this client reads before it sends a state. It has no id: the page
 * answers nothing to it, and a page of an earlier release drops it unread (a message with no request id gets no
 * answer). A client that posts none (kit-v1 to kit-v1.4) is read as kit-v1.4.
 */
export interface HelloMessage {
  v: 1;
  type: "hello";
  kit: string;
}

/** Posted on every change of the state. */
export interface StateEvent {
  v: 1;
  type: "state";
  state: SignpageState;
}

/**
 * What a running pool.buy's page read and bound itself, one fact per event, each once and in this order, at the moment
 * it is known (card signpage-buy-route-events):
 * - `wallet`: the one-time wallet W the proof pays and the transaction is signed by, once the device's check passed and
 *   W derived from the seed is the proof's recipient;
 * - `venue` and `pool`: the venue the quote was read on (on Solana "pump-curve" or "pumpswap") and its pool's address
 *   (the bonding curve's account or the AMM pool's), read on two RPCs and checked in the same step;
 * - `tx` (card pool-buy-send-fast): the buy's transaction signature (base58 of 64 bytes), told once both RPCs read this
 *   very transaction back under it, the moment the buy is sent. The answer names it too, but an answer that comes past
 *   the client's SIGNPAGE_TIMEOUT_MS is dropped (a mainnet bundle that lands late); this event reaches the app whenever
 *   it comes;
 * - `out`: the token amount W received, a decimal string in the token's whole units, read from the transaction itself
 *   on both RPCs, the two the same and at least the buy's min out. Absent when they differ: never made up.
 * Addresses, an amount and a signature only: never a key, the 12 words or a note.
 */
export type BuyRoute = { wallet: string } | { venue: string; pool: string } | { out: string } | { tx: string };

/** The stage of a request still running, by its id. */
export interface ProgressEvent {
  v: 1;
  type: "progress";
  id: string;
  stage: Stage;
}

/**
 * One fact of a running buy's route (BuyRoute), by its id: a progress event with no stage. Its own event, never fields
 * on a stage event: a client of an earlier kit checks a progress event with exact keys and drops any other shape, so it
 * drops a route event and still reads every stage. A page of an earlier release sends none, and a client reads its
 * stages as before.
 */
export type ProgressRouteEvent = { v: 1; type: "progress"; id: string } & BuyRoute;

export type SignpageEvent = ReadyEvent | StateEvent | ProgressEvent | ProgressRouteEvent;

/** Anything the page posts to the app. */
export type SignpageMessage = SignpageAnswer | SignpageEvent;

/**
 * Every stage a deposit can reach (card kit-deposit-calls added the last four, after kit-v1, changing none before them):
 * - quote_checked: the address is shown, nothing seen yet; waiting: the send is known; in_transit and into_vault: 1Click
 *   is processing, then the device binds the note; done: the note read on two agreeing RPCs;
 * - failed: 1Click reported FAILED and is still processing it; short: 1Click INCOMPLETE_DEPOSIT, less arrived than the
 *   quote's amount; expired: the signed deadline passed with nothing sent;
 * - refunded: 1Click refunded the money to the deposit's one-time id U; refund_move: the device's move of that refund
 *   into the vault is in flight;
 * - held: the money waits under its id (the vault keeps refusing it, or 1Click cannot route it); halted: it waits for a
 *   reason named in `hold` (DepositHold).
 */
export type DepositStage =
  | "quote_checked" | "waiting" | "in_transit" | "into_vault" | "done" | "refunded" | "held" | "halted"
  | "failed" | "short" | "expired" | "refund_move";
export const DEPOSIT_STAGES: readonly DepositStage[] = Object.freeze([
  "quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted",
  "failed", "short", "expired", "refund_move",
] as const);
/** Why a halted deposit waits: USDC halted or the relayer down or holding; the relayer not caught up; the vault's account blocked on USDC. */
export type DepositHold = "halted" | "not_caught_up" | "vault_blocked";
export const DEPOSIT_HOLDS: readonly DepositHold[] = Object.freeze(["halted", "not_caught_up", "vault_blocked"] as const);
/** The stages a refunded deposit's later legs can be at: the refund move's own, then where it lands. */
export const DEPOSIT_REFUNDED_STAGES: readonly DepositStage[] = Object.freeze(["refund_move", "in_transit", "into_vault", "done", "held", "halted"] as const);
/** The stages at which the money waits under an id the user can move it out of (withdraw.open's from_id). */
export const DEPOSIT_HELD_STAGES: readonly DepositStage[] = Object.freeze(["refunded", "refund_move", "held", "halted"] as const);
/**
 * What the device knows of a deposit beside its stage (card kit-deposit-calls), on the deposit op in state.ops and on
 * deposit.confirm's answer. Each only on the stages it belongs to; the kit's client drops a message that has one elsewhere:
 * - refunded: true once 1Click refunded the money to U, so the legs after it are the refund move's (DEPOSIT_REFUNDED_STAGES);
 * - hold: why a halted deposit waits, on "halted" only (a page of an earlier release sends halted without it);
 * - held_id: the id the money waits under (U, or the refund move's id), for withdraw.open's from_id (DEPOSIT_HELD_STAGES);
 * - since_ms: unix ms when the device first saw the send, the sheet's counter's zero; on every stage but quote_checked
 *   and expired, where nothing was sent;
 * - amount_usd: the USDC credited into the vault, a decimal string, on "done" only.
 * States and amounts only: never a key, the 12 words or which note is whose.
 */
export interface DepositFacts {
  refunded?: boolean;
  hold?: DepositHold;
  held_id?: string;
  since_ms?: number;
  amount_usd?: string;
}
export type WithdrawStage = "proving" | "submitted" | "in_transit" | "sent" | "refunded" | "stopped";
export type TradeStage = "signed" | "sent" | "filled" | "part_filled" | "refused" | "not_landed";
export type HopStage = "in_flight" | "arrived" | "refunded" | "fallback";
export type ReturnStage = "signed" | "sent" | "in_transit" | "into_vault" | "done";
export type RestoreStage = "started" | "reading" | "done" | "stalled";
export type Stage = DepositStage | WithdrawStage | TradeStage | HopStage | ReturnStage | RestoreStage | "queued";

/** The assets a chain's pool holds. A pool's asset comes from the device's own pool table, never from a server. */
export type PoolAsset = "SOL" | "ETH" | "USDC";
export const POOL_ASSETS: readonly PoolAsset[] = Object.freeze(["SOL", "ETH", "USDC"] as const);
/** Each pool asset's decimals: the one table. state.pools carries no decimals; an amount's 1.0 is 10^decimals here. */
export const POOL_ASSET_DECIMALS: Readonly<Record<PoolAsset, number>> = Object.freeze({ SOL: 9, ETH: 18, USDC: 6 });

export type WalletState = "PLANNED" | "ARMING" | "READY" | "IN_POSITION" | "RETURNING" | "EMPTY";
export type OrderState = "SIGNED" | "ARMED" | "FILLED" | "CANCELLED" | "DEAD";

/**
 * One request's operation in state.ops, by its id: the id of the request that started it. A deposit's op id is its
 * deposit.quote request's id (card kit-deposit-calls): the app finds the deposit it asked for in state.ops under the id
 * it sent, and a retry, which reuses the id, names the same op. The client drops an op it cannot read and keeps the
 * rest of the state (card kit-frame-version; kit-v1.4 and earlier refuse the whole state for one such op).
 */
export type Operation =
  | ({ id: string; kind: "deposit"; stage: DepositStage; txs: TxRef[] } & DepositFacts)
  | { id: string; kind: "withdraw"; stage: WithdrawStage; txs: TxRef[] }
  | { id: string; kind: "buy" | "sell"; stage: TradeStage; txs: TxRef[]; code?: ErrorCode }
  | { id: string; kind: "hop"; stage: HopStage; txs: TxRef[] }
  | { id: string; kind: "return"; stage: ReturnStage; txs: TxRef[] }
  | { id: string; kind: "restore"; stage: RestoreStage; txs: TxRef[] };

/** A pool asset's USD price in SignpageState.pools, as the signing page read it (card signpage-pool-price). */
export type PoolStatePrice = { price: string; expo: number; published_s: number; read_ms: number };

/** What the page tells the app: addresses, balances, tx hashes and states only. */
export interface SignpageState {
  /** The signing page's release tag. */
  release: string;
  api: 1;
  signed_in: boolean;
  way?: SigninWay;
  /** False while the 12 words are the only copy and not saved: the backup comes before the first deposit. */
  code_saved: boolean;
  /** The last way in that failed on SIGN_HOST, and why (for example "no_prf", "no_passkey"). */
  signin_failed?: { way: SigninWay; reason: string };
  /** USDC in the vault. */
  vault_balance: string;
  /**
   * The private balance held in each chain's pool, read from the device's own notes (never from a server): one entry
   * per chain, each amount a decimal string in whole units of the pool's asset, as vault_balance is for USDC (12.5 SOL
   * is "12.5"). `asset` is the pool's, set by the device from the pool's kind; its decimals are POOL_ASSET_DECIMALS's
   * alone. `ready` is how much of it is ready to buy (chunks with a proof ready); absent while no proof
   * queue runs, never "0" in its place. `tap_max` is the most one tap can spend on the chain, in the same whole units:
   * a tap spends one ready proof, so it is the largest spend among the ready proofs, never their sum: the chunk less
   * what comes out of it before the venue (Solana: the relay fee, the tip and W's new accounts on the costliest venue,
   * the kit's solanaPoolBuyMaxSpend; EVM: nothing, since an EVM tap asks for a whole chunk and the signing page refuses
   * any other amount, rules/pool.ts checkEvmBuy). At most `ready`, never below "0". It
   * comes only with `ready`, and a page of an earlier release, or one that cannot price a pool, sends `ready` without it.
   * Absent when the page is signed out or the notes could not be read. Totals
   * only, never a note; the app sees them each time the store changes, so two in a row can show one note's value.
   *
   * `price` (card signpage-pool-price) is the pool asset's USD price as this page read it itself, the kit's poolUsdPrice
   * on two RPCs of two providers that agreed: one asset is `price` x 10^`expo` USD (`price` a positive integer string),
   * `published_s` the feed's own time (unix s) and `read_ms` the device's clock at the read. Absent on NEAR, on a chain
   * the page could not price, and once the read is older than the feed's bound (POOL_USD_FEEDS maxAgeS); an app checks
   * that bound again on its own clock, since the state it holds ages.
   */
  pools?: { chain: Chain; asset: PoolAsset; balance: string; ready?: string; tap_max?: string; price?: PoolStatePrice }[];
  wallets: { chain: Chain; address: string; role: "fresh" | "hop"; size: string; state: WalletState }[];
  positions: { chain: Chain; token: string; amount: string; cost: string; wallets: string[] }[];
  orders: {
    order_id: string;
    chain: Chain;
    wallet: string;
    token: string;
    group_id: string;
    trigger: OrderTrigger;
    state: OrderState;
    /** Unix ms of the last check of its nonce. */
    last_check?: number;
  }[];
  /** Money held under a one-time id or an arming account whose arm has stopped; withdraw.open with the id moves it. */
  held: { id: string; asset: string; amount: string }[];
  /**
   * The device's deposit wallets that still hold money (card app-export-every-wallet): a deposit wallet of this seed
   * with a balance not yet moved into its chain's pool or the vault, a remainder or dust included. `asset` is the
   * chain's pool asset (POOL_ASSET_DECIMALS), `amount` its balance in whole units of it, as pools' `balance` is.
   * Addresses and amounts only. Absent from a page of an earlier release; moneyWallets names the ones above 0.
   */
  deposit_wallets?: { chain: Chain; address: string; asset: PoolAsset; amount: string }[];
  ops: Operation[];
}
