// One budget per provider host, the trade's reads first (card signpage-passes-yield-to-a-trade). The paid devnet runs of
// 11 Nov 00:35Z and 02:51Z: the page's proof pass, positions pass and state-read settles kept api.devnet.solana.com's
// window full while a buy waited for Final (429 to its finality reads for 8 to 18 s), and the transport asked a
// throttling host again at 250, 500 and 1000 ms. Each test here runs on a fake provider that counts every request per
// host and throttles as told. Run as the testnet build, whose Solana pair is api.devnet and the helper's devnet route.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import { onTestClock } from "../../kit/test/test-clock.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { TESTNET_RPCS, pageEvmPoolRpcs, pageSolanaRpcs, pageSolanaSettleRpcs, testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_LADDER } = await import("../../wallet/src/pool/evm.ts");
const { holdHosts, hostLane, resetHostLanes, stopHostLaneWaits, PASS_BUDGET_TRADING, PASS_FLOOR_MS, TRADE_TURN_MAX_MS } = await import("../../wallet/src/throttle.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { POOL_DEPOSIT_LOCK } = await import("../src/pool-deposit.ts");
const { keptSells } = await import("../src/pool-sell.ts");

const DEVNET = TESTNET_RPCS.solana[0];
// Circle's USDC on Base Sepolia, as test/pool-testnet-evm-queue.test.ts names it
const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const HELPER = TESTNET_RPCS.solana[1];

type Sent = { host: string; method: string; at: number; status: number };
type Answer = number | { status?: number; result?: unknown; ms?: number; retryAfter?: string };
/** A fake provider as globalThis.fetch: every request counted per host; `answer` says the status of each (429 or 200),
 *  or its status, result, delay and Retry-After. */
async function onProvider(answer: (host: string, n: number, method: string) => Answer, run: (sent: Sent[], t0: number) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const sent: Sent[] = [];
  const per = new Map<string, number>();
  const t0 = performance.now();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const host = new URL(u instanceof Request ? u.url : String(u)).host;
    const n = (per.get(host) ?? 0) + 1;
    per.set(host, n);
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    const a = answer(host, n, q.method);
    const { status = 200, result = 7, ms = 0, retryAfter } = typeof a === "number" ? { status: a } : a;
    sent.push({ host, method: q.method, at: performance.now() - t0, status });
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (status === 429) return new Response("Too Many Requests", { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }), { status: 200 });
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

/** Fills `url`'s host's window with a trade's requests, as a trade's reads do (the passes then take only the floor). */
const fill = (url: string, n = PASS_BUDGET_TRADING): void => {
  for (let i = 0; i < n; i++) hostLane(url).sent("trade");
};
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const SCOPE = solanaPoolOf(SOL_POOLS.devnet!.program).scope;
async function wallet(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { w, ns };
}
/** A note of the devnet pool, INCOMING with its send (a deposit's when `ref` is null; a sell's return note otherwise). */
async function incoming(ns: NoteStore, ref: NoteRef | null): Promise<void> {
  const planned = ref === null ? await ns.planDeposit(SCOPE, (r) => noteSecrets(SEED64, r).precommitment) : await ns.add({ ref, scope: SCOPE, precommitment: noteSecrets(SEED64, ref).precommitment, state: "PLANNED" });
  await ns.move(planned.id, "PLANNED", "INCOMING", { send: { signature: "1".repeat(64), value: 5_000_000n, last_valid_block_height: 151n } });
}
const SELL = { kind: "pool.sell", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: 1n, slippageBps: 100, decimals: 9 } as const;
/** A sell kept on W (it ended "sent", or the page reloaded after its send): a state read settles it by its own
 *  transaction on both RPCs, then each RPC's height, read after (the review's probe A). */
const keptSell = (w: WalletStore): Promise<void> => keptSells(async () => w as never).put({ signature: "1".repeat(64), tx: "AA==", last: 151 });
/** `p`'s time to settle from now in ms, or null past `ms`. */
const within = async (p: Promise<unknown>, ms: number): Promise<number | null> => {
  const t = performance.now();
  return Promise.race([p.then(() => performance.now() - t, () => performance.now() - t), tick(ms).then(() => null)]);
};
// every chain read answers null after 200 ms: a settle's reads are in flight when a trade is tapped
const slowNull = (): Answer => ({ result: null, ms: 200 });

test("a trade's hold leaves a pass its budget: a pass read goes at once while the host's window has room, and the trade's own reads never wait on the budget", async () => {
  await onProvider(() => 200, async (sent) => {
    const release = holdHosts([DEVNET, HELPER]);
    assert.equal(await pageSolanaRpcs("pass")[0]("getProgramAccounts", []), 7, "room in the window: not parked on the hold");
    fill(DEVNET, 100);
    const t = performance.now();
    assert.equal(await pageSolanaRpcs("trade")[0]("getSlot", []), 7);
    assert.ok(performance.now() - t < 100, "a trade's read past every budget goes at once");
    assert.deepEqual(sent.map((s) => s.method), ["getProgramAccounts", "getSlot"]);
    release();
  });
});

test("a pass over the budget waits for room, ends at once on its stop, and a host with room is never waited on", async () => {
  await onProvider(() => 200, async (sent) => {
    fill(DEVNET, 30);
    // the helper's route is another host: its pass reads go on
    assert.equal(await pageSolanaRpcs("pass")[1]("getSlot", []), 7);
    assert.equal(sent.length, 1);
    const a = new AbortController();
    const waiting = hostLane(DEVNET).turn("pass", a.signal);
    await tick(50);
    a.abort(new Error("signed out"));
    await assert.rejects(waiting, /signed out/);
    assert.equal(sent.length, 1, "nothing sent past the budget");
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

test("Base and Robinhood: the same rule; a pass's read of a chain's pool list waits for room in its host's window while a trade's reads fill it, the trade's own go, and a 429 pauses the host for both", async () => {
  await onProvider((host, n) => (host === "rpc.testnet.chain.robinhood.com" && n === 1 ? 429 : 200), async (sent) => {
    for (const chain of ["base", "robinhood"] as const) {
      const release = holdHosts(TESTNET_RPCS[chain]);
      // the trade's first pass read goes (the floor), then its reads fill the window: the next pass waits
      await Promise.all(pageEvmPoolRpcs(chain, "pass")!.map((r) => r("eth_gasPrice", [])));
      for (const u of TESTNET_RPCS[chain]) fill(u);
      const pass = pageEvmPoolRpcs(chain, "pass")!.map((r) => r("eth_blockNumber", []));
      const before = sent.length;
      assert.equal(await pageEvmPoolRpcs(chain, "trade")![1]!("eth_chainId", []), 7);
      await tick(200);
      assert.deepEqual(sent.slice(before).map((x) => x.method), ["eth_chainId"], `${chain}: only the trade's read while its reads fill the window`);
      release();
      resetHostLanes();
      assert.deepEqual(await Promise.all(pass), [7, 7]);
    }
    const rh = sent.filter((x) => x.host === "rpc.testnet.chain.robinhood.com" && x.method === "eth_gasPrice");
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

test("a sign out ends every wait on every host at once: a pass's read waiting for room and a trade's read waiting the host's pause both reject, unsent", async () => {
  await onProvider((host, n) => (host === "api.devnet.solana.com" && n === 1 ? 429 : 200), async (sent) => {
    // the helper's route full; api.devnet paused by a 429
    fill(HELPER, 30);
    const pass = pageSolanaRpcs("pass")[1]("getSlot", []).catch((e: unknown) => e);
    const throttled = pageSolanaRpcs("trade")[0]("getSlot", []).catch((e: unknown) => e);
    await tick(100);
    const paused = pageSolanaRpcs("trade")[0]("getBlockHeight", []).catch((e: unknown) => e);
    await tick(50);
    const t = performance.now();
    stopHostLaneWaits(new Error("signed out"));
    for (const p of [pass, throttled, paused]) assert.match(String(await p), /signed out/);
    assert.ok(performance.now() - t < 100, "at once, not at the pause's end");
    await tick(1_100);
    assert.deepEqual(sent.map((x) => x.method), ["getSlot"], "only the first read went out: nothing after the sign out");
  });
});

// The review of a1a6bad6, P1-1 (its probe A): a state read's settle of a kept sell reads under POOL_SELL_LOCK; a sell
// tapped meanwhile holds its hosts and waits for that lock. The settle's reads park on the sell's hold: the sell answered
// 150 s after the tap. A reader that holds what a trade can wait for reads as a trade.
test("A: a sell tapped while a state read settles a kept sell (under the sell lock) answers in seconds, not at the hold's bound", async () => {
  await onProvider(slowNull, async () => {
    const { w } = await wallet();
    await keptSell(w);
    const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { prover: { vault: signalsProver(), stop: () => {} } });
    const read = t.stateRead();
    await tick(100);
    const r = t.flow(SELL as never, { id: "s1", sha: "00", progress: () => {} } as never) as { running?: true; after: Promise<unknown>; answer: () => unknown };
    assert.equal(r.running, true);
    const ms = await within(r.after, 8_000);
    assert.ok(ms !== null, "the sell answered inside 8 s of its tap");
    assert.deepEqual(r.answer(), { error: "not_funded" });
    assert.ok((await within(read, 8_000)) !== null, "the state read ended");
  });
});

// Its probe A2: the same with a buy running (its hold on both hosts), the sell tapped 1 s in, the buy ending at 2 s.
test("A2: the same with a buy holding the hosts: the sell answers in seconds and the buy's end is not what frees it", async () => {
  await onProvider(slowNull, async () => {
    const { w } = await wallet();
    await keptSell(w);
    const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { prover: { vault: signalsProver(), stop: () => {} } });
    const buy = holdHosts([DEVNET, HELPER]);
    const read = t.stateRead();
    await tick(1_000);
    const r = t.flow(SELL as never, { id: "s2", sha: "00", progress: () => {} } as never) as { after: Promise<unknown>; answer: () => unknown };
    const ms = await within(r.after, 8_000);
    buy();
    assert.ok(ms !== null, "the sell answered inside 8 s of its tap, the buy still holding");
    assert.deepEqual(r.answer(), { error: "not_funded" });
    assert.ok((await within(read, 8_000)) !== null);
  });
});

// Its probe D (P2-1): a state read's settle of an INCOMING deposit note holds POOL_DEPOSIT_LOCK across its reads; a
// deposit tapped during a buy's hold waits for that lock. The settle reads as a trade, so the lock comes in seconds.
test("D: a deposit tapped while a buy holds the hosts and a state read settles a deposit gets the deposit lock in seconds", async () => {
  await onProvider(slowNull, async () => {
    const { w, ns } = await wallet();
    await incoming(ns, null);
    const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { prover: { vault: signalsProver(), stop: () => {} } });
    const buy = holdHosts([DEVNET, HELPER]);
    const read = t.stateRead();
    await tick(300);
    const ms = await within(navigator.locks.request(POOL_DEPOSIT_LOCK, { mode: "exclusive" }, async () => {}), 8_000);
    buy();
    assert.ok(ms !== null, "the deposit's lock came inside 8 s, the buy still holding");
    assert.ok((await within(read, 8_000)) !== null);
  });
});

// Its probe E (P2-2): 20 overlapping trades of 300 ms each kept a pass's turn waiting to the last one's end. A pass's
// turn now comes at least every PASS_FLOOR_MS whatever trades hold the host or send.
test("E: under trades that overlap for good and fill the host's window, a pass read still goes at least every PASS_FLOOR_MS", async () => {
  await onProvider(() => 200, async (sent) => {
    let on = true;
    // every read and give-back kept, all settled before the fake provider goes
    const reads: Promise<unknown>[] = [];
    const trades = (async () => {
      while (on) {
        const give = holdHosts([DEVNET]);
        for (let i = 0; i < 5; i++) reads.push(pageSolanaRpcs("trade")[0]("getSlot", []));
        await tick(300);
        // the next one starts before this one ends
        reads.push(tick(50).then(give));
      }
    })();
    // the trades' own reads fill the window first
    await tick(1_500);
    assert.ok(sent.length > PASS_BUDGET_TRADING, "the trades' own reads filled the window");
    const at: number[] = [];
    const t0 = performance.now();
    const passes = (async () => {
      for (let i = 0; i < 3; i++) {
        await pageSolanaRpcs("pass")[0]("getAccountInfo", []);
        at.push(performance.now() - t0);
      }
    })();
    const ms = await within(passes, 3 * PASS_FLOOR_MS + 2_000);
    on = false;
    await trades;
    await Promise.allSettled([...reads, passes]);
    assert.ok(ms !== null, `three pass reads inside ${3 * PASS_FLOOR_MS + 2_000} ms: ${at.map(Math.round).join(", ")}`);
    assert.equal(sent.filter((x) => x.method === "getAccountInfo").length, 3);
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! <= PASS_FLOOR_MS + 200, `pass ${i} waited ${Math.round(at[i]! - at[i - 1]!)} ms`);
  });
});

// The review of a1a6bad6, P2 (d): the turn's deadline. A host that answers 429 with a Retry-After of an hour, for good,
// and another reader whose 429s keep renewing its pause: a trade's read on it still ends within its stated bound
// (TRADE_TURN_MAX_MS for its turn, then its 3.5 s), and the pair's other seat reads and answers.
test("a host that throttles for good with Retry-After 3600: a trade's read ends within 13.5 s of its call, and the other seat still reads", () => onTestClock(async () => {
  await onProvider((host) => (host === "api.devnet.solana.com" ? { status: 429, retryAfter: "3600" } : 200), async () => {
    const [a, b] = [pageSolanaRpcs("trade"), pageSolanaRpcs("trade")];
    // the first read meets the 429: the host paused 10 s (the Retry-After held to the cap)
    await a[0]("getSlot", []).catch(() => {});
    // a reader that waits the same pause and goes first at its end, renewing it each time
    const renew = (async () => {
      for (let i = 0; i < 4; i++) await a[0]("getSlot", []).catch(() => {});
    })();
    await tick(500);
    const t = performance.now();
    const seat0 = await b[0]("getBlockHeight", []).then(() => "answered", (e: unknown) => String(e));
    const ms = performance.now() - t;
    assert.match(seat0, /HTTP 429/);
    assert.ok(ms <= TRADE_TURN_MAX_MS + 3_500, `the trade's read ended ${Math.round(ms)} ms after its call`);
    assert.equal(await b[1]("getBlockHeight", []), 7, "the other seat reads and answers");
    await renew;
  });
}));

// A paid devnet run on 1e15ba0f (11 Nov): a deposit asked beside a state read's settle answered down. A trade's re-ask
// after a 429 slept the pause it read at its fault, then went out without looking again: a pause another reader's 429
// moved on meanwhile (the helper's route answers 429 with a Retry-After) was sent into, drew another 429 and doubled
// the host's pause. The re-ask takes its turn again, so nothing leaves the page while its host is paused.
test("a deposit's read and a settle's read both meet 429 on one host: neither re-ask leaves inside the host's pause, a re-ask never doubles it, and the deposit's next attempt answers inside its tap's 30 s", async () => {
  // the helper's devnet route: answers in 300 ms; the first two requests 429, the second with a Retry-After of 3 s; any
  // request it gets before that window ends 429 too, after it 200
  let windowEnd = Infinity;
  await onProvider((host, n) => {
    if (host !== new URL(HELPER).host) return 200;
    if (n === 1) return { status: 429, ms: 300 };
    if (n === 2) return { status: 429, ms: 300, retryAfter: "3" };
    return performance.now() < windowEnd ? { status: 429, ms: 300 } : { ms: 300 };
  }, async (sent, t0) => {
    windowEnd = t0 + 500 + 3_000;
    const deposit = pageSolanaRpcs("trade")[1]("getAccountInfo", []).then(() => "answered", (e: unknown) => String(e));
    await tick(200);
    const settle = pageSolanaSettleRpcs("trade")[1]("getMultipleAccounts", []).then(() => "answered", (e: unknown) => String(e));
    const [d, s] = await Promise.all([deposit, settle]);
    const line = (): string => sent.filter((x) => x.host === new URL(HELPER).host).map((x) => `${x.method}@${Math.round(x.at)}ms:${x.status}`).join(" ");
    const inPause = sent.filter((x) => x.host === new URL(HELPER).host && x.at >= 500 && x.at < 3_450);
    assert.deepEqual(inPause, [], `a re-ask left inside the host's pause (500 to 3500 ms): ${line()}`);
    assert.equal(sent.filter((x) => x.status === 429).length, 2, `only the two first reads drew 429: ${line()}`);
    // the deposit's attempt, asked again after the kind's 1 s wait, as read-waits.ts does: inside its tap's 30 s
    const again = d === "answered" ? d : await tick(1_000).then(() => pageSolanaRpcs("trade")[1]("getAccountInfo", []).then(() => "answered", (e: unknown) => String(e)));
    assert.equal(again, "answered", `the deposit's read: ${d}; asked again: ${again}; ${line()}`);
    assert.equal(s, "answered", `the settle's read: ${s}; ${line()}`);
    assert.ok(performance.now() - t0 < 30_000);
  });
});
