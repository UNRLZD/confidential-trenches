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
import { GT_PAGE_WAIT_MS, GT_SERVE_MS, geckoBudget, WINDOW_MS, type GeckoBudget } from "../gecko.ts";
import { HOLDERS_FIELDS, PAGE_FIELDS, RISK_FIELDS } from "../solana/token.ts";
import { GT_BASE } from "./lists.ts";
import { createEvmToken, INFO_FRESH_MS, INFO_SERVE_MS, INFO_WAIT_MS, toInfo } from "./token.ts";
import { enableTimers, resetTimers } from "../../../test/mock-timers.ts";

/** `p`'s answer once the promise steps queued now have run, with no timer firing; undefined while it waits on one. */
async function atOnce<T>(p: Promise<T>): Promise<T | undefined> {
  let got: T | undefined;
  void p.then((v) => (got = v));
  for (let i = 0; i < 10 && got === undefined; i++) await new Promise((r) => setImmediate(r));
  return got;
}

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

test("the info is read once a token and held INFO_FRESH_MS; a held page answers with no call and no wait", async (ctx) => {
  let t = NOW;
  calls = 0;
  const tok = createEvmToken("robinhood", { lists: listsOf("robinhood"), gecko: geckoBudget(() => t), fetch: fake("robinhood"), now: () => t });
  assert.equal((await tok.page(CASES[1].addr)).status, 200);
  assert.equal(calls, 1);
  // a held page waits on no timer: with the timers mocked and never moved, each answers at once
  enableTimers(ctx.mock.timers, { apis: ["setTimeout"] });
  try {
    for (let i = 0; i < 50; i++) assert.equal((await atOnce(tok.page(CASES[1].addr)))?.status, 200, `held page ${i} answered with no wait`);
  } finally {
    resetTimers(ctx.mock.timers);
  }
  await tok.holders(CASES[1].addr);
  assert.equal(calls, 1, "held: no second call");
  t += INFO_FRESH_MS;
  await tok.page(CASES[1].addr);
  assert.equal(calls, 2, "read again once INFO_FRESH_MS old");
});

test("a first info read slower than INFO_WAIT_MS: the page answers without it, the read lands for the next one", async (t) => {
  let release: () => void = () => {};
  const slow = new Promise<void>((ok) => (release = ok));
  const tok = createEvmToken("base", {
    lists: listsOf("base"),
    gecko: geckoBudget(Date.now),
    fetch: async (url) => (await slow, fake("base")(url)),
  });
  // the page's wait for the info on mocked timers: it answers at INFO_WAIT_MS, not 1 ms before
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  let page: Awaited<ReturnType<typeof tok.page>> | undefined;
  try {
    const p = tok.page(CASES[0].addr);
    assert.equal(await atOnce(p), undefined, "it waits for the info read");
    t.mock.timers.tick(INFO_WAIT_MS - 1);
    assert.equal(await atOnce(p), undefined, "1 ms before INFO_WAIT_MS");
    t.mock.timers.tick(1);
    page = await atOnce(p);
  } finally {
    resetTimers(t.mock.timers);
  }
  assert.ok(page !== undefined, "answered at INFO_WAIT_MS");
  const first = JSON.parse(page.body);
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

// Card evm-holders-never-starve: the live helper's window holds its own background reads every minute (helper log
// 14:33-14:46Z: "calls: ahead sol bars 1, lists 1-2 ... window 3 of 5"), and a token's first info read went to the
// "refresh" (page) or "stale" (holders) lane, which stop at 3 and 4 calls: Robinhood's holders answered 429 at 14:46Z
// ("stale base info 1; refused: ... stale 4"). A read of what nobody holds is a page read (../gecko.ts refreshLane).
// Its promise as it holds on the keyless budget (card market-data-evm-capacity): a listed token's holders answer 200
// whenever the helper read them in the last INFO_SERVE_MS, however busy the window; a token nobody read in that time
// answers 200 when the budget frees a call within GT_PAGE_WAIT_MS, else 429 with the wait (the last test below).
/** One budget for both chains, as the server's, with the window the live helper had: one ahead call, two list calls. */
function liveWindow(clock: () => number): GeckoBudget {
  const b = geckoBudget(clock);
  assert.ok(b.take("ahead", false, false, "sol bars"));
  assert.ok(b.take("lists", true));
  assert.ok(b.take("lists", true));
  return b;
}

test("the window busy as the live helper's (ahead 1, lists 2 of 5): each chain's first page and holders answer 200 with GeckoTerminal's count, one call a token", async () => {
  calls = 0;
  const gecko = liveWindow(() => NOW);
  const tok = {
    base: createEvmToken("base", { lists: listsOf("base"), gecko, fetch: fake("base"), now: () => NOW }),
    robinhood: createEvmToken("robinhood", { lists: listsOf("robinhood"), gecko, fetch: fake("robinhood"), now: () => NOW }),
  };
  for (const c of CASES) {
    const page = await tok[c.chain].page(c.addr);
    assert.equal(page.status, 200);
    assert.equal(JSON.parse(page.body).row.holders, c.holders, `${c.chain} page: the holder count`);
    const h = await tok[c.chain].holders(c.addr);
    assert.equal(h.status, 200, `${c.chain} holders: ${h.body}`);
    assert.deepEqual([JSON.parse(h.body).total, JSON.parse(h.body).top_bps], [c.holders, c.top]);
  }
  assert.equal(calls, 2, "one info call a token");
});

test("the window busy: a token's first holders read with no page before it answers 200 on both chains", async () => {
  calls = 0;
  const gecko = liveWindow(() => NOW);
  for (const c of CASES) {
    const tok = createEvmToken(c.chain, { lists: listsOf(c.chain), gecko, fetch: fake(c.chain), now: () => NOW });
    const h = await tok.holders(c.addr);
    assert.equal(h.status, 200, `${c.chain} holders: ${h.body}`);
    assert.equal(JSON.parse(h.body).total, c.holders);
  }
  assert.equal(calls, 2);
});

// Card market-data-evm-capacity: the holder count is display data that moves slowly, so a held one serves, dated by its
// own read, for INFO_SERVE_MS, while its re-read waits for a call nobody's first read needs. Before it, a count held
// past GT_SERVE_MS (10 min) was dropped and a full window answered 429 for a token the helper had read (live 20:34Z:
// "refused /v1/market/holders geckoterminal budget", window 5 of 5). Red at 1e00df14 (the 429 at GT_SERVE_MS).
test("a held info's re-read leaves a first read its calls: refused, the held count serves, dated, while under INFO_SERVE_MS, never past it", async () => {
  let t = NOW;
  calls = 0;
  const gecko = geckoBudget(() => t);
  const tok = createEvmToken("robinhood", { lists: listsOf("robinhood"), gecko, fetch: fake("robinhood"), now: () => t });
  const c = CASES[1];
  const first = JSON.parse((await tok.holders(c.addr)).body);
  assert.equal(first.total, c.holders);
  // past INFO_FRESH_MS, the window at the room a held re-read leaves a first read (COLD_RESERVE)
  t += INFO_FRESH_MS;
  for (let i = 0; i < 3; i++) assert.ok(gecko.take("pages"));
  const held = await tok.holders(c.addr);
  assert.equal(held.status, 200);
  assert.equal(JSON.parse(held.body).total, c.holders, "the held count");
  assert.equal(JSON.parse(held.body).as_of_ms, first.as_of_ms, "dated by its read, not by the answer");
  assert.equal(JSON.parse((await tok.page(c.addr)).body).row.holders, c.holders);
  assert.equal(calls, 1, "the re-read refused: no call");
  // past GT_SERVE_MS, the window full: still the held count, dated (the 429 before this card)
  t = NOW + GT_SERVE_MS;
  for (let i = 0; i < 5; i++) assert.ok(gecko.take("pages"));
  const kept = await tok.holders(c.addr);
  assert.equal(kept.status, 200, kept.body);
  assert.equal(JSON.parse(kept.body).total, c.holders);
  assert.equal(JSON.parse((await tok.page(c.addr)).body).row.holders, c.holders);
  assert.equal(calls, 1);
  // past INFO_SERVE_MS the held count is not served: its re-read is a page read, and refused it is the budget's 429 with
  // its wait, never a 200 with a count older than the bound
  t = NOW + INFO_SERVE_MS;
  for (let i = 0; i < 5; i++) assert.ok(gecko.take("pages"));
  const old = await tok.holders(c.addr);
  assert.equal(old.status, 429, old.body);
  assert.ok((old.retryAfterS ?? 0) >= 1);
  assert.equal(JSON.parse((await tok.page(c.addr)).body).row.holders, null, "the page: no old count");
  assert.equal(calls, 1);
});

// Card market-data-evm-capacity: N tokens opened inside one window, on the window the live helper keeps with its own
// background reads (liveWindow: 3 of 5). Each token's holders were read once in the last INFO_SERVE_MS (a page opened
// earlier, a live run's read): every one answers 200 with its count and no call is spent. Red at 1e00df14: each count
// was dropped at GT_SERVE_MS, the re-reads met the full window and answered 429.
test("four tokens on both chains, read within the hour, opened again inside one window with the background's 3 of 5 held: holders 200 for each, dated, no 429", async () => {
  let t = NOW;
  calls = 0;
  const all = (["base", "robinhood"] as const).flatMap((chain) => Object.keys(FX[chain].info).map((addr) => ({ chain, addr })));
  assert.equal(all.length, 4);
  const gecko = geckoBudget(() => t);
  const tok = {
    base: createEvmToken("base", { lists: listsOf("base"), gecko, fetch: fake("base"), now: () => t }),
    robinhood: createEvmToken("robinhood", { lists: listsOf("robinhood"), gecko, fetch: fake("robinhood"), now: () => t }),
  };
  for (const [i, c] of all.entries()) {
    t = NOW + i * WINDOW_MS; // one a window
    assert.equal((await tok[c.chain].holders(c.addr)).status, 200);
  }
  assert.equal(calls, 4);
  // 40 min later the window holds the background's three calls (ahead 1, lists 2) and a cold chart's pool and bars
  t = NOW + 40 * 60_000;
  assert.ok(gecko.take("ahead", false, false, "sol bars"));
  assert.ok(gecko.take("lists", true));
  assert.ok(gecko.take("lists", true));
  assert.ok(gecko.take("pages", false, false, "base pool"));
  assert.ok(gecko.take("pages", false, false, "base bars"));
  for (const c of all) {
    const h = await tok[c.chain].holders(c.addr);
    assert.equal(h.status, 200, `${c.chain} ${c.addr}: ${h.body}`);
    assert.equal(typeof JSON.parse(h.body).total, "number");
    const p = await tok[c.chain].page(c.addr);
    assert.equal(typeof JSON.parse(p.body).row.holders, "number", `${c.chain} ${c.addr} page`);
  }
  assert.equal(calls, 4, "no call spent: the window is full");
});

// The window full, 5 of 5, as at 14:29Z with the live run's Solana pages: a cold holders read waits for the budget's next
// free call under GT_PAGE_WAIT_MS (../gecko.ts takeOrWait, the Solana path's cold-read wait) instead of answering 429.
test("the window full (5 of 5): a cold base holders read waits for the next free call and answers 200, within GT_PAGE_WAIT_MS", async () => {
  let t = NOW;
  calls = 0;
  const gecko = geckoBudget(() => t);
  gecko.seed(Array.from({ length: 5 }, () => NOW - WINDOW_MS + 2_000)); // all five leave the window 2 s from now
  const slept: number[] = [];
  const tok = createEvmToken("base", { lists: listsOf("base"), gecko, fetch: fake("base"), now: () => t, sleep: async (ms) => (slept.push(ms), (t += ms)) });
  const h = await tok.holders(CASES[0].addr);
  assert.equal(h.status, 200, h.body);
  assert.equal(JSON.parse(h.body).total, CASES[0].holders);
  assert.equal(calls, 1);
  const waited = slept.reduce((a, b) => a + b, 0);
  assert.ok(waited >= 2_000 && waited <= GT_PAGE_WAIT_MS, `waited ${waited} ms`);
});

test("the window full with its next free call past GT_PAGE_WAIT_MS: a cold holders read answers 429 with that wait, without waiting", async () => {
  let t = NOW;
  const gecko = geckoBudget(() => t);
  gecko.seed(Array.from({ length: 5 }, () => NOW - 1_000)); // the next free call 74 s away
  const slept: number[] = [];
  const tok = createEvmToken("base", { lists: listsOf("base"), gecko, fetch: fake("base"), now: () => t, sleep: async (ms) => (slept.push(ms), (t += ms)) });
  const h = await tok.holders(CASES[0].addr);
  assert.equal(h.status, 429, h.body);
  assert.ok((h.retryAfterS ?? 0) >= 70, `retry-after ${h.retryAfterS}`);
  assert.deepEqual(slept, []);
});
