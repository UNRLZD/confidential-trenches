/**
 * The helper server (HELPER_HOST, markets paper H7). It holds API keys, never a money key, and logs no request: no
 * line it writes holds a client IP, a path or a header.
 *
 *   HELPER_COMMIT=<40 hex> [PORT=8080] node src/server.ts
 *
 * Every answer carries X-Helper-Commit and Vary: Origin. Cross-origin reads are allowed for exactly APP_HOST and
 * SIGN_HOST, never `*` and never with credentials (H7 "Cross-origin reads").
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { health } from "./health.ts";

export const ORIGINS: ReadonlySet<string> = new Set([
  "https://confidential.unrealized.trade",
  "https://sign.confidential.unrealized.trade",
]);
const EXPOSE = "X-Helper-Commit, X-Helper-Source, X-Fetched-At";
const METHODS = ["GET", "POST", "PUT", "DELETE"];
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
    asked.every((a) => a === "content-type")
  ) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = METHODS.join(", ");
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

export function handler(commit: string) {
  if (!SHA.test(commit)) throw new Error("HELPER_COMMIT must be a full 40-hex commit");
  return (req: IncomingMessage, res: ServerResponse): void => {
    const base: Headers = {
      "X-Helper-Commit": commit,
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
        return send(200, health(commit), cors(req));
      }
      return send(404, { error: "not_found" }, cors(req));
    } catch {
      if (!res.headersSent) send(500, { error: "internal" }, cors(req));
      else res.destroy();
    }
  };
}

export function start(commit: string, port: number): Server {
  const server = createServer(
    // Caddy keeps its upstream connections idle for 30 s (deploy/Caddyfile); ours outlive that, so no reused
    // connection is closed under a request
    { headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 65_000 },
    handler(commit),
  );
  server.listen(port);
  return server;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commit = process.env.HELPER_COMMIT ?? "";
  const port = Number(process.env.PORT ?? 8080);
  if (!SHA.test(commit)) {
    console.error("helper: HELPER_COMMIT must be a full 40-hex commit");
    process.exit(2);
  }
  const server = start(commit, port);
  server.on("listening", () => console.log(`helper: listening on ${port}, commit ${commit}`));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
