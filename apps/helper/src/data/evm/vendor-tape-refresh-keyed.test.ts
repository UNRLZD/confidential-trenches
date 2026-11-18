// node --test apps/helper/src/data/evm/vendor-tape-refresh-keyed.test.ts (card evm-vendor-tape-refresh-keyed): a Base
// or Robinhood coin whose tape is the vendor's rows (swaps.ts noneTrades) is read again inside BEHIND_MAX's ms (15 s,
// the age its answer names in evm-vendor-read) while a page holds it, even with GeckoTerminal's keyless window full, as
// a Solana one is (card sol-vendor-tape-refresh-lands, ../solana/tape-refresh-lands.test.ts). Red at 4ff5ffb9a: a held
// tape's refresh went keyless only, and the deployed helper's keyless window had no room for it (its minute lines 18 Nov
// 12:56-13:48Z stood at 3 of 5, the refresh lane's cap, and no keyless Solana "trades" call was made in 52 minutes), so
// its rows aged without bound.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { CG_BACKGROUND_TIMEOUT_MS, CG_ONCHAIN, CG_TIMEOUT_MS, coingeckoPace, createKeyed } from "../coingecko.ts";
import { geckoBudget } from "../gecko.ts";
import { providerHolds } from "../../limits/limits.ts";
import { TAPE_FRESH_MS } from "../solana/token.ts";
import { GT_BASE } from "./lists.ts";
import { BEHIND_MAX, STALE_MS } from "./swaps.ts";

/** A planted key: never a real one. */
const KEY = ["CG", "planted", "evm", "tape", "key"].join("-");
const VENDOR_READ = /(?:^|,)\s*evm-vendor-read;desc="rows read (\d+) ms ago"/;
const BOUND = BEHIND_MAX.robinhood.ms;
/** The event loop's turns between two page reads (2 s apart): a refresh behind the held rows lands in them. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
};

/** The recorded SOGNI vendor answer (fixtures/gt-pool-trades-sogni-base.json) served by CoinGecko's keyed API and by
 *  GeckoTerminal's keyless one alike, its receipts as recorded; OTHER, a second coin our reads find no pool of. */
function harness(perMin = "300") {
  const R = JSON.parse(readFileSync(new URL("./fixtures/gt-pool-trades-sogni-base.json", import.meta.url), "utf8")) as { coin: string; pool: string; trades: (Record<string, unknown> & { id: string; legs: { from: [string, string]; to: [string, string] } })[] };
  const receipts = (JSON.parse(readFileSync(new URL("./fixtures/vendor-rows-receipts.json", import.meta.url), "utf8")) as { sogni: Record<string, unknown> }).sogni;
  const answer = { data: R.trades.map(({ id, legs, ...a }) => ({ id, type: "trade", attributes: { ...a, from_token_address: legs.from[0], from_token_amount: legs.from[1], to_token_address: legs.to[0], to_token_amount: legs.to[1] } })) };
  const OTHER = "0x00000000000000000000000000000000000000c0";
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const clock = { t: Date.parse("2026-11-14T17:30:00Z") };
  const calls: string[] = [];
  let cgSeen: (signal: AbortSignal | undefined) => void = () => undefined;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const vendor = url.startsWith(CG_ONCHAIN) ? CG_ONCHAIN : url.startsWith(GT_BASE) ? GT_BASE : null;
    if (vendor !== null) {
      calls.push(url);
      if (vendor === CG_ONCHAIN) cgSeen(init.signal ?? undefined);
      for (const coin of [R.coin, OTHER]) {
        if (url.includes(`/tokens/${coin}/pools?page=1`)) return new Response(JSON.stringify({ data: [{ id: `robinhood_${R.pool}`, attributes: { address: R.pool } }] }), { status: 200 });
        if (url.includes(`/pools/${R.pool}/trades?token=${coin}`)) return new Response(JSON.stringify(answer), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }
    const reqs = JSON.parse(String(init.body ?? "null")) as { id: number; method: string; params: unknown[] }[] | null;
    if (!Array.isArray(reqs) || !reqs.every((r) => r.method === "eth_getTransactionReceipt")) return chain.fetch(url, init);
    return new Response(JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: receipts[r.params[0] as string] ?? null }))), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: perMin };
  const holds = providerHolds(() => clock.t, coingeckoPace(env));
  const keyed = createKeyed(env, holds, { fetch: fetch as never })!;
  const gecko = geckoBudget(() => clock.t);
  // the deployed helper's keyless window: the lists' two calls and the ahead lane's one, renewed as they leave it
  const fill = () => gecko.seed([clock.t - 1, clock.t - 1, clock.t - 1], "lists");
  fill();
  const s = open(chain, clock, { pools: new Map(), fetch: fetch as never, gecko, keyed, sleep: async (ms: number) => void (clock.t += ms) });
  after(() => s.stop());
  const cg = (kind: string) => calls.filter((u) => u.startsWith(CG_ONCHAIN) && u.includes(kind)).length;
  const gt = (kind: string) => calls.filter((u) => u.startsWith(GT_BASE) && u.includes(kind)).length;
  const tape = async (coin = R.coin) => {
    const a = await s.trades(coin, 50);
    const named = VENDOR_READ.exec(a.timing ?? "")?.[1];
    return { ...a, j: JSON.parse(a.body) as { trades: unknown[]; src: string; as_of_ms: number; whole_ms?: number }, age: named === undefined ? NaN : Number(named) };
  };
  return { clock, coin: R.coin, OTHER, keyed, fill, cg, gt, tape, onCg: (f: typeof cgSeen) => void (cgSeen = f) };
}

test("a held vendor tape read every 2 s for 5 minutes, GeckoTerminal's keyless window full: every answer names its rows read inside BEHIND_MAX's ms (red: the refresh went keyless only and was refused, the rows aged to 5 minutes)", async () => {
  const h = harness();
  // the timeout each keyed read is sent with (the signal made just before its fetch): a page's cold read
  // CG_TIMEOUT_MS, a refresh behind held rows CG_BACKGROUND_TIMEOUT_MS
  const signals = new WeakMap<AbortSignal, number>();
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    const s = timeout.call(AbortSignal, ms);
    signals.set(s, ms);
    return s;
  };
  after(() => void (AbortSignal.timeout = timeout));
  const timeouts: number[] = [];
  h.onCg((signal) => timeouts.push(signal === undefined ? -1 : (signals.get(signal) ?? -1)));
  const first = await h.tape();
  assert.equal(first.status, 200, first.body.slice(0, 120));
  assert.equal(first.j.src, "coingecko", "a cold tape is the key's, as before");
  assert.equal(first.j.trades.length, 6);
  const ages: number[] = [];
  for (const end = h.clock.t + 300_000; h.clock.t < end; ) {
    h.clock.t += 2_000;
    h.fill();
    await settle();
    const a = await h.tape();
    assert.equal(a.status, 200);
    assert.equal(a.j.trades.length, 6, "the held rows are served while the refresh runs behind them");
    ages.push(a.age);
  }
  const max = Math.max(...ages);
  assert.ok(ages.every(Number.isFinite), "every answer names its rows' age");
  assert.ok(max <= BOUND, `oldest rows served ${max} ms after their read (bound ${BOUND}): ${ages.join(",")}`);
  // one keyed trades read a TAPE_FRESH_MS (plus the poll that crossed it), never one a poll
  const n = h.cg("/trades");
  assert.ok(n >= 25 && n <= 31, `${n} keyed trades reads in 5 minutes`);
  assert.equal(h.gt("/trades"), 0, "no keyless call: the window was full");
  // the refreshes draw the key as the helper's background (limits.ts CALLER_DAY_ROOM), named so in the minute line
  assert.match(h.keyed.minute() ?? "", /served trades background \d+/);
  AbortSignal.timeout = timeout;
  assert.deepEqual([...new Set(timeouts.slice(0, 2))], [CG_TIMEOUT_MS], "the cold read's top pool and trades wait as a caller's");
  assert.deepEqual([...new Set(timeouts.slice(2))], [CG_BACKGROUND_TIMEOUT_MS], "every refresh is a background read");
});

test("a held tape's answer never waits on its refresh: the read past TAPE_FRESH_MS is served the held rows at once and the refresh lands behind them; one refresh at a time however many callers", async () => {
  const h = harness();
  const read0 = h.clock.t;
  await h.tape();
  const before = h.cg("/trades");
  h.clock.t = read0 + TAPE_FRESH_MS + 1;
  h.fill();
  const [a, b, c] = await Promise.all([h.tape(), h.tape(), h.tape()]);
  for (const x of [a, b, c]) assert.deepEqual([x.status, x.j.as_of_ms, x.age], [200, read0, TAPE_FRESH_MS + 1], "the held rows, dated by their read");
  await settle();
  assert.equal(h.cg("/trades"), before + 1, "one refresh for three callers");
  const d = await h.tape();
  assert.deepEqual([d.j.as_of_ms, d.age, d.j.src], [h.clock.t, 0, "coingecko"], "the next read is served the refresh");
});

test("a tape held past STALE_MS is no held answer: its caller waits for the read, from the callers' share", async () => {
  const h = harness();
  await h.tape();
  h.clock.t += STALE_MS + 1;
  h.fill();
  const a = await h.tape();
  assert.deepEqual([a.status, a.age, a.j.src], [200, 0, "coingecko"]);
  assert.doesNotMatch(h.keyed.minute() ?? "", /trades background/, "a read a caller waits on is never the background's");
});

test("past the key's background day the held tape's refresh goes keyless (refused here, the window full) and its rows are served dated; a cold tape of another coin still reads the key (the callers' share)", async () => {
  const h = harness("100000");
  assert.equal((await h.tape()).j.src, "coingecko");
  // spend the background share of the day (CG_DAY less PROBE_DAY_SHARE and CALLER_DAY_ROOM), past the cold read's
  // CALLER_HOLD_MS
  h.clock.t += 1_100;
  let spent = 0;
  for (let i = 0; i < 4_000; i++) if ((await h.keyed.read(`/networks/robinhood/tokens/${h.coin}/pools?page=1`, () => true, true)) === undefined) break; else spent++;
  assert.ok(spent > 2_000 && spent < 2_500, `background share ${spent}`);
  const before = h.cg("/trades");
  h.clock.t += TAPE_FRESH_MS + 1;
  h.fill();
  const held = await h.tape();
  await settle();
  assert.equal(held.status, 200);
  assert.equal(h.cg("/trades"), before, "the held refresh took no caller's share of the day");
  assert.ok(held.age > TAPE_FRESH_MS, "its rows served dated by their read");
  const cold = await h.tape(h.OTHER);
  assert.equal(cold.status, 200, cold.body.slice(0, 120));
  assert.equal(cold.j.src, "coingecko", "a cold tape still finds the key");
});
