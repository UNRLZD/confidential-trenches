// card pool-buy-waits-out-a-throttle: a Solana withdraw that meets one provider's throttle before any signature is only
// slower. Its plan (the costs, the plan, To and the exit's deposit address) and each part up to its signature are made
// again from their first read after the page's one wait (read-waits.ts readWaits: from 1 s, doubling, at most 10 s, a
// Retry-After honoured to 10 s, 30 s a step); past it, or once a part is signed, the run ends as before, nothing made
// again. A sign out ends the wait. A run's time is never the machine's: on mocked timers ticked 250 ms per 40 event-loop
// turns, the clock moved while the wallet store's seal was in the thread pool, so a busy runner read waits no run set
// (merge queue run 43807941583: the free test's run at 10000 ms, waiting nothing). Each run runs on the test clock
// (../../kit/test/test-clock.ts onTestClock: it holds while a seal is in the thread pool and moves only to the time of a
// timer), each wait asked of the world's own sleep and its end kept; a run that must set no wait at all runs on a clock
// that never moves (atOnce).
//   node --test test/pool-withdraw-throttle.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { runPoolWithdraw } from "../src/pool-withdraw.ts";
import { ReadBusy } from "../src/read-waits.ts";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { ASK, COST, POOL, TO, closers, world } from "./pool-withdraw-world.ts";

after(() => closers.forEach((c) => c()));

const AFTER_MS = 2_000;
/** The exit's deposit address on Solana (a quote's, as the exit answers it). */
const DEPOSIT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const throttle = (): SolanaRpcTransportError => new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc.example", AFTER_MS);

/** The world's pair with `fault(p, method, params)` thrown in place of an answer when it names one. */
const faulty = (rpcs: readonly [SolanaRpc, SolanaRpc], fault: (p: 0 | 1, method: string, params: readonly unknown[]) => Error | null): readonly [SolanaRpc, SolanaRpc] =>
  [0, 1].map((p) => (async (method: string, params: readonly unknown[]) => {
    const e = fault(p as 0 | 1, method, params);
    if (e) throw e;
    return rpcs[p as 0 | 1](method, params);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];

/** The world's sleep, each wait asked (`waits`, its ms), and a run on the test clock with the waits ended by the run's
 *  end (`ended`: the clock then runs out every timer still set, a wait the run left included). */
function clock() {
  const waits: number[] = [];
  const ended: number[] = [];
  const wait = (ms: number): Promise<void> => (waits.push(ms), new Promise<void>((ok) => setTimeout(() => (ended.push(ms), ok()), ms)));
  const drive = <T>(run: () => Promise<T>): Promise<{ v: T; ended: number[] }> => onTestClock(async () => ({ v: await run(), ended: [...ended] }));
  return { waits, wait, drive };
}
/** A run on a clock that never moves (mocked timers, never ticked): it ends only if it sets no wait of any kind (the
 *  world's sleep, a bound, a timeout's race); one that sets any never ends, and its test fails at its own timeout. */
async function atOnce<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  enableTimers(t.mock.timers, { apis: ["setTimeout", "Date"] });
  try {
    return await run();
  } finally {
    resetTimers(t.mock.timers);
  }
}

test("the plan's fee read throttled once: the run waits the Retry-After, reads its plan again and sends", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  let n = 0;
  const host = { ...wd.host, rpcs: faulty(wd.host.rpcs, (p, m) => (p === 0 && m === "getFeeForMessage" && n++ === 0 ? throttle() : null)) };
  const { v: a, ended } = await c.drive(() => runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(wd.releases.length, 1);
  assert.ok(c.waits.includes(AFTER_MS), `no wait of the provider's Retry-After: ${c.waits.join(",")}`);
  assert.ok(ended.includes(AFTER_MS), `the run went on before the wait ended: ${ended.join(",")}`);
});

test("a part's pool read throttled once before it signs: the part is made again from its first read, one release", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  let n = 0;
  const host = { ...wd.host, rpcs: faulty(wd.host.rpcs, (p, m, params) => (p === 1 && m === "getAccountInfo" && params[0] === POOL && n++ === 0 ? throttle() : null)) };
  const { v: a } = await c.drive(() => runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(wd.releases.length, 1, "one release leaves");
  assert.equal(wd.binds.length, 2, "the part is bound again: its attempt from its first read");
  assert.ok(c.waits.includes(AFTER_MS), c.waits.join(","));
  assert.equal((await wd.ns.list()).filter((x) => x.state === "HELD").length, 0, "no note left held");
});

test("the exit's deposit address busy once (HTTP 429): asked again after the wait, the run pays the address", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  const refunds: string[] = [];
  const exit = async (w: string): Promise<string> => {
    if (refunds.push(w) === 1) throw new ReadBusy(429);
    return DEPOSIT;
  };
  const { v: a } = await c.drive(() => runPoolWithdraw({ ...wd.host, exit }, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(refunds.length, 2);
  assert.equal(refunds[1], refunds[0], "asked again with the same W: no quote names a W the withdraw does not use");
  assert.equal(wd.balance.get(DEPOSIT), 2_000_000n);
});

test("the exit's busy answer with a Retry-After of 3 s: the run waits those 3 s (the page's one rule, as a provider's), then asks again", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  let asked = 0;
  const exit = async (): Promise<string> => {
    if (asked++ === 0) throw new ReadBusy(429, 3_000);
    return DEPOSIT;
  };
  const { v: a } = await c.drive(() => runPoolWithdraw({ ...wd.host, exit }, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.deepEqual(c.waits, [3_000]);
});

test("the exit answered, then To's check throttled: the run waits, checks the same address again and pays it; the exit asked once", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  const refunds: string[] = [];
  const exit = async (w: string): Promise<string> => (refunds.push(w), DEPOSIT);
  let n = 0;
  const rpcs = faulty(wd.host.rpcs, (p, m, params) => (p === 0 && m === "getAccountInfo" && params[0] === DEPOSIT && n++ === 0 ? throttle() : null));
  const { v: a } = await c.drive(() => runPoolWithdraw({ ...wd.host, rpcs, exit }, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(n > 1, true, "To checked again after the wait");
  assert.ok(c.waits.includes(AFTER_MS), c.waits.join(","));
  assert.equal(refunds.length, 1, `the exit asked ${refunds.length} times: an abandoned quote names a W`);
  assert.equal(wd.balance.get(DEPOSIT), 2_000_000n);
});

test("a part throttled after it held its note, whose free then fails: the run stops at once naming the failed free, never a wait for a note it holds", { timeout: 10_000 }, async (t) => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  let n = 0;
  const rpcs = faulty(wd.host.rpcs, (p, m, params) => (p === 1 && m === "getAccountInfo" && params[0] === POOL && n++ === 0 ? throttle() : null));
  const ns = await wd.host.notes();
  let frees = 0;
  const notes = async () =>
    new Proxy(ns, {
      get: (o, k) =>
        k === "move"
          ? (id: string, from: string, to: string, x: unknown) =>
              from === "HELD" && to === "UNSPENT" && frees++ === 0 ? Promise.reject(new Error("the note store is closed")) : (o.move as (...a: unknown[]) => unknown).call(o, id, from, to, x)
          : Reflect.get(o, k, o),
    });
  const a = await atOnce(t, () => runPoolWithdraw({ ...wd.host, rpcs, notes } as typeof wd.host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "stopped");
  assert.match(a.cause ?? "", /^Error free\b/, `the cause names the failed free: ${a.cause}`);
  assert.equal(wd.binds.length, 1, "the part never made again");
  assert.equal(wd.releases.length, 0);
  assert.deepEqual(c.waits, [], "no wait");
});

test("throttled for good: the waits double to their 30 s bound, then the run stops with nothing bound or sent", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  const host = { ...wd.host, rpcs: faulty(wd.host.rpcs, (p, m) => (p === 0 && m === "getFeeForMessage" ? throttle() : null)) };
  const { v: a } = await c.drive(() => runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "stopped");
  assert.match(a.cause ?? "", /^SolanaRpcTransportError http_429/);
  assert.deepEqual(c.waits, [2_000, 4_000, 8_000, 10_000]);
  assert.equal(wd.binds.length, 0);
  assert.equal(wd.releases.length, 0);
});

test("a fault once the part is signed is never made again: the helper's send throttled, one bind and one release", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait, landed: false });
  const host = { ...wd.host, send: async (pool: Parameters<typeof wd.host.send>[0], tx: Uint8Array) => (await wd.host.send(pool, tx), Promise.reject(throttle())) };
  const { v: a } = await c.drive(() => runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.notEqual(a.stage, "sent");
  assert.equal(wd.binds.length, 1, "the signed part was made again");
  assert.equal(wd.releases.length, 1);
});

test("a sign out during the wait ends it: stopped, nothing bound, before the Retry-After", { timeout: 60_000 }, async () => {
  const c = clock();
  const wd = await world([30_000_000n], { wait: c.wait });
  const out = new AbortController();
  const host = {
    ...wd.host,
    stop: out.signal,
    rpcs: faulty(wd.host.rpcs, (p, m) => (p === 0 && m === "getFeeForMessage" ? (setTimeout(() => out.abort(), 500), throttle()) : null)),
  };
  const { v: a, ended } = await c.drive(() => runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "stopped");
  assert.match(a.cause ?? "", /^ReadStopped/);
  assert.equal(wd.binds.length, 0);
  assert.deepEqual(c.waits, [AFTER_MS]);
  assert.deepEqual(ended, [], "the wait outlived the sign out");
});

test("the exit's 1Click ask answered 429 or 503 is busy (ReadBusy), a 400 or a 404 still refused", async () => {
  const { poolExit, PoolExitRefused } = await import("../src/pool-exit.ts");
  const ready = { chain: "solana", dest: "base", to: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", amount: 100_000_000n, maxFee: 1n } as const;
  const answering = (status: number, after?: string) => ({ network: "mainnet", price: () => null, now: () => 1_800_000_000_000, fetch: (async () => new Response("{}", { status, headers: { "content-type": "application/json", ...(after === undefined ? {} : { "retry-after": after }) } })) as typeof fetch });
  for (const status of [429, 503]) await assert.rejects(poolExit(answering(status), ready)!(TO), (e: unknown) => e instanceof ReadBusy && e.afterMs === null);
  // its Retry-After carried, in seconds or as an HTTP date on the exit's clock
  await assert.rejects(poolExit(answering(429, "3"), ready)!(TO), (e: unknown) => e instanceof ReadBusy && e.afterMs === 3_000);
  await assert.rejects(poolExit(answering(503, new Date(1_800_000_004_000).toUTCString()), ready)!(TO), (e: unknown) => e instanceof ReadBusy && e.afterMs === 4_000);
  for (const status of [400, 404]) await assert.rejects(poolExit(answering(status), ready)!(TO), (e: unknown) => e instanceof PoolExitRefused && !(e instanceof ReadBusy), `HTTP ${status}`);
});
