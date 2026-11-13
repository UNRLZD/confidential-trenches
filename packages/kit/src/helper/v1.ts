// The helper API /v1, frozen with the kit on Nov 1 06:00Z: every path of markets.md H7 with its 7.1 changes
// (research main 3dbe87c). It is what the kit, the signing page and any outside wallet, terminal or bot call on a
// helper: ours, or their own copy of it.
// Types and constants only. It imports only the kit's own order record (Chain, OrderRecord and ORDER_RECORD_FIELDS,
// never redefined here) and the kit's deepFreeze, and signs nothing; a helper holds API keys, never a money key, and can only carry what the device signed. Nothing a
// helper answers is trusted for anything signed: the device checks every answer against its own request and its own
// chain reads before it signs.
// Wire rules: JSON bodies; a signed transaction or delegate in standard base64; an intent's public key and signature
// as ed25519:<base58> (intents.near's raw_ed25519 form, HelperSignedIntent); no cookies; the kit calls with HELPER_FETCH_INIT; every
// answer carries X-Helper-Commit. An error is { error: { code } } with the HTTP status of HELPER_CODE_STATUS (400 for
// a code not listed there). Limits are design values (H7: "Limits are [design]").

import { ORDER_RECORD_FIELDS, type Chain, type OrderRecord } from "../orders/record.ts";
import { deepFreeze } from "../freeze.ts";

// ---------------------------------------------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------------------------------------------

export const HELPER_V1_PREFIX = "/v1";

/** On every answer, errors included: the helper's own commit. */
export const HELPER_COMMIT_HEADER = "X-Helper-Commit";
/** On every /v1/proxy answer: the vendor it came from, and when the helper read it. */
export const HELPER_SOURCE_HEADER = "X-Helper-Source";
export const HELPER_FETCHED_AT_HEADER = "X-Fetched-At";

/** The kit's fetch settings for every helper call. */
export const HELPER_FETCH_INIT = { credentials: "omit", referrerPolicy: "no-referrer" } as const;
deepFreeze(HELPER_FETCH_INIT);

/**
 * Cross-origin reads (H7 "Cross-origin reads", 7.1 row "every path, and the push socket"). Access-Control-Allow-Origin
 * is the request's Origin only when it equals one of `origins` byte for byte (scheme, host and port), and absent for
 * any other, null included; never "*". It and Vary: Origin are on every answer, errors included.
 * Access-Control-Allow-Credentials is never sent, on any answer (`allowCredentialsHeader: "absent"`; markets.md:3300). A preflight (OPTIONS with Access-Control-Request-Method) from one of `origins`
 * answers 204 with exactly `allowMethods`, `allowHeaders` and `maxAgeSeconds`; one asking any other header, or from any
 * other origin, gets no allow headers. The push socket checks Origin on the upgrade: one of `origins` passes, any other
 * gets 403, and an upgrade with no Origin (not a browser) passes. A call with no Origin (a server or a bot) is answered
 * as any other.
 * `origins` are this release's APP_HOST and SIGN_HOST; a helper run by someone else lists its own two.
 */
export const HELPER_CORS = {
  origins: ["https://ct-app.unrealized.trade", "https://confidential.unrealized.trade"],
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["content-type"],
  // Retry-After: a device reads a 429's wait cross-origin (card wallet-per-buy, M367)
  exposeHeaders: ["X-Helper-Commit", "X-Helper-Source", "X-Fetched-At", "Retry-After"],
  maxAgeSeconds: 600,
  vary: "Origin",
  allowCredentialsHeader: "absent",
} as const;
deepFreeze(HELPER_CORS);

/** Standard base64 of bytes the device signed; a helper carries them byte for byte. */
export type HelperBase64 = string;
/** A non-negative integer as a canonical decimal string (no sign, no leading zero): u128 and U256 amounts. */
export type HelperDecimal = string;
/** A NEAR account id. */
export type HelperNearAccount = string;
/** A NEAR public key: "ed25519:" and the 32-byte key in base58. */
export type HelperNearPublicKey = `ed25519:${string}`;
/** An ed25519 signature: "ed25519:" and the 64 bytes in base58 (never base64). */
export type HelperEd25519Signature = `ed25519:${string}`;
/** A transaction id in its chain's form. */
export type HelperTxHash = string;

/** The parts of /v1/health, one per value of H7's Part column (7.1 row "GET /v1/health parts"). */
export const HELPER_PARTS = ["proxy", "relay", "intents", "delegate", "orders", "log"] as const;
deepFreeze(HELPER_PARTS);
export type HelperPart = (typeof HELPER_PARTS)[number];

/** Codes any path can answer: a vendor or RPC down (H2.3), a body over its limit, a full bucket (H2.2), no such thing. */
export const HELPER_COMMON_CODES = ["upstream", "too_large", "rate_limited", "not_found"] as const;
deepFreeze(HELPER_COMMON_CODES);
export type HelperCommonCode = (typeof HELPER_COMMON_CODES)[number];

export interface HelperError<C extends string> {
  error: { code: C | HelperCommonCode };
}
export type HelperAnswer<T, C extends string> = T | HelperError<C>;

/** The HTTP status of each code that does not answer 400. */
export const HELPER_CODE_STATUS = {
  not_found: 404,
  token_not_watched: 404,
  too_large: 413,
  rate_limited: 429,
  id_not_ours: 403,
  sender_struck: 403,
  receiver_is_vault: 403,
  prepay_open: 409,
  not_paid: 409,
  no_payout: 409,
  wallet_created: 409,
  wallet_exists: 409,
  not_registered: 409,
  already_registered: 409,
  token_mismatch: 409,
  replayed: 409,
  trade_used: 409,
  carry_failed: 502,
  receiver_not_registered: 409,
  upstream: 503,
  token_halted: 503,
  index_behind: 503,
  relayer_low: 503,
  // POST /v1/pool/solana/pieces: a buy's pieces signed by two wallets (card buy-spends-several-pieces)
  wallets_differ: 422,
} as const;
deepFreeze(HELPER_CODE_STATUS);

// ---------------------------------------------------------------------------------------------------------------
// The paths (H7's table and 7.1's new rows), with their part and body limit in bytes
// ---------------------------------------------------------------------------------------------------------------

export const HELPER_V1_PATHS = [
  { method: "GET", path: "/v1/health", part: "all", limitBytes: 1024 },
  { method: "POST", path: "/v1/proxy/{vendor}/{path}", part: "proxy", limitBytes: 65536 },
  { method: "POST", path: "/v1/rpc/{chain}", part: "proxy", limitBytes: 262144 },
  { method: "GET", path: "/v1/market/...", part: "proxy", limitBytes: null },
  { method: "GET", path: "/v1/logo/{chain}/{token}", part: "proxy", limitBytes: 262144 },
  { method: "GET", path: "/v1/token-status", part: "relay", limitBytes: 1024 },
  { method: "GET", path: "/v1/withdraw/fee", part: "relay", limitBytes: 1024 },
  { method: "POST", path: "/v1/withdraw", part: "relay", limitBytes: 8192 },
  { method: "GET", path: "/v1/withdraw/{tx_hash}", part: "relay", limitBytes: 1024 },
  // the pool relayers (card helper-pool-senders, apps/helper/src/pool/): the epoch's fee, then a pool release or buy
  // the device signed, carried as is (POOL_SOLANA_BODY_MAX and POOL_EVM_BODY_MAX, 4 KB each)
  // POST /v1/pool/solana/send on mainnet answers a tag 3 only once its send is decided (the fill, or not_landed), so
  // the device's fetch for it waits longer than a blockhash lives (150 blocks; SOLANA_POOL_SEND_MARGIN_MS, 90 s, is
  // longer), never a short timeout
  { method: "GET", path: "/v1/pool/fee", part: "relay", limitBytes: 1024 },
  { method: "POST", path: "/v1/pool/solana/send", part: "relay", limitBytes: 4096 },
  // a buy made of several pieces (card buy-spends-several-pieces): every tag 2, then the tag 3, all of one W; the tag 2s
  // sent plain, then the tag 3 as one send is (card owners-solana-buy-lands), so a tag 2 can land without the buy and
  // its money waits in W; on mainnet answered, like a tag 3, only once the fill is decided
  // (POOL_SOLANA_PIECES_BODY_MAX, 8 KB)
  { method: "POST", path: "/v1/pool/solana/pieces", part: "relay", limitBytes: 8192 },
  { method: "POST", path: "/v1/pool/evm/send", part: "relay", limitBytes: 4096 },
  // W's sell back into its pool (card helper-evm-sender): the sell calldata and W's 7702 authorization (POOL_EVM_SELL_BODY_MAX, 8 KB)
  { method: "POST", path: "/v1/pool/evm/sell", part: "relay", limitBytes: 8192 },
  { method: "POST", path: "/v1/bind", part: "delegate", limitBytes: 4096 },
  // a restoring device's read of its NEAR trade wallets' carried calls (card near-holdings-restore): at most
  // HELPER_BIND_RECORD_WALLETS_MAX (64) wallets, about 4.3 KB
  { method: "POST", path: "/v1/bind/record", part: "delegate", limitBytes: 8192 },
  { method: "POST", path: "/v1/intents", part: "intents", limitBytes: 8192 },
  { method: "POST", path: "/v1/orders", part: "orders", limitBytes: 65536 },
  { method: "POST", path: "/v1/orders/status", part: "orders", limitBytes: 16384 },
  { method: "PUT", path: "/v1/orders/{order_id}", part: "orders", limitBytes: 32768 },
  { method: "DELETE", path: "/v1/orders/{order_id}", part: "orders", limitBytes: 1024 },
  { method: "POST", path: "/v1/log", part: "log", limitBytes: 4096 },
] as const;
deepFreeze(HELPER_V1_PATHS);
export type HelperV1Path = (typeof HELPER_V1_PATHS)[number];

// ---------------------------------------------------------------------------------------------------------------
// GET /v1/health
// ---------------------------------------------------------------------------------------------------------------

/** "down" until the part's own card lands, or while it cannot serve. */
export type HelperPartState = "up" | "down";

export interface HelperHealthAnswer {
  ok: boolean;
  commit: string;
  /** `delegate` is POST /v1/bind, the onward delegates into intents.near and the plain moves out included. */
  parts: Record<HelperPart, HelperPartState>;
}

// ---------------------------------------------------------------------------------------------------------------
// POST /v1/proxy/{vendor}/{path}
// ---------------------------------------------------------------------------------------------------------------

/** Each vendor has a fixed base URL and a path allowlist on the helper; the proxy is never an open proxy. */
export const HELPER_PROXY_VENDORS = ["jupiter", "relay", "lifi", "oneclick"] as const;
deepFreeze(HELPER_PROXY_VENDORS);
export type HelperProxyVendor = (typeof HELPER_PROXY_VENDORS)[number];

/**
 * The body of POST /v1/proxy/relay/quote/v2 (7.1): the device's own request, passed through unchanged, and it must
 * carry includeProtocolData: true. The helper never edits it; the device runs its own order check on the answer.
 */
export type HelperRelayQuoteV2Body = { includeProtocolData: true } & Record<string, unknown>;

/** The vendor's own body, passed through, with X-Helper-Source and X-Fetched-At. */
export type HelperProxyAnswer = unknown;
/** path_not_allowed: the path is not on that vendor's allowlist. */
export type HelperProxyCode = "path_not_allowed";

// ---------------------------------------------------------------------------------------------------------------
// POST /v1/rpc/{chain}
// ---------------------------------------------------------------------------------------------------------------

/** The one getBlock config the Solana routes forward (card buy-spends-several-pieces): a block's header at finalized,
 *  no transactions, signatures or rewards. The signing page's found W rule reads it (pool-sell.ts foundQuiet) and the
 *  helper forwards getBlock only with exactly this (apps/helper/src/rpc/rpc.ts blockHeaderAllowed), from this one
 *  object, so the two never drift apart. */
export const HELPER_SOLANA_BLOCK_HEADER = Object.freeze({ commitment: "finalized", encoding: "json", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 } as const);

/** The method allowlist per chain (H7 with 7.1's second-provider reads). Base and Robinhood are EVM. */
export const HELPER_RPC_METHODS = {
  solana: [
    "getAccountInfo",
    "getMultipleAccounts",
    "getBalance",
    "getTokenAccountsByOwner",
    "getTokenLargestAccounts",
    "getLatestBlockhash",
    "simulateTransaction",
    "sendTransaction",
    "getSignatureStatuses",
    "getTransaction",
    "getBlockHeight",
    "getMinimumBalanceForRentExemption",
    // the set send's dead check (trade/solana/send.ts): is the tx's blockhash still valid at processed
    "isBlockhashValid",
    // the signing page's pool path, whose second provider is this route (card pool-buy-send-fast; signpage
    // test/page-rpc.test.ts reads every Solana method that path names and fails on one off this list): the finalized
    // slot (pool-buy.ts whose spend, pool-withdraw.ts), W's history (pool-spend.ts), a transaction's fee
    // (pool-deposit.ts, pool-sell.ts, pool-withdraw.ts, wallet pool/solana.ts), a block's time (the deadline settle),
    // the finalized height and slot in one read (pool-sell.ts)
    "getSlot",
    "getSignaturesForAddress",
    "getFeeForMessage",
    "getBlockTime",
    "getEpochInfo",
    // a found W's sweep (signpage pool-sell.ts foundQuiet, card buy-spends-several-pieces): the finalized height of the
    // block W's latest transaction is in. The helper forwards it only as a header read (apps/helper/src/rpc/rpc.ts
    // blockHeaderAllowed: transactionDetails none, no rewards, finalized), never a block's transactions
    "getBlock",
    // a note restore's scan of the pool program (wallet pool/solana-restore.ts, memcmp-filtered). The heaviest read on
    // the list: the helper forwards it only on its own pinned pool program with a dataSize and a memcmp filter (review
    // L-2, apps/helper/src/rpc/rpc.ts scanAllowed), within the caller's share (16 per 10 s), the per-method budget, the
    // provider's pace and its 4 MB answer (RPC_ANSWER_MAX: an answer over it is refused, never passed on)
    "getProgramAccounts",
  ],
  base: [
    "eth_call",
    "eth_simulateV1",
    "eth_getTransactionCount",
    "eth_getBalance",
    "eth_feeHistory",
    "eth_blockNumber",
    "eth_sendRawTransaction",
    "eth_getTransactionReceipt",
    "eth_getLogs",
    "eth_estimateGas",
    "eth_getBlockByNumber",
    "eth_getTransactionByHash",
  ],
  robinhood: [
    "eth_call",
    "eth_simulateV1",
    "eth_getTransactionCount",
    "eth_getBalance",
    "eth_feeHistory",
    "eth_blockNumber",
    "eth_sendRawTransaction",
    "eth_getTransactionReceipt",
    "eth_getLogs",
    "eth_estimateGas",
    "eth_getBlockByNumber",
    "eth_getTransactionByHash",
  ],
  near: ["query", "block", "gas_price", "tx", "send_tx", "EXPERIMENTAL_tx_status", "EXPERIMENTAL_protocol_config"],
} as const satisfies Record<Chain, readonly string[]>;
deepFreeze(HELPER_RPC_METHODS);

export const HELPER_RPC_BATCH_MAX = 10;

export interface HelperJsonRpcRequest<C extends Chain = Chain> {
  jsonrpc: "2.0";
  id: number | string;
  method: (typeof HELPER_RPC_METHODS)[C][number];
  params?: unknown;
}
/** One request, or a batch of 1 to HELPER_RPC_BATCH_MAX. */
export type HelperRpcRequest<C extends Chain = Chain> = HelperJsonRpcRequest<C> | HelperJsonRpcRequest<C>[];
/** The provider's JSON-RPC answer, passed through. */
export type HelperRpcAnswer = unknown;
/** method_not_allowed: a method off the chain's allowlist, in any request of a batch. */
export type HelperRpcCode = "method_not_allowed";

// ---------------------------------------------------------------------------------------------------------------
// GET /v1/market/...
// ---------------------------------------------------------------------------------------------------------------

/** Market data per screen (D1). Its field lists are frozen with the app's screens, since they feed no signature. */
export type HelperMarketAnswer = unknown;

// ---------------------------------------------------------------------------------------------------------------
// GET /v1/logo/{chain}/{token}
// ---------------------------------------------------------------------------------------------------------------

/**
 * `token` is the token's id in its chain's form: a base58 mint, a lowercase 0x address, a NEAR account id; anything
 * else answers 404. The caller never names a URL. The answer is the image bytes with the type its magic bytes showed,
 * X-Content-Type-Options: nosniff, Content-Security-Policy: default-src 'none'; sandbox, and
 * Cache-Control: public, max-age=86400; 204 with no body when the token has no logo that passed the checks (SVG is
 * refused), and the app shows its own (a 204 is no failed load in the browser, a 404 is).
 */
export const HELPER_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
deepFreeze(HELPER_LOGO_TYPES);
export type HelperLogoType = (typeof HELPER_LOGO_TYPES)[number];
export const HELPER_LOGO_MAX_BYTES = 262144;

// ---------------------------------------------------------------------------------------------------------------
// GET /v1/token-status?token=<id>
// ---------------------------------------------------------------------------------------------------------------

/**
 * The helper's own watch of the release's USDC. Display only: no move into the vault rests on it, and the relayer's
 * own checks are what hold a move. While `caught_up` is false, `halted`, `vault_blocked` and `code_hash_ok` are null.
 */
export interface HelperTokenStatusAnswer {
  token: HelperNearAccount;
  caught_up: boolean;
  halted: boolean | null;
  vault_blocked: boolean | null;
  code_hash_ok: boolean | null;
  code_hash: string;
  block_height: number;
  last_event: { name: "paused" | "unpaused" | "blocklist" | "unblocklist"; block_height: number; receipt_id: string } | null;
}
/** token_not_watched (404): any token but the release's USDC. */
export type HelperTokenStatusCode = "token_not_watched";

// ---------------------------------------------------------------------------------------------------------------
// GET /v1/withdraw/fee?token=<id>
// ---------------------------------------------------------------------------------------------------------------

/**
 * The relayer's quote: the absolute relay_fee in the token's base units, quoted at fee_min (7.1, LD5). The device
 * binds it in the proof's context and refuses relay_fee > its own fee_max, from its own reads; gp, px and g_w are the
 * inputs the relayer priced it at, shown, never used for the bound.
 * relayer_account and fee_recipient are display only (HELPER_FEE_ANSWER_DISPLAY_ONLY): the device never copies them.
 */
export interface HelperWithdrawFeeAnswer {
  /** Display only. */
  relayer_account: HelperNearAccount;
  /** Display only. */
  fee_recipient: HelperNearAccount;
  relay_fee: HelperDecimal;
  gp: HelperDecimal;
  px: string;
  g_w: HelperDecimal;
  valid_until_block: number;
}

/**
 * The fee answer's fields the device never copies. It puts in the withdrawal's fee_recipient the relayer account
 * written in the release (HelperReleaseRelayer; wallet.md:899), and refuses a fee answer whose relayer_account or
 * fee_recipient differs from the release's, byte for byte.
 */
export const HELPER_FEE_ANSWER_DISPLAY_ONLY = ["relayer_account", "fee_recipient"] as const;
deepFreeze(HELPER_FEE_ANSWER_DISPLAY_ONLY);

/** The release's own relayer, written in the release and never read from a helper: what the device checks against. */
export interface HelperReleaseRelayer {
  readonly relayer_account: HelperNearAccount;
  readonly fee_recipient: HelperNearAccount;
}

// ---------------------------------------------------------------------------------------------------------------
// POST /v1/withdraw, GET /v1/withdraw/{tx_hash}
// ---------------------------------------------------------------------------------------------------------------

/**
 * The vault's withdrawal, which names no processor: the vault binds itself inside context. relay_fee and
 * register_deposit are u128 decimals, refund_precommitment a canonical U256 decimal, deadline_ms the vault's block
 * time in ms, and salt 16 fresh random bytes as exactly 32 lowercase hex characters with no 0x.
 */
/** The withdrawal's salt: 16 fresh random bytes as exactly 32 lowercase hex characters, no 0x (vault.md:360). */
export const HELPER_SALT_PATTERN = /^[0-9a-f]{32}$/;
deepFreeze(HELPER_SALT_PATTERN);

export interface HelperWithdrawal {
  recipient: HelperNearAccount;
  register_deposit: HelperDecimal;
  fee_recipient: HelperNearAccount;
  relay_fee: HelperDecimal;
  refund_precommitment: HelperDecimal;
  deadline_ms: number;
  salt: string;
}

/** snarkjs's decimal strings. */
export interface HelperGroth16Proof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

export interface HelperWithdrawRequest {
  withdrawal: HelperWithdrawal;
  proof: HelperGroth16Proof;
  /** The 8 decimals in snarkjs order. */
  public_signals: [string, string, string, string, string, string, string, string];
  /**
   * true when the recipient is an arming account A, which the relayer funds first when it has no account (H3.7 item
   * 1); false when the vault pays the NEAR account the user typed straight (card wallet-withdraw-move-out).
   */
  fund_recipient: boolean;
  token: HelperNearAccount;
}

export interface HelperWithdrawAnswer {
  tx_hash: HelperTxHash;
  state: "submitted";
}

/** In H3.4's order. */
export const HELPER_WITHDRAW_CODES = [
  "bad_shape",
  "bad_proof",
  "bad_fee_recipient",
  "fee_too_low",
  "fee_above_cap",
  "spent",
  "unknown_root",
  "index_behind",
  "in_flight",
  "withdraw_failed",
  "recipient_refused",
  "register_deposit_wrong",
  "bad_recipient",
  "deadline_too_close",
  "token_halted",
  "fund_recipient_wrong",
  "relayer_low",
] as const;
deepFreeze(HELPER_WITHDRAW_CODES);
export type HelperWithdrawCode = (typeof HELPER_WITHDRAW_CODES)[number];

/** The device re-reads the transaction on its own RPC; this is a hint. */
export interface HelperWithdrawStatusAnswer {
  state: "submitted" | "final" | "failed";
  block: number | null;
  receipts_ok: boolean | null;
}

// ---------------------------------------------------------------------------------------------------------------
// POST /v1/bind
// ---------------------------------------------------------------------------------------------------------------

/** The body: one NEP-366 SignedDelegateAction (V1), borsh, in base64, at most 4 KB. */
export interface HelperBindRequest {
  signed_delegate: HelperBase64;
}

export interface HelperBindAnswer {
  tx_hash: HelperTxHash;
}

/** The decoded view of what signed_delegate carries, as the helper reads it. */
export interface HelperDelegateAction<A> {
  sender_id: HelperNearAccount;
  receiver_id: HelperNearAccount;
  /** Exactly one action. */
  actions: [A];
  nonce: number;
  max_block_height: number;
  public_key: HelperNearPublicKey;
}

/** A FunctionCall action, its args decoded from JSON. deposit is 1 yocto for every token call here. */
export interface HelperFunctionCall<M extends string, Args> {
  FunctionCall: { method_name: M; args: Args; gas: number; deposit: "1" };
}

export interface HelperFtTransferCallArgs {
  receiver_id: HelperNearAccount;
  amount: HelperDecimal;
  msg: string;
}

export interface HelperFtTransferArgs {
  receiver_id: HelperNearAccount;
  amount: HelperDecimal;
}

/**
 * The deposit delegate of an id (U, R or V; wallet-followup item 12), and A's move back to the vault (WM-11):
 * TOKEN.ft_transfer_call(vault, amount, msg), msg = {precommitment P, depositor}. receiver_id is the token. The
 * relayer runs H4.3's checks and R1-R7, sends storage_prepay for P and, once its receipt shows SuccessValue, the
 * delegate, both from bind.<ours>.near.
 */
export type HelperBindDeposit = HelperDelegateAction<HelperFunctionCall<"ft_transfer_call", HelperFtTransferCallArgs>>;

/** The onward delegate's receiver_id, always (wallet.md:901). */
export const HELPER_ONWARD_RECEIVER = "intents.near";

/** An onward delegate's arguments: receiver_id is intents.near, msg the deposit address of a quote our helper made. */
export interface HelperOnwardArgs {
  receiver_id: typeof HELPER_ONWARD_RECEIVER;
  amount: HelperDecimal;
  msg: string;
}

/**
 * An onward delegate of A, U, R or V into intents.near: one ft_transfer_call whose receiver_id is intents.near and
 * whose msg is the deposit address of a 1Click quote our helper made. Wrapped by relay.<ours>.near (H3.7 item 2).
 */
export type HelperBindOnward = HelperDelegateAction<HelperFunctionCall<"ft_transfer_call", HelperOnwardArgs>>;

/**
 * A plain move out of A, U, R or V to a typed NEAR account: one ft_transfer of the sender's whole USDC (less one base
 * unit for an id). The receiver is never the vault, intents.near or an account of ours, and must exist on two RPCs; an
 * unregistered one is registered once per sender by the relayer. Wrapped by relay.<ours>.near (H3.7 item 2).
 */
export type HelperBindPlain = HelperDelegateAction<HelperFunctionCall<"ft_transfer", HelperFtTransferArgs>>;

/**
 * An id's clean-up once its deposit is in the vault: receiver_id = sender_id and one DeleteAccount whose
 * beneficiary_id is the release's relayer account; never storage_unregister.
 */
export type HelperBindCleanup = HelperDelegateAction<{ DeleteAccount: { beneficiary_id: HelperNearAccount } }>;

/** Every shape /v1/bind carries. Anything else, a NEP-413 signed message alone included, is bad_shape. */
export type HelperBindDelegate = HelperBindDeposit | HelperBindOnward | HelperBindPlain | HelperBindCleanup;

/**
 * The beta cap per deposit, $1,000 in USDC base units (6 decimals): the device does not sign a deposit above it and the
 * relayer answers amount_above_cap. It is kept in the kit and the relayer only; the vault takes any amount.
 */
export const HELPER_BIND_DEPOSIT_CAP = 1_000_000_000n;

/**
 * The longest POST /v1/bind takes to answer, in ms. The helper answers within it: a carry still running at it answers
 * in_flight and goes on to its own end, as it does when the client closes. The device waits this long plus the
 * request's way there and back, so it hears every answer given in time (a tx_hash, written with the call, and every
 * refusal, acted on at once); a send with no answer by then is unsure, and the device reads the deposits pages again.
 * A deposit's carry is two transactions read at final, the prepay and the delegate: a testnet deposit took 19.4 s from
 * the signed call to the pages. 45 s is 2.3 times that, and well inside the call's own window of 120 blocks. With the
 * device's 5 s for the way there and back, its whole wait is 50 s, under the 60 s at which browsers and proxies often
 * cut a long request, so the device hears the helper's own in_flight rather than a broken connection.
 */
export const HELPER_BIND_ANSWER_MS = 45_000;

/**
 * A deposit delegate's codes, in H4.3's order. Not failures: prepay_open (the device waits until the deposits pages
 * hold the previous P) and resign_needed (the device signs again). sender_struck is final for that id.
 * amount_above_cap: the amount is over HELPER_BIND_DEPOSIT_CAP.
 */
export const HELPER_BIND_DEPOSIT_CODES = [
  "bad_shape",
  "bad_signature",
  "no_account",
  "bad_key",
  "bad_nonce",
  "sender_struck",
  "expired",
  "resign_needed",
  "not_one_action",
  "not_ft_transfer_call",
  "token_not_accepted",
  "deposit_not_1_yocto",
  "gas_too_low",
  "gas_too_high",
  "bad_receiver",
  "amount_too_low",
  "amount_above_cap",
  "amount_above_balance",
  "bad_msg",
  "p_used",
  "p_bound",
  "prepay_open",
  "in_flight",
  "token_halted",
  "relayer_low",
] as const;
deepFreeze(HELPER_BIND_DEPOSIT_CODES);

/** A clean-up delegate's codes: checks 1-4, then its own, in order. */
export const HELPER_BIND_CLEANUP_CODES = [
  "bad_shape",
  "bad_signature",
  "no_account",
  "bad_key",
  "bad_nonce",
  "expired",
  "resign_needed",
  "id_not_ours",
  "bad_shape",
  "not_deposited",
  "not_settled",
] as const;
deepFreeze(HELPER_BIND_CLEANUP_CODES);

/**
 * An onward delegate's and a plain move's codes, in H3.7 item 2's order. not_helper_quote is onward only;
 * bad_receiver, amount_not_whole, receiver_not_registered and registration_failed are plain only. Not failures:
 * not_paid (the device sends the same signed bytes again while max_block_height is ahead, never a new nonce) and
 * in_flight. sender_struck is final for that sender here: its money leaves by its own self-submitted ft_transfer.
 */
export const HELPER_BIND_ONWARD_CODES = [
  "bad_shape",
  "bad_signature",
  "no_account",
  "bad_key",
  "bad_nonce",
  "id_not_ours",
  "not_paid",
  "expired",
  "token_not_accepted",
  "deposit_not_1_yocto",
  "gas_too_high",
  "bad_msg",
  "not_helper_quote",
  "sender_struck",
  "in_flight",
  "bad_receiver",
  "amount_above_balance",
  "amount_not_whole",
  "receiver_not_registered",
  "token_halted",
  "relayer_low",
  "registration_failed",
] as const;
deepFreeze(HELPER_BIND_ONWARD_CODES);

/**
 * A trade of a fresh NEAR wallet W on Rhea classic (card relayer-near-trade): the device's own request and the quote's
 * hops and venue output (the kit's rheaQuote), which the helper runs the kit's nearSwapCheck against, never trusting
 * them for anything else. W is a 64-hex implicit id whose key exists only on the device.
 */
export interface HelperNearTrade {
  network: "mainnet" | "testnet";
  side: "buy" | "sell";
  /** The NEAR token bought or sold against the network's USDC. */
  token: HelperNearAccount;
  /** W, 64 lowercase hex. */
  wallet: string;
  /** What leaves W: USDC units on a buy, the token's on a sell. */
  amount_in: HelperDecimal;
  /** The user's slippage on what the exchange pays, 1 to 9,999 bps. */
  slippage_bps: number;
  /** What the quote's last hop pays (RheaQuote.venueOut): the floor is taken from it. */
  venue_out: HelperDecimal;
  /** The quote's hops, one or two. */
  hops: { pool: number; token_in: HelperNearAccount; token_out: HelperNearAccount }[];
}

/**
 * POST /v1/bind's trade kind. With signed_delegates empty, W does not exist yet: the helper creates it with one plain
 * Transfer (HELPER_BIND_TRADE_CREATE_YOCTO plus, on a buy, the output token's storage minimum as read on two providers,
 * at most HELPER_BIND_TRADE_STORAGE_MAX), once per W ever, and only after a vault payout to W reads as landed on two
 * providers at final; the answer is that Transfer. Then the device reads W's key nonce and signs W's calls (the kit's
 * nearSwapCalls), each one FunctionCall as its own NEP-366 SignedDelegateAction, in order and with rising nonces; the
 * helper checks them all (the delegate checks and nearSwapCheck) before it sends any, then carries each in turn,
 * paying the gas, and answers every transaction. A sell's USDC goes back to the vault as a deposit delegate
 * (HelperBindDeposit) and W ends with a clean-up (HelperBindCleanup) whose beneficiary is the helper's gas account.
 */
export interface HelperBindTradeRequest {
  trade: HelperNearTrade;
  /** At most HELPER_BIND_TRADE_DELEGATES_MAX, each at most 4 KB of borsh in base64. */
  signed_delegates: HelperBase64[];
}

export interface HelperBindTradeAnswer {
  /** The helper's transactions, in order: the creation, or each carried delegate. */
  tx_hashes: HelperTxHash[];
}

/** The most delegates one trade request carries: the registration, the swap and the lost-found claim. */
export const HELPER_BIND_TRADE_DELEGATES_MAX = 3;
/**
 * What W's creation sends it, and all it sends: W's account and its one key, 182 B x 1e19 yocto, the same as one-time
 * ids (helper bind/create.ts CREATE_YOCTO). The deposits W's calls attach (the registration's storage, each call's
 * yocto) are paid by the relayer that carries them, never by W (nearcore core/primitives/src/fees.rs total_deposit).
 */
export const HELPER_BIND_TRADE_CREATE_YOCTO = 1_820_000_000_000_000_000_000n;
/** The most a registration on the output token may attach: 0.0125 NEAR, the kit's NEAR_SWAP_STORAGE_MAX (N3). */
export const HELPER_BIND_TRADE_STORAGE_MAX = 12_500_000_000_000_000_000_000n;

/**
 * The trade kind's codes, in the order the helper checks. swap_<n> is the kit's nearSwapCheck refusal of that name
 * (swap_n2: a receiver that is not the input token, the output token or the exchange). no_payout: no vault payout to
 * W reads as landed. wallet_created: W was created, or taken as it was, by this helper already (a paid W that someone
 * else's Transfer made is taken with 200 and no transaction). wallet_exists: W came to exist between the helper's
 * checks and its Transfer, so it is not sent to (ask again: it is taken as it is). storage_above_cap: the token's storage minimum is over HELPER_BIND_TRADE_STORAGE_MAX. replayed: a delegate
 * this helper carried already, in another request. trade_used: W's buy, or its sell, is carried already (one swap
 * per side per W, ever). bad_order: a registration and a swap in one request (the swap goes only once the registration
 * reads back). not_registered: the helper's own read on two providers at one block does not show W registered on the
 * output token (and on a sell the input token), so a swap is not carried. already_registered: a registration while W
 * reads registered on the token, or after one was carried for W. token_mismatch: W's first carried call named another
 * token. token_untrusted: a hop is not a Rhea pool holding its two tokens. trade_used also answers a second claim on a
 * side, and a swap after TRADE_SWAP_FAILS_MAX (3) failed swaps whose input came back to W. upstream: a provider failed
 * or the two disagreed: nothing was decided, ask again. carry_failed:
 * a carried call failed on chain; nothing after it was sent.
 */
export const HELPER_BIND_TRADE_CODES = [
  "bad_shape",
  "bad_signature",
  "bad_sender",
  "no_payout",
  "wallet_created",
  "wallet_exists",
  "storage_above_cap",
  "no_account",
  "bad_key",
  "bad_nonce",
  "expired",
  "resign_needed",
  "not_one_action",
  "bad_order",
  "not_registered",
  "already_registered",
  "token_mismatch",
  "token_untrusted",
  "swap_input",
  "swap_n1",
  "swap_n2",
  "swap_n3",
  "swap_n4",
  "swap_n7",
  "amount_above_balance",
  "replayed",
  "trade_used",
  "in_flight",
  "token_halted",
  "relayer_low",
  "carry_failed",
  "upstream",
] as const;
deepFreeze(HELPER_BIND_TRADE_CODES);

export type HelperBindCode =
  | (typeof HELPER_BIND_DEPOSIT_CODES)[number]
  | (typeof HELPER_BIND_CLEANUP_CODES)[number]
  | (typeof HELPER_BIND_ONWARD_CODES)[number]
  | (typeof HELPER_BIND_TRADE_CODES)[number];

// ---------------------------------------------------------------------------------------------------------------
// POST /v1/bind/record
// ---------------------------------------------------------------------------------------------------------------

/**
 * A device restoring from its 12 words asks for its NEAR trade wallets' records (card near-holdings-restore): for each
 * W, the token W's first carried call named and W's own calls the helper carried, so the device learns what W bought
 * from W's signed bytes and their transactions, read again on its own providers. The body is exactly these two keys;
 * `wallets` are 1 to HELPER_BIND_RECORD_WALLETS_MAX distinct 64-lowercase-hex ids. Anything else is bad_shape.
 */
export interface HelperBindRecordRequest {
  network: "mainnet" | "testnet";
  wallets: string[];
}
/** The most wallets one record request names (two requests rebuild 100). */
export const HELPER_BIND_RECORD_WALLETS_MAX = 64;
/** A carried transaction's state as the helper last read it final on two providers ("pending": not final yet). */
export type HelperBindRecordState = "pending" | "landed" | "failed" | "dropped";
/** One of W's calls the helper carried: its relayer transaction and, once its outcome is final (landed or failed), that
 *  transaction's signed bytes, which hold W's NEP-366 SignedDelegateAction. A call still pending, or dropped, carries
 *  no signed bytes (a delegate not yet on chain is never handed out): only its delegate's max_block_height, decimal,
 *  when the helper could read it. `refunded`: a failed swap whose input read back on W in full (absent otherwise). */
export interface HelperBindRecordCall {
  tx_hash: HelperTxHash;
  /** Standard base64 of the relayer's signed transaction, as sent: landed and failed calls only. */
  signed_tx?: HelperBase64;
  /** The delegate's last block: pending and dropped calls only. */
  max_block_height?: HelperDecimal;
  method: string;
  side: "buy" | "sell";
  state: HelperBindRecordState;
  refunded?: true;
}
/**
 * One asked wallet's record, in the asked order. A W the vault never paid (no spends row to W reads paid, or settled
 * with refund_value 0, on two providers at one final block), or one with no record, is the same empty shape: token
 * null, calls [], created null, so the answer tells no one which W exist.
 */
export interface HelperBindRecord {
  wallet: string;
  token: HelperNearAccount | null;
  calls: HelperBindRecordCall[];
  /** W's creation Transfer: its hash, the height it was signed at (decimal) and its state; null when none was sent. */
  created: { tx_hash: HelperTxHash; height: HelperDecimal; state: HelperBindRecordState } | null;
}
export interface HelperBindRecordAnswer {
  records: HelperBindRecord[];
}
/** bad_shape: not the body above, or a network this helper does not carry. upstream: a read failed or the two providers
 *  disagreed; nothing was kept, ask again. */
export const HELPER_BIND_RECORD_CODES = ["bad_shape", "upstream"] as const;
deepFreeze(HELPER_BIND_RECORD_CODES);
export type HelperBindRecordCode = (typeof HELPER_BIND_RECORD_CODES)[number];

// ---------------------------------------------------------------------------------------------------------------
// POST /v1/intents
// ---------------------------------------------------------------------------------------------------------------

/**
 * One signed intents.near intent, raw_ed25519: the signature is ed25519 over the payload string's UTF-8 bytes, and
 * the helper carries the string byte for byte. It never carries a move into the vault.
 */
export interface HelperIntentsRequest {
  signed_intent: HelperSignedIntent;
}

export interface HelperSignedIntent {
  standard: "raw_ed25519";
  /** JSON of HelperIntentPayload, canonical (no whitespace, no repeated key). */
  payload: string;
  /** The signer's key, "ed25519:" and base58 (proofs/g1-arm-swap/intent.mjs:101). */
  public_key: HelperNearPublicKey;
  /** ed25519 over the payload's UTF-8 bytes, "ed25519:" and base58, never base64 (intent.mjs:101). */
  signature: HelperEd25519Signature;
}

/** What `payload` decodes to: exactly one intent, signed by the gated signer. */
export interface HelperIntentPayload {
  /** U, R, V or A. */
  signer_id: HelperNearAccount;
  verifying_contract: "intents.near";
  /** RFC 3339. */
  deadline: string;
  /** base64 of a 32-byte versioned nonce. */
  nonce: string;
  intents: [HelperIntent];
}

/** A transfer's tokens map holds exactly this many entries (wallet.md:898). */
export const HELPER_TRANSFER_TOKEN_ENTRIES = 1;

/**
 * A transfer inside intents.near to a 1Click deposit address that a quote made through our helper signed, with the
 * signer as its refundTo: exactly HELPER_TRANSFER_TOKEN_ENTRIES tokens entry ("nep141:<token>" to a decimal amount).
 * No memo, no msg.
 */
export interface HelperIntentTransfer {
  intent: "transfer";
  receiver_id: HelperNearAccount;
  tokens: Record<string, HelperDecimal>;
}

/**
 * An ft_withdraw out of intents.near to a NEAR account that is neither the vault nor intents.near. No memo, no msg,
 * no storage_deposit: an unregistered receiver is registered by the relayer once per signer before the send.
 */
export interface HelperIntentFtWithdraw {
  intent: "ft_withdraw";
  token: HelperNearAccount;
  receiver_id: HelperNearAccount;
  amount: HelperDecimal;
}

export type HelperIntent = HelperIntentTransfer | HelperIntentFtWithdraw;

export interface HelperIntentsAnswer {
  tx_hash: HelperTxHash;
}

/**
 * In H4.3's order ("The ids' intents on /v1/intents"): the gate first, before any chain read; then the vault refusal;
 * registration_failed comes at the send and counts toward the signer's three. Never token_halted: neither kind is held
 * on a halt. sender_struck is final for that signer here: its money leaves by its own self-submitted ft_withdraw.
 */
export const HELPER_INTENTS_CODES = [
  "id_not_ours",
  "receiver_is_vault",
  "bad_shape",
  "not_helper_quote",
  "expired",
  "sender_struck",
  "in_flight",
  "simulation_refused",
  "receiver_not_registered",
  "relayer_low",
  "registration_failed",
] as const;
deepFreeze(HELPER_INTENTS_CODES);
export type HelperIntentsCode = (typeof HELPER_INTENTS_CODES)[number];

// ---------------------------------------------------------------------------------------------------------------
// /v1/orders
// ---------------------------------------------------------------------------------------------------------------

/**
 * One order as the order sender takes it: the kit's own OrderRecord (orders/record.ts: group_id, the trigger
 * {kind, pool, venue, direction, price, quote_asset}, variants[1..3] signed on one nonce, expires_at for NEAR, nonce_ref
 * per H5.1) with the hash of the order's token. The token is a random secret the device keeps; status, replace and
 * delete need it, and the helper stores only its SHA-256, as 64 lowercase hex characters.
 */
export type HelperOrder = OrderRecord & { token_hash: string };

/** token_hash: SHA-256 of the order's token, 64 lowercase hex characters (markets.md:2071). */
export const HELPER_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
deepFreeze(HELPER_TOKEN_HASH_PATTERN);

/**
 * An order's fields on the wire, exactly: the order record's own and token_hash, nothing else. The order sender
 * refuses an order with any other field.
 */
export const HELPER_ORDER_FIELDS = Object.freeze([...ORDER_RECORD_FIELDS, "token_hash"] as const);

export interface HelperOrdersRequest {
  group_id: string;
  /** One order, or a stop and a take-profit twin. */
  orders: [HelperOrder] | [HelperOrder, HelperOrder];
}

export const HELPER_ORDER_CODES = [
  "bad_bytes",
  "bad_signature",
  "nonce_mismatch",
  "nonce_spent",
  "no_balance",
  "expired",
  "duplicate",
] as const;
deepFreeze(HELPER_ORDER_CODES);
export type HelperOrderCode = (typeof HELPER_ORDER_CODES)[number];

export interface HelperOrdersAnswer {
  orders: ({ order_id: OrderRecord["order_id"]; state: "armed" } | { order_id: OrderRecord["order_id"]; error: { code: HelperOrderCode } })[];
}

/** The order sender's own states (H5.1), not the device's. */
export type HelperOrderState = "armed" | "firing" | "sent" | "filled" | "void" | "expired" | "deleted";

/** POST /v1/orders/status takes 1 to this many items (markets.md:3343). */
export const HELPER_STATUS_ITEMS_MAX = 100;

/** `token` is the order's own capability, of which the helper stores only the hash. */
export interface HelperOrderStatusItem {
  order_id: OrderRecord["order_id"];
  token: string;
}

/** 1 to HELPER_STATUS_ITEMS_MAX items. */
export interface HelperOrdersStatusRequest {
  items: [HelperOrderStatusItem, ...HelperOrderStatusItem[]];
}

export interface HelperOrderStatus {
  order_id: OrderRecord["order_id"];
  state: HelperOrderState;
  tx_id?: HelperTxHash;
  last_try?: string;
  reason?: string;
}

export interface HelperOrdersStatusAnswer {
  items: HelperOrderStatus[];
}

/** PUT /v1/orders/{order_id}: new variants on the same nonce_ref, in the order record's own fields. */
export type HelperOrderReplaceRequest = { token: string } & Pick<OrderRecord, "variants" | "expires_at">;

export interface HelperOrderReplaceAnswer {
  state: HelperOrderState;
}

/** DELETE /v1/orders/{order_id}. */
export interface HelperOrderDeleteRequest {
  token: string;
}

export interface HelperOrderDeleteAnswer {
  state: "deleted";
}

// ---------------------------------------------------------------------------------------------------------------
// POST /v1/log
// ---------------------------------------------------------------------------------------------------------------

/**
 * A signed call for the profile log (section 2.5). The log contract checks `sig` itself, so the relayer only carries
 * it: a first post (no stored head for T) from log.<ours>.near with its storage attached, any other call with its
 * FunctionCall key. First posts pass the helper's limiter per requester.
 */
export interface HelperLogPostArgs {
  T: string;
  prev_head: string;
  entry_hash: string;
  payload: string;
  sig: string;
}

export interface HelperLogSubscribeArgs {
  T: string;
  p: string;
  follower_pubkey: string;
  precommitment: string;
  sig: string;
}

export type HelperLogRequest = { method: "post"; args: HelperLogPostArgs } | { method: "subscribe"; args: HelperLogSubscribeArgs };

export interface HelperLogAnswer {
  tx_hash: HelperTxHash;
}

export type HelperLogCode = "bad_shape" | "bad_signature" | "relayer_low";
