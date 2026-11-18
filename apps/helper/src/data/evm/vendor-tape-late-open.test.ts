// node --test apps/helper/src/data/evm/vendor-tape-late-open.test.ts (card evm-vendor-tape-late-open-serves-held): a Base
// or Robinhood coin our reads find no pool of is served the vendor's rows and bars (swaps.ts noneTrades, noneCandles).
// Its pool search runs again NONE_MS (5 minutes) after the last, inside the open a page's read waits on; a search that
// outlasts the open's bound (OPEN_BOUND_MS, 8 s) or fails must still answer what the vendor's read holds. Red at
// 14ccd9d99: the tape past its bound answered our own book's rows, none, as `filling` (a local helper on mainnet served
// Robinhood fBOMB so at 8 s, held from the vendor, 18 Nov 15:19:55Z), a failed search answered 503, and a chart read
// before a time answered no bars while the vendor's bars for that time were held.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import * as rh from "../../../test/evm-swaps/robinhood.ts";
import * as base from "../../../test/evm-swaps/base.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { CG_ONCHAIN, coingeckoPace, createKeyed } from "../coingecko.ts";
import { geckoBudget } from "../gecko.ts";
import { providerHolds } from "../../limits/limits.ts";
import { GT_BASE } from "./lists.ts";
import { OPEN_BOUND_MS } from "./swaps.ts";

/** A planted key: never a real one. */
const KEY = ["CG", "planted", "evm", "late", "key"].join("-");
/** swaps.ts NONE_MS: a token with no pool read is looked for again after this. */
const NONE_MS = 300_000;
const T0 = Date.parse("2026-11-14T17:30:00Z");
const Q = Math.floor(T0 / 900_000) * 900;
/** The vendor's newest 15m bars, and its bars before OLD_TO (a chart scrolled back): none of the newest is before it. */
const OLD_TO = Q - 3_600;
const NEWEST = { data: { attributes: { ohlcv_list: [[Q - 900, 0.5, 0.6, 0.4, 0.55, 1000], [Q - 1_800, 0.45, 0.5, 0.4, 0.5, 900]] } } };
const OLDER = { data: { attributes: { ohlcv_list: [[OLD_TO - 900, 0.4, 0.5, 0.3, 0.45, 800], [OLD_TO - 1_800, 0.35, 0.4, 0.3, 0.4, 700], [OLD_TO - 2_700, 0.3, 0.35, 0.25, 0.35, 600]] } } };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
};

type Chain = "base" | "robinhood";
/** The recorded SOGNI vendor answer (fixtures/gt-pool-trades-sogni-base.json) and its receipts, served by CoinGecko's
 *  keyed API; a coin our reads find no pool of on `chain`. `search`: how each pool-search read is answered from now on
 *  ("held": it waits until `release`; "down": the provider's 503). */
function harness(chain: Chain) {
  const R = JSON.parse(readFileSync(new URL("./fixtures/gt-pool-trades-sogni-base.json", import.meta.url), "utf8")) as { coin: string; pool: string; trades: (Record<string, unknown> & { id: string; legs: { from: [string, string]; to: [string, string] } })[] };
  const receipts = (JSON.parse(readFileSync(new URL("./fixtures/vendor-rows-receipts.json", import.meta.url), "utf8")) as { sogni: Record<string, unknown> }).sogni;
  const answer = { data: R.trades.map(({ id, legs, ...a }) => ({ id, type: "trade", attributes: { ...a, from_token_address: legs.from[0], from_token_amount: legs.from[1], to_token_address: legs.to[0], to_token_amount: legs.to[1] } })) };
  const fake = chain === "robinhood" ? rh.fakeChain() : base.fakeChain();
  if (chain === "robinhood") fake.st.head = rh.REC.lastHead;
  const clock = { t: T0 };
  const st = { search: "open" as "open" | "held" | "down", asked: 0, release: () => undefined as void };
  let held: Promise<void> = Promise.resolve();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith(CG_ONCHAIN) || url.startsWith(GT_BASE)) {
      if (url.includes(`/tokens/${R.coin}/pools?page=1`)) return new Response(JSON.stringify({ data: [{ id: `${chain}_${R.pool}`, attributes: { address: R.pool } }] }), { status: 200 });
      if (url.includes(`/pools/${R.pool}/trades?token=${R.coin}`)) return new Response(JSON.stringify(answer), { status: 200 });
      if (url.includes(`/pools/${R.pool}/ohlcv/minute?aggregate=15`)) return new Response(JSON.stringify(url.includes(`before_timestamp=${OLD_TO}`) ? OLDER : NEWEST), { status: 200 });
      return new Response("{}", { status: 404 });
    }
    const reqs = JSON.parse(String(init.body ?? "null")) as { id: number; method: string; params: unknown[] }[];
    if (reqs.every((r) => r.method === "eth_getTransactionReceipt")) return new Response(JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: receipts[r.params[0] as string] ?? null }))), { status: 200 });
    // the pool search's reads
    if (st.search !== "open") st.asked++;
    if (st.search === "down") return new Response("down", { status: 503 });
    if (st.search === "held") await held;
    if (chain === "robinhood") return fake.fetch(url, init);
    // Base: the coin has no transfer and no venue record, its decimals 18 (base.ts's chain answers only its recorded pools)
    const own = (r: (typeof reqs)[number]) => {
      if (r.method === "eth_getLogs") return { jsonrpc: "2.0", id: r.id, result: [] };
      if ((r.params[0] as { data?: string }).data === "0x313ce567") return { jsonrpc: "2.0", id: r.id, result: `0x${(18).toString(16).padStart(64, "0")}` };
      return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } };
    };
    if (reqs.every((r) => r.method !== "eth_getBlockByNumber")) return new Response(JSON.stringify(reqs.map(own)), { status: 200 });
    return fake.fetch(url, init);
  };
  const env = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "300" };
  const holds = providerHolds(() => clock.t, coingeckoPace(env));
  const keyed = createKeyed(env, holds, { fetch: fetch as never })!;
  const gecko = geckoBudget(() => clock.t);
  // the deployed helper's keyless window full (vendor-tape-refresh-keyed.test.ts): every vendor read is the key's
  const fill = () => gecko.seed([clock.t - 1, clock.t - 1, clock.t - 1], "lists");
  fill();
  const over = { pools: new Map(), fetch: fetch as never, gecko, keyed, sleep: async (ms: number) => void (clock.t += ms), later: () => undefined };
  const s = chain === "robinhood" ? rh.open(fake as never, clock, over) : base.open(fake as never, clock, over);
  after(() => (st.release(), s.stop()));
  const hold = () => {
    st.search = "held";
    held = new Promise<void>((ok) => (st.release = ok));
  };
  const tape = async () => {
    const a = await s.trades(R.coin, 50);
    return { ...a, j: JSON.parse(a.body) as { trades: unknown[]; src: string; filling?: boolean } };
  };
  const chart = async (to: number | null) => {
    const a = await s.candles(R.coin, "15m", to, 500);
    return { ...a, j: JSON.parse(a.body) as { candles: number[][]; src: string; filling?: boolean } };
  };
  /** The page's reads every 10 s up to just short of NONE_MS after the first search, so the vendor's rows stay renewed. */
  const pollTo = async (end: number) => {
    while (clock.t + 10_000 < end) {
      clock.t += 10_000;
      fill();
      await settle();
      assert.equal((await tape()).j.trades.length, 6);
    }
  };
  return { clock, st, hold, tape, chart, pollTo, fill };
}

for (const chain of ["robinhood", "base"] as const) {
  test(`${chain}: a vendor-held tape whose NONE_MS pool search outlasts the open's bound is answered the held rows, never an empty filling tape (red: trades [] filling, src chain, at 8 s)`, async () => {
    const h = harness(chain);
    const first = await h.tape();
    assert.deepEqual([first.status, first.j.src, first.j.trades.length], [200, "coingecko", 6], first.body.slice(0, 160));
    await h.pollTo(T0 + NONE_MS);
    h.clock.t = T0 + NONE_MS + 1;
    h.fill();
    h.hold();
    const { value: a, ms } = await onVirtualTime(Date.now(), () => h.tape());
    assert.ok(h.st.asked > 0, "the pool search ran again and its reads were held");
    assert.ok(ms >= OPEN_BOUND_MS, `answered past the open's bound (${ms} ms)`);
    assert.equal(a.status, 200, a.body.slice(0, 160));
    assert.deepEqual([a.j.src, a.j.trades.length], ["coingecko", 6], `the held vendor rows, not ${a.body.slice(0, 160)}`);
    // the search ends with no pool: the coin's next read is the vendor's tape as before
    h.st.release();
    h.st.search = "open";
    await settle();
  });

  test(`${chain}: a vendor-held tape whose NONE_MS pool search fails is answered the held rows, never a 503 (red: 503 upstream)`, async () => {
    const h = harness(chain);
    assert.equal((await h.tape()).j.trades.length, 6);
    await h.pollTo(T0 + NONE_MS);
    h.clock.t = T0 + NONE_MS + 1;
    h.fill();
    h.st.search = "down";
    const { value } = await onVirtualTime(Date.now(), async () => [await h.tape(), await h.tape()]);
    assert.ok(h.st.asked > 0, "the pool search ran again");
    for (const a of value) {
      assert.equal(a.status, 200, a.body.slice(0, 160));
      assert.deepEqual([a.j.src, a.j.trades.length], ["coingecko", 6], a.body.slice(0, 160));
    }
  });

  test(`${chain}: vendor-held bars, the newest and a range before a time, are answered while the NONE_MS pool search outlasts the open's bound (red: the range before a time answered [] filling)`, async () => {
    const h = harness(chain);
    const newest = await h.chart(null);
    assert.deepEqual([newest.status, newest.j.src, newest.j.candles.length], [200, "coingecko", 2], newest.body.slice(0, 160));
    const older = await h.chart(OLD_TO);
    assert.deepEqual([older.status, older.j.src, older.j.candles.length], [200, "coingecko", 3], older.body.slice(0, 160));
    h.clock.t = T0 + NONE_MS + 1;
    h.hold();
    const { value } = await onVirtualTime(Date.now(), async () => [await h.chart(null), await h.chart(OLD_TO)]);
    assert.ok(h.st.asked > 0, "the pool search ran again and its reads were held");
    const [a, b] = value as [typeof newest, typeof newest];
    assert.deepEqual([a.status, a.j.src, a.j.candles.length], [200, "coingecko", 2], a.body.slice(0, 160));
    assert.deepEqual([b.status, b.j.src, b.j.candles.map((c) => c[0])], [200, "coingecko", [OLD_TO - 2_700, OLD_TO - 1_800, OLD_TO - 900]], `the held bars before ${OLD_TO}, not ${b.body.slice(0, 160)}`);
  });

  test(`${chain}: vendor-held bars whose NONE_MS pool search fails are answered, never a 503 (red: 503 upstream)`, async () => {
    const h = harness(chain);
    assert.equal((await h.chart(null)).j.candles.length, 2);
    assert.equal((await h.chart(OLD_TO)).j.candles.length, 3);
    h.clock.t = T0 + NONE_MS + 1;
    h.st.search = "down";
    const { value } = await onVirtualTime(Date.now(), async () => [await h.chart(null), await h.chart(OLD_TO)]);
    assert.ok(h.st.asked > 0, "the pool search ran again");
    assert.deepEqual(value.map((a) => [a.status, a.j.src, a.j.candles?.length]), [[200, "coingecko", 2], [200, "coingecko", 3]], value.map((a) => a.body.slice(0, 100)).join(" | "));
  });
}
