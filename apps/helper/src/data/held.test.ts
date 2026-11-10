// node --test apps/helper/src/data/held.test.ts: GET /v1/market/held, the batch read of the tokens a device holds
// (symbol, name, USD price) on Solana, Base and Robinhood (card market-token-reads), with fakes for the Solana token
// page, the chain's lists and DexScreener's tokens/v1. Red before held.ts exists: the module is missing and the route
// answers 404 for every request.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { HELPER_FETCHED_AT_HEADER, HELPER_SOURCE_HEADER } from "@blindfill/kit";
import { start } from "../server.ts";
import { geckoBudget } from "./gecko.ts";
import { createHeld, DEX_BASE, DEX_LIMITS, HELD_FRESH_MS, HELD_MAX, HELD_SERVE_MS, parseHeld } from "./held.ts";
import { upstreamBudget, type BudgetLimits } from "../limits/limits.ts";
import { createEvmToken } from "./evm/token.ts";
import { NOT_FOUND, UPSTREAM, type DataAnswer } from "./solana/token.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = Date.parse("2026-11-10T02:00:00Z");
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const A = "0x2df14792e7b9c5cc8e9a1eb37140533b32fb8d99";
const B = "0xe71b15267238c80ec51a16d389cdd00133162ad2";
const C = "0x000000000000000000000000000000000000dead";

/** The chain's lists answer: one row per token given. */
const listsOf = (chain: "base" | "robinhood", tokens: string[], status = 200) => ({
  get: async () => ({
    status,
    asOfMs: NOW - 5_000,
    body: JSON.stringify({ chain, as_of_ms: NOW - 5_000, lists: { new: tokens.map((token) => ({ chain, token, symbol: "LST", name: "Listed token", price_usd: "0.5", src: "geckoterminal" })) } }),
  }),
});
/** A DexScreener pair whose base token is `address` (tokens/v1's form, live read 2026-11-10 05:39Z). */
const pair = (address: string, extra: Record<string, unknown> = {}, base: Record<string, unknown> = {}) => ({
  chainId: "base",
  dexId: "uniswap",
  pairAddress: "0x0e635f8eeed4f7279d56692d552f034ece136019",
  baseToken: { address, name: "Dex name", symbol: "DXS", ...base },
  quoteToken: { address: "0x4200000000000000000000000000000000000006", name: "Wrapped Ether", symbol: "WETH" },
  priceUsd: "0.0123",
  liquidity: { usd: 1000 },
  ...extra,
});
type Hit = { url: string };
/** A fake fetch answering tokens/v1 with `answer`'s pairs, recording each call. */
function fakeFetch(hits: Hit[], answer: (addresses: string[], chainId: string) => unknown, status = 200) {
  return async (url: string): Promise<Response> => {
    hits.push({ url });
    const m = /\/tokens\/v1\/(\w+)\/([^/?]+)$/.exec(url);
    if (m === null) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify(answer(m[2]!.split(","), m[1]!)), { status });
  };
}
/** A DexScreener budget on `now` with these limits. */
const dexOf = (now: () => number, lim: BudgetLimits = DEX_LIMITS) => upstreamBudget(() => lim, now);
const solanaPage = (rows: Record<string, DataAnswer>) => ({
  page: async (mint: string): Promise<DataAnswer> => rows[mint] ?? NOT_FOUND,
});
const ok = (row: Record<string, unknown>): DataAnswer => ({ status: 200, body: JSON.stringify({ row }), src: "jupiter", asOfMs: NOW - 2_000 });
const held = (over: Partial<Parameters<typeof createHeld>[0]> & { hits?: Hit[]; answer?: (a: string[], chainId: string) => unknown; status?: number; now?: () => number } = {}) => {
  const hits = over.hits ?? [];
  return createHeld({
    solana: solanaPage({}),
    lists: { base: listsOf("base", []), robinhood: listsOf("robinhood", []) },
    fetch: fakeFetch(hits, over.answer ?? ((a, chainId) => a.map((x) => pair(x, { chainId }))), over.status),
    now: over.now ?? (() => NOW),
    sleep: async () => {},
    ...over,
  } as Parameters<typeof createHeld>[0]);
};
const body = async (a: DataAnswer) => JSON.parse(a.body) as { tokens: { token: string; symbol: string | null; name: string | null; price_usd: string | null; src: string }[]; as_of_ms: number };

test("solana: each mint through the token page, in order; a mint the page answers 404 for is an entry of nulls, never dropped", async () => {
  const h = held({ solana: solanaPage({ [MINT_A]: ok({ symbol: "SOL", name: "Wrapped SOL", price_usd: "150.25" }) }) });
  const a = await h.read("solana", [MINT_A, MINT_B]);
  assert.equal(a.status, 200);
  const j = await body(a);
  assert.deepEqual(j.tokens, [
    { token: MINT_A, symbol: "SOL", name: "Wrapped SOL", price_usd: "150.25", src: "jupiter" },
    { token: MINT_B, symbol: null, name: null, price_usd: null, src: "none" },
  ]);
  assert.equal(j.as_of_ms, NOW - 2_000);
});

test("solana: every page failing answers 503 upstream; a page answering 404 for all is a 200 of nulls", async () => {
  const bad = held({ solana: { page: async () => UPSTREAM } });
  assert.equal((await bad.read("solana", [MINT_A, MINT_B])).status, 503);
  const none = held();
  const a = await none.read("solana", [MINT_A]);
  assert.equal(a.status, 200);
  assert.equal((await body(a)).tokens[0]!.src, "none");
});

test("base: a token in the lists rows costs no call; the one not in them is one DexScreener tokens/v1 call naming only it; a second read within 60 s makes no call", async () => {
  const hits: Hit[] = [];
  let t = NOW;
  const h = held({ hits, now: () => t, lists: { base: listsOf("base", [A]), robinhood: listsOf("robinhood", []) } });
  const first = await body(await h.read("base", [A, B]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.url, `${DEX_BASE}/tokens/v1/base/${B}`);
  assert.deepEqual(first.tokens[0], { token: A, symbol: "LST", name: "Listed token", price_usd: "0.5", src: "geckoterminal" });
  assert.deepEqual(first.tokens[1], { token: B, symbol: "DXS", name: "Dex name", price_usd: "0.0123", src: "dexscreener" });
  t += HELD_FRESH_MS - 1;
  const again = await body(await h.read("base", [A, B]));
  assert.equal(hits.length, 1, "a refresh inside a minute makes no call");
  assert.deepEqual(again.tokens, first.tokens);
  t += 2;
  await h.read("base", [A, B]);
  assert.equal(hits.length, 2, "past a minute it is read again");
});

test("base: tokens asked in capitals are read by their lowercase address and answered as asked", async () => {
  const hits: Hit[] = [];
  const h = held({ hits });
  const asked = "0x2DF14792E7B9C5CC8E9A1EB37140533B32FB8D99";
  const j = await body(await h.read("base", [asked]));
  assert.equal(hits[0]!.url, `${DEX_BASE}/tokens/v1/base/${A}`);
  assert.equal(j.tokens[0]!.token, asked);
  assert.equal(j.tokens[0]!.symbol, "DXS");
});

test("base: a pair whose base token is another (or the asked token as its quote) leaves the entry null; a price '1e5' is refused; a 300-char name is bounded; a token DexScreener does not name stays null", async () => {
  const h = held({
    answer: () => [
      pair(C, {}, { name: "Impostor" }),
      { ...pair(C), quoteToken: { address: A, symbol: "QUO", name: "Quoted" } },
      pair(B, { priceUsd: "1e5" }, { name: "n".repeat(300), symbol: "s".repeat(100) }),
    ],
  });
  const j = await body(await h.read("base", [A, B]));
  assert.deepEqual(j.tokens[0], { token: A, symbol: null, name: null, price_usd: null, src: "none" });
  assert.equal(j.tokens[1]!.price_usd, null);
  assert.equal(j.tokens[1]!.name!.length, 64);
  assert.equal(j.tokens[1]!.symbol!.length, 32);
});

test("base: a price that is not a plain decimal is refused whatever its form", async () => {
  for (const price of ["-1", "NaN", "Infinity", "0x10", "1.", ".5", "1e-7", 5, null, "9".repeat(80)]) {
    const h = held({ answer: () => [pair(A, { priceUsd: price })] });
    const j = await body(await h.read("base", [A]));
    assert.equal(j.tokens[0]!.price_usd, null, String(price));
  }
});

test("robinhood: the call names DexScreener's robinhood chain and takes only its pairs; a budget that refuses leaves the entry null with a 200", async () => {
  const hits: Hit[] = [];
  const h = held({ hits, answer: (a, chainId) => [...a.map((x) => pair(x, { chainId: "base", priceUsd: "9" }, { symbol: "WRONG" })), ...a.map((x) => pair(x, { chainId }))] });
  const j = await body(await h.read("robinhood", [B]));
  assert.equal(hits[0]!.url, `${DEX_BASE}/tokens/v1/robinhood/${B}`);
  assert.equal(j.tokens[0]!.symbol, "DXS", "a pair of another chain is not this chain's");

  const hits2: Hit[] = [];
  const refused = held({ hits: hits2, dex: dexOf(() => NOW, { total: 0, perClient: 0, windowMs: 60_000 }) });
  const a = await refused.read("robinhood", [B]);
  assert.equal(a.status, 200);
  assert.deepEqual((await body(a)).tokens, [{ token: B, symbol: null, name: null, price_usd: null, src: "none" }]);
  assert.equal(hits2.length, 0);
});

test("base: of the pairs naming a token, the deepest liquidity's price is taken", async () => {
  const h = held({ answer: () => [pair(A, { priceUsd: "5", liquidity: { usd: 10 } }), pair(A, { priceUsd: "1.0001", liquidity: { usd: 9_000_000 } }), pair(A, { priceUsd: "7", liquidity: { usd: "1e99" } })] });
  assert.equal((await body(await h.read("base", [A]))).tokens[0]!.price_usd, "1.0001");
});

test("base: DexScreener's 429 holds its budget for the wait it names; the next read makes no call", async () => {
  let t = NOW;
  const hits: Hit[] = [];
  const h = held({ hits, now: () => t, status: 429, dex: dexOf(() => t) });
  assert.equal((await h.read("base", [A])).status, 200);
  t += 1_000;
  await h.read("base", [B]);
  assert.equal(hits.length, 1, "held for DEX_LIMITS.windowMs with no Retry-After");
  t += DEX_LIMITS.windowMs!;
  await h.read("base", [B]);
  assert.equal(hits.length, 2, "read again once the hold ends");
});

test("base: a failed call with nothing else named answers 503 upstream; with another token named from the lists it is a 200", async () => {
  const bad = held({ status: 500 });
  assert.equal((await bad.read("base", [B])).status, 503);
  const mixed = held({ status: 500, lists: { base: listsOf("base", [A]), robinhood: listsOf("robinhood", []) } });
  const a = await mixed.read("base", [A, B]);
  assert.equal(a.status, 200);
  assert.equal((await body(a)).tokens[1]!.src, "none");
});

test("base: the lists never having answered sends every token to the one DexScreener call", async () => {
  const hits: Hit[] = [];
  const h = held({ hits, lists: { base: listsOf("base", [A], 503), robinhood: listsOf("robinhood", []) } });
  await h.read("base", [A, B]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.url, `${DEX_BASE}/tokens/v1/base/${A},${B}`);
});

test("base: a lists row of another chain, a row with a hostile symbol and an oversize answer name nothing", async () => {
  const lists = {
    get: async () => ({ status: 200, asOfMs: NOW, body: JSON.stringify({ lists: { new: [{ chain: "robinhood", token: A, symbol: "X", name: "Y", price_usd: "1" }] } }) }),
  };
  const hits: Hit[] = [];
  const h = held({ hits, lists: { base: lists, robinhood: listsOf("robinhood", []) } });
  await h.read("base", [A]);
  assert.equal(hits.length, 1, "a row of another chain is not this chain's");
});

test("parseHeld: one chain of the three, 1 to HELD_MAX distinct tokens in the chain's form, nothing else", () => {
  const q = (s: string) => new URL(`http://x/v1/market/held?${s}`).searchParams;
  assert.deepEqual(parseHeld(q(`chain=solana&token=${MINT_A}&token=${MINT_B}`)), { chain: "solana", tokens: [MINT_A, MINT_B] });
  assert.deepEqual(parseHeld(q(`chain=base&token=${A}`)), { chain: "base", tokens: [A] });
  assert.deepEqual(parseHeld(q(`chain=robinhood&token=${A}`)), { chain: "robinhood", tokens: [A] });
  const many = (n: number) => Array.from({ length: n }, (_, i) => `token=0x${i.toString(16).padStart(40, "0")}`).join("&");
  assert.notEqual(parseHeld(q(`chain=base&${many(HELD_MAX)}`)), null);
  for (const bad of [
    `chain=near&token=${A}`,
    `chain=base`,
    `token=${A}`,
    `chain=base&chain=base&token=${A}`,
    `chain=base&${many(HELD_MAX + 1)}`,
    `chain=base&token=${A}&token=${A}`,
    `chain=base&token=${A}&token=${A.toUpperCase().replace("0X", "0x")}`,
    `chain=base&token=0x12`,
    `chain=base&token=${MINT_A}`,
    `chain=solana&token=${A}`,
    `chain=solana&token=${MINT_A}&token=${MINT_A}`,
    `chain=base&token=${A}&extra=1`,
    `chain=base&token=`,
  ]) assert.equal(parseHeld(q(bad)), null, bad);
  assert.equal(HELD_MAX, 30);
});

// the route, on a real server on a free port
function get(port: number, path: string, method = "GET"): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((done, fail) => {
    const r = request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail);
    r.end();
  });
}
test("server: /v1/market/held is mounted; a bad request answers 404 with no read, a good one the shape", async () => {
  let reads = 0;
  const counting = held({ solana: { page: async (m: string) => (reads++, ok({ symbol: "SOL", name: "Wrapped SOL", price_usd: "150.25" })) } });
  const spy = {
    ...counting,
    read: (...a: Parameters<typeof counting.read>) => (reads++, counting.read(...a)),
  };
  const s = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, spy);
  await new Promise<void>((done) => s.on("listening", () => done()));
  const port = (s.address() as AddressInfo).port;
  try {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `token=0x${i.toString(16).padStart(40, "0")}`).join("&");
    for (const bad of [
      `chain=near&token=${A}`,
      `chain=base`,
      `chain=base&${many(31)}`,
      `chain=base&token=${A}&token=${A}`,
      `chain=base&token=0xnope`,
      `chain=base&token=${A}&extra=1`,
    ]) {
      const r = await get(port, `/v1/market/held?${bad}`);
      assert.equal(r.status, 404, bad);
      assert.deepEqual(JSON.parse(r.text), { error: { code: "not_found" } });
    }
    assert.equal(reads, 0, "no read for a bad request");
    const r = await get(port, `/v1/market/held?chain=solana&token=${MINT_A}`);
    assert.equal(r.status, 200, r.text);
    const j = JSON.parse(r.text) as { tokens: unknown[]; as_of_ms: number };
    assert.deepEqual(j.tokens, [{ token: MINT_A, symbol: "SOL", name: "Wrapped SOL", price_usd: "150.25", src: "jupiter" }]);
    assert.equal(typeof j.as_of_ms, "number");
    assert.equal(r.headers[HELPER_SOURCE_HEADER.toLowerCase()], "jupiter");
    assert.equal(r.headers[HELPER_FETCHED_AT_HEADER.toLowerCase()], new Date(NOW - 2_000).toISOString());
    assert.match(String(r.headers["server-timing"]), /total;dur=/);
    assert.equal((await get(port, `/v1/market/held?chain=solana&token=${MINT_A}`, "POST")).status, 405);
  } finally {
    await new Promise<void>((done) => (s.closeAllConnections(), s.close(() => done())));
  }
});

test("server: without a held reader the route answers 404", async () => {
  const s = start(COMMIT, 0);
  await new Promise<void>((done) => s.on("listening", () => done()));
  try {
    assert.equal((await get((s.address() as AddressInfo).port, `/v1/market/held?chain=solana&token=${MINT_A}`)).status, 404);
  } finally {
    await new Promise<void>((done) => (s.closeAllConnections(), s.close(() => done())));
  }
});

// Card market-token-reads (abuse): a stranger sending 30 fresh random addresses on every call. The held read takes no
// GeckoTerminal call (its 5 calls in 75 s are the token page's and the charts'); on DexScreener's budget the stranger
// draws only its share, so another device's held read still makes its call, and a user whose held token was named
// keeps it while the stranger runs. Compared with GET /v1/market/token, which reads nothing for an address no list holds.
test("abuse: a stranger's held reads of random addresses take no GeckoTerminal call and only their own DexScreener share; another device still reads; a named token stays named", async () => {
  let t = NOW;
  const clock = () => t;
  const gecko = geckoBudget(clock);
  const hits: Hit[] = [];
  const h = held({ hits, now: clock, dex: dexOf(clock), gecko } as never);
  const USER = "203.0.113.9";
  const STRANGER = "198.51.100.66";
  // a user's off-list Base token, named once before the stranger starts
  assert.equal((await body(await h.read("base", [A], USER))).tokens[0]!.symbol, "DXS");
  const rand = () => `0x${Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")}`;
  const before = hits.length;
  for (let i = 0; i < 40; i++) {
    await h.read(i % 2 === 0 ? "base" : "robinhood", Array.from({ length: HELD_MAX }, rand), STRANGER);
    t += 200;
  }
  const strangerCalls = hits.length - before;
  // past HELD_FRESH_MS the user's token is read again: its own call, with the stranger's share spent
  t += HELD_FRESH_MS;
  const user = (await body(await h.read("base", [A], USER))).tokens[0]!;
  const other = (await body(await h.read("base", [B], "192.0.2.1"))).tokens[0]!;
  console.log(`stranger: 40 reads in 8 s, ${strangerCalls} DexScreener calls (share ${DEX_LIMITS.perClient} a 10 s); GeckoTerminal window ${gecko.calls().length} of 5; user's token ${user.symbol}, another device's ${other.symbol}`);
  assert.ok(strangerCalls <= DEX_LIMITS.perClient, `the stranger made ${strangerCalls} calls, its share is ${DEX_LIMITS.perClient}`);
  assert.equal(gecko.calls().length, 0, "no GeckoTerminal call");
  assert.equal(user.symbol, "DXS", "the user's named token is read again while the stranger runs");
  assert.equal(other.symbol, "DXS", "another device's first read makes its call");
  assert.ok(hits.every((x) => x.url.startsWith(`${DEX_BASE}/tokens/v1/`)));

  // GET /v1/market/token today: an address no list holds is 404 with no GeckoTerminal call
  const evmHits: Hit[] = [];
  const page2 = createEvmToken("base", { lists: { get: listsOf("base", []).get, listed: async () => false }, gecko: geckoBudget(clock), fetch: fakeFetch(evmHits, () => []) as never, now: clock, sleep: async () => {} });
  for (let i = 0; i < 30; i++) assert.equal((await page2.page(rand())).status, 404);
  assert.equal(evmHits.length, 0);
});

test("a name read within HELD_SERVE_MS is served, dated, while the budget refuses; past it the entry is null", async () => {
  let t = NOW;
  const clock = () => t;
  // one call in the hour: the first read takes it, every later one is refused
  const h = held({ now: clock, dex: dexOf(clock, { total: 1, perClient: 1, windowMs: 3_600_000 }) });
  assert.equal((await body(await h.read("base", [A]))).tokens[0]!.symbol, "DXS");
  t += 2 * HELD_FRESH_MS;
  const j = await body(await h.read("base", [A]));
  assert.equal(j.tokens[0]!.symbol, "DXS");
  assert.equal(j.as_of_ms, NOW, "dated by its read");
  t = NOW + HELD_SERVE_MS + 1;
  assert.equal((await body(await h.read("base", [A]))).tokens[0]!.symbol, null);
});
