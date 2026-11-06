// The deposit's follow on SIGN_HOST (card wallet-deposit-follow, src/deposit-follow.ts), with the wallet's real store on
// fake-indexeddb and 1Click's status answered by a script (the recorded live answer's quoteResponse,
// packages/kit/test/fixtures/oneclick-quotes.json, with this test's U): deposit.quote's checked answer writes the op
// and starts the follow with no tap; a refused quote writes none; deposit.confirm answers the op's stage and facts as
// the kit reads them and each later stage as its progress; an unknown address is not_allowed; settle() resumes every
// op not at an end and leaves done, refunded and held; a sign out stops the follows.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { Stage } from "../../kit/src/signpage/messages.ts";
import { depositAccount, NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";
import type { FollowRpc } from "../../wallet/src/deposit/follow.ts";
import * as d from "../../wallet/src/derive/index.ts";
import type { KindContext } from "../src/api.ts";
import { depositFollows, FOLLOW_ENDS } from "../src/deposit-follow.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const LIVE = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/oneclick-quotes.json", import.meta.url), "utf8")).live.answer;
const ADDR = LIVE.quote.depositAddress as string;
const U = depositAccount(SEED, 1n, 0).account;
const RESULT = { deposit_address: ADDR, origin_asset: "nep141:wrap.near", amount_in: "452500000000000000000000", min_amount_out: "1983085", deadline: LIVE.quote.deadline, time_estimate_s: 20 };

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
const status = (s: string) => {
  const q = structuredClone(LIVE);
  q.quoteRequest.recipient = q.quoteRequest.refundTo = U;
  return Response.json({ correlationId: "x", quoteResponse: q, status: s, swapDetails: {}, updatedAt: "2026-10-31T21:06:00.000Z" });
};
// no chain read is reached on these stages; a block read says the deadline is far
const RPCS = (): readonly [FollowRpc, FollowRpc] => {
  const one = (name: string): FollowRpc => ({ name, query: async () => ({}), tx: async () => ({}), block: async () => ({ result: { header: { timestamp_nanosec: "1" } } }) });
  return [one(NEAR_NETWORKS.testnet.fastnear[0]), one(NEAR_NETWORKS.testnet.drpc)];
};

async function world(script: string[]) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  let reads = 0;
  const fetchFn = (async () => status(script.length > 1 ? script.shift()! : script[0]!)).bind(null) as unknown as typeof fetch;
  const counted = (async (...a: Parameters<typeof fetch>) => (reads++, fetchFn(...a))) as typeof fetch;
  let tick = () => {};
  const f = depositFollows({
    network: () => "testnet",
    store: async () => w,
    seed64: async () => Uint8Array.from(SEED),
    rpcs: RPCS,
    fetch: counted,
    sleep: async () => (tick(), await new Promise<void>((ok) => setImmediate(ok))),
    locks: () => null,
    now: () => 1_762_400_000_000,
  });
  return { w, f, reads: () => reads, onTick: (fn: () => void) => (tick = fn) };
}
const ctxOf = (id: string, seen: Stage[]): KindContext => ({ id, sha: "0".repeat(64), progress: (s) => void seen.push(s) });

test("a checked deposit.quote answer writes the op and follows it with no tap; a refused one writes nothing", async () => {
  const t = await world(["PROCESSING"]);
  let n = 0;
  t.onTick(() => ++n >= 3 && t.f.signedOut());
  const kinds = t.f.withFollow({ "deposit.quote": () => ({ after: Promise.resolve(), answer: () => ({ result: RESULT }) }) }, async () => ({ scope: 1n, index: 0 }));
  const d = (kinds["deposit.quote"] as (p: unknown, c: KindContext) => { after: Promise<unknown>; answer: () => unknown })({}, ctxOf("dq-1", []));
  await d.after;
  assert.deepEqual(d.answer(), { result: RESULT }, "the answer is the quote's, unchanged");
  await t.f.idle();
  const op = (await t.w.get("ops", "dq-1")) as Record<string, any>;
  assert.equal(op.kind, "deposit");
  assert.equal(op.stage, "in_transit", "followed with no tap: 1Click's PROCESSING read");
  assert.deepEqual(op.follow, { network: "testnet", s: "1", i: 0, address: ADDR, deadline_ms: Date.parse(LIVE.quote.deadline) });

  const r = await world(["PROCESSING"]);
  const refused = r.f.withFollow({ "deposit.quote": () => ({ after: Promise.resolve(), answer: () => ({ error: "quote_check_failed" as const }) }) }, async () => ({ scope: 1n, index: 0 }));
  await (refused["deposit.quote"] as (p: unknown, c: KindContext) => { after: Promise<unknown> })({}, ctxOf("dq-2", [])).after;
  assert.deepEqual(await r.w.keys("ops"), []);
  assert.equal(r.reads(), 0);
});

test("a Running deposit.quote stays Running through the wrapper", async () => {
  const t = await world(["PENDING_DEPOSIT"]);
  const kinds = t.f.withFollow({ "deposit.quote": () => ({ running: true, after: Promise.resolve(), answer: () => ({ error: "busy" }) }) as never }, async () => null);
  const d = (kinds["deposit.quote"] as (p: unknown, c: KindContext) => Record<string, unknown>)({}, ctxOf("dq-1", []));
  assert.equal(d.running, true);
});

test("deposit.confirm answers the op's stage and facts as the kit reads them, then each later stage as progress; an unknown address is not_allowed", async () => {
  const t = await world(["KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT"]);
  await t.w.put("ops", "dq-1", { kind: "deposit", stage: "quote_checked", txs: [], created_ms: 1, follow: { network: "testnet", s: "1", i: 0, address: ADDR, deadline_ms: Date.parse(LIVE.quote.deadline) } });
  let n = 0;
  t.onTick(() => ++n >= 4 && t.f.signedOut());
  const seen: Stage[] = [];
  const kinds = t.f.withFollow({}, async () => null);
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

test("settle() resumes every deposit op not at an end; done, refunded and held stay as they are", async () => {
  const t = await world(["PROCESSING"]);
  const f = { network: "testnet", s: "1", i: 0, address: ADDR, deadline_ms: Date.parse(LIVE.quote.deadline) };
  await t.w.put("ops", "open", { kind: "deposit", stage: "waiting", txs: [], created_ms: 1, since_ms: 5, follow: f });
  for (const stage of FOLLOW_ENDS) await t.w.put("ops", `end-${stage}`, { kind: "deposit", stage, txs: [], created_ms: 1, follow: { ...f, address: `${stage}`.padEnd(64, "0") } });
  let n = 0;
  t.onTick(() => ++n >= 2 && t.f.signedOut());
  await t.f.settle();
  await t.f.idle();
  assert.equal(((await t.w.get("ops", "open")) as { stage: string }).stage, "in_transit");
  for (const stage of FOLLOW_ENDS) assert.equal(((await t.w.get("ops", `end-${stage}`)) as { stage: string }).stage, stage);
  assert.equal(t.reads(), 2, "only the open op read 1Click's status");
});
