// Where Discover's data comes from: GET /v1/market/lists?chain=<chain> on HELPER_HOST for Solana, Base and Robinhood
// (card app-discover-live for Solana, apps/helper/src/data/solana/lists.ts; card app-chains-evm for Base and Robinhood,
// apps/helper/src/data/evm/lists.ts), merged in the browser into one snapshot (09-design-brief S1 Chain filter: "`All`
// merges the four chains' served lists in the browser"); the shell's chain filter narrows it to one chain (pickSnapshot).
// Each answer is 06b's `snapshot` of `Row`s (fields.ts), 38 fields a row, every chain the same list. Display only: nothing
// here feeds a signature, so a row that is not a row is dropped and the rest is drawn as the helper sent it. NEAR joins
// when the helper serves its lists (it answers chain=near 404 today).
// The helper refreshes the lists every 12 s; since app-console-429 it answers its last good read, dated by as_of_ms, on a
// 200 however old it is, and never a 503 once it has one. So the screen reads on that cadence and shows two separate
// things: how old the data is, as the list's age once its read is older than 60 s (model.ts listAge, card app-list-age);
// and whether the helper answers, as the error state, only after 60 s with no 200 (afterFail). Each chain's answer is
// held by the same rule on its own (allListsReader): one chain's failed read keeps its last good lists for 60 s and
// never empties the others.
// The token page's rail and / still read Solana's lists alone (readLists, rail.ts): they move with their own live checks.
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { useCallback, useEffect, useState } from "react";
import type { DiscoverData } from "./Discover.tsx";
import type { MarketChain, MarketRow, MarketSnapshot } from "./fields.ts";
import { SNAPSHOT_LISTS } from "./fields.ts";

/** The chains whose lists the helper serves, in the chain filter's order (routes.ts TOKEN_CHAINS). */
export const LIST_CHAINS = ["solana", "base", "robinhood"] as const satisfies readonly MarketChain[];
export type ListChain = (typeof LIST_CHAINS)[number];

/** HELPER_HOST: the helper the CSP's connect-src names (public/_headers). */
export const listsUrl = (chain: ListChain): string => `https://ct-api.unrealized.trade/v1/market/lists?chain=${chain}`;
export const HELPER_URL = listsUrl("solana");
export const REFRESH_MS = 12_000;
export const STALE_MS = 60_000;
const TIMEOUT_MS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRow = (v: unknown): v is MarketRow => isObject(v) && typeof v.token === "string" && v.token !== "" && typeof v.symbol === "string" && v.symbol !== "";

/** One read of one chain's lists. Throws on a failed read, a non-200 answer, an answer that is not that chain's
 *  snapshot. A row of another chain is dropped. */
export async function readChainLists(chain: ListChain, fetchFn: typeof fetch = fetch): Promise<MarketSnapshot> {
  const r = await fetchFn(listsUrl(chain), { ...HELPER_FETCH_INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status !== 200) throw new Error(`lists answered ${r.status}`);
  const body: unknown = await r.json();
  if (!isObject(body) || body.chain !== chain || !isObject(body.lists) || typeof body.as_of_ms !== "number") throw new Error(`lists: not a ${chain} snapshot`);
  const lists: Record<string, MarketRow[]> = {};
  for (const [name, rows] of Object.entries(body.lists)) {
    if (!Array.isArray(rows)) throw new Error(`lists: ${name} is not a list`);
    lists[name] = rows.filter((x): x is MarketRow => isRow(x) && x.chain === chain);
  }
  if (!lists.new || !lists.trending) throw new Error("lists: new or trending missing");
  return { chain, as_of_ms: body.as_of_ms, lists: lists as unknown as MarketSnapshot["lists"] };
}

/** One read of Solana's lists (the token page's rail and /). */
export const readLists = (fetchFn: typeof fetch = fetch): Promise<MarketSnapshot> => readChainLists("solana", fetchFn);

/** Each chain's own read time (as_of_ms) in a merged snapshot, so one chain's view dates its lists by its own read. */
const AS_OF = new WeakMap<MarketSnapshot, Partial<Record<MarketChain, number>>>();

/** The chains' snapshots as one: each list the chains' rows in LIST_CHAINS order, dated by the oldest read. */
export function mergeLists(parts: readonly MarketSnapshot[]): MarketSnapshot {
  const lists: Record<string, MarketRow[]> = {};
  const asOf: Partial<Record<MarketChain, number>> = {};
  for (const p of parts) {
    if (p.chain !== "all") asOf[p.chain] = p.as_of_ms;
    for (const name of SNAPSHOT_LISTS) {
      const rows = p.lists[name];
      if (rows) (lists[name] ??= []).push(...rows);
    }
  }
  lists.new ??= [];
  lists.trending ??= [];
  const s: MarketSnapshot = { chain: "all", as_of_ms: Math.min(...parts.map((p) => p.as_of_ms)), lists: lists as unknown as MarketSnapshot["lists"] };
  AS_OF.set(s, asOf);
  return s;
}

/** The snapshot on the chain filter's pick: every chain, or one chain's rows dated by that chain's own read. */
export function pickSnapshot(s: MarketSnapshot, pick: MarketChain | "all"): MarketSnapshot {
  if (pick === "all" || s.chain === pick) return s;
  const lists: Record<string, MarketRow[]> = {};
  for (const [name, rows] of Object.entries(s.lists)) if (rows) lists[name] = rows.filter((r) => r.chain === pick);
  return { chain: pick, as_of_ms: AS_OF.get(s)?.[pick] ?? s.as_of_ms, lists: lists as unknown as MarketSnapshot["lists"] };
}

/** Discover's data on the shell's chain filter: every chain's lists, or one chain's (pickSnapshot). */
export const pickData = (data: DiscoverData, pick: MarketChain | "all"): DiscoverData => (data.status === "ready" ? { status: "ready", snapshot: pickSnapshot(data.snapshot, pick) } : data);

/**
 * A reader of every chain's lists, merged (mergeLists). Each chain is read at once; a chain whose read fails keeps its
 * last good lists while its last 200 came at most STALE_MS ago (afterFail's rule, per chain), else it is left out. It
 * throws only when no chain has lists to draw, so the caller's error rule (afterFail) still runs on the whole.
 */
export function allListsReader(deps: { now?: () => number; chains?: readonly ListChain[] } = {}) {
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? LIST_CHAINS;
  const held = new Map<ListChain, { s: MarketSnapshot; at: number }>();
  return async (fetchFn: typeof fetch = fetch): Promise<MarketSnapshot> => {
    const got = await Promise.allSettled(chains.map((c) => readChainLists(c, fetchFn)));
    const t = now();
    const parts: MarketSnapshot[] = [];
    chains.forEach((c, i) => {
      const g = got[i]!;
      if (g.status === "fulfilled") held.set(c, { s: g.value, at: t });
      const h = held.get(c);
      if (h && t - h.at <= STALE_MS) parts.push(h.s);
    });
    if (!parts.length) throw new Error("lists: no chain answered");
    return mergeLists(parts);
  };
}

/** The app's one reader of every chain's lists (Discover and the search). */
export const readAllLists = allListsReader();

let inflight: { fetchFn: typeof fetch; p: Promise<MarketSnapshot> } | null = null;

/** readAllLists, one read for every caller while one is in flight with the same fetch. */
export function sharedAllLists(fetchFn: typeof fetch = fetch): Promise<MarketSnapshot> {
  if (inflight && inflight.fetchFn === fetchFn) return inflight.p;
  const p = readAllLists(fetchFn).finally(() => {
    if (inflight?.p === p) inflight = null;
  });
  inflight = { fetchFn, p };
  return p;
}

/** What one failed re-read leaves on screen: the lists as they were while the last 200 came at most STALE_MS ago, else
 *  the error state. It counts from the last 200 on this device, not from the lists' read time: how old the lists are is
 *  the age line's job, so a list served hours old survives a blip. */
export const afterFail = (data: DiscoverData, lastGoodMs: number | null, nowMs: number): DiscoverData =>
  lastGoodMs !== null && nowMs - lastGoodMs <= STALE_MS ? data : { status: "error" };

/** The data and the clock for Discover: loading until the first read, then every chain's lists, re-read every 12 s. A
 *  failed re-read keeps the last good lists until 60 s pass with no 200; `retry` reads again from the loading state. */
export function useDiscoverData(): { data: DiscoverData; nowMs: number; retry: () => void } {
  const [data, setData] = useState<DiscoverData>({ status: "loading" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    let lastGood: number | null = null;
    const read = () =>
      sharedAllLists().then(
        (snapshot) => {
          if (!live) return;
          lastGood = Date.now();
          setNowMs(lastGood);
          setData({ status: "ready", snapshot });
        },
        () => {
          if (!live) return;
          const now = Date.now();
          // the clock moves on a failed read too, so a kept list's age keeps counting
          setNowMs(now);
          setData((d) => afterFail(d, lastGood, now));
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
