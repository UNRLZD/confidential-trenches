// Card pool-sell-legs-side-by-side: a sale's finder read (`together`) asks its Ws side by side (in the list's random
// order, its route pacing the calls), so a sale's list of Ws costs one W's read, not one per W.
import assert from "node:assert/strict";
import { test } from "node:test";
import { entropyToWords, wordsToSeed64 } from "../src/derive/index.ts";
import { buyWallets, buyWalletsOf, type Holdings, type HoldingsReader } from "../src/pool/buy-wallets.ts";

// the all-zero entropy, a published vector (test/vectors/a8.json's kind of seed): no key of anyone's
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const spent = [0, 1, 2].map((i) => ({ ref: { kind: "deposit" as const, s: 1001n, i }, label: 10n + BigInt(i) }));
const none: Holdings = { native: 0n, tokens: new Map(), unreadable: [] };

/** A reader whose reads answer only when let go: how many are in flight at once. */
function held() {
  const waiting: { address: string; go: (h: Holdings) => void; fail: (e: unknown) => void }[] = [];
  const reader: HoldingsReader = { chain: "sol", read: (address) => new Promise((go, fail) => void waiting.push({ address, go, fail })) };
  return { reader, waiting };
}
const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test("the finder asks every W at once, in the list's order, and each W keeps its own answer", async () => {
  const r = held();
  const got = buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: r.reader }], { pick: () => 0, together: true });
  await drain();
  assert.equal(r.waiting.length, 3, "all three in flight before any answers");
  r.waiting.forEach((x, n) => x.go({ ...none, native: BigInt(n + 1) }));
  const a = await got;
  assert.deepEqual(a.failed, []);
  const byAddress = new Map(r.waiting.map((x, n) => [x.address, BigInt(n + 1)]));
  assert.deepEqual(a.wallets.map((w) => w.holdings.native), a.wallets.map((w) => byAddress.get(w.address)));
});

test("one W's failed read fails its pool (no W of it listed), and a stop asked while they read is thrown", async () => {
  const r = held();
  const got = buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: r.reader }], { pick: () => 0, together: true });
  await drain();
  r.waiting[1]!.fail(new Error("http 429"));
  r.waiting[0]!.go(none);
  r.waiting[2]!.go(none);
  const a = await got;
  assert.deepEqual(a.wallets, []);
  assert.equal(a.failed.length, 1);
  assert.match(a.failed[0]!.error, /http 429/);
  const s = held();
  const stop = new AbortController();
  const stopped = buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: s.reader }], { pick: () => 0, signal: stop.signal, together: true });
  await drain();
  stop.abort();
  s.waiting.forEach((x) => x.fail(new Error("aborted")));
  await assert.rejects(stopped);
});

test("without together (the positions' passes) the Ws are read one after another, as before", async () => {
  const r = held();
  const got = buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: r.reader }], { pick: () => 0 });
  await drain();
  assert.equal(r.waiting.length, 1);
  for (let n = 0; n < 3; n++) {
    r.waiting[n]!.go(none);
    await drain();
  }
  assert.equal((await got).wallets.length, 3);
});

test("buyWalletsOf: the same Ws as the finder's derivation, each with no holdings, and nothing read; a W twice fails its pool", async () => {
  const r = held();
  const read = buyWallets(SEED, [{ id: "sol", chain: "sol", spent, reader: r.reader }], { pick: () => 0, together: true });
  await drain();
  r.waiting.forEach((x) => x.go(none));
  const a = await read;
  const b = buyWalletsOf(SEED, [{ id: "sol", chain: "sol", spent }]);
  assert.deepEqual(b.failed, []);
  assert.deepEqual(b.wallets.map((w) => [w.address, w.l, w.j, w.note, w.path]).sort(), a.wallets.map((w) => [w.address, w.l, w.j, w.note, w.path]).sort());
  assert.ok(b.wallets.every((w) => w.holdings.native === 0n && w.holdings.tokens.size === 0));
  const twice = buyWalletsOf(SEED, [{ id: "sol", chain: "sol", spent: [spent[0]!, spent[0]!] }]);
  assert.deepEqual(twice.wallets, []);
  assert.equal(twice.failed.length, 1);
});

// The finder at a sale's tap (a restored device before its first whole pass): its Ws in steps, so one sale never puts
// more than 20 reads on one host inside 1 s. A W's read is one round of three calls (getBalance and both
// getTokenAccountsByOwner), so 6 Ws a step: 18 calls. A paid devnet pass (11 Nov 05:52Z) burst about 15 at the tap and
// drew six 429s at 0.5 s. A failed read starts no later step, and every pool a later step would have read fails.
test("the finder reads 30 Ws in steps of 6 a second apart (never over 20 calls on a host inside 1 s); a failed read starts no later step", async () => {
  const STEP = 6;
  const STEP_MS = 1_000;
  const many = Array.from({ length: 30 }, (_, i) => ({ ref: { kind: "deposit" as const, s: 1001n, i }, label: 10n + BigInt(i) }));
  for (const fail of [false, true]) {
    const clock = { t: 0 };
    const at: number[] = [];
    const reader: HoldingsReader = {
      chain: "sol",
      read: async () => {
        at.push(clock.t);
        if (fail && at.length === 2) throw new Error("getBalance: http 429");
        return none;
      },
    };
    const waits: number[] = [];
    const got = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: many, reader }], { pick: () => 0, together: true, wait: async (ms: number) => void (waits.push(ms), (clock.t += ms)) });
    const calls = (s: number) => 3 * at.filter((t) => t >= s && t < s + 1_000).length;
    assert.ok(Math.max(...at.map(calls)) <= 20, `${Math.max(...at.map(calls))} calls inside 1 s`);
    if (!fail) {
      assert.equal(at.length, 30);
      assert.deepEqual(waits, Array(4).fill(STEP_MS), "30 Ws: five steps a second apart");
      assert.equal(got.wallets.length, 30);
    } else {
      assert.equal(at.length, STEP, "the failed read's step only");
      assert.deepEqual(waits, [STEP_MS], "the step's wait, then no later step");
      assert.equal(got.wallets.length, 0);
      assert.equal(got.failed.length, 1);
    }
  }
});
