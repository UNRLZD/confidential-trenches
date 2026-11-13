// node --test apps/helper/src/candles-keyed-gt.test.ts (card helper-candles-keyed-gt): with COINGECKO_API_KEY set, every
// chart read (a Solana token's top pool and bars, an EVM token's GeckoTerminal pool and bars) asks CoinGecko's keyed
// on-chain API first, within its per-minute and day budget; refused (401, 429, 5xx, a timeout, its budget) the read goes
// to the keyless GeckoTerminal path as main has it; with no key, main's reads exactly; and the key is only ever in the
// request header to CoinGecko, never in a log, an answer or a header we send back. Red at b1b679c42 (main, card
// chart-candles-never-429): no keyed read exists (data/coingecko.ts is missing), every chart read is GeckoTerminal's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { CG_DAY, CG_ONCHAIN, CG_URL, coingeckoPace, createKeyed } from "./data/coingecko.ts";
import { geckoBudget } from "./data/gecko.ts";
import { createSolanaToken, GT_BASE } from "./data/solana/token.ts";
import { providerHolds } from "./limits/limits.ts";
import { handler } from "./server.ts";
import { fakeChain, open, REC } from "../test/evm-swaps/robinhood.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
const FX = JSON.parse(readFileSync(new URL("./data/solana/fixtures/token-page.json", import.meta.url), "utf8"));
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
/** A planted key: never a real one (the tests search every string we log or answer for it). */
const KEY = ["CG", "planted", "test", "key", "only"].join("-");
const ENV = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "300" };
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const unused = { async handle(): Promise<never> { throw new Error("no chain or Jupiter read in a chart") } };

type Call = { url: string; headers: Record<string, string> };
/** A vendor double: CoinGecko answers `cg(url)` (a Response, or a thrown error), GeckoTerminal answers the fixtures. */
function vendors(cg: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    if (url.startsWith(CG_ONCHAIN)) return cg(url, init);
    if (!url.startsWith(GT_BASE)) throw new Error(`unexpected ${url}`);
    return json(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token);
  };
  return { calls, fetch, cgCalls: () => calls.filter((c) => c.url.startsWith(CG_ONCHAIN)), gtCalls: () => calls.filter((c) => c.url.startsWith(GT_BASE)) };
}
function solana(env: Record<string, string>, v: ReturnType<typeof vendors>, t = { t: Date.parse("2026-11-13T11:00:00Z") }) {
  const holds = providerHolds(() => t.t, coingeckoPace(env));
  const keyed = createKeyed(env, holds, { fetch: v.fetch as never });
  const token = createSolanaToken(unused as never, unused as never, { now: () => t.t, sleep: async (ms: number) => void (t.t += ms), fetch: v.fetch as never, gecko: geckoBudget(() => t.t), keyed });
  return { token, keyed, holds, t };
}

const servers: ReturnType<typeof createServer>[] = [];
after(() => Promise.all(servers.map((s) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))))).then(() => undefined));
async function listen(h: ReturnType<typeof handler>): Promise<number> {
  const s = createServer(h);
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  return (s.address() as AddressInfo).port;
}
function get(port: number, path: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { origin: APP, "x-forwarded-for": "198.18.9.1" } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", fail).end();
  });
}

test("the pace: the key's rate less a tenth, a tenth of it at once and never past it in any 60 s; the day the month's 100,000 over 31; no key, no pace", () => {
  const p = coingeckoPace(ENV)[CG_URL]!;
  assert.equal(CG_DAY, 3_225);
  assert.deepEqual({ ...p, perS: Math.round(p.perS * 60) }, { perS: 243, burst: 27, unit: "call", group: "coingecko", day: CG_DAY });
  assert.ok(p.burst + p.perS * 60 <= 270 + 1e-9, "at most 270 calls in any 60 s");
  assert.deepEqual(coingeckoPace({}), {});
  assert.deepEqual(coingeckoPace({ COINGECKO_API_KEY: "" }), {});
  assert.throws(() => coingeckoPace({ COINGECKO_API_KEY: KEY }), /^Error: COINGECKO_CALLS_PER_MIN /);
  assert.throws(() => coingeckoPace({ COINGECKO_API_KEY: "short", COINGECKO_CALLS_PER_MIN: "300" }), (e: Error) => /^COINGECKO_API_KEY is not an API key/.test(e.message) && !e.message.includes("short"));
  assert.throws(() => coingeckoPace({ COINGECKO_API_KEY: `${KEY} x`, COINGECKO_CALLS_PER_MIN: "300" }), (e: Error) => !e.message.includes(KEY));
  assert.equal(createKeyed({}, providerHolds(Date.now, {})), null, "no key: no keyed reads");
});

test("Solana, keyed: a cold chart's top pool and bars are CoinGecko's, the key in the header alone, src coingecko, no GeckoTerminal call", async () => {
  const v = vendors((url) => json(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token));
  const { token } = solana(ENV, v);
  const a = await token.candles(BONK, "1m", null, 500);
  assert.equal(a.status, 200, a.body);
  const b = JSON.parse(a.body);
  assert.deepEqual([b.src, a.src], ["coingecko", "coingecko"]);
  assert.ok(b.candles.length > 0);
  assert.equal(v.gtCalls().length, 0, "no keyless call");
  assert.deepEqual(v.cgCalls().map((c) => c.url.replace(/pools\/\w+/, "pools/<pool>")), [`${CG_ONCHAIN}/networks/solana/tokens/${BONK}`, `${CG_ONCHAIN}/networks/solana/pools/<pool>/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${BONK}`]);
  for (const c of v.cgCalls()) {
    assert.equal(c.headers["x-cg-pro-api-key"], KEY);
    assert.ok(!c.url.includes(KEY), "never in the URL");
  }
  // a history range the kept bars cover is served from them, named by their source
  const first = b.candles[0][0] as number;
  const h = await token.candles(BONK, "1m", first + 600, 5);
  assert.equal(JSON.parse(h.body).src, "coingecko");
  assert.equal(v.cgCalls().length, 2, "no call for history held");
});

for (const [name, cg] of [
  ["401 (the key refused)", () => json({ status: { error_code: 401 } }, 401)],
  ["403", () => json({}, 403)],
  ["429 (CoinGecko's own limit)", () => json({}, 429, { "retry-after": "20" })],
  ["500", () => json({}, 500)],
  ["503", () => json({}, 503)],
  ["a timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
  ["a failed connection", () => Promise.reject(new TypeError("fetch failed"))],
  ["a 200 that is not the shape we read", () => json({ data: { attributes: {} } })],
  ["a 200 that is not JSON", () => new Response("<html>", { status: 200 })],
] as [string, () => Response | Promise<Response>][]) {
  test(`Solana, keyed answers ${name}: the chart falls back to GeckoTerminal keyless as main reads it, src geckoterminal`, async () => {
    const v = vendors(cg);
    const { token } = solana(ENV, v);
    const a = await token.candles(BONK, "15m", null, 500);
    assert.equal(a.status, 200, a.body);
    assert.equal(JSON.parse(a.body).src, "geckoterminal");
    assert.deepEqual(v.gtCalls().map((c) => c.url.replace(/pools\/\w+/, "pools/<pool>")), [`${GT_BASE}/networks/solana/tokens/${BONK}`, `${GT_BASE}/networks/solana/pools/<pool>/ohlcv/minute?aggregate=15&limit=1000&currency=usd&token=${BONK}`]);
    assert.ok(v.gtCalls().every((c) => c.headers["x-cg-pro-api-key"] === undefined), "the key never goes to GeckoTerminal");
    // CoinGecko asked first: a refusal holds it (the bars' read then goes keyless at once), a bad answer does not
    assert.equal(v.cgCalls().length, name.startsWith("a 200") ? 2 : 1, "CoinGecko asked first");
  });
}

test("Solana, keyed refused 401 / 429 / 5xx: CoinGecko is not asked again while it holds, so a cold chart waits on no dead read", async () => {
  for (const [cg, holdS] of [[() => json({}, 401), 75], [() => json({}, 429, { "retry-after": "20" }), 20], [() => json({}, 502), 30]] as [() => Response, number][]) {
    const v = vendors(cg);
    const { token, holds, t } = solana(ENV, v);
    await token.candles(BONK, "15m", null, 500);
    const asked = v.cgCalls().length;
    assert.equal(asked, 1, "the first read refused, the next of the same chart read keyless");
    assert.equal(Math.round(holds.heldMs(CG_URL) / 1000), holdS);
    await token.candles(DOGE, "15m", null, 500);
    assert.equal(v.cgCalls().length, asked, "held: no keyed call");
    t.t += holdS * 1000 + 1;
    await token.candles(WIF, "15m", null, 500);
    assert.ok(v.cgCalls().length > asked, "the hold over, asked again");
  }
});
const DOGE = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

test("Solana, keyed budget: past its minute the read goes keyless at once; past its day, keyless until the next UTC day", async () => {
  const v = vendors((url) => json(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token));
  const env = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "2" };
  const { keyed, t } = solana(env, v);
  // a rate of 2: one call at once, then one a minute
  const ok = () => true;
  assert.notEqual(await keyed!.read("/networks/solana/tokens/x", ok), undefined);
  assert.equal(await keyed!.read("/networks/solana/tokens/y", ok), undefined, "the minute spent");
  assert.equal(v.cgCalls().length, 1);
  assert.match(keyed!.minute()!, /^coingecko calls: minute 1, served 1$/);
  // the day: CG_DAY less the identity reads' share (limits.ts PROBE_DAY_SHARE), across the day's minutes
  const day = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "100000" };
  const s = solana(day, v, { t: Date.parse("2026-11-13T00:00:00Z") });
  let served = 0;
  for (let i = 0; i < CG_DAY + 10; i++, s.t.t += 1_000) if ((await s.keyed!.read(`/n/${i}`, ok)) !== undefined) served++;
  assert.ok(served < CG_DAY && served >= CG_DAY - Math.ceil(CG_DAY * 0.01) - 1, `${served} served in the day`);
  assert.equal(await s.keyed!.read("/n/more", ok), undefined, "the day spent");
  // 3,225 less the identity reads' 1% (32): 3,193 served, and the 43 past them refused by the day
  assert.equal(s.keyed!.minute(), "coingecko calls: day 43, served 3193");
  s.t.t = Date.parse("2026-11-14T00:00:01Z");
  assert.notEqual(await s.keyed!.read("/n/next-day", ok), undefined, "the next UTC day reads keyed again");
  void t;
});

test("no key set: the chart's reads are main's, call for call and byte for byte", async () => {
  const at = { t: Date.parse("2026-11-13T11:00:00Z") };
  const runs: { calls: Call[]; body: string }[] = [];
  for (const withDep of [false, true]) {
    const v = vendors(() => assert.fail("CoinGecko asked with no key"));
    const t = { t: at.t };
    const deps = { now: () => t.t, sleep: async (ms: number) => void (t.t += ms), fetch: v.fetch as never, gecko: geckoBudget(() => t.t) };
    const token = createSolanaToken(unused as never, unused as never, withDep ? { ...deps, keyed: createKeyed({}, providerHolds(() => t.t, coingeckoPace({})), { fetch: v.fetch as never }) } : deps);
    const a = await token.candles(BONK, "15m", null, 500);
    runs.push({ calls: v.calls, body: a.body });
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.equal(JSON.parse(runs[0]!.body).src, "geckoterminal");
});

test("EVM (Robinhood's reads, as Base's): a listed token with no pool of ours charts CoinGecko's pool and bars first, src coingecko; refused, GeckoTerminal's as main", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const clock = { t: Date.parse("2026-11-02T13:53:00Z") };
  const POOL = `0x${"ab".repeat(32)}`;
  for (const up of [true, false]) {
    const urls: Call[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      if (!url.startsWith(CG_ONCHAIN) && !url.startsWith(GT_BASE)) return chain.fetch(url, init);
      urls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      if (url.startsWith(CG_ONCHAIN) && !up) return json({}, 429);
      if (url.includes("/pools?page=1")) return json({ data: [{ attributes: { address: POOL } }] });
      return json(FX.gt_ohlcv);
    };
    const keyed = createKeyed(ENV, providerHolds(() => clock.t, coingeckoPace(ENV)), { fetch: fetch as never });
    const s = open(chain, clock, { pools: new Map(), fetch: fetch as never, gecko: geckoBudget(() => clock.t), keyed });
    const token = `0x${"34".repeat(20)}`;
    const a = await s.candles(token, "1m", null, 60);
    assert.equal(a.status, 200, a.body);
    const c = JSON.parse(a.body);
    assert.equal(c.src, up ? "coingecko" : "geckoterminal");
    assert.ok(c.candles.length > 0);
    const shape = urls.map((u) => `${u.url.startsWith(CG_ONCHAIN) ? "cg" : "gt"} ${u.url.replace(/^https:\/\/[^/]+\/api\/v[23](\/onchain)?/, "")}`);
    const pools = `/networks/robinhood/tokens/${token}/pools?page=1`;
    const bars = `/networks/robinhood/pools/${POOL}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${token}`;
    assert.deepEqual(shape, up ? [`cg ${pools}`, `cg ${bars}`] : [`cg ${pools}`, `gt ${pools}`, `gt ${bars}`]);
    for (const u of urls) assert.equal(u.headers["x-cg-pro-api-key"], u.url.startsWith(CG_ONCHAIN) ? KEY : undefined);
    s.stop();
  }
});

test("the key never leaves the request header: planted, it is in no log line, refusal, error, answer body or header we send back", async () => {
  const logged: string[] = [];
  const keep = (...a: unknown[]) => void logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  const was = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  Object.assign(console, { log: keep, error: keep, warn: keep, info: keep });
  process.stderr.write = ((c: string | Uint8Array) => (logged.push(String(c)), true)) as never;
  try {
    // every way the keyed read can end: served, each refusal, a timeout, an answer echoing the key back
    let n = 0;
    const answers = [
      (url: string) => json(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token),
      () => json({ status: { error_code: 401, error_message: `bad key ${KEY}` } }, 401),
      () => json({ echo: KEY }, 429, { "retry-after": "1" }),
      () => Promise.reject(Object.assign(new DOMException(`timeout ${KEY}`, "TimeoutError"))),
      () => json({ data: { attributes: { ohlcv_list: KEY } } }),
      () => new Response(`not json ${KEY}`, { status: 200 }),
    ];
    const answered: string[] = [];
    for (const cg of answers) {
      const v = vendors((url) => cg(url));
      const { token, keyed, t } = solana(ENV, v);
      const port = await listen(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, token));
      for (const tf of ["1m", "15m", "1h"]) {
        const a = await get(port, `/v1/market/candles?chain=solana&token=${BONK}&tf=${tf}&limit=500`);
        answered.push(a.body, JSON.stringify(a.headers));
        t.t += 61_000;
      }
      answered.push(keyed!.minute() ?? "");
      for (const c of v.calls) assert.ok(!c.url.includes(KEY), "never in a URL");
      n += v.cgCalls().length;
    }
    assert.ok(n >= answers.length, "CoinGecko was asked in every case");
    const all = [...logged, ...answered];
    assert.ok(all.length > 0);
    for (const s of all) assert.ok(!s.includes(KEY) && !s.includes(KEY.slice(3, 19)), `the key in: ${s.slice(0, 200)}`);
  } finally {
    Object.assign(console, was);
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
});
