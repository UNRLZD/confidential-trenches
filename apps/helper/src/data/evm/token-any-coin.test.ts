// node --test apps/helper/src/data/evm/token-any-coin.test.ts (card evm-token-page-opens-any-coin): a Base or Robinhood
// coin no Discover list served opens its page and holders, named by DexScreener (named.ts) with the
// answers it gave for Robinhood MOW and Base DEGEN (fixtures/dexscreener-named.json, read 2026-11-15 20:20Z). Red at
// 0322a1322: both chains' token page answered 404 for any address its lists never served (token.ts rowOf; live 20:10Z:
// MOW and DEGEN 404 on the deployed helper). The chart and tape: swaps-any-coin.test.ts. An address
// DexScreener names no pool for (a typo, a non-contract) still answers 404; DexScreener refused or down answers 503,
// never a 404 for a real coin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { call as _call, listening } from "../../../test/servers.ts";
import { ROW_FIELDS } from "../../../../terminal/src/screens/discover/fields.ts";
import { start } from "../../server.ts";
import { DEX_BASE } from "../held.ts";
import { HOLDERS_FIELDS, PAGE_FIELDS } from "../solana/token.ts";
import { createEvmNamed, toNamed } from "./named.ts";
import { createEvmToken } from "./token.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DEX = JSON.parse(readFileSync(new URL("./fixtures/dexscreener-named.json", import.meta.url), "utf8")) as { recorded_at: string; answers: Record<string, unknown[]> };
const NOW = Date.parse(DEX.recorded_at);
const MOW = "0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa";
const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
const NOT_A_COIN = "0x0000000000000000000000000000000000000001";
type Chain = "base" | "robinhood";
const CASES = [
  { chain: "robinhood", token: MOW, symbol: "MOW", name: "MowCat", price: "0.1547", pool: "0x5291cfd042d8a771a510534ee31090bc4f4dc72724871e8f321aecfd12332a9a" },
  { chain: "base", token: DEGEN, symbol: "DEGEN", name: "Degen", price: "0.0007108", pool: "0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa" },
] as const;

/** Each chain's recorded lists (the token page test's, fixtures/token-info-<chain>.json), which hold neither coin, and a
 *  maker read that names a pad for DEGEN only (a stand-in for lists.ts maker's on-chain read). */
const listsOf = (chain: Chain) => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/token-info-${chain}.json`, import.meta.url), "utf8")) as { lists_body: string };
  const snap = JSON.parse(f.lists_body) as { as_of_ms: number; lists: Record<string, { token: string }[]> };
  const tokens = new Set(Object.values(snap.lists).flat().map((r) => r.token));
  return {
    tokens,
    get: async () => ({ status: 200, body: f.lists_body, asOfMs: snap.as_of_ms }),
    listed: async (t: string) => tokens.has(t),
    maker: async (t: string) => (t === DEGEN ? "clanker" : null),
  };
};
/** DexScreener behind a fake fetch: the recorded answer for each asked token ([] for one it has none for), or `status`. */
let dexCalls = 0;
const dexFetch = (status = 200) => async (url: string): Promise<Response> => {
  const m = new RegExp(`^${DEX_BASE}/tokens/v1/(base|robinhood)/(0x[0-9a-f]{40})$`).exec(url);
  if (m === null) throw new Error(`unexpected ${url}`);
  dexCalls++;
  if (status !== 200) return new Response("{}", { status, headers: status === 429 ? { "retry-after": "30" } : {} });
  return new Response(JSON.stringify(DEX.answers[`${m[1]}:${m[2]}`] ?? []), { status: 200 });
};
const tokensWith = (status = 200) =>
  Object.fromEntries(
    (["base", "robinhood"] as const).map((c) => {
      const fetch = dexFetch(status);
      return [c, createEvmToken(c, { lists: listsOf(c), named: createEvmNamed(c, { fetch, now: () => NOW }), now: () => NOW })];
    }),
  );
const at = (evmTokens: ReturnType<typeof tokensWith>) => start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, evmTokens);
// Each server may have said 'listening' before before() runs (start() listens at import); the shared wait reads its own
// state first, and every call is bounded (card helper-test-servers-never-hang, test/servers.ts).
const servers: [string, Server][] = [
  ["the DexScreener-up server", at(tokensWith())],
  ["the DexScreener-429 server", at(tokensWith(429))],
  ["the DexScreener-500 server", at(tokensWith(500))],
];
const ports: number[] = [];
before(async () => {
  (await Promise.all(servers.map(([name, s]) => listening(s, name)))).forEach((p, i) => (ports[i] = p));
});
after(() => Promise.all(servers.map(([, s]) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))))));

/** One GET to server `to`, bounded and named. */
const call = (path: string, to = 0) => _call(ports[to]!, { path }, servers[to]![0]);

for (const c of CASES) {
  test(`GET /v1/market/token?chain=${c.chain} for ${c.symbol}, which no list served: 200, its row DexScreener's, in the frozen fields`, async () => {
    assert.equal(listsOf(c.chain).tokens.has(c.token), false, "the coin is on no list");
    const r = await call(`/v1/market/token?chain=${c.chain}&token=${c.token}`);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers["x-helper-source"], "dexscreener");
    assert.equal(r.headers["x-fetched-at"], new Date(NOW).toISOString());
    const p = JSON.parse(r.body);
    assert.deepEqual(Object.keys(p), [...PAGE_FIELDS]);
    assert.deepEqual(Object.keys(p.row), [...ROW_FIELDS]);
    assert.equal(p.row.chain, c.chain);
    assert.equal(p.row.token, c.token);
    assert.equal(p.row.symbol, c.symbol);
    assert.equal(p.row.name, c.name);
    assert.equal(p.row.price_usd, c.price);
    assert.equal(p.row.src, "dexscreener");
    // the maker read's tag: DEGEN's stand-in names a pad, MOW's none
    assert.equal(p.row.launchpad, c.token === DEGEN ? "clanker" : null);
    assert.equal(p.risk.liq_usd.v, p.row.liq_usd);
    const h = await call(`/v1/market/holders?chain=${c.chain}&token=${c.token}`);
    assert.equal(h.status, 200, h.body);
    assert.deepEqual(Object.keys(JSON.parse(h.body)), [...HOLDERS_FIELDS]);
  });
}

test("an address DexScreener names no pool for, a typo, a coin on the other chain: 404 not_found, as before", async () => {
  for (const q of [`chain=base&token=${NOT_A_COIN}`, "chain=base&token=0x12", `chain=base&token=${MOW}`, `chain=robinhood&token=${DEGEN}`]) {
    for (const path of ["token", "holders"]) {
      const r = await call(`/v1/market/${path}?${q}`);
      assert.equal(r.status, 404, `${path} ${q}`);
      assert.deepEqual(JSON.parse(r.body), { error: { code: "not_found" } });
    }
  }
});

test("DexScreener refusing (429) or down (500): 503 upstream for a coin no list carries, never a 404", async () => {
  for (const to of [1, 2]) {
    const r = await call(`/v1/market/token?chain=robinhood&token=${MOW}`, to);
    assert.equal(r.status, 503, `server ${to}: ${r.body}`);
    assert.deepEqual(JSON.parse(r.body), { error: { code: "upstream" } });
  }
});

test("a token the lists served is answered from its list row with no DexScreener call; a coin read once is held, not read again", async () => {
  const listed = [...listsOf("base").tokens][0]!;
  const before = dexCalls;
  assert.equal((await call(`/v1/market/token?chain=base&token=${listed}`)).status, 200);
  assert.equal(dexCalls, before, "no DexScreener call for a listed token");
  assert.equal((await call(`/v1/market/token?chain=base&token=${DEGEN}`)).status, 200);
  assert.equal(dexCalls, before, "DEGEN's answer of the first test is held");
});

test("toNamed: the recorded answers, and every hostile pair refused", () => {
  const mow = toNamed("robinhood", MOW, DEX.answers[`robinhood:${MOW}`], NOW)!;
  assert.equal(mow.pool, CASES[0].pool, "the v4 pool id, a hint the swap reads check on chain");
  assert.equal(mow.row.chg_24h_bps, -101);
  assert.equal(mow.row.chg_5m_bps, null, "a change DexScreener does not give is null");
  assert.equal(mow.row.buys_24h, 372);
  assert.equal(mow.row.created_s, 1790956630);
  assert.equal(mow.row.mc_usd, "154733203");
  assert.equal(toNamed("base", DEGEN, DEX.answers[`base:${DEGEN}`], NOW)!.pool, CASES[1].pool);
  assert.equal(toNamed("base", NOT_A_COIN, DEX.answers[`base:${NOT_A_COIN}`], NOW), null);
  const pair = DEX.answers[`base:${DEGEN}`]![0] as Record<string, unknown>;
  const base = pair.baseToken as Record<string, unknown>;
  for (const bad of [
    { ...pair, chainId: "ethereum" },
    { ...pair, baseToken: { ...base, address: MOW } },
    { ...pair, baseToken: { ...base, symbol: "" } },
    { ...pair, baseToken: { ...base, symbol: 7 } },
  ])
    assert.equal(toNamed("base", DEGEN, [bad], NOW), null);
  assert.equal(toNamed("base", DEGEN, { pairs: [pair] }, NOW), null, "not a list");
  const odd = toNamed("base", DEGEN, [{ ...pair, priceUsd: "1e9", pairAddress: "javascript:1", priceChange: { h24: Infinity }, txns: { h24: { buys: -1 } }, pairCreatedAt: NOW + 2 * 86_400_000 }], NOW)!;
  assert.equal(odd.row.price_usd, null);
  assert.equal(odd.pool, null);
  assert.equal(odd.row.chg_24h_bps, null);
  assert.equal(odd.row.buys_24h, null);
  assert.equal(odd.row.created_s, null);
});
