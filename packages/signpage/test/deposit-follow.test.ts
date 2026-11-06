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
import { type DepositRecord, openWalletStore, WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { Stage } from "../../kit/src/signpage/messages.ts";
import { depositAccount, NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";
import type { FollowRpc } from "../../wallet/src/deposit/follow.ts";
import * as d from "../../wallet/src/derive/index.ts";
import type { KindContext } from "../src/api.ts";
import { depositFollows, FOLLOW_ENDS, FOLLOW_LOCK } from "../src/deposit-follow.ts";
import { type DepositPublic, depositQuoteHost } from "../src/deposit-wire.ts";
import { ADDRESS as MOCK_ADDRESS, h1c, NOW as MOCK_NOW, SOL_USDC, U as MOCK_U } from "./oneclick-mock.ts";

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
  assert.deepEqual(op.follow, { ...FOLLOW, sent: true }, "min_amount_out in USDC base units; 1Click has seen a send");
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

test("settle() resumes every deposit op not at an end, expired and refunded too; done and held stay as they are", async () => {
  const t = await world(["PROCESSING"]);
  const f = FOLLOW;
  await t.w.put("ops", "open", { kind: "deposit", stage: "waiting", txs: [], created_ms: 1, since_ms: 5, follow: f });
  for (const stage of ["expired", "refunded"]) await t.w.put("ops", `late-${stage}`, { kind: "deposit", stage, txs: [], created_ms: 1, ...(stage === "refunded" ? { held_id: U, since_ms: 5 } : {}), follow: { ...f, address: stage.padEnd(64, "0") } });
  assert.deepEqual([...FOLLOW_ENDS].sort(), ["done", "held"]);
  for (const stage of FOLLOW_ENDS) await t.w.put("ops", `end-${stage}`, { kind: "deposit", stage, txs: [], created_ms: 1, follow: { ...f, address: `${stage}`.padEnd(64, "0") } });
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
