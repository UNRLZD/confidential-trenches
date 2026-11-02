#!/usr/bin/env node
// Live check of card kit-freeze-helper-api: the helper API /v1 is one typed file in the kit, as GitHub serves it.
// It reads packages/kit/src/helper/v1.ts and packages/kit/src/index.ts from GitHub (main, then the 06:00Z freeze tag)
// and parses them with the TypeScript parser, never running them. It checks, against values pinned here from
// markets.md, wallet.md and vault.md at research main 3dbe87c (the public repo carries no papers):
//   - the file imports nothing outside the kit (only Chain, OrderRecord and ORDER_RECORD_FIELDS from ../orders/record.ts,
//     decided 00:35Z), redefines none of the wallet's exported names (a duplicate fails the kit's tsc with
//     TS2308), and index.ts exports it ("export * from ./helper/v1");
//   - the path list equals H7's table (markets.md:3329-3345) with 7.1's new POST /v1/log (:3277), and the health parts
//     are {proxy, relay, intents, delegate, orders, log} (:3278, :3331);
//   - /v1/bind's body is one signed delegate, and its deposit shape is a DelegateAction holding ft_transfer_call (:3274,
//     :3340);
//   - /v1/intents' body holds only the transfer and ft_withdraw kinds, verifying_contract intents.near, and no msg, memo
//     or storage_deposit field anywhere (:3341, :1910-1923);
//   - every answer-code list equals its row, in order (H4.3's for /v1/bind, :3338-3342), with 503 token_halted and 403
//     receiver_is_vault, and /v1/intents never answers token_halted;
//   - cross-origin reads for exactly APP_HOST and SIGN_HOST (:3280, :3291-3311): never "*", no credentials, Vary:
//     Origin, X-Helper-Commit exposed (:3287-3289);
//   - every money-path shape (withdraw, withdraw/fee, bind, intents, orders, the PUT, status, log) prints exactly as
//     pinned in SHAPES, and every frozen value (CORS, paths with their limits, the RPC allowlist, the HTTP statuses,
//     the patterns and limits, the order's wire fields with orders/record.ts's ORDER_RECORD_FIELDS) equals VALUES;
//   - after kit-v1, the additions only: the beta cap per deposit HELPER_BIND_DEPOSIT_CAP (1,000 USDC in base units,
//     OD:262) and its code amount_above_cap right after amount_too_low (card kit-deposit-cap);
//     and the Solana RPC method isBlockhashValid, last on the Solana list (card solana-set-send's dead check); the
//     pin is exact, so any other method, place or chain fails (card kit-freeze-pin-blockhash); and POST /v1/bind's
//     answer bound HELPER_BIND_ANSWER_MS (45 s), which the helper answers within and the device's send waits for, one
//     number both read (card wallet-bind-carry-wait);
//   - after 06:00Z, main's v1.ts equals the tag's byte for byte.
// Once the helper answers (card helper-host-health), it also reads https://api.confidential.unrealized.trade/v1/health
// from APP_HOST's Origin and from a stranger's, and compares its parts, X-Helper-Commit and CORS headers with the file.
// While the host does not answer at all, that part is skipped and said so; --require-health makes it a failure.
//   node scripts/live-checks/kit-freeze-helper-api.mjs [--tag <06:00Z tag>] [--require-health] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2 (after 06:00Z, --tag is required)
// --record writes every answer the run read to <file>, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const KEY = "kit-freeze-helper-api";
export const RAW = "https://raw.githubusercontent.com/UNRLZD/confidential-trenches";
export const V1 = "packages/kit/src/helper/v1.ts";
export const ENTRY = "packages/kit/src/index.ts";
export const RECORD = "packages/kit/src/orders/record.ts";
// HELPER_HOST, markets.md:2434
export const HEALTH = "https://api.confidential.unrealized.trade/v1/health";
export const FREEZE = Date.parse("2026-11-01T06:00:00Z");
const STRANGER = "https://stranger.invalid";
const TIMEOUT_MS = 10_000;
const MAX_TEXT = 1 << 20; // a v1.ts or index.ts over 1 MB is not ours
const MAX_HEALTH = 1024; // H7: /v1/health answers 1 KB

// ---- pinned from markets.md at research main 3dbe87c (line numbers as at ffcba5e: the H7 rows did not move) ----
// H7's table (:3331-3345) and 7.1's new row POST /v1/log (:3277)
export const PATHS = [
  "GET /v1/health",
  "POST /v1/proxy/{vendor}/{path}",
  "POST /v1/rpc/{chain}",
  "GET /v1/market/...",
  "GET /v1/logo/{chain}/{token}",
  "GET /v1/token-status",
  "GET /v1/withdraw/fee",
  "POST /v1/withdraw",
  "GET /v1/withdraw/{tx_hash}",
  "POST /v1/bind",
  "POST /v1/intents",
  "POST /v1/orders",
  "POST /v1/orders/status",
  "PUT /v1/orders/{order_id}",
  "DELETE /v1/orders/{order_id}",
  "POST /v1/log",
];
export const PARTS = ["proxy", "relay", "intents", "delegate", "orders", "log"]; // :3278, :3331
// APP_HOST and SIGN_HOST (M326 (5); wallet.md:1227), the only origins (:3297-3298)
export const ORIGINS = ["https://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade"];
export const CODES = {
  // :3338, H3.4's order
  HELPER_WITHDRAW_CODES: ["bad_shape", "bad_proof", "bad_fee_recipient", "fee_too_low", "fee_above_cap", "spent", "unknown_root", "index_behind", "in_flight", "withdraw_failed", "recipient_refused", "register_deposit_wrong", "bad_recipient", "deadline_too_close", "token_halted", "fund_recipient_wrong", "relayer_low"],
  // :3340, H4.3's order
  HELPER_BIND_DEPOSIT_CODES: ["bad_shape", "bad_signature", "no_account", "bad_key", "bad_nonce", "sender_struck", "expired", "resign_needed", "not_one_action", "not_ft_transfer_call", "token_not_accepted", "deposit_not_1_yocto", "gas_too_low", "gas_too_high", "bad_receiver", "amount_too_low", "amount_above_cap", "amount_above_balance", "bad_msg", "p_used", "p_bound", "prepay_open", "in_flight", "token_halted", "relayer_low"],
  // :3340, checks 1-4, then the clean-up's own (:1871-1880)
  HELPER_BIND_CLEANUP_CODES: ["bad_shape", "bad_signature", "no_account", "bad_key", "bad_nonce", "expired", "resign_needed", "id_not_ours", "bad_shape", "not_deposited", "not_settled"],
  // :3340, H3.7 item 2's order
  HELPER_BIND_ONWARD_CODES: ["bad_shape", "bad_signature", "no_account", "bad_key", "bad_nonce", "id_not_ours", "not_paid", "expired", "token_not_accepted", "deposit_not_1_yocto", "gas_too_high", "bad_msg", "not_helper_quote", "sender_struck", "in_flight", "bad_receiver", "amount_above_balance", "amount_not_whole", "receiver_not_registered", "token_halted", "relayer_low", "registration_failed"],
  // :3341, H4.3's paragraph "The ids' intents on /v1/intents"
  HELPER_INTENTS_CODES: ["id_not_ours", "receiver_is_vault", "bad_shape", "not_helper_quote", "expired", "sender_struck", "in_flight", "simulation_refused", "receiver_not_registered", "relayer_low", "registration_failed"],
  // :3342
  HELPER_ORDER_CODES: ["bad_bytes", "bad_signature", "nonce_mismatch", "nonce_spent", "no_balance", "expired", "duplicate"],
};
export const STATUS = { token_halted: 503, receiver_is_vault: 403, id_not_ours: 403, sender_struck: 403, prepay_open: 409, not_paid: 409, receiver_not_registered: 409 };
const DELEGATE_FIELDS = ["sender_id", "receiver_id", "actions", "nonce", "max_block_height", "public_key"];
// The frozen file, pinned (review of 01:33Z). SHAPES: each money-path type as the TypeScript printer writes it
// with no comments, checked by hand against its row: withdraw and withdraw/fee markets.md:3337-3339 and 7.1's rows
// :3271-3272, the withdrawal vault.md:356-364, bind :3340, intents :3341 and wallet.md:898-901, orders, status, the PUT
// and DELETE :3342-3345 (the orders row as restated at 3dbe87c), log :3277 and section 2.5. VALUES: the frozen
// constants, HELPER_ORDER_FIELDS read with orders/record.ts's ORDER_RECORD_FIELDS. A deleted salt or a renamed
// relay_fee changes a SHAPES line.
export const SHAPES = {
  HelperWithdrawFeeAnswer: "export interface HelperWithdrawFeeAnswer { relayer_account: HelperNearAccount; fee_recipient: HelperNearAccount; relay_fee: HelperDecimal; gp: HelperDecimal; px: string; g_w: HelperDecimal; valid_until_block: number; }",
  HelperReleaseRelayer: "export interface HelperReleaseRelayer { readonly relayer_account: HelperNearAccount; readonly fee_recipient: HelperNearAccount; }",
  HelperWithdrawal: "export interface HelperWithdrawal { recipient: HelperNearAccount; register_deposit: HelperDecimal; fee_recipient: HelperNearAccount; relay_fee: HelperDecimal; refund_precommitment: HelperDecimal; deadline_ms: number; salt: string; }",
  HelperGroth16Proof: "export interface HelperGroth16Proof { a: [ string, string ]; b: [ [ string, string ], [ string, string ] ]; c: [ string, string ]; }",
  HelperWithdrawRequest: "export interface HelperWithdrawRequest { withdrawal: HelperWithdrawal; proof: HelperGroth16Proof; public_signals: [ string, string, string, string, string, string, string, string ]; fund_recipient: true; token: HelperNearAccount; }",
  HelperWithdrawAnswer: "export interface HelperWithdrawAnswer { tx_hash: HelperTxHash; state: \"submitted\"; }",
  HelperWithdrawStatusAnswer: "export interface HelperWithdrawStatusAnswer { state: \"submitted\" | \"final\" | \"failed\"; block: number | null; receipts_ok: boolean | null; }",
  HelperBindRequest: "export interface HelperBindRequest { signed_delegate: HelperBase64; }",
  HelperBindAnswer: "export interface HelperBindAnswer { tx_hash: HelperTxHash; }",
  HelperDelegateAction: "export interface HelperDelegateAction<A> { sender_id: HelperNearAccount; receiver_id: HelperNearAccount; actions: [ A ]; nonce: number; max_block_height: number; public_key: HelperNearPublicKey; }",
  HelperFunctionCall: "export interface HelperFunctionCall<M extends string, Args> { FunctionCall: { method_name: M; args: Args; gas: number; deposit: \"1\"; }; }",
  HelperFtTransferCallArgs: "export interface HelperFtTransferCallArgs { receiver_id: HelperNearAccount; amount: HelperDecimal; msg: string; }",
  HelperFtTransferArgs: "export interface HelperFtTransferArgs { receiver_id: HelperNearAccount; amount: HelperDecimal; }",
  HelperOnwardArgs: "export interface HelperOnwardArgs { receiver_id: typeof HELPER_ONWARD_RECEIVER; amount: HelperDecimal; msg: string; }",
  HelperBindDeposit: "export type HelperBindDeposit = HelperDelegateAction<HelperFunctionCall<\"ft_transfer_call\", HelperFtTransferCallArgs>>;",
  HelperBindOnward: "export type HelperBindOnward = HelperDelegateAction<HelperFunctionCall<\"ft_transfer_call\", HelperOnwardArgs>>;",
  HelperBindPlain: "export type HelperBindPlain = HelperDelegateAction<HelperFunctionCall<\"ft_transfer\", HelperFtTransferArgs>>;",
  HelperBindCleanup: "export type HelperBindCleanup = HelperDelegateAction<{ DeleteAccount: { beneficiary_id: HelperNearAccount; }; }>;",
  HelperBindDelegate: "export type HelperBindDelegate = HelperBindDeposit | HelperBindOnward | HelperBindPlain | HelperBindCleanup;",
  HelperIntentsRequest: "export interface HelperIntentsRequest { signed_intent: HelperSignedIntent; }",
  HelperSignedIntent: "export interface HelperSignedIntent { standard: \"raw_ed25519\"; payload: string; public_key: HelperNearPublicKey; signature: HelperEd25519Signature; }",
  HelperIntentPayload: "export interface HelperIntentPayload { signer_id: HelperNearAccount; verifying_contract: \"intents.near\"; deadline: string; nonce: string; intents: [ HelperIntent ]; }",
  HelperIntentTransfer: "export interface HelperIntentTransfer { intent: \"transfer\"; receiver_id: HelperNearAccount; tokens: Record<string, HelperDecimal>; }",
  HelperIntentFtWithdraw: "export interface HelperIntentFtWithdraw { intent: \"ft_withdraw\"; token: HelperNearAccount; receiver_id: HelperNearAccount; amount: HelperDecimal; }",
  HelperIntent: "export type HelperIntent = HelperIntentTransfer | HelperIntentFtWithdraw;",
  HelperIntentsAnswer: "export interface HelperIntentsAnswer { tx_hash: HelperTxHash; }",
  HelperOrder: "export type HelperOrder = OrderRecord & { token_hash: string; };",
  HelperOrdersRequest: "export interface HelperOrdersRequest { group_id: string; orders: [ HelperOrder ] | [ HelperOrder, HelperOrder ]; }",
  HelperOrdersAnswer: "export interface HelperOrdersAnswer { orders: ({ order_id: OrderRecord[\"order_id\"]; state: \"armed\"; } | { order_id: OrderRecord[\"order_id\"]; error: { code: HelperOrderCode; }; })[]; }",
  HelperOrderStatusItem: "export interface HelperOrderStatusItem { order_id: OrderRecord[\"order_id\"]; token: string; }",
  HelperOrdersStatusRequest: "export interface HelperOrdersStatusRequest { items: [ HelperOrderStatusItem, ...HelperOrderStatusItem[] ]; }",
  HelperOrderStatus: "export interface HelperOrderStatus { order_id: OrderRecord[\"order_id\"]; state: HelperOrderState; tx_id?: HelperTxHash; last_try?: string; reason?: string; }",
  HelperOrdersStatusAnswer: "export interface HelperOrdersStatusAnswer { items: HelperOrderStatus[]; }",
  HelperOrderReplaceRequest: "export type HelperOrderReplaceRequest = { token: string; } & Pick<OrderRecord, \"variants\" | \"expires_at\">;",
  HelperOrderReplaceAnswer: "export interface HelperOrderReplaceAnswer { state: HelperOrderState; }",
  HelperOrderDeleteRequest: "export interface HelperOrderDeleteRequest { token: string; }",
  HelperOrderDeleteAnswer: "export interface HelperOrderDeleteAnswer { state: \"deleted\"; }",
  HelperLogPostArgs: "export interface HelperLogPostArgs { T: string; prev_head: string; entry_hash: string; payload: string; sig: string; }",
  HelperLogSubscribeArgs: "export interface HelperLogSubscribeArgs { T: string; p: string; follower_pubkey: string; precommitment: string; sig: string; }",
  HelperLogRequest: "export type HelperLogRequest = { method: \"post\"; args: HelperLogPostArgs; } | { method: \"subscribe\"; args: HelperLogSubscribeArgs; };",
  HelperLogAnswer: "export interface HelperLogAnswer { tx_hash: HelperTxHash; }",
  HelperDecimal: "export type HelperDecimal = string;",
  HelperNearAccount: "export type HelperNearAccount = string;",
  HelperNearPublicKey: "export type HelperNearPublicKey = `ed25519:${string}`;",
  HelperEd25519Signature: "export type HelperEd25519Signature = `ed25519:${string}`;",
  HelperBase64: "export type HelperBase64 = string;",
  HelperTxHash: "export type HelperTxHash = string;",
  HelperOrderState: "export type HelperOrderState = \"armed\" | \"firing\" | \"sent\" | \"filled\" | \"void\" | \"expired\" | \"deleted\";",
};
export const VALUES = {
  HELPER_CORS: {"origins":["https://confidential.unrealized.trade","https://sign.confidential.unrealized.trade"],"allowMethods":["GET","POST","PUT","DELETE"],"allowHeaders":["content-type"],"exposeHeaders":["X-Helper-Commit","X-Helper-Source","X-Fetched-At"],"maxAgeSeconds":600,"vary":"Origin","allowCredentialsHeader":"absent"},
  HELPER_V1_PATHS: [{"method":"GET","path":"/v1/health","part":"all","limitBytes":1024},{"method":"POST","path":"/v1/proxy/{vendor}/{path}","part":"proxy","limitBytes":65536},{"method":"POST","path":"/v1/rpc/{chain}","part":"proxy","limitBytes":262144},{"method":"GET","path":"/v1/market/...","part":"proxy","limitBytes":null},{"method":"GET","path":"/v1/logo/{chain}/{token}","part":"proxy","limitBytes":262144},{"method":"GET","path":"/v1/token-status","part":"relay","limitBytes":1024},{"method":"GET","path":"/v1/withdraw/fee","part":"relay","limitBytes":1024},{"method":"POST","path":"/v1/withdraw","part":"relay","limitBytes":8192},{"method":"GET","path":"/v1/withdraw/{tx_hash}","part":"relay","limitBytes":1024},{"method":"POST","path":"/v1/bind","part":"delegate","limitBytes":4096},{"method":"POST","path":"/v1/intents","part":"intents","limitBytes":8192},{"method":"POST","path":"/v1/orders","part":"orders","limitBytes":65536},{"method":"POST","path":"/v1/orders/status","part":"orders","limitBytes":16384},{"method":"PUT","path":"/v1/orders/{order_id}","part":"orders","limitBytes":32768},{"method":"DELETE","path":"/v1/orders/{order_id}","part":"orders","limitBytes":1024},{"method":"POST","path":"/v1/log","part":"log","limitBytes":4096}],
  HELPER_RPC_METHODS: {"solana":["getAccountInfo","getMultipleAccounts","getBalance","getTokenAccountsByOwner","getTokenLargestAccounts","getLatestBlockhash","simulateTransaction","sendTransaction","getSignatureStatuses","getTransaction","getBlockHeight","getMinimumBalanceForRentExemption","isBlockhashValid"],"base":["eth_call","eth_simulateV1","eth_getTransactionCount","eth_getBalance","eth_feeHistory","eth_blockNumber","eth_sendRawTransaction","eth_getTransactionReceipt","eth_getLogs","eth_estimateGas","eth_getBlockByNumber","eth_getTransactionByHash"],"robinhood":["eth_call","eth_simulateV1","eth_getTransactionCount","eth_getBalance","eth_feeHistory","eth_blockNumber","eth_sendRawTransaction","eth_getTransactionReceipt","eth_getLogs","eth_estimateGas","eth_getBlockByNumber","eth_getTransactionByHash"],"near":["query","block","gas_price","tx","send_tx","EXPERIMENTAL_tx_status","EXPERIMENTAL_protocol_config"]},
  HELPER_RPC_BATCH_MAX: 10,
  HELPER_CODE_STATUS: {"not_found":404,"token_not_watched":404,"too_large":413,"rate_limited":429,"id_not_ours":403,"sender_struck":403,"receiver_is_vault":403,"prepay_open":409,"not_paid":409,"receiver_not_registered":409,"upstream":503,"token_halted":503,"index_behind":503,"relayer_low":503},
  HELPER_SALT_PATTERN: "/^[0-9a-f]{32}$/",
  HELPER_TOKEN_HASH_PATTERN: "/^[0-9a-f]{64}$/",
  HELPER_ONWARD_RECEIVER: "intents.near",
  HELPER_TRANSFER_TOKEN_ENTRIES: 1,
  HELPER_STATUS_ITEMS_MAX: 100,
  HELPER_ORDER_FIELDS: ["v","order_id","group_id","chain","wallet","token","amount","min_out","trigger","nonce_ref","variants","expires_at","token_hash"],
  HELPER_FEE_ANSWER_DISPLAY_ONLY: ["relayer_account","fee_recipient"],
  HELPER_PARTS: ["proxy","relay","intents","delegate","orders","log"],
  HELPER_FETCH_INIT: {"credentials":"omit","referrerPolicy":"no-referrer"},
  HELPER_COMMIT_HEADER: "X-Helper-Commit",
  HELPER_LOGO_MAX_BYTES: 262144,
  HELPER_LOGO_TYPES: ["image/png","image/jpeg","image/webp","image/gif"],
  HELPER_PROXY_VENDORS: ["jupiter","relay","lifi","oneclick"],
  HELPER_BIND_DEPOSIT_CAP: "1000000000n",
  HELPER_BIND_ANSWER_MS: 45000,
};
const NEVER_IN_INTENTS = ["msg", "memo", "storage_deposit"];
// the one import v1.ts makes, and the wallet's exported names it must not declare (decided 00:35Z)
export const IMPORTS = ['import { ORDER_RECORD_FIELDS, type Chain, type OrderRecord } from "../orders/record.ts";'];
export const WALLET_NAMES = ["Chain", "CHAINS", "TxRef", "Stage", "ErrorCode", "Operation", "OrderState", "WalletState", "OrderRecord", "SigninWay", "ReturnKey"];

// ---- reading TypeScript as data ----
const fail = (m) => {
  throw new Error(m);
};

export function parse(text) {
  const sf = ts.createSourceFile("v1.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics?.length) fail(`does not parse: ${sf.parseDiagnostics[0].messageText}`);
  const decls = new Map();
  for (const s of sf.statements) {
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) decls.set(s.name.text, s);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) decls.set(d.name.text, d);
  }
  return { sf, decls };
}

// a literal value (string, number, boolean, null, array, object) behind `as const` and `satisfies`; anything else refused
// env: identifiers a spread may name (ORDER_RECORD_FIELDS, read from record.ts); Object.freeze(x) is x; a regex is its text;
// a bigint is its decimal text with "n" (1_000n and 0x3e8n both read "1000n")
export function literal(node, env = {}) {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isBigIntLiteral(node)) return `${BigInt(node.text.slice(0, -1))}n`;
  if (ts.isRegularExpressionLiteral(node)) return node.text;
  if (ts.isCallExpression(node) && node.expression.getText() === "Object.freeze" && node.arguments.length === 1) return literal(node.arguments[0], env);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((e) => {
      if (!ts.isSpreadElement(e)) return [literal(e, env)];
      const name = e.expression.getText();
      if (!ts.isIdentifier(e.expression) || !Array.isArray(env[name])) fail(`not a literal: ...${name}`);
      return env[name];
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    const o = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) fail(`not a plain property: ${p.getText()}`);
      o[p.name.text] = literal(p.initializer, env);
    }
    return o;
  }
  return fail(`not a literal: ${node.getText().slice(0, 60)}`);
}

const constOf = ({ decls, env }, name) => {
  const d = decls.get(name);
  if (!d || !ts.isVariableDeclaration(d) || !d.initializer) fail(`no const ${name}`);
  return literal(d.initializer, env);
};

// every property name, and every string literal each property can hold, over the types reachable from `roots`
export function reach({ sf, decls }, roots) {
  const props = new Set();
  const lits = new Map();
  const seen = new Set();
  const addLits = (name, t) => {
    const ls = ts.isUnionTypeNode(t) ? t.types : [t];
    for (const l of ls) if (ts.isLiteralTypeNode(l) && ts.isStringLiteral(l.literal)) lits.set(name, new Set([...(lits.get(name) ?? []), l.literal.text]));
  };
  const member = (m) => {
    if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
      props.add(m.name.text);
      if (m.type) addLits(m.name.text, m.type);
    }
    if (m.type) node(m.type);
    for (const p of m.parameters ?? []) if (p.type) node(p.type);
  };
  const named = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const d = decls.get(name);
    if (!d) return;
    if (ts.isInterfaceDeclaration(d)) {
      for (const h of d.heritageClauses ?? []) for (const t of h.types) node(t);
      d.members.forEach(member);
    } else if (ts.isTypeAliasDeclaration(d)) node(d.type);
  };
  const node = (n) => {
    if (ts.isTypeReferenceNode(n)) named(n.typeName.getText(sf));
    else if (ts.isExpressionWithTypeArguments(n)) named(n.expression.getText(sf));
    else if (ts.isTypeQueryNode(n)) named(n.exprName.getText(sf));
    if (ts.isTypeLiteralNode(n)) n.members.forEach(member);
    else ts.forEachChild(n, node);
  };
  roots.forEach(named);
  return { props, lits, seen };
}

const membersOf = ({ decls }, name) => {
  const d = decls.get(name);
  if (!d || !ts.isInterfaceDeclaration(d)) fail(`no interface ${name}`);
  return d.members.map((m) => m.name?.getText());
};

const imports = ({ sf }) => {
  const found = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || (ts.isExportDeclaration(n) && n.moduleSpecifier)) found.push(n.getText(sf).replace(/\s+/g, " "));
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) found.push(n.getText(sf).slice(0, 60));
    else if (ts.isImportTypeNode(n)) found.push(n.getText(sf).slice(0, 60));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
// a declaration as the printer writes it with no comments, on one line
export function shapeText({ sf, decls }, name) {
  const d = decls.get(name);
  if (!d || !(ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d))) return null;
  return printer.printNode(ts.EmitHint.Unspecified, d, sf).replace(/\s+/g, " ").trim();
}

// The checks on one v1.ts text, with orders/record.ts's text for ORDER_RECORD_FIELDS: [ok, line] pairs.
export function checkV1(text, recordText = "") {
  const out = [];
  const t = (what, fn) => {
    try {
      const r = fn();
      out.push([r === true, r === true ? what : `${what}: ${r}`]);
    } catch (e) {
      out.push([false, `${what}: ${e.message}`]);
    }
  };
  let f;
  try {
    f = parse(text);
    let fields = null;
    try {
      fields = constOf({ ...parse(recordText), env: {} }, "ORDER_RECORD_FIELDS");
    } catch {
      // no record.ts, or no plain list in it: HELPER_ORDER_FIELDS cannot be read and its pin fails
    }
    f.env = { ORDER_RECORD_FIELDS: fields };
  } catch (e) {
    return [[false, `v1.ts ${e.message}`]];
  }
  t("v1.ts imports only the kit's order record", () => {
    const i = imports(f);
    return same(i, IMPORTS) || `imports ${i.map((x) => x.slice(0, 80)).join("; ") || "nothing"}`;
  });
  t("v1.ts redefines none of the wallet's exported names", () => {
    const dup = WALLET_NAMES.filter((n) => f.decls.has(n));
    return dup.length === 0 || `declares ${dup.join(", ")}`;
  });
  t("the path list equals H7 with 7.1's changes", () => {
    const got = constOf(f, "HELPER_V1_PATHS").map((p) => `${p.method} ${p.path}`);
    const missing = PATHS.filter((p) => !got.includes(p));
    const extra = got.filter((p) => !PATHS.includes(p));
    const dup = got.filter((p, i) => got.indexOf(p) !== i);
    return (missing.length === 0 && extra.length === 0 && dup.length === 0) || `missing [${missing}], extra [${extra}], twice [${dup}]`;
  });
  t("the health parts are {proxy, relay, intents, delegate, orders, log}", () => {
    const parts = constOf(f, "HELPER_PARTS");
    if (!same(parts, PARTS)) return `HELPER_PARTS is ${JSON.stringify(parts)}`;
    const bad = constOf(f, "HELPER_V1_PATHS").filter((p) => p.part !== "all" && !PARTS.includes(p.part));
    if (bad.length) return `paths name parts outside the list: ${bad.map((p) => p.path)}`;
    const h = reach(f, ["HelperHealthAnswer"]);
    return (h.props.has("parts") && h.seen.has("HelperPart")) || "HelperHealthAnswer.parts is not keyed by HelperPart";
  });
  t("/v1/bind's body is one signed delegate, its deposit a DelegateAction holding ft_transfer_call", () => {
    const body = membersOf(f, "HelperBindRequest");
    if (!same(body, ["signed_delegate"])) return `HelperBindRequest has [${body}]`;
    const da = membersOf(f, "HelperDelegateAction");
    const lack = DELEGATE_FIELDS.filter((x) => !da.includes(x));
    if (lack.length) return `HelperDelegateAction lacks [${lack}]`;
    const dep = f.decls.get("HelperBindDeposit");
    if (!dep || !ts.isTypeAliasDeclaration(dep)) return "no type HelperBindDeposit";
    const ref = dep.type;
    if (!ts.isTypeReferenceNode(ref) || ref.typeName.getText(f.sf) !== "HelperDelegateAction") return `HelperBindDeposit is ${ref.getText(f.sf)}`;
    const call = ref.typeArguments?.[0];
    const m = call && ts.isTypeReferenceNode(call) && call.typeName.getText(f.sf) === "HelperFunctionCall" ? call.typeArguments?.[0] : null;
    if (!m || !ts.isLiteralTypeNode(m) || m.literal.text !== "ft_transfer_call") return `HelperBindDeposit's action is ${call?.getText(f.sf)}`;
    const all = f.decls.get("HelperBindDelegate");
    return (all && reach(f, ["HelperBindDelegate"]).seen.has("HelperBindDeposit")) || "HelperBindDelegate does not hold HelperBindDeposit";
  });
  t("/v1/intents' body holds only transfer and ft_withdraw, with no msg, memo or storage_deposit", () => {
    const body = membersOf(f, "HelperIntentsRequest");
    if (!same(body, ["signed_intent"])) return `HelperIntentsRequest has [${body}]`;
    const r = reach(f, ["HelperIntentsRequest", "HelperIntentPayload"]);
    if (!r.seen.has("HelperIntent")) return "HelperIntentPayload does not hold HelperIntent";
    const kinds = [...(r.lits.get("intent") ?? [])].sort();
    if (!same(kinds, ["ft_withdraw", "transfer"])) return `intent kinds [${kinds}]`;
    const bad = NEVER_IN_INTENTS.filter((p) => r.props.has(p));
    if (bad.length) return `a field ${bad.join(", ")} is in the body`;
    const vc = [...(r.lits.get("verifying_contract") ?? [])];
    return same(vc, ["intents.near"]) || `verifying_contract [${vc}]`;
  });
  t("every answer-code list equals its H7 row, in order", () => {
    const bad = Object.entries(CODES).filter(([k, v]) => !same(constOf(f, k), v));
    if (bad.length) return `differs: ${bad.map(([k]) => k).join(", ")}`;
    if (constOf(f, "HELPER_INTENTS_CODES").includes("token_halted")) return "/v1/intents answers token_halted";
    const st = constOf(f, "HELPER_CODE_STATUS");
    const wrong = Object.entries(STATUS).filter(([k, v]) => st[k] !== v);
    return wrong.length === 0 || `HTTP status wrong for ${wrong.map(([k, v]) => `${k} (${st[k]}, not ${v})`).join(", ")}`;
  });
  t("cross-origin reads for exactly APP_HOST and SIGN_HOST, never *, no credentials", () => {
    const c = constOf(f, "HELPER_CORS");
    if (JSON.stringify(c).includes("*")) return `HELPER_CORS holds "*": ${JSON.stringify(c)}`;
    if (!same(c.origins, ORIGINS)) return `origins ${JSON.stringify(c.origins)}`;
    if (c.allowCredentialsHeader !== "absent") return `allowCredentialsHeader ${c.allowCredentialsHeader}`;
    if (c.vary !== "Origin") return `vary ${c.vary}`;
    return (Array.isArray(c.exposeHeaders) && c.exposeHeaders.includes("X-Helper-Commit")) || "X-Helper-Commit is not exposed";
  });
  t("X-Helper-Commit on every answer", () => constOf(f, "HELPER_COMMIT_HEADER") === "X-Helper-Commit" || "HELPER_COMMIT_HEADER is not X-Helper-Commit");
  t("every money-path shape equals its pin", () => {
    const bad = Object.entries(SHAPES).filter(([k, v]) => shapeText(f, k) !== v);
    return bad.length === 0 || `differs: ${bad.map(([k]) => k).join(", ")}`;
  });
  t("every frozen value equals its pin", () => {
    const bad = Object.entries(VALUES).filter(([k, v]) => {
      try {
        return !same(constOf(f, k), v);
      } catch {
        return true;
      }
    });
    return bad.length === 0 || `differs: ${bad.map(([k]) => k).join(", ")}`;
  });
  return out;
}

// index.ts exports the file, so apps reach it through the kit's public entry
export function checkEntry(text) {
  const { sf } = parse(text);
  const ok = sf.statements.some((s) => ts.isExportDeclaration(s) && !s.exportClause && !s.isTypeOnly && s.moduleSpecifier && /^\.\/helper\/v1(\.ts|\.js)?$/.test(s.moduleSpecifier.text));
  return [ok, ok ? 'index.ts holds export * from "./helper/v1"' : 'index.ts does not export * from "./helper/v1"'];
}

async function readText(fetchFn, url, max = MAX_TEXT) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  const text = await r.text();
  if (text.length > max) return { status: r.status, text: null, over: true };
  return { status: r.status, text, headers: r.headers };
}

// The health answer, or { error } when the host does not answer at all.
async function readHealth(fetchFn) {
  try {
    return await readText(fetchFn, HEALTH, MAX_HEALTH);
  } catch (e) {
    return { error: String(e.cause?.code ?? e.name ?? e.message) };
  }
}

export function checkHealth(app, stranger, v1Parts = PARTS) {
  const out = [];
  const h = (ok, line) => out.push([ok, line]);
  if (app.over) return [[false, `health answers more than ${MAX_HEALTH} bytes`]];
  let j;
  try {
    j = JSON.parse(app.text);
  } catch {
    return [[false, `health answers status ${app.status}, not JSON`]];
  }
  const parts = j && typeof j.parts === "object" && j.parts !== null ? j.parts : {};
  const keys = Object.keys(parts).sort();
  h(app.status === 200 && same(keys, [...v1Parts].sort()), `health parts [${keys}] equal the file's [${v1Parts}] (status ${app.status})`);
  const vals = Object.values(parts).filter((v) => v !== "up" && v !== "down");
  h(vals.length === 0 && typeof j.ok === "boolean", `health ok is a boolean and every part is up or down${vals.length ? `: got ${JSON.stringify(vals)}` : ""}`);
  const commit = app.headers.get("x-helper-commit");
  h(typeof j.commit === "string" && j.commit.length > 0 && commit === j.commit, `X-Helper-Commit ${commit} equals the answer's commit ${j.commit}`);
  const acao = app.headers.get("access-control-allow-origin");
  h(acao === ORIGINS[0], `from APP_HOST's Origin, Access-Control-Allow-Origin is ${acao}`);
  const vary = (app.headers.get("vary") ?? "").toLowerCase().split(",").map((s) => s.trim());
  h(vary.includes("origin"), `Vary holds Origin (${app.headers.get("vary")})`);
  h(app.headers.get("access-control-allow-credentials") === null, "no Access-Control-Allow-Credentials");
  const sacao = stranger.error ? null : stranger.headers.get("access-control-allow-origin");
  h(!stranger.error && sacao === null, `from a stranger's Origin, Access-Control-Allow-Origin is ${stranger.error ? `unread (${stranger.error})` : sacao ?? "absent"}`);
  return out;
}

// fetchFn(url, init) as fetch; now: the check's clock; tag: the 06:00Z tag's name
export async function check({ fetchFn = fetch, now = Date.now(), tag, requireHealth = false } = {}) {
  const lines = [];
  let ok = true;
  const add = (good, line) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${line}`);
  };
  const refs = ["main"];
  if (now >= FREEZE) {
    if (!tag) throw new Error("after 06:00Z, name the freeze tag: --tag <tag>");
    refs.push(tag);
  } else if (tag) refs.push(tag);
  else lines.push("--  the 06:00Z tag is not due yet: main only");
  const texts = {};
  for (const ref of refs) {
    const url = `${RAW}/${encodeURIComponent(ref)}/${V1}`;
    const r = await readText(fetchFn, url);
    if (r.status !== 200 || r.text === null) {
      add(false, `${ref}: ${V1} answers ${r.over ? "over 1 MB" : `status ${r.status}`}`);
      continue;
    }
    texts[ref] = r.text;
    const rec = await readText(fetchFn, `${RAW}/${encodeURIComponent(ref)}/${RECORD}`);
    if (rec.status !== 200 || rec.text === null) add(false, `${ref}: ${RECORD} answers status ${rec.status}`);
    for (const [good, line] of checkV1(r.text, rec.text ?? "")) add(good, `${ref}: ${line}`);
    const e = await readText(fetchFn, `${RAW}/${encodeURIComponent(ref)}/${ENTRY}`);
    if (e.status !== 200 || e.text === null) add(false, `${ref}: ${ENTRY} answers status ${e.status}`);
    else {
      const [good, line] = checkEntry(e.text);
      add(good, `${ref}: ${line}`);
    }
  }
  if (refs.length === 2 && texts.main !== undefined && texts[tag] !== undefined) add(texts.main === texts[tag], `main's v1.ts equals the tag ${tag}'s byte for byte`);
  const app = await readHealth((u, i) => fetchFn(u, { ...i, headers: { Origin: ORIGINS[0] } }));
  if (app.error) {
    if (requireHealth) add(false, `${HEALTH} does not answer (${app.error})`);
    else lines.push(`--  ${HEALTH} does not answer yet (${app.error}): the health comparison waits for helper-host-health`);
  } else {
    const stranger = await readHealth((u, i) => fetchFn(u, { ...i, headers: { Origin: STRANGER } }));
    let parts = PARTS;
    try {
      parts = constOf(parse(texts.main ?? ""), "HELPER_PARTS");
    } catch {
      // main's file failed above; compare with the pinned parts
    }
    for (const [good, line] of checkHealth(app, stranger, parts)) add(good, line);
  }
  return { ok, lines };
}

// a fetch that keeps every answer it reads: { url, origin, status, headers, text } or { url, origin, error }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init = {}) => {
    const origin = init.headers?.Origin ?? null;
    try {
      const r = await fetchFn(url, init);
      const text = await r.text();
      answers.push({ url, origin, status: r.status, headers: Object.fromEntries(r.headers), text });
      return new Response(text, { status: r.status, headers: r.headers });
    } catch (e) {
      answers.push({ url, origin, error: String(e.cause?.code ?? e.name ?? e.message) });
      throw e;
    }
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const rec = recorder();
    const r = await check({ fetchFn: opt("--record") ? rec.fetchFn : fetch, tag: opt("--tag"), requireHealth: a.includes("--require-health") });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
