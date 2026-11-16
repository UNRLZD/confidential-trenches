// card pool-buy-waits-out-a-throttle: a pool scan a provider throttled past the page's own retry is that fault, never
// "no pools". pageReference read it as none, so a coin whose only pools are on a scanned venue (Meteora DLMM, Raydium)
// answered quote_check_failed at once and the buy never waited; now the reference throws the fault when it names no
// pool (the buy's attempts wait it out, read-waits.ts readsWaited), and a pool another venue names still quotes.
//   node --test test/reference-scan-fault.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { keptPools, pageReference, type PoolFinders } from "../src/page-rpc.ts";
import { enableTimers, resetTimers } from "./mock-timers.ts";

const COIN = "9a13W5HdHk8P3wHtmJmM1pJWXa9ARn9pRx16khKmtppu";
const REQ = { side: "buy", token: COIN, amount: 1_000_000n } as const;

/** A provider on which no account of the coin's pump venues exists: every account it is asked for is null. */
const empty = (url: string): SolanaRpc =>
  Object.assign(async (method: string, params: readonly unknown[]) => {
    if (method === "getMultipleAccounts") return { context: { slot: 1 }, value: (params[0] as unknown[]).map(() => null) };
    if (method === "getAccountInfo") return { context: { slot: 1 }, value: null };
    throw new Error(`unexpected ${method}`);
  }, { url });
const pair = [empty("https://a.example"), empty("https://b.example")] as const;
const throttled = (): Promise<readonly string[]> => Promise.reject(new SolanaRpcTransportError("http_429", "HTTP 429", 3, "seat.example", 1_000));

test("a coin with no pump pool whose DLMM scan was throttled: the reference throws the scan's fault, never no reference", async () => {
  const finders: PoolFinders = { dlmmPairs: throttled, cpmmPools: async () => [], ammV4Pools: async () => [] };
  await assert.rejects(pageReference(pair, REQ, finders), (e: unknown) => e instanceof SolanaRpcTransportError && e.fault === "http_429");
});

test("a scan that failed otherwise (an answer out of shape) is still no pools: null, as before", async () => {
  const finders: PoolFinders = { dlmmPairs: () => Promise.reject(new Error("a DLMM pair list is not a list")), cpmmPools: async () => [], ammV4Pools: async () => [] };
  assert.equal(await pageReference(pair, REQ, finders), null);
});

test("no scan failed and no pool: null, the coin has none", async () => {
  const finders: PoolFinders = { dlmmPairs: async () => [], cpmmPools: async () => [], ammV4Pools: async () => [] };
  assert.equal(await pageReference(pair, REQ, finders), null);
});

// the kit's scan gives up on a call at its own bound (dlmm.ts SCAN_TIMEOUT_MS, 5 s) with a plain error, while the page's
// lane may hold that call longer (a provider's throttle waited out under it): a scan given up on is that provider's no
// answer, a timeout fault, as readReference reads a read given up on; never "no pools"
const SCAN_BOUND_MS = 5_000;
/** A scan provider whose getProgramAccounts is held `ms` (forever when null), then answers `then`. */
const held = (url: string, ms: number | null, then: () => unknown): SolanaRpc =>
  Object.assign(async (method: string) => {
    if (method !== "getProgramAccounts") throw new Error(`unexpected ${method}`);
    if (ms === null) return new Promise(() => {});
    await new Promise((ok) => setTimeout(ok, ms));
    return then();
  }, { url });
const throttle = (url: string) => () => {
  throw new SolanaRpcTransportError("http_429", "HTTP 429", 3, new URL(url).host, 1_000);
};
const keptDlmm = (scan: readonly [SolanaRpc, SolanaRpc]): PoolFinders => ({ dlmmPairs: keptPools("dlmmPairs", () => scan, () => pair), cpmmPools: async () => [], ammV4Pools: async () => [] });
async function given(t: TestContext, finders: PoolFinders, ms: number): Promise<{ value: unknown } | { thrown: unknown }> {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const got = pageReference(pair, REQ, finders).then((value) => ({ value }), (thrown: unknown) => ({ thrown }));
  for (let at = 0; at < ms; at += 250) {
    for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
    t.mock.timers.tick(250);
  }
  return got;
}

test("a DLMM scan held past the kit's scan bound, then throttled: the reference throws a timeout fault naming the provider, never null", async (t) => {
  const scan = [held("https://s1.example", 6_000, throttle("https://s1.example")), held("https://s2.example", 6_000, throttle("https://s2.example"))] as const;
  const got = await given(t, keptDlmm(scan), 7_000);
  assert.ok("thrown" in got, `the reference answered ${JSON.stringify((got as { value: unknown }).value)}`);
  assert.ok(got.thrown instanceof SolanaRpcTransportError, String(got.thrown));
  assert.equal(got.thrown.fault, "timeout");
  assert.match(got.thrown.host, /^s[12]\.example$/);
});

test("a DLMM scan that never answers: given up at the kit's bound, the reference throws a timeout fault", async (t) => {
  const scan = [held("https://s1.example", null, () => null), held("https://s2.example", null, () => null)] as const;
  const got = await given(t, keptDlmm(scan), SCAN_BOUND_MS + 1_000);
  assert.ok("thrown" in got && got.thrown instanceof SolanaRpcTransportError && got.thrown.fault === "timeout", JSON.stringify(got));
});

test("a DLMM scan throttled inside the kit's bound: the reference throws that provider's own fault (its http_429)", async (t) => {
  const scan = [held("https://s1.example", 100, throttle("https://s1.example")), held("https://s2.example", 100, throttle("https://s2.example"))] as const;
  const got = await given(t, keptDlmm(scan), 1_000);
  assert.ok("thrown" in got && got.thrown instanceof SolanaRpcTransportError && got.thrown.fault === "http_429", JSON.stringify(got));
});

test("a DLMM scan both providers answered out of shape, nothing in flight: no pools, null, as before", async (t) => {
  const scan = [held("https://s1.example", 100, () => ({ value: "no list" })), held("https://s2.example", 100, () => ({ value: "no list" }))] as const;
  const got = await given(t, keptDlmm(scan), 1_000);
  assert.deepEqual(got, { value: null });
});
