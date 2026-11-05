/**
 * The helper server (HELPER_HOST, markets paper H7). It holds API keys, never a money key, and logs no request: no
 * line it writes holds a client IP, a path or a header.
 *
 *   HELPER_COMMIT=<40 hex> [PORT=8080] [JUPITER_API_KEY=..] [RELAY_API_KEY=..] [LIFI_API_KEY=..] [ONECLICK_JWT=..]
 *     [SOLANA_RPC_URL=..] [SOLANA_HOLDERS_RPC_URL=..] [BASE_RPC_URL=..] [ROBINHOOD_RPC_URL=..] [NEAR_RPC_URL=..] [NEAR_RPC_URL_B=..]
 *     [RPC_BUDGET_<CHAIN>=<total>,<per client>[,<per method>]] [PROXY_BUDGET_<VENDOR>=<total a minute>,<per client>]
 *     [NEAR_TESTNET_RPC_URL=..] [NEAR_TESTNET_RPC_URL_B=..] [WITHDRAW_RELAYER_MAINNET=.. WITHDRAW_FEE_RECIPIENT_MAINNET=..]
 *     [WITHDRAW_RELAYER_TESTNET=.. WITHDRAW_FEE_RECIPIENT_TESTNET=..] [WITHDRAW_VAULT_<NET>=.. WITHDRAW_RELAYER_KEYS_<NET>=..]
 *     [BIND_VAULT_<NET>=.. BIND_RELAYER_<NET>=.. BIND_RELAYER_KEY_<NET>=.. BIND_MARGIN_K=..] [HELPER_RELEASE=.. HELPER_STORE_DIR=..]
 *     node src/server.ts   (<NET>: MAINNET or TESTNET)
 *
 * The vendor keys come from the host's environment only (src/proxy/vendors.ts); a vendor with no key is called
 * without one. So do the RPC providers' URLs (src/rpc/rpc.ts), where a keyed provider holds its key; a chain with none
 * set uses its public endpoint, and the second NEAR provider USDC's watch reads (NEAR_RPC_URL_B; src/token-status/).
 * GET /v1/withdraw/fee quotes a network only when the release's relayer accounts for it are set (src/withdraw/fee.ts).
 * POST /v1/withdraw and POST /v1/bind carry a network only when its sender's names are set (src/withdraw/send.ts,
 * src/bind/env.ts); each network's carry is held by that network's own token watch (src/token-status/).
 *
 * Every answer carries X-Helper-Commit and Vary: Origin. Cross-origin reads are allowed for exactly APP_HOST and
 * SIGN_HOST, never `*` and never with credentials (H7 "Cross-origin reads").
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { HELPER_BIND_ANSWER_MS, HELPER_CODE_STATUS, HELPER_COMMIT_HEADER, HELPER_CORS, HELPER_FETCHED_AT_HEADER, HELPER_SOURCE_HEADER } from "@blindfill/kit";
import { createSolanaLists } from "./data/solana/lists.ts";
import { createEvmLists, type EvmChain } from "./data/evm/lists.ts";
import { createSwaps, SWAP_RPCS, TRADES_MAX, type EvmSwaps } from "./data/evm/swaps.ts";
import { geckoBudget, GT_LIMIT_PER_MIN, type GeckoBudget } from "./data/gecko.ts";
import { AHEAD_TICK_MS, CANDLES_MAX, createSolanaToken, type DataAnswer } from "./data/solana/token.ts";
import { createSolanaTrades, TRADES_RPCS, type SolanaTrades } from "./data/solana/trades.ts";
import { health, releaseOf, type Part } from "./health.ts";
import { checkVendorPlans, createProxy, PROXY_BODY_MAX } from "./proxy/proxy.ts";
import { RPC_BODY_MAX } from "./rpc/methods.ts";
import { createRpc } from "./rpc/rpc.ts";
import { BIND_MAX_BYTES } from "./bind/checks.ts";
import { bindSenderFromEnv, type BindSender } from "./bind/env.ts";
import { statusesOf, tokenWatchesFromEnv, type TokenWatch, type TokenWatches } from "./token-status/status.ts";
import { feeQuoterFromEnv, FeeReadRefused, STORE_ENV, type FeeQuoter } from "./withdraw/fee.ts";
import { withdrawSenderFromEnv, type WithdrawSender } from "./withdraw/send.ts";
import { POOL_EPOCH_MS } from "./pool/fee.ts";
import { POOL_SOLANA_BODY_MAX, solanaPoolSendersFromEnv, type SolanaPoolSender } from "./pool/solana.ts";
import { evmPoolSendersFromEnv, POOL_EVM_BODY_MAX, POOL_EVM_SELL_BODY_MAX, POOL_LIFE_MAX_MS, type EvmPoolSender } from "./pool/evm.ts";
import { clientOf, clientWindow, providerHolds, refusalLog, throttled, throttleOf, type ProviderHolds } from "./limits/limits.ts";
import { openDurableDir } from "./store/durable.ts";
import { createSlot, type Slot, type SlotName, type SlotState } from "./rpc/slot.ts";
import { readWarm, seedGecko, writeWarm, type Warm } from "./data/warm.ts";
import { TICK_MS } from "./data/evm/lists.ts";
import * as nodeFs from "node:fs";
import { join } from "node:path";

type Proxy = ReturnType<typeof createProxy>;
type Rpc = ReturnType<typeof createRpc>;
type Lists = ReturnType<typeof createSolanaLists>;
type EvmLists = Partial<Record<EvmChain, ReturnType<typeof createEvmLists>>>;
/** The chains whose candles and trade tape come from our own swap reads: the EVM chains (src/data/evm/swaps.ts) and
 *  Solana (src/data/solana/trades.ts). */
type Swaps = Partial<Record<EvmChain, EvmSwaps>> & { solana?: SolanaTrades };
type Token = ReturnType<typeof createSolanaToken>;
type Fee = ReturnType<typeof feeQuoterFromEnv>;
// The routes of every part this server mounts (each path's part is the kit's HELPER_V1_PATHS). /v1/health reads its
// "up" parts from these keys and the dispatch below reads each route from here, so a part is up exactly when its
// routes are mounted.
const MOUNTED = { proxy: ["/v1/proxy/", "/v1/rpc/", "/v1/market/lists", "/v1/market/token", "/v1/market/holders", "/v1/market/candles", "/v1/market/trades"], relay: ["/v1/token-status", "/v1/withdraw/fee", "/v1/withdraw", "/v1/pool/fee", "/v1/pool/solana/send", "/v1/pool/evm/send", "/v1/pool/evm/sell"], delegate: ["/v1/bind"] } as const satisfies Partial<Record<Part, readonly string[]>>;
const [PROXY_PREFIX, RPC_PREFIX, MARKET_LISTS, MARKET_TOKEN, MARKET_HOLDERS, MARKET_CANDLES, MARKET_TRADES] = MOUNTED.proxy;
const [TOKEN_STATUS, WITHDRAW_FEE, WITHDRAW, POOL_FEE, POOL_SOLANA_SEND, POOL_EVM_SEND, POOL_EVM_SELL] = MOUNTED.relay;
const [BIND] = MOUNTED.delegate;
/** POST /v1/withdraw's body limit (the kit's HELPER_V1_PATHS row: 8 KB). */
export const WITHDRAW_BODY_MAX = 8_192;
/** POST /v1/bind's body limit: the kit's HELPER_V1_PATHS row, as bind/checks.ts reads it (4 KB). */
export const BIND_BODY_MAX = BIND_MAX_BYTES;
/**
 * POST /v1/bind answers within the kit's HELPER_BIND_ANSWER_MS, which the device's send waits for: a carry still running
 * then answers in_flight (the call is out and its end not known yet, so the device reads the deposits pages) and goes on
 * to its own end and record, as it does when the client closes.
 */
function bindAnswerWithin<A>(carry: Promise<A>, late: A, ms = HELPER_BIND_ANSWER_MS): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<A>((ok) => (timer = setTimeout(() => ok(late), Math.max(0, ms))));
  return Promise.race([carry, bound]).finally(() => clearTimeout(timer));
}
const BIND_LATE = { status: (HELPER_CODE_STATUS as Record<string, number>).in_flight ?? 400, body: { error: { code: "in_flight" as const } } };
/**
 * A stop's longest drain (card helper-ready-gate): the requests in flight at SIGTERM finish, the longest a bind's
 * HELPER_BIND_ANSWER_MS (45 s), then the process exits; deploy/redeploy.sh's `docker stop -t 60` kills only past it.
 */
export const STOP_MS = HELPER_BIND_ANSWER_MS + 5_000;
/**
 * How long a send, a withdrawal fee quote or a bind waits for this process to hold the senders (sendersFromEnv): during
 * a deploy's swap the new helper takes traffic while the old one drains its last requests and exits, which hands the
 * store over: at most STOP_MS, or docker stop's 60 s when it is killed. Each send's own deadline check runs after the
 * wait (pool/solana.ts and pool/evm.ts deadline_near, withdraw/send.ts check 9), so a wait can cost a refusal the
 * device re-proves after, never a late send. A bind waits only within its own HELPER_BIND_ANSWER_MS (the BIND route).
 */
export const SENDERS_WAIT_MS = 60_000;
const SENDERS_LATE = { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
/** Whether `held` settles fulfilled within `ms` (SENDERS_WAIT_MS). */
function heldWithin(held: Promise<unknown>, ms = SENDERS_WAIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((ok) => (timer = setTimeout(() => ok(false), Math.max(0, ms))));
  return Promise.race([held.then(() => true, () => false), late]).finally(() => clearTimeout(timer));
}
const SERVED: ReadonlySet<Part> = new Set(Object.keys(MOUNTED) as Part[]);
/** The routes a refusal is logged under (card app-console-429): a mounted route by its own path, the proxy and RPC
 *  routes by their prefix (the vendor or chain is in the reason), anything else "other": never a caller's text. */
const ROUTE_NAMES: ReadonlySet<string> = new Set(["/v1/health", ...Object.values(MOUNTED).flat().filter((p) => !p.endsWith("/"))]);
const routeOf = (path: string): string => (ROUTE_NAMES.has(path) ? path : path.startsWith(PROXY_PREFIX) ? "/v1/proxy" : path.startsWith(RPC_PREFIX) ? "/v1/rpc" : "other");
/** The reason a per-client window names (limits.ts clientWindow): one address past its requests a window. */
const CLIENT_WINDOW = "client window";

// The cross-origin rules are the kit's HELPER_CORS (packages/kit/src/helper/v1.ts).
export const ORIGINS: ReadonlySet<string> = new Set(HELPER_CORS.origins);
const EXPOSE = HELPER_CORS.exposeHeaders.join(", ");
/** Requests one client makes to the pool routes per limit window [design: a device sends one release per tap and reads
 * the fee once an epoch; 30 per 10 s leaves room for a ladder of sells while one client cannot flood the RPC reads]. */
export const POOL_RATE_MAX = 30;
/** Requests one client makes per limit window to every route that has no budget of its own (health, token status,
 * withdraw, bind, market data, an unknown path) [design: 120 per 10 s, a screen's refreshes several times over; the
 * reads behind them are cached and shared, so this bounds only what one client can make the helper do]. */
export const API_RATE_MAX = 120;
/** Requests one client makes per limit window to the RPC route, and apart to the proxy route, counted before the body
 * is read, a refused request and a cache hit included [design: 120 per 10 s, as API_RATE_MAX: above every share a
 * device draws there (RPC_CLIENT_MAX a chain, a vendor's PROXY_BUDGETS share), so an honest device meets its share first,
 * while the bodies one client makes the helper read and parse stay bounded]. */
export const UPSTREAM_ROUTE_MAX = 120;
const METHODS: readonly string[] = HELPER_CORS.allowMethods;
const SHA = /^[0-9a-f]{40}$/;

type Headers = Record<string, string>;

/** The CORS headers of one answer: the request's Origin echoed only when it is one of the two, byte for byte. */
export function cors(req: IncomingMessage): Headers {
  const h: Headers = { Vary: "Origin" };
  const origin = req.headers.origin;
  if (typeof origin === "string" && ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Expose-Headers"] = EXPOSE;
  }
  return h;
}

/** A preflight gets the allow headers only from one of the two origins, for a listed method and no header but content-type. */
function preflight(req: IncomingMessage): Headers {
  const h: Headers = { Vary: "Origin" };
  const origin = req.headers.origin;
  const method = req.headers["access-control-request-method"];
  const asked = (req.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (
    typeof origin === "string" &&
    ORIGINS.has(origin) &&
    typeof method === "string" &&
    METHODS.includes(method) &&
    asked.every((a) => (HELPER_CORS.allowHeaders as readonly string[]).includes(a))
  ) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = METHODS.join(", ");
    h["Access-Control-Allow-Headers"] = HELPER_CORS.allowHeaders.join(", ");
    h["Access-Control-Max-Age"] = String(HELPER_CORS.maxAgeSeconds);
  }
  return h;
}

/** The request body, or undefined once it passes `max` bytes (by its Content-Length or as it arrives). */
function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((ok, fail) => {
    if (Number(req.headers["content-length"] ?? "0") > max) return ok(undefined);
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) {
        req.removeAllListeners("data");
        req.resume();
        return ok(undefined);
      }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

export function handler(
  commit: string,
  proxy: Proxy = createProxy(process.env),
  rpc: Rpc = createRpc(process.env),
  watches: TokenWatches = tokenWatchesFromEnv(process.env),
  lists: Lists = createSolanaLists(proxy, rpc),
  fee: Fee = feeQuoterFromEnv(process.env),
  withdraw: WithdrawSender = withdrawSenderFromEnv(process.env, fee, statusesOf(watches)),
  token: Token = solanaTokenFromEnv(process.env, proxy, lists, rpc),
  bind: BindSender = bindSenderFromEnv(process.env, watches),
  release: number | null = releaseOf(process.env),
  pools: ReadonlyMap<string, SolanaPoolSender> = solanaPoolSendersFromEnv(process.env),
  evmPools: ReadonlyMap<string, EvmPoolSender> = evmPoolSendersFromEnv(process.env),
  // read at each call, so a test's mocked Date is the one clock its timers and the bind's bound share
  now: () => number = () => Date.now(),
  evmLists: EvmLists = {},
  evmSwaps: Swaps = {},
  ready: () => boolean = () => true,
  senders: Promise<unknown> = Promise.resolve(),
  // card helper-solana-failover: each Solana slot keyed, fallback or public (rpc/slot.ts), for /v1/health
  solana: () => Partial<Record<SlotName, SlotState>> = () => ({ rpc: rpc.slot.state() }),
  // card app-console-429: every caller 429, one log line a window per route and reason with its count
  refusals: { count(route: string, why: string): void } = refusalLog(),
) {
  if (!SHA.test(commit)) throw new Error("HELPER_COMMIT must be a full 40-hex commit");
  // GET /v1/token-status serves each network's token from that network's own watch
  const watchOf = new Map<string, TokenWatch>(Object.values(watches).map((w) => [w.token, w]));
  // the per-client limits (limits/limits.ts): in memory for one window, the client's address never logged; the RPC
  // and proxy routes have their own windows and also draw from their upstream's budget (rpc/rpc.ts, proxy/proxy.ts)
  const poolRate = clientWindow(POOL_RATE_MAX, now);
  const apiRate = clientWindow(API_RATE_MAX, now);
  const rpcRate = clientWindow(UPSTREAM_ROUTE_MAX, now);
  const proxyRate = clientWindow(UPSTREAM_ROUTE_MAX, now);
  return (req: IncomingMessage, res: ServerResponse): void => {
    const base: Headers = {
      [HELPER_COMMIT_HEADER]: commit,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const send = (status: number, body: unknown, extra: Headers = {}) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      const h: Headers = { ...base, ...extra };
      if (text) {
        h["Content-Type"] = "application/json; charset=utf-8";
        h["Content-Length"] = String(Buffer.byteLength(text));
      }
      res.writeHead(status, h);
      res.end(req.method === "HEAD" ? undefined : text);
    };
    let route = "other";
    const reply = (a: { status: number; headers?: Headers; body: string; why?: string }) => {
      // a 429, and a 503 a vendor's hold or room answered (card helper-crowd-429: proxy.ts notReady), both named
      if (a.status === 429 || (a.status === 503 && a.why !== undefined)) refusals.count(route, a.why ?? "unnamed");
      const h: Headers = { ...base, ...cors(req), ...a.headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(a.body)) };
      if (a.status === 413) h.Connection = "close";
      res.writeHead(a.status, h);
      res.end(a.body);
    };
    try {
      if (req.method === "OPTIONS") return send(204, undefined, preflight(req));
      let path: string;
      try {
        path = new URL(req.url ?? "/", "http://helper.invalid").pathname;
      } catch {
        return send(400, { error: "bad_request" }, cors(req));
      }
      route = routeOf(path);
      // every route but the pool, RPC and proxy routes (which have their own windows below) counts in the client's window
      if (!path.startsWith(PROXY_PREFIX) && !path.startsWith(RPC_PREFIX) && path !== POOL_FEE && path !== POOL_SOLANA_SEND && path !== POOL_EVM_SEND && path !== POOL_EVM_SELL) {
        const wait = apiRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait, undefined, CLIENT_WINDOW));
      }
      if (path === "/v1/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "method_not_allowed" }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        return send(200, health(commit, SERVED, release, ready(), solana()), cors(req));
      }
      if (path === TOKEN_STATUS) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        // exactly one token, a watched network's (USDC, the testnet token; H7: any other answers 404 token_not_watched)
        const tokens = new URL(req.url ?? "/", "http://helper.invalid").searchParams.getAll("token");
        const watch = tokens.length === 1 ? watchOf.get(tokens[0]!) : undefined;
        if (watch === undefined) return send(404, { error: { code: "token_not_watched" } }, cors(req));
        void watch
          .status()
          .then((s) => send(200, s, cors(req)))
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === WITHDRAW_FEE) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        // the relayer's quote (withdraw/fee.ts): exactly one token, one this relayer carries; reads that fail or
        // disagree answer upstream (503) and quote nothing; a provider's throttle answers 429 with its wait
        const tokens = new URL(req.url ?? "/", "http://helper.invalid").searchParams.getAll("token");
        if (tokens.length !== 1 || fee.networkOf(tokens[0]!) === null) return send(404, { error: { code: "not_found" } }, cors(req));
        // a quote is the senders' (their store keeps it): it waits for them, bounded, as a send does
        void heldWithin(senders)
          .then((held) => (held ? fee.quote(tokens[0]!) : Promise.reject(new FeeReadRefused("the senders are not this helper's yet"))))
          .then((a) => send(200, a, cors(req)))
          .catch((e) => (res.headersSent ? res.destroy() : e instanceof FeeReadRefused ? (throttleOf(e) > 0 ? reply(throttled(throttleOf(e), undefined, "provider limit")) : send(503, { error: { code: "upstream" } }, cors(req))) : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === POOL_FEE) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        const wait = poolRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait, undefined, CLIENT_WINDOW));
        // the relayer's one fee per pool per epoch (pool/fee.ts): exactly one pool this helper carries, and at most one
        // epoch start on the 60 s grid (default: the epoch now) within [now - POOL_LIFE_MAX_MS, now], refused before
        // any read (M356 (3)); the same answer for every caller
        const q = new URL(req.url ?? "/", "http://helper.invalid").searchParams;
        const asked = q.getAll("pool").length === 1 ? q.get("pool")! : "";
        const pool = pools.get(asked) ?? evmPools.get(asked);
        const epochs = q.getAll("epoch");
        if (pool === undefined || epochs.length > 1) return send(404, { error: { code: "not_found" } }, cors(req));
        const nowMs = now();
        if (epochs.length === 1 && (!/^[1-9][0-9]{0,15}$/.test(epochs[0]!) || Number(epochs[0]) % POOL_EPOCH_MS !== 0 || Number(epochs[0]) > nowMs || Number(epochs[0]) < nowMs - POOL_LIFE_MAX_MS)) return send(404, { error: { code: "not_found" } }, cors(req));
        // a Solana fee is the host's; an EVM fee is read from the epoch's first block (null: no block in it yet)
        void Promise.resolve()
          .then((): unknown => pool.fee(epochs.length === 1 ? Number(epochs[0]) : nowMs))
          .then((a) => (a === null ? send(404, { error: { code: "not_found" } }, cors(req)) : send(200, a, cors(req))))
          // a provider's throttle is a wait (429), any other failed read 503
          .catch((e) => (res.headersSent ? res.destroy() : throttleOf(e) > 0 ? reply(throttled(throttleOf(e), undefined, "provider limit")) : send(503, { error: { code: "upstream" } }, cors(req))));
        return;
      }
      if (path === POOL_SOLANA_SEND) {
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        const wait = poolRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait, undefined, CLIENT_WINDOW));
        // pool/solana.ts: { pool, tx }, the pool one this helper carries (else 404 not_found)
        void readBody(req, POOL_SOLANA_BODY_MAX)
          .then(async (text) => {
            if (text === undefined) return { status: 413, body: JSON.stringify({ error: { code: "too_large" } }) };
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              return { status: 400, body: JSON.stringify({ error: { code: "bad_shape" } }) };
            }
            // the pool the body names, one this helper carries (pool/solana.ts checks the transaction is that pool's)
            const name = typeof body === "object" && body !== null ? (body as { pool?: unknown }).pool : undefined;
            const pool = typeof name === "string" ? pools.get(name) : undefined;
            if (pool === undefined) return { status: 404, body: JSON.stringify({ error: { code: "not_found" } }) };
            if (!(await heldWithin(senders))) return SENDERS_LATE;
            const a = await pool.carry(body, clientOf(req));
            return { status: a.status, headers: (a.retryAfterS === undefined ? {} : { "Retry-After": String(a.retryAfterS) }) as Headers, body: JSON.stringify(a.body) };
          })
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === POOL_EVM_SEND || path === POOL_EVM_SELL) {
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        const wait = poolRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait, undefined, CLIENT_WINDOW));
        // pool/evm.ts: a withdraw { pool, data, epoch } or a sell { pool, w, data, authorization }, the pool one this
        // helper carries (else 404 not_found); both draw on the pool's one queue and its held limit per client
        const sell = path === POOL_EVM_SELL;
        void readBody(req, sell ? POOL_EVM_SELL_BODY_MAX : POOL_EVM_BODY_MAX)
          .then(async (text) => {
            if (text === undefined) return { status: 413, body: JSON.stringify({ error: { code: "too_large" } }) };
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              return { status: 400, body: JSON.stringify({ error: { code: "bad_shape" } }) };
            }
            const name = typeof body === "object" && body !== null ? (body as { pool?: unknown }).pool : undefined;
            const pool = typeof name === "string" ? evmPools.get(name) : undefined;
            if (pool === undefined) return { status: 404, body: JSON.stringify({ error: { code: "not_found" } }) };
            if (!(await heldWithin(senders))) return SENDERS_LATE;
            const a = await (sell ? pool.sell(body, clientOf(req)) : pool.carry(body, clientOf(req)));
            return { status: a.status, headers: (a.retryAfterS === undefined ? {} : { "Retry-After": String(a.retryAfterS) }) as Headers, body: JSON.stringify(a.body) };
          })
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === WITHDRAW) {
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        // checks 1-10 and the send (withdraw/send.ts); a body that is not one JSON value is check 1's bad_shape
        void readBody(req, WITHDRAW_BODY_MAX)
          .then(async (text) => {
            if (text === undefined) return { status: 413, body: JSON.stringify({ error: { code: "too_large" } }) };
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              return { status: 400, body: JSON.stringify({ error: { code: "bad_shape" } }) };
            }
            if (!(await heldWithin(senders))) return SENDERS_LATE;
            const a = await withdraw.carry(body);
            return { status: a.status, body: JSON.stringify(a.body) };
          })
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === BIND) {
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        // the deposit carry (bind/env.ts, bind/send.ts carryDeposit with bind/checks.ts); a body that is not one JSON
        // value is check 1's bad_shape
        void readBody(req, BIND_BODY_MAX)
          .then(async (text) => {
            if (text === undefined) return { status: 413, body: JSON.stringify({ error: { code: "too_large" } }) };
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              return { status: 400, body: JSON.stringify({ error: { code: "bad_shape" } }) };
            }
            // the answer's bound runs from here, the wait for the senders inside it: a bind not carried by the bound is
            // refused (nothing sent), one carried answers within what is left of it (in_flight past it)
            const t0 = now();
            if (!(await heldWithin(senders, HELPER_BIND_ANSWER_MS))) return SENDERS_LATE;
            const a = await bindAnswerWithin(bind.carry(body), BIND_LATE, HELPER_BIND_ANSWER_MS - (now() - t0));
            return { status: a.status, body: JSON.stringify(a.body) };
          })
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === MARKET_LISTS) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        // Discover's lists: exactly one chain, Solana (src/data/solana/lists.ts) or an EVM chain this helper serves
        // (src/data/evm/lists.ts)
        const chains = new URL(req.url ?? "/", "http://helper.invalid").searchParams.getAll("chain");
        const evm = chains.length === 1 && Object.hasOwn(evmLists, chains[0]!) ? evmLists[chains[0] as EvmChain] : undefined;
        if (chains.length !== 1 || (chains[0] !== "solana" && evm === undefined)) return send(404, { error: { code: "not_found" } }, cors(req));
        void (evm ?? lists)
          .get()
          .then((a) => {
            const h: Headers = { ...base, ...cors(req), Vary: "Origin, Accept-Encoding", "Content-Type": "application/json; charset=utf-8" };
            if (a.status === 429) return reply(throttled(a.retryAfterS ?? 1, undefined, a.why));
            if (a.status !== 200 || a.asOfMs === undefined) return send(a.status, JSON.parse(a.body), cors(req));
            h[HELPER_SOURCE_HEADER] = evm === undefined ? "jupiter" : "geckoterminal";
            h[HELPER_FETCHED_AT_HEADER] = new Date(a.asOfMs).toISOString();
            const gzip = a.gzip !== undefined && /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
            const out = gzip ? a.gzip! : Buffer.from(a.body, "utf8");
            if (gzip) h["Content-Encoding"] = "gzip";
            h["Content-Length"] = String(out.length);
            res.writeHead(200, h);
            res.end(req.method === "HEAD" ? undefined : out);
          })
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === MARKET_TOKEN || path === MARKET_HOLDERS || path === MARKET_CANDLES || path === MARKET_TRADES) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        // the token page's reads: exactly one chain and exactly one token. Solana's page, holders and candles
        // (src/data/solana/token.ts); candles and trades of an EVM chain whose own swap reads this helper runs
        // (src/data/evm/swaps.ts). Candles also exactly one tf, and at most one `to` (unix seconds) and one `limit` (1 to
        // CANDLES_MAX, default it); trades at most one `limit` (1 to TRADES_MAX, default it)
        const q = new URL(req.url ?? "/", "http://helper.invalid").searchParams;
        const one = (k: string) => (q.getAll(k).length === 1 ? q.get(k)! : null);
        const most = (k: string) => (q.getAll(k).length === 0 ? "" : one(k));
        const chain = one("chain");
        const mint = one("token");
        const swaps = chain !== null && Object.hasOwn(evmSwaps, chain) ? evmSwaps[chain as EvmChain | "solana"] : undefined;
        if (mint === null || (path === MARKET_TRADES ? swaps === undefined : path === MARKET_CANDLES ? chain !== "solana" && swaps === undefined : chain !== "solana")) return send(404, { error: { code: "not_found" } }, cors(req));
        let read: Promise<DataAnswer>;
        if (path === MARKET_TRADES) {
          const limit = most("limit");
          if (limit === null || !/^(|[1-9]\d?)$/.test(limit) || Number(limit) > TRADES_MAX) return send(404, { error: { code: "not_found" } }, cors(req));
          read = swaps!.trades(mint, limit === "" ? TRADES_MAX : Number(limit));
        } else if (path === MARKET_CANDLES) {
          const tf = one("tf");
          const to = most("to");
          const limit = most("limit");
          if (tf === null || to === null || limit === null || !/^(|[1-9]\d{0,10})$/.test(to) || !/^(|[1-9]\d{0,2})$/.test(limit) || Number(limit) > CANDLES_MAX) {
            return send(404, { error: { code: "not_found" } }, cors(req));
          }
          read = swaps !== undefined ? swaps.candles(mint, tf, to === "" ? null : Number(to), limit === "" ? CANDLES_MAX : Number(limit)) : token.candles(mint, tf, to === "" ? null : Number(to), limit === "" ? CANDLES_MAX : Number(limit));
        } else read = path === MARKET_TOKEN ? token.page(mint, clientOf(req)) : token.holders(mint, clientOf(req));
        void read
          .then((a) => {
            if (a.status === 429) return reply(throttled(a.retryAfterS ?? 1, undefined, a.why));
            if (a.status !== 200 || a.asOfMs === undefined) return send(a.status, JSON.parse(a.body), cors(req));
            const h: Headers = { [HELPER_SOURCE_HEADER]: a.src ?? "", [HELPER_FETCHED_AT_HEADER]: new Date(a.asOfMs).toISOString() };
            reply({ status: 200, headers: h, body: a.body }); // node sends no body on a HEAD
          })
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path.startsWith(PROXY_PREFIX)) {
        // counted before anything is read: a refused request and a cache hit spend the window too
        const wait = proxyRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait, undefined, CLIENT_WINDOW));
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        // the raw path, never URL's normalised one: only a path written exactly as on the allowlist is served
        const raw = req.url ?? "";
        const q = raw.indexOf("?");
        const rest = (q === -1 ? raw : raw.slice(0, q)).slice(PROXY_PREFIX.length);
        const slash = rest.indexOf("/");
        if (!raw.startsWith(PROXY_PREFIX) || slash <= 0) return send(404, { error: { code: "not_found" } }, cors(req));
        void readBody(req, PROXY_BODY_MAX)
          .then((body) =>
            body === undefined
              ? { status: 413, headers: {}, body: JSON.stringify({ error: { code: "too_large" } }) }
              : proxy.handle(rest.slice(0, slash), rest.slice(slash), q === -1 ? "" : raw.slice(q + 1), body, clientOf(req)),
          )
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path.startsWith(RPC_PREFIX)) {
        // counted before anything is read, as for the proxy
        const wait = rpcRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait, undefined, CLIENT_WINDOW));
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        // the raw path, as for the proxy: the chain is the one segment after the prefix, written exactly
        const raw = req.url ?? "";
        const q = raw.indexOf("?");
        const chain = (q === -1 ? raw : raw.slice(0, q)).slice(RPC_PREFIX.length);
        if (!raw.startsWith(RPC_PREFIX) || chain === "" || chain.includes("/")) return send(404, { error: { code: "not_found" } }, cors(req));
        void readBody(req, RPC_BODY_MAX)
          .then((body) =>
            body === undefined
              ? { status: 413, body: JSON.stringify({ error: { code: "too_large" } }) }
              : rpc.handle(chain, req.headers["content-type"], body, clientOf(req)),
          )
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      return send(404, { error: "not_found" }, cors(req));
    } catch {
      if (!res.headersSent) send(500, { error: "internal" }, cors(req));
      else res.destroy();
    }
  };
}

/**
 * The token page's reads: the helper's one RPC client, so they draw from the same Solana provider's one budget as every
 * caller (a second client would be a second budget on one provider, and together they could pass its limit), each read
 * from the share of the caller whose request made it, and holders on SOLANA_HOLDERS_RPC_URL when set
 * (src/data/solana/token.ts).
 */
export function solanaTokenFromEnv(env: Record<string, string | undefined>, proxy: Proxy, lists: Lists, rpc: Rpc, gecko?: GeckoBudget, slots?: Map<SlotName, Slot>): Token {
  const holders = env.SOLANA_HOLDERS_RPC_URL;
  // card helper-solana-failover: the holders key's slot has no public fallback (the public endpoint refuses
  // getTokenLargestAccounts, rpc/rpc.ts Deps): fallen back, its reads answer 503 at once and the page serves Jupiter's
  // card helper-crowd-429: the holders key set to the main one is one provider's second, so it shares the main pacer
  const holdersRpc =
    holders === undefined || holders === "" ? undefined : createRpc({ SOLANA_RPC_URL: holders }, { slot: "holders", publicFallback: false, ...(holders === env.SOLANA_RPC_URL ? { pacer: rpc.pacer } : {}) });
  if (holdersRpc !== undefined) slots?.set("holders", holdersRpc.slot);
  return createSolanaToken(proxy, rpc, { gecko, listed: lists.get, holdersRpc });
}

/**
 * The EVM chains' own swap reads (src/data/evm/swaps.ts): Base's and Robinhood's candles and trade tape. A token is
 * served only when its chain's Discover lists hold it. Base's providers are the host's BASE_RPC_URL when set (a keyed
 * one, asked first), then the public ones (SWAP_RPCS); Robinhood's are the public ones.
 */
export function evmSwapsFromEnv(env: Record<string, string | undefined>, evmLists: EvmLists, gecko?: GeckoBudget, holds?: ProviderHolds): Swaps {
  const out: Swaps = {};
  for (const chain of ["base", "robinhood"] as const) {
    const lists = evmLists[chain];
    if (lists === undefined) continue;
    const url = chain === "base" ? env.BASE_RPC_URL : undefined;
    let seen: { asOfMs: number; tokens: Set<string>; pools: Record<string, string> } | null = null;
    // the lists' newest answer, read once per answer: its tokens, and each one's pool as the list names it
    const snapshot = async () => {
      const a = await lists.get();
      if (a.status !== 200 || a.asOfMs === undefined) return null;
      if (seen === null || seen.asOfMs !== a.asOfMs) {
        const snap = JSON.parse(a.body) as { lists: Record<string, { token: string }[]>; pools?: Record<string, string> };
        seen = { asOfMs: a.asOfMs, tokens: new Set(Object.values(snap.lists).flatMap((rows) => rows.map((r) => r.token))), pools: snap.pools ?? {} };
      }
      return seen;
    };
    out[chain] = createSwaps(chain, {
      gecko,
      holds,
      rpcs: url === undefined || url === "" ? SWAP_RPCS[chain] : [url, ...SWAP_RPCS[chain]],
      listed: async (token) => (await snapshot())?.tokens.has(token) ?? false,
      // a hint only: swaps.ts fromHint takes it once the chain says the pool is the token's
      hint: async (token) => {
        const s = await snapshot();
        return s !== null && Object.hasOwn(s.pools, token) ? s.pools[token]! : null;
      },
    });
  }
  return out;
}

/**
 * Solana's own trade reads (src/data/solana/trades.ts): the candles and tape of a token on the Solana Discover lists,
 * the bars before our first from the token page's GeckoTerminal candles. The stream is SOLANA_STREAM_WS_URL when set (a
 * keyed provider's websocket), else the public one; requests go to SOLANA_TRADES_RPC_URL first when set.
 */
export function solanaTradesFromEnv(env: Record<string, string | undefined>, lists: Lists, token: Token, rpc?: Rpc, slots?: Map<SlotName, Slot>): SolanaTrades {
  const ws = env.SOLANA_STREAM_WS_URL;
  const url = env.SOLANA_TRADES_RPC_URL;
  let seen: { asOfMs: number; tokens: Set<string> } | null = null;
  // card helper-solana-failover: the keyed trades provider and stream each fall back to the public one (rpc/slot.ts)
  const slot = createSlot("trades", url !== undefined && url !== "");
  const streamSlot = createSlot("stream", ws !== undefined && ws !== "");
  slots?.set("trades", slot).set("stream", streamSlot);
  return createSolanaTrades({
    slot,
    streamSlot,
    wsUrl: ws === undefined || ws === "" ? undefined : ws,
    rpcs: url === undefined || url === "" ? TRADES_RPCS : [url, ...TRADES_RPCS],
    history: (mint, tf, to, limit) => token.candles(mint, tf, to, limit),
    log: (line) => console.log(`helper: ${line}`),
    // the walks draw the Solana budget callers draw, behind them (rpc.ts userRoomOf)
    ...(rpc === undefined ? {} : { budget: (u: string, m: string) => rpc.background("solana", u, m), throttled: (u: string, h: globalThis.Headers) => rpc.backgroundThrottled("solana", u, h) }),
    listed: async (mint) => {
      const a = await lists.get();
      // no lists answer yet: unknown, never "not listed" (trades.ts listed)
      if (a.status !== 200 || a.asOfMs === undefined) return null;
      if (seen === null || seen.asOfMs !== a.asOfMs) {
        const snap = JSON.parse(a.body) as { lists: Record<string, { token: string }[]> };
        seen = { asOfMs: a.asOfMs, tokens: new Set(Object.values(snap.lists).flatMap((rows) => rows.map((r) => r.token))) };
      }
      return seen.tokens.has(mint);
    },
  });
}

/**
 * The senders' handover (card helper-ready-gate). A deploy starts the new helper next to the old one, and both are
 * pointed at one store (HELPER_STORE_DIR), whose folders one process holds at a time (store/durable.ts). The new one
 * takes the `senders` folder's lock, which the running helper holds for its life, and then builds the fee quoter,
 * which opens its own store; while either is held by the other helper it tries again every `retryMs`, and only once
 * both are its own do its sends go (`held`): the withdrawal and deposit relayers start, and POST /v1/withdraw,
 * /v1/bind and the pool sends wait for it (SENDERS_WAIT_MS), so two helpers never send with one key or write one
 * store. `peer`: another helper held one of them at the start, so this one takes no traffic until it is ready. The
 * fee quoter's network is known from the environment at once (a quoter with no store), its quotes wait for `held`.
 */
export function sendersFromEnv(env: Record<string, string | undefined>, retryMs = 250): { fee: FeeQuoter; held: Promise<void>; peer: boolean } {
  const dir = env[STORE_ENV] ?? "";
  const bare = feeQuoterFromEnv({ ...env, [STORE_ENV]: "" });
  if (dir === "") return { fee: bare, held: Promise.resolve(), peer: false };
  let real: FeeQuoter | null = null;
  const isHeld = (e: unknown) => /is held by another process/.test((e as Error | undefined)?.message ?? "");
  /** One try: the senders lock (kept for the process's life), then the fee quoter; false while another holds either. */
  let sendersLock = false;
  const attempt = (): boolean => {
    try {
      if (!sendersLock) {
        openDurableDir(join(dir, "senders"), nodeFs, () => undefined, 0);
        sendersLock = true;
      }
      // both tries take no wait: a retry runs on the event loop every retryMs, and a lock wait blocks it whole
      real = feeQuoterFromEnv(env, fetch, 0);
      return true;
    } catch (e) {
      if (isHeld(e)) return false;
      throw e;
    }
  };
  const peer = !attempt();
  const held = peer
    ? new Promise<void>((ok, fail) => {
        const t = setInterval(() => {
          try {
            if (attempt()) clearInterval(t), ok();
          } catch (e) {
            clearInterval(t);
            fail(e);
          }
        }, retryMs);
      })
    : Promise.resolve();
  const fee: FeeQuoter = {
    networkOf: (token) => bare.networkOf(token),
    quote: async (token) => (await held, real!.quote(token)),
    reads: (network) => ({ feeMin: async (w) => (await held, real!.reads(network).feeMin(w)) }),
  };
  return { fee, held, peer };
}

/**
 * The warm file's writer (data/warm.ts). The file is the holder's: a peer writes none until `held` (the senders are its
 * own), so the file the old helper writes at its stop is the one the next seeds from, never overwritten by the next
 * one's warm-up before it. A write that fails is skipped: the next helper reads its lists from GeckoTerminal.
 */
export function warmWriter(storeDir: string, held: Promise<unknown>, state: () => Warm): () => void {
  let holds = false;
  void held.then(() => void (holds = true), () => undefined);
  return () => {
    if (!holds) return;
    try {
      writeWarm(storeDir, state());
    } catch {
      // nothing kept
    }
  };
}

/** A token page read is part of being ready: one of the Solana list's tokens. */
type Ready = { lists: Pick<Lists, "get">; evmLists: Record<string, Pick<ReturnType<typeof createEvmLists>, "get">>; token: Pick<Token, "page" | "holders"> };
/** How often the warm-up asks again while not ready. */
export const READY_EVERY_MS = 2_000;
/**
 * Whether this helper is ready (card helper-ready-gate): the Solana list and every EVM chain's lists answer 200, and a
 * Solana token page and its holders answer 200 for a token on the Solana list. Each read is the one a caller makes (and
 * stays cached for them).
 */
export async function isReady(p: Ready): Promise<boolean> {
  const sol = await p.lists.get();
  if (sol.status !== 200) return false;
  for (const l of Object.values(p.evmLists)) if ((await l.get()).status !== 200) return false;
  const snap = JSON.parse(sol.body) as { lists?: Record<string, { token?: unknown }[]> };
  const mint = Object.values(snap.lists ?? {}).flat().find((r) => typeof r?.token === "string")?.token as string | undefined;
  if (mint === undefined) return false;
  const [page, holders] = await Promise.all([p.token.page(mint, READY_CLIENT), p.token.holders(mint, READY_CLIENT)]);
  return page.status === 200 && holders.status === 200;
}
/** The client the warm-up's token reads draw as (a caller's share, the callers' room). */
const READY_CLIENT = "helper-ready";
/** Asks isReady every READY_EVERY_MS until it is true, then resolves. */
export async function warmUntilReady(p: Ready, everyMs = READY_EVERY_MS): Promise<void> {
  for (;;) {
    if (await isReady(p).catch(() => false)) return;
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
}

/**
 * Every pool's start check (card evm-buy-hookdata-fee, review fold 4 MEDIUM-1): each Solana pool's configured fee at its
 * first good rent read (pool/solana.ts ready; a failed read is asked again every `everyMs` until one is good) and each
 * EVM pool's state reads a proof's life back (pool/evm.ts ready). Resolves once all have passed; the first refusal calls
 * `refuse` (main: exit 2) and rejects, so the helper's ready never turns true over a refused start.
 */
export function poolsChecked(pools: ReadonlyMap<string, Pick<SolanaPoolSender, "ready">>, evmPools: ReadonlyMap<string, Pick<EvmPoolSender, "ready">>, refuse: (e: Error) => void, everyMs = READY_EVERY_MS): Promise<void> {
  const sol = [...pools.values()].map((p) => {
    const again = setInterval(() => void p.ready, everyMs);
    again.unref();
    return p.ready.finally(() => clearInterval(again));
  });
  const checks = [...sol, ...[...evmPools.values()].map((p) => p.ready())];
  for (const c of checks) c.catch(refuse);
  return Promise.all(checks).then(() => undefined);
}

export function start(commit: string, port: number, proxy?: Proxy, rpc?: Rpc, watches?: TokenWatches, lists?: Lists, fee?: Fee, withdraw?: WithdrawSender, token?: Token, bind?: BindSender, pools?: ReadonlyMap<string, SolanaPoolSender>, evmLists?: EvmLists, evmSwaps?: Swaps, ready?: () => boolean, senders: Promise<unknown> = Promise.resolve(), solana?: () => Partial<Record<SlotName, SlotState>>, release?: number | null, evmPools?: ReadonlyMap<string, EvmPoolSender>): Server {
  const server = createServer(
    // Caddy keeps its upstream connections idle for 30 s (deploy/Caddyfile); ours outlive that, so no reused
    // connection is closed under a request
    { headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 65_000 },
    handler(commit, proxy, rpc, watches, lists, fee, withdraw, token, bind, release, pools, evmPools, undefined, evmLists, evmSwaps, ready, senders, solana),
  );
  server.listen(port);
  // the relayers start once this process holds the senders (sendersFromEnv): a restart resends their open sends and
  // settles before any request
  void senders.then(() => {
    withdraw?.warm();
    bind?.warm();
  }, () => undefined);
  return server;
}

/**
 * A stop's drain (card helper-ready-gate): `server` takes no new connection, and every connection closes once its answer
 * is out. server.close() alone leaves a connection that is busy at the stop on keep-alive (Node 24), so the proxy sends
 * it more requests and the old helper never drains: an answer that is not out yet says Connection: close, and one
 * already under way ends its connection when it finishes; a request that arrives on a busy connection meanwhile is
 * answered the same way. Returns the drain; call it once at the stop.
 */
export function drainer(server: Server): () => void {
  const inFlight = new Set<ServerResponse>();
  let stopping = false;
  const last = (res: ServerResponse) => {
    if (!res.headersSent) res.setHeader("Connection", "close");
    else res.once("finish", () => res.socket?.end());
  };
  server.prependListener("request", (_req: IncomingMessage, res: ServerResponse) => {
    if (stopping) return last(res);
    inFlight.add(res);
    res.once("close", () => inFlight.delete(res));
  });
  return () => {
    stopping = true;
    for (const res of inFlight) last(res);
    server.close();
    server.closeIdleConnections();
  };
}


/** How long each outbound connect may try one address before the next (node's default is 250 ms): long enough for one
 *  lost SYN (resent at 1 s), so a slow connect is not turned into a 503. Seen 2026-11-03 15:25Z: GeckoTerminal's IPv4
 *  connect past 250 ms, its IPv6 unreachable, the fetch failed at 506 ms (ETIMEDOUT 104.18.0.233; EHOSTUNREACH
 *  2606:4700::6812:1e9) and the token page's candles answered 503 in 5 of 24 reads. */
export const CONNECT_ATTEMPT_MS = 2_000;

if (import.meta.main) {
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS); // every start path (the image's CMD runs this file)
  const commit = process.env.HELPER_COMMIT ?? "";
  const port = Number(process.env.PORT ?? 8080);
  if (!SHA.test(commit)) {
    console.error("helper: HELPER_COMMIT must be a full 40-hex commit");
    process.exit(2);
  }
  const storeDir = process.env.HELPER_STORE_DIR ?? ""; // withdraw/fee.ts STORE_ENV
  let server: Server | null = null;
  let saveWarm = () => undefined as void;
  let drain = () => undefined as void;
  try {
    checkVendorPlans(process.env);
    const proxy = createProxy(process.env);
    // one hold per provider, shared by every path that reads it (card helper-robinhood-capacity: the swap and maker reads
    // and /v1/rpc/robinhood all read rpc.mainnet.chain.robinhood.com)
    const holds = providerHolds();
    // an EVM chain's callers may be answered by the swap reads' pinned providers when its own is held or has no room
    // (rpc.ts callEvm): a user's call never pays for the helper's background load
    const rpc = createRpc(process.env, { holds, pinned: SWAP_RPCS });
    const lists = createSolanaLists(proxy, rpc);
    // the senders' handover (sendersFromEnv): `peer` when the helper this one replaces still runs
    const senders = sendersFromEnv(process.env);
    senders.held.catch((e: Error) => (console.error(`helper: ${e.message}`), process.exit(2)));
    // GeckoTerminal's one keyless budget (src/data/gecko.ts): the Solana token page's candles first, the EVM lists after
    const SERVED_EVM: readonly EvmChain[] = ["base", "robinhood"];
    const gecko = geckoBudget(Date.now);
    const evmLists: EvmLists = Object.fromEntries(SERVED_EVM.map((c) => [c, createEvmLists(c, gecko, { holds })]));
    // card helper-ready-gate: the previous helper's warm file (data/warm.ts) seeds the EVM lists and its GeckoTerminal
    // calls; while it still runs (peer), this one makes no GeckoTerminal call until the handover, then takes its last
    // calls from the file it wrote at its stop. With no file, a replaced helper may have spent the window: none for one.
    const warm = readWarm(storeDir, Date.now());
    if (warm !== null) {
      seedGecko(gecko, warm);
      const whole = SERVED_EVM.map((c) => evmLists[c]!.restore(warm.evm[c])).every(Boolean);
      // held only when the file gave every list: a list it lacks is read now, inside the seeded budget
      if (senders.peer && whole) {
        gecko.hold();
        void senders.held.then(() => (seedGecko(gecko, readWarm(storeDir, Date.now())), gecko.release()));
      }
    } else if (senders.peer) gecko.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => Date.now()));
    let solanaState = (): unknown => undefined;
    saveWarm = warmWriter(storeDir, senders.held, () => ({ at: Date.now(), gecko: gecko.calls(), geckoLists: gecko.calls("lists"), evm: Object.fromEntries(SERVED_EVM.map((c) => [c, evmLists[c]!.state()])), solana: solanaState() }));
    // card helper-solana-failover: every Solana slot's state, for /v1/health
    const slots = new Map<SlotName, Slot>([["rpc", rpc.slot]]);
    const token = solanaTokenFromEnv(process.env, proxy, lists, rpc, gecko, slots);
    // card app-console-429: the token page's answers the previous helper held, at the start and again at the handover
    // (the file it wrote at its stop), so a swap's first loads are answered as the old helper would have answered them
    solanaState = () => token.state();
    if (warm !== null) token.restore(warm.solana);
    if (senders.peer) void senders.held.then(() => token.restore(readWarm(storeDir, Date.now())?.solana));
    const watches = tokenWatchesFromEnv(process.env);
    const fee = senders.fee;
    // each network's carry is held by its own watch only
    const withdraw = withdrawSenderFromEnv(process.env, fee, statusesOf(watches));
    const bind = bindSenderFromEnv(process.env, watches);
    // a Solana pool whose configured fee is not the kit's for the rent both providers read stops the helper (at the
    // pool's first good read, pool/solana.ts ready); a read that fails takes down only that pool (503), never the rest
    const pools = solanaPoolSendersFromEnv(process.env);
    // card helper-ready-without-gt: every part read from the environment is read here, at the start, so a value the
    // helper refuses stops it at once (exit 2, naming the variable). Left to handler()'s defaults they were read only at
    // listen(), which a peer runs once warm, inside a promise: an unhandled rejection, exit 1 with no line of ours, and
    // a restart loop until redeploy.sh's bound (18:55-18:58Z: a partial POOL_EVM_*_BASE_SEPOLIA set)
    const evmPools = evmPoolSendersFromEnv(process.env);
    const release = releaseOf(process.env);
    // card evm-buy-hookdata-fee: an EVM pool RPC that cannot answer the fee's state reads 10 min back stops the start;
    // both pool kinds' start checks run from here, and ready (below) waits for them
    const checked = poolsChecked(pools, evmPools, (e) => (console.error(`helper: ${e.message}`), process.exit(2)));
    const swaps: Swaps = { ...evmSwapsFromEnv(process.env, evmLists, gecko, holds), solana: solanaTradesFromEnv(process.env, lists, token, rpc, slots) };
    lists.warm();
    for (const l of Object.values(evmLists)) l.warm();
    setInterval(saveWarm, TICK_MS).unref();
    // card helper-restart-fresh: the charts callers read lately are re-read ahead of their next read, one GeckoTerminal
    // call at most a tick in its "ahead" lane (data/solana/token.ts ahead), so a swap hands over bars inside the bound
    setInterval(() => void token.ahead().catch(() => undefined), AHEAD_TICK_MS).unref();
    // card helper-crowd-429: GeckoTerminal's calls a minute by lane and read, so a refused chart is named from the log
    setInterval(() => void ((l) => l !== null && console.log(`helper: ${l}`))(gecko.minute()), 60_000).unref();
    // ready (health.ts): once the lists, a token page and its holders answer 200. A helper that replaces a running one
    // (peer) listens only then, so the proxy, which tries each helper of the service in turn, never reaches it cold
    // (deploy/redeploy.sh waits for it, bounded, before it stops the old one); one that starts alone listens at once.
    // Every pool's start check is part of it, so a start that refuses (exit 2) is never ready and the old one stays.
    let ready = false;
    const warmed = Promise.all([warmUntilReady({ lists, evmLists, token }), checked]).then(() => void (ready = true));
    const listen = () => {
      server = start(commit, port, proxy, rpc, watches, lists, fee, withdraw, token, bind, pools, evmLists, swaps, () => ready, senders.held, () => Object.fromEntries([...slots].map(([k, v]) => [k, v.state()])), release, evmPools); // warms both relayers once the senders are ours
      drain = drainer(server);
      server.on("listening", () => console.log(`helper: listening on ${port}, commit ${commit}${ready ? "" : ", warming"}`));
    };
    if (senders.peer) void warmed.then(listen, () => undefined); // a refusal: poolsChecked's exit 2, never a listen
    else {
      listen();
      void warmed.catch(() => undefined);
    }
  } catch (e) {
    console.error(`helper: ${(e as Error).message}`);
    process.exit(2);
  }
  // a stop finishes the requests in flight (the old helper of a deploy's swap): no new connection, idle ones closed,
  // the warm file written for the next helper, exit once the last answer is out or at STOP_MS
  const stop = () => {
    saveWarm();
    if (server === null) process.exit(0);
    server.once("close", () => process.exit(0));
    drain();
    setTimeout(() => process.exit(0), STOP_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
