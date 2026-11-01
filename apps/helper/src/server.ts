/**
 * The helper server (HELPER_HOST, markets paper H7). It holds API keys, never a money key, and logs no request: no
 * line it writes holds a client IP, a path or a header.
 *
 *   HELPER_COMMIT=<40 hex> [PORT=8080] [JUPITER_API_KEY=..] [RELAY_API_KEY=..] [LIFI_API_KEY=..] [ONECLICK_JWT=..]
 *     [SOLANA_RPC_URL=..] [BASE_RPC_URL=..] [ROBINHOOD_RPC_URL=..] [NEAR_RPC_URL=..] [NEAR_RPC_URL_B=..] node src/server.ts
 *
 * The vendor keys come from the host's environment only (src/proxy/vendors.ts); a vendor with no key is called
 * without one. So do the RPC providers' URLs (src/rpc/rpc.ts), where a keyed provider holds its key; a chain with none
 * set uses its public endpoint, and the second NEAR provider USDC's watch reads (NEAR_RPC_URL_B; src/token-status/).
 *
 * Every answer carries X-Helper-Commit and Vary: Origin. Cross-origin reads are allowed for exactly APP_HOST and
 * SIGN_HOST, never `*` and never with credentials (H7 "Cross-origin reads").
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HELPER_COMMIT_HEADER, HELPER_CORS, HELPER_FETCHED_AT_HEADER, HELPER_SOURCE_HEADER } from "@blindfill/kit";
import { createSolanaLists } from "./data/solana/lists.ts";
import { health, type Part } from "./health.ts";
import { createProxy, PROXY_BODY_MAX } from "./proxy/proxy.ts";
import { RPC_BODY_MAX } from "./rpc/methods.ts";
import { createRpc } from "./rpc/rpc.ts";
import { createTokenWatch, USDC } from "./token-status/status.ts";

type Proxy = ReturnType<typeof createProxy>;
type Rpc = ReturnType<typeof createRpc>;
type Watch = ReturnType<typeof createTokenWatch>;
type Lists = ReturnType<typeof createSolanaLists>;
// The routes of every part this server mounts (each path's part is the kit's HELPER_V1_PATHS). /v1/health reads its
// "up" parts from these keys and the dispatch below reads each route from here, so a part is up exactly when its
// routes are mounted.
const MOUNTED = { proxy: ["/v1/proxy/", "/v1/rpc/", "/v1/market/lists"], relay: ["/v1/token-status"] } as const satisfies Partial<Record<Part, readonly string[]>>;
const [PROXY_PREFIX, RPC_PREFIX, MARKET_LISTS] = MOUNTED.proxy;
const [TOKEN_STATUS] = MOUNTED.relay;
const SERVED: ReadonlySet<Part> = new Set(Object.keys(MOUNTED) as Part[]);

// The cross-origin rules are the kit's HELPER_CORS (packages/kit/src/helper/v1.ts).
export const ORIGINS: ReadonlySet<string> = new Set(HELPER_CORS.origins);
const EXPOSE = HELPER_CORS.exposeHeaders.join(", ");
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
  watch: Watch = createTokenWatch(process.env),
  lists: Lists = createSolanaLists(proxy, rpc),
) {
  if (!SHA.test(commit)) throw new Error("HELPER_COMMIT must be a full 40-hex commit");
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
      if (path === "/v1/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "method_not_allowed" }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        return send(200, health(commit, SERVED), cors(req));
      }
      if (path === TOKEN_STATUS) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: { code: "method_not_allowed" } }, { ...cors(req), Allow: "GET, HEAD, OPTIONS" });
        // exactly one token, the release's USDC (H7: any other answers 404 token_not_watched)
        const tokens = new URL(req.url ?? "/", "http://helper.invalid").searchParams.getAll("token");
        if (tokens.length !== 1 || tokens[0] !== USDC) return send(404, { error: { code: "token_not_watched" } }, cors(req));
        void watch
          .status()
          .then((s) => send(200, s, cors(req)))
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
      if (path.startsWith(PROXY_PREFIX)) {
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
              : proxy.handle(rest.slice(0, slash), rest.slice(slash), q === -1 ? "" : raw.slice(q + 1), body),
          )
          .then(reply)
          .catch(() => (res.headersSent ? res.destroy() : send(500, { error: "internal" }, cors(req))));
        return;
      }
      if (path.startsWith(RPC_PREFIX)) {
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
              : rpc.handle(chain, req.headers["content-type"], body),
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

export function start(commit: string, port: number, proxy?: Proxy, rpc?: Rpc, watch?: Watch, lists?: Lists): Server {
  const server = createServer(
    // Caddy keeps its upstream connections idle for 30 s (deploy/Caddyfile); ours outlive that, so no reused
    // connection is closed under a request
    { headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 65_000 },
    handler(commit, proxy, rpc, watch, lists),
  );
  server.listen(port);
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
    server = start(commit, port, proxy, rpc, undefined, lists);
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
