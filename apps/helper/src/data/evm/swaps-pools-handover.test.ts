// node --test apps/helper/src/data/evm/swaps-pools-handover.test.ts: card helper-evm-tapes-survive-a-restart. A deploy's
// new helper takes over the main pools the old one found and checked on chain (swaps.ts `pools`, kept POOL_KEEP_MS),
// through the warm file on the store volume (data/warm.ts), so no listed coin's pool is searched for again after a
// deploy: before this every restart re-ran the search ahead for every listed coin (45 Base, 37 Robinhood) and each
// first open's discovery, on the same keyed providers the live run's tapes read (run 44249482613: helper-tape-4337-trader
// read nothing on 30 Robinhood tapes 11 min after the deploy, token-stats-count-every-trade 2 of 3 Base tapes filling;
// both PASS on the warm helper at 07:00-07:10Z). The state is hostile input: bounded, each entry checked, one bad entry
// restores nothing, an entry keeps its own find time.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeChain, ICNT, KNOWN, open, POOL_ICNT, POOL_VVV, VVV } from "../../../test/evm-swaps/base.ts";
import { evmMarketOf, readWarm, restoreEvmMarket, WARM_DIR, WARM_FILE, writeWarm } from "../warm.ts";
import { HANDOVER_ENTRIES_MAX, POOL_KEEP_MS } from "./swaps.ts";

const handed = (s: { state(): unknown }) => JSON.parse(JSON.stringify(s.state())) as { found?: [string, Record<string, unknown>][] } & Record<string, unknown>;

test("a restarted helper keeps the main pools the old one found, with their find time, before any read of its own", () => {
  const clock = { t: 1_000_000 };
  const old = open(fakeChain(), clock);
  const st = handed(old);
  clock.t += 60_000;
  const c = fakeChain();
  const next = open(c, clock, { pools: new Map() });
  assert.equal(next.kept(ICNT), undefined, "a fresh helper holds no pool");
  assert.equal(next.restore(st), true);
  assert.deepEqual(next.kept(ICNT), { pool: POOL_ICNT.id, decimals: 18 });
  assert.deepEqual(next.kept(VVV), { pool: POOL_VVV.id, decimals: 18 });
  // each keeps its own find time: past POOL_KEEP_MS from the old helper's find it is searched for again
  clock.t = 1_000_000 + POOL_KEEP_MS;
  assert.equal(next.kept(ICNT), undefined);
});

test("through the warm file on disk: written at the stop, read at the start", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pools-handover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { t: Date.now() };
  const old = open(fakeChain(), clock);
  writeWarm(dir, { at: clock.t, gecko: [], geckoLists: [], evm: {}, evmMarket: evmMarketOf(["base"], () => ({ swaps: old })) } as never);
  const next = open(fakeChain(), clock, { pools: new Map() });
  restoreEvmMarket(readWarm(dir, clock.t), ["base"], () => ({ swaps: next }));
  assert.deepEqual(next.kept(ICNT), { pool: POOL_ICNT.id, decimals: 18 });
});

test("planted: a torn warm file is dropped whole, and the helper starts with no pool rather than a guess", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pools-handover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { t: Date.now() };
  const old = open(fakeChain(), clock);
  writeWarm(dir, { at: clock.t, gecko: [], geckoLists: [], evm: {}, evmMarket: evmMarketOf(["base"], () => ({ swaps: old })) } as never);
  const file = join(dir, WARM_DIR, WARM_FILE);
  const whole = JSON.stringify(readWarm(dir, clock.t));
  writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
  assert.equal(readWarm(dir, clock.t), null);
  const next = open(fakeChain(), clock, { pools: new Map() });
  restoreEvmMarket(readWarm(dir, clock.t), ["base"], () => ({ swaps: next }));
  assert.equal(next.kept(ICNT), undefined);
});

test("card helper-v4-hook-trade-is-what-its-trader-paid: an older helper's v4 pool with no hook is found again (it kept a hook only when it could change a swapper's amounts), its others restored; this helper's state restores it", () => {
  const clock = { t: 1_000_000 };
  const st = handed(open(fakeChain(), clock));
  assert.equal(st.v4Hooks, "any");
  const coin = "0x5084b9421250ecc822e3648a81cac23ab65eb54c";
  const hooked = "0x1111111111166b7fe7bd91427724b487980afc69";
  const v4 = (token: string, hook?: string) => [token, { pool: { venue: "v4", id: `0x${"27".repeat(32)}`, token, tokenIs0: false, quote: { kind: "eth", decimals: 18 }, ...(hook === undefined ? {} : { hook }) }, decimals: 18, at: clock.t - 1 }] as [string, Record<string, unknown>];
  st.found!.push(v4(coin), v4(hooked, "0x0469a4bd3724dc86c9542f4694c976da13c450c0"));
  const { v4Hooks: _, ...older } = st;
  const next = open(fakeChain(), clock, { pools: new Map() });
  assert.equal(next.restore(older), true);
  assert.equal(next.kept(coin), undefined, "no hook kept by an older helper: found again");
  assert.deepEqual(next.kept(hooked), { pool: `0x${"27".repeat(32)}`, decimals: 18 });
  assert.deepEqual(next.kept(ICNT), { pool: POOL_ICNT.id, decimals: 18 });
  const same = open(fakeChain(), clock, { pools: new Map() });
  assert.equal(same.restore(st), true);
  assert.deepEqual(same.kept(coin), { pool: `0x${"27".repeat(32)}`, decimals: 18 }, "this helper's state: a v4 pool with no hook has none");
});

test("planted: a handed-over pool that fails any check restores nothing", () => {
  const clock = { t: 1_000_000 };
  const good = handed(open(fakeChain(), clock));
  assert.ok(Array.isArray(good.found) && good.found.length === KNOWN.size, JSON.stringify(good.found));
  const bad: [string, (f: [string, Record<string, unknown>][]) => void][] = [
    ["a key that is not the pool's token", (f) => (f[0]![0] = VVV)],
    ["a token that is no address", (f) => (f[0]![0] = "0xnope")],
    ["a venue no chain has", (f) => ((f[0]![1].pool as Record<string, unknown>).venue = "v9")],
    ["a pool id that is neither an address nor a v4 id", (f) => ((f[0]![1].pool as Record<string, unknown>).id = "0x1234")],
    ["a quote kind off the list", (f) => ((f[0]![1].pool as Record<string, unknown>).quote = { kind: "btc", decimals: 8 })],
    ["decimals out of range", (f) => (f[0]![1].decimals = 78)],
    ["a hook that is no address", (f) => ((f[0]![1].pool as Record<string, unknown>).hook = "0xzz")],
    ["a find time ahead of now", (f) => (f[0]![1].at = clock.t + 1)],
    ["a find time past POOL_KEEP_MS", (f) => (f[0]![1].at = clock.t - POOL_KEEP_MS - 1)],
    ["more entries than HANDOVER_ENTRIES_MAX", (f) => f.push(...Array.from({ length: HANDOVER_ENTRIES_MAX }, () => f[0]!))],
  ];
  for (const [why, edit] of bad) {
    const st = JSON.parse(JSON.stringify(good)) as typeof good;
    edit(st.found!);
    const next = open(fakeChain(), clock, { pools: new Map() });
    assert.equal(next.restore(st), false, why);
    assert.equal(next.kept(ICNT), undefined, why);
    assert.equal(next.kept(VVV), undefined, why);
  }
});
