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
// 403), failing (5xx), answering anything but JSON within the size cap, or whose answer holds its own URL's key in any
// form answers 503 upstream, so the device falls back to its own providers (H2.3).
// Throttling (card helper-abuse-limits, ../limits/limits.ts): each chain's provider is one budget every call draws
// from, the helper's own reads included (RPC_BUDGET_<CHAIN>, default RPC_CHAIN_MAX requests in any 10 s, no caller
// more than RPC_CLIENT_MAX of them a window, a batch drawing one per request in it), and where the provider also limits
// one method (Solana's public endpoint, RPC_METHOD_MAX), each method a budget of its own drawn in the same step. The
// totals sit at the provider's own limits, so no set of callers can make the provider throttle us; a draw past a share
// or a total answers 429 rate_limited with the seconds until it would go ahead. If the provider throttles anyway (its 429), the helper, its one client, holds the chain until the reset
// it named (at most a minute): every draw on that chain, the helper's own reads included, answers 429 with the seconds
// left and nothing reaches the provider. A 503 is never a wait.
//
// Refusals, in the kit's error shape { error: { code } } (v1.ts HelperRpcCode and the common codes):
//   404 not_found           a chain that is not one of RPC_CHAINS;
//   413 too_large           a body over RPC_BODY_MAX bytes, or a batch of more than RPC_BATCH_MAX;
//   400 method_not_allowed  everything else that is not a JSON-RPC request whose every method is on the chain's list:
//                           a content type other than JSON, a body that is not JSON, an empty batch, a request that is
//                           not { jsonrpc: "2.0", id, method, params? } with an integer or string id and object or array
//                           params, and a method off the list in any request of a batch.
import { budgetFromEnv, EVM_LIMIT_CODE, RETRY_AFTER_MAX_S, throttled, upstreamBudget, upstreamRetryAfterS, type BudgetLimits } from "../limits/limits.ts";
import { RPC_BATCH_MAX, RPC_BODY_MAX, RPC_CHAINS, RPC_METHODS, type RpcChain } from "./methods.ts";

export const RPC_ANSWER_MAX = 4 * 1024 * 1024; // a getMultipleAccounts of 100 accounts or an eth_getLogs page fits
export const RPC_TIMEOUT_MS = 10_000; // NEAR send_tx waits for execution; the server's request timeout is 15 s
/**
 * Requests one chain's provider takes from every caller together per 10 s window, unless RPC_BUDGET_<CHAIN> names its
 * plan's: the public Solana endpoint's published limit, "Maximum number of requests per 10 seconds per IP: 100"
 * (solana-foundation/solana-com apps/docs/content/docs/en/references/clusters.mdx:153 at dd6c46a, "Mainnet rate
 * limits", read 2026-11-03 08:31Z). The other chains' public endpoints publish no number (docs.base.org's connecting
 * and faucet pages, docs.fastnear.com, read 08:33Z), so they default to the same, the most conservative known.
 */
export const RPC_CHAIN_MAX = 100;
/**
 * Requests one caller draws per chain per window, unless RPC_BUDGET_<CHAIN> says: what a device's one-transaction
 * trade asks of one provider when it fills within its read burst, from the kit's own pattern
 * (packages/kit/src/trade/solana/send.ts): the send (l.6-8), the burst of C = B/5 = 8 status reads over the keyless
 * B = 40 (l.190-193), and a blockhash read, about 11, rounded up to 16. Six callers at their full share fill the public
 * 100; a trade left undecided past its burst reads up to B - C = 32 statuses in a window (l.197-198), which only a
 * keyed provider's larger RPC_BUDGET_<CHAIN> serves.
 */
export const RPC_CLIENT_MAX = 16;
/**
 * Requests of one method the public Solana endpoint takes in 10 s from every caller together: "Maximum number of
 * requests per 10 seconds per IP for a single RPC: 40" (clusters.mdx:154, the same "Mainnet rate limits" list as
 * RPC_CHAIN_MAX). Without it three callers at their share of one method (3 x 16 getSignatureStatuses) make the
 * endpoint throttle, and its reset holds the chain for every caller. A keyed provider names its own as the third
 * number of RPC_BUDGET_SOLANA, or none (two numbers: no limit per method).
 */
export const RPC_METHOD_MAX = 40;
/**
 * Requests per 10 s kept on each chain (its total and each method's) for the helper's own reads that serve every
 * user, which only those reads may draw, whatever RPC_BUDGET_<CHAIN> says. Solana: Discover's curve reads, one
 * getMultipleAccounts per 100 pump.fun mints (data/solana/lists.ts l.338), of at most 300 rows (three Jupiter lists of
 * limit=100, READS), once per FRESH_MS 12 s refresh: 3 in any 10 s. The other chains: no own reads through here (the
 * token watches and the pool senders read their own providers), so 0. The token page's reads are not in it: they are
 * one per token a caller opens, so they draw that caller's share and stop at the total less this, as callers do.
 */
export const RPC_RESERVE: Readonly<Record<RpcChain, number>> = { solana: 3, base: 0, robinhood: 0, near: 0 };
/** Each chain's budget unless RPC_BUDGET_<CHAIN> says; only Solana's public endpoint publishes a limit per method. */
export const RPC_BUDGETS: Readonly<Record<RpcChain, BudgetLimits & { perMethod?: number }>> = {
  solana: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX, perMethod: RPC_METHOD_MAX },
  base: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  robinhood: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  near: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
};
/** The chains whose providers speak EVM JSON-RPC, where -32005 is a throttle (limits.ts EVM_LIMIT_CODE). */
const EVM_CHAINS: ReadonlySet<string> = new Set(["base", "robinhood"]);
/** The whole seconds an EVM provider's -32005 in `answer` (one answer or a batch) asks to wait, 1 to RETRY_AFTER_MAX_S;
 * 0 when there is none or the chain is not EVM. */
function evmLimited(chain: RpcChain, answer: unknown): number {
  if (!EVM_CHAINS.has(chain)) return 0;
  let wait = 0;
  for (const a of Array.isArray(answer) ? answer : [answer]) {
    const e = (a as { error?: { code?: unknown; data?: { backoff_seconds?: unknown } } } | null)?.error;
    if (e?.code !== EVM_LIMIT_CODE) continue;
    const s = Number(e.data?.backoff_seconds);
    wait = Math.max(wait, Number.isFinite(s) && s > 0 ? Math.min(Math.ceil(s), RETRY_AFTER_MAX_S) : 1);
  }
  return wait;
}
/** The environment variable naming a chain's budget, "<total>,<per client>[,<per method>]" per 10 s; the share at
 * least RPC_BATCH_MAX, so a full batch can be served, and a method's at least that and at most the total. */
export const rpcBudgetEnv = (chain: RpcChain): string => `RPC_BUDGET_${chain.toUpperCase()}`;
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
  const limits = Object.fromEntries(RPC_CHAINS.map((ch) => [ch, { ...budgetFromEnv(env, rpcBudgetEnv(ch), RPC_BUDGETS[ch], { minShare: RPC_BATCH_MAX, perMethod: true, reserve: RPC_RESERVE[ch] }), reserve: RPC_RESERVE[ch] }])) as Record<RpcChain, BudgetLimits & { perMethod?: number }>;
  // a key is a chain, or "<chain> <method>" for one method's budget on it (no share: the chain's share bounds a caller)
  const budget = upstreamBudget((key) => {
    const [ch, method] = key.split(" ") as [RpcChain, string | undefined];
    return method === undefined ? limits[ch] : { total: limits[ch].perMethod!, perClient: Infinity, reserve: RPC_RESERVE[ch] };
  }, now);

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
   * page) pass none: they draw from the provider's total, never a caller's share; `reserved` marks the ones RPC_RESERVE
   * holds room for (Discover's), which alone may draw it.
   */
  async function handle(chain: string, contentType: string | undefined, body: string, client?: string, reserved = false): Promise<Answer> {
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

    // the provider's reset holds every caller, the helper's own reads too; then the call draws on the chain's total (a
    // caller's share too) and each method's, a batch one per request in it, all or none
    const held = budget.heldFor(c);
    if (held > 0) return throttled(held);
    const reqs = (Array.isArray(out) ? out : [out]) as { method: string }[];
    const draws: [string, number][] = [[c, reqs.length]];
    if (limits[c].perMethod !== undefined) for (const r of reqs) draws.push([`${c} ${r.method}`, 1]);
    const wait = budget.takeEach(draws, client, false, reserved);
    if (wait > 0) return throttled(wait);
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
        budget.hold(c, now() + upstreamRetryAfterS(r.headers, now()) * 1000);
        return throttled(budget.heldFor(c));
      }
      text = await readAnswer(r);
    } catch {
      return UPSTREAM();
    }
    if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400)) return UPSTREAM();
    if (text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return UPSTREAM();
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      return UPSTREAM();
    }
    // an EVM provider's -32005 (limits.ts EVM_LIMIT_CODE) in any answer is its throttle, as its 429 is: the chain is held
    // for the backoff it names (Infura's error.data.backoff_seconds), else 1 s
    const limited = evmLimited(c, answer);
    if (limited > 0) {
      budget.hold(c, now() + limited * 1000);
      return throttled(budget.heldFor(c));
    }
    const b = Buffer.from(text, "utf8");
    if (up.forms.some((f) => b.includes(f))) return UPSTREAM();
    return { status: r.status, body: text };
  }

  return { handle };
}
