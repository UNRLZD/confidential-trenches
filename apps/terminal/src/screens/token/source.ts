// Where the token page's data comes from (card app-no-test-token): the route at / draws the top of Discover's Trending
// column. One read of GET /v1/market/lists?chain=solana (Discover's own read, ../discover/data.ts), the first row of
// the Trending column as Discover orders it (columnRows), then GET /v1/market/token for that mint (the helper's
// apps/helper/src/data/solana/token.ts, 06b `TokenPage`), whose `row` the page draws. Display only: nothing here feeds
// a signature. A failed or wrong read is the error state, never another token; an empty column is the empty state.
// The page (TokenPage.tsx) takes `TokenData` and does not change.
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { useCallback, useEffect, useState } from "react";
import { readLists } from "../discover/data.ts";
import type { MarketRow } from "../discover/fields.ts";
import { columnRows } from "../discover/model.ts";

export type TokenData = { status: "loading" } | { status: "error" } | { status: "empty" } | { status: "ready"; row: MarketRow };

/** HELPER_HOST's token read for a Solana mint (the CSP's connect-src names the host, public/_headers). */
export const TOKEN_URL = (mint: string) => `https://api.confidential.unrealized.trade/v1/market/token?chain=solana&token=${encodeURIComponent(mint)}`;
const TIMEOUT_MS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The row of one token read. Throws on a failed read, a non-200 answer, or a row that is not this Solana mint's. */
async function readRow(mint: string, fetchFn: typeof fetch): Promise<MarketRow> {
  const r = await fetchFn(TOKEN_URL(mint), { ...HELPER_FETCH_INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status !== 200) throw new Error(`token answered ${r.status}`);
  const body: unknown = await r.json();
  const row = isObject(body) ? body.row : null;
  if (!isObject(row) || row.chain !== "solana" || row.token !== mint || typeof row.symbol !== "string" || row.symbol === "") throw new Error("token: not this mint's row");
  return row as unknown as MarketRow;
}

/** The page's data: the top Trending token's row, the empty state when the column is empty, else the error state. */
export async function loadTopToken(fetchFn: typeof fetch = fetch): Promise<TokenData> {
  try {
    const top = columnRows(await readLists(fetchFn), "trending")[0];
    if (!top) return { status: "empty" };
    return { status: "ready", row: await readRow(top.token, fetchFn) };
  } catch {
    return { status: "error" };
  }
}

/** The data and the clock for the token route: loading until the read ends; `retry` reads again from loading. */
export function useTopToken(): { data: TokenData; nowMs: number; retry: () => void } {
  const [data, setData] = useState<TokenData>({ status: "loading" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void loadTopToken().then((d) => {
      if (!live) return;
      setNowMs(Date.now());
      setData(d);
    });
    return () => {
      live = false;
    };
  }, [attempt]);
  const retry = useCallback(() => {
    setData({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { data, nowMs, retry };
}
