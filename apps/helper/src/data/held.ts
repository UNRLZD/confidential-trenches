// GET /v1/market/held: the symbol, name and USD price of each token a device holds, on Solana, Base and Robinhood, in
// one request (card market-token-reads). Portfolio needs them for tokens that are no longer in Discover's lists, which
// the token page (solana/token.ts, evm/token.ts) answers 404 for on the EVM chains.
//
// Sources, per chain:
//   - solana: each mint through the token page (solana/token.ts page), whose caches the token screen shares; read in
//     parallel. A mint the page does not answer 200 for is an entry of nulls.
//   - base and robinhood: the chain's current lists rows for a token they hold; for the rest ONE GeckoTerminal call,
//     `networks/<net>/tokens/multi/<a>,<b>,...` (api.geckoterminal.com/docs/index.html "tokens/multi/{addresses}"; a
//     live read 2026-11-10 01:21Z answered {"data":[{"id":"base_0x...","type":"token","attributes":{"address","name",
//     "symbol","decimals","price_usd",...}}]} for two Base addresses), taken through the GeckoTerminal budget's "pages"
//     lane as the token page's info read is (evm/token.ts readInfo), since one call a token would starve the keyless
//     5 calls in 75 s. Each token's answer is held HELD_FRESH_MS, at most CACHE_MAX tokens.
//
// Display only: nothing here feeds a signature. Every upstream answer is hostile input: an entry is used only when it
// names the asked token, strings are bounded and a price is a plain decimal or null.
import type { GeckoBudget } from "./gecko.ts";
import { GT_PAGE_WAIT_MS, takeOrWait, throttledUntil } from "./gecko.ts";
import { evmAddress, GT_BASE, GT_NETWORK, type EvmChain } from "./evm/lists.ts";
import { address, text } from "./solana/lists.ts";
import { CACHE_MAX, type DataAnswer } from "./solana/token.ts";

/** The most tokens one request names [design: GeckoTerminal's tokens/multi takes at most 30 addresses]. */
export const HELD_MAX = 30;
/** A token's GeckoTerminal answer is held this long, so a refresh inside a minute makes no call [design: a price is
 *  display data; one batch a minute a chain keeps a device's refresh to 1 of the budget's 5 calls in 75 s]. */
export const HELD_FRESH_MS = 60_000;
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
  gecko: GeckoBudget;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
};

export function createHeld(deps: Deps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  const doFetch = deps.fetch ?? fetch;
  const kept = bounded<{ entry: Entry | null; at: number }>(CACHE_MAX);
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

  /** One tokens/multi call for `missing` (lowercase addresses), its answer kept per token. */
  async function gecko(chain: EvmChain, missing: string[]): Promise<"ok" | "refused" | "failed"> {
    if ((await takeOrWait(deps.gecko, "pages", `${chain} held`, now() + GT_PAGE_WAIT_MS, now, sleep)) !== null) return "refused";
    try {
      const r = await doFetch(`${GT_BASE}/networks/${GT_NETWORK[chain]}/tokens/multi/${missing.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        throttledUntil(deps.gecko, r.headers.get("retry-after"), now());
        await r.body?.cancel();
        return "refused";
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return "failed";
      }
      const body = await r.text();
      if (body.length > ANSWER_MAX) return "failed";
      const data = obj(JSON.parse(body)).data;
      if (!Array.isArray(data)) return "failed";
      const at = now();
      const asked = new Set(missing);
      const found = new Map<string, Entry>();
      for (const raw of data.slice(0, 2 * HELD_MAX)) {
        const d = obj(raw);
        const a = obj(d.attributes);
        const token = evmAddress(a.address);
        // used only when it names an asked token
        if (d.type !== "token" || token === null || !asked.has(token) || found.has(token)) continue;
        const entry = entryOf(a.symbol, a.name, a.price_usd);
        if (entry !== null) found.set(token, entry);
      }
      for (const t of missing) kept.set(`${chain}:${t}`, { entry: found.get(t) ?? null, at });
      return "ok";
    } catch {
      return "failed";
    }
  }

  /** The missing tokens' GeckoTerminal read, one at a time for the same tokens. */
  function batch(chain: EvmChain, missing: string[]) {
    const key = `${chain}:${missing.join(",")}`;
    let p = running.get(key);
    if (p === undefined) {
      p = gecko(chain, missing).finally(() => running.delete(key));
      running.set(key, p);
    }
    return p;
  }

  async function evm(chain: EvmChain, tokens: string[]): Promise<Outcome[]> {
    const { rows, at: listsAt } = await listed(chain);
    const lower = tokens.map((t) => evmAddress(t)!);
    const fresh = (t: string) => {
      const k = kept.get(`${chain}:${t}`);
      return k !== undefined && now() - k.at < HELD_FRESH_MS;
    };
    const missing = lower.filter((t) => !rows.has(t) && !fresh(t));
    const read = missing.length === 0 ? "ok" : await batch(chain, missing);
    return lower.map((t): Outcome => {
      const row = rows.get(t);
      if (row !== undefined) return { kind: "named", source: { entry: row, src: "geckoterminal", at: listsAt } };
      const k = kept.get(`${chain}:${t}`);
      if (k !== undefined && now() - k.at < HELD_FRESH_MS) return k.entry === null ? { kind: "absent" } : { kind: "named", source: { entry: k.entry, src: "geckoterminal", at: k.at } };
      return { kind: read === "refused" ? "refused" : "failed" };
    });
  }

  return {
    /**
     * 200 with one entry per asked token, in the order asked (`tokens` as parseHeld gave them); a token no source names
     * is an entry of nulls with src "none". 503 upstream only when no token could be named and a read failed.
     */
    async read(chain: HeldChain, tokens: string[], client?: string): Promise<DataAnswer> {
      const outcomes = chain === "solana" ? await Promise.all(tokens.map((t) => solana(t, client))) : deps.lists[chain] === undefined ? tokens.map((): Outcome => ({ kind: "failed" })) : await evm(chain, tokens);
      const named = outcomes.filter((o): o is Extract<Outcome, { kind: "named" }> => o.kind === "named");
      if (named.length === 0 && outcomes.some((o) => o.kind === "failed")) return { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
      const asOf = named.length === 0 ? now() : Math.min(...named.map((o) => o.source.at));
      const out = tokens.map((token, i) => {
        const o = outcomes[i]!;
        return o.kind === "named" ? { token, ...o.source.entry, src: o.source.src } : { token, symbol: null, name: null, price_usd: null, src: "none" };
      });
      return { status: 200, body: JSON.stringify({ tokens: out, as_of_ms: asOf }), src: chain === "solana" ? "jupiter" : "geckoterminal", asOfMs: asOf };
    },
    /** Whether this reader serves `chain` (an EVM chain only while its lists are wired). */
    serves: (chain: HeldChain): boolean => chain === "solana" || deps.lists[chain] !== undefined,
  };
}
export type Held = ReturnType<typeof createHeld>;
