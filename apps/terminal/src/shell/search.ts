// The top bar's search model (card app-header-search-chain): find a token by its symbol, its name or its address in the
// lists already read (Discover's read, ../screens/discover/data.ts readLists; the rail's store, ../screens/token/rail.ts),
// on this device with no read per key. A pasted address the lists do not hold goes to the token read
// (../screens/token/source.ts loadToken) for each chain with data whose address form it fits. The chain filter is All
// plus the chains the lists hold. Display only: nothing here feeds a signature.
import { TOKEN_CHAINS } from "../routes/routes.ts";
import { REFRESH_MS } from "../screens/discover/data.ts";
import type { MarketChain, MarketRow, MarketSnapshot } from "../screens/discover/fields.ts";
import { columnRows } from "../screens/discover/model.ts";
import { RAIL, sharedLists } from "../screens/token/rail.ts";

/** The filter: every chain, or one. */
export type ChainPick = "all" | MarketChain;

/** The most rows the search draws. */
export const LIMIT = 10;

const LISTS = ["trending", "trending_1h", "trending_5m", "new", "graduating"] as const;

/** Every row of every list, one row per chain and token, the first seen kept. */
export function allRows(s: MarketSnapshot): MarketRow[] {
  const L = s.lists as unknown as Record<string, readonly MarketRow[] | undefined>;
  const names = [...LISTS, ...Object.keys(L).filter((k) => !(LISTS as readonly string[]).includes(k))];
  const seen = new Set<string>();
  const out: MarketRow[] = [];
  for (const n of names)
    for (const r of L[n] ?? []) {
      const k = `${r.chain}/${r.token}`;
      if (!seen.has(k)) seen.add(k), out.push(r);
    }
  return out;
}

/** The chains the rows hold, in TOKEN_CHAINS order: the filter's choices after All. */
export const chainsWithData = (rows: readonly MarketRow[]): MarketChain[] => TOKEN_CHAINS.filter((c) => rows.some((r) => r.chain === c));

// Each chain's address form: a Solana mint is base58 of 32 to 44 characters; a Base or Robinhood token a 0x address of
// 40 hex digits; a NEAR token an account, named (parts of a-z, 0-9, - and _, joined by dots, ending .near) or implicit
// (64 hex digits).
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const NEAR = /^(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)+near$|^[0-9a-f]{64}$/;

/** The chains whose address form the query is, or none. */
export function addressChains(query: string): MarketChain[] {
  const q = query.trim();
  if (SOLANA.test(q)) return ["solana"];
  if (EVM.test(q)) return ["base", "robinhood"];
  if (NEAR.test(q.toLowerCase())) return ["near"];
  return [];
}

/** The id in its chain's own spelling: a Solana mint as typed (base58 is case-sensitive), the others lower case. */
const idFor = (chain: MarketChain, q: string): string => (chain === "solana" ? q : q.toLowerCase());

/** The query as matched: trimmed, its letters folded to one case, one leading $ dropped. */
const fold = (s: string): string => s.normalize("NFKC").toLowerCase();
const norm = (q: string): string => fold(q.trim()).replace(/^\$/, "");

const num = (v: string | null | undefined) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : -1);

/** How well a row matches: 0 its symbol, 1 its name, 2 its symbol starts with the query, 3 its name does, 4 a word of
 *  its name does, 5 its symbol holds it, 6 its name holds it; null for no match. */
function rank(r: MarketRow, q: string): number | null {
  const s = fold(r.symbol).replace(/^\$/, "");
  const n = fold(r.name ?? "");
  if (s === q) return 0;
  if (n === q) return 1;
  if (s.startsWith(q)) return 2;
  if (n.startsWith(q)) return 3;
  if (n.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) return 4;
  if (s.includes(q)) return 5;
  if (n.includes(q)) return 6;
  return null;
}

export interface Plan {
  /** The rows to draw, best first. */
  rows: MarketRow[];
  /** The token reads to make: an address the lists do not hold. */
  reads: { chain: MarketChain; id: string }[];
}

/**
 * What a query finds in `rows` on the filter's chain: an address finds its row, or, when the lists do not hold it, the
 * token reads for each chain in `chains` (the chains with data) that its form fits; any other query finds up to LIMIT
 * rows by symbol and name, best match first, a tie by market cap (largest first), then as listed.
 */
export function plan(rows: readonly MarketRow[], query: string, pick: ChainPick, chains: readonly MarketChain[]): Plan {
  const q = query.trim();
  if (!q) return { rows: [], reads: [] };
  const on = (c: MarketChain) => pick === "all" || pick === c;
  const forms = addressChains(q).filter(on);
  if (addressChains(q).length) {
    const listed = rows.filter((r) => forms.includes(r.chain) && r.token === idFor(r.chain, q));
    if (listed.length) return { rows: listed, reads: [] };
    return { rows: [], reads: forms.filter((c) => chains.includes(c)).map((chain) => ({ chain, id: idFor(chain, q) })) };
  }
  const nq = norm(q);
  if (!nq) return { rows: [], reads: [] };
  const hits: { r: MarketRow; k: number; mc: number; i: number }[] = [];
  rows.forEach((r, i) => {
    if (!on(r.chain)) return;
    const k = rank(r, nq);
    if (k !== null) hits.push({ r, k, mc: num(r.mc_usd), i });
  });
  hits.sort((a, b) => a.k - b.k || b.mc - a.mc || a.i - b.i);
  return { rows: hits.slice(0, LIMIT).map((h) => h.r), reads: [] };
}

/** With no query: the top of the Trending column as Discover orders it, on the filter's chain. */
export const idleRows = (s: MarketSnapshot, pick: ChainPick): MarketRow[] =>
  columnRows(s, "trending")
    .filter((r) => pick === "all" || r.chain === pick)
    .slice(0, LIMIT);

type RailView = { data: { status: string; snapshot?: MarketSnapshot }; nowMs: number };

export interface ListsDeps {
  /** The rail's store as drawn now (rail.ts RAIL.get). */
  rail?: () => RailView;
  /** One lists read, shared while in flight (rail.ts sharedLists). */
  read?: () => Promise<MarketSnapshot>;
  now?: () => number;
}

/**
 * The lists the search reads: the rail's store's while its lists are under REFRESH_MS old (the token page reads them on
 * Discover's cadence), else its own last read while that is under REFRESH_MS old, else one read shared with any read in
 * flight. It reads only when asked (the search opening), never on a timer: no second poll.
 */
export function listsSource(deps: ListsDeps = {}) {
  const rail = deps.rail ?? (RAIL.get as () => RailView);
  const read = deps.read ?? (() => sharedLists());
  const now = deps.now ?? Date.now;
  let own: { s: MarketSnapshot; at: number } | null = null;
  const fresh = (at: number) => now() - at < REFRESH_MS;
  const railFresh = (): MarketSnapshot | null => {
    const r = rail();
    return r.data.status === "ready" && r.data.snapshot && fresh(r.nowMs) ? r.data.snapshot : null;
  };
  return {
    /** The freshest lists held now, with no read: the rail's while fresh, else the last read's; null before any. */
    now(): MarketSnapshot | null {
      const r = rail();
      return railFresh() ?? own?.s ?? (r.data.status === "ready" ? (r.data.snapshot ?? null) : null);
    },
    /** Fresh lists: held ones under REFRESH_MS old, else one read. Rejects on a failed read. */
    async get(): Promise<MarketSnapshot> {
      const r = railFresh();
      if (r) return r;
      if (own && fresh(own.at)) return own.s;
      const s = await read();
      own = { s, at: now() };
      return s;
    },
  };
}

export type ListsSource = ReturnType<typeof listsSource>;

/** The app's one source. */
export const SEARCH_LISTS = listsSource();
