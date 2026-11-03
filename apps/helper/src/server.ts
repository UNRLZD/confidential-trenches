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
import { HELPER_BIND_ANSWER_MS, HELPER_CODE_STATUS, HELPER_COMMIT_HEADER, HELPER_CORS, HELPER_FETCHED_AT_HEADER, HELPER_SOURCE_HEADER } from "@blindfill/kit";
import { createSolanaLists } from "./data/solana/lists.ts";
import { CANDLES_MAX, createSolanaToken, type DataAnswer } from "./data/solana/token.ts";
import { health, releaseOf, type Part } from "./health.ts";
import { createProxy, PROXY_BODY_MAX } from "./proxy/proxy.ts";
import { RPC_BODY_MAX } from "./rpc/methods.ts";
import { createRpc } from "./rpc/rpc.ts";
import { BIND_MAX_BYTES } from "./bind/checks.ts";
import { bindSenderFromEnv, type BindSender } from "./bind/env.ts";
import { statusesOf, tokenWatchesFromEnv, type TokenWatch, type TokenWatches } from "./token-status/status.ts";
import { feeQuoterFromEnv, FeeReadRefused } from "./withdraw/fee.ts";
import { withdrawSenderFromEnv, type WithdrawSender } from "./withdraw/send.ts";
import { POOL_EPOCH_MS } from "./pool/fee.ts";
import { POOL_SOLANA_BODY_MAX, solanaPoolSendersFromEnv, type SolanaPoolSender } from "./pool/solana.ts";
import { evmPoolSendersFromEnv, POOL_EVM_BODY_MAX, POOL_LIFE_MAX_MS, type EvmPoolSender } from "./pool/evm.ts";
import { clientOf, clientWindow, throttled, throttleOf } from "./limits/limits.ts";

type Proxy = ReturnType<typeof createProxy>;
type Rpc = ReturnType<typeof createRpc>;
type Lists = ReturnType<typeof createSolanaLists>;
type Token = ReturnType<typeof createSolanaToken>;
type Fee = ReturnType<typeof feeQuoterFromEnv>;
// The routes of every part this server mounts (each path's part is the kit's HELPER_V1_PATHS). /v1/health reads its
// "up" parts from these keys and the dispatch below reads each route from here, so a part is up exactly when its
// routes are mounted.
const MOUNTED = { proxy: ["/v1/proxy/", "/v1/rpc/", "/v1/market/lists", "/v1/market/token", "/v1/market/holders", "/v1/market/candles"], relay: ["/v1/token-status", "/v1/withdraw/fee", "/v1/withdraw", "/v1/pool/fee", "/v1/pool/solana/send", "/v1/pool/evm/send"], delegate: ["/v1/bind"] } as const satisfies Partial<Record<Part, readonly string[]>>;
const [PROXY_PREFIX, RPC_PREFIX, MARKET_LISTS, MARKET_TOKEN, MARKET_HOLDERS, MARKET_CANDLES] = MOUNTED.proxy;
const [TOKEN_STATUS, WITHDRAW_FEE, WITHDRAW, POOL_FEE, POOL_SOLANA_SEND, POOL_EVM_SEND] = MOUNTED.relay;
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
function bindAnswerWithin<A>(carry: Promise<A>, late: A): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<A>((ok) => (timer = setTimeout(() => ok(late), HELPER_BIND_ANSWER_MS)));
  return Promise.race([carry, bound]).finally(() => clearTimeout(timer));
}
const BIND_LATE = { status: (HELPER_CODE_STATUS as Record<string, number>).in_flight ?? 400, body: { error: { code: "in_flight" as const } } };
const SERVED: ReadonlySet<Part> = new Set(Object.keys(MOUNTED) as Part[]);

// The cross-origin rules are the kit's HELPER_CORS (packages/kit/src/helper/v1.ts).
export const ORIGINS: ReadonlySet<string> = new Set(HELPER_CORS.origins);
// and Retry-After (card helper-abuse-limits, M367 (2)): every 429 names its wait, which a browser reads only when exposed
const EXPOSE = [...HELPER_CORS.exposeHeaders, "Retry-After"].join(", ");
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
  now: () => number = Date.now,
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
    const reply = (a: { status: number; headers?: Headers; body: string }) => {
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
      // every route but the pool, RPC and proxy routes (which have their own windows below) counts in the client's window
      if (!path.startsWith(PROXY_PREFIX) && !path.startsWith(RPC_PREFIX) && path !== POOL_FEE && path !== POOL_SOLANA_SEND && path !== POOL_EVM_SEND) {
        const wait = apiRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait));
      }
      if (path === "/v1/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "method_not_allowed" }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        return send(200, health(commit, SERVED, release), cors(req));
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
        void fee
          .quote(tokens[0]!)
          .then((a) => send(200, a, cors(req)))
          .catch((e) => (res.headersSent ? res.destroy() : e instanceof FeeReadRefused ? (throttleOf(e) > 0 ? reply(throttled(throttleOf(e))) : send(503, { error: { code: "upstream" } }, cors(req))) : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === POOL_FEE) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        const wait = poolRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait));
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
          .catch((e) => (res.headersSent ? res.destroy() : throttleOf(e) > 0 ? reply(throttled(throttleOf(e))) : send(503, { error: { code: "upstream" } }, cors(req))));
        return;
      }
      if (path === POOL_SOLANA_SEND) {
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        const wait = poolRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait));
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
            const a = await pool.carry(body, clientOf(req));
            return { status: a.status, headers: (a.retryAfterS === undefined ? {} : { "Retry-After": String(a.retryAfterS) }) as Headers, body: JSON.stringify(a.body) };
          })
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === POOL_EVM_SEND) {
        if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "POST, OPTIONS" });
        const wait = poolRate.take(clientOf(req));
        if (wait > 0) return reply(throttled(wait));
        // pool/evm.ts: { pool, data }, the pool one this helper carries (else 404 not_found)
        void readBody(req, POOL_EVM_BODY_MAX)
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
            const a = await pool.carry(body, clientOf(req));
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
            const a = await bindAnswerWithin(bind.carry(body), BIND_LATE);
            return { status: a.status, body: JSON.stringify(a.body) };
          })
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path === MARKET_LISTS) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        // Discover's lists (src/data/solana/lists.ts): exactly one chain, and Solana is the one served so far
        const chains = new URL(req.url ?? "/", "http://helper.invalid").searchParams.getAll("chain");
        if (chains.length !== 1 || chains[0] !== "solana") return send(404, { error: { code: "not_found" } }, cors(req));
        void lists
          .get()
          .then((a) => {
            const h: Headers = { ...base, ...cors(req), Vary: "Origin, Accept-Encoding", "Content-Type": "application/json; charset=utf-8" };
            if (a.status === 429) return reply(throttled(a.retryAfterS ?? 1));
            if (a.status !== 200 || a.asOfMs === undefined) return send(a.status, JSON.parse(a.body), cors(req));
            h[HELPER_SOURCE_HEADER] = "jupiter";
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
      if (path === MARKET_TOKEN || path === MARKET_HOLDERS || path === MARKET_CANDLES) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        // the token page's reads (src/data/solana/token.ts): exactly one chain, Solana, and exactly one token; candles
        // also exactly one tf, and at most one `to` (unix seconds) and one `limit` (1 to CANDLES_MAX, default it)
        const q = new URL(req.url ?? "/", "http://helper.invalid").searchParams;
        const one = (k: string) => (q.getAll(k).length === 1 ? q.get(k)! : null);
        const most = (k: string) => (q.getAll(k).length === 0 ? "" : one(k));
        const chain = one("chain");
        const mint = one("token");
        if (chain !== "solana" || mint === null) return send(404, { error: { code: "not_found" } }, cors(req));
        let read: Promise<DataAnswer>;
        if (path === MARKET_CANDLES) {
          const tf = one("tf");
          const to = most("to");
          const limit = most("limit");
          if (tf === null || to === null || limit === null || !/^(|[1-9]\d{0,10})$/.test(to) || !/^(|[1-9]\d{0,2})$/.test(limit) || Number(limit) > CANDLES_MAX) {
            return send(404, { error: { code: "not_found" } }, cors(req));
          }
          read = token.candles(mint, tf, to === "" ? null : Number(to), limit === "" ? CANDLES_MAX : Number(limit));
        } else read = path === MARKET_TOKEN ? token.page(mint) : token.holders(mint);
        void read
          .then((a) => {
            if (a.status === 429) return reply(throttled(a.retryAfterS ?? 1));
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
        if (wait > 0) return reply(throttled(wait));
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
        if (wait > 0) return reply(throttled(wait));
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
 * caller (no caller's share; a second client would be a second budget on one provider, and together they could pass
 * its limit), and holders on SOLANA_HOLDERS_RPC_URL when set (src/data/solana/token.ts).
 */
export function solanaTokenFromEnv(env: Record<string, string | undefined>, proxy: Proxy, lists: Lists, rpc: Rpc): Token {
  const holders = env.SOLANA_HOLDERS_RPC_URL;
  return createSolanaToken(proxy, rpc, {
    listed: lists.get,
    holdersRpc: holders === undefined || holders === "" ? undefined : createRpc({ SOLANA_RPC_URL: holders }),
  });
}

export function start(commit: string, port: number, proxy?: Proxy, rpc?: Rpc, watches?: TokenWatches, lists?: Lists, fee?: Fee, withdraw?: WithdrawSender, token?: Token, bind?: BindSender, pools?: ReadonlyMap<string, SolanaPoolSender>): Server {
  const server = createServer(
    // Caddy keeps its upstream connections idle for 30 s (deploy/Caddyfile); ours outlive that, so no reused
    // connection is closed under a request
    { headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 65_000 },
    handler(commit, proxy, rpc, watches, lists, fee, withdraw, token, bind, undefined, pools),
  );
  server.listen(port);
  // the relayers start with the helper: a restart resends their open sends and settles before any request
  withdraw?.warm();
  bind?.warm();
  return server;
}

if (import.meta.main) {
  const commit = process.env.HELPER_COMMIT ?? "";
  const port = Number(process.env.PORT ?? 8080);
  if (!SHA.test(commit)) {
    console.error("helper: HELPER_COMMIT must be a full 40-hex commit");
    process.exit(2);
  }
  let server: Server;
  try {
    const proxy = createProxy(process.env);
    const rpc = createRpc(process.env);
    const lists = createSolanaLists(proxy, rpc);
    const watches = tokenWatchesFromEnv(process.env);
    const fee = feeQuoterFromEnv(process.env);
    // each network's carry is held by its own watch only
    const withdraw = withdrawSenderFromEnv(process.env, fee, statusesOf(watches));
    const bind = bindSenderFromEnv(process.env, watches);
    // a Solana pool whose configured fee is not the kit's for the rent both providers read stops the helper (at the
    // pool's first good read, pool/solana.ts ready); a read that fails takes down only that pool (503), never the rest
    const pools = solanaPoolSendersFromEnv(process.env);
    for (const p of pools.values()) p.ready.catch((e: Error) => (console.error(`helper: ${e.message}`), process.exit(2)));
    server = start(commit, port, proxy, rpc, watches, lists, fee, withdraw, undefined, bind, pools); // warms both relayers
    lists.warm();
  } catch (e) {
    console.error(`helper: ${(e as Error).message}`);
    process.exit(2);
  }
  server.on("listening", () => console.log(`helper: listening on ${port}, commit ${commit}`));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
