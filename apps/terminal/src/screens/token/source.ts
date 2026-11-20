// Where the token page's data comes from. Two routes draw the page. /token/<chain>/<id> (card app-token-route) reads
// GET /v1/market/token for that chain and id (the helper's apps/helper/src/data/solana/token.ts, 06b `TokenPage`) and
// draws its `row`: an id the helper does not know (it answers 404) is the empty state, the page's not-found. / on All
// reads OPEN_TOKEN the same way (card mihao-opens-first, loadHome). / on a chain pick (card app-no-test-token) draws the
// top of Discover's Trending column on that pick (card app-chains-evm-rail):
// one read of every chain's lists (Discover's own read, ../discover/data.ts sharedAllLists, shared with the rail's read
// in flight), narrowed to the pick (pickSnapshot), the first row of the Trending column as Discover orders it
// (columnRows), then the same token read for that token, on its own chain. Display only: nothing here feeds a
// signature. A failed or wrong read is the error state, never another token; an empty column is the empty state. The
// page (TokenPage.tsx) takes `TokenData`.
//
// Card token-page-fills-after (M384): a cold page's row may be the helper's row named on chain (src "chain", helper
// card helper-page-jup-429), its symbol and name read from the mint and its Jupiter fields null. The page's `filling`
// (the helper's TokenPage field) says Jupiter's row is still coming: then those null fields draw loading; a page
// without it (a mint Jupiter does not list, or a helper that does not send it) draws the dash. While the row is named
// on chain the page reads again every FILL_MS, so a mint Jupiter lists later fills without a reload, until the row is
// Jupiter's or the page closes.
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { useCallback, useEffect, useState } from "react";
import { OPEN_TOKEN } from "../../routes/routes.ts";
import { pickSnapshot, sharedAllLists } from "../discover/data.ts";
import type { MarketChain, MarketRow, MarketSnapshot } from "../discover/fields.ts";
import { columnRows } from "../discover/model.ts";
import type { RiskRead } from "../trade/safety.ts";
import { chainNamed, socialLinks, type SocialLinks } from "./model.ts";

/** `risk` is the token read's own `risk` part, which the safety grid draws (what the row lacks: insiders, tax, LP, honeypot).
 *  `filling`: the helper says the row's Jupiter fields are still coming (true only when it sends `filling: true`). */
export type TokenData = { status: "loading" } | { status: "error" } | { status: "empty" } | { status: "ready"; row: MarketRow; risk?: RiskRead; filling?: boolean; decimals?: number; links?: SocialLinks };

/** HELPER_HOST's token read for one token (the CSP's connect-src names the host, public/_headers). */
export const TOKEN_URL = (id: string, chain: MarketChain = "solana") => `https://ct-api.unrealized.trade/v1/market/token?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(id)}`;
/** One token read's own wait for the helper's answer. */
export const TIMEOUT_MS = 10_000;

// Card app-token-page-rides-out-a-slow-token-read: merge group 44618685462 drew /token/robinhood/<cbBTC> in the error
// state while the helper answered that token in 0.6-1.1 s on every read before and after (19 Nov 21:55Z): one read the
// helper did not answer in TIMEOUT_MS was the error state, with no second read. A read the helper does not answer (no
// answer in its wait, a network failure) or answers 5xx or 429 is read again after BACKOFF_MS, while READY_MS from the
// page's first read has room for a read; the error state is a refusal (another status, a body that is not this token's
// row) or READY_MS spent with no answer.
/** How long a token read keeps reading a helper that does not answer before the page draws the error state. */
export const READY_MS = 20_000;
/** The waits before each read again, the last one repeated. */
export const BACKOFF_MS = [500, 1_000, 2_000, 4_000] as const;
/** No read again starts with less of READY_MS left than this: a cold token read took 2.0-2.2 s (19 Nov 21:58Z). */
export const MIN_READ_MS = 2_500;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The helper does not know the token (it answers 404 for an id that is no token of that chain, or one it does not list). */
class Unknown extends Error {}
/** The helper gave no answer to read: none in the read's wait, a network failure, or a 5xx or 429. */
class NoAnswer extends Error {}

/** What a token read waits on; each is the real one unless a test hands its own in. `signal`: the page closed, so no
 *  read again starts. */
export interface ReadDeps {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeout?: (ms: number) => AbortSignal;
  signal?: AbortSignal;
}

const sleepReal = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });

const cutShort = (e: unknown): boolean => isObject(e) && (e.name === "TimeoutError" || e.name === "AbortError");

/** The row and `risk` of one token read, read again while the helper gives no answer (NoAnswer) and READY_MS has room.
 *  Throws Unknown on a 404, NoAnswer once READY_MS is spent (or the page closed), any other Error on another status or a
 *  row that is not this chain's and id's. */
async function readRow(chain: MarketChain, id: string, fetchFn: typeof fetch, deps: ReadDeps = {}): Promise<{ row: MarketRow; risk?: RiskRead; filling: boolean; decimals?: number; links: SocialLinks }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepReal;
  const end = now() + READY_MS;
  for (let n = 0; ; n++) {
    try {
      return await readOnce(chain, id, fetchFn, (deps.timeout ?? AbortSignal.timeout)(Math.min(TIMEOUT_MS, end - now())));
    } catch (e) {
      if (!(e instanceof NoAnswer)) throw e;
      const wait = BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]!;
      if (deps.signal?.aborted || end - now() - wait < MIN_READ_MS) throw e;
      await sleep(wait, deps.signal);
      if (deps.signal?.aborted) throw e;
    }
  }
}

/** One token read, waiting on `signal`. */
async function readOnce(chain: MarketChain, id: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<{ row: MarketRow; risk?: RiskRead; filling: boolean; decimals?: number; links: SocialLinks }> {
  let r: Response;
  try {
    r = await fetchFn(TOKEN_URL(id, chain), { ...HELPER_FETCH_INIT, signal });
  } catch {
    throw new NoAnswer("token: no answer");
  }
  if (r.status === 404) throw new Unknown("token: unknown");
  if (r.status >= 500 || r.status === 429) throw new NoAnswer(`token answered ${r.status}`);
  if (r.status !== 200) throw new Error(`token answered ${r.status}`);
  let body: unknown;
  try {
    body = await r.json();
  } catch (e) {
    // the body cut off by the read's wait is no answer; a body that is not JSON is a refusal
    throw cutShort(e) ? new NoAnswer("token: no answer") : e;
  }
  const row = isObject(body) ? body.row : null;
  const risk = isObject(body) ? body.risk : null;
  if (!isObject(row) || row.chain !== chain || row.token !== id || typeof row.symbol !== "string" || row.symbol === "") throw new Error("token: not this token's row");
  // the mint's decimals (06b TokenPage `decimals`), which the Holders tab reads its base-unit amounts with
  const decimals = isObject(body) && typeof body.decimals === "number" && Number.isInteger(body.decimals) && body.decimals >= 0 && body.decimals <= 30 ? body.decimals : undefined;
  return { row: row as unknown as MarketRow, ...(isObject(risk) ? { risk: risk as RiskRead } : {}), filling: isObject(body) && body.filling === true, ...(decimals === undefined ? {} : { decimals }), links: socialLinks(isObject(body) ? body.links : undefined) };
}

/** The page's data for /token/<chain>/<id>: the token's row, the empty state (not found) for an id the helper does not
 *  know, else the error state. */
export async function loadToken(chain: MarketChain, id: string, fetchFn: typeof fetch = fetch, deps: ReadDeps = {}): Promise<TokenData> {
  try {
    return { status: "ready", ...(await readRow(chain, id, fetchFn, deps)) };
  } catch (e) {
    return e instanceof Unknown ? { status: "empty" } : { status: "error" };
  }
}

/** The page's data: the top Trending token's row on the chain filter's pick (every chain, or one), the empty state when
 *  that column is empty, else the error state. `read` is the lists read (every chain's, shared while in flight). */
export async function loadTopToken(fetchFn: typeof fetch = fetch, pick: MarketChain | "all" = "all", read: (f: typeof fetch) => Promise<MarketSnapshot> = sharedAllLists, deps: ReadDeps = {}): Promise<TokenData> {
  try {
    const top = columnRows(pickSnapshot(await read(fetchFn), pick), "trending")[0];
    if (!top) return { status: "empty" };
    return { status: "ready", ...(await readRow(top.chain, top.token, fetchFn, deps)) };
  } catch {
    return { status: "error" };
  }
}

/** The page's data for /: on All (a fresh open) OPEN_TOKEN, mihao, read as /token/solana/<its mint> is (card
 *  mihao-opens-first); on a chain pick that chain's top Trending token (loadTopToken). */
export async function loadHome(fetchFn: typeof fetch = fetch, pick: MarketChain | "all" = "all", read: (f: typeof fetch) => Promise<MarketSnapshot> = sharedAllLists, deps: ReadDeps = {}): Promise<TokenData> {
  return pick === "all" ? loadToken(OPEN_TOKEN.chain, OPEN_TOKEN.id, fetchFn, deps) : loadTopToken(fetchFn, pick, read, deps);
}

/** How often a page whose row is named on chain reads again (M384). */
export const FILL_MS = 5_000;

/** The page reads again: its row is the helper's named on chain, not Jupiter's (still coming, or not listed yet). */
export const following = (d: TokenData): boolean => d.status === "ready" && chainNamed(d.row);

export interface FillDeps {
  /** Runs `fn` after `ms`; returns its cancel. */
  later?: (fn: () => void, ms: number) => () => void;
  /** The page is out of sight (document.hidden): no read is made until it is back. */
  hidden?: () => boolean;
}

const laterReal = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** Reads once and hands the answer to `onData`; while the answer's row is named on chain (`following`), reads again
 *  every FILL_MS and hands on each ready answer of the same token, until its row is Jupiter's. A failed read again (or another token's, as /
 *  could pick if its Trending column moved) keeps the row drawn and tries FILL_MS later. One read at a time; a hidden
 *  page reads nothing. `load` is handed a signal the stop aborts, so a read the helper does not answer is not read
 *  again once the page closed. Returns the stop. */
export function followToken(load: (signal: AbortSignal) => Promise<TokenData>, onData: (d: TokenData) => void, deps: FillDeps = {}): () => void {
  const later = deps.later ?? laterReal;
  const hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.hidden);
  const closed = new AbortController();
  let stopped = false;
  let token: string | null = null;
  let cancel: () => void = () => undefined;
  const again = () => {
    if (!stopped) cancel = later(() => void step(), FILL_MS);
  };
  async function step(): Promise<void> {
    if (hidden()) return again();
    const d = await load(closed.signal);
    if (stopped) return;
    if (d.status !== "ready" || d.row.token !== token) return again();
    onData(d);
    if (following(d)) again();
  }
  void load(closed.signal).then((d) => {
    if (stopped) return;
    if (d.status === "ready") token = d.row.token;
    onData(d);
    if (following(d)) again();
  });
  return () => {
    stopped = true;
    closed.abort();
    cancel();
  };
}

type Loaded = { data: TokenData; nowMs: number; retry: () => void };

/** The data and the clock of one read: loading until it ends, then read again while its row is named on chain (followToken);
 *  `retry` reads again from loading. The caller keys the component by what it reads, so a read never outlives its
 *  token. */
function useLoaded(load: (signal: AbortSignal) => Promise<TokenData>): Loaded {
  const [data, setData] = useState<TokenData>({ status: "loading" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const stop = followToken(load, (d) => {
      setNowMs(Date.now());
      setData(d);
    });
    return stop;
    // `load` is fixed for this component's life: its caller keys the component by what it reads
  }, [attempt]);
  const retry = useCallback(() => {
    setData({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { data, nowMs, retry };
}

/** The data for /: OPEN_TOKEN on All, the top Trending token on a chain pick (loadHome). The caller keys the component by the pick. */
export const useTopToken = (pick: MarketChain | "all"): Loaded => useLoaded((signal) => loadHome(fetch, pick, sharedAllLists, { signal }));

/** The data for /token/<chain>/<id>. */
export const useToken = (chain: MarketChain, id: string): Loaded => useLoaded((signal) => loadToken(chain, id, fetch, { signal }));
