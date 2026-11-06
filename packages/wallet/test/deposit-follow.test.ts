// The device follows a deposit from its checked address to its note with no tap (card wallet-deposit-follow; wallet.md
// §2.4 steps 4-9 and point 8, APU-04).
//   node --test test/deposit-follow.test.ts   (from packages/wallet)
// 1Click's status answers are the recorded live answer's quoteResponse (packages/kit/test/fixtures/oneclick-quotes.json,
// "live", status SUCCESS, read 2026-11-01T00:57Z) under the status answer's top-level keys as recorded keyless on
// 2026-10-22 (research proofs/pr3-1click-status-echo: correlationId, quoteResponse, status, swapDetails, updatedAt),
// with this test's address and U in it and each status set. The chain is a mock behind the testnet pair: U's reads are
// test/vectors/deposit-account.json's real answers (replay-deposit-reads.ts), the vault's pages
// test/vectors/deposit-bind-pages.json's real testnet pages with rows the test sets, each side its own height, rows, U's
// USDC and block time. The note store and the ops store are the real ones on fake-indexeddb. Test secrets come from the
// first published BIP-39 vector (all-zero entropy).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import type { DepositStage } from "@blindfill/kit";
import { base58 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { decodeSignedDelegate } from "../../../apps/helper/src/bind/checks.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { depositAccount, NEAR_NETWORKS, type NearRpc } from "../src/deposit/account.ts";
import { type BindOutcome, bindDeposit, resetBindSession } from "../src/deposit/bind.ts";
import { RELEASE_BIND_URL } from "../src/deposit/delegate.ts";
import { DEPOSIT_STATUS_URL, type DepositOp, type FollowArgs, type FollowDeps, followDeposit, type FollowRpc, ONECLICK_STATUSES, type OneClickStatus, readDepositStatus, STATUS_STAGE, usdOf } from "../src/deposit/follow.ts";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { replayDepositReads } from "./replay-deposit-reads.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const PAGES = JSON.parse(readFileSync(new URL("./vectors/deposit-bind-pages.json", import.meta.url), "utf8"));
const LIVE = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/oneclick-quotes.json", import.meta.url), "utf8")).live.answer;
const NET = NEAR_NETWORKS.testnet;
const VAULT = NET.vault!;
assert.equal(PAGES.vault, VAULT);
const ADDR = LIVE.quote.depositAddress as string;
const CREDIT = 2_003_117n; // the live quote's amountOut: what 1Click delivered to U
const DEADLINE = Date.parse(LIVE.quote.deadline);
const RELAYER = "bind.blindfill-test.testnet";
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const publicKeyOf = (u: string) => `ed25519:${base58.encode(Uint8Array.from(u.match(/../g)!, (h) => parseInt(h, 16)))}`;
const turn = () => new Promise<void>((ok) => setImmediate(ok));

/** A recorded status answer for `status`, naming `addr`, with recipient and refund `u`. */
function statusAnswer(status: string, u: string, addr = ADDR, edit: (j: any) => void = () => {}) {
  const quoteResponse = structuredClone(LIVE);
  quoteResponse.quote.depositAddress = addr;
  quoteResponse.quoteRequest.recipient = u;
  quoteResponse.quoteRequest.refundTo = u;
  quoteResponse.quoteRequest.refundType = "INTENTS";
  const j = { correlationId: "f7c38c72-b112-42fd-986f-9705977fcf61", quoteResponse, status, swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] }, updatedAt: "2026-10-31T21:06:00.000Z" };
  edit(j);
  return j;
}

// ---------- the mock chain ----------
type Row = { index: number; precommitment: string; label: string; value: string; leaf_index: number; depositor: string };
type Side = { height: bigint; nonce: bigint; rows: Row[]; balance: bigint; timeMs: number };
class Chain {
  a: Side;
  b: Side;
  readonly u: string;
  constructor(u: string, height = 275753808n, nonce = 275753000000001n) {
    this.u = u;
    this.a = { height, nonce, rows: [], balance: 0n, timeMs: DEADLINE - 3_600_000 };
    this.b = { height: height + 1n, nonce, rows: [], balance: 0n, timeMs: DEADLINE - 3_600_000 };
  }
  tick = () => (this.a.height++, this.b.height++);
  credit(v: bigint, side?: "a" | "b") {
    for (const s of side === undefined ? [this.a, this.b] : [this[side]]) s.balance = v;
  }
  addRow(p: bigint, { depositor = this.u, value, side }: { depositor?: string; value: bigint; side?: "a" | "b" }) {
    for (const s of side === undefined ? [this.a, this.b] : [this[side]]) {
      const index = s.rows.length;
      s.rows.push({ index, precommitment: p.toString(), label: (1000n + BigInt(index)).toString(), value: value.toString(), leaf_index: 2 * index, depositor });
    }
  }
  rpcs(): [FollowRpc, FollowRpc] {
    const replay = replayDepositReads("testnet", publicKeyOf(this.u));
    const side = (k: "a" | "b", r: NearRpc): FollowRpc => ({
      name: r.name,
      tx: async () => ({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }),
      block: async () => ({ jsonrpc: "2.0", id: "x", result: { header: { height: Number(this[k].height), timestamp_nanosec: (BigInt(this[k].timeMs) * 1_000_000n).toString() } } }),
      query: async (params) => {
        const s = this[k];
        const at = params.block_id === undefined ? s.height : BigInt(params.block_id as number);
        if (at > s.height) return { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } };
        const stamp = (j: any) => ((j.result.block_height = Number(at)), (j.result.block_hash = `h${at}`), j);
        if (params.method_name === "deposits" || params.method_name === "state_tree" || params.method_name === "label_tree") {
          const j = structuredClone(PAGES.answers[k].json);
          if (params.method_name === "deposits") {
            const { from, limit } = JSON.parse(Buffer.from(params.args_base64 as string, "base64").toString());
            j.result.result = [...Buffer.from(JSON.stringify(s.rows.slice(from, from + limit)))];
          } else j.result.result = [...Buffer.from(JSON.stringify({ size: s.rows.length, depth: 20, root: "0" }))];
          return stamp(j);
        }
        const j = stamp((await r.query(params)) as any);
        if (params.request_type === "view_access_key_list") {
          j.result.keys[0].public_key = publicKeyOf(this.u);
          j.result.keys[0].access_key.nonce = Number(s.nonce);
        }
        if (params.method_name === "ft_balance_of") j.result.result = [...Buffer.from(JSON.stringify(s.balance.toString()))];
        return j;
      },
    });
    return [side("a", replay[0]), side("b", replay[1])];
  }
}

// ---------- the stores ----------
const opened: WalletStore[] = [];
const stores: NoteStore[] = [];
after(() => (opened.forEach((s) => s.close()), stores.forEach((n) => n.close())));
beforeEach(() => resetBindSession());

/** 1Click's statuses the helper answers, in turn (the last one repeats); every request's URL kept. */
function oneClick(u: string, script: (OneClickStatus | { raw: unknown; http?: number })[]) {
  const urls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    assert.equal(init?.method, "POST"); // the helper's proxy route (a GET answers 405, read live 6 Nov 15:45Z)
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.body, undefined); // nothing leaves but the address in the URL
    const next = script.length > 1 ? script.shift()! : script[0]!;
    if (typeof next === "string") return Response.json(statusAnswer(next, u));
    return Response.json(next.raw, { status: next.http ?? 200 });
  }) as typeof fetch;
  return { urls, fetchFn };
}

async function setup(script: (OneClickStatus | { raw: unknown; http?: number })[], over: Partial<FollowDeps> = {}) {
  const idb = new IDBFactory();
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  const store = await openNoteStore(w);
  stores.push(store);
  const note = await store.planDeposit(1n, pc);
  const i = (note.ref as { i: number }).i;
  const u = depositAccount(SEED, 1n, i).account;
  const chain = new Chain(u);
  const oc = oneClick(u, script);
  const stages: DepositStage[] = [];
  const binds: { noteId: string; amount: bigint }[] = [];
  // the bind (bind.ts) as a spy: the call lands, U's USDC goes into the vault and both RPCs' pages hold P for U
  const bind: typeof bindDeposit = async (_seed, a) => {
    binds.push({ noteId: a.noteId, amount: a.amount });
    const n = (await store.get(a.noteId))!;
    chain.addRow(n.precommitment, { value: a.amount });
    chain.credit(0n);
    if (n.state === "PLANNED") await store.move(a.noteId, "PLANNED", "INCOMING");
    const r = chain.a.rows.at(-1)!;
    const leaf = { value: a.amount, label: BigInt(r.label), commitment: noteCommitment(a.amount, BigInt(r.label), n.precommitment), leafIndex: BigInt(r.leaf_index) };
    return { kind: "deposited", note: await store.move(a.noteId, "INCOMING", "UNSPENT", { leaf }) } as BindOutcome;
  };
  const args: FollowArgs = { opId: "dq-1", network: "testnet", s: 1n, i, address: ADDR, deadline_ms: DEADLINE };
  let ticks = 0;
  const onTick: { fn: (n: number) => void } = { fn: () => {} };
  const deps: FollowDeps = {
    ops: w,
    store,
    rpcs: chain.rpcs(),
    fetchFn: oc.fetchFn,
    sleep: async () => (chain.tick(), onTick.fn(++ticks), await turn()),
    signal: AbortSignal.timeout(20_000),
    // every stage as SIGN_HOST answers it must be one the kit's client reads (kit schema.ts depositConfirm)
    onStage: (s, f) => (assert.ok(SIGNPAGE_RESULT_SCHEMAS["deposit.confirm"]({ stage: s, ...f }), `the kit refuses ${JSON.stringify({ stage: s, ...f })}`), stages.push(s)),
    bind,
    relayerAccount: RELAYER,
    now: () => 1_762_400_000_000,
    ...over,
  };
  return { w, store, note, i, u, chain, oc, stages, binds, args, deps, onTick, idb, ticks: () => ticks };
}
const opOf = async (w: WalletStore, id = "dq-1") => (await w.get("ops", id)) as DepositOp;

// ---------- the status read ----------
test("APU-04: each of 1Click's seven statuses maps to its stage", () => {
  assert.deepEqual(Object.keys(STATUS_STAGE).sort(), [...ONECLICK_STATUSES].sort());
  assert.deepEqual(STATUS_STAGE, {
    PENDING_DEPOSIT: "quote_checked",
    KNOWN_DEPOSIT_TX: "waiting",
    PROCESSING: "in_transit",
    INCOMPLETE_DEPOSIT: "short",
    SUCCESS: "in_transit", // into_vault only once U's credit reads on two RPCs
    REFUNDED: "refunded",
    FAILED: "failed",
  });
});

test("the status is read through the helper's keyed proxy, naming the address only; a hostile answer is no read", async () => {
  const u = "a".repeat(64);
  for (const st of ONECLICK_STATUSES) {
    const oc = oneClick(u, [st]);
    assert.equal(await readDepositStatus(ADDR, u, oc.fetchFn), st);
    assert.deepEqual(oc.urls, [`${DEPOSIT_STATUS_URL}?depositAddress=${ADDR}`]);
    assert.ok(DEPOSIT_STATUS_URL.startsWith("https://api.confidential.unrealized.trade/v1/proxy/oneclick/"));
  }
  const bad: [string, unknown, number?][] = [
    ["another address", statusAnswer("SUCCESS", u, "b".repeat(64))],
    ["another recipient", statusAnswer("SUCCESS", u, ADDR, (j) => (j.quoteResponse.quoteRequest.recipient = "c".repeat(64)))],
    ["another refund", statusAnswer("SUCCESS", u, ADDR, (j) => (j.quoteResponse.quoteRequest.refundTo = "c".repeat(64)))],
    ["an unknown status", statusAnswer("DONE", u)],
    ["no quote", statusAnswer("SUCCESS", u, ADDR, (j) => delete j.quoteResponse)],
    ["keyless 404", { statusCode: 404, message: "not found" }, 404],
    ["a 500", statusAnswer("SUCCESS", u), 500],
  ];
  for (const [what, raw, http] of bad) assert.equal(await readDepositStatus(ADDR, u, oneClick(u, [{ raw, http }]).fetchFn), null, what);
  const big = (async () => new Response("x".repeat(70_000))) as unknown as typeof fetch;
  assert.equal(await readDepositStatus(ADDR, u, big), null, "an answer over the cap");
});

// ---------- the follow ----------
test("the address to the note with no tap: waiting, in transit, into the vault, done once both RPCs hold the note UNSPENT", async () => {
  const t = await setup(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  t.onTick.fn = (n) => n === 3 && t.chain.credit(CREDIT); // 1Click delivers to U on the token
  const out = await followDeposit(SEED, t.args, t.deps);
  assert.equal(out.kind, "done");
  assert.deepEqual(t.stages, ["waiting", "in_transit", "into_vault", "done"]);
  assert.deepEqual(t.binds, [{ noteId: t.note.id, amount: CREDIT }]);
  const op = await opOf(t.w);
  assert.equal(op.stage, "done");
  assert.equal(op.amount_usd, "2.003117");
  assert.equal(op.since_ms, 1_762_400_000_000);
  assert.equal((await t.store.get(t.note.id))!.state, "UNSPENT");
});

test("planted: done is never shown before both RPCs' pages hold the note; one RPC's row is no read", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const spy = t.deps.bind!;
  let held = 0;
  // the bind says deposited, but only RPC a's pages hold the row; b gets it six ticks later
  const bind: typeof bindDeposit = async (s, a, dps) => {
    const out = await spy(s, a, dps);
    t.chain.b.rows.pop();
    t.onTick.fn = (n) => {
      if (++held === 6) t.chain.addRow(t.note.precommitment, { value: CREDIT, side: "b" });
    };
    return out;
  };
  const p = followDeposit(SEED, t.args, { ...t.deps, bind });
  const out = await p;
  assert.equal(out.kind, "done");
  assert.ok(held >= 6, "done waited for RPC b's row");
  assert.equal(t.stages.at(-1), "done");
});

test("planted: SUCCESS with U's credit on one RPC only, or under MIN_DEPOSIT, binds nothing; the stage stays in transit", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT, "a"); // RPC b reads 0
  const ac = new AbortController();
  t.onTick.fn = (n) => {
    if (n === 5) t.chain.credit(999_999n); // both agree, but under MIN_DEPOSIT
    if (n === 10) ac.abort(new Error("stop"));
  };
  await assert.rejects(followDeposit(SEED, t.args, { ...t.deps, signal: ac.signal }), /stop/);
  assert.equal(t.binds.length, 0);
  assert.deepEqual(t.stages, ["in_transit"]);
  assert.equal((await opOf(t.w)).follow.amount, undefined);
});

test("short, failed and expired come only from 1Click's status or both RPCs' block time, never a timer; each is shown as it is", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const ac = new AbortController();
  let script: OneClickStatus[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => oneClick(t.u, [script.length > 1 ? script.shift()! : script[0] ?? "PENDING_DEPOSIT"]).fetchFn(url, init)) as typeof fetch;
  t.onTick.fn = (n) => {
    if (n === 30) t.chain.a.timeMs = DEADLINE + 1; // past the deadline on one RPC only
    if (n === 40) t.chain.b.timeMs = DEADLINE + 1; // and on both
    if (n === 45) script = ["KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "FAILED", "PROCESSING"]; // a late send, 1Click's own words
    if (n === 60) ac.abort(new Error("stop"));
  };
  const at: [DepositStage, number][] = [];
  await assert.rejects(followDeposit(SEED, t.args, { ...t.deps, fetchFn, signal: ac.signal, onStage: (s, f) => (t.deps.onStage!(s, f), at.push([s, t.ticks()])) }), /stop/);
  assert.deepEqual(at.map(([s]) => s), ["expired", "waiting", "short", "failed", "in_transit"]);
  assert.equal(at[0]![1], 40, "expired only once both RPCs' block time is past the deadline");
  const op = await opOf(t.w);
  assert.equal(op.stage, "in_transit");
  assert.equal(t.binds.length, 0);
});

test("a stale answer never takes the stage back, and an answer for another address moves nothing", async () => {
  const t = await setup(["PROCESSING", "KNOWN_DEPOSIT_TX", { raw: statusAnswer("REFUNDED", "a".repeat(64)) }, "PENDING_DEPOSIT"]);
  const ac = new AbortController();
  t.onTick.fn = (n) => n === 6 && ac.abort(new Error("stop"));
  await assert.rejects(followDeposit(SEED, t.args, { ...t.deps, signal: ac.signal }), /stop/);
  assert.deepEqual(t.stages, ["in_transit"]);
});

test("REFUNDED: refunded under U, never done; with the refund move, refund_move then its legs, done only once the leaf is read", async () => {
  const t = await setup(["PROCESSING", "REFUNDED"]);
  assert.deepEqual(await followDeposit(SEED, t.args, t.deps), { kind: "refunded" });
  assert.deepEqual(t.stages, ["in_transit", "refunded"]);
  let op = await opOf(t.w);
  assert.equal(op.stage, "refunded");
  assert.equal(op.held_id, t.u);
  assert.equal(t.binds.length, 0);

  // a reload with the refund move given: it runs from refunded, and done waits for the pages on both RPCs
  const order: string[] = [];
  const refundMove = async (u: string) => {
    assert.equal(u, t.u);
    order.push("move");
    t.onTick.fn = (n) => n % 3 === 0 && t.chain.credit(CREDIT);
  };
  const spy = t.deps.bind!;
  const bind: typeof bindDeposit = async (...a) => (order.push("bind"), spy(...a));
  const out = await followDeposit(SEED, t.args, { ...t.deps, refundMove, bind, onStage: (s, f) => (t.deps.onStage!(s, f), order.push(s)) });
  assert.equal(out.kind, "done");
  assert.deepEqual(order, ["refund_move", "move", "in_transit", "into_vault", "bind", "done"]);
  op = await opOf(t.w);
  assert.equal(op.stage, "done");
  assert.equal(op.refunded, true);
  assert.equal(op.held_id, undefined);
});

test("the bind stops (struck or a relayer check): held, the money under U for withdraw.open", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const out = await followDeposit(SEED, t.args, { ...t.deps, bind: async () => ({ kind: "struck", account: t.u }) });
  assert.deepEqual(out, { kind: "held", why: "sender_struck" });
  const op = await opOf(t.w);
  assert.equal(op.stage, "held");
  assert.equal(op.held_id, t.u);
});

test("a front-run on P: that note lands with its leaf, and what U still holds goes on U's next second-arrival note", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const spy = t.deps.bind!;
  let first = true;
  const bind: typeof bindDeposit = async (s, a, dps) => {
    if (!first) return spy(s, a, dps);
    first = false;
    // another's dust deposit names P first: the pages hold P with another depositor; U's USDC stays
    const n = (await t.store.get(a.noteId))!;
    t.chain.addRow(n.precommitment, { value: 1_000_000n, depositor: "e".repeat(64) });
    await t.store.move(a.noteId, "PLANNED", "INCOMING");
    const leaf = { value: 1_000_000n, label: 1000n, commitment: noteCommitment(1_000_000n, 1000n, n.precommitment), leafIndex: 0n };
    return { kind: "front_run", note: await t.store.move(a.noteId, "INCOMING", "UNSPENT", { leaf }) };
  };
  const out = await followDeposit(SEED, t.args, { ...t.deps, bind });
  assert.equal(out.kind, "done");
  assert.deepEqual((out as { note: { ref: unknown } }).note.ref, { kind: "second", id: { id: "U", s: 1n, i: t.i }, n: 0 });
  const op = await opOf(t.w);
  assert.equal(op.follow.note, 0);
  assert.equal(op.amount_usd, usdOf(CREDIT));
});

test("a reload at into_vault resumes the bind on the same note at the same amount, with no status read and no new note", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const ac = new AbortController();
  const stuck: typeof bindDeposit = async (_s, a) => {
    t.binds.push({ noteId: a.noteId, amount: a.amount });
    ac.abort(new Error("page reloaded"));
    throw new Error("page reloaded");
  };
  await assert.rejects(followDeposit(SEED, t.args, { ...t.deps, bind: stuck, signal: ac.signal }), /page reloaded/);
  assert.equal((await opOf(t.w)).stage, "into_vault");
  const before = t.oc.urls.length;
  t.chain.credit(CREDIT + 5_000_000n); // another arrival into U since: the note's amount is still the one written
  const out = await followDeposit(SEED, t.args, t.deps);
  assert.equal(out.kind, "done");
  assert.equal(t.oc.urls.length, before, "no status read after the credit");
  assert.deepEqual(t.binds, [{ noteId: t.note.id, amount: CREDIT }, { noteId: t.note.id, amount: CREDIT }]);
  assert.equal((await t.store.list()).length, 1);
});

test("an op of another deposit under the same id is refused, never followed", async () => {
  const t = await setup(["SUCCESS"]);
  await t.w.put("ops", "dq-1", { kind: "deposit", stage: "waiting", txs: [], created_ms: 1, follow: { network: "testnet", s: "1", i: t.i, address: "f".repeat(64), deadline_ms: DEADLINE } });
  await assert.rejects(followDeposit(SEED, t.args, t.deps), /another deposit/);
});

// ---------- with bind.ts itself: a reload never signs a second call at a new nonce ----------
type Sent = { nonce: bigint; p: bigint };
test("reload mid-bind with bind.ts: the call already out is settled, no second call at a new nonce, done once it lands", async () => {
  const t = await setup(["SUCCESS"], { bind: bindDeposit });
  t.chain.credit(CREDIT);
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(DEPOSIT_STATUS_URL)) return t.oc.fetchFn(url, init);
    assert.equal(url, RELEASE_BIND_URL);
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(Object.keys(body), ["signed_delegate"]);
    const dl = decodeSignedDelegate(new Uint8Array(Buffer.from(body.signed_delegate, "base64")));
    const fc = dl.actions[0] as { args: Uint8Array };
    sent.push({ nonce: dl.nonce, p: BigInt(JSON.parse(JSON.parse(Buffer.from(fc.args).toString()).msg).precommitment) });
    throw new TypeError("fetch failed"); // the answer is lost: the call may be out
  }) as typeof fetch;
  const ac = new AbortController();
  t.onTick.fn = () => sent.length > 0 && ac.abort(new Error("page reloaded"));
  await assert.rejects(followDeposit(SEED, t.args, { ...t.deps, fetchFn, signal: ac.signal }), /page reloaded/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.nonce, t.chain.a.nonce + 1n);
  assert.equal((await opOf(t.w)).stage, "into_vault");

  // the reload: a new tab session; the relayer had carried the call, which lands a few blocks on
  resetBindSession();
  let n = 0;
  t.onTick.fn = () => {
    if (++n === 4) {
      t.chain.a.nonce = t.chain.b.nonce = sent[0]!.nonce;
      t.chain.credit(0n);
      t.chain.addRow(sent[0]!.p, { value: CREDIT });
    }
  };
  const out = await followDeposit(SEED, t.args, { ...t.deps, fetchFn });
  assert.equal(out.kind, "done");
  assert.equal(sent.length, 1, `a second call at nonce ${sent[1]?.nonce} after the reload`);
  assert.equal((await t.store.get(t.note.id))!.state, "UNSPENT");
  assert.equal((await opOf(t.w)).stage, "done");
});
