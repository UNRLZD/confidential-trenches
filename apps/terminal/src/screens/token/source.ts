// Where the token page's data comes from. Two routes draw the page. /token/<chain>/<id> (card app-token-route) reads
// GET /v1/market/token for that chain and id (the helper's apps/helper/src/data/solana/token.ts, 06b `TokenPage`) and
// draws its `row`: an id the helper does not know (it answers 404) is the empty state, the page's not-found. / (card
// app-no-test-token) draws the top of Discover's Trending column: one read of GET /v1/market/lists?chain=solana
// (Discover's own read, ../discover/data.ts), the first row of the Trending column as Discover orders it (columnRows),
// then the same token read for that mint. Display only: nothing here feeds a signature. A failed or wrong read is the
// error state, never another token; an empty column is the empty state. The page (TokenPage.tsx) takes `TokenData`.
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { useCallback, useEffect, useState } from "react";
import { readLists } from "../discover/data.ts";
import type { MarketChain, MarketRow } from "../discover/fields.ts";
import { columnRows } from "../discover/model.ts";
import type { RiskRead } from "../trade/safety.ts";

/** `risk` is the token read's own `risk` part, which the safety grid draws (what the row lacks: insiders, tax, LP, honeypot). */
export type TokenData = { status: "loading" } | { status: "error" } | { status: "empty" } | { status: "ready"; row: MarketRow; risk?: RiskRead };

/** HELPER_HOST's token read for one token (the CSP's connect-src names the host, public/_headers). */
export const TOKEN_URL = (id: string, chain: MarketChain = "solana") => `https://api.confidential.unrealized.trade/v1/market/token?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(id)}`;
const TIMEOUT_MS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The helper does not know the token (it answers 404 for an id that is no token of that chain, or one it does not list). */
class Unknown extends Error {}

/** The row and `risk` of one token read. Throws Unknown on a 404, any other Error on a failed read, another status, or a
 *  row that is not this chain's and id's. */
async function readRow(chain: MarketChain, id: string, fetchFn: typeof fetch): Promise<{ row: MarketRow; risk?: RiskRead }> {
  const r = await fetchFn(TOKEN_URL(id, chain), { ...HELPER_FETCH_INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status === 404) throw new Unknown("token: unknown");
  if (r.status !== 200) throw new Error(`token answered ${r.status}`);
  const body: unknown = await r.json();
  const row = isObject(body) ? body.row : null;
  const risk = isObject(body) ? body.risk : null;
  if (!isObject(row) || row.chain !== chain || row.token !== id || typeof row.symbol !== "string" || row.symbol === "") throw new Error("token: not this token's row");
  return { row: row as unknown as MarketRow, ...(isObject(risk) ? { risk: risk as RiskRead } : {}) };
}

/** The page's data for /token/<chain>/<id>: the token's row, the empty state (not found) for an id the helper does not
 *  know, else the error state. */
export async function loadToken(chain: MarketChain, id: string, fetchFn: typeof fetch = fetch): Promise<TokenData> {
  try {
    return { status: "ready", ...(await readRow(chain, id, fetchFn)) };
  } catch (e) {
    return e instanceof Unknown ? { status: "empty" } : { status: "error" };
  }
}

/** The page's data: the top Trending token's row, the empty state when the column is empty, else the error state. */
export async function loadTopToken(fetchFn: typeof fetch = fetch): Promise<TokenData> {
  try {
    const top = columnRows(await readLists(fetchFn), "trending")[0];
    if (!top) return { status: "empty" };
    return { status: "ready", ...(await readRow("solana", top.token, fetchFn)) };
  } catch {
    return { status: "error" };
  }
}

type Loaded = { data: TokenData; nowMs: number; retry: () => void };

/** The data and the clock of one read: loading until it ends; `retry` reads again from loading. The caller keys the
 *  component by what it reads, so a read never outlives its token. */
function useLoaded(load: () => Promise<TokenData>): Loaded {
  const [data, setData] = useState<TokenData>({ status: "loading" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void load().then((d) => {
      if (!live) return;
      setNowMs(Date.now());
      setData(d);
    });
    return () => {
      live = false;
    };
    // `load` is fixed for this component's life: its caller keys the component by what it reads
  }, [attempt]);
  const retry = useCallback(() => {
    setData({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { data, nowMs, retry };
}

/** The data for /: the top Trending token. */
export const useTopToken = (): Loaded => useLoaded(() => loadTopToken());

/** The data for /token/<chain>/<id>. */
export const useToken = (chain: MarketChain, id: string): Loaded => useLoaded(() => loadToken(chain, id));
