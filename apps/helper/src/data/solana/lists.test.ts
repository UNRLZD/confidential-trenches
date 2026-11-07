// node --test apps/helper/src/data/solana/lists.test.ts: Discover's Solana lists on recorded vendor answers. Jupiter's
// recent and top-trending 5m and 1h lists as read on 2026-11-01 15:16Z (api.jup.ag, limit=100; 12 rows of each kept,
// picked to cover a row with no price, no 5m stats, a graduated and an on-curve pump.fun token, a token with no
// launchpad, another launchpad, and mint or freeze authority still set), and the pump.fun curve accounts of the
// on-curve rows as api.mainnet-beta.solana.com answered getMultipleAccounts at the same minute. The rows hold exactly
// the terminal's field list (apps/terminal/src/screens/discover/fields.ts, which holds buys_1h and sells_1h), in their wire
// forms, and pass the terminal's one curve rule (apps/terminal/src/screens/market/curve.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { enableTimers, resetTimers } from "../../../test/mock-timers.ts";
import { gunzipSync } from "node:zlib";
import { ROW_FIELDS as TERMINAL_FIELDS, ROW_REQUIRED } from "../../../../terminal/src/screens/discover/fields.ts";
import { onCurve } from "../../../../terminal/src/screens/market/curve.ts";
import {
  address, b58decode, b58encode, createSolanaLists, dec, FRESH_MS, LIST_MAX, LIST_STEP_MS, pumpCurveAddress, pumpCurveBps, PUMP_PROGRAM,
  READS, ROW_FIELDS, SERVED_MS, snapshot, STALE_MS, text, toRow, toRows, type Row,
} from "./lists.ts";
import { createOrigins, rpcAccounts } from "./origin.ts";
import { createProxy } from "../../proxy/proxy.ts";
import { createRpc } from "../../rpc/rpc.ts";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const RAW = { new: JSON.parse(fx("jupiter-recent.json")), trending_5m: JSON.parse(fx("jupiter-toptrending-5m.json")), trending_1h: JSON.parse(fx("jupiter-toptrending-1h.json")) };
const CURVES = JSON.parse(fx("solana-pump-curves.json")) as { request_mints: string[]; answer: { result: { value: unknown[] } } };
const AS_OF = Date.parse("2026-11-01T15:16:30Z");
const rowsOf = (k: keyof typeof RAW) => toRows(RAW[k], AS_OF)!;
const raw = (k: keyof typeof RAW, symbol: string) => (RAW[k] as Record<string, unknown>[]).find((r) => r.symbol === symbol)!;
const row = (k: keyof typeof RAW, symbol: string) => rowsOf(k).find((r) => r.symbol === symbol)!;
/** The RPC path answering each account from the recording: the recorded pump.fun curves by their address, every other
 *  account none (the Nov 1 recording read only the curves). */
const CURVE_BY_KEY = new Map(CURVES.request_mints.map((m, i) => [pumpCurveAddress(m), CURVES.answer.result.value[i]]));
const accountsRpc = (byKey: ReadonlyMap<string, unknown>, seen: string[][] = []) => ({
  handle: async (_chain: string, _type: string | undefined, body: string) => {
    const keys = JSON.parse(body).params[0] as string[];
    seen.push(keys);
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: keys.map((k) => byKey.get(k) ?? null) } }) };
  },
});
const recordedRpc = accountsRpc(CURVE_BY_KEY);
const PUMP_TAGGED = [...new Set([...RAW.new, ...RAW.trending_5m, ...RAW.trending_1h].filter((j: any) => j.launchpad === "pump.fun" && j.graduatedPool === undefined).map((j: any) => j.id as string))];

test("the field list is the terminal's ROW_FIELDS in its order, which ends with buys_1h and sells_1h (asked for the Trending column)", () => {
  assert.deepEqual(ROW_FIELDS, TERMINAL_FIELDS);
  assert.deepEqual(ROW_FIELDS.slice(-2), ["buys_1h", "sells_1h"]);
});

test("recorded Jupiter answers: every row holds exactly the field list, every required field, in its wire form", () => {
  for (const k of ["new", "trending_5m", "trending_1h"] as const) {
    const rows = rowsOf(k);
    assert.equal(rows.length, RAW[k].length, `${k}: no recorded row is dropped`);
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), [...ROW_FIELDS], `${r.symbol}: keys`);
      for (const f of ROW_REQUIRED) assert.notEqual(r[f], undefined, `${r.symbol}: ${f}`);
      assert.equal(r.chain, "solana");
      assert.equal(r.src, "jupiter");
      assert.equal(r.as_of_ms, AS_OF);
      assert.equal(typeof r.symbol, "string");
      assert.equal(typeof r.name, "string");
      assert.equal(typeof r.icon, "boolean");
      for (const f of ROW_FIELDS.filter((x) => x.endsWith("_usd"))) {
        const v = r[f];
        assert.ok(v === null || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)), `${r.symbol}: ${f}=${String(v)}`);
      }
      for (const f of ROW_FIELDS.filter((x) => x.endsWith("_bps") || x === "holders" || x === "created_s" || x.startsWith("buys_") || x.startsWith("sells_"))) {
        const v = r[f];
        assert.ok(v === null || Number.isSafeInteger(v), `${r.symbol}: ${f}=${String(v)}`);
      }
      for (const f of ["mint_auth", "freeze_auth"] as const) assert.ok(r[f] === null || typeof r[f] === "boolean");
    }
  }
});

test("one row field by field against its recorded Jupiter row (TRUMP, top trending 5m)", () => {
  const j = raw("trending_5m", "TRUMP") as any;
  const r = row("trending_5m", "TRUMP");
  assert.equal(r.token, j.id);
  assert.equal(r.price_usd, "1.74634421892");
  assert.equal(r.mc_usd, "492238441.033");
  assert.equal(r.liq_usd, dec(j.liquidity));
  assert.equal(r.holders, j.holderCount);
  assert.equal(r.chg_5m_bps, Math.round(j.stats5m.priceChange * 100));
  assert.equal(r.chg_1h_bps, Math.round(j.stats1h.priceChange * 100));
  assert.equal(r.chg_24h_bps, Math.round(j.stats24h.priceChange * 100));
  assert.equal(r.top10_bps, 8070);
  assert.equal(r.vol_5m_usd, dec(j.stats5m.buyVolume + j.stats5m.sellVolume));
  assert.equal(r.net_5m_usd, dec(j.stats5m.buyVolume - j.stats5m.sellVolume, true));
  assert.equal(r.vol_1h_usd, dec(j.stats1h.buyVolume + j.stats1h.sellVolume));
  assert.equal(r.vol_24h_usd, dec(j.stats24h.buyVolume + j.stats24h.sellVolume));
  assert.deepEqual([r.buys_5m, r.sells_5m, r.buys_1h, r.sells_1h, r.buys_24h, r.sells_24h], [1428, 1344, 11403, 11015, 31123, 30485]);
  assert.equal(r.created_s, Date.parse(j.firstPool.createdAt) / 1000);
  assert.equal(r.creator, j.dev);
  assert.deepEqual([r.mint_auth, r.freeze_auth], [false, false]);
  assert.equal(r.launchpad, null, "a token with no launchpad is listed, tagged null (D-S4)");
  assert.equal(r.curve_bps, null, "no launchpad and no graduated pool: unknown");
  assert.deepEqual([r.icon, r.venue, r.label, r.dev_bps, r.snipers_bps, r.creator_sold_bps, r.chg_4h_bps], [false, null, null, null, null, null, null]);
});

test("app-discover-solana's asks: price null with no usdPrice, launchpad null with none, curve 10,000 once graduated, buys and sells for 1h", () => {
  const noPrice = rowsOf("new").filter((r) => r.price_usd === null);
  assert.ok(noPrice.length >= 1);
  for (const r of noPrice) assert.equal((RAW.new as any[]).find((j) => j.id === r.token).usdPrice, undefined);
  const all = [...rowsOf("new"), ...rowsOf("trending_5m"), ...rowsOf("trending_1h")];
  const graduated = all.filter((r) => typeof (RAW.new.concat(RAW.trending_5m, RAW.trending_1h) as any[]).find((j) => j.id === r.token).graduatedPool === "string");
  assert.ok(graduated.length >= 3);
  for (const r of graduated) {
    assert.equal(r.curve_bps, 10_000, `${r.symbol}`);
    assert.equal(onCurve(r as any), false, `${r.symbol}: listed, off the curve`);
  }
  assert.ok(graduated.some((r) => r.launchpad === "pump.fun"), "a graduated launchpad token keeps its launchpad");
  assert.ok(all.some((r) => r.launchpad === null) && all.some((r) => r.launchpad === "pump.fun") && all.some((r) => r.launchpad === "stonkfun"));
  // an authority still set: Jupiter drops the Disabled flag and names the authority
  const rawAll = RAW.new.concat(RAW.trending_5m, RAW.trending_1h) as any[];
  for (const r of all) {
    const j = rawAll.find((x) => x.id === r.token);
    assert.equal(r.mint_auth, j.audit.mintAuthorityDisabled === true ? false : typeof j.mintAuthority === "string" ? true : null, `${r.symbol} mint`);
    assert.equal(r.freeze_auth, j.audit.freezeAuthorityDisabled === true ? false : typeof j.freezeAuthority === "string" ? true : null, `${r.symbol} freeze`);
    assert.equal(r.dev_bps, typeof j.audit.devBalancePercentage === "number" ? Math.round(j.audit.devBalancePercentage * 100) : null, `${r.symbol} dev`);
  }
  assert.ok(all.some((r) => r.mint_auth === true) && all.some((r) => r.freeze_auth === true) && all.some((r) => typeof r.dev_bps === "number"));
  for (const r of rowsOf("trending_1h")) assert.ok(Number.isSafeInteger(r.buys_1h) && Number.isSafeInteger(r.sells_1h), `${r.symbol}`);
});

test("a window with one side only: Jupiter drops a zero side, so it reads 0; a window with neither side reads null", () => {
  const good = raw("trending_5m", "TRUMP") as any;
  const r = toRow({ ...good, stats5m: { buyVolume: 220.27984179577888, numBuys: 2, numTraders: 2 }, stats1h: { sellVolume: 10, numSells: 1 }, stats24h: { priceChange: 1 } }, AS_OF)!;
  assert.deepEqual([r.vol_5m_usd, r.net_5m_usd, r.buys_5m, r.sells_5m], ["220.279841796", "220.279841796", 2, 0]);
  assert.deepEqual([r.vol_1h_usd, r.buys_1h, r.sells_1h], ["10", 0, 1]);
  assert.deepEqual([r.vol_24h_usd, r.buys_24h, r.sells_24h, r.chg_24h_bps], [null, null, null, 100]);
  const none = toRow({ ...good, stats5m: undefined }, AS_OF)!;
  assert.deepEqual([none.vol_5m_usd, none.net_5m_usd, none.buys_5m, none.sells_5m, none.chg_5m_bps], [null, null, null, null, null]);
});

test("pump.fun curves: each mint's curve account is read at its program address, and the recorded accounts read 0-9,999 with the chain's tag", async () => {
  // a known address: a curve account the recorded answer shows owned by the pump.fun program
  assert.equal(pumpCurveAddress("ETHgDzFEG9gqBrjpPyiLvi12LSN9m7aPSdvWWjyZpump"), "oPYZyVGxKR6QqWpkaBRGxRn8PdfoRCgMWCJJCgpQmxC");
  const seen: string[][] = [];
  const o = createOrigins(rpcAccounts(accountsRpc(CURVE_BY_KEY, seen), true));
  const rows = [...rowsOf("new"), ...rowsOf("trending_5m"), ...rowsOf("trending_1h")];
  await o.refresh(rows.map((r) => ({ mint: r.token as string, hint: undefined, createdS: 0 })), AS_OF);
  for (const m of PUMP_TAGGED) assert.ok(seen.flat().includes(pumpCurveAddress(m)), `${m}: its curve asked`);
  assert.deepEqual(CURVES.request_mints, PUMP_TAGGED, "the recorded curves are those of the on-curve rows Jupiter tags pump.fun");
  assert.equal(o.get("ETHgDzFEG9gqBrjpPyiLvi12LSN9m7aPSdvWWjyZpump")?.curveBps, 9089);
  assert.equal(o.get("ETHgDzFEG9gqBrjpPyiLvi12LSN9m7aPSdvWWjyZpump")?.pad, "pump.fun");
  assert.equal(o.get("7UF3egEva3jHDZqfM6eCzEq5n5kdZ3Jxk18A5D3ypump")?.curveBps, 0, "untouched curve: 793.1 M left");
  // a curve whose reserves exceed the standard 793.1 M is another configuration: made by pump.fun, progress unknown
  assert.deepEqual(o.get("6xASXp7JqKnzWTsC8kXcDjSkAVyv2qQRiE2Lgnv9pump"), { pad: "pump.fun", family: "pump", pool: pumpCurveAddress("6xASXp7JqKnzWTsC8kXcDjSkAVyv2qQRiE2Lgnv9pump"), config: null, curveBps: null });
});

test("pump.fun curve account checks: complete reads 10,000; wrong owner, discriminator, size or flag reads null", () => {
  const acct = CURVES.answer.result.value[CURVES.request_mints.indexOf("ETHgDzFEG9gqBrjpPyiLvi12LSN9m7aPSdvWWjyZpump")] as any;
  const data = Buffer.from(acct.data[0], "base64");
  const with_ = (d: Buffer, owner = PUMP_PROGRAM) => ({ ...acct, owner, data: [d.toString("base64"), "base64"] });
  assert.equal(pumpCurveBps(acct), 9089);
  const done = Buffer.from(data);
  done[48] = 1;
  assert.equal(pumpCurveBps(with_(done)), 10_000);
  const flag = Buffer.from(data);
  flag[48] = 2;
  assert.equal(pumpCurveBps(with_(flag)), null);
  assert.equal(pumpCurveBps(with_(data, "11111111111111111111111111111111")), null);
  const disc = Buffer.from(data);
  disc[0] = disc[0]! ^ 1;
  assert.equal(pumpCurveBps(with_(disc)), null);
  assert.equal(pumpCurveBps(with_(data.subarray(0, 48))), null);
  assert.equal(pumpCurveBps({ ...acct, data: [acct.data[0], "base58"] }), null);
  for (const bad of [null, undefined, 7, "x", [], { owner: PUMP_PROGRAM }]) assert.equal(pumpCurveBps(bad), null);
});

test("a failed or malformed RPC answer leaves every launch unread: the rows untagged and named unsettled", async () => {
  const rows = [...rowsOf("new"), ...rowsOf("trending_5m"), ...rowsOf("trending_1h")];
  for (const answer of [{ status: 503, body: "{}" }, { status: 200, body: "not json" }, { status: 200, body: JSON.stringify({ result: { value: [] } }) }, { status: 200, body: JSON.stringify({ error: { code: -32005 } }) }]) {
    const o = createOrigins(rpcAccounts({ handle: async () => answer }, true));
    await o.refresh(rows.map((r) => ({ mint: r.token as string, hint: undefined, createdS: 0 })), AS_OF);
    const s = snapshot({ new: rowsOf("new"), trending_5m: rowsOf("trending_5m"), trending_1h: rowsOf("trending_1h") }, o.get, AS_OF);
    assert.ok(Object.values(s.lists).flat().every((r) => r.launchpad === null));
    assert.equal(s.unsettled.length, new Set(rows.map((r) => r.token)).size);
  }
  const down = createOrigins(rpcAccounts({ handle: async () => { throw new Error("down"); } }, true));
  await down.refresh([{ mint: CURVES.request_mints[0]!, hint: undefined, createdS: 0 }], AS_OF);
  assert.equal(down.get(CURVES.request_mints[0]!), undefined);
});

test("the snapshot: trending is trending_1h; graduating holds each on-curve token once, highest first, every one on the terminal's curve", async () => {
  const read = { new: rowsOf("new"), trending_5m: rowsOf("trending_5m"), trending_1h: rowsOf("trending_1h") };
  const o = createOrigins(rpcAccounts(recordedRpc, true));
  await o.refresh([...read.new, ...read.trending_5m, ...read.trending_1h].map((r) => ({ mint: r.token as string, hint: undefined, createdS: 0 })), AS_OF);
  const curves = new Map(PUMP_TAGGED.filter((m) => typeof o.get(m)?.curveBps === "number").map((m) => [m, o.get(m)!.curveBps!]));
  const s = snapshot(read, o.get, AS_OF);
  assert.deepEqual(Object.keys(s), ["chain", "lists", "as_of_ms", "unsettled"]);
  assert.deepEqual(s.unsettled, []);
  assert.deepEqual(Object.keys(s.lists), ["new", "trending", "trending_5m", "trending_1h", "graduating"]);
  assert.equal(s.chain, "solana");
  assert.deepEqual(s.lists.trending, s.lists.trending_1h);
  const g = s.lists.graduating;
  assert.equal(g.length, curves.size);
  assert.equal(new Set(g.map((r) => r.token)).size, g.length);
  for (const r of g) assert.ok(onCurve(r as any) && r.launchpad === "pump.fun", `${r.symbol}`);
  for (let i = 1; i < g.length; i++) assert.ok((g[i - 1]!.curve_bps as number) >= (g[i]!.curve_bps as number));
  assert.equal(g[0]!.curve_bps, 9089);
  // the curve fills the row in every list it appears in
  const filled = s.lists.new.filter((r) => curves.has(r.token as string));
  for (const r of filled) assert.equal(r.curve_bps, curves.get(r.token as string));
});

test("hostile rows: no valid mint, symbol or name drops the row; numbers out of range, bad text, tags and times read null or are cut", () => {
  const good = raw("trending_5m", "TRUMP") as any;
  assert.equal(toRow({ ...good, id: "0OIl" + good.id.slice(4) }, AS_OF), null);
  assert.equal(toRow({ ...good, id: good.id + "1" }, AS_OF), null);
  assert.equal(toRow({ ...good, id: 7 }, AS_OF), null);
  assert.equal(toRow({ ...good, symbol: undefined }, AS_OF), null);
  assert.equal(toRow({ ...good, symbol: "‮\u0000  " }, AS_OF), null);
  assert.equal(toRow({ ...good, name: undefined }, AS_OF)!.name, "TRUMP", "no name: the symbol");
  for (const bad of [null, 7, "x", [], { id: good.id }]) assert.equal(toRow(bad, AS_OF), null);
  const r = toRow({
    ...good,
    symbol: "‮SOL\u0007" + "X".repeat(100),
    name: "<img src=x onerror=alert(1)>\n",
    usdPrice: -1, mcap: Infinity, liquidity: 1e300, holderCount: 1.5,
    stats5m: { ...good.stats5m, priceChange: NaN, buyVolume: -5, numBuys: -1, numSells: "7" },
    stats1h: { ...good.stats1h, priceChange: -150, numBuys: 2 ** 60 },
    stats24h: "x",
    audit: { topHoldersPercentage: 120, mintAuthorityDisabled: "true", freezeAuthorityDisabled: false },
    launchpad: "<script>", dev: "not-an-address", graduatedPool: "nope",
    firstPool: { createdAt: "yesterday" }, createdAt: "2999-01-01T00:00:00Z",
  }, AS_OF)!;
  assert.equal(r.symbol, "SOL" + "X".repeat(29), "controls and direction marks stripped, 32 code points");
  assert.equal(r.name, "<img src=x onerror=alert(1)>", "text is data: kept as text, the app escapes it");
  assert.deepEqual(
    [r.price_usd, r.mc_usd, r.liq_usd, r.holders, r.chg_5m_bps, r.vol_5m_usd, r.net_5m_usd, r.buys_5m, r.sells_5m, r.chg_1h_bps, r.buys_1h, r.vol_24h_usd, r.buys_24h, r.top10_bps, r.mint_auth, r.freeze_auth, r.launchpad, r.creator, r.curve_bps, r.created_s],
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  );
  assert.deepEqual(Object.keys(r), [...ROW_FIELDS]);
});

test("a list answer: not a list is null; at most 100 rows; a mint listed twice is kept once", () => {
  for (const bad of [null, {}, "[]", { data: [] }]) assert.equal(toRows(bad, AS_OF), null);
  const one = RAW.trending_5m[0];
  const many = Array.from({ length: 150 }, (_, i) => ({ ...one, id: b58encode(Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? 1 + (i % 200) : k === 1 ? i : 7))) }));
  assert.equal(toRows(many, AS_OF)!.length, LIST_MAX);
  assert.equal(toRows([one, one, { ...one }], AS_OF)!.length, 1);
});

test("decimal strings: 12 significant digits, never an exponent; signed only where asked", () => {
  assert.equal(dec(1.234e-11), "0.00000000001234");
  assert.equal(dec(2212999703.19402), "2212999703.19");
  assert.equal(dec(0.004791481863661449), "0.00479148186366");
  assert.equal(dec(1e17), "100000000000000000");
  assert.equal(dec(0.1 + 0.2), "0.3");
  assert.equal(dec(5), "5");
  assert.equal(dec(0), "0");
  assert.equal(dec(-78746.0687921, true), "-78746.0687921");
  assert.equal(dec(-1), null);
  assert.equal(dec(1e19), null);
  assert.equal(dec("5"), null);
  assert.equal(text("a⁦b⁩c", 32), "abc");
  assert.equal(address("So11111111111111111111111111111111111111112"), "So11111111111111111111111111111111111111112");
  assert.equal(address("11111111111111111111111111111111"), "11111111111111111111111111111111");
  assert.equal(b58decode("0"), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The served answer
// ---------------------------------------------------------------------------------------------------------------

function fakes(opts: { fail?: () => boolean } = {}) {
  let t = AS_OF;
  const calls: string[] = [];
  const proxy = {
    handle: async (vendor: string, path: string, query: string): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      calls.push(`${vendor} ${path}?${query}`);
      if (opts.fail?.()) return { status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' };
      const k = path === READS.new ? "new" : path === READS.trending_5m ? "trending_5m" : "trending_1h";
      return { status: 200, headers: { "X-Fetched-At": new Date(t).toISOString() }, body: JSON.stringify(RAW[k]) };
    },
  };
  return { proxy, calls, now: () => t, step: (ms: number) => (t += ms) };
}

test("fold 6 (R5b, R5d): Discover's Jupiter lists and curve reads draw on the helper's own reserve: with every caller's part of Jupiter and of getMultipleAccounts spent, the lists are served whole", async () => {
  const t = AS_OF;
  const jup: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  // the clock stands at AS_OF, so a wait the proxy takes (a caller's turn, a poll for room) reads the same now() after
  // it: the wait is a turn of the event loop, never real seconds (162 s of real sleep in a fresh run, card
  // fresh-run-margin), as crowd.test.ts's still clock does
  // the minute's reserve alone (burstMs 0): the callers' part is spent at one instant, which Jupiter's 10 s window
  // (proxy.ts PACED, card helper-page-jup-429) would spread
  const proxy = createProxy({}, {
    burstMs: 0,
    now: () => t,
    sleep: async () => {},
    fetch: (async (url: string) => {
      const path = new URL(url).pathname;
      jup.push(path);
      const k = path === READS.new ? "new" : path === READS.trending_5m ? "trending_5m" : path === READS.trending_1h ? "trending_1h" : null;
      return json(k === null ? { ok: 1 } : RAW[k]);
    }) as never,
  });
  const curves: number[] = [];
  const rpc = createRpc({}, { now: () => t, fetch: (async (_u: string, i: RequestInit) => (JSON.parse(String(i.body)).id === 1 && curves.push(1), json(CURVES.answer))) as never });
  let callers = 0;
  for (let a = 0; a < 20; a++) for (let i = 0; i < 4; i++) if ((await proxy.handle("jupiter", "/swap/v2/build", `q=${a}-${i}`, "", `198.51.100.${a}`)).status === 200) callers++;
  assert.equal(callers, 60 - 34, "callers' part of Jupiter Free is spent");
  const gma = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getMultipleAccounts", params: [[]] });
  let reads = 0;
  for (let a = 0; a < 4; a++) for (let i = 0; i < 16; i++) if ((await rpc.handle("solana", "application/json", gma, `198.51.100.${a}`)).status === 200) reads++;
  assert.equal(reads, 40 - 3, "callers' part of getMultipleAccounts is spent");
  jup.length = 0;
  const a = await createSolanaLists(proxy, rpc, { now: () => t }).get();
  assert.equal(a.status, 200);
  assert.deepEqual(jup.sort(), [READS.new, READS.trending_1h, READS.trending_5m].sort(), "the three lists reached Jupiter");
  assert.ok(curves.length >= 1, "the curve reads reached the provider");
  const s = JSON.parse(a.body);
  assert.ok(s.lists.new.length > 0 && s.lists.trending_5m.length > 0);
  assert.ok((s.lists.new as Row[]).concat(s.lists.trending_5m, s.lists.trending_1h).some((r: Row) => r.curve_bps !== null && r.curve_bps !== undefined), "a curve read's answer is on the rows");
});

test("the lists: one read of the three Jupiter lists through the proxy, shared until FRESH_MS; gzip of the same body", async () => {
  const f = fakes();
  const lists = createSolanaLists(f.proxy, recordedRpc, { now: f.now });
  const [a, b] = await Promise.all([lists.get(), lists.get()]);
  assert.equal(a.status, 200);
  assert.equal(a, b);
  assert.deepEqual(f.calls.sort(), ["jupiter /tokens/v2/recent?limit=100", "jupiter /tokens/v2/toptrending/1h?limit=100", "jupiter /tokens/v2/toptrending/5m?limit=100"]);
  assert.equal(gunzipSync(a.gzip!).toString("utf8"), a.body);
  const s = JSON.parse(a.body);
  assert.equal(s.as_of_ms, AS_OF);
  for (const k of ["new", "trending", "trending_5m", "trending_1h", "graduating"]) for (const r of s.lists[k] as Row[]) assert.deepEqual(Object.keys(r), [...ROW_FIELDS]);
  f.step(LIST_STEP_MS - 1);
  await lists.get();
  assert.equal(f.calls.length, 3);
  // card helper-page-jup-429: past LIST_STEP_MS one list is read again, the one read longest ago, never the three at once
  f.step(1);
  await lists.get();
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(f.calls.slice(3), ["jupiter /tokens/v2/recent?limit=100"]);
});

test("card helper-page-jup-429: the three lists are read one a LIST_STEP_MS, each once a FRESH_MS, the one read longest ago first", async () => {
  const f = fakes();
  const lists = createSolanaLists(f.proxy, recordedRpc, { now: f.now });
  await lists.get();
  for (let i = 0; i < 6; i++) {
    f.step(LIST_STEP_MS);
    await lists.get();
    await new Promise((ok) => setImmediate(ok));
  }
  assert.deepEqual(f.calls.slice(3).map((c) => c.split(" ")[1]!.split("?")[0]), ["/tokens/v2/recent", "/tokens/v2/toptrending/5m", "/tokens/v2/toptrending/1h", "/tokens/v2/recent", "/tokens/v2/toptrending/5m", "/tokens/v2/toptrending/1h"]);
  assert.equal(LIST_STEP_MS * 3, FRESH_MS);
});

test("the lists: past FRESH_MS the last answer serves while one refresh runs; with the vendor down it still serves past STALE_MS, dated by its own read, never 503 once read", async () => {
  let down = false;
  const f = fakes({ fail: () => down });
  const lists = createSolanaLists(f.proxy, recordedRpc, { now: f.now });
  const first = await lists.get();
  f.step(FRESH_MS);
  assert.equal(await lists.get(), first, "the last answer, at once");
  await new Promise((ok) => setImmediate(ok));
  assert.equal(f.calls.length, 4, "one refresh behind it, of one list (card helper-page-jup-429)");
  down = true;
  // the refresh read at AS_OF + FRESH_MS: its data is STALE_MS old here
  f.step(STALE_MS);
  const held = await lists.get();
  assert.equal(held.status, 200);
  f.step(1);
  const behind = await lists.get();
  assert.deepEqual([behind.status, behind.body, behind.asOfMs], [200, held.body, held.asOfMs], "behind STALE_MS: the last answer, dated at its read");
  await new Promise((ok) => setImmediate(ok));
  f.step(3_600_000);
  const hour = await lists.get();
  assert.deepEqual([hour.status, hour.asOfMs], [200, held.asOfMs], "an hour behind: still served, still dated");
});

test("the lists: one list down or not a list answers 503 when there is no last answer", async () => {
  const lists = createSolanaLists({ handle: async (_v: string, p: string) => ({ status: 200, headers: {}, body: p === READS.new ? '{"oops":1}' : JSON.stringify(RAW.trending_5m) }) }, recordedRpc);
  assert.equal((await lists.get()).status, 503);
});

test("the lists: a throttled list read (the proxy's 429) with no last answer answers not ready (503 upstream), never our 429 (card helper-crowd-429 fold 6: Jupiter's limit is not the caller's)", async () => {
  const lists = createSolanaLists({ handle: async (_v: string, p: string): Promise<{ status: number; headers: Record<string, string>; body: string }> => (p === READS.new ? { status: 429, headers: { "Retry-After": "8" }, body: '{"error":{"code":"rate_limited"}}' } : { status: 200, headers: {}, body: JSON.stringify(RAW.trending_5m) }) }, recordedRpc);
  const a = await lists.get();
  assert.deepEqual([a.status, JSON.parse(a.body), a.retryAfterS], [503, { error: { code: "upstream" } }, undefined]);
});

test("warm(): one refresh at once and one every LIST_STEP_MS (one list each), so a caller never waits on a vendor; the stop ends it", async (t) => {
  enableTimers(mock.timers, { apis: ["setInterval"] });
  t.after(() => resetTimers(mock.timers));
  const f = fakes();
  const lists = createSolanaLists(f.proxy, recordedRpc, { now: f.now });
  const stop = lists.warm();
  await new Promise((ok) => setImmediate(ok));
  assert.equal(f.calls.length, 3);
  for (let i = 1; i <= 3; i++) {
    f.step(LIST_STEP_MS);
    mock.timers.tick(LIST_STEP_MS);
    await new Promise((ok) => setImmediate(ok));
    assert.equal(f.calls.length, 3 + i);
    const a = await lists.get();
    assert.equal(a.status, 200);
    assert.equal(f.calls.length, 3 + i, "served from the warm snapshot, no read of its own");
  }
  stop();
  f.step(LIST_STEP_MS);
  mock.timers.tick(LIST_STEP_MS);
  await new Promise((ok) => setImmediate(ok));
  assert.equal(f.calls.length, 6);
});

// card helper-launchpad-origin: every row's launchpad is what the chain says made the token, on accounts and Jupiter rows
// recorded 2026-11-03 16:49Z (fixtures/solana-origins.json, origin.test.ts): Jupiter's tag is kept only when a read agrees
test("the lists' launchpad tags are the chain's: Jupiter's untagged pump.fun tokens tagged, a tag no launch backs dropped, a LaunchLab or DBC token's pool read", async () => {
  const OX = JSON.parse(fx("solana-origins.json")) as { read_at: string; tokens: { case: string; mint: string; origin: { pad: string; curveBps: number | null } | null; jupiter: Record<string, unknown> }[]; accounts: Record<string, unknown> };
  const at = Date.parse(OX.read_at);
  const jup = OX.tokens.map((t) => t.jupiter);
  const proxy = { handle: async () => ({ status: 200, headers: { "X-Fetched-At": OX.read_at }, body: JSON.stringify(jup) }) };
  const lists = createSolanaLists(proxy, accountsRpc(new Map(Object.entries(OX.accounts))), { now: () => at });
  const a = await lists.get();
  assert.equal(a.status, 200);
  const s = JSON.parse(a.body);
  const rows = new Map((s.lists.new as Row[]).map((r) => [r.token, r]));
  for (const t of OX.tokens) {
    const r = rows.get(t.mint)!;
    assert.equal(r.launchpad, t.origin?.pad ?? null, `${t.case}: ${t.mint} (Jupiter: ${String(t.jupiter.launchpad ?? null)})`);
    if (t.origin?.curveBps != null) assert.equal(r.curve_bps, t.origin.curveBps, `${t.case}: curve`);
  }
  assert.ok(OX.tokens.some((t) => t.jupiter.launchpad === undefined && t.origin !== null), "a token Jupiter leaves untagged is tagged");
  assert.ok(OX.tokens.some((t) => t.jupiter.launchpad === "metadao" && t.origin === null), "a tag no launch backs is dropped");
  assert.ok((s.lists.graduating as Row[]).some((r) => r.launchpad === "raydium-launchlab"), "a LaunchLab token on its curve is graduating");
});

test("card robinhood-listed-tape-opens: a mint the last answer held and the next one dropped stays listed (its trades open) for SERVED_MS after the last answer that held it; one no answer held is not; unknown while no answer was built", async () => {
  let t = AS_OF;
  const trending = new Set([...RAW.trending_5m, ...RAW.trending_1h].map((x: { id: string }) => x.id));
  const mint = (RAW.new as { id: string }[]).map((x) => x.id).find((m) => !trending.has(m))!;
  assert.ok(mint, "the recorded New list holds a mint the trending lists do not");
  let drop = false;
  let down = true;
  const proxy = {
    handle: async (_v: string, path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      if (down) return { status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' };
      const k = path === READS.new ? "new" : path === READS.trending_5m ? "trending_5m" : "trending_1h";
      const rows = k === "new" && drop ? (RAW.new as { id: string }[]).filter((x) => x.id !== mint) : RAW[k];
      return { status: 200, headers: { "X-Fetched-At": new Date(t).toISOString() }, body: JSON.stringify(rows) };
    },
  };
  const lists = createSolanaLists(proxy, recordedRpc, { now: () => t });
  assert.equal(await lists.listed(mint), null, "no answer yet: unknown, never not listed");
  down = false;
  assert.equal(await lists.listed(mint), true);
  drop = true;
  t += LIST_STEP_MS; // New, read longest ago with the others, is read again
  await lists.get();
  for (let i = 0; i < 100 && JSON.parse((await lists.get()).body).as_of_ms === AS_OF; i++) await new Promise((ok) => setImmediate(ok));
  const s = JSON.parse((await lists.get()).body) as { lists: Record<string, { token: string }[]> };
  assert.ok(!Object.values(s.lists).some((rows) => rows.some((r) => r.token === mint)), "the next answer leaves the mint out");
  assert.equal(await lists.listed(mint), true, "dropped from the newest answer, still listed");
  assert.equal(await lists.listed("So11111111111111111111111111111111111111112"), false, "a mint no answer held");
  const heldAt = AS_OF;
  t = heldAt + SERVED_MS;
  assert.equal(await lists.listed(mint), true, "at SERVED_MS after the last answer that held it");
  t = heldAt + SERVED_MS + 1;
  assert.equal(await lists.listed(mint), false, "past it: off the lists");
});
