// node --test apps/helper/src/data/solana/tape-refresh-lands.test.ts (card sol-vendor-tape-refresh-lands): a Solana
// coin's tape built from the vendor's rows (token.ts tapes, served by trades.ts poolTape) is read again within
// SOL_VENDOR_REACH_MS (15 s) while a page holds it, even with GeckoTerminal's keyless window full. Measured on the
// deployed helper 18 Nov 12:56-13:48Z: its keyless window stood at 3 of 5 (the lists' 2, the ahead lane's 1) in the
// minute lines, the refresh lane takes a call only under perMin - COLD_RESERVE = 3, and no keyless "sol trades" call
// was made in those 52 minutes, so a held tape was served at any age (BONK at 26 s, 13:03Z). Red at f1c909a28: the
// held tape's refresh went keyless only (KEYED_COLD_ONLY) and was refused, its rows aging past the bound.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { CG_BACKGROUND_TIMEOUT_MS, CG_ONCHAIN, CG_TIMEOUT_MS, coingeckoPace, createKeyed } from "../coingecko.ts";
import { geckoBudget } from "../gecko.ts";
import { providerHolds } from "../../limits/limits.ts";
import { enableTimers, resetTimers } from "../../../test/mock-timers.ts";
import { createSolanaToken, GT_BASE, TAPE_FRESH_MS, TAPE_OPEN_BOUND_MS } from "./token.ts";
import { SOL_VENDOR_REACH_MS } from "./trades.ts";

/** A planted key: never a real one. */
const KEY = ["CG", "planted", "tape", "key", "only"].join("-");
const unused = { async handle(): Promise<never> { throw new Error("no chain or Jupiter read in a tape") } };
/** Two coins' top pools and trades: the recorded NEARKAT pool trades (fixtures/sol-pool-trades-nearkat.json) for each. */
const o = JSON.parse(readFileSync(new URL("./fixtures/sol-pool-trades-nearkat.json", import.meta.url), "utf8")) as { mint: string; pool: string; trades: (Record<string, unknown> & { id: string; legs: { from: [string, string]; to: [string, string] } })[] };
const OTHER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const answerFor = (mint: string) => ({
  data: o.trades.map(({ id, legs, ...a }) => {
    const swap = (x: string) => (x === o.mint ? mint : x);
    return { id, type: "trade", attributes: { ...a, from_token_address: swap(legs.from[0]), from_token_amount: legs.from[1], to_token_address: swap(legs.to[0]), to_token_amount: legs.to[1] } };
  }),
});
/** The event loop's turn between two page reads (2 s apart): a refresh behind the held rows lands in it. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((ok) => setImmediate(ok));
};
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function harness(perMin = "300", down: (url: string, at: number) => boolean = () => false, hang: (url: string) => boolean = () => false) {
  const t = { t: Date.parse("2026-11-14T17:25:00Z") };
  const calls: { url: string }[] = [];
  const fetch = async (url: string) => {
    calls.push({ url });
    // CoinGecko never answering (a hung connection)
    if (url.startsWith(CG_ONCHAIN) && hang(url)) return new Promise<never>(() => undefined);
    // CoinGecko slow past its CG_TIMEOUT_MS: the read waits it out and fails
    if (url.startsWith(CG_ONCHAIN) && down(url, t.t)) {
      t.t += CG_TIMEOUT_MS;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    const path = url.startsWith(CG_ONCHAIN) ? url.slice(CG_ONCHAIN.length) : url.startsWith(GT_BASE) ? url.slice(GT_BASE.length) : null;
    if (path === null) throw new Error(`unexpected ${url}`);
    for (const mint of [o.mint, OTHER]) {
      if (path === `/networks/solana/tokens/${mint}`) return json({ data: { relationships: { top_pools: { data: [{ id: `solana_${mint === o.mint ? o.pool : `${o.pool.slice(0, -1)}X`}`, type: "pool" }] } } } });
      if (path.includes("/trades?token=") && path.endsWith(mint)) return json(answerFor(mint));
    }
    return new Response("{}", { status: 404 });
  };
  const holds = providerHolds(() => t.t, coingeckoPace({ COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: perMin }));
  const keyed = createKeyed({ COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: perMin }, holds, { fetch: fetch as never })!;
  const gecko = geckoBudget(() => t.t);
  // the deployed helper's keyless window: the lists' two calls and the ahead lane's one, renewed as they leave it
  const fill = () => gecko.seed([t.t - 1, t.t - 1, t.t - 1], "lists");
  fill();
  const token = createSolanaToken(unused as never, unused as never, { now: () => t.t, sleep: async (ms: number) => void (t.t += ms), fetch: fetch as never, gecko, keyed });
  const tape = (mint: string) => (token as unknown as { tape(m: string): Promise<{ status: number; body: string; src?: string; asOfMs?: number }> }).tape(mint);
  const cg = (kind: string) => calls.filter((c) => c.url.startsWith(CG_ONCHAIN) && c.url.includes(kind)).length;
  const gt = (kind: string) => calls.filter((c) => c.url.startsWith(GT_BASE) && c.url.includes(kind)).length;
  return { t, tape, keyed, gecko, fill, cg, gt };
}

test("a held vendor tape read every 2 s for 5 minutes, GeckoTerminal's keyless window full: every answer's rows read under SOL_VENDOR_REACH_MS ago (red: refused keyless, they aged to 5 minutes)", async () => {
  const h = harness();
  // the timeout each keyed read is sent with: a page's cold read CG_TIMEOUT_MS, a refresh behind held rows
  // CG_BACKGROUND_TIMEOUT_MS (CoinGecko's /trades took up to 3.1 s from a Mac, 18 Nov 14:2xZ)
  const timeouts: number[] = [];
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => (timeouts.push(ms), timeout.call(AbortSignal, ms));
  after(() => void (AbortSignal.timeout = timeout));
  const first = await h.tape(o.mint);
  assert.equal(first.status, 200, first.body.slice(0, 80));
  assert.equal(first.src, "coingecko", "a cold tape is the key's, as before");
  const ages: number[] = [];
  for (const end = h.t.t + 300_000; h.t.t < end; ) {
    h.t.t += 2_000;
    h.fill();
    await settle();
    const a = await h.tape(o.mint);
    assert.equal(a.status, 200);
    ages.push(h.t.t - a.asOfMs!);
  }
  const max = Math.max(...ages);
  assert.ok(max <= SOL_VENDOR_REACH_MS, `oldest rows served ${max} ms after their read (bound ${SOL_VENDOR_REACH_MS})`);
  assert.ok(max <= TAPE_FRESH_MS, `renewed each TAPE_FRESH_MS: ${max}`);
  // one keyed trades read a TAPE_FRESH_MS (plus the read that crossed it), never one a poll
  const n = h.cg("/trades");
  assert.ok(n >= 25 && n <= 31, `${n} keyed trades reads in 5 minutes`);
  assert.equal(h.gt("/trades"), 0, "no keyless call: the window was full");
  // the refreshes draw the key as the helper's background (limits.ts CALLER_DAY_ROOM): named so in the minute line
  assert.match(h.keyed.minute() ?? "", /served trades background \d+/);
  AbortSignal.timeout = timeout;
  assert.deepEqual([...new Set(timeouts.slice(0, 2))], [CG_TIMEOUT_MS], "the cold read's top pool and trades");
  assert.deepEqual([...new Set(timeouts.slice(2))], [CG_BACKGROUND_TIMEOUT_MS], "every refresh");
});

test("past the key's background day the held tape's refresh goes keyless and its rows are served dated; a cold tape of another coin still reads the key (callers' quarter of the day)", async () => {
  const h = harness("100000");
  assert.equal((await h.tape(o.mint)).src, "coingecko");
  // spend the background share of the day (CG_DAY less PROBE_DAY_SHARE and CALLER_DAY_ROOM), past the cold read's
  // CALLER_HOLD_MS
  h.t.t += 1_100;
  let spent = 0;
  for (let i = 0; i < 4_000; i++) if ((await h.keyed.read(`/networks/solana/tokens/${o.mint}`, () => true, true)) === undefined) break; else spent++;
  assert.ok(spent > 2_000 && spent < 2_500, `background share ${spent}`);
  const before = h.cg("/trades");
  h.t.t += TAPE_FRESH_MS + 1;
  h.fill();
  const held = await h.tape(o.mint);
  await settle();
  assert.equal(held.status, 200);
  assert.equal(h.cg("/trades"), before, "the held refresh took no caller's share of the day");
  assert.ok(h.t.t - held.asOfMs! > TAPE_FRESH_MS, "its rows served dated by their read");
  const cold = await h.tape(OTHER);
  assert.equal(cold.status, 200, cold.body.slice(0, 80));
  assert.equal(cold.src, "coingecko", "a cold tape still finds the key");
});

test("one CoinGecko timeout on a held tape's refresh: the next read renews it inside SOL_VENDOR_REACH_MS (red: the timeout held the key 30 s and the rows aged to 40 s, a local helper on mainnet reads 18 Nov 14:05:42-14:06:22Z)", async () => {
  let failed = 0;
  const start = Date.parse("2026-11-14T17:25:00Z");
  // the first refresh after 20 s times out, once
  const h = harness("300", (url, at) => url.includes("/trades") && at - start > 20_000 && failed++ === 0);
  assert.equal((await h.tape(o.mint)).src, "coingecko");
  const ages: number[] = [];
  for (const end = h.t.t + 60_000; h.t.t < end; ) {
    h.t.t += 2_000;
    h.fill();
    await settle();
    const a = await h.tape(o.mint);
    assert.equal(a.status, 200);
    ages.push(h.t.t - a.asOfMs!);
  }
  assert.equal(failed > 0, true, "the timeout was met");
  assert.ok(Math.max(...ages) <= SOL_VENDOR_REACH_MS, `oldest rows served ${Math.max(...ages)} ms after their read: ${ages.join(",")}`);
});

// card sol-vendor-tape-waits-past-reach: a page opening a coin another reader held 17 s before (no read between, so no
// refresh ran) was served the held rows at once, 17 s old, past SOL_VENDOR_REACH_MS, while the refresh ran behind them
// (revalidate served held rows at once up to STALE_MS); card evm-vendor-tape-refresh-keyed's live check met the same on
// Base (0x1668cd48 served 18.9 s old, 18 Nov 15:13:45Z). Red at 576a3baef: the second reader's rows 17,000 ms old.
test("a 17 s gap between two readers of a held tape: the second waits for the one refresh and is served rows under SOL_VENDOR_REACH_MS old (red: the held rows at once, 17 s old)", async () => {
  const h = harness();
  assert.equal((await h.tape(o.mint)).src, "coingecko");
  const before = h.cg("/trades");
  h.t.t += 17_000;
  h.fill();
  // two readers at once: one refresh, both served its rows
  const [a, b] = await Promise.all([h.tape(o.mint), h.tape(o.mint)]);
  for (const x of [a, b]) {
    assert.equal(x.status, 200, x.body.slice(0, 80));
    assert.ok(h.t.t - x.asOfMs! <= SOL_VENDOR_REACH_MS, `rows served ${h.t.t - x.asOfMs!} ms after their read (bound ${SOL_VENDOR_REACH_MS})`);
  }
  assert.equal(h.cg("/trades") - before, 1, "one refresh for both readers");
  assert.match(h.keyed.minute() ?? "", /served trades background \d+/, "the refresh stays the helper's background read");
});

test("inside SOL_VENDOR_REACH_MS a held tape is served at once and its refresh runs behind it, as before", async () => {
  const h = harness();
  const first = await h.tape(o.mint);
  h.t.t += 12_000;
  h.fill();
  const a = await h.tape(o.mint);
  assert.equal(a.asOfMs, first.asOfMs, "the held rows, not the refresh's");
  await settle();
  const b = await h.tape(o.mint);
  assert.ok(b.asOfMs! > first.asOfMs!, "the refresh behind them landed");
});

test("a refresh that hangs past the reach: the caller is answered the newest held rows at TAPE_OPEN_BOUND_MS, never left waiting on the vendor", async (t) => {
  let hang = false;
  const h = harness("300", () => false, (url) => hang && url.includes("/trades"));
  assert.equal((await h.tape(o.mint)).src, "coingecko");
  h.t.t += 17_000;
  h.fill();
  hang = true;
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  let answered = false;
  const p = h.tape(o.mint).then((a) => ((answered = true), a));
  await settle();
  assert.equal(answered, false, "waits for the refresh");
  t.mock.timers.tick(TAPE_OPEN_BOUND_MS - 1);
  await settle();
  assert.equal(answered, false, "still within the bound");
  t.mock.timers.tick(1);
  const a = await p;
  assert.equal(a.status, 200);
  assert.equal(h.t.t - a.asOfMs! >= 17_000, true, "the newest rows held, dated by their read");
  resetTimers(t.mock.timers);
});
