// The order record: what the device sends the order sender for each order it signs in advance (wallet.md §7 item 3,
// in the shape of markets.md H5.1; decided 2026-11-01 00:35Z). POST /v1/orders carries one group of one or two
// records. Each exit sells from the fresh wallet W, its output goes to W itself, and min_out is fixed inside the signed
// bytes, so a server that holds this record can only send the order early, at the user's price or better
// (wallet.md §2.6).

/** The chains a fresh wallet trades on. */
export type Chain = "solana" | "base" | "robinhood" | "near";

export const CHAINS = ["solana", "base", "robinhood", "near"] as const satisfies readonly Chain[];

/** What fires an order. */
export interface OrderTrigger {
  kind: "stop" | "take_profit" | "limit";
  /** The pool whose price the order sender reads. */
  pool: string;
  /** The venue (the program or contract family) that pool belongs to. */
  venue: string;
  /** "lte" fires when the price falls to `price` or below (a stop), "gte" when it rises to it or above. */
  direction: "lte" | "gte";
  /** Decimal string: the token's price, in `quote_asset` per whole token, at which the order fires. */
  price: string;
  /** The asset `price` is counted in, in the chain's own form. */
  quote_asset: string;
}

/**
 * The nonce every variant of an order and its twin share, so the first to land makes all the others invalid
 * (wallet.md §2.6). Integers are decimal strings.
 */
export interface NonceRefs {
  /** A durable nonce: the nonce account and the nonce value stored in it. */
  solana: { nonce_account: string; nonce_value: string };
  base: { wallet: string; nonce: string };
  robinhood: { wallet: string; nonce: string };
  /** The access key's nonce: nonces are per key on NEAR. */
  near: { account: string; public_key: string; nonce: string };
}

export type NonceRef = NonceRefs[Chain];

export interface OrderRecord<C extends Chain = Chain> {
  v: 1;
  /** 16 random bytes the device picks, lowercase hex. */
  order_id: string;
  /** Links an order to its twin (a stop and its take-profit): groups of 1 or 2. Same form as order_id. */
  group_id: string;
  chain: C;
  /** The fresh wallet W that signed it, in the chain's own address form. */
  wallet: string;
  /** The token sold, in the chain's own form (a base58 mint, a lowercase 0x address, a NEAR account id). */
  token: string;
  /** Integer string: the amount of the token sold, in its base units; the same in every variant. */
  amount: string;
  /** Integer string: the least the sell pays W, in the native coin's base units; the same in every variant's bytes. */
  min_out: string;
  trigger: OrderTrigger;
  nonce_ref: NonceRefs[C];
  /**
   * 1 to 3 signed variants of the same sell at rising fees, all on `nonce_ref`, so only one can land: base64 of the
   * signed transaction (Solana, EVM) or the signed NEP-366 delegate (NEAR), byte for byte as the device signed it.
   */
  variants: [string] | [string, string] | [string, string, string];
  /** NEAR only: the block height at which the delegates expire (their `max_block_height`). */
  expires_at?: C extends "near" ? number : never;
}

/**
 * The record's fields, exactly: a receiver refuses a record with any other field. On the wire, POST /v1/orders adds
 * only token_hash (helper/v1.ts HELPER_ORDER_FIELDS).
 */
export const ORDER_RECORD_FIELDS = [
  "v",
  "order_id",
  "group_id",
  "chain",
  "wallet",
  "token",
  "amount",
  "min_out",
  "trigger",
  "nonce_ref",
  "variants",
  "expires_at",
] as const satisfies readonly (keyof OrderRecord)[];

/** At most this many signed variants per order. */
export const ORDER_VARIANTS_MAX = 3;
