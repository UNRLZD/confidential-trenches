// One https server for every harness host. A request is routed by its Host header to that host's site: a build dir
// served as static files under the dir's own _headers file (Cloudflare Pages' format, read by the deploy gate's own
// parser), so a header regression in a build shows in the harness. Every request is logged with the host it named.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { parseHeadersFile } from "../../scripts/check-deploy.ts";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Pages' URL patterns: `*` is a splat, `:name` one path segment. */
function patternRegex(p) {
  const src = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:[A-Za-z]\w*/g, "[^/]+");
  return new RegExp(`^${src}$`);
}

/** The headers a dir's _headers file sets on `urlPath`: every matching rule in order, a repeated name joined by ", ". */
export function headersFor(rules, urlPath) {
  const out = new Map();
  for (const r of rules) {
    if (!patternRegex(r.path).test(urlPath)) continue;
    for (const [k, v] of r.headers) {
      const lk = k.toLowerCase();
      out.set(lk, out.has(lk) ? `${out.get(lk)}, ${v}` : v);
    }
    for (const k of r.removes) out.delete(k);
  }
  return out;
}

/**
 * @param {{ cert: Buffer, key: Buffer, sites: Record<string, { root: string, spa?: boolean }> }} opts
 *   sites maps a host name to its build dir; `spa` serves index.html for a path with no file (Pages' default when the
 *   build has no 404.html).
 */
export async function startServer({ cert, key, sites }) {
  const table = new Map();
  for (const [host, s] of Object.entries(sites)) {
    const root = path.resolve(s.root);
    if (!existsSync(path.join(root, "index.html"))) throw new Error(`harness: ${host}'s build ${root} has no index.html`);
    const hf = path.join(root, "_headers");
    const parsed = existsSync(hf) ? parseHeadersFile(readFileSync(hf, "utf8")) : { rules: [], problems: [] };
    if (parsed.problems.length) throw new Error(`harness: ${hf}: ${parsed.problems.join("; ")}`);
    table.set(host.toLowerCase(), { root, spa: !!s.spa, rules: parsed.rules });
  }
  /** @type {{ t: number, host: string, method: string, path: string, status: number, fetchSite: string|null }[]} */
  const log = [];
  const server = createServer({ cert, key }, (req, res) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const rawPath = new URL(req.url ?? "/", "https://x").pathname;
    let urlPath = rawPath;
    try {
      urlPath = decodeURIComponent(rawPath);
    } catch {
      urlPath = "";
    }
    const send = (status, body, headers = {}) => {
      log.push({ t: Date.now(), host, method: req.method ?? "", path: urlPath, status, fetchSite: String(req.headers["sec-fetch-site"] ?? "") || null });
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const site = table.get(host);
    if (!site) return send(421, "no such harness host\n", { "content-type": "text/plain" });
    if (!urlPath) return send(400, "bad path\n", { "content-type": "text/plain" });
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "", { allow: "GET, HEAD" });
    let file = path.join(site.root, urlPath);
    if (!file.startsWith(site.root + path.sep) && file !== site.root) return send(404, "");
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
    // Pages never serves the _headers file itself
    if (path.basename(file) === "_headers" || !existsSync(file)) {
      if (!site.spa) return send(404, "not found\n", { "content-type": "text/plain" });
      file = path.join(site.root, "index.html");
    }
    const headers = Object.fromEntries(headersFor(site.rules, urlPath));
    headers["content-type"] = TYPES[path.extname(file)] ?? "application/octet-stream";
    send(200, readFileSync(file), headers);
  });
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    port,
    log,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
