// The candidate Rhea pools a NEAR buy's quote reads (card near-private-trading): the kit's rheaQuote takes pool ids "from
// any list" and reads each one itself on two providers at one block, so this list is only a hint, and it never makes
// the device sign against a pool state it did not read on both providers.
// - Where: Rhea's own exchange, get_number_of_pools then get_pools pages of NEAR_POOLS_PAGE, read on BOTH providers of
//   the page's paced pair, each once a session per network and kept (a provider whose read failed is read again on the
//   next quote, the other's list used meanwhile); nothing names the user, W or the token, so the read says nothing of
//   what is bought. 9,015 pools on mainnet at 12 Nov 07:15Z, about 95 KB a page of 500. Pages of 2000 (card
//   near-quote-under-the-pace): 5 reads a provider, not 19; a page of 2000 from index 0 answered on both providers,
//   1,225,371 bytes each as JSON-RPC sends it (the result a list of byte numbers), 2000 rows (12 Nov 22:27Z), a
//   quarter of the helper's RPC_ANSWER_MAX (4 MiB).
// - Which: SIMPLE_POOL rows of exactly two tokens, at most RHEA_QUOTE_POOLS_MAX in all: the token's pools with USDC
//   and with wrapped NEAR, deepest first (by the other token's reserve), then the deepest wrapped NEAR / USDC pools for
//   the route through wrapped NEAR. Each provider's list is ranked on its own and the two are taken in turn (its first,
//   the other's first, ...), so one provider that hides the deep pools, or lists shallow pools as deep to crowd them
//   out, still leaves the other's deepest in. What one lying provider can still do: list real pools that are worse (the
//   quote reads them on both providers and keeps the best route), or ids that are no pool (the quote is refused).
// - Every answer is hostile: a count or row out of shape ends the read (it is read again on the next quote), and the
//   pages are bounded (NEAR_POOLS_MAX).
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, RHEA_QUOTE_POOLS_MAX } from "../../kit/src/near/rhea.ts";
import { dclPoolOf, NEAR_DCL } from "../../kit/src/near/dcl.ts";

/** One get_pools page. */
export const NEAR_POOLS_PAGE = 2000;
/** The most pools read: past it the count is refused (mainnet held 9,015). */
export const NEAR_POOLS_MAX = 50_000;
/** Pages in flight at once (the provider's pace still spaces them). */
export const NEAR_POOLS_AT_ONCE = 5;
/** How many wrapped NEAR / USDC pools join the token's own ones. */
export const NEAR_POOLS_BRIDGE = 4;

type Row = { id: number; a: string; b: string; ra: bigint; rb: bigint };
const U128 = /^(0|[1-9]\d{0,38})$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** A view call's answer as JSON (call_function at final), refused unless the result is bytes. */
export async function nearView(rpc: NearRpc, contract: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const a = await rpc.query({ request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) }, signal);
  const r = isObj(a) && isObj(a.result) ? a.result.result : undefined;
  if (!Array.isArray(r) || !r.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error(`${rpc.name}: ${method}: not a view answer`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(r as number[])));
}

/** Rhea's pool count (get_number_of_pools), refused out of range. */
async function rheaCount(network: NearNetwork, rpc: NearRpc, signal?: AbortSignal): Promise<number> {
  const n = await nearView(rpc, NEAR_RHEA[network].exchange, "get_number_of_pools", {}, signal);
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > NEAR_POOLS_MAX) throw new Error("get_number_of_pools: out of range");
  return n as number;
}

/** Rhea's simple two-token pools from index `from` to `to` (not included), read page by page. */
async function readRheaRange(network: NearNetwork, rpc: NearRpc, from0: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const exchange = NEAR_RHEA[network].exchange;
  const pages = Array.from({ length: Math.ceil((to - from0) / NEAR_POOLS_PAGE) }, (_, k) => from0 + k * NEAR_POOLS_PAGE);
  // NEAR_POOLS_AT_ONCE pages in flight; the rows kept in page order whatever order the answers come in
  const got: Row[][] = [];
  let next = 0;
  const one = async (): Promise<void> => {
    while (next < pages.length) {
      const k = next++;
      const from = pages[k]!;
      const page = await nearView(rpc, exchange, "get_pools", { from_index: from, limit: Math.min(NEAR_POOLS_PAGE, to - from) }, signal);
      if (!Array.isArray(page) || page.length > NEAR_POOLS_PAGE) throw new Error("get_pools: not a page");
      const rows: Row[] = [];
      page.forEach((p, i) => {
        if (!isObj(p) || p.pool_kind !== "SIMPLE_POOL") return;
        const t = p.token_account_ids;
        const m = p.amounts;
        if (!Array.isArray(t) || t.length !== 2 || !Array.isArray(m) || m.length !== 2) return;
        if (typeof t[0] !== "string" || typeof t[1] !== "string" || typeof m[0] !== "string" || typeof m[1] !== "string" || !U128.test(m[0]) || !U128.test(m[1])) return;
        rows.push({ id: from + i, a: t[0], b: t[1], ra: BigInt(m[0]), rb: BigInt(m[1]) });
      });
      got[k] = rows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(NEAR_POOLS_AT_ONCE, pages.length) }, one));
  return got.flat();
}

/** Rhea's simple two-token pools, read page by page. */
export async function readRheaPools(network: NearNetwork, rpc: NearRpc, signal?: AbortSignal): Promise<Row[]> {
  return readRheaRange(network, rpc, 0, await rheaCount(network, rpc, signal), signal);
}

/** At most RHEA_QUOTE_POOLS_MAX ids for a buy or sell of `token` against the network's USDC (see the header). */
export function rheaCandidates(network: NearNetwork, rows: readonly Row[], token: string): number[] {
  return rheaCandidatesOf(network, [rows], token);
}

/** The ids of several lists (one per provider), each ranked on its own and taken in turn, distinct, within the cap. */
export function rheaCandidatesOf(network: NearNetwork, lists: readonly (readonly Row[])[], token: string): number[] {
  const each = lists.map((rows) => ranked(network, rows, token));
  const bridge = inTurn(each.map((e) => e.bridge)).slice(0, NEAR_POOLS_BRIDGE);
  const own = inTurn(each.map((e) => e.own))
    .filter((id) => !bridge.includes(id))
    .slice(0, RHEA_QUOTE_POOLS_MAX - bridge.length);
  return [...own, ...bridge];
}

/** The lists' ids taken in turn (each list's first, then each one's second, ...), each id once. */
function inTurn(lists: readonly (readonly number[])[]): number[] {
  const out: number[] = [];
  for (let k = 0; lists.some((l) => k < l.length); k++) for (const l of lists) if (k < l.length && !out.includes(l[k]!)) out.push(l[k]!);
  return out;
}

/** One list's ranking: the token's own pools (at most the cap) and the bridge pools (at most NEAR_POOLS_BRIDGE). */
function ranked(network: NearNetwork, rows: readonly Row[], token: string): { own: number[]; bridge: number[] } {
  const usdc = NEAR_NETWORKS[network].usdc;
  const wrap = NEAR_RHEA[network].wrap;
  // a pool of exactly {x, y}: the reserve of `of` in it (one token, one unit, so pools compare), else null
  const reserve = (r: Row, x: string, y: string, of: string): bigint | null =>
    (r.a === x && r.b === y) || (r.a === y && r.b === x) ? (r.a === of ? r.ra : r.rb) : null;
  const deepest = (pairs: readonly [string, string][], of: string, most: number): number[] =>
    rows
      .map((r) => [r.id, pairs.map(([x, y]) => reserve(r, x, y, of)).find((v) => v !== null) ?? null] as const)
      .filter((e): e is readonly [number, bigint] => e[1] !== null && e[1] > 0n)
      .sort((p, q) => (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : p[0] - q[0]))
      .slice(0, most)
      .map((e) => e[0]);
  // the route through wrapped NEAR: its deepest pools with USDC, by their USDC
  const bridge = token === wrap ? [] : deepest([[wrap, usdc]], usdc, NEAR_POOLS_BRIDGE);
  // the token's own pools with USDC or wrapped NEAR, by the token's reserve in each
  const own = deepest(token === wrap ? [[token, usdc]] : [[token, usdc], [token, wrap]], token, RHEA_QUOTE_POOLS_MAX);
  return { own, bridge };
}

/** Rhea DCL's fee tiers, in millionths (dcl.ts dclPoolOf): the four DCL pools a pair may have. */
export const NEAR_DCL_FEES = [100, 400, 2000, 10000] as const;

/**
 * Rhea DCL's candidate pool ids for a buy or sell of `token` against USDC (card near-dcl-sell), made on the device from
 * the token alone, never taken from a server's list: the token with wrapped NEAR and USDC with wrapped NEAR, each at
 * NEAR_DCL_FEES, each id "<lower>|<higher>|<fee>" (DCL_QUOTE_POOLS_MAX, 8, in all). An id with no pool reads null and
 * dclQuote leaves it out; so the list says nothing of which pools exist, and asks nothing that names the token.
 * DCL is on mainnet only; wrapped NEAR itself: USDC's four alone; USDC: none.
 */
export function dclCandidates(network: NearNetwork, token: string): string[] {
  if (!(network in NEAR_DCL)) return [];
  const wrap = NEAR_DCL[network as "mainnet"].wrap;
  const usdc = NEAR_NETWORKS[network].usdc;
  if (token === usdc) return [];
  const ids = (a: string, b: string) => NEAR_DCL_FEES.map((f) => `${a < b ? a : b}|${a < b ? b : a}|${f}`);
  return [...(token === wrap ? [] : ids(token, wrap)), ...ids(usdc, wrap)];
}

/**
 * Where the kept lists live across page loads (card near-quote-inside-the-kpi): the page's own storage, strings by key
 * (src/main.ts keptDb, SIGN_HOST's IndexedDB). What is kept is a hint for which pools to quote, never a price or an
 * amount: every candidate is read again at the quote's block on both providers (rheaQuote, dclQuote), so a stale or
 * forged record can cost reads or leave a pool out of a quote, never steer what the device signs. A record that does
 * not parse as one is dropped and read anew. Bounded: a provider's Rhea rows are at most NEAR_POOLS_MAX, DCL tokens at
 * most NEAR_DCL_KEPT_TOKENS.
 */
export type KeptStore = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
/** How the kept lists read the clock and their storage (tests give their own). */
export type KeptOptions = { store?: KeptStore; now?: () => number };
/** A kept Rhea list older than this is read whole again (its reserves re-ranked) in the background of the ask that
 *  finds it so; new pools are read on every ask from the count. [design: 10 min; ranking only orders candidates.] */
export const NEAR_RHEA_KEPT_MS = 10 * 60_000;
/** A kept DCL read older than this is read again on the next ask. [design: 10 min, as Rhea's.] */
export const NEAR_DCL_KEPT_MS = 10 * 60_000;
/** The most tokens whose DCL read is kept across page loads (the oldest dropped first). */
export const NEAR_DCL_KEPT_TOKENS = 256;

const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
/** A kept Rhea list as stored: { count, at, rows: [[id, a, b, ra, rb], ...] }, or null for anything else. */
function rheaKeptOf(text: string | null, now: number): { count: number; at: number; rows: Row[] } | null {
  try {
    const v = JSON.parse(text ?? "null") as unknown;
    if (!isObj(v) || !Number.isSafeInteger(v.count) || (v.count as number) < 1 || (v.count as number) > NEAR_POOLS_MAX || typeof v.at !== "number" || v.at > now || !Array.isArray(v.rows) || v.rows.length > (v.count as number)) return null;
    const rows: Row[] = [];
    for (const r of v.rows as unknown[]) {
      if (!Array.isArray(r) || r.length !== 5) return null;
      const [id, a, b, ra, rb] = r as unknown[];
      if (!Number.isSafeInteger(id) || (id as number) < 0 || (id as number) >= (v.count as number) || typeof a !== "string" || typeof b !== "string" || !ACCOUNT_ID.test(a) || !ACCOUNT_ID.test(b) || typeof ra !== "string" || typeof rb !== "string" || !U128.test(ra) || !U128.test(rb)) return null;
      rows.push({ id: id as number, a, b, ra: BigInt(ra), rb: BigInt(rb) });
    }
    return { count: v.count as number, at: v.at, rows };
  } catch {
    return null;
  }
}
const rheaKeptText = (k: { count: number; at: number; rows: readonly Row[] }): string => JSON.stringify({ count: k.count, at: k.at, rows: k.rows.map((r) => [r.id, r.a, r.b, String(r.ra), String(r.rb)]) });

/**
 * The DCL candidates worth quoting for `token`, kept a session (card near-dcl-route). The token's own four ids with
 * wrapped NEAR are read once with get_pool at final on each of the two providers; an id that either reads as its pool is
 * kept. That is a hint only: dclQuote reads every id again at the quote's block on both providers and leaves out one
 * with no pool, so a provider that invents a pool costs reads, and one that hides a pool is outvoted by the other.
 * None of the token's own: the token is not on DCL, and its quotes ask DCL nothing (11 reads of each provider a quote
 * fewer, on the paced seat: a session's first NEAR buy at the seat's share took a second 429 and 7 s longer without
 * this). Some: those and USDC's four with wrapped NEAR (`dclCandidates`'s, read at the quote's block). A provider whose
 * read failed is read again on the next quote, the other's answer used meanwhile; both failed: every candidate, so a
 * read that failed never takes DCL out of a quote. A DCL pool made later in the session is seen on the next load.
 */
export function dclPoolsKept(network: NearNetwork, rpcs: () => readonly [NearRpc, NearRpc], o: KeptOptions = {}): (token: string, signal?: AbortSignal) => Promise<string[]> {
  const now = o.now ?? Date.now;
  // per set of ids (the token's own four, keyed by the token; USDC's four with wrapped NEAR, keyed "usdc"): each
  // provider's read this session, and the ids found by either with when they were read (kept across page loads)
  const slots = new Map<string, (Promise<string[]> | null)[]>();
  let found: Record<string, { ids: string[]; at: number }> | null = null;
  const key = `dcl-pools:${network}`;
  const load = async (): Promise<Record<string, { ids: string[]; at: number }>> => {
    if (found !== null) return found;
    let v: unknown = null;
    try {
      v = JSON.parse((await o.store?.get(key)) ?? "null");
    } catch {
      v = null;
    }
    const out: Record<string, { ids: string[]; at: number }> = {};
    if (isObj(v))
      for (const [k, e] of Object.entries(v).slice(0, NEAR_DCL_KEPT_TOKENS + 1))
        if (isObj(e) && typeof e.at === "number" && e.at <= now() && Array.isArray(e.ids) && e.ids.length <= 4 && e.ids.every((id) => typeof id === "string" && dclPoolOf(id) !== null)) out[k] = { ids: e.ids as string[], at: e.at };
    return (found ??= out);
  };
  const save = (all: Record<string, { ids: string[]; at: number }>): void => {
    // the newest NEAR_DCL_KEPT_TOKENS tokens and USDC's
    const keep = Object.entries(all).sort((x, y) => y[1].at - x[1].at).slice(0, NEAR_DCL_KEPT_TOKENS + 1);
    void o.store?.set(key, JSON.stringify(Object.fromEntries(keep))).catch(() => {});
  };
  /** Of `ids`, those either provider reads as a pool: kept NEAR_DCL_KEPT_MS; null when neither read (every id then). */
  const which = async (name: string, ids: readonly string[], signal?: AbortSignal): Promise<string[] | null> => {
    const all = await load();
    const was = all[name];
    if (was !== undefined && now() - was.at < NEAR_DCL_KEPT_MS && was.ids.every((id) => ids.includes(id))) return was.ids;
    const exchange = NEAR_DCL[network as keyof typeof NEAR_DCL].exchange;
    const s = was !== undefined && now() - was.at >= NEAR_DCL_KEPT_MS ? [null, null] : (slots.get(name) ?? [null, null]);
    slots.set(name, s);
    const pair = rpcs();
    const read = await Promise.allSettled(
      [0, 1].map((i) =>
        (s[i] ??= Promise.all(
          ids.map(async (id) => {
            const row = await nearView(pair[i]!, exchange, "get_pool", { pool_id: id }, signal);
            if (row === null) return null;
            if (isObj(row) && row.pool_id === id) return id;
            throw new Error(`${pair[i]!.name}: get_pool ${id}: not that pool's row`);
          }),
        )
          .then((got) => got.filter((x): x is string => x !== null))
          .catch((e: unknown) => {
            s[i] = null;
            throw e;
          })),
      ),
    );
    const lists = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (lists.length === 0) return null;
    const union = ids.filter((id) => lists.some((l) => l.includes(id)));
    // kept across page loads only when both providers answered (a provider's failed read is read again next time)
    if (lists.length === 2) {
      all[name] = { ids: union, at: now() };
      save(all);
    }
    return union;
  };
  return async (token, signal) => {
    const all = dclCandidates(network, token);
    if (all.length === 0 || !(network in NEAR_DCL)) return [];
    const wrap = NEAR_DCL[network as keyof typeof NEAR_DCL].wrap;
    const own = all.filter((id) => id.split("|").slice(0, 2).includes(token) && token !== wrap);
    const usdc = all.filter((id) => !own.includes(id));
    if (own.length > 0) {
      const mine = await which(token, own, signal);
      if (mine !== null && mine.length === 0) return [];
      const bridge = (await which("usdc", usdc, signal)) ?? usdc;
      return [...(mine ?? own), ...bridge];
    }
    return (await which("usdc", usdc, signal)) ?? usdc;
  };
}

/** The candidates per network: each provider's list of Rhea's pools, kept across asks and page loads (`o.store`). On
 *  each ask each provider's pool count is read (one read): pools are only ever added, so a higher count reads the new
 *  pools from the tail, a lower one reads the whole list again; a list older than NEAR_RHEA_KEPT_MS is read whole again
 *  in the background (its reserves re-ranked) while this ask uses it. A provider whose read failed is read again on the
 *  next ask, its kept list (if any) used meanwhile; the candidates come from every list there is, refused only when
 *  neither provider has one. */
export function rheaPoolsKept(network: NearNetwork, rpcs: () => readonly [NearRpc, NearRpc], o: KeptOptions = {}): (token: string, signal?: AbortSignal) => Promise<number[]> {
  const now = o.now ?? Date.now;
  type Kept = { count: number; at: number; rows: Row[] };
  const kept: (Kept | null)[] = [null, null];
  const loaded: (Promise<void> | null)[] = [null, null];
  const whole: (Promise<Kept> | null)[] = [null, null];
  const key = (i: number) => `rhea-pools:${network}:${i}`;
  const keep = (i: number, k: Kept): Kept => {
    kept[i] = k;
    void o.store?.set(key(i), rheaKeptText(k)).catch(() => {});
    return k;
  };
  const readWhole = (i: number, rpc: NearRpc, signal?: AbortSignal): Promise<Kept> =>
    (whole[i] ??= (async () => {
      const count = await rheaCount(network, rpc, signal);
      return keep(i, { count, at: now(), rows: await readRheaRange(network, rpc, 0, count, signal) });
    })().finally(() => {
      whole[i] = null;
    }));
  const listOf = async (i: number, rpc: NearRpc, signal?: AbortSignal): Promise<Row[]> => {
    await (loaded[i] ??= (async () => {
      const k = rheaKeptOf((await o.store?.get(key(i)).catch(() => null)) ?? null, now());
      if (k !== null && kept[i] === null) kept[i] = k;
    })());
    const k = kept[i];
    if (k === null) return (await readWhole(i, rpc, signal)).rows;
    try {
      const n = await rheaCount(network, rpc, signal);
      let cur = k;
      if (n < k.count) return (await readWhole(i, rpc, signal)).rows;
      if (n > k.count) cur = keep(i, { count: n, at: k.at, rows: [...k.rows, ...(await readRheaRange(network, rpc, k.count, n, signal))] });
      if (now() - cur.at >= NEAR_RHEA_KEPT_MS) void readWhole(i, rpc).catch(() => {});
      return cur.rows;
    } catch (e) {
      if (signal?.aborted) throw e;
      return k.rows;
    }
  };
  return async (token, signal) => {
    const pair = rpcs();
    const read = await Promise.allSettled([0, 1].map((i) => listOf(i, pair[i]!, signal)));
    const lists = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (lists.length === 0) throw (read[0] as PromiseRejectedResult).reason;
    return rheaCandidatesOf(network, lists, token);
  };
}

/** The kept lists' storage on the page (card near-quote-inside-the-kpi): SIGN_HOST's own IndexedDB, one store of strings
 *  by key; a failed open is opened again on the next use, and every failure reads as nothing kept. */
export function keptDb(idb: IDBFactory = indexedDB): KeptStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (db ??= new Promise<IDBDatabase>((res, rej) => {
      const r = idb.open("ct-near-kept", 1);
      r.onupgradeneeded = () => void r.result.createObjectStore("kept");
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        res(r.result);
      };
      r.onerror = () => rej(r.error);
    }).catch((e) => {
      db = null;
      throw e;
    }));
  const run = <T>(mode: IDBTransactionMode, ask: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then((d) => new Promise<T>((res, rej) => {
      const t = d.transaction("kept", mode);
      const q = ask(t.objectStore("kept"));
      t.oncomplete = () => res(q.result);
      t.onerror = t.onabort = () => rej(t.error);
    }));
  return {
    get: (key) => run("readonly", (s) => s.get(key)).then((v) => (typeof v === "string" ? v : null)),
    set: (key, value) => run("readwrite", (s) => s.put(value, key)).then(() => {}),
  };
}
