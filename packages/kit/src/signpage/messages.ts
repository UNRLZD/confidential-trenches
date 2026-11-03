// The signing page's postMessage API (wallet.md §7 item 4; app.md §2.1 A2-A4). The app talks to SIGN_HOST's hidden
// iframe only with these messages, the origin checked both ways. Every request kind has its wallet.md §2.8 row; the
// page refuses a kind with no row, a field its row does not allow, and a `v` other than 1. Answers and events carry
// addresses, balances, tx hashes and states only: never a key, the 12 words, a note secret or a signed-but-unsent
// payload (wallet.md §2.9 row 11).
//
// Every amount is a decimal string. A request's `id` is crypto.randomUUID(); a retry reuses it, and the page answers a
// repeated id with its first answer, never a second run, so a timeout and a retry can never buy twice.

import type { Chain, OrderTrigger } from "../orders/record.ts";

/** The seventeen request kinds, app to page. The last two, nav and reload, are to SIGN_HOST's shell (card signpage-shell). */
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
] as const;

export type SignpageKind = (typeof SIGNPAGE_KINDS)[number];

/** The kinds that open a SIGN_HOST top-level screen: the app posts one, then moves the same tab to SIGN_HOST. */
export const OPEN_KINDS = ["withdraw.open", "signin.open", "backup.open", "export.open", "signout"] as const satisfies readonly SignpageKind[];

/** The events, page to app. */
export const SIGNPAGE_EVENTS = ["ready", "state", "progress"] as const;

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
  /** Ask a deposit address for money from outside: the 1Click asset id the user sends, and how much of it. */
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
  "deposit.confirm": { stage: DepositStage };
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
}

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

/** Posted on every change of the state. */
export interface StateEvent {
  v: 1;
  type: "state";
  state: SignpageState;
}

/** The stage of a request still running, by its id. */
export interface ProgressEvent {
  v: 1;
  type: "progress";
  id: string;
  stage: Stage;
}

export type SignpageEvent = ReadyEvent | StateEvent | ProgressEvent;

/** Anything the page posts to the app. */
export type SignpageMessage = SignpageAnswer | SignpageEvent;

export type DepositStage = "quote_checked" | "waiting" | "in_transit" | "into_vault" | "done" | "refunded" | "held" | "halted";
export type WithdrawStage = "proving" | "submitted" | "in_transit" | "sent" | "refunded" | "stopped";
export type TradeStage = "signed" | "sent" | "filled" | "part_filled" | "refused" | "not_landed";
export type HopStage = "in_flight" | "arrived" | "refunded" | "fallback";
export type ReturnStage = "signed" | "sent" | "in_transit" | "into_vault" | "done";
export type RestoreStage = "started" | "reading" | "done" | "stalled";
export type Stage = DepositStage | WithdrawStage | TradeStage | HopStage | ReturnStage | RestoreStage | "queued";

export type WalletState = "PLANNED" | "ARMING" | "READY" | "IN_POSITION" | "RETURNING" | "EMPTY";
export type OrderState = "SIGNED" | "ARMED" | "FILLED" | "CANCELLED" | "DEAD";

export type Operation =
  | { id: string; kind: "deposit"; stage: DepositStage; txs: TxRef[] }
  | { id: string; kind: "withdraw"; stage: WithdrawStage; txs: TxRef[] }
  | { id: string; kind: "buy" | "sell"; stage: TradeStage; txs: TxRef[]; code?: ErrorCode }
  | { id: string; kind: "hop"; stage: HopStage; txs: TxRef[] }
  | { id: string; kind: "return"; stage: ReturnStage; txs: TxRef[] }
  | { id: string; kind: "restore"; stage: RestoreStage; txs: TxRef[] };

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
   * per chain, each amount a decimal string in whole units of the pool's asset, as vault_balance is for USDC. `ready` is how much of it is ready to buy (chunks with a proof ready); absent while no proof
   * queue runs, never "0" in its place. Absent when the page is signed out or the notes could not be read.
   */
  pools?: { chain: Chain; balance: string; ready?: string }[];
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
  ops: Operation[];
}
