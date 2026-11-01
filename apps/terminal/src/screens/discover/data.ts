// Where Discover's data comes from: GET /v1/market/lists?chain=solana on HELPER_HOST (card app-discover-live; the route is
// apps/helper/src/data/solana/lists.ts). The answer is 06b's `snapshot` of `Row`s (fields.ts), 38 fields a row. Display
// only: nothing here feeds a signature, so a row that is not a row is dropped and the rest is drawn as the helper sent it.
// The helper refreshes the lists every 12 s and serves its last good read up to 60 s, so the screen reads on that cadence
// and shows the error state once a minute has passed with no good read.
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { useCallback, useEffect, useState } from "react";
import type { DiscoverData } from "./Discover.tsx";
import type { MarketRow, MarketSnapshot } from "./fields.ts";

/** HELPER_HOST: the helper the CSP's connect-src names (public/_headers). */
export const HELPER_URL = "https://api.confidential.unrealized.trade/v1/market/lists?chain=solana";
export const REFRESH_MS = 12_000;
export const STALE_MS = 60_000;
const TIMEOUT_MS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRow = (v: unknown): v is MarketRow => isObject(v) && typeof v.token === "string" && v.token !== "" && typeof v.symbol === "string" && v.symbol !== "";

/** One read of the lists. Throws on a failed read, a non-200 answer, an answer that is not a Solana snapshot. */
export async function readLists(fetchFn: typeof fetch = fetch): Promise<MarketSnapshot> {
  const r = await fetchFn(HELPER_URL, { ...HELPER_FETCH_INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status !== 200) throw new Error(`lists answered ${r.status}`);
  const body: unknown = await r.json();
  if (!isObject(body) || body.chain !== "solana" || !isObject(body.lists) || typeof body.as_of_ms !== "number") throw new Error("lists: not a Solana snapshot");
  const lists: Record<string, MarketRow[]> = {};
  for (const [name, rows] of Object.entries(body.lists)) {
    if (!Array.isArray(rows)) throw new Error(`lists: ${name} is not a list`);
    lists[name] = rows.filter(isRow);
  }
  if (!lists.new || !lists.trending) throw new Error("lists: new or trending missing");
  return { chain: "solana", as_of_ms: body.as_of_ms, lists: lists as unknown as MarketSnapshot["lists"] };
}

/** The data and the clock for Discover: loading until the first read, then the lists, re-read every 12 s. A failed
 *  re-read keeps the last good lists until they are 60 s old; `retry` reads again from the loading state. */
export function useDiscoverData(): { data: DiscoverData; nowMs: number; retry: () => void } {
  const [data, setData] = useState<DiscoverData>({ status: "loading" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    let lastGood = 0;
    const read = () =>
      readLists().then(
        (snapshot) => {
          if (!live) return;
          lastGood = Date.now();
          setNowMs(lastGood);
          setData({ status: "ready", snapshot });
        },
        () => {
          if (live && Date.now() - lastGood > STALE_MS) setData({ status: "error" });
        },
      );
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [attempt]);
  const retry = useCallback(() => {
    setData({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { data, nowMs, retry };
}
