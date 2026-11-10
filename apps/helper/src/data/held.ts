// GET /v1/market/held: the symbol, name and USD price of each token a device holds, on Solana, Base and Robinhood, in
// one request (card market-token-reads). Portfolio needs them for tokens that are no longer in Discover's lists, which
// the token page (solana/token.ts, evm/token.ts) answers 404 for on the EVM chains.
//
// Sources, per chain:
//   - solana: each mint through the token page (solana/token.ts page), whose caches the token screen shares; read in
//     parallel. A mint the page does not answer 200 for is an entry of nulls.
//   - base and robinhood: the chain's current lists rows for a token they hold; for the rest ONE DexScreener call,
//     `tokens/v1/<chainId>/<a>,<b>,...` (docs.dexscreener.com/api/reference, read 2026-11-10 05:40Z: "Get one or
//     multiple pairs by token address (rate-limit 300 requests per minute)", up to 30 addresses; live reads 05:39Z
//     answered a list of pairs {chainId, dexId, pairAddress, baseToken {address, name, symbol}, quoteToken, priceUsd,
//     liquidity {usd}} for Base USDC and a Robinhood token, chainIds "base" and "robinhood"). Each token is named by
//     the pair of the deepest liquidity whose base token it is. Never GeckoTerminal: its keyless budget is 5 calls in
//     75 s for the whole helper and is the token page's and the charts' (gecko.ts); held there, a token no list carries
//     was refused whenever the helper's own lists and ahead reads held 3 of the 5, and named null (live run
//     42760975418, Base USDC, 05:16Z), and a held read took a call a cold page needed. DexScreener's own budget
//     (DEX_LIMITS) holds every caller to a share, so no address's reads take another's. Each token's answer is held
//     HELD_FRESH_MS, at most CACHE_MAX tokens.
//
// Display only: nothing here feeds a signature. Every upstream answer is hostile input: an entry is used only when it
// names the asked token on the asked chain, strings are bounded and a price is a plain decimal or null.
import { GT_SERVE_MS } from "./gecko.ts";
import { evmAddress, type EvmChain } from "./evm/lists.ts";
import { address, text } from "./solana/lists.ts";
import { CACHE_MAX, type DataAnswer } from "./solana/token.ts";
import { upstreamBudget, type BudgetLimits } from "../limits/limits.ts";

/** The most tokens one request names [design: DexScreener's tokens/v1 takes at most 30 addresses]. */
export const HELD_MAX = 30;
/** A token's DexScreener answer is held this long, so a refresh inside a minute makes no call [design: a price is
 *  display data, and DexScreener's own answer is cached 30 s at its edge (cache-control max-age=30, read 05:4xZ)]. */
export const HELD_FRESH_MS = 60_000;
/** A token's name and price read this long ago is served when it cannot be read again (the budget refused or the call
 *  failed): the market routes' freshness bound (gecko.ts GT_SERVE_MS). */
export const HELD_SERVE_MS = GT_SERVE_MS;
export const DEX_BASE = "https://api.dexscreener.com";
/** DexScreener's chainId of each EVM chain (live reads 2026-11-10 05:39Z). */
export const DEX_CHAIN: Readonly<Record<EvmChain, string>> = { base: "base", robinhood: "robinhood" };
/** DexScreener's budget [design: its documented 300 calls a minute, less a fifth for the sliding window's second and
 *  any other process on our address; a caller draws at most 10 calls a 10 s window (limits.ts LIMIT_WINDOW_MS), a
 *  device's Portfolio refresh being one call a chain, so one address sending fresh addresses holds at most 60 of the
 *  240 a minute and a name read before is served meanwhile (HELD_SERVE_MS)]. */
export const DEX_LIMITS: BudgetLimits = { total: 240, perClient: 10, windowMs: 60_000 };
const DEX_KEY = "dexscreener";
const ANSWER_MAX = 256 * 1024;
const TIMEOUT_MS = 8_000;
/** A plain decimal string of at most 30 digits and 40 decimals: no sign, exponent, "NaN" or hex. */
const PRICE = /^\d{1,30}(\.\d{1,40})?$/;

export type HeldChain = "solana" | EvmChain;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Entry = { symbol: string | null; name: string | null; price_usd: string | null };
type Source = { entry: Entry; src: string; at: number };
/** `named`: a source named the token; `absent`: the sources answered and none names it; `refused`: the budget said no;
 *  `failed`: a read failed. */
type Outcome = { kind: "named"; source: Source } | { kind: "absent" } | { kind: "refused" } | { kind: "failed" };

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const price = (v: unknown): string | null => (typeof v === "string" && PRICE.test(v) ? v : null);
/** The entry a source's fields make, or null when they name neither a symbol nor a name. */
function entryOf(symbol: unknown, name: unknown, usd: unknown): Entry | null {
  const s = text(symbol, 32);
  const n = text(name, 64) ?? s;
  return s === null && n === null ? null : { symbol: s, name: n, price_usd: price(usd) };
}

/**
 * The chain and tokens of a request's query, or null for anything else (answered 404 before any read): exactly one
 * `chain` of solana, base and robinhood, 1 to HELD_MAX `token`s, each distinct and in the chain's address form, and no
 * other key.
 */
export function parseHeld(q: URLSearchParams): { chain: HeldChain; tokens: string[] } | null {
  for (const k of q.keys()) if (k !== "chain" && k !== "token") return null;
  const chains = q.getAll("chain");
  const tokens = q.getAll("token");
  const chain = chains[0];
  if (chains.length !== 1 || (chain !== "solana" && chain !== "base" && chain !== "robinhood")) return null;
  if (tokens.length < 1 || tokens.length > HELD_MAX) return null;
  const seen = new Set<string>();
  for (const t of tokens) {
    const key = chain === "solana" ? address(t) : evmAddress(t);
    if (key === null || seen.has(key)) return null;
    seen.add(key);
  }
  return { chain, tokens };
}

/** A map that keeps at most `max` keys, dropping the oldest written. */
function bounded<V>(max: number) {
  const m = new Map<string, V>();
  return {
    get: (k: string) => m.get(k),
    set(k: string, v: V) {
      m.delete(k);
      m.set(k, v);
      while (m.size > max) m.delete(m.keys().next().value!);
    },
  };
}

type Deps = {
  /** The Solana token page (solana/token.ts page). */
  solana: { page(mint: string, client?: string): Promise<DataAnswer> };
  /** Each EVM chain's Discover lists (evm/lists.ts get); a chain with none is not served. */
  lists: Partial<Record<EvmChain, { get(): Promise<{ status: number; body: string; asOfMs?: number }> }>>;
  /** DexScreener's budget (default: DEX_LIMITS on `now`). */
  dex?: ReturnType<typeof upstreamBudget>;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
};

export function createHeld(deps: Deps) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const dex = deps.dex ?? upstreamBudget(() => DEX_LIMITS, now);
  // the names read, and apart from them the addresses DexScreener named nothing for, so addresses nobody holds (a
  // stranger's random ones) never push out a name a device reads
  const kept = bounded<{ entry: Entry; at: number }>(CACHE_MAX);
  const absent = bounded<number>(CACHE_MAX);
  const running = new Map<string, Promise<"ok" | "refused" | "failed">>();
  const rowsOf = new Map<EvmChain, { body: string; rows: Map<string, Entry> }>();

  async function solana(mint: string, client?: string): Promise<Outcome> {
    let a: DataAnswer;
    try {
      a = await deps.solana.page(mint, client);
    } catch {
      return { kind: "failed" };
    }
    if (a.status === 404) return { kind: "absent" };
    if (a.status !== 200 || a.asOfMs === undefined) return { kind: "failed" };
    try {
      const row = obj(obj(JSON.parse(a.body)).row);
      const entry = entryOf(row.symbol, row.name, row.price_usd);
      return entry === null ? { kind: "absent" } : { kind: "named", source: { entry, src: text(row.src, 32) ?? a.src ?? "jupiter", at: a.asOfMs } };
    } catch {
      return { kind: "failed" };
    }
  }

  /** The chain's lists rows by lowercase token with the lists' read time; empty while the lists have never answered. */
  async function listed(chain: EvmChain): Promise<{ rows: Map<string, Entry>; at: number }> {
    const none = { rows: new Map<string, Entry>(), at: now() };
    try {
      const a = await deps.lists[chain]!.get();
      if (a.status !== 200 || a.asOfMs === undefined) return none;
      let held = rowsOf.get(chain);
      if (held?.body !== a.body) {
        const rows = new Map<string, Entry>();
        for (const list of Object.values(obj(obj(JSON.parse(a.body)).lists))) {
          if (!Array.isArray(list)) continue;
          for (const raw of list) {
            const r = obj(raw);
            const token = evmAddress(r.token);
            const entry = entryOf(r.symbol, r.name, r.price_usd);
            if (r.chain === chain && token !== null && entry !== null && !rows.has(token)) rows.set(token, entry);
          }
        }
        held = { body: a.body, rows };
        rowsOf.set(chain, held);
      }
      return { rows: held.rows, at: a.asOfMs };
    } catch {
      return none;
    }
  }

  /** One DexScreener tokens/v1 call for `missing` (lowercase addresses), its answer kept per token. */
  async function dexRead(chain: EvmChain, missing: string[], client?: string): Promise<"ok" | "refused" | "failed"> {
    // its own budget, never GeckoTerminal's: a refused read serves a token named before (HELD_SERVE_MS)
    if (dex.take(DEX_KEY, client) > 0) return "refused";
    try {
      const r = await doFetch(`${DEX_BASE}/tokens/v1/${DEX_CHAIN[chain]}/${missing.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        const ra = Number(r.headers.get("retry-after"));
        dex.hold(DEX_KEY, now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : DEX_LIMITS.windowMs!));
        await r.body?.cancel();
        return "refused";
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return "failed";
      }
      const body = await r.text();
      if (body.length > ANSWER_MAX) return "failed";
      const pairs: unknown = JSON.parse(body);
      if (!Array.isArray(pairs)) return "failed";
      const at = now();
      const asked = new Set(missing);
      // per asked token, the pair of the deepest liquidity whose base token it is, on this chain
      const best = new Map<string, { entry: Entry; liq: number }>();
      for (const raw of pairs.slice(0, 10 * HELD_MAX)) {
        const p = obj(raw);
        const b = obj(p.baseToken);
        const token = evmAddress(b.address);
        if (p.chainId !== DEX_CHAIN[chain] || token === null || !asked.has(token)) continue;
        const usd = obj(p.liquidity).usd;
        const liq = typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : 0;
        const entry = entryOf(b.symbol, b.name, p.priceUsd);
        const had = best.get(token);
        if (entry !== null && (had === undefined || liq > had.liq)) best.set(token, { entry, liq });
      }
      for (const t of missing) {
        const e = best.get(t)?.entry;
        if (e === undefined) absent.set(`${chain}:${t}`, at);
        else kept.set(`${chain}:${t}`, { entry: e, at });
      }
      return "ok";
    } catch {
      return "failed";
    }
  }

  /** The missing tokens' DexScreener read, one at a time for the same tokens. */
  function batch(chain: EvmChain, missing: string[], client?: string) {
    const key = `${chain}:${missing.join(",")}`;
    let p = running.get(key);
    if (p === undefined) {
      p = dexRead(chain, missing, client).finally(() => running.delete(key));
      running.set(key, p);
    }
    return p;
  }

  async function evm(chain: EvmChain, tokens: string[], client?: string): Promise<Outcome[]> {
    const { rows, at: listsAt } = await listed(chain);
    const lower = tokens.map((t) => evmAddress(t)!);
    const read = (t: string): Outcome | undefined => {
      const k = kept.get(`${chain}:${t}`);
      const a = absent.get(`${chain}:${t}`);
      // the newer of the two reads of the token
      if (a !== undefined && (k === undefined || a > k.at) && now() - a < HELD_FRESH_MS) return { kind: "absent" };
      if (k !== undefined && now() - k.at < HELD_FRESH_MS) return { kind: "named", source: { entry: k.entry, src: "dexscreener", at: k.at } };
      return undefined;
    };
    const fresh = (t: string) => read(t) !== undefined;
    const missing = lower.filter((t) => !rows.has(t) && !fresh(t));
    const got = missing.length === 0 ? "ok" : await batch(chain, missing, client);
    return lower.map((t): Outcome => {
      const row = rows.get(t);
      if (row !== undefined) return { kind: "named", source: { entry: row, src: "geckoterminal", at: listsAt } };
      const done = read(t);
      if (done !== undefined) return done;
      // not read again this time: a name read within HELD_SERVE_MS is served, dated by its read (the answer's as_of_ms)
      const k = kept.get(`${chain}:${t}`);
      if (k !== undefined && now() - k.at < HELD_SERVE_MS) return { kind: "named", source: { entry: k.entry, src: "dexscreener", at: k.at } };
      return { kind: got === "refused" ? "refused" : "failed" };
    });
  }

  return {
    /**
     * 200 with one entry per asked token, in the order asked (`tokens` as parseHeld gave them); a token no source names
     * is an entry of nulls with src "none". 503 upstream only when no token could be named and a read failed.
     */
    async read(chain: HeldChain, tokens: string[], client?: string): Promise<DataAnswer> {
      const outcomes = chain === "solana" ? await Promise.all(tokens.map((t) => solana(t, client))) : deps.lists[chain] === undefined ? tokens.map((): Outcome => ({ kind: "failed" })) : await evm(chain, tokens, client);
      const named = outcomes.filter((o): o is Extract<Outcome, { kind: "named" }> => o.kind === "named");
      if (named.length === 0 && outcomes.some((o) => o.kind === "failed")) return { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
      const asOf = named.length === 0 ? now() : Math.min(...named.map((o) => o.source.at));
      const out = tokens.map((token, i) => {
        const o = outcomes[i]!;
        return o.kind === "named" ? { token, ...o.source.entry, src: o.source.src } : { token, symbol: null, name: null, price_usd: null, src: "none" };
      });
      return { status: 200, body: JSON.stringify({ tokens: out, as_of_ms: asOf }), src: chain === "solana" ? "jupiter" : named.some((o) => o.source.src === "dexscreener") ? "dexscreener" : "geckoterminal", asOfMs: asOf };
    },
    /** Whether this reader serves `chain` (an EVM chain only while its lists are wired). */
    serves: (chain: HeldChain): boolean => chain === "solana" || deps.lists[chain] !== undefined,
  };
}
export type Held = ReturnType<typeof createHeld>;
