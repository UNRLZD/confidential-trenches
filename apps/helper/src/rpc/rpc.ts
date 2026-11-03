// POST /v1/rpc/{chain} (markets paper H7 row, M:3335, with 7.1's LD1 reads, M:3275): a JSON-RPC request, or a batch of
// 1 to RPC_BATCH_MAX, forwarded to the chain's one configured provider only when every method in it is on the chain's
// allowlist (methods.ts, the kit's list). The helper is never an open RPC: anything else is refused before any call.
// Nothing the provider answers is trusted for anything signed (H2.4, LD1): the device takes every gating read on two
// providers, at least one reached device-direct, so this path can only make it refuse.
//
// What reaches the provider: the request re-written from what was checked (jsonrpc, id, method, params; numbers kept
// digit for digit), never the caller's bytes, so a key the checker and the provider read differently (a repeated
// "method", say) cannot carry an unlisted method; and content-type: application/json. No header of the caller.
// What reaches the caller: the provider's status and JSON body. A provider that is down, slow, refusing our key (401,
// 403), out of quota (429), failing (5xx), answering anything but JSON within the size cap, or whose answer holds its
// own URL's key in any form answers 503 upstream, so the device falls back to its own providers (H2.3).
// Throttling (card helper-abuse-limits, ../limits/limits.ts): each chain's provider is one budget every caller draws
// from, RPC_CHAIN_MAX requests a window, and no caller more than RPC_CLIENT_MAX of them; a draw past either answers 429
// rate_limited with the seconds to the window's end. A provider's own 429 is answered to the caller that drew it, as
// 429 with the provider's reset (at most a minute), and pauses nobody else. A 503 is never a wait.
//
// Refusals, in the kit's error shape { error: { code } } (v1.ts HelperRpcCode and the common codes):
//   404 not_found           a chain that is not one of RPC_CHAINS;
//   413 too_large           a body over RPC_BODY_MAX bytes, or a batch of more than RPC_BATCH_MAX;
//   400 method_not_allowed  everything else that is not a JSON-RPC request whose every method is on the chain's list:
//                           a content type other than JSON, a body that is not JSON, an empty batch, a request that is
//                           not { jsonrpc: "2.0", id, method, params? } with an integer or string id and object or array
//                           params, and a method off the list in any request of a batch.
import { throttled, upstreamBudget, upstreamRetryAfterS } from "../limits/limits.ts";
import { RPC_BATCH_MAX, RPC_BODY_MAX, RPC_CHAINS, RPC_METHODS, type RpcChain } from "./methods.ts";

export const RPC_ANSWER_MAX = 4 * 1024 * 1024; // a getMultipleAccounts of 100 accounts or an eth_getLogs page fits
export const RPC_TIMEOUT_MS = 10_000; // NEAR send_tx waits for execution; the server's request timeout is 15 s
/** Requests one chain's provider takes from every caller together per limit window [design: 50 a second, under a
 * paid provider plan's rate; a provider that allows less answers its own 429, which goes to the caller that drew it]. */
export const RPC_CHAIN_MAX = 500;
/** Requests one caller draws per chain per window [design: 10 a second, about twice a device's busiest trade; a fifth
 * of the chain's, so it takes five callers at their full share to throttle anyone else]. */
export const RPC_CLIENT_MAX = 100;
const ID_MAX = 128;

/**
 * Each chain's provider: the URL in the host's environment (a keyed provider puts its key in the URL, markets paper
 * H2.1), else a public endpoint, so a helper anyone runs works with no key. Each default answered a read from the
 * Mac on 2026-11-01 06:24Z (getBlockHeight, eth_blockNumber, block).
 */
export const RPC_UPSTREAMS: Readonly<Record<RpcChain, { env: string; fallback: string }>> = {
  solana: { env: "SOLANA_RPC_URL", fallback: "https://api.mainnet-beta.solana.com" },
  base: { env: "BASE_RPC_URL", fallback: "https://mainnet.base.org" },
  robinhood: { env: "ROBINHOOD_RPC_URL", fallback: "https://rpc.mainnet.chain.robinhood.com" },
  near: { env: "NEAR_RPC_URL", fallback: "https://rpc.mainnet.fastnear.com" },
};

export type RpcAnswer = { status: number; body: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Deps = { fetch?: Fetch; now?: () => number };
type Answer = RpcAnswer & { headers?: Record<string, string> };
type Upstream = { url: string; forms: Buffer[] };

const error = (status: number, code: string): RpcAnswer => ({ status, body: JSON.stringify({ error: { code } }) });
const REFUSED = () => error(400, "method_not_allowed");
const UPSTREAM = () => error(503, "upstream");

/** Every form a secret could leave in: as set, base64, base64url and URL-encoded. */
function forms(secrets: string[]): Buffer[] {
  const out = new Set<string>();
  for (const s of secrets) {
    const b = Buffer.from(s, "utf8");
    for (const f of [s, b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(s)]) out.add(f);
  }
  return [...out].map((f) => Buffer.from(f, "utf8"));
}

/**
 * The providers this host uses. A URL set in the environment must be http(s) with no fragment; the start stops on any
 * other, naming the variable, never the value. Its secret parts (the URL itself, user and password, every query value
 * and every path segment of 16 characters or more, where providers put keys) are what an answer must never hold.
 */
export function readUpstreams(env: Record<string, string | undefined>): Record<RpcChain, Upstream> {
  const out = {} as Record<RpcChain, Upstream>;
  for (const chain of RPC_CHAINS) {
    const { env: name, fallback } = RPC_UPSTREAMS[chain];
    const set = env[name];
    if (set === undefined || set === "") {
      out[chain] = { url: fallback, forms: [] };
      continue;
    }
    let u: URL;
    try {
      u = new URL(set);
    } catch {
      throw new Error(`${name} must be an http(s) URL`);
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hash !== "" || /\s/.test(set)) throw new Error(`${name} must be an http(s) URL with no fragment`);
    const secrets = [set, u.href, u.username, u.password, ...u.searchParams.values(), ...u.pathname.split("/").filter((s) => s.length >= 16)];
    out[chain] = { url: set, forms: forms(secrets.filter((s) => s.length >= 8)) };
  }
  return out;
}

/** The caller's body parsed with every number kept as written (a u64 slot or lamports past 2^53 included). */
function parse(text: string): unknown {
  const keep = (_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === "number" && ctx?.source !== undefined && !(Number.isSafeInteger(v) && String(v) === ctx.source)
      ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(ctx.source)
      : v;
  return JSON.parse(text, keep as (k: string, v: unknown) => unknown);
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** One checked request, rebuilt from its four fields only, or undefined. */
function check(chain: RpcChain, r: unknown): Record<string, unknown> | undefined {
  if (!isPlain(r)) return undefined;
  for (const k of Object.keys(r)) if (k !== "jsonrpc" && k !== "id" && k !== "method" && k !== "params") return undefined;
  if (r.jsonrpc !== "2.0") return undefined;
  const id = r.id;
  if (!((typeof id === "number" && Number.isSafeInteger(id)) || (typeof id === "string" && id.length <= ID_MAX))) return undefined;
  if (typeof r.method !== "string" || !RPC_METHODS[chain].includes(r.method)) return undefined;
  if (Object.hasOwn(r, "params") && !isPlain(r.params) && !Array.isArray(r.params)) return undefined;
  const out: Record<string, unknown> = { jsonrpc: "2.0", id, method: r.method };
  if (Object.hasOwn(r, "params")) out.params = r.params;
  return out;
}

export function createRpc(env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const upstreams = readUpstreams(env);
  const budget = upstreamBudget(RPC_CHAIN_MAX, RPC_CLIENT_MAX, now);

  async function readAnswer(r: Response): Promise<string | undefined> {
    if (Number(r.headers.get("content-length") ?? "0") > RPC_ANSWER_MAX) return undefined;
    if (!r.body) return "";
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.byteLength;
      if (n > RPC_ANSWER_MAX) return undefined;
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /**
   * One call: `chain` as the caller wrote it, `contentType` its Content-Type header, `body` the request body, `client`
   * the caller's address (../limits/limits.ts clientOf). The helper's own cached reads (Discover's lists, the token
   * page) pass none and draw from no caller's share.
   */
  async function handle(chain: string, contentType: string | undefined, body: string, client?: string): Promise<Answer> {
    if (!(RPC_CHAINS as readonly string[]).includes(chain)) return error(404, "not_found");
    const c = chain as RpcChain;
    if (Buffer.byteLength(body) > RPC_BODY_MAX) return error(413, "too_large");
    if (!/^application\/json\s*(;|$)/i.test(contentType ?? "")) return REFUSED();
    let parsed: unknown;
    try {
      parsed = parse(body);
    } catch {
      return REFUSED();
    }
    let out: unknown;
    if (Array.isArray(parsed)) {
      if (parsed.length > RPC_BATCH_MAX) return error(413, "too_large");
      if (parsed.length === 0) return REFUSED();
      const checked = parsed.map((r) => check(c, r));
      if (checked.some((r) => r === undefined)) return REFUSED();
      out = checked;
    } else {
      out = check(c, parsed);
      if (out === undefined) return REFUSED();
    }
    let forward: string;
    try {
      forward = JSON.stringify(out);
    } catch {
      return REFUSED(); // nesting too deep to write back
    }

    if (client !== undefined) {
      const wait = budget.take(c, client);
      if (wait > 0) return throttled(wait);
    }
    const up = upstreams[c];
    let r: Response;
    let text: string | undefined;
    try {
      r = await doFetch(up.url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: forward,
        redirect: "error",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (r.status === 429) {
        await r.body?.cancel();
        return throttled(upstreamRetryAfterS(r.headers, now()));
      }
      text = await readAnswer(r);
    } catch {
      return UPSTREAM();
    }
    if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400)) return UPSTREAM();
    if (text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return UPSTREAM();
    try {
      JSON.parse(text);
    } catch {
      return UPSTREAM();
    }
    const b = Buffer.from(text, "utf8");
    if (up.forms.some((f) => b.includes(f))) return UPSTREAM();
    return { status: r.status, body: text };
  }

  return { handle };
}
