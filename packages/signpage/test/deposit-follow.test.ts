// The deposit's follow on SIGN_HOST (card wallet-deposit-follow, src/deposit-follow.ts), with the wallet's real store on
// fake-indexeddb and 1Click's status answered by a script (the recorded live answer's quoteResponse,
// packages/kit/test/fixtures/oneclick-quotes.json, with this test's U): deposit.quote's checked answer writes the op
// and starts the follow with no tap; a refused quote writes none; deposit.confirm answers the op's stage and facts as
// the kit reads them and each later stage as its progress; an unknown address is not_allowed; settle() resumes every
// op not at an end (expired and refunded among them) and leaves done and held; the seed opens only for a bind; a sign
// out waits for the follows under the seed lock.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import type { DepositRecord, WalletStore } from "@blindfill/wallet/store";
import type { Stage } from "../../kit/src/signpage/messages.ts";
import type { FollowRpc } from "../../wallet/src/deposit/follow.ts";
import type { KindContext } from "../src/api.ts";
import type { DepositPublic } from "../src/deposit-wire.ts";
import { ADDRESS as MOCK_ADDRESS, h1c, NOW as MOCK_NOW, SOL_USDC, U as MOCK_U } from "./oneclick-mock.ts";
// after the mock, so the check loads the mock's keys (a static import would load the kit's first)
const { openWalletStore, WALLET_SEED_LOCK } = await import("@blindfill/wallet/store");
const { SIGNPAGE_RESULT_SCHEMAS } = await import("../../kit/src/signpage/schema.ts");
const { depositAccount, NEAR_NETWORKS } = await import("../../wallet/src/deposit/account.ts");
const d = await import("../../wallet/src/derive/index.ts");
const { depositFollows, FOLLOW_ENDS, FOLLOW_LOCK } = await import("../src/deposit-follow.ts");
const { depositQuoteHost } = await import("../src/deposit-wire.ts");

const SAVED: DepositPublic = { status: { source: "code", code_saved: true }, deposit: { v: 1, scope: "7", index: 3, id: MOCK_U } };

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const LIVE = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/oneclick-quotes.json", import.meta.url), "utf8")).live.answer;
const ADDR = LIVE.quote.depositAddress as string;
const U = depositAccount(SEED, 1n, 0).account;
const RESULT = { deposit_address: ADDR, origin_asset: "nep141:wrap.near", amount_in: "452500000000000000000000", min_amount_out: "1.983085", deadline: LIVE.quote.deadline, time_estimate_s: 20 };
const FOLLOW = { network: "testnet", s: "1", i: 0, u: U, address: ADDR, deadline_ms: Date.parse(LIVE.quote.deadline), origin: "nep141:wrap.near", min_out: "1983085" };

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
const status = (s: string) => {
  const q = structuredClone(LIVE);
  q.quoteRequest.recipient = q.quoteRequest.refundTo = U;
  return Response.json({ correlationId: "x", quoteResponse: q, status: s, swapDetails: {}, updatedAt: "2026-10-31T21:06:00.000Z" });
};
// the chain reads (U's USDC) answer nothing on both RPCs: no credit, so no bind; a block read says the deadline is far
const RPCS = (): readonly [FollowRpc, FollowRpc] => {
  const one = (name: string): FollowRpc => ({ name, query: async () => ({}), tx: async () => ({}), block: async () => ({ result: { header: { timestamp_nanosec: "1" } } }) });
  return [one(NEAR_NETWORKS.testnet.fastnear[0]), one(NEAR_NETWORKS.testnet.drpc)];
};

async function world(script: string[], o: { seed64?: () => Promise<Uint8Array>; locks?: () => LockManager | null } = {}) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  let reads = 0;
  const fetchFn = (async () => status(script.length > 1 ? script.shift()! : script[0]!)).bind(null) as unknown as typeof fetch;
  const counted = (async (...a: Parameters<typeof fetch>) => (reads++, fetchFn(...a))) as typeof fetch;
  let tick = () => {};
  const f = depositFollows({
    network: () => "testnet",
    store: async () => w,
    seed64: o.seed64 ?? (async () => Uint8Array.from(SEED)),
    rpcs: RPCS,
    fetch: counted,
    sleep: async () => (tick(), await new Promise<void>((ok) => setImmediate(ok))),
    locks: o.locks ?? (() => null),
    now: () => 1_762_400_000_000,
  });
  return { w, f, reads: () => reads, onTick: (fn: () => void) => (tick = fn) };
}
const ctxOf = (id: string, seen: Stage[]): KindContext => ({ id, sha: "0".repeat(64), progress: (s) => void seen.push(s) });

test("a checked quote writes the op from that quote and its record, and follows it with no tap; an op of another deposit refuses", async () => {
  const t = await world(["PROCESSING"]);
  let n = 0;
  t.onTick(() => ++n >= 3 && t.f.signedOut());
  await t.f.quoted("dq-1", RESULT, { scope: 1n, index: 0, u: U });
  await t.f.idle();
  const op = (await t.w.get("ops", "dq-1")) as Record<string, any>;
  assert.equal(op.kind, "deposit");
  assert.equal(op.stage, "in_transit", "followed with no tap: 1Click's PROCESSING read");
  assert.deepEqual(op.follow, { ...FOLLOW, status: "PROCESSING", sent: true }, "min_amount_out in USDC base units; 1Click has seen a send");
  await assert.rejects(t.f.quoted("dq-1", { ...RESULT, deposit_address: "f".repeat(64) }, { scope: 1n, index: 0, u: U }), /another deposit/);
  await assert.rejects(t.f.quoted("dq-3", { ...RESULT, min_amount_out: "1.0000001" }, { scope: 1n, index: 0, u: U }), /min_amount_out/);
  assert.deepEqual((await t.w.keys("ops")).sort(), ["dq-1"]);
});

test("the quote host hands the follow U from the record its rule checked, never a later read", async () => {
  // reads: before the rule, after it (the same record), then a moved one any later read would see
  const moved: DepositRecord = { v: 1, scope: "7", index: 4, id: "b".repeat(64) };
  const reads = [SAVED, SAVED, { ...SAVED, deposit: moved }];
  let r = 0;
  const got: unknown[] = [];
  const host = depositQuoteHost({ scope: () => 7n, read: async () => reads[Math.min(r++, 2)]!, fetch: h1c({}).fetch, now: () => MOCK_NOW, checked: async (id, res, u) => void got.push({ id, address: res.deposit_address, u }) });
  const d = host({ origin_asset: SOL_USDC, amount: "25" }, { id: "dq-9" });
  await d.after;
  assert.ok("result" in (d.answer() as object));
  assert.deepEqual(got, [{ id: "dq-9", address: MOCK_ADDRESS, u: { scope: 7n, index: 3, u: MOCK_U } }]);
  assert.equal(r, 2, "two reads, as the rule makes them; no third");
  // the follow's write throws: the answer is down, never an address nothing follows
  const down = depositQuoteHost({ scope: () => 7n, read: async () => SAVED, fetch: h1c({}).fetch, now: () => MOCK_NOW, checked: async () => { throw new Error("no store"); } });
  const e = down({ origin_asset: SOL_USDC, amount: "25" }, { id: "dq-10" });
  await e.after;
  assert.deepEqual(e.answer(), { error: "down" });
});

test("deposit.confirm answers the op's stage and facts as the kit reads them, then each later stage as progress; an unknown address is not_allowed", async () => {
  const t = await world(["KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT"]);
  await t.w.put("ops", "dq-1", { kind: "deposit", stage: "quote_checked", txs: [], created_ms: 1, follow: FOLLOW });
  let n = 0;
  t.onTick(() => ++n >= 4 && t.f.signedOut());
  const seen: Stage[] = [];
  const kinds = t.f.withFollow({});
  const confirm = kinds["deposit.confirm"] as (p: unknown, c: KindContext) => { after: Promise<unknown>; answer: () => any };
  const d = confirm({ deposit_address: ADDR }, ctxOf("dc-1", seen));
  await d.after;
  assert.deepEqual(d.answer(), { result: { stage: "quote_checked" } });
  await t.f.idle();
  assert.deepEqual(seen, ["waiting", "in_transit", "short"]);
  const later = confirm({ deposit_address: ADDR }, ctxOf("dc-2", []));
  await later.after;
  const a = later.answer();
  assert.deepEqual(a, { result: { stage: "short", since_ms: 1_762_400_000_000 } });
  assert.ok(SIGNPAGE_RESULT_SCHEMAS["deposit.confirm"](a.result));
  await t.f.idle();

  const none = confirm({ deposit_address: "f".repeat(64) }, ctxOf("dc-3", []));
  await none.after;
  assert.deepEqual(none.answer(), { error: "not_allowed" });
});

test("settle() resumes every deposit op not at an end, expired and refunded too; held, and done past its deadline, stay as they are", async () => {
  const t = await world(["PROCESSING"]);
  const f = FOLLOW;
  await t.w.put("ops", "open", { kind: "deposit", stage: "waiting", txs: [], created_ms: 1, since_ms: 5, follow: f });
  for (const stage of ["expired", "refunded"]) await t.w.put("ops", `late-${stage}`, { kind: "deposit", stage, txs: [], created_ms: 1, ...(stage === "refunded" ? { held_id: U, since_ms: 5 } : {}), follow: { ...f, address: stage.padEnd(64, "0") } });
  assert.deepEqual([...FOLLOW_ENDS].sort(), ["done", "held"]);
  for (const stage of FOLLOW_ENDS) await t.w.put("ops", `end-${stage}`, { kind: "deposit", stage, txs: [], created_ms: 1, follow: { ...f, address: `${stage}`.padEnd(64, "0"), ...(stage === "done" ? { final: true } : {}) } });
  let n = 0;
  t.onTick(() => ++n >= 3 && t.f.signedOut());
  await t.f.settle();
  await t.f.idle();
  assert.equal(((await t.w.get("ops", "open")) as { stage: string }).stage, "in_transit");
  for (const stage of FOLLOW_ENDS) assert.equal(((await t.w.get("ops", `end-${stage}`)) as { stage: string }).stage, stage);
  assert.ok(t.reads() >= 3, "the open, expired and refunded ops each read again");
});

test("the seed is never opened without a credit to bind", async () => {
  let opened = 0;
  const t = await world(["PROCESSING"], { seed64: async () => (opened++, Uint8Array.from(SEED)) });
  let n = 0;
  t.onTick(() => ++n >= 3 && t.f.signedOut());
  await t.f.quoted("dq-1", RESULT, { scope: 1n, index: 0, u: U });
  await t.f.idle();
  assert.equal(opened, 0, "status and balance reads need only U");
});

test("N1 and E2: a live follow never holds the seed lock while it polls: an exclusive (nameDeposit, setCodeSaved, a sign out) and a trade's shared request go at once; U's own lock is held", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  const f = depositFollows({
    network: () => "testnet",
    store: async () => w,
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: (async () => status("PENDING_DEPOSIT")) as unknown as typeof fetch,
    sleep: () => new Promise<void>((ok) => setTimeout(ok, 5)),
    locks: () => navigator.locks, // the real Web Locks (Node 24), which queue
    now: () => 1_762_400_000_000,
  });
  await f.quoted("dq-1", RESULT, { scope: 1n, index: 0, u: U });
  await new Promise((ok) => setTimeout(ok, 50));
  let exclusive = false;
  let shared = false;
  const ex = navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, async () => void (exclusive = true));
  const sh = navigator.locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => void (shared = true));
  await Promise.race([Promise.all([ex, sh]), new Promise((ok) => setTimeout(ok, 400))]);
  const q = await navigator.locks.query();
  assert.ok(exclusive && shared, "neither waited on the follow");
  assert.ok(q.held!.some((l) => l.name === `${FOLLOW_LOCK}testnet/${U}` && l.mode === "exclusive"), "U's lock is held while it follows");
  assert.ok(!q.held!.some((l) => l.name === WALLET_SEED_LOCK));
  f.signedOut();
  await f.idle();
});

test("two ops on one U in one tab: one note store, one follower; each op's stages reach its own deposit.confirm", async () => {
  const t = await world(["PROCESSING"]);
  let n = 0;
  t.onTick(() => ++n >= 6 && t.f.signedOut());
  await t.f.quoted("dq-1", RESULT, { scope: 1n, index: 0, u: U });
  await t.f.quoted("dq-2", { ...RESULT, deposit_address: "c".repeat(64) }, { scope: 1n, index: 0, u: U });
  await t.f.idle();
  assert.equal(((await t.w.get("ops", "dq-1")) as { stage: string }).stage, "in_transit");
});

test("E7: deposit.quote with no request id to follow it answers no address", async () => {
  const host = depositQuoteHost({ scope: () => 7n, read: async () => SAVED, fetch: h1c({}).fetch, now: () => MOCK_NOW, checked: async () => assert.fail("no op to follow") });
  const d = host({ origin_asset: SOL_USDC, amount: "25" });
  await d.after;
  assert.deepEqual(d.answer(), { error: "not_allowed" });
});

// ---------- r2: the store closing, a dying follow, the seed lock, the retry's pause, a refusal, the deadline ----------
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// U's USDC reads 2 USDC on both RPCs at one block: a bind phase starts
const CREDIT_RPCS = (): readonly [FollowRpc, FollowRpc] => {
  const one = (name: string): FollowRpc => ({
    name,
    tx: async () => ({}),
    block: async () => ({ result: { header: { timestamp_nanosec: "1" } } }),
    query: async (p) => (p.method_name === "ft_balance_of" ? { result: { block_height: 100, result: [...Buffer.from(JSON.stringify("2000000"))] } } : {}),
  });
  return [one(NEAR_NETWORKS.testnet.fastnear[0]), one(NEAR_NETWORKS.testnet.drpc)];
};

test("S1: the tab's store connection closes (another tab's upgrade) and is opened again: the follows end, U's lock is freed, and the deposit is followed again", async () => {
  const idb = new IDBFactory();
  let cur1 = await openWalletStore({ indexedDB: idb });
  const w2 = await openWalletStore({ indexedDB: idb });
  closers.push(() => cur1.close(), () => w2.close());
  let reads1 = 0;
  let reads2 = 0;
  const mk = (store: () => Promise<WalletStore>, count: () => void) =>
    depositFollows({
      network: () => "testnet",
      store,
      seed64: async () => Uint8Array.from(SEED),
      rpcs: RPCS,
      fetch: (async () => (count(), status("PROCESSING"))) as unknown as typeof fetch,
      sleep: () => pause(5) as Promise<void>,
      locks: () => navigator.locks,
      now: () => 1_762_400_000_000,
    });
  const tab1 = mk(async () => cur1, () => void reads1++);
  const tab2 = mk(async () => w2, () => void reads2++);
  await tab1.quoted("dq-1", RESULT, { scope: 1n, index: 0, u: U });
  await pause(100);
  assert.ok(reads1 > 0, "tab 1 follows");
  // main.ts: onEvent "closed" drops the handle (storeClosed) and the next open() opens a fresh one, then settles
  cur1.close();
  tab1.storeClosed();
  // the close alone ends tab 1's follow and frees U's lock: tab 2's landing follows the deposit
  const at2 = reads2;
  await tab2.settle();
  await pause(300);
  assert.ok(reads2 > at2, "tab 2 never got U's lock after tab 1's store closed");
  cur1 = await openWalletStore({ indexedDB: idb });
  await tab1.settle();
  tab1.signedOut();
  tab2.signedOut();
  await Promise.all([tab1.idle(), tab2.idle()]);

  // a settle() that finds another handle than its follows run on ends them first, with no storeClosed()
  const idb3 = new IDBFactory();
  let cur = await openWalletStore({ indexedDB: idb3 });
  closers.push(() => cur.close());
  let reads = 0;
  const tab = mk(async () => cur, () => void reads++);
  await tab.quoted("dq-1", RESULT, { scope: 1n, index: 0, u: U });
  await pause(50);
  cur.close();
  cur = await openWalletStore({ indexedDB: idb3 });
  const from = reads;
  await tab.settle();
  await pause(200);
  tab.signedOut();
  await tab.idle();
  assert.ok(reads > from, "followed again on the new handle");
});

test("S2: a sign out, then the next sign in's settle() while the stopped follow still sleeps: a new follow starts, the dying one is never handed back", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.put("ops", "dq-1", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 1, follow: { ...FOLLOW, sent: true } });
  let reads = 0;
  let gets = 0;
  let release!: () => void;
  const slept = new Promise<void>((ok) => (release = ok));
  // the follow's own read of the op (settle's is the first) hangs until this test lets it go: that follow cannot stop
  const store = new Proxy(w, { get: (o, k) => (k === "get" ? async (...a: [never, string]) => (a[1] === "dq-1" && ++gets === 2 ? slept.then(() => o.get(...a)) : o.get(...a)) : (o as never)[k]) }) as WalletStore;
  const f = depositFollows({
    network: () => "testnet",
    store: async () => store,
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: (async () => (reads++, status("PROCESSING"))) as unknown as typeof fetch,
    sleep: (ms) => (ms === 1_000 ? slept : (pause(5) as Promise<void>)),
    locks: () => null,
    now: () => 1_762_400_000_000,
  });
  await f.settle();
  await pause(30);
  assert.equal(reads, 0);
  f.signedOut();
  await f.settle(); // the next sign in's landing
  await pause(100);
  assert.ok(reads > 0, "the op is followed after the new sign in's settle()");
  f.signedOut();
  release();
  await f.idle();
});

test("G1: the bind phase opens the seed only under the wallet's seed lock, taken shared", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  const held: string[][] = [];
  const f = depositFollows({
    network: () => "testnet",
    store: async () => w,
    // the locks held as the seed opens; then a seed that is not U's: the op is held and the follow ends
    seed64: async () => (held.push((await navigator.locks.query()).held!.filter((l) => l.name === WALLET_SEED_LOCK).map((l) => l.mode!)), new Uint8Array(64)),
    rpcs: CREDIT_RPCS,
    fetch: (async () => status("SUCCESS")) as unknown as typeof fetch,
    sleep: () => pause(5) as Promise<void>,
    locks: () => navigator.locks,
    now: () => 1_762_400_000_000,
  });
  await f.quoted("dq-1", RESULT, { scope: 1n, index: 0, u: U });
  await Promise.race([f.idle(), pause(2_000)]);
  assert.deepEqual(held, [["shared"]]);
  assert.equal(((await w.get("ops", "dq-1")) as { stage: string }).stage, "held");
  f.signedOut();
  await f.idle();
});

test("G2 and the body: a throw that is no refusal pauses before the op's next try, doubling; a note store that never opened is opened again", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.put("ops", "dq-1", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 1, follow: { ...FOLLOW, sent: true } });
  let gets = 0; // settle's own read is the first; the op's next three fail
  let opens = 0;
  let reads = 0;
  const sleeps: number[] = [];
  const store = new Proxy(w, { get: (o, k) => (k === "get" ? async (...a: [never, string]) => (a[1] === "dq-1" && ++gets >= 2 && gets <= 4 ? Promise.reject(new Error("IDB busy")) : o.get(...a)) : (o as never)[k]) }) as WalletStore;
  const f = depositFollows({
    network: () => "testnet",
    // the first open, the note store's, fails: that body is dead and the next follow of U opens another
    store: async () => (++opens === 2 ? Promise.reject(new Error("open blocked")) : store),
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: (async () => (reads++, status("PROCESSING"))) as unknown as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    locks: () => null,
    now: () => 1_762_400_000_000,
  });
  await f.settle();
  for (let k = 0; k < 50 && reads === 0; k++) await pause(5);
  f.signedOut();
  await f.idle();
  assert.ok(reads > 0, "followed once the store reads");
  // the dead store's pause, then the op's next tries on the new one, the pace kept across the re-follow
  assert.deepEqual(sleeps.slice(0, 4), [1_000, 2_000, 4_000, 8_000], `the pauses: ${sleeps.slice(0, 6).join()}`);
});

test("G3: a refusal of the follow (an op naming no valid deposit) ends that op's follow: no retry", async () => {
  const t = await world(["PROCESSING"]);
  await t.w.put("ops", "bad", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 1, follow: { ...FOLLOW, min_out: "1" } });
  await t.f.settle();
  const ended = await Promise.race([t.f.idle().then(() => true), pause(500).then(() => false)]);
  t.f.signedOut();
  await t.f.idle();
  assert.ok(ended, "the refused op's follow is retried forever");
  assert.equal(t.reads(), 0);
});

test("a done op is followed until its quote's deadline is past on both RPCs, then marked final and no landing follows it again", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  const note = await ns.planDeposit(9n, () => 123n);
  await w.put("ops", "dq-1", { kind: "deposit", stage: "done", txs: [], created_ms: 1, since_ms: 5, amount_usd: "2", follow: { ...FOLLOW, status: "SUCCESS", sent: true, delivered: "2000000", notes: [note.id], bound: "2000000" } });
  let blockMs = FOLLOW.deadline_ms - 60_000;
  // U's USDC reads 0 on both RPCs at one block: nothing left to bind, so final waits only on the deadline
  const rpcs = (): readonly [FollowRpc, FollowRpc] => {
    const one = (name: string): FollowRpc => ({ name, query: async (p) => (p.method_name === "ft_balance_of" ? { result: { block_height: 100, result: [...Buffer.from(JSON.stringify("0"))] } } : {}), tx: async () => ({}), block: async () => ({ result: { header: { timestamp_nanosec: (BigInt(blockMs) * 1_000_000n).toString() } } }) });
    return [one(NEAR_NETWORKS.testnet.fastnear[0]), one(NEAR_NETWORKS.testnet.drpc)];
  };
  const f = depositFollows({ network: () => "testnet", store: async () => w, seed64: async () => Uint8Array.from(SEED), rpcs, fetch: (async () => status("SUCCESS")) as unknown as typeof fetch, sleep: () => pause(5) as Promise<void>, locks: () => null, now: () => 1_762_400_000_000 });
  await f.settle();
  const early = await Promise.race([f.idle().then(() => true), pause(150).then(() => false)]);
  assert.equal(early, false, "a done op before its deadline is still followed");
  blockMs = FOLLOW.deadline_ms + 1;
  await Promise.race([f.idle(), pause(2_000)]);
  const op = (await w.get("ops", "dq-1")) as { stage: string; follow: { final?: true } };
  assert.equal(op.stage, "done");
  assert.equal(op.follow.final, true);
  let again = 0;
  const g = depositFollows({ network: () => "testnet", store: async () => w, seed64: async () => Uint8Array.from(SEED), rpcs, fetch: (async () => (again++, status("SUCCESS"))) as unknown as typeof fetch, sleep: () => pause(5) as Promise<void>, locks: () => null, now: () => 1_762_400_000_000 });
  await g.settle();
  await g.idle();
  f.signedOut();
  assert.equal(again, 0);
});

test("S2b: a follow stuck on the closed connection (a read that never ends) when the store reopens: the new follow opens U's note store on the new connection, never the old one", async () => {
  const idb = new IDBFactory();
  const h1 = await openWalletStore({ indexedDB: idb });
  closers.push(() => h1.close());
  await h1.put("ops", "dq-1", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 1, follow: { ...FOLLOW, sent: true } });
  let gets = 0;
  let release!: () => void;
  const held = new Promise<void>((ok) => (release = ok));
  const stuck = new Proxy(h1, { get: (o, k) => (k === "get" ? async (...a: [never, string]) => (a[1] === "dq-1" && ++gets === 2 ? held.then(() => o.get(...a)) : o.get(...a)) : (o as never)[k]) }) as WalletStore;
  let cur: WalletStore = stuck;
  let reads = 0;
  const f = depositFollows({
    network: () => "testnet",
    store: async () => cur,
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: (async () => (reads++, status("PROCESSING"))) as unknown as typeof fetch,
    sleep: () => pause(5) as Promise<void>,
    locks: () => null,
    now: () => 1_762_400_000_000,
  });
  await f.settle();
  await pause(30);
  assert.equal(reads, 0, "the first follow is stuck on its read");
  h1.close();
  f.storeClosed();
  const h2 = await openWalletStore({ indexedDB: idb });
  closers.push(() => h2.close());
  cur = h2;
  await f.settle();
  await pause(150);
  const seen = reads;
  f.signedOut();
  release();
  await f.idle();
  assert.ok(seen > 0, "the deposit is not followed on the new connection");
});

test("D1: two ops of one U whose note store never opened: both are followed again, on a new one", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  const B = "c".repeat(64);
  await w.put("ops", "dq-1", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 1, follow: { ...FOLLOW, sent: true } });
  await w.put("ops", "dq-2", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 2, follow: { ...FOLLOW, address: B, sent: true } });
  let opens = 0;
  const asked = new Set<string>();
  const f = depositFollows({
    network: () => "testnet",
    // settle's read is the first; the note store's open, the second, fails a little later, once both ops wait on it
    store: async () => (++opens === 2 ? pause(30).then(() => Promise.reject(new Error("open blocked"))) : w),
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: (async (url: string) => (asked.add(new URL(url).searchParams.get("depositAddress")!), status("PROCESSING"))) as unknown as typeof fetch,
    sleep: async () => {},
    locks: () => null,
    now: () => 1_762_400_000_000,
  });
  await f.settle();
  for (let k = 0; k < 100 && asked.size < 2; k++) await pause(5);
  f.signedOut();
  await f.idle();
  assert.deepEqual([...asked].sort(), [ADDR, B].sort());
});

test("G2b: a sign out ends a follow in its retry pause at once, so U's lock goes with it", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.put("ops", "dq-1", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 1, follow: { ...FOLLOW, sent: true } });
  let gets = 0;
  let paused = false;
  const store = new Proxy(w, { get: (o, k) => (k === "get" ? async (...a: [never, string]) => (a[1] === "dq-1" && ++gets >= 2 ? Promise.reject(new Error("IDB busy")) : o.get(...a)) : (o as never)[k]) }) as WalletStore;
  const f = depositFollows({
    network: () => "testnet",
    store: async () => store,
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: (async () => status("PROCESSING")) as unknown as typeof fetch,
    sleep: () => ((paused = true), new Promise<void>(() => {})), // a pause that never ends by itself
    locks: () => navigator.locks,
    now: () => 1_762_400_000_000,
  });
  await f.settle();
  for (let k = 0; k < 100 && !paused; k++) await pause(5);
  assert.ok(paused);
  f.signedOut();
  const ended = await Promise.race([f.idle().then(() => true), pause(300).then(() => false)]);
  assert.ok(ended, "the stopped follow waited out its pause");
  await pause(20);
  assert.ok(!(await navigator.locks.query()).held!.some((l) => l.name === `${FOLLOW_LOCK}testnet/${U}`), "U's lock is still held");
});

test("G2c: a note store that never opens is retried at a pace that doubles across the op's re-follows, to the cap, never every second", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.put("ops", "dq-1", { kind: "deposit", stage: "in_transit", txs: [], created_ms: 1, follow: { ...FOLLOW, sent: true } });
  let opens = 0;
  const sleeps: number[] = [];
  const f = depositFollows({
    network: () => "testnet",
    // settle's read is the first; every open of U's note store after it fails
    store: async () => (++opens === 1 ? w : Promise.reject(new Error("open blocked"))),
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: (async () => status("PROCESSING")) as unknown as typeof fetch,
    // nine pauses, then a sign out; each pause a turn of the event loop, as a timer is
    sleep: async (ms) => (sleeps.push(ms), sleeps.length >= 9 && f.signedOut(), await new Promise<void>((ok) => setImmediate(ok))),
    locks: () => null,
    now: () => 1_762_400_000_000,
  });
  await f.settle();
  for (let k = 0; k < 200 && sleeps.length < 9; k++) await pause(5);
  await f.idle();
  assert.deepEqual(sleeps.slice(0, 9), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000], `the pauses: ${sleeps.slice(0, 9).join()}`);
});

// ---------- audit V-01 (card wallet-near-prepay-taken): a stranger takes P after the relayer's prepay ----------
for (const [what, lose] of [["", null], [", the first call's answer lost and the call carried 3 blocks later", 3n]] as const)
test(`V-01 on SIGN_HOST: a stranger naming U takes P at the quote's min${what}; U's refund lands on P' with no tap, both notes the user's, the op only U's own`, async () => {
  const { V01World, CREDIT, MIN_OUT } = await import("../../wallet/test/prepay-taken-world.ts");
  const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
  const { usdOf } = await import("../../wallet/src/deposit/follow.ts");
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  const notes = await openNoteStore(w);
  closers.push(() => notes.close());
  const note = await notes.planDeposit(1n, (ref) => noteSecrets(SEED, ref).precommitment);
  const i = (note.ref as { i: number }).i;
  const u = depositAccount(SEED, 1n, i).account;
  const v01 = new V01World(u, { depositor: u, value: BigInt(MIN_OUT) });
  v01.balance = CREDIT;
  v01.loseFirst = lose;
  const sleeps: number[] = [];
  const f = depositFollows({
    network: () => "testnet",
    store: async () => w,
    seed64: async () => Uint8Array.from(SEED),
    rpcs: () => v01.rpcs(),
    fetch: v01.fetchFn,
    // a block a pause, and 10 min of block time, so the quote's deadline passes and the follow ends (untilFinal)
    sleep: async (ms) => (sleeps.push(ms), v01.tick(), (v01.timeMs += 600_000), await new Promise<void>((ok) => setImmediate(ok))),
    locks: () => null,
    now: () => 1_762_400_000_000,
  });
  await f.quoted("dq-v01", RESULT, { scope: 1n, index: i, u });
  for (let k = 0; k < 400 && ((await w.get("ops", "dq-v01")) as { follow: { final?: true } }).follow.final !== true; k++) await new Promise((ok) => setTimeout(ok, 5));
  f.signedOut();
  await f.idle();
  const op = (await w.get("ops", "dq-v01")) as { stage: string; amount_usd: string; follow: { final?: true; notes: string[] } };
  const P2 = noteSecrets(SEED, { kind: "second", id: { id: "U", s: 1n, i }, n: 0 }).precommitment;
  assert.equal(op.stage, "done");
  assert.equal(op.follow.final, true);
  assert.deepEqual(v01.carried.map((c) => [c.fate, c.p]), [["refunded", note.precommitment], ["landed", P2]], "U's call on P refunded, then landed on P'");
  assert.deepEqual(v01.prepays, [note.precommitment, P2]);
  assert.ok(!v01.answers.some((a) => a === "bad_nonce" || a === "in_flight"), `nothing signed while U's call on P was out: ${v01.answers.join()}`);
  assert.equal(v01.balance, 0n, "nothing waits in U");
  assert.equal(op.amount_usd, usdOf(CREDIT), "the op shows U's own deposit, never the stranger's");
  const all = await notes.list();
  assert.deepEqual(op.follow.notes, [all.find((n) => n.precommitment === P2)!.id]);
  assert.deepEqual(all.map((n) => [n.state, n.leaf?.value]).sort(), [["UNSPENT", BigInt(MIN_OUT)], ["UNSPENT", CREDIT]], "the stranger's note on our P is the user's");
});
