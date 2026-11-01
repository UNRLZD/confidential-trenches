// The order record: what the device sends the order sender for each order it signs in advance (wallet.md §7 item 3).
// Each exit sells from the fresh wallet W, its output goes to W itself, and min_out is fixed inside the signed bytes,
// so a server that holds this record can only send the order early, at the user's price or better (wallet.md §2.6).

/** The chains a fresh wallet trades on. */
export type Chain = "solana" | "base" | "robinhood" | "near";

export const CHAINS = ["solana", "base", "robinhood", "near"] as const satisfies readonly Chain[];

export interface OrderRecord {
  v: 1;
  /** Random id the device picks for this order. */
  order_id: string;
  chain: Chain;
  /** The fresh wallet W that signed it, in the chain's own address form. */
  wallet: string;
  /** The token sold, in the chain's own form (a base58 mint, a lowercase 0x address, a NEAR account id). */
  token: string;
  /** The pool whose price fires the order. */
  pool: string;
  /** "tp" take-profit, "sl" stop. */
  side: "tp" | "sl";
  /** Decimal string: the token's price, in the chain's native coin per whole token, at which the order fires. */
  trigger_price: string;
  /** Integer string: the amount of the token sold, in its base units. */
  amount: string;
  /** Integer string: the least the sell pays W, in the native coin's base units; the same value is in `bytes`. */
  min_out: string;
  /**
   * The nonce the twins share, so the first to land cancels the other: Solana `<nonce account>/<nonce value>`, EVM
   * `<wallet>/<nonce>`, NEAR `<account>/<public key>/<nonce>`.
   */
  nonce_ref: string;
  /** The order_id of its twin (the stop of a take-profit, and back). */
  twin_id: string;
  /** Base64 of the signed transaction (Solana, EVM) or the signed NEP-366 delegate (NEAR). */
  bytes: string;
}

/** The record's fields, exactly: a receiver refuses a record with any other field. */
export const ORDER_RECORD_FIELDS = [
  "v",
  "order_id",
  "chain",
  "wallet",
  "token",
  "pool",
  "side",
  "trigger_price",
  "amount",
  "min_out",
  "nonce_ref",
  "twin_id",
  "bytes",
] as const satisfies readonly (keyof OrderRecord)[];

// Compile-time: the field list and the interface name the same thirteen fields.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _OrderRecordFieldsMatch = Assert<Same<keyof OrderRecord, (typeof ORDER_RECORD_FIELDS)[number]>>;
