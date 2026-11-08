// The token page's lower panel and About (card app-token-lower-panel): the helper's GET /v1/market/holders read whole or
// not at all, the Holders tab's count and top share (the read's, else the token row's Jupiter fields), its rows, the
// Trades tab's rows from the tape, and About's window tiles and flow bar from the token row. Pure functions only.
//   node --test apps/terminal/test/token-lower-panel.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketRow } from "../src/screens/discover/fields.ts";
import { aboutView, HOLDERS_URL, holdersSummary, holderViews, readHolders, tapeViews, toHolders } from "../src/screens/token/lower.ts";
import type { Trade } from "../src/screens/token/trades.ts";

const A = "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo";
const B = "BbHG9GvPActFGogv3iNrpDAj4qpXr8t3jF16uGxXcKci";
const BURN = "1nc1nerator11111111111111111111111111111111";
// the shape of a recorded answer (ct-api 8 Nov 12:52Z, cbBTC), cut to three rows
const chain = () => ({
  holders: [
    { addr: A, amt: "63217378033", bps: 2118 },
    { addr: B, amt: "58600100000", bps: 1963 },
    { addr: BURN, amt: "100000000", bps: 3, kind: "burn" },
  ],
  total: 77016,
  top_bps: 5827,
  src: "chain",
  as_of_ms: 1794142123567,
});
const jupiter = () => ({ holders: [], total: 77016, top_bps: 1627, src: "jupiter", as_of_ms: 1794142118691 });

test("the url asks the chain and the token", () => {
  assert.equal(HOLDERS_URL("solana", "Mint111"), "https://ct-api.unrealized.trade/v1/market/holders?chain=solana&token=Mint111");
  assert.match(HOLDERS_URL("solana", "a&b"), /token=a%26b$/);
});

test("a good answer: the rows, the count and the top share as sent; Jupiter's fallback has no rows", () => {
  const h = toHolders(chain());
  assert.ok(h);
  assert.equal(h.holders.length, 3);
  assert.deepEqual(h.holders[2], { addr: BURN, amt: "100000000", bps: 3, kind: "burn" });
  assert.equal(h.total, 77016);
  assert.equal(h.topBps, 5827);
  assert.equal(h.src, "chain");
  assert.deepEqual(toHolders(jupiter()), { holders: [], total: 77016, topBps: 1627, src: "jupiter" });
  assert.deepEqual(toHolders({ ...jupiter(), total: null, top_bps: null }), { holders: [], total: null, topBps: null, src: "jupiter" });
});

test("planted bad answers: each refused whole", () => {
  const row = (k: string, v: unknown) => {
    const b = chain();
    (b.holders[1] as Record<string, unknown>)[k] = v;
    return b;
  };
  const bad: [string, unknown][] = [
    ["null", null],
    ["a list", []],
    ["holders not a list", { ...chain(), holders: {} }],
    ["holders missing", { total: 1, top_bps: 1, src: "chain" }],
    ["over 20 rows", { ...chain(), holders: Array.from({ length: 21 }, () => chain().holders[0]) }],
    ["a row null", { ...chain(), holders: [null] }],
    ["addr empty", row("addr", "")],
    ["addr a number", row("addr", 7)],
    ["amt negative", row("amt", "-1")],
    ["amt a decimal", row("amt", "1.5")],
    ["amt a number", row("amt", 5)],
    ["bps over all", row("bps", 10_001)],
    ["bps a fraction", row("bps", 1.5)],
    ["kind unknown", row("kind", "pool")],
    ["total negative", { ...chain(), total: -1 }],
    ["total a string", { ...chain(), total: "77016" }],
    ["top_bps over all", { ...chain(), top_bps: 10_001 }],
    ["src missing", { ...chain(), src: undefined }],
  ];
  for (const [name, body] of bad) assert.equal(toHolders(body), null, name);
});

test("the read: a 200 answer of the shape; a 404, a throw or a bad body is no read", async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  let asked = "";
  const spy = (async (u: string) => {
    asked = u;
    return new Response(JSON.stringify(chain()), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await readHolders("solana", A, spy))?.total, 77016);
  assert.equal(asked, HOLDERS_URL("solana", A));
  assert.equal(await readHolders("base", A, answer(404, { error: { code: "not_found" } })), null);
  assert.equal(await readHolders("solana", A, answer(200, { holders: "x" })), null);
  assert.equal(await readHolders("solana", A, (async () => { throw new Error("down"); }) as unknown as typeof fetch), null);
});

const row = (o: Partial<MarketRow> = {}): MarketRow => ({
  chain: "solana", token: "Mint", symbol: "SYM", name: "Sym", icon: false, price_usd: "2", src: "jupiter", as_of_ms: 1, launchpad: null,
  mc_usd: "2000000", holders: 2680, top10_bps: 1627, ...o,
});

test("the Holders tab's count and top share: the read's, else the token row's (Jupiter until the holders key); none is the dash", () => {
  assert.deepEqual(holdersSummary(toHolders(chain()), row()), { count: "77.0K", top: "58%" });
  assert.deepEqual(holdersSummary(toHolders(jupiter()), row()), { count: "77.0K", top: "16%" });
  // no read (a chain the helper serves no holders for, or a failed read): the token row's own Jupiter fields
  assert.deepEqual(holdersSummary(null, row()), { count: "2,680", top: "16%" });
  assert.deepEqual(holdersSummary({ holders: [], total: null, topBps: null, src: "jupiter" }, row({ holders: null, top10_bps: null })), { count: "—", top: "—" });
});

test("holder rows: the value at the token's price, the amount in whole tokens, the share of supply, the bar against the biggest; burn and creator marked", () => {
  const v = holderViews(toHolders(chain())!.holders, { decimals: 8, priceUsd: "2", creator: B });
  assert.equal(v.length, 3);
  assert.deepEqual(v[0], { addr: A, usd: "$1.26K", amount: "632.17", share: "21.2%", width: 100, burn: false, creator: false });
  assert.equal(v[1]!.creator, true);
  assert.equal(v[1]!.share, "19.6%");
  assert.equal(v[1]!.width, Number(((1963 / 2118) * 100).toFixed(1)));
  // a burn row is not circulating: it never sets the bar's scale
  assert.equal(v[2]!.burn, true);
  // no decimals or no price read: no amount or value drawn, never a guess
  const none = holderViews(toHolders(chain())!.holders, { decimals: null, priceUsd: null, creator: null });
  assert.equal(none[0]!.amount, "—");
  assert.equal(none[0]!.usd, "—");
  assert.equal(none[0]!.share, "21.2%");
  assert.equal(holderViews([{ addr: A, amt: "1", bps: null }], { decimals: 0, priceUsd: "1", creator: null })[0]!.share, "—");
});

const T0 = 1_794_142_000_000;
const trade = (o: Partial<Trade> = {}): Trade => ({ t_ms: T0 - 65_000, side: "buy", usd: "15", amt: "5490", trader: A, tx: "t1", ...o });

test("trade rows: age, side, the trade's MC (its price times the supply), amount, total, the bar against the biggest, the trader", () => {
  const v = tapeViews([trade(), trade({ side: "sell", usd: "1092.02", amt: "405200", trader: null, tx: "t2", t_ms: T0 - 3_000 })], { supply: 1_000_000, creator: A, nowMs: T0 });
  assert.equal(v.length, 2);
  assert.deepEqual(v[0], { key: "t1", age: "1m", side: "buy", mc: "$2.73K", amount: "5.49K", total: "$15.00", width: Number(((15 / 1092.02) * 100).toFixed(1)), trader: A, creator: true });
  assert.deepEqual(v[1], { key: "t2", age: "3s", side: "sell", mc: "$2.70K", amount: "405.2K", total: "$1,092.02", width: 100, trader: null, creator: false });
  // no supply read: no MC drawn
  assert.equal(tapeViews([trade()], { supply: null, creator: null, nowMs: T0 })[0]!.mc, "—");
  assert.deepEqual(tapeViews([], { supply: 1, creator: null, nowMs: T0 }), []);
});

test("About: the four windows from the row (4H dashed when not served), the 5m tiles, the flow bar of the 24h buys and sells", () => {
  const a = aboutView(row({ chg_5m_bps: 46, chg_1h_bps: -1294, chg_4h_bps: null, chg_24h_bps: 802, vol_5m_usd: "51110", buys_5m: 1, sells_5m: 2, net_5m_usd: "-51080.4", buys_24h: 285, sells_24h: 260 }));
  assert.deepEqual(a.windows, [
    { id: "5M", text: "+0.46%", tone: "acc" },
    { id: "1H", text: "−12.94%", tone: "sell" },
    { id: "4H", text: "—", tone: "none" },
    { id: "1D", text: "+8.02%", tone: "acc" },
  ]);
  assert.deepEqual(a.five, { vol: "$51.1K", buys: "1", sells: "2", net: "−$51.1K", netTone: "sell" });
  assert.deepEqual(a.flow, { buys: "285", sells: "260", buyPct: Number(((285 / 545) * 100).toFixed(1)) });
  // nothing served: every value the dash, the bar unknown
  const none = aboutView(row());
  assert.deepEqual(none.windows.map((w) => w.text), ["—", "—", "—", "—"]);
  assert.deepEqual(none.five, { vol: "—", buys: "—", sells: "—", net: "—", netTone: "none" });
  assert.deepEqual(none.flow, { buys: "—", sells: "—", buyPct: null });
  assert.equal(aboutView(row({ net_5m_usd: "27518.8" })).five.net, "+$27.5K");
  assert.equal(aboutView(row({ buys_24h: 0, sells_24h: 0 })).flow.buyPct, null);
});
