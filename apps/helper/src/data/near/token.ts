// GET /v1/market/token and /v1/market/holders with chain=near: the token page's NEAR reads, in the fields the other
// chains answer (../solana/token.ts PAGE_FIELDS, RISK_FIELDS and HOLDERS_FIELDS; ../evm/token.ts toPage is the shape
// copied). Any token with a Rhea classic wNEAR pool has a page (lists.ts row: its main pool's price and liquidity, its
// own ft_metadata), listed or not; any other account answers 404.
//
// `pool` is null and `route` "unknown", as on a chain whose pool the page does not trade: trading on NEAR is not open
// here. No view counts a NEP-141 token's holders or names its authorities, LP lock, dev, snipers, tax or honeypot, so
// those fields are null with src "none" (06b `Field`), and the holders answer holds no rows and no count, src "none",
// as the other chains answer with no holders source.
//
// Display only: nothing here feeds a signature.
import { LINKS, type Links } from "../links.ts";
import { NOT_FOUND, type DataAnswer, type Field, type RISK_FIELDS } from "../solana/token.ts";
import type { Row } from "../solana/lists.ts";
import type { NearLists } from "./lists.ts";
import { nearAccount } from "./views.ts";

export type NearTokenPage = { row: Row; decimals: number; pool: null; risk: Record<(typeof RISK_FIELDS)[number], Field<unknown>>; route: "unknown"; filling: false; links: Links };

export function toNearPage(row: Row, decimals: number): NearTokenPage {
  const at = row.as_of_ms as number;
  const none = (): Field<never> => ({ v: null, src: "none", as_of_ms: at });
  return {
    row,
    decimals,
    pool: null,
    risk: {
      mint_auth: none(),
      freeze_auth: none(),
      lp: none(),
      top10_bps: none(),
      dev_bps: none(),
      snipers_bps: none(),
      holders: none(),
      liq_usd: { v: row.liq_usd, src: "chain", as_of_ms: at },
      age_s: none(),
      tax: none(),
      honeypot: none(),
      insiders_bps: none(),
      bundlers_bps: none(),
      fresh_bps: none(),
    },
    route: "unknown",
    filling: false,
    // no NEAR source here names a token's site or socials: what the shared registry holds (../links.ts), else {}
    links: LINKS.of("near", String(row.token)),
  };
}

export function createNearToken(lists: NearLists, now: () => number = Date.now) {
  return {
    async page(token: string): Promise<DataAnswer> {
      const t = nearAccount(token);
      if (t === null) return NOT_FOUND;
      const r = await lists.row(t);
      if (r === null) return NOT_FOUND;
      return { status: 200, body: JSON.stringify(toNearPage(r.row, r.meta.decimals)), src: "chain", asOfMs: r.row.as_of_ms as number };
    },
    async holders(token: string): Promise<DataAnswer> {
      const t = nearAccount(token);
      if (t === null) return NOT_FOUND;
      const r = await lists.row(t);
      if (r === null) return NOT_FOUND;
      const at = now();
      return { status: 200, body: JSON.stringify({ holders: [], total: null, top_bps: null, src: "none", as_of_ms: at }), src: "none", asOfMs: at };
    },
  };
}
export type NearToken = ReturnType<typeof createNearToken>;

/** The NEAR market reads the helper mounts on chain=near. */
export type NearMarket = { lists: NearLists; token: NearToken; trades: import("./trades.ts").NearTrades };
