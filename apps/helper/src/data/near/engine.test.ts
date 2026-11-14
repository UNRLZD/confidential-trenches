// chain=near from the unrealized.trade engine (card every-cell-shows-a-value), replayed from its real answers of
// 2026-11-14 03:53Z (fixtures/engine-2026-11-14: the four lists at limit 3, and dragons-2.nearlytrade.near's token,
// holders cut to 12, trades cut to 6, 1m candles at limit 4; the LP lock keys, which nothing here reads, left out). Before this card every NEAR list row's market cap,
// holders, launch time, launchpad and buy and sell counts were null (lists.ts: Rhea's views give none of them), the
// token page's risk grid had only liquidity, and its holders answer held no rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROW_FIELDS } from "../../../../terminal/src/screens/discover/fields.ts";
import { PAGE_FIELDS, RISK_FIELDS } from "../solana/token.ts";
import { createEngineNear, engineFirst, engineRisk, engineRow, ENGINE, LISTS_MS, STALE_MS } from "./engine.ts";
import type { NearMarket } from "./token.ts";
import type { Fetch } from "./views.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/engine-2026-11-14/${name}.json`, import.meta.url), "utf8");
const T = "dragons-2.nearlytrade.near";
const ROUTES: Record<string, string> = {
  "/discover?column=new&limit=50": "discover-new",
  "/discover?column=graduating&limit=50": "discover-graduating",
  "/trending?window=5m&limit=50": "trending-5m",
  "/trending?window=1h&limit=50": "trending-1h",
  [`/token/${T}`]: "token",
  [`/token/${T}/holders`]: "holders",
  [`/token/${T}/trades`]: "trades",
  [`/token/${T}/candles?tf=1m&limit=4`]: "candles",
};
const AT = Date.UTC(2026, 10, 14, 3, 53);

function engine(opts: { down?: boolean; asked?: string[]; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: AT };
  const fetch: Fetch = async (url) => {
    assert.ok(url.startsWith(ENGINE), url);
    const path = url.slice(ENGINE.length);
    opts.asked?.push(path);
    if (opts.down) return new Response("bad gateway", { status: 502 });
    const name = ROUTES[path];
    return name === undefined ? new Response('{"error":"not found"}', { status: 404 }) : new Response(fx(name), { status: 200 });
  };
  return createEngineNear({ fetch, now: () => clock.t });
}

/** Rhea's reads as the fallback: each answer names itself, so a test sees which source served it. */
const rhea = (asked: string[]): NearMarket =>
  ({
    lists: { get: async () => (asked.push("rhea lists"), { status: 200, body: '{"rhea":true}' }), scan: () => null },
    token: { page: async () => (asked.push("rhea page"), { status: 200, body: '{"rhea":"page"}' }), holders: async () => (asked.push("rhea holders"), { status: 200, body: '{"rhea":"holders"}' }) },
    trades: { trades: async () => (asked.push("rhea trades"), { status: 200, body: '{"rhea":"trades"}' }), candles: async () => (asked.push("rhea candles"), { status: 200, body: '{"rhea":"candles"}' }) },
  }) as unknown as NearMarket;

test("lists: every row the engine gives carries market cap, price, holders, launch time and buy and sell counts; New, Graduating and both Trending windows filled", async () => {
  const asked: string[] = [];
  const near = engineFirst(rhea(asked), engine());
  const a = await near.lists.get();
  assert.equal(a.status, 200);
  assert.deepEqual(asked, [], "the engine answered: Rhea's lists are not read");
  const snap = JSON.parse(a.body) as { chain: string; lists: Record<string, Record<string, unknown>[]>; as_of_ms: number };
  assert.equal(snap.chain, "near");
  assert.equal(snap.as_of_ms, AT);
  for (const l of ["new", "trending", "trending_5m", "trending_1h", "graduating"]) assert.ok(snap.lists[l]!.length > 0, `${l} has rows`);
  // New: the engine's newest three, one of which has no price (xoe.token.primitives.near, mcapUsd null) and is not listed
  assert.deepEqual(
    snap.lists.new!.map((r) => r.token),
    ["whatsnow.v2-launchpad.justhoot.near"],
  );
  for (const rows of Object.values(snap.lists))
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), [...ROW_FIELDS, "buys_1h", "sells_1h"].filter((k, i, all) => all.indexOf(k) === i));
      for (const k of ["price_usd", "mc_usd", "liq_usd", "vol_24h_usd", "vol_1h_usd", "vol_5m_usd"]) assert.match(String(r[k]), /^\d+(\.\d+)?$/, `${r.token} ${k}`);
      for (const k of ["holders", "buys_5m", "sells_5m", "buys_1h", "sells_1h", "buys_24h", "sells_24h", "created_s"]) assert.ok(Number.isSafeInteger(r[k]), `${r.token} ${k} = ${r[k]}`);
      assert.equal(r.src, "unrealized");
    }
  const drg = snap.lists.graduating!.find((r) => r.token === T)!;
  assert.equal(drg.launchpad, "nearlytrade");
  assert.equal(drg.icon, true, "its logo is served by the helper at GET /v1/logo/near/{token}, never fetched by the page");
  assert.equal(drg.mc_usd, "18174.8315483");
  assert.equal(drg.holders, 86);
  assert.equal(drg.top10_bps, 5433);
  assert.equal(drg.dev_bps, 231);
  assert.equal(drg.snipers_bps, 0);
  assert.equal(drg.mint_auth, false, "no full-access key on the token's account");
  assert.equal(drg.curve_bps, 10_000, "listed");
  assert.equal(drg.created_s, Math.floor(1792755303968 / 1000));
});

test("lists: the engine down, or its answer past STALE_MS, serves Rhea's snapshot", async () => {
  const asked: string[] = [];
  assert.equal((await engineFirst(rhea(asked), engine({ down: true })).lists.get()).body, '{"rhea":true}');
  assert.deepEqual(asked, ["rhea lists"]);
  const clock = { t: AT };
  const asked2: string[] = [];
  const e = engine({ clock });
  const near = engineFirst(rhea(asked2), e);
  assert.notEqual((await near.lists.get()).body, '{"rhea":true}');
  // past STALE_MS with no newer read, the held lists are not served: Rhea's are
  clock.t += STALE_MS + 1;
  assert.equal(e.lists(), null);
  assert.ok(LISTS_MS < STALE_MS, "a running helper reads the lists several times inside STALE_MS");
});

test("token page: the risk grid's cells from the engine: top 10, dev, snipers, holders, insiders, bundlers, fresh, tax, both authorities, honeypot", async () => {
  const asked: string[] = [];
  const near = engineFirst(rhea(asked), engine());
  const a = await near.token.page(T);
  assert.equal(a.status, 200);
  assert.deepEqual(asked, []);
  const page = JSON.parse(a.body) as { row: Record<string, unknown>; decimals: number; risk: Record<string, { v: unknown; src: string }> };
  assert.deepEqual(Object.keys(page), [...PAGE_FIELDS]);
  assert.deepEqual(Object.keys(page.risk), [...RISK_FIELDS]);
  assert.equal(page.decimals, 18);
  const v = Object.fromEntries(Object.entries(page.risk).map(([k, f]) => [k, f.v]));
  assert.deepEqual(v, {
    mint_auth: false,
    freeze_auth: false,
    lp: null, // listed: off its curve (the grid draws only the curve class)
    top10_bps: 5433,
    dev_bps: 231,
    snipers_bps: 0,
    holders: 86,
    liq_usd: page.row.liq_usd,
    age_s: Math.floor(page.row.as_of_ms as number / 1000) - Math.floor(1792755303968 / 1000),
    tax: { buy_bps: 200, sell_bps: 200 },
    honeypot: false, // a 1 NEAR buy sells back for 94.13%
    insiders_bps: 4832,
    bundlers_bps: 0,
    fresh_bps: 4959,
  });
  for (const [k, f] of Object.entries(page.risk)) if (f.v !== null) assert.equal(f.src, "unrealized", k);
});

test("engineRisk and engineRow: a full-access key is a mint and freeze authority; a sell-back of nothing with no other seller is a honeypot; unknown stays null", () => {
  const raw = JSON.parse(fx("token")).token as Record<string, unknown>;
  const keyed = { ...raw, risk: { ...(raw.risk as object), fullAccessKeys: 2 } };
  const row = engineRow(keyed, AT)!;
  assert.equal(row.mint_auth, true);
  assert.equal(row.freeze_auth, true);
  const unknownKeys = engineRow({ ...raw, risk: { ...(raw.risk as object), fullAccessKeys: null } }, AT)!;
  assert.equal(unknownKeys.mint_auth, null);
  assert.equal(engineRisk({ ...raw, sellablePct: 0, nonDevSells30m: 0 }, row, AT).honeypot.v, true);
  assert.equal(engineRisk({ ...raw, sellablePct: 10, nonDevSells30m: 0 }, row, AT).honeypot.v, null);
  assert.equal(engineRisk({ ...raw, sellablePct: 10, nonDevSells30m: 3 }, row, AT).honeypot.v, false);
  assert.equal(engineRisk({ ...raw, stage: "heating", progressBps: 4200 }, row, AT).lp.v !== null, true);
  const untaxed = engineRisk({ ...raw, risk: { transferTaxBps: null } }, row, AT);
  assert.deepEqual([untaxed.tax.v, untaxed.tax.src], [null, "none"]);
  // hostile: a bad id, a symbol of control marks, an out-of-range share
  assert.equal(engineRow({ ...raw, id: "Bad..near" }, AT), null);
  assert.equal(engineRow({ ...raw, symbol: "\u0000‮" , name: null }, AT), null);
  assert.equal(engineRow({ ...raw, top10Pct: 140 }, AT)!.top10_bps, null);
});

test("holders, trades and candles from the engine: rows, whole-token amounts, USD bars", async () => {
  const asked: string[] = [];
  const near = engineFirst(rhea(asked), engine());
  const h = JSON.parse((await near.token.holders(T)).body) as { holders: { addr: string; amt: string; bps: number }[]; total: number; top_bps: number; src: string };
  assert.equal(h.src, "unrealized");
  assert.equal(h.total, 86);
  assert.equal(h.holders.length, 12);
  assert.deepEqual(h.holders[0], { addr: "treasury.sickyak1747.near", amt: h.holders[0]!.amt, bps: 4832 });
  assert.match(h.holders[0]!.amt, /^\d+$/, "raw units, as the other chains' holders");
  assert.ok(h.top_bps > 9_000 && h.top_bps <= 10_000);
  const t = JSON.parse((await near.trades.trades(T, 50)).body) as { trades: { t_ms: number; side: string; usd: string; amt: string; trader: string | null; tx: string }[]; src: string };
  assert.equal(t.src, "unrealized");
  assert.equal(t.trades.length, 6);
  assert.deepEqual(
    t.trades.slice(0, 2).map((r) => [r.side, r.usd, r.amt, r.t_ms]),
    [
      ["b", "68.6140862746", "3693489.228895965153951217", 1794613424254],
      ["s", "13.1342054571", "707757.564938508114305741", 1794560326937],
    ],
  );
  assert.ok(t.trades.every((r, i) => i === 0 || r.t_ms <= t.trades[i - 1]!.t_ms), "newest first");
  assert.equal((JSON.parse((await near.trades.trades(T, 2)).body) as { trades: unknown[] }).trades.length, 2);
  const c = JSON.parse((await near.trades.candles(T, "1m", null, 4)).body) as { tf: string; candles: [number, string, string, string, string, string][] };
  assert.equal(c.tf, "1m");
  assert.equal(c.candles.length, 4);
  const tok = JSON.parse(fx("token")).token as { priceUsd: number; priceNear: number };
  const first = JSON.parse(fx("candles")).candles[0] as { t: number; o: number; vNear: number };
  assert.equal(c.candles[0]![0], first.t / 1000);
  assert.ok(Math.abs(Number(c.candles[0]![1]) - first.o * (tok.priceUsd / tok.priceNear)) < 1e-15, "the bar's open in USD at the token's own NEAR price");
  assert.deepEqual(asked, []);
});

test("token reads the engine does not answer (a token it does not hold, or the engine down) are served by Rhea's", async () => {
  const asked: string[] = [];
  const near = engineFirst(rhea(asked), engine());
  assert.equal((await near.token.page("other.near")).body, '{"rhea":"page"}');
  const down = engineFirst(rhea(asked), engine({ down: true }));
  assert.equal((await down.token.holders(T)).body, '{"rhea":"holders"}');
  assert.equal((await down.trades.trades(T, 50)).body, '{"rhea":"trades"}');
  assert.equal((await down.trades.candles(T, "1m", null, 4)).body, '{"rhea":"candles"}');
  assert.deepEqual(asked, ["rhea page", "rhea holders", "rhea trades", "rhea candles"]);
});

test("a token's reads are held FRESH_MS: a second page open within it asks the engine nothing", async () => {
  const asked: string[] = [];
  const near = engineFirst(rhea([]), engine({ asked }));
  await near.token.page(T);
  await near.trades.trades(T, 50);
  await near.token.page(T);
  await near.trades.trades(T, 50);
  assert.deepEqual(asked, [`/token/${T}`, `/token/${T}/trades`]);
});
