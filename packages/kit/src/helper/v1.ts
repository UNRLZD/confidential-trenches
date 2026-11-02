// The helper API /v1, frozen with the kit on Nov 1 06:00Z: every path of markets.md H7 with its 7.1 changes
// (research main 3dbe87c). It is what the kit, the signing page and any outside wallet, terminal or bot call on a
// helper: ours, or their own copy of it.
// Types and constants only. It imports only the kit's own order record (Chain, OrderRecord and ORDER_RECORD_FIELDS,
// never redefined here) and signs nothing; a helper holds API keys, never a money key, and can only carry what the device signed. Nothing a
// helper answers is trusted for anything signed: the device checks every answer against its own request and its own
// chain reads before it signs.
// Wire rules: JSON bodies; a signed transaction or delegate in standard base64; an intent's public key and signature
// as ed25519:<base58> (intents.near's raw_ed25519 form, HelperSignedIntent); no cookies; the kit calls with HELPER_FETCH_INIT; every
// answer carries X-Helper-Commit. An error is { error: { code } } with the HTTP status of HELPER_CODE_STATUS (400 for
// a code not listed there). Limits are design values (H7: "Limits are [design]").

import { ORDER_RECORD_FIELDS, type Chain, type OrderRecord } from "../orders/record.ts";

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
  origins: ["https://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade"],
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["content-type"],
  exposeHeaders: ["X-Helper-Commit", "X-Helper-Source", "X-Fetched-At"],
  maxAgeSeconds: 600,
  vary: "Origin",
  allowCredentialsHeader: "absent",
} as const;

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
export type HelperPart = (typeof HELPER_PARTS)[number];

/** Codes any path can answer: a vendor or RPC down (H2.3), a body over its limit, a full bucket (H2.2), no such thing. */
export const HELPER_COMMON_CODES = ["upstream", "too_large", "rate_limited", "not_found"] as const;
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
  receiver_not_registered: 409,
  upstream: 503,
  token_halted: 503,
  index_behind: 503,
  relayer_low: 503,
} as const;

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
  { method: "POST", path: "/v1/bind", part: "delegate", limitBytes: 4096 },
  { method: "POST", path: "/v1/intents", part: "intents", limitBytes: 8192 },
  { method: "POST", path: "/v1/orders", part: "orders", limitBytes: 65536 },
  { method: "POST", path: "/v1/orders/status", part: "orders", limitBytes: 16384 },
  { method: "PUT", path: "/v1/orders/{order_id}", part: "orders", limitBytes: 32768 },
  { method: "DELETE", path: "/v1/orders/{order_id}", part: "orders", limitBytes: 1024 },
  { method: "POST", path: "/v1/log", part: "log", limitBytes: 4096 },
] as const;
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
 * Cache-Control: public, max-age=86400; 404 when no logo passed the checks (SVG is refused), and the app shows its own.
 */
export const HELPER_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
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
   * Always true: the kit sends fund_recipient: true on every /v1/withdraw (markets.md:1535-1536), and the relayer
   * funds a new arming account A first when the recipient is one (H3.7 item 1).
   */
  fund_recipient: true;
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
 * the signed call to the pages. 60 s is three times that, and inside the call's own window of 120 blocks.
 */
export const HELPER_BIND_ANSWER_MS = 60_000;

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

export type HelperBindCode =
  | (typeof HELPER_BIND_DEPOSIT_CODES)[number]
  | (typeof HELPER_BIND_CLEANUP_CODES)[number]
  | (typeof HELPER_BIND_ONWARD_CODES)[number];

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
