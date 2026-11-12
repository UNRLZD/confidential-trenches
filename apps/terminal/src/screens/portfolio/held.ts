// Portfolio's market data for the tokens the device holds (card market-token-reads), from the kit's held read over the
// helper (readHeldMarket, readHeldHistory) and the value line the kit computes from the signing page's own positions and
// ops (heldValueSeries), and the trade book from those ops (model.ts tradeBook: the closed round trips, each open one's
// bought, sold and realized). The helper is sent each held token's chain and id only, never an amount or a wallet. Whether a
// token sells now is the device's own sell quote, which the signing page does not send yet: `route` is null (not read),
// so no row is marked on the helper's word. Display only: nothing here feeds a signature.
import { heldKey, heldValueSeries } from "@blindfill/kit";
import type { Chain, HeldBar, HeldMarket, HeldRef, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { NO_DATA, portfolio, tradeBook } from "./model.ts";
import type { PortfolioData, PositionExtra, TokenMarket } from "./model.ts";

/** Each held token once, by chain then token. */
export function heldRefs(state: SignpageState | null): HeldRef[] {
  const seen = new Map<string, HeldRef>();
  for (const p of state?.positions ?? []) seen.set(heldKey(p.chain, p.token), { chain: p.chain, token: p.token });
  return [...seen.values()].sort((a, b) => (a.chain === b.chain ? (a.token < b.token ? -1 : a.token > b.token ? 1 : 0) : a.chain < b.chain ? -1 : 1));
}

/** PortfolioData from the held reads: the market of each token the read names, and the value line ending at the total. */
export function heldData(snap: SignpageClientSnapshot, markets: readonly HeldMarket[], history: ReadonlyMap<string, readonly HeldBar[]>, now: number): PortfolioData {
  const byKey = new Map<string, TokenMarket>();
  for (const m of markets) {
    if (m.symbol === null && m.name === null && m.price_usd === null) continue;
    byKey.set(heldKey(m.chain, m.token), { symbol: m.symbol ?? m.token.slice(0, 6), name: m.name ?? "", price: m.price_usd, route: null });
  }
  const market = (chain: Chain, token: string): TokenMarket | null => byKey.get(heldKey(chain, token)) ?? null;
  const s = snap.state;
  // the closed round trips and each open one's bought, sold, realized and opened time, from the device's own trade ops
  const book = s ? tradeBook(s.ops, s.positions) : null;
  const extra = (chain: Chain, token: string): PositionExtra | null => book?.open.get(`${chain}:${token}`) ?? null;
  const own: PortfolioData = { ...NO_DATA, market, extra, closed: book?.closed ?? [] };
  const t = portfolio(snap, own, now).totals;
  if (!s || !t) return own;
  // the open buys' wallets' coin is no token's value: it joins the base, so the line ends at the total
  const base = t.cash + t.onWay + t.held;
  const baseUsd = `${base < 0n ? "0" : base / 100n}.${(base < 0n ? 0n : base % 100n).toString().padStart(2, "0")}`;
  const series = heldValueSeries({ positions: s.positions, markets, history, ops: s.ops, base_usd: baseUsd, now });
  return { ...own, series };
}
