// card pool-buy-waits-out-a-throttle: a Solana withdraw that meets one provider's throttle before any signature is only
// slower. Its plan (the costs, the plan, To and the exit's deposit address) and each part up to its signature are made
// again from their first read after the page's one wait (read-waits.ts readWaits: from 1 s, doubling, at most 10 s, a
// Retry-After honoured to 10 s, 30 s a step); past it, or once a part is signed, the run ends as before, nothing made
// again. A sign out ends the wait. Waits run on mocked timers (./mock-timers.ts).
//   node --test test/pool-withdraw-throttle.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { runPoolWithdraw } from "../src/pool-withdraw.ts";
import { ReadBusy } from "../src/read-waits.ts";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { ASK, COST, POOL, TO, closers, world } from "./pool-withdraw-world.ts";

after(() => closers.forEach((c) => c()));

const AFTER_MS = 2_000;
const throttle = (): SolanaRpcTransportError => new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc.example", AFTER_MS);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await new Promise((ok) => setImmediate(ok));
};

/** The world's pair with `fault(p, method, params)` thrown in place of an answer when it names one. */
const faulty = (rpcs: readonly [SolanaRpc, SolanaRpc], fault: (p: 0 | 1, method: string, params: readonly unknown[]) => Error | null): readonly [SolanaRpc, SolanaRpc] =>
  [0, 1].map((p) => (async (method: string, params: readonly unknown[]) => {
    const e = fault(p as 0 | 1, method, params);
    if (e) throw e;
    return rpcs[p as 0 | 1](method, params);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];

/** Mocked timers, the world's waits on them (each one's ms kept), and a run driven to its end by the mocked clock. */
function clock(t: TestContext) {
  enableTimers(t.mock.timers, { apis: ["setTimeout", "Date"] });
  t.after(() => resetTimers(t.mock.timers));
  const waits: number[] = [];
  const wait = (ms: number): Promise<void> => (waits.push(ms), new Promise<void>((ok) => setTimeout(ok, ms)));
  const drive = async <T>(p: Promise<T>): Promise<{ v: T; ms: number }> => {
    let done = false;
    let v!: T;
    void p.then((x) => void ((done = true), (v = x)));
    let ms = 0;
    for (; ms <= 120_000; ms += 250) {
      await flush();
      if (done) break;
      t.mock.timers.tick(250);
    }
    assert.ok(done, "the run never ended");
    return { v, ms };
  };
  return { waits, wait, drive };
}

test("the plan's fee read throttled once: the run waits the Retry-After, reads its plan again and sends", async (t) => {
  const c = clock(t);
  const wd = await world([30_000_000n], { wait: c.wait });
  let n = 0;
  const host = { ...wd.host, rpcs: faulty(wd.host.rpcs, (p, m) => (p === 0 && m === "getFeeForMessage" && n++ === 0 ? throttle() : null)) };
  const { v: a, ms } = await c.drive(runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(wd.releases.length, 1);
  assert.ok(c.waits.includes(AFTER_MS), `no wait of the provider's Retry-After: ${c.waits.join(",")}`);
  assert.ok(ms >= AFTER_MS, `the run went on before the wait ended (${ms} ms)`);
});

test("a part's pool read throttled once before it signs: the part is made again from its first read, one release", async (t) => {
  const c = clock(t);
  const wd = await world([30_000_000n], { wait: c.wait });
  let n = 0;
  const host = { ...wd.host, rpcs: faulty(wd.host.rpcs, (p, m, params) => (p === 1 && m === "getAccountInfo" && params[0] === POOL && n++ === 0 ? throttle() : null)) };
  const { v: a } = await c.drive(runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(wd.releases.length, 1, "one release leaves");
  assert.equal(wd.binds.length, 2, "the part is bound again: its attempt from its first read");
  assert.ok(c.waits.includes(AFTER_MS), c.waits.join(","));
  assert.equal((await wd.ns.list()).filter((x) => x.state === "HELD").length, 0, "no note left held");
});

test("the exit's deposit address busy once (HTTP 429): asked again after the wait, the run pays the address", async (t) => {
  const c = clock(t);
  const wd = await world([30_000_000n], { wait: c.wait });
  const DEPOSIT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  let asked = 0;
  const exit = async (): Promise<string> => {
    if (asked++ === 0) throw new ReadBusy(429);
    return DEPOSIT;
  };
  const { v: a } = await c.drive(runPoolWithdraw({ ...wd.host, exit }, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(asked, 2);
  assert.equal(wd.balance.get(DEPOSIT), 2_000_000n);
});

test("throttled for good: the waits double to their 30 s bound, then the run stops with nothing bound or sent", async (t) => {
  const c = clock(t);
  const wd = await world([30_000_000n], { wait: c.wait });
  const host = { ...wd.host, rpcs: faulty(wd.host.rpcs, (p, m) => (p === 0 && m === "getFeeForMessage" ? throttle() : null)) };
  const { v: a } = await c.drive(runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "stopped");
  assert.match(a.cause ?? "", /^SolanaRpcTransportError http_429/);
  assert.deepEqual(c.waits, [2_000, 4_000, 8_000, 10_000]);
  assert.equal(wd.binds.length, 0);
  assert.equal(wd.releases.length, 0);
});

test("a fault once the part is signed is never made again: the helper's send throttled, one bind and one release", async (t) => {
  const c = clock(t);
  const wd = await world([30_000_000n], { wait: c.wait, landed: false });
  const host = { ...wd.host, send: async (pool: Parameters<typeof wd.host.send>[0], tx: Uint8Array) => (await wd.host.send(pool, tx), Promise.reject(throttle())) };
  const { v: a } = await c.drive(runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.notEqual(a.stage, "sent");
  assert.equal(wd.binds.length, 1, "the signed part was made again");
  assert.equal(wd.releases.length, 1);
});

test("a sign out during the wait ends it: stopped, nothing bound, before the Retry-After", async (t) => {
  const c = clock(t);
  const wd = await world([30_000_000n], { wait: c.wait });
  const out = new AbortController();
  const host = {
    ...wd.host,
    stop: out.signal,
    rpcs: faulty(wd.host.rpcs, (p, m) => (p === 0 && m === "getFeeForMessage" ? (setTimeout(() => out.abort(), 500), throttle()) : null)),
  };
  const { v: a, ms } = await c.drive(runPoolWithdraw(host, ASK, TO, 2_000_000n, COST));
  assert.equal(a.stage, "stopped");
  assert.match(a.cause ?? "", /^ReadStopped/);
  assert.equal(wd.binds.length, 0);
  assert.ok(ms < AFTER_MS, `the wait outlived the sign out (${ms} ms)`);
});

test("the exit's 1Click ask answered 429 or 503 is busy (ReadBusy), a 400 still refused", async () => {
  const { poolExit, PoolExitRefused } = await import("../src/pool-exit.ts");
  const ready = { chain: "solana", dest: "base", to: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", amount: 100_000_000n, maxFee: 1n } as const;
  const answering = (status: number) => ({ network: "mainnet", price: () => null, now: () => 1_800_000_000_000, fetch: (async () => new Response("{}", { status, headers: { "content-type": "application/json" } })) as typeof fetch });
  for (const status of [429, 503]) await assert.rejects(poolExit(answering(status), ready)!(TO), (e: unknown) => e instanceof ReadBusy);
  await assert.rejects(poolExit(answering(404), ready)!(TO), (e: unknown) => e instanceof PoolExitRefused && !(e instanceof ReadBusy));
});
