// One budget per provider host, the trade's reads first (card signpage-passes-yield-to-a-trade). The paid devnet runs of
// 11 Nov 00:35Z and 02:51Z: the page's proof pass, positions pass and state-read settles kept api.devnet.solana.com's
// window full while a buy waited for Final (429 to its finality reads for 8 to 18 s), and the transport asked a
// throttling host again at 250, 500 and 1000 ms. Each test here runs on a fake provider that counts every request per
// host and throttles as told. Run as the testnet build, whose Solana pair is api.devnet and the helper's devnet route.
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { TESTNET_RPCS, pageEvmPoolRpcs, pageSolanaRpcs, pageSolanaSettleRpcs, testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_LADDER } = await import("../../wallet/src/pool/evm.ts");
const { holdHosts, hostLane, resetHostLanes } = await import("../../wallet/src/throttle.ts");

const DEVNET = TESTNET_RPCS.solana[0];
// Circle's USDC on Base Sepolia, as test/pool-testnet-evm-queue.test.ts names it
const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const HELPER = TESTNET_RPCS.solana[1];

type Sent = { host: string; method: string; at: number; status: number };
/** A fake provider as globalThis.fetch: every request counted per host; `answer` says the status of each (429 or 200). */
async function onProvider(answer: (host: string, n: number) => number, run: (sent: Sent[], t0: number) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const sent: Sent[] = [];
  const per = new Map<string, number>();
  const t0 = performance.now();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const host = new URL(u instanceof Request ? u.url : String(u)).host;
    const n = (per.get(host) ?? 0) + 1;
    per.set(host, n);
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    const status = answer(host, n);
    sent.push({ host, method: q.method, at: performance.now() - t0, status });
    if (status === 429) return new Response("Too Many Requests", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: 7 }), { status: 200 });
  }) as typeof fetch;
  resetHostLanes();
  try {
    await run(sent, t0);
  } finally {
    globalThis.fetch = real;
    resetHostLanes();
  }
}
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a trade holds its hosts: a pass's read on them waits until the trade ends, the trade's own reads go at once", async () => {
  await onProvider(() => 200, async (sent) => {
    const release = holdHosts([DEVNET, HELPER]);
    const pass = pageSolanaRpcs("pass");
    const trade = pageSolanaRpcs("trade");
    const passRead = pass[0]("getProgramAccounts", []);
    const passRead1 = pageSolanaSettleRpcs("pass")[1]("getMultipleAccounts", []);
    assert.equal(await trade[0]("getSlot", []), 7);
    assert.equal(await trade[1]("getSlot", []), 7);
    await tick(300);
    assert.deepEqual(sent.map((s) => s.method), ["getSlot", "getSlot"], "only the trade's reads went out while it held both hosts");
    release();
    assert.equal(await passRead, 7);
    assert.equal(await passRead1, 7);
    assert.deepEqual(sent.map((s) => s.method).slice(2).sort(), ["getMultipleAccounts", "getProgramAccounts"]);
    assert.equal(hostLane(DEVNET).trading(), false);
  });
});

test("a pass waiting for a trade ends at once on its stop, a host no trade holds is never waited on, and a hold ends at its bound", async () => {
  await onProvider(() => 200, async (sent) => {
    const release = holdHosts([DEVNET]);
    // the helper's route is another host: its pass reads go on
    assert.equal(await pageSolanaRpcs("pass")[1]("getSlot", []), 7);
    assert.equal(sent.length, 1);
    const a = new AbortController();
    const waiting = hostLane(DEVNET).turn("pass", a.signal);
    a.abort(new Error("signed out"));
    await assert.rejects(waiting, /signed out/);
    release();
    // a hold never outlives its bound: a run that never ends stops the passes for that long at most
    const lane = hostLane(DEVNET);
    lane.trade(60);
    assert.equal(lane.trading(), true);
    await lane.turn("pass");
    assert.equal(lane.trading(), false, "given back at its bound");
  });
});

test("one backoff per host: a 429 pauses the host for every reader from 1 s, and the read that met it is asked again once after the pause, never at 250 ms", async () => {
  // api.devnet throttles its first request; the helper's route answers all
  await onProvider((host, n) => (host === "api.devnet.solana.com" && n === 1 ? 429 : 200), async (sent) => {
    const first = pageSolanaRpcs("trade")[0]("getSlot", []);
    await tick(50);
    // another reader of the same host (another object, a pass's), during the pause; and one of another host
    const second = pageSolanaRpcs("pass")[0]("getMultipleAccounts", []);
    assert.equal(await pageSolanaRpcs("pass")[1]("getSlot", []), 7, "another host is not paused");
    assert.equal(await first, 7);
    assert.equal(await second, 7);
    const devnet = sent.filter((s) => s.host === "api.devnet.solana.com");
    assert.deepEqual(devnet.map((s) => s.method).sort(), ["getMultipleAccounts", "getSlot", "getSlot"], "the throttled read asked once again; the other reader once");
    for (const s of devnet.slice(1)) assert.ok(s.at - devnet[0]!.at >= 990, `${s.method} went ${Math.round(s.at - devnet[0]!.at)} ms after the 429: inside the host's 1 s pause`);
  });
});

test("a throttle again doubles the host's pause, and the read that met it twice rejects naming it: never a third ask", async () => {
  await onProvider((host, n) => (n <= 2 ? 429 : 200), async (sent) => {
    const e = await pageSolanaRpcs("trade")[0]("getSlot", []).catch((x: unknown) => x);
    assert.ok(e instanceof Error && /HTTP 429/.test(e.message));
    assert.equal(sent.length, 2, "asked twice, no third time");
    assert.ok(sent[1]!.at - sent[0]!.at >= 990);
    assert.equal(await pageSolanaRpcs("pass")[0]("getSlot", []), 7);
    assert.equal(sent.length, 3);
    assert.ok(sent[2]!.at - sent[1]!.at >= 1_990, `the next read went ${Math.round(sent[2]!.at - sent[1]!.at)} ms after the second 429, inside the doubled 2 s pause`);
  });
});

test("a read sent after the last throttle that goes through puts the host's pause back to none", async () => {
  await onProvider((host, n) => (n === 1 ? 429 : 200), async (sent) => {
    assert.equal(await pageSolanaRpcs("trade")[0]("getSlot", []), 7);
    const t = performance.now();
    assert.equal(await pageSolanaRpcs("pass")[0]("getSlot", []), 7);
    assert.ok(performance.now() - t < 200, "no pause left once a read went through");
    assert.equal(sent.length, 3);
  });
});

test("the buy and sell kinds' hosts hold the page's Solana hosts from their making to their end, once", async () => {
  await onProvider(() => 200, async () => {
    const made: { buy?: () => { end?(): void }; sell?: () => { end?(): void } } = {};
    testnetPool(
      { store: async () => assert.fail("no store read"), seed64: async () => assert.fail("no seed read") },
      {
        evmPin: () => undefined,
        tradeKinds: {
          buy: ((h: () => { end?(): void }) => ((made.buy = h), () => ({ error: "not_allowed" }))) as never,
          sell: ((h: () => { end?(): void }) => ((made.sell = h), () => ({ error: "not_allowed" }))) as never,
        },
      },
    );
    for (const [name, make] of [["buy", made.buy], ["sell", made.sell]] as const) {
      assert.equal(hostLane(DEVNET).trading(), false);
      const h = make!();
      assert.equal(hostLane(DEVNET).trading(), true, `${name}: api.devnet held`);
      assert.equal(hostLane(HELPER).trading(), true, `${name}: the helper's devnet route held`);
      h.end?.();
      h.end?.();
      assert.equal(hostLane(DEVNET).trading(), false, `${name}: given back at its end, once`);
      assert.equal(hostLane(HELPER).trading(), false);
    }
  });
});

test("Base and Robinhood: the same rule; a pass's read of a chain's pool list waits while a trade holds its hosts, the trade's own go, and a 429 pauses the host for both", async () => {
  await onProvider((host, n) => (host === "rpc.testnet.chain.robinhood.com" && n === 1 ? 429 : 200), async (sent) => {
    for (const chain of ["base", "robinhood"] as const) {
      const release = holdHosts(TESTNET_RPCS[chain]);
      const pass = pageEvmPoolRpcs(chain, "pass")!.map((r) => r("eth_blockNumber", []));
      const before = sent.length;
      assert.equal(await pageEvmPoolRpcs(chain, "trade")![1]!("eth_chainId", []), 7);
      await tick(200);
      assert.deepEqual(sent.slice(before).map((x) => x.method), ["eth_chainId"], `${chain}: only the trade's read while it holds`);
      release();
      assert.deepEqual(await Promise.all(pass), [7, 7]);
    }
    const rh = sent.filter((x) => x.host === "rpc.testnet.chain.robinhood.com");
    assert.equal(rh.length, 2, "the throttled read asked again once");
    assert.ok(rh[1]!.at - rh[0]!.at >= 990, "after the host's 1 s pause");
  });
});

test("the EVM buy kind's host holds its chain's pool list hosts from its making to its end", async () => {
  await onProvider(() => 200, async () => {
    const made: { h?: { end?(): void } } = {};
    const t = testnetPool(
      { store: async () => assert.fail("no store read"), seed64: async () => assert.fail("no seed read") },
      { evmSync: () => ({ events: async () => assert.fail("no sync read") }), tradeKinds: { evmBuy: ((host: () => { end?(): void }) => () => ((made.h = host()), { error: "not_allowed" })) as never } } as never,
    );
    t.flow({ kind: "pool.buy", chain: "base", token: SEPOLIA_USDC, amount: EVM_LADDER.min, slippageBps: 100, decimals: 18 } as never, null as never);
    assert.ok(made.h, "the base buy made its host");
    for (const u of TESTNET_RPCS.base) assert.equal(hostLane(u).trading(), true, u);
    assert.equal(hostLane(DEVNET).trading(), false, "another chain's host is not held");
    made.h!.end?.();
    for (const u of TESTNET_RPCS.base) assert.equal(hostLane(u).trading(), false, u);
  });
});
