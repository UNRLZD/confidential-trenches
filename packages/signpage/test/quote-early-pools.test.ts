// A Solana dry's quote never waits for the slower provider's pool scan (card solana-quote-reads-found-pools-once): the
// page's public scan seat answers one call each 1.25 s (pool-testnet.ts SOLANA_TOKEN_SEAT_LIMIT) and a coin's scans are
// six calls on it, 6.6 s on 16 Nov, while the helper's half answered in 0.3 s. keptPools' early list is the first
// provider's whole half of the same scan; the finder itself (a tap's reference) still waits for both providers' union.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58, base64 } from "@scure/base";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { keptPools, pageReference, type PoolFinders } from "../src/page-rpc.ts";

const COIN = "9a13W5HdHk8P3wHtmJmM1pJWXa9ARn9pRx16khKmtppu".slice(0, 44);
const POOL = "AVnUz8xzBqgVbbJkLgXLKLDkoBvQgz6CtxXvaGJyqMFs";
const SLOW_MS = 4_000;
const FAST_MS = 300;
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
};
const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** A provider that answers each scan after `ms`, naming POOL when the coin is the first mint (the scan's offset-8 mint). */
const scanner = (url: string, ms: number, calls: string[]): SolanaRpc =>
  Object.assign(
    (method: string, params: readonly unknown[]) =>
      new Promise((ok) => {
        calls.push(`${url} ${method}`);
        const filters = (params[1] as { filters?: { memcmp?: { bytes?: string } }[] }).filters ?? [];
        const first = filters.find((f) => f.memcmp)?.memcmp?.bytes;
        setTimeout(() => ok({ context: { slot: 1 }, value: first === COIN ? [{ pubkey: POOL, account: null }] : [] }), ms);
      }),
    { url },
  );

test("a coin's early pools come with the faster provider's half of the scan; the finder still waits for both", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const calls: string[] = [];
  const pair = [scanner("https://slow.example", SLOW_MS, calls), scanner("https://fast.example", FAST_MS, calls)] as const;
  const find = keptPools("cpmmPools", () => pair, () => pair);
  let early: readonly string[] | undefined;
  let both: readonly string[] | undefined;
  void find.early!(COIN).then((x) => void (early = x));
  void find(COIN).then((x) => void (both = x));
  await flush();
  t.mock.timers.tick(FAST_MS);
  await flush();
  assert.deepEqual(early, [POOL], `no early list at ${FAST_MS} ms, the faster provider's half`);
  assert.equal(both, undefined, "the union came before the slower provider answered");
  t.mock.timers.tick(SLOW_MS - FAST_MS);
  await flush();
  assert.deepEqual(both, [POOL]);
  // one scan for both: each provider asked the coin's two scans once
  assert.equal(calls.filter((c) => c.includes("getProgramAccounts")).length, 4, calls.join("\n"));
});

test("an early list is none when the scan fails before any provider's half is whole, as a failed finder", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const calls: string[] = [];
  const bad: SolanaRpc = Object.assign(() => Promise.resolve({ value: [{ pubkey: "not an address" }] }), { url: "https://bad.example" });
  const find = keptPools("cpmmPools", () => [bad, scanner("https://slow.example", SLOW_MS, calls)] as const, () => [bad, bad] as const);
  let early: readonly string[] | undefined;
  void find.early!(COIN).then((x) => void (early = x));
  await flush();
  // the bad provider's answer fails the kit's scan at once, so the union fails: the early list is none, as
  // pageReference reads a failed finder, never a wait for the slower provider
  assert.deepEqual(early, []);
  t.mock.timers.tick(SLOW_MS);
  await flush();
  assert.deepEqual(early, []);
});

test("a dry's reference reads each kind's early pools; a tap's waits for the finder itself", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  // two providers that hold no pool of the coin: the reference is none, read at once
  const empty = (url: string): SolanaRpc => Object.assign(async (_m: string, p: readonly unknown[]) => ({ context: { slot: 1 }, value: (p[0] as unknown[]).map(() => null) }), { url });
  const rpcs = [empty("https://a.example"), empty("https://b.example")] as const;
  const finders: PoolFinders = { cpmmPools: Object.assign(() => never<readonly string[]>(), { early: async () => [] as readonly string[] }) };
  let dry: unknown = "waiting";
  let tap: unknown = "waiting";
  void pageReference(rpcs, { side: "buy", token: COIN, amount: 1_000_000n }, finders, { early: true }).then((x) => void (dry = x), (e) => void (dry = e));
  void pageReference(rpcs, { side: "buy", token: COIN, amount: 1_000_000n }, finders).then((x) => void (tap = x), (e) => void (tap = e));
  await flush();
  assert.equal(dry, null, "the dry's reference waited for the slower scan");
  assert.equal(tap, "waiting");
});

test("a coin with more pools than a reference reads (13 DLMM pairs, past 8): the early list is the faster provider's half ranked by depth, as the kit ranks the union", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const pools = Array.from({ length: 13 }, (_, i) => base58.encode(new Uint8Array(32).fill(i + 1)));
  const named = (url: string, ms: number): SolanaRpc =>
    Object.assign(
      (_m: string, params: readonly unknown[]) =>
        new Promise((ok) => {
          const filters = (params[1] as { filters?: { memcmp?: { bytes?: string } }[] }).filters ?? [];
          const first = filters.find((f) => f.memcmp)?.memcmp?.bytes;
          setTimeout(() => ok({ context: { slot: 1 }, value: first === COIN ? pools.map((pubkey) => ({ pubkey })) : [] }), ms);
        }),
      { url },
    );
  // each pair's SOL reserve as a token account holding k + 1 lamports, read at once
  const depth = (url: string): SolanaRpc =>
    Object.assign(
      async (_m: string, params: readonly unknown[]) => ({
        context: { slot: 1 },
        value: (params[0] as string[]).map((_, k) => {
          const b = new Uint8Array(8);
          new DataView(b.buffer).setBigUint64(0, BigInt(k + 1), true);
          return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [base64.encode(b), "base64"] };
        }),
      }),
      { url },
    );
  const find = keptPools("dlmmPairs", () => [named("https://slow.example", SLOW_MS), named("https://fast.example", FAST_MS)] as const, () => [depth("https://a.example"), depth("https://b.example")] as const);
  let early: readonly string[] | undefined;
  void find.early!(COIN).then((x) => void (early = x));
  await flush();
  t.mock.timers.tick(FAST_MS);
  await flush();
  assert.ok(early !== undefined, `no early list at ${FAST_MS} ms, the faster provider's half`);
  assert.ok(early.length > 0 && early.length <= 8, `early names ${early.length} pairs, at most 8`);
  assert.ok(early.every((p) => pools.includes(p)));
});
