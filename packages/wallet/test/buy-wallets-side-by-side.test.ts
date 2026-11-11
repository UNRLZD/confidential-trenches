// Card pool-sell-legs-side-by-side: a sale's finder read (`together`) asks its Ws side by side (in the list's random
// order, its route pacing the calls), so a sale's list of Ws costs one W's read, not one per W.
import assert from "node:assert/strict";
import { test } from "node:test";
import { entropyToWords, wordsToSeed64 } from "../src/derive/index.ts";
import { buyWallets, type Holdings, type HoldingsReader } from "../src/pool/buy-wallets.ts";

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
