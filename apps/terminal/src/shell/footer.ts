// The desktop footer's data (card app-footer-bar; R5's footer, design/proto/assets/app.js:375-385 at design-lock-r5).
// Only what is read is drawn:
// - the block and the connection: NEAR's final block, read on the release's pair (the two RPCs Verify reads, already
//   in APP_HOST's connect-src; a testnet build reads the testnet pair), the first that answers, every BLOCK_EVERY_MS
//   while the page shows. An answer is Stable with its round trip; no answer from either is Offline. The block drawn
//   is the highest final block read, so one RPC a block behind the other never draws the chain going back.
// - the prices: SOL and ETH in USD only as the signing page read them for the pools (state.pools[].price: Pyth's
//   SOL/USD and Chainlink's ETH/USD, each on two RPCs of two providers that agree), within their feed's bound
//   (trade/model.ts statePoolPrice, the one rule the trade box prices with). Signed out the page reads none, so none
//   is drawn. R5's other coins (ZEC, BNB, XRP, DOGE, TRX, SUI) and its 24 h changes have no source the app reads.
// - the links: Terms, Privacy and the Verify pill, each a route the app has (routes/routes.ts). R5's Risks, Help, X,
//   Docs and Telegram have no page and are not drawn.
import type { NearNetwork, SignpageState } from "@blindfill/kit";
import { statePoolPrice } from "../screens/trade/model.ts";
import { VERIFY_RELEASES } from "../screens/verify/release.ts";

/** How often the block is read while the page shows: NEAR finalises about every 0.6 s, so each read draws a new block. */
export const BLOCK_EVERY_MS = 3_000;
/** One RPC's answer is waited this long before the other is asked. */
export const BLOCK_READ_MS = 5_000;

interface Word {
  text: string;
  source: string;
  draft: boolean;
}
const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

/** Every word the footer draws. Numbers, block heights, the round trip's "ms" and coin symbols are data, not copy. */
export const FOOTER_WORDS = {
  stable: draft("Stable", "design-lock-r5 app.js:379 (the connection's state, UNRLZD's SiteFooter); 09-design-brief S1.19 [draft copy: Stable]"),
  offline: ok("Offline", "owner 1 Nov 16:45Z, keep (sign-in, Discover, token page); design-lock-r5 app.js:379, the footer's offline state"),
  connection: draft("Connection", "design-lock-r5 app.js:380 (Connection 185 ms)"),
  block: ok("Block", "owner 2 Nov 06:08Z, all approved (Verify's Block); design-lock-r5 app.js:381 (Block 220,948,200)"),
  terms: ok("Terms", "shipped (card app-shell); design-lock-r5 app.js:381"),
  privacy: ok("Privacy", "shipped (card app-shell); design-lock-r5 app.js:381"),
} as const satisfies Record<string, Word>;

/** The footer's page links, in R5's order; the Verify pill names the panel (verify/words.ts title). */
export const FOOTER_LINKS = { terms: "/terms", privacy: "/privacy", verify: "/verify" } as const;

/** The pair the footer reads: the release's, as Verify reads it. */
export const footerRpcs = (network: NearNetwork): readonly string[] => VERIFY_RELEASES[network].rpcs;

export type BlockRead = { height: number; ms: number };

/** NEAR's final block from the first RPC of `rpcs` that answers one, with that answer's round trip in ms; null when none does. */
export async function readFinalBlock(rpcs: readonly string[], fetchFn: typeof fetch = fetch, clock: () => number = () => performance.now()): Promise<BlockRead | null> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "ct-footer", method: "block", params: { finality: "final" } });
  for (const url of rpcs) {
    const t0 = clock();
    try {
      const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(BLOCK_READ_MS) });
      if (!res.ok) continue;
      const height = ((await res.json()) as { result?: { header?: { height?: unknown } } })?.result?.header?.height;
      if (typeof height === "number" && Number.isSafeInteger(height) && height > 0) return { height, ms: Math.round(clock() - t0) };
    } catch {
      // a failed or slow RPC: the next one is asked; neither answering draws Offline
    }
  }
  return null;
}

/** wait: no read has ended yet; on: the last read answered; off: it did not (the last block read stays drawn). */
export type Conn = { kind: "wait" } | { kind: "on"; height: number; ms: number } | { kind: "off"; height: number | null };

export function nextConn(prev: Conn, read: BlockRead | null): Conn {
  const last = prev.kind === "wait" ? null : prev.height;
  if (!read) return { kind: "off", height: last };
  return { kind: "on", height: Math.max(read.height, last ?? 0), ms: read.ms };
}

export type Tick = { sym: "SOL" | "ETH"; usd: number };

/** The coins' USD prices the signing page read and that are still within their feed's bound at `nowMs`. */
export function footerTicks(pools: SignpageState["pools"], nowMs: number): Tick[] {
  const usd = (chain: "solana" | "base" | "robinhood"): number | null => {
    const p = statePoolPrice(pools, chain, nowMs);
    return p ? Number(p.price) / 10 ** -p.expo : null;
  };
  const ticks: Tick[] = [];
  const sol = usd("solana");
  if (sol !== null) ticks.push({ sym: "SOL", usd: sol });
  const eth = usd("base") ?? usd("robinhood");
  if (eth !== null) ticks.push({ sym: "ETH", usd: eth });
  return ticks;
}

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** R5's ticker form: whole dollars from $1,000 ("$2,467"), cents under it ("$106.83"). */
export const fmtUsd = (n: number): string => `$${n >= 1000 ? whole.format(n) : cents.format(n)}`;

export const fmtBlock = (h: number): string => whole.format(h);
