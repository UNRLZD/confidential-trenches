// node --test apps/helper/src/data/evm/token.test.ts: GET /v1/market/token and /v1/market/holders with chain=base and
// chain=robinhood on a real server on a free port (card market-data-evm-token), with the deployed helper's recorded
// lists answers and GeckoTerminal's recorded token info answers (fixtures/token-info-<chain>.json, 2026-11-09 01:49-01:52Z)
// behind a fake fetch: 200 in exactly the Solana path's frozen fields, the row the lists' own with its launchpad tag
// and chain, the info's decimals, holder count and top 10 share; an address the lists never served, or no address, 404;
// GeckoTerminal refusing or failing never invents a value. Red at 26438c0c: both routes answered 404 for any chain but
// solana (server.ts:478).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { ROW_FIELDS } from "../../../../terminal/src/screens/discover/fields.ts";
import { start } from "../../server.ts";
import { geckoBudget } from "../gecko.ts";
import { HOLDERS_FIELDS, PAGE_FIELDS, RISK_FIELDS } from "../solana/token.ts";
import { GT_BASE } from "./lists.ts";
import { createEvmToken, INFO_FRESH_MS, INFO_WAIT_MS, toInfo } from "./token.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
type Snapshot = { as_of_ms: number; lists: Record<string, Record<string, unknown>[]> };
/** `lists_body`: the deployed helper's lists answer as it sent it; `info`: GeckoTerminal's info answer per token. */
type Fixture = { recorded_at: string; lists_body: string; lists: Snapshot; info: Record<string, unknown>; info_404?: unknown };
const fx = (chain: string): Fixture => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/token-info-${chain}.json`, import.meta.url), "utf8")) as Fixture;
  return { ...f, lists: JSON.parse(f.lists_body) as Snapshot };
};
const FX = { base: fx("base"), robinhood: fx("robinhood") };
const NOW = Date.parse(FX.base.recorded_at);
/** The recorded token each chain's case reads, and the launchpad the deployed lists tagged it with on chain. */
const CASES = [
  { chain: "base", addr: "0x2df14792e7b9c5cc8e9a1eb37140533b32fb8d99", pad: "doppler", decimals: 18, holders: 154, top: 9550 },
  { chain: "robinhood", addr: "0xe71b15267238c80ec51a16d389cdd00133162ad2", pad: "pons", decimals: 18, holders: 2, top: 10_000 },
] as const;
const UNLISTED = "0x000000000000000000000000000000000000dead";

const rowOf = (chain: keyof typeof FX, token: string) => Object.values(FX[chain].lists.lists).flat().find((r) => r.token === token)!;
const listsOf = (chain: keyof typeof FX) => {
  const tokens = new Set(Object.values(FX[chain].lists.lists).flat().map((r) => r.token as string));
  return { get: async () => ({ status: 200, body: FX[chain].lists_body, asOfMs: FX[chain].lists.as_of_ms }), listed: async (t: string) => tokens.has(t) };
};
let calls = 0;
const fake = (chain: keyof typeof FX, status = 200) => async (url: string): Promise<Response> => {
  calls++;
  const m = new RegExp(`^${GT_BASE}/networks/${chain}/tokens/(0x[0-9a-f]{40})/info$`).exec(url);
  if (m === null) throw new Error(`unexpected ${url}`);
  if (status !== 200) return new Response("{}", { status, headers: status === 429 ? { "retry-after": "30" } : {} });
  const a = FX[chain].info[m[1]!];
  return a === undefined ? new Response(JSON.stringify(FX.base.info_404), { status: 404 }) : new Response(JSON.stringify(a), { status: 200 });
};
const tokens = (status = 200) => ({
  base: createEvmToken("base", { lists: listsOf("base"), gecko: geckoBudget(() => NOW), fetch: fake("base", status), now: () => NOW }),
  robinhood: createEvmToken("robinhood", { lists: listsOf("robinhood"), gecko: geckoBudget(() => NOW), fetch: fake("robinhood", status), now: () => NOW }),
});
const at = (evmTokens: ReturnType<typeof tokens>) => start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, evmTokens);
const servers = [at(tokens()), at(tokens(429)), at(tokens(500))];
const ports: number[] = [];
before(() => Promise.all(servers.map((s, i) => new Promise<void>((ok) => s.on("listening", () => ((ports[i] = (s.address() as AddressInfo).port), ok()))))));
after(() => Promise.all(servers.map((s) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))))));

function call(path: string, to = 0) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: ports[to], method: "GET", path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail).end();
  });
}

for (const c of CASES) {
  test(`GET /v1/market/token?chain=${c.chain}: 200 in the frozen fields, the lists' row with its ${c.pad} tag, GeckoTerminal's decimals, holders and top 10`, async () => {
    const r = await call(`/v1/market/token?chain=${c.chain}&token=${c.addr}`);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers["x-helper-source"], "geckoterminal");
    const p = JSON.parse(r.body);
    // dated by the row's own list read (each list's; the snapshot's as_of_ms is the oldest of the three)
    assert.equal(r.headers["x-fetched-at"], new Date(rowOf(c.chain, c.addr).as_of_ms as number).toISOString());
    assert.deepEqual(Object.keys(p), [...PAGE_FIELDS]);
    assert.deepEqual(Object.keys(p.row), [...ROW_FIELDS]);
    assert.deepEqual(Object.keys(p.risk), [...RISK_FIELDS]);
    const listed = rowOf(c.chain, c.addr);
    assert.equal(p.row.chain, c.chain);
    assert.equal(p.row.token, c.addr);
    assert.equal(p.row.launchpad, c.pad);
    for (const f of ["symbol", "name", "price_usd", "mc_usd", "liq_usd", "vol_24h_usd", "created_s", "as_of_ms"]) assert.equal(p.row[f], listed[f], f);
    assert.equal(p.row.holders, c.holders);
    assert.equal(p.row.top10_bps, c.top);
    assert.equal(p.decimals, c.decimals);
    assert.equal(p.pool, null); // no swap read holds its pool here
    assert.deepEqual(p.risk.holders, { v: c.holders, src: "geckoterminal", as_of_ms: p.risk.holders.as_of_ms });
    assert.equal(p.risk.top10_bps.v, c.top);
    assert.deepEqual(p.risk.liq_usd, { v: listed.liq_usd, src: "geckoterminal", as_of_ms: listed.as_of_ms });
    for (const f of ["mint_auth", "freeze_auth", "lp", "dev_bps", "snipers_bps", "tax", "honeypot", "insiders_bps", "bundlers_bps", "fresh_bps"]) assert.equal(p.risk[f].src, "none", f);
    assert.equal(p.route, "unknown");
    assert.equal(p.filling, false);
  });

  test(`GET /v1/market/holders?chain=${c.chain}: 200 in the frozen fields, no rows, GeckoTerminal's count and top 10`, async () => {
    const r = await call(`/v1/market/holders?chain=${c.chain}&token=${c.addr}`);
    assert.equal(r.status, 200, r.body);
    const h = JSON.parse(r.body);
    assert.deepEqual(Object.keys(h), [...HOLDERS_FIELDS]);
    assert.deepEqual(h.holders, []);
    assert.equal(h.total, c.holders);
    assert.equal(h.top_bps, c.top);
    assert.equal(h.src, "geckoterminal");
  });
}

test("an address the lists never served, a mixed-case listed address, no token, two tokens, a non-address: 404 or the page", async () => {
  for (const chain of ["base", "robinhood"]) {
    for (const path of ["token", "holders"]) {
      for (const q of [`&token=${UNLISTED}`, "", `&token=${CASES[0].addr}&token=${CASES[0].addr}`, "&token=0x123", "&token=__proto__"]) {
        const r = await call(`/v1/market/${path}?chain=${chain}${q}`);
        assert.equal(r.status, 404, `${chain} ${path} ${q}`);
        assert.deepEqual(JSON.parse(r.body), { error: { code: "not_found" } });
      }
    }
  }
  // the lists' tokens are lowercase; the same address in checksum case is the same token
  const mixed = await call(`/v1/market/token?chain=base&token=0x${CASES[0].addr.slice(2).toUpperCase()}`);
  assert.equal(mixed.status, 200);
  assert.equal(JSON.parse(mixed.body).row.token, CASES[0].addr);
  for (const q of ["?chain=BASE", "?chain=eip155:8453", "?chain=constructor"]) assert.equal((await call(`/v1/market/token${q}&token=${CASES[0].addr}`)).status, 404, q);
});

test("GeckoTerminal refusing (429) or failing (500): the page is the lists' row with those fields null, holders 429 or 503, never a value made up", async () => {
  for (const [to, holders] of [[1, 429], [2, 503]] as const) {
    const r = await call(`/v1/market/token?chain=base&token=${CASES[0].addr}`, to);
    assert.equal(r.status, 200);
    const p = JSON.parse(r.body);
    assert.equal(p.row.holders, null);
    assert.equal(p.row.top10_bps, null);
    assert.equal(p.decimals, null);
    assert.equal(p.risk.holders.src, "none");
    assert.equal(p.row.launchpad, "doppler");
    const h = await call(`/v1/market/holders?chain=base&token=${CASES[0].addr}`, to);
    assert.equal(h.status, holders, h.body);
    if (holders === 429) assert.ok(Number(h.headers["retry-after"]) >= 1);
  }
});

test("the info is read once a token and held INFO_FRESH_MS; a held page answers with no call, and in well under the page's 1 s", async () => {
  let t = NOW;
  calls = 0;
  const tok = createEvmToken("robinhood", { lists: listsOf("robinhood"), gecko: geckoBudget(() => t), fetch: fake("robinhood"), now: () => t });
  assert.equal((await tok.page(CASES[1].addr)).status, 200);
  assert.equal(calls, 1);
  const ms: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    assert.equal((await tok.page(CASES[1].addr)).status, 200);
    ms.push(performance.now() - t0);
  }
  await tok.holders(CASES[1].addr);
  assert.equal(calls, 1, "held: no second call");
  ms.sort((a, b) => a - b);
  console.log(`warm page: p50 ${ms[25]!.toFixed(2)} ms, p95 ${ms[47]!.toFixed(2)} ms, n=50 (bound 1000 ms)`);
  assert.ok(ms[47]! < 50, `warm page p95 ${ms[47]} ms`);
  t += INFO_FRESH_MS;
  await tok.page(CASES[1].addr);
  assert.equal(calls, 2, "read again once INFO_FRESH_MS old");
});

test("a first info read slower than INFO_WAIT_MS: the page answers without it, the read lands for the next one", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((ok) => (release = ok));
  const tok = createEvmToken("base", {
    lists: listsOf("base"),
    gecko: geckoBudget(Date.now),
    fetch: async (url) => (await slow, fake("base")(url)),
  });
  const t0 = performance.now();
  const first = JSON.parse((await tok.page(CASES[0].addr)).body);
  const waited = performance.now() - t0;
  assert.ok(waited >= INFO_WAIT_MS - 5 && waited < INFO_WAIT_MS + 200, `waited ${waited} ms`);
  assert.equal(first.row.holders, null);
  release();
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(JSON.parse((await tok.page(CASES[0].addr)).body).row.holders, CASES[0].holders);
});

test("the pool and decimals the swap reads found and checked on chain win over GeckoTerminal's decimals", async () => {
  const kept = { pool: "0x00000000000000000000000000000000000000000000000000000000000000ab", decimals: 6 };
  const tok = createEvmToken("base", { lists: listsOf("base"), gecko: geckoBudget(() => NOW), fetch: fake("base"), now: () => NOW, kept: (t) => (t === CASES[0].addr ? kept : undefined) });
  const p = JSON.parse((await tok.page(CASES[0].addr)).body);
  assert.equal(p.pool, kept.pool);
  assert.equal(p.decimals, 6);
});

test("a lists answer rebuilt with the same as_of_ms (a maker settled in a tick with no list read): the page takes its new tag", async () => {
  const snap = structuredClone(FX.base.lists);
  for (const r of Object.values(snap.lists).flat()) if (r.token === CASES[0].addr) r.launchpad = null;
  let body = JSON.stringify(snap);
  const lists = { get: async () => ({ status: 200, body, asOfMs: snap.as_of_ms }), listed: async () => true };
  const tok = createEvmToken("base", { lists, gecko: geckoBudget(() => NOW), fetch: fake("base"), now: () => NOW });
  assert.equal(JSON.parse((await tok.page(CASES[0].addr)).body).row.launchpad, null);
  body = FX.base.lists_body; // the same as_of_ms, the maker now read
  assert.equal(JSON.parse((await tok.page(CASES[0].addr)).body).row.launchpad, "doppler");
});

test("toInfo: only an answer naming this token; numbers in range or null", () => {
  const good = FX.base.info[CASES[0].addr];
  assert.notEqual(toInfo(CASES[0].addr, good, NOW), null);
  assert.equal(toInfo(UNLISTED, good, NOW), null, "another token's answer");
  assert.equal(toInfo(CASES[0].addr, FX.base.info_404, NOW), null);
  const bad = structuredClone(good) as { data: { attributes: Record<string, unknown> } };
  Object.assign(bad.data.attributes, { decimals: 99, holders: { count: -1, distribution_percentage: { top_10: "101.5" }, last_updated: "2099-01-01T00:00:00Z" } });
  assert.deepEqual(toInfo(CASES[0].addr, bad, NOW), { decimals: null, holders: null, top10Bps: null, asOfMs: NOW });
});
