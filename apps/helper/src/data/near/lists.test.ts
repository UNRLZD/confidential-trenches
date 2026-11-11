// NEAR's lists and token page from Rhea classic's views (card helper-near-lists-and-token), replayed from one real read
// (fixtures/rhea-reads-2026-11-11.json: FastNEAR's and dRPC's answers, two get_pools pages kept, the rest answered []).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROW_FIELDS } from "../../../../terminal/src/screens/discover/fields.ts";
import { PAGE_FIELDS, RISK_FIELDS } from "../solana/token.ts";
import { chgBps, createNearLists, liqOf, mainsOf, parsePools, priceOf, priceText, toMeta, usdText, wnearFlow } from "./lists.ts";
import { createNearToken } from "./token.ts";
import { HOST_GAP_MS, nearAccount, NEAR_RPCS, PAST_RPCS, pacedFetch, WAIT_MAX_MS } from "./views.ts";
import { fixtureFetch } from "./fixtures/replay.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/rhea-reads-2026-11-11.json", import.meta.url), "utf8")) as { rpc: { body: { params: Record<string, unknown> }; view?: unknown; answer?: { result: unknown } }[] };

test("parsePools: SIMPLE_POOLs of two valid NEAR accounts with digit amounts, numbered from the page's start; others dropped", () => {
  const page = [
    { pool_kind: "SIMPLE_POOL", token_account_ids: ["token.rhealab.near", "wrap.near"], amounts: ["10", "20"] },
    { pool_kind: "STABLE_SWAP", token_account_ids: ["a.near", "b.near"], amounts: ["1", "1"] },
    { pool_kind: "SIMPLE_POOL", token_account_ids: ["Bad.near", "wrap.near"], amounts: ["1", "1"] },
    { pool_kind: "SIMPLE_POOL", token_account_ids: ["x.near", "wrap.near"], amounts: ["1e3", "1"] },
    { pool_kind: "SIMPLE_POOL", token_account_ids: ["wrap.near", "wrap.near"], amounts: ["1", "1"] },
    { pool_kind: "SIMPLE_POOL", token_account_ids: ["a.near", "b.near", "c.near"], amounts: ["1", "1", "1"] },
  ];
  assert.deepEqual(parsePools(page, 6000), [{ id: 6000, tokens: ["token.rhealab.near", "wrap.near"], amounts: [10n, 20n] }]);
  assert.equal(parsePools({ not: "a list" }, 0), null);
  assert.equal(parsePools(Array(501).fill({}), 0), null);
});

test("wnearFlow: Rhea counts a swap under its input token, so wNEAR's flow is volumes[w].input + volumes[other].output", () => {
  // pool 6458 (RHEA, wNEAR) on 2026-11-11: the same token's two counts agree in size (1.118e27 in, 1.111e27 out)
  const v = [{ input: "1118286153472098101208976272", output: "13843720693540510348301046408228" }, { input: "13825878412171454143679973423720", output: "1111068086398209521728355949" }];
  assert.equal(wnearFlow(v, 0), 1118286153472098101208976272n + 1111068086398209521728355949n);
  assert.equal(wnearFlow(v, 1), 13843720693540510348301046408228n + 13825878412171454143679973423720n);
  assert.equal(wnearFlow([{ input: "1", output: "x" }, { input: "1", output: "1" }], 1), null);
  assert.equal(wnearFlow(v, 2), null);
  assert.equal(wnearFlow({}, 0), null);
});

test("mainsOf and the price: the token's deepest wNEAR pool, NEAR's price from the deepest wNEAR-stablecoin pool, liquidity twice the wNEAR side", () => {
  const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const pools = [
    { id: 1, tokens: [USDC, "wrap.near"] as [string, string], amounts: [3_000_000_000n, 1000n * 10n ** 24n] as [bigint, bigint] }, // $3 a NEAR
    { id: 2, tokens: ["wrap.near", USDC] as [string, string], amounts: [10n * 10n ** 24n, 1_000_000n] as [bigint, bigint] }, // shallower, $0.10
    { id: 3, tokens: ["t.near", "wrap.near"] as [string, string], amounts: [500n * 10n ** 18n, 100n * 10n ** 24n] as [bigint, bigint] },
    { id: 4, tokens: ["wrap.near", "t.near"] as [string, string], amounts: [1n * 10n ** 24n, 1n * 10n ** 18n] as [bigint, bigint] },
  ];
  const { mains, nearUsd } = mainsOf(pools);
  assert.equal(nearUsd, 3n * 10n ** 18n);
  const m = mains.get("t.near")!;
  assert.deepEqual(m, { pool: 3, amt: 500n * 10n ** 18n, wnear: 100n * 10n ** 24n, w: 1 });
  // 100 NEAR for 500 tokens: 0.2 NEAR, $0.60 a token
  assert.equal(priceText(priceOf(m, 18, nearUsd!)!), "0.6");
  assert.equal(usdText(liqOf(m, nearUsd!)), "600");
  assert.equal(chgBps(110n, 100n), 1000);
  assert.equal(chgBps(110n, null), null);
  assert.equal(mainsOf([pools[2]!]).nearUsd, null);
});

test("toMeta: hostile metadata bounded or refused", () => {
  assert.deepEqual(toMeta({ symbol: "RHEA", name: "Rhea", decimals: 18 }), { symbol: "RHEA", name: "Rhea", decimals: 18 });
  assert.deepEqual(toMeta({ symbol: "X\u0000Y", decimals: 0 }), { symbol: "XY", name: "XY", decimals: 0 });
  assert.equal(toMeta({ symbol: "A", name: "n", decimals: 31 }), null);
  assert.equal(toMeta({ symbol: "", name: "n", decimals: 6 }), null);
  assert.equal(toMeta({ symbol: "S".repeat(33), decimals: 6 }), null);
  assert.equal(toMeta(null), null);
});

test("nearAccount: NEAR's account id rules", () => {
  for (const ok of ["token.rhealab.near", "wrap.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nene-2250.meme-cooking.near", "a_b.near"]) assert.equal(nearAccount(ok), ok);
  for (const bad of ["Wrap.near", "a", "a..near", ".near", "near.", "a-.near", "x".repeat(65), "a/b.near", 7]) assert.equal(nearAccount(bad), null, String(bad));
});

test("the providers: two operators, FastNEAR and dRPC; the day-back reads dRPC and near.org's archival", () => {
  assert.deepEqual([...NEAR_RPCS], ["https://free.rpc.fastnear.com", "https://near.drpc.org"]);
  assert.deepEqual([...PAST_RPCS], ["https://near.drpc.org", "https://archival-rpc.mainnet.near.org"]);
});

test("createNearLists on the recorded read: NEAR's snapshot in the frozen row fields, src chain, every value from the views", async () => {
  const calls: string[] = [];
  const lists = createNearLists({ fetch: fixtureFetch(calls) });
  let a = await lists.get();
  // the hour and day reads land after the first answer: wait for them (the recorded read had them)
  for (let i = 0; i < 100 && JSON.parse(a.body).lists.trending.length === 0; i++) {
    await new Promise((ok) => setTimeout(ok, 20));
    a = await lists.get();
  }
  assert.equal(a.status, 200);
  const s = JSON.parse(a.body);
  assert.equal(s.chain, "near");
  assert.deepEqual(Object.keys(s.lists), ["new", "trending", "trending_5m", "trending_1h", "graduating"]);
  assert.ok(s.lists.new.length > 0, "new rows");
  assert.ok(s.lists.trending.length > 0, "trending rows");
  for (const r of [...s.lists.new, ...s.lists.trending]) {
    assert.deepEqual(Object.keys(r).sort(), [...ROW_FIELDS].sort());
    assert.equal(r.chain, "near");
    assert.equal(r.src, "chain");
    assert.equal(r.as_of_ms, s.as_of_ms);
    assert.equal(r.icon, false);
    assert.equal(r.launchpad, null);
    assert.equal(r.created_s, null);
    assert.match(r.price_usd, /^\d+(\.\d+)?$/);
    assert.ok(Number(r.liq_usd) >= 1000, `${r.token} liq ${r.liq_usd}`);
    assert.equal(nearAccount(r.token), r.token);
  }
  // new: newest pool first; trending: most hour volume first, every row with some
  const ids = s.lists.new.map((r: { token: string }) => Number(s.pools[r.token]));
  assert.deepEqual(ids, [...ids].sort((x: number, y: number) => y - x));
  const vols = s.lists.trending.map((r: { vol_1h_usd: string }) => Number(r.vol_1h_usd));
  assert.deepEqual(vols, [...vols].sort((x: number, y: number) => y - x));
  assert.ok(vols.every((v: number) => v > 0));
  assert.deepEqual(s.lists.trending, s.lists.trending_1h);
  // RHEA's row is its pool's own price: 6458's wNEAR over its RHEA at NEAR's price from pool 4512 (USDC)
  const rhea = s.lists.trending.find((r: { token: string }) => r.token === "token.rhealab.near");
  assert.equal(rhea.symbol, "RHEA");
  assert.equal(s.pools["token.rhealab.near"], "6458");
  const head = (FX.rpc[0]!.answer!.result as { header: { height: number } }).header.height;
  const p6458 = FX.rpc.find((r) => r.body.params.method_name === "get_pools" && r.body.params.block_id === head && (JSON.parse(Buffer.from(String(r.body.params.args_base64), "base64").toString()) as { from_index: number }).from_index === 6000)!;
  const pool = (p6458.view as { token_account_ids: string[]; amounts: string[] }[])[458]!;
  assert.deepEqual(pool.token_account_ids, ["token.rhealab.near", "wrap.near"]);
  assert.ok(Math.abs(Number(rhea.liq_usd) / 2 / (Number(pool.amounts[1]) / 1e24) - Number(rhea.price_usd) * (Number(pool.amounts[0]) / 1e18) / (Number(pool.amounts[1]) / 1e24)) < 0.01);
  // both operators were asked (rotation)
  assert.ok(calls.some((u) => u.includes("fastnear")) && calls.some((u) => u.includes("drpc")));
});

test("the token page: any token with a Rhea wNEAR pool, the 06b fields, null with src none where no view reads it; 404 otherwise", async () => {
  const lists = createNearLists({ fetch: fixtureFetch() });
  const t = createNearToken(lists);
  const a = await t.page("token.rhealab.near");
  assert.equal(a.status, 200);
  const p = JSON.parse(a.body);
  assert.deepEqual(Object.keys(p), [...PAGE_FIELDS]);
  assert.deepEqual(Object.keys(p.risk), [...RISK_FIELDS]);
  assert.equal(p.row.symbol, "RHEA");
  assert.equal(p.decimals, 18);
  assert.equal(p.pool, null);
  assert.equal(p.route, "unknown");
  assert.equal(p.risk.liq_usd.src, "chain");
  assert.equal(p.risk.liq_usd.v, p.row.liq_usd);
  assert.equal(p.risk.holders.src, "none");
  const h = await t.holders("token.rhealab.near");
  assert.deepEqual({ ...JSON.parse(h.body), as_of_ms: 0 }, { holders: [], total: null, top_bps: null, src: "none", as_of_ms: 0 });
  for (const bad of ["no-pool-token.near", "Bad", "a..near"]) assert.equal((await t.page(bad)).status, 404, bad);
});

test("pacedFetch: one host's calls start HOST_GAP_MS apart, one past WAIT_MAX_MS fails with nothing sent, and a 429 holds the host", async () => {
  let sent = 0;
  const f = pacedFetch(async () => (sent++, new Response("{}", { status: 200 })));
  const n = Math.ceil(WAIT_MAX_MS / HOST_GAP_MS) + 10;
  const t0 = Date.now();
  const got = await Promise.allSettled(Array.from({ length: n }, () => f("https://pace.test/", {})));
  const refused = got.filter((g) => g.status === "rejected").length;
  assert.ok(refused >= 9 && refused <= 11, `refused ${refused} of ${n}`);
  assert.equal(sent, n - refused);
  assert.ok(Date.now() - t0 >= (sent - 1) * HOST_GAP_MS - 50, "spaced");
  let asked = 0;
  const g = pacedFetch(async () => (asked++, new Response("busy", { status: 429 })));
  assert.equal((await g("https://held.test/", {})).status, 429);
  await assert.rejects(g("https://held.test/", {}), /host held/);
  assert.equal(asked, 1);
});
