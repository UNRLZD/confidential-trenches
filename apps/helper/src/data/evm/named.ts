// An EVM token's Discover row when no list carries it (card evm-token-page-opens-any-coin): a coin opened from a search,
// a shared link or a position the user holds after it left trending. The token page, its holders, its candles and its
// tape answer it as they answer a listed one; 404 is only for an address no source names a pool for (a typo, a wallet,
// a contract that trades nowhere).
//
// The source is DexScreener's `tokens/v1/<chainId>/<address>`, the read held.ts already makes for a token no list
// carries, on the same budget (held.ts DEX_LIMITS, its key DEX_KEY: one share of DexScreener's 300 calls a minute for the
// whole helper, a caller at most its per-client part). Never GeckoTerminal: its keyless budget is 5 calls in 75 s for the
// whole helper (../gecko.ts) and is the lists', the charts' and the holders'; gated on it, every unlisted address
// answered 404 (live 20:10Z: Robinhood MOW and Base DEGEN). Read 2026-11-15 20:20Z from a Mac: MOW
// (robinhood 0x0b7c...94fa) answered one pair, uniswap v4, pairAddress its 32-byte pool id, priceUsd "0.1547",
// priceChange {h6, h24}, volume {h24, h6, h1, m5}, txns {m5, h1, h6, h24} of {buys, sells}, liquidity.usd, fdv,
// marketCap, pairCreatedAt in ms; DEGEN (base 0x4ed4...efed) one pair, uniswap v3, with info.imageUrl; a non-token
// address (0x...0001) `[]`, 200. Each in 0.4-0.9 s.
//
// Display only: nothing here feeds a signature. The answer is hostile input: a pair is used only when its chainId is the
// chain's and its base token is the asked token, text is cut and stripped, every number is checked finite and bounded or
// null, the pool is a hint the swap reads check on chain before reading it (swaps.ts fromHint), the logo URL goes through
// the logo registry's rules (../logo.ts). Each token's answer is held HELD_FRESH_MS (named or absent) and served up to
// HELD_SERVE_MS when it cannot be read again; at most CACHE_MAX tokens of each.
import { LOGOS } from "../logo.ts";
import { DEX_BASE, DEX_CHAIN, DEX_KEY, DEX_LIMITS, HELD_FRESH_MS, HELD_SERVE_MS } from "../held.ts";
import { dec, text, type Row, ROW_FIELDS } from "../solana/lists.ts";
import { CACHE_MAX } from "../solana/token.ts";
import { evmAddress, type EvmChain } from "./lists.ts";
import { upstreamBudget } from "../../limits/limits.ts";

const ANSWER_MAX = 256 * 1024;
const TIMEOUT_MS = 8_000;
/** The most pairs of an answer looked at [design: tokens/v1 answered one pair a token, 2026-11-15 20:20Z; a token
 *  address is one of at most 30 a call, held.ts takes 10 a token]. */
const PAIRS_MAX = 30;
const PRICE = /^\d{1,30}(\.\d{1,40})?$/;
const POOL = /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** A named token: its row, and the pool its pair names (a hint for the swap reads), when it names one. */
export type Named = { row: Row; pool: string | null };

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const usd = (v: unknown): string | null => dec(typeof v === "number" ? v : typeof v === "string" && PRICE.test(v) ? Number(v) : undefined);
/** A market value of 0 is unknown (lists.ts cap, card market-data-matches-the-page): null. */
const cap = (v: unknown): string | null => {
  const u = usd(v);
  return u === null || Number(u) <= 0 ? null : u;
};
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
function bps(pct: unknown): number | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < -100 || Math.abs(pct) > 1e9) return null;
  return Math.round(pct * 100) || 0;
}

/** DexScreener's tokens/v1 answer as the token's row and pool: the pair of the deepest liquidity on `chain` whose base
 *  token is `token` (lowercase); null when no pair is one (the token has no pool DexScreener knows), or the answer is
 *  not a list. */
export function toNamed(chain: EvmChain, token: string, answer: unknown, asOfMs: number): Named | null {
  if (!Array.isArray(answer)) return null;
  let best: { p: Record<string, unknown>; liq: number } | null = null;
  for (const raw of answer.slice(0, PAIRS_MAX)) {
    const p = obj(raw);
    const b = obj(p.baseToken);
    if (p.chainId !== DEX_CHAIN[chain] || evmAddress(b.address) !== token) continue;
    if (text(b.symbol, 32) === null) continue;
    const l = obj(p.liquidity).usd;
    const liq = typeof l === "number" && Number.isFinite(l) && l >= 0 ? l : 0;
    if (best === null || liq > best.liq) best = { p, liq };
  }
  if (best === null) return null;
  const p = best.p;
  const b = obj(p.baseToken);
  const symbol = text(b.symbol, 32)!;
  const name = text(b.name, 64) ?? symbol;
  const vol = obj(p.volume);
  const chg = obj(p.priceChange);
  const tx = obj(p.txns);
  const [m5, h1, h24] = [obj(tx.m5), obj(tx.h1), obj(tx.h24)];
  const ms = p.pairCreatedAt;
  const created = Number.isSafeInteger(ms) && (ms as number) >= Date.UTC(2015, 0, 1) && (ms as number) <= asOfMs + 86_400_000 ? Math.floor((ms as number) / 1000) : null;
  const row = {
    chain,
    token,
    symbol,
    name,
    icon: LOGOS.remember(chain, token, obj(p.info).imageUrl), // GET /v1/logo/{chain}/{token} serves it (../logo.ts)
    venue: null,
    label: null,
    created_s: created, // the pair's, as a list row's is its pool's
    price_usd: usd(p.priceUsd),
    mc_usd: cap(p.marketCap) ?? cap(p.fdv),
    vol_24h_usd: usd(vol.h24),
    chg_5m_bps: bps(chg.m5),
    chg_1h_bps: bps(chg.h1),
    chg_24h_bps: bps(chg.h24),
    liq_usd: usd(obj(p.liquidity).usd),
    holders: null,
    top10_bps: null,
    src: "dexscreener",
    as_of_ms: asOfMs,
    creator: null,
    creator_sold_bps: null,
    dev_bps: null,
    snipers_bps: null,
    mint_auth: null,
    freeze_auth: null,
    vol_5m_usd: usd(vol.m5),
    buys_5m: count(m5.buys),
    sells_5m: count(m5.sells),
    net_5m_usd: null,
    risk_src: null,
    launchpad: null, // the maker read's (lists.ts maker), set where the page is answered
    curve_bps: null,
    vol_1h_usd: usd(vol.h1),
    chg_4h_bps: null,
    buys_24h: count(h24.buys),
    sells_24h: count(h24.sells),
    buys_1h: count(h1.buys),
    sells_1h: count(h1.sells),
  } satisfies Record<(typeof ROW_FIELDS)[number], unknown>;
  const pool = typeof p.pairAddress === "string" && POOL.test(p.pairAddress) ? p.pairAddress.toLowerCase() : null;
  return { row, pool };
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

/** One EVM chain's unlisted tokens. `dex`: DexScreener's one budget, the one held.ts draws (default DEX_LIMITS). */
export function createEvmNamed(chain: EvmChain, deps: { dex?: ReturnType<typeof upstreamBudget>; fetch?: Fetch; now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const dex = deps.dex ?? upstreamBudget(() => DEX_LIMITS, now);
  // the tokens named, and apart from them the addresses named nothing for, so a stranger's random addresses never push
  // out a coin a device opens
  const kept = bounded<{ named: Named; at: number }>(CACHE_MAX);
  const absent = bounded<number>(CACHE_MAX);
  const running = new Map<string, Promise<"ok" | "unread">>();

  async function read(token: string, client?: string): Promise<"ok" | "unread"> {
    if (dex.take(DEX_KEY, client) > 0) return "unread";
    try {
      const r = await doFetch(`${DEX_BASE}/tokens/v1/${DEX_CHAIN[chain]}/${token}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        const ra = Number(r.headers.get("retry-after"));
        dex.hold(DEX_KEY, now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : DEX_LIMITS.windowMs!));
        await r.body?.cancel();
        return "unread";
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return "unread";
      }
      const body = await r.text();
      if (body.length > ANSWER_MAX) return "unread";
      const j: unknown = JSON.parse(body);
      if (!Array.isArray(j)) return "unread";
      const at = now();
      const named = toNamed(chain, token, j, at);
      if (named === null) absent.set(token, at);
      else kept.set(token, { named, at });
      return "ok";
    } catch {
      return "unread";
    }
  }

  /** The newer of the token's two reads while fresh: its row, null (named nothing), undefined (none fresh). */
  const fresh = (token: string): Named | null | undefined => {
    const k = kept.get(token);
    const a = absent.get(token);
    if (a !== undefined && (k === undefined || a > k.at) && now() - a < HELD_FRESH_MS) return null;
    if (k !== undefined && now() - k.at < HELD_FRESH_MS) return k.named;
    return undefined;
  };
  /** The named row read within HELD_SERVE_MS, whatever came after it. */
  const servable = (token: string): Named | undefined => {
    const k = kept.get(token);
    return k !== undefined && now() - k.at < HELD_SERVE_MS ? k.named : undefined;
  };

  return {
    /**
     * The token's row (a lowercase address): its pair's, null when DexScreener names no pool for it, "unread" when it
     * could not be read (the budget refused, DexScreener failed) and no row read within HELD_SERVE_MS is held.
     */
    async named(token: string, client?: string): Promise<Named | null | "unread"> {
      const f = fresh(token);
      if (f !== undefined) return f;
      let p = running.get(token);
      if (p === undefined) {
        p = read(token, client).finally(() => running.delete(token));
        running.set(token, p);
      }
      const got = await p;
      const f2 = fresh(token);
      if (got === "ok" && f2 !== undefined) return f2;
      return servable(token) ?? "unread";
    },
    /** The pool the token's held pair names, while servable (the swap reads' hint, checked on chain); else null. */
    pool: (token: string): string | null => servable(token)?.pool ?? null,
    /** The held pair's USD price, while servable (the swap reads' scale check, swaps.ts price); else null. */
    price(token: string): number | null {
      const v = servable(token)?.row.price_usd;
      const n = typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  };
}
export type EvmNamed = ReturnType<typeof createEvmNamed>;
