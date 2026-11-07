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
import { DepositAccountRefused, depositAccount, HEIGHT_SPREAD_MAX, NEAR_NETWORKS, type NearRpc } from "../src/deposit/account.ts";
import { type BindOutcome, bindDeposit, POLL_MS, resetBindSession } from "../src/deposit/bind.ts";
import { RELEASE_BIND_URL } from "../src/deposit/delegate.ts";
import { DEPOSIT_STATUS_URL, type DepositOp, followEnded, readMoveAt, type FollowArgs, type FollowDeps, type FollowMoveAsk, followDeposit, type FollowRpc, ONECLICK_STATUSES, type OneClickStatus, readCredit, readDepositStatus, STATUS_RETRY_MAX_MS, STATUS_STAGE, usdcUnits, usdOf } from "../src/deposit/follow.ts";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { replayDepositReads } from "./replay-deposit-reads.ts";
import { REFUND_INTENT_WINDOW_MS, type MoveRecord, type RefundMoveResult, versionedNonce } from "../src/deposit/refund.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const PAGES = JSON.parse(readFileSync(new URL("./vectors/deposit-bind-pages.json", import.meta.url), "utf8"));
const LIVE = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/oneclick-quotes.json", import.meta.url), "utf8")).live.answer;
const NET = NEAR_NETWORKS.testnet;
const VAULT = NET.vault!;
assert.equal(PAGES.vault, VAULT);
const ADDR = LIVE.quote.depositAddress as string;
const CREDIT = 2_003_117n; // the live quote's amountOut: what 1Click delivered to U
const DEADLINE = Date.parse(LIVE.quote.deadline);
const MIN_OUT = LIVE.quote.minAmountOut as string; // 1983085: the checked quote's min_amount_out
const ORIGIN = LIVE.quoteRequest.originAsset as string; // what a refund lands as, under U inside intents.near
const INTENTS = "intents.test"; // testnet has no intents contract: the follow's deps name one for the mock
const NOW = 1_762_400_000_000;
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
type Side = { height: bigint; nonce: bigint; rows: Row[]; balance: bigint; held: bigint; timeMs: number; finalLag: bigint };
class Chain {
  a: Side;
  b: Side;
  readonly u: string;
  codeHash: string | null = null;
  heldUsdc = 0n;
  /** The nonces intents.near holds used for U (is_nonce_used), base64; with a height, used only from that block on. */
  used = new Set<string>();
  usedFrom = new Map<string, bigint>();
  /** What U holds of the asset inside intents at a block, when the test sets it per height (else the side's `held`). */
  heldAt: ((k: "a" | "b", at: bigint) => bigint) | null = null;
  /** intents.near's current salt (current_salt). */
  salt = "252812b3";
  /** A block's time by its height, when the test sets it (else the side's `timeMs` for every block). */
  timeAt: ((at: bigint) => number) | null = null;
  constructor(u: string, height = 275753808n, nonce = 275753000000001n) {
    this.u = u;
    this.a = { height, nonce, rows: [], balance: 0n, held: 0n, timeMs: DEADLINE - 3_600_000, finalLag: 0n };
    this.b = { height: height + 1n, nonce, rows: [], balance: 0n, held: 0n, timeMs: DEADLINE - 3_600_000, finalLag: 0n };
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
      block: async (params) => {
        const at = "block_id" in params ? BigInt(params.block_id) : this[k].height;
        if (at > this[k].height) return { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } };
        return { jsonrpc: "2.0", id: "x", result: { header: { height: Number(at), timestamp_nanosec: (BigInt(this.timeAt ? this.timeAt(at) : this[k].timeMs) * 1_000_000n).toString() } } };
      },
      query: async (params) => {
        const s = this[k];
        const at = params.block_id === undefined ? s.height - s.finalLag : BigInt(params.block_id as number);
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
        if (params.method_name === "is_nonce_used") {
          assert.equal(params.account_id, INTENTS);
          const a = JSON.parse(Buffer.from(params.args_base64 as string, "base64").toString());
          assert.equal(a.account_id, this.u);
          assert.equal(Buffer.from(a.nonce, "base64").length, 32);
          const used = this.used.has(a.nonce) || (this.usedFrom.has(a.nonce) && at >= this.usedFrom.get(a.nonce)!);
          return stamp({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify(used))], logs: [] } });
        }
        if (params.method_name === "current_salt") {
          assert.equal(params.account_id, INTENTS);
          return stamp({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify(this.salt))], logs: [] } });
        }
        if (params.method_name === "mt_balance_of") {
          assert.equal(params.account_id, INTENTS);
          const a = JSON.parse(Buffer.from(params.args_base64 as string, "base64").toString());
          assert.equal(a.account_id, this.u);
          // the origin asset's refund, or NEAR USDC's (this.heldUsdc)
          const v = a.token_id === ORIGIN ? (this.heldAt ? this.heldAt(k, at) : s.held) : a.token_id === `nep141:${NET.usdc}` ? this.heldUsdc : assert.fail(`token_id ${a.token_id}`);
          return stamp({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify(v.toString()))], logs: [] } });
        }
        const j = stamp((await r.query(params)) as any);
        if (params.request_type === "view_account" && this.codeHash !== null) j.result.code_hash = this.codeHash;
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
  const args: FollowArgs = { opId: "dq-1", network: "testnet", s: 1n, i, u, address: ADDR, deadline_ms: DEADLINE, origin: ORIGIN, min_out: MIN_OUT };
  const seeds: Uint8Array[] = [];
  const sleeps: number[] = [];
  let ticks = 0;
  const onTick: { fn: (n: number) => void } = { fn: () => {} };
  const deps: FollowDeps = {
    ops: w,
    store,
    rpcs: chain.rpcs(),
    // the seed for a bind phase only: each copy kept, so a test reads how often it opened and that it was zeroed
    seed64: async () => (seeds.push(Uint8Array.from(SEED)), seeds.at(-1)!),
    intents: INTENTS,
    fetchFn: oc.fetchFn,
    sleep: async (ms) => (sleeps.push(ms), chain.tick(), onTick.fn(++ticks), await turn()),
    signal: AbortSignal.timeout(20_000),
    // every stage as SIGN_HOST answers it must be one the kit's client reads (kit schema.ts depositConfirm)
    onStage: (s, f) => (assert.ok(SIGNPAGE_RESULT_SCHEMAS["deposit.confirm"]({ stage: s, ...f }), `the kit refuses ${JSON.stringify({ stage: s, ...f })}`), stages.push(s)),
    bind,
    relayerAccount: RELAYER,
    now: () => NOW,
    ...over,
  };
  return { w, store, note, i, u, chain, oc, stages, binds, args, deps, onTick, idb, seeds, sleeps, ticks: () => ticks };
}
const opOf = async (w: WalletStore, id = "dq-1") => (await w.get("ops", id)) as DepositOp;
/** A refund move as the follow hands it (deps.refundMove): records the move as runRefundMove would (its nonce under the
 *  read salt, its deadline the lower block time + 120 s, the whole balance read), then runs `send`. */
const mover = (send: (u: string, m: MoveRecord, ask: FollowMoveAsk) => Promise<void> | void) => async (ask: FollowMoveAsk): Promise<RefundMoveResult> => {
  const t = ask.reads.map((r) => r.blockTimeNs / 1_000_000n);
  const deadline_ms = Number(t[0]! < t[1]! ? t[0]! : t[1]!) + REFUND_INTENT_WINDOW_MS;
  const m: MoveRecord = { nonce: versionedNonce(ask.salt, deadline_ms), deadline_ms, asset: ask.asset, amount: ask.reads[0].held.toString() };
  await ask.record(m);
  await send(ask.u, m, ask);
  return { kind: "sent", move: m, status: 200 };
};

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
    assert.deepEqual(await readDepositStatus(ADDR, u, oc.fetchFn), { status: st, delivered: null });
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

// ---------- the follow: one follower per U ----------
/** A status answer for `addr` (its own script per address), SUCCESS naming `out` as swapDetails.amountOut when given. */
function perAddress(u: string, scripts: Record<string, (OneClickStatus | [OneClickStatus, bigint])[]>) {
  const reads: string[] = [];
  const fetchFn = (async (url: string) => {
    const addr = new URL(url).searchParams.get("depositAddress")!;
    reads.push(addr);
    const sc = scripts[addr]!;
    const next = sc.length > 1 ? sc.shift()! : sc[0]!;
    const [st, out] = typeof next === "string" ? [next, undefined] : next;
    return Response.json(statusAnswer(st, u, addr, (j) => out !== undefined && (j.swapDetails.amountOut = out.toString())));
  }) as typeof fetch;
  return { fetchFn, reads };
}
const stop = (t: { onTick: { fn: (n: number) => void } }, at: number) => {
  const ac = new AbortController();
  const was = t.onTick.fn;
  t.onTick.fn = (n) => (was(n), n >= at && ac.abort(new Error("stop")));
  return ac.signal;
};

test("the status read carries what 1Click delivered on SUCCESS (swapDetails.amountOut), nothing on other statuses", async () => {
  const u = "a".repeat(64);
  const p = perAddress(u, { [ADDR]: [["SUCCESS", 2_003_117n], ["PROCESSING", 5n]] });
  assert.deepEqual(await readDepositStatus(ADDR, u, p.fetchFn), { status: "SUCCESS", delivered: 2_003_117n });
  assert.deepEqual(await readDepositStatus(ADDR, u, p.fetchFn), { status: "PROCESSING", delivered: null });
});

test("the address to the note with no tap: waiting, in transit, into the vault, done once both RPCs hold the note", async () => {
  const t = await setup(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  t.onTick.fn = (n) => n === 3 && t.chain.credit(CREDIT);
  const out = await followDeposit(t.args, t.deps);
  assert.equal(out.kind, "done");
  assert.deepEqual(t.stages, ["waiting", "in_transit", "into_vault", "done"]);
  assert.deepEqual(t.binds, [{ noteId: t.note.id, amount: CREDIT }]);
  const op = await opOf(t.w);
  assert.equal(op.amount_usd, "2.003117");
  assert.deepEqual(op.follow.notes, [t.note.id]);
  assert.equal((await t.store.get(t.note.id))!.state, "UNSPENT");
});

test("planted: done is never shown before both RPCs' pages hold the note; one RPC's row is no read", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const spy = t.deps.bind!;
  let held = 0;
  const bind: typeof bindDeposit = async (s, a, dps) => {
    const out = await spy(s, a, dps);
    t.chain.b.rows.pop();
    t.onTick.fn = () => ++held === 6 && t.chain.addRow(t.note.precommitment, { value: CREDIT, side: "b" });
    return out;
  };
  const out = await followDeposit(t.args, { ...t.deps, bind });
  assert.equal(out.kind, "done");
  assert.ok(held >= 6, "done waited for RPC b's row");
});

test("planted: U's credit on one RPC only, or under MIN_DEPOSIT, binds nothing", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT, "a");
  t.onTick.fn = (n) => n === 5 && t.chain.credit(999_999n);
  await assert.rejects(followDeposit(t.args, { ...t.deps, signal: stop(t, 10) }), /stop/);
  assert.equal(t.binds.length, 0);
  assert.deepEqual(t.stages, ["in_transit"]);
  assert.equal(t.seeds.length, 0);
});

test("short and failed come only from 1Click; expired only from both RPCs' block time; E3: slow rounds with nothing in flight, chain-only past the deadline", async () => {
  const t = await setup(["PENDING_DEPOSIT", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "FAILED", "PROCESSING"]);
  await assert.rejects(followDeposit(t.args, { ...t.deps, signal: stop(t, 8) }), /stop/);
  assert.deepEqual(t.stages, ["short", "failed", "in_transit"]);
  assert.deepEqual(t.sleeps.slice(0, 3), [15_000, 30_000, 1_000], "nothing in flight: 15 s then 30 s; a send in flight: 1 s");
  assert.ok(t.sleeps.slice(3).every((ms) => ms === 1_000));

  const e = await setup(["PENDING_DEPOSIT"]);
  let clock = NOW;
  e.onTick.fn = (n) => {
    if (n === 2) clock = DEADLINE + 1; // the device's clock alone: no stage
    if (n === 4) e.chain.a.timeMs = DEADLINE + 1; // one RPC
    if (n === 6) (oneSide = e.stages.length), (e.chain.b.timeMs = DEADLINE + 1); // both
  };
  let oneSide = -1;
  await assert.rejects(followDeposit(e.args, { ...e.deps, now: () => clock, signal: stop(e, 12) }), /stop/);
  assert.deepEqual(e.stages, ["expired"]);
  assert.equal(oneSide, 0, "past the deadline on one RPC's block time only: no expired");
  const at = e.oc.urls.length;
  assert.ok(at <= 7, "no status read once past the deadline on both RPCs with no send seen");
  assert.ok(e.sleeps.slice(-3).every((ms) => ms >= 15_000), "chain-only rounds go on, slowly");
});

test("F2: a send that lands after expired is bound and done on a later round (expired is no end)", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1;
  const deps = { ...t.deps, now: () => DEADLINE + 1 };
  t.onTick.fn = (n) => {
    if (n === 3) {
      t.chain.credit(CREDIT); // 1Click delivered the late send
      t.oc.urls.length = 0;
    }
  };
  const script = oneClick(t.u, ["SUCCESS"]);
  const out = await followDeposit(t.args, { ...deps, fetchFn: script.fetchFn });
  assert.equal(out.kind, "done");
  assert.ok(t.stages.includes("expired"));
  assert.deepEqual(t.binds, [{ noteId: t.note.id, amount: CREDIT }]);
});

test("a stale answer never takes the stage back, and an answer for another address moves nothing", async () => {
  const t = await setup(["PROCESSING", "KNOWN_DEPOSIT_TX", { raw: statusAnswer("REFUNDED", "a".repeat(64)) }, "PENDING_DEPOSIT"]);
  await assert.rejects(followDeposit(t.args, { ...t.deps, signal: stop(t, 6) }), /stop/);
  assert.deepEqual(t.stages, ["in_transit"]);
});

test("E4 and N3: refunded only for an op whose own status read REFUNDED and once U's refund reads inside intents.near on both RPCs; a stranger's dust under U shows nothing; it is no end", async () => {
  const t = await setup(["PROCESSING", "PROCESSING", "PROCESSING", "SUCCESS"]);
  t.onTick.fn = (n) => {
    if (n === 2) t.chain.a.held = t.chain.b.held = 1n; // a stranger's dust under U, on both: no op of U read REFUNDED
    if (n === 6) t.chain.credit(CREDIT); // 1Click's real delivery
  };
  const out = await followDeposit(t.args, t.deps);
  assert.equal(out.kind, "done");
  assert.deepEqual(t.stages, ["in_transit", "into_vault", "done"]);
  assert.deepEqual(t.binds.map((b) => b.amount), [CREDIT]);

  // REFUNDED read: the refund on one RPC only is no read; on both, refunded; the rounds go on
  const r = await setup(["REFUNDED"]);
  r.onTick.fn = (n) => {
    if (n === 1) r.chain.a.held = 1n;
    if (n === 4) r.chain.b.held = 1n;
  };
  const between: (string | undefined)[] = [];
  const was = r.onTick.fn;
  r.onTick.fn = (n) => (was(n), between.push(r.stages.at(-1)));
  await assert.rejects(followDeposit(r.args, { ...r.deps, signal: stop(r, 8) }), /stop/);
  assert.deepEqual(between.slice(0, 4), [undefined, undefined, undefined, undefined], "nothing shown while one RPC reads it");
  assert.deepEqual(r.stages, ["refunded"]);
});

test("a refund as NEAR USDC inside intents (U's USDC token id) is read too: refunded", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.heldUsdc = 3_000_000n;
  await assert.rejects(followDeposit(t.args, { ...t.deps, signal: stop(t, 3) }), /stop/);
  assert.equal((await opOf(t.w)).stage, "refunded");
});

test("refunded with the refund move: done once its credit is bound; N8: a move whose debit is not final yet is never sent again, and a pause follows it", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = CREDIT;
  let moves = 0;
  let unsureStage: string | undefined;
  const refundMove = mover(async (u, move) => {
    assert.equal(u, t.u);
    // recorded before it is sent
    assert.deepEqual((await opOf(t.w)).follow.move, move);
    assert.equal(move.deadline_ms, t.chain.a.timeMs + REFUND_INTENT_WINDOW_MS);
    moves++;
    // the move's debit is not final for 5 rounds, and RPC a reads it 2 rounds before RPC b (no read); then U's USDC
    // comes back on the token
    let k = 0;
    t.onTick.fn = () => {
      if (++k === 3) t.chain.a.held = 0n;
      if (k === 5) t.chain.b.held = 0n;
      if (k === 5) unsureStage = t.stages.at(-1);
      if (k === 7) t.chain.credit(CREDIT);
    };
  });
  const out = await followDeposit(t.args, { ...t.deps, refundMove });
  assert.equal(out.kind, "done");
  assert.equal(moves, 1, "sent once");
  assert.ok(t.stages.indexOf("refund_move") >= 0 && t.stages.at(-1) === "done");
  const op = await opOf(t.w);
  assert.equal(op.refunded, true);
  assert.equal(op.follow.move, undefined);
  assert.equal(op.follow.moved, true);
  assert.equal(unsureStage, "refund_move", "through on a read only one RPC gives");
});

test("F6 and E8: a stop during the refund move's credit wait, and a stop right after it is sent: the resume never sends it again", async () => {
  for (const when of ["after", "inside"] as const) {
    const t = await setup(["REFUNDED"]);
    t.chain.a.held = t.chain.b.held = CREDIT;
    let moves = 0;
    const ac = new AbortController();
    const refundMove = mover(() => {
      moves++;
      if (when === "inside") ac.abort(new Error("reload")); // the tab closes as the move goes out
      t.chain.a.held = t.chain.b.held = 0n;
    });
    if (when === "after") t.onTick.fn = (n) => n === 4 && ac.abort(new Error("reload"));
    await assert.rejects(followDeposit(t.args, { ...t.deps, refundMove, signal: ac.signal }), /reload/);
    assert.equal((await opOf(t.w)).follow.move !== undefined, when === "inside", when);
    t.chain.credit(CREDIT);
    t.onTick.fn = () => {};
    assert.equal((await followDeposit(t.args, { ...t.deps, refundMove })).kind, "done", when);
    assert.equal(moves, 1, when);
  }
});

test("held: the bind stops (struck): the money under U for withdraw.open", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const out = await followDeposit(t.args, { ...t.deps, bind: async () => ({ kind: "struck", account: t.u }) });
  assert.deepEqual(out, { kind: "held", why: "sender_struck" });
  const op = await opOf(t.w);
  assert.equal(op.held_id, t.u);
});

test("a front-run on P: that note is never counted, and what U still holds goes on U's next second-arrival note", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const spy = t.deps.bind!;
  let first = true;
  const bind: typeof bindDeposit = async (s, a, dps) => {
    if (!first) return spy(s, a, dps);
    first = false;
    const n = (await t.store.get(a.noteId))!;
    t.chain.addRow(n.precommitment, { value: 1_000_000n, depositor: "e".repeat(64) });
    await t.store.move(a.noteId, "PLANNED", "INCOMING");
    const leaf = { value: 1_000_000n, label: 1000n, commitment: noteCommitment(1_000_000n, 1000n, n.precommitment), leafIndex: 0n };
    return { kind: "front_run", note: await t.store.move(a.noteId, "INCOMING", "UNSPENT", { leaf }) };
  };
  const out = await followDeposit(t.args, { ...t.deps, bind });
  assert.equal(out.kind, "done");
  assert.deepEqual((out as { note: { ref: unknown } }).note.ref, { kind: "second", id: { id: "U", s: 1n, i: t.i }, n: 0 });
  assert.equal((await opOf(t.w)).amount_usd, usdOf(CREDIT));
});

test("a reload mid-bind binds the same note (nothing signed for it yet) at U's credit read again, with no new note", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const ac = new AbortController();
  const stuck: typeof bindDeposit = async (_s, a) => {
    t.binds.push({ noteId: a.noteId, amount: a.amount });
    ac.abort(new Error("page reloaded"));
    throw new Error("page reloaded");
  };
  await assert.rejects(followDeposit(t.args, { ...t.deps, bind: stuck, signal: ac.signal }), /page reloaded/);
  const out = await followDeposit(t.args, t.deps);
  assert.equal(out.kind, "done");
  assert.deepEqual(t.binds, [{ noteId: t.note.id, amount: CREDIT }, { noteId: t.note.id, amount: CREDIT }]);
  assert.equal((await t.store.list()).length, 1);
});

test("an op of another deposit under the same id is refused, never followed", async () => {
  const t = await setup(["SUCCESS"]);
  await t.w.put("ops", "dq-1", { kind: "deposit", stage: "waiting", txs: [], created_ms: 1, follow: { network: "testnet", s: "1", i: t.i, address: "f".repeat(64), deadline_ms: DEADLINE } });
  await assert.rejects(followDeposit(t.args, t.deps), /another deposit/);
});

// ---------- the review's planted sequences ----------
test("F1: a forged REFUNDED while 1Click delivered: U's credit is bound, never refunded; done only on 1Click's SUCCESS", async () => {
  const t = await setup(["PROCESSING", "REFUNDED", "REFUNDED", "REFUNDED", "SUCCESS"]);
  t.chain.credit(CREDIT);
  const out = await followDeposit(t.args, t.deps);
  assert.equal(out.kind, "done");
  assert.deepEqual(t.binds, [{ noteId: t.note.id, amount: CREDIT }]);
  assert.ok(!t.stages.includes("refunded"));
  assert.ok(t.oc.urls.length >= 5, "done waited for the op's own SUCCESS");
});

test("F3 and M2: SUCCESS and a 1.99 USDC gift (over min_amount_out, under what 1Click delivered): done on U's bound sum at the min; U is followed to the deadline, so the real delivery binds after it and shows", async () => {
  const GIFT = 1_990_000n;
  assert.ok(GIFT > BigInt(MIN_OUT) && GIFT < CREDIT);
  const t = await setup(["SUCCESS"]);
  t.oc.fetchFn = perAddress(t.u, { [ADDR]: [["SUCCESS", CREDIT]] }).fetchFn;
  t.chain.credit(GIFT); // anyone can ft_transfer to U
  let doneAt = 0;
  t.onTick.fn = (n) => {
    if (doneAt === 0 && t.stages.at(-1) === "done") doneAt = n;
    if (n === 8) t.chain.credit(CREDIT);
    if (n === 14) t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1; // the quote's deadline passes on both
  };
  const out = await followDeposit(t.args, { ...t.deps, fetchFn: t.oc.fetchFn, untilFinal: true });
  assert.equal(out.kind, "done");
  assert.ok(doneAt > 0 && doneAt < 8, `done on the gift (at tick ${doneAt}), before the delivery`);
  assert.deepEqual(t.binds.map((b) => b.amount), [GIFT, CREDIT]);
  const op = await opOf(t.w);
  assert.equal(op.amount_usd, usdOf(GIFT + CREDIT));
  assert.equal(op.follow.notes!.length, 2);
  assert.equal(op.follow.delivered, CREDIT.toString());
  assert.equal(op.follow.final, true);
  assert.ok(t.ticks() >= 14, "resolved only once the deadline is past on both RPCs");

  // M2: the store's leaf names another value than the pages' row at the same index and commitment: held
  const m = await setup(["SUCCESS"]);
  m.chain.credit(CREDIT);
  const store = new Proxy(m.store, {
    get: (o, k) => (k === "get" || k === "list"
      ? async (...a: unknown[]) => {
          const tamper = (n: any) => (n?.leaf ? { ...n, leaf: { ...n.leaf, value: n.leaf.value + 1n } } : n);
          const r = await (o as any)[k](...a);
          return Array.isArray(r) ? r.map(tamper) : tamper(r);
        }
      : (o as never)[k]),
  });
  assert.deepEqual(await followDeposit(m.args, { ...m.deps, store }), { kind: "held", why: "leaf" });
});

test("F4: USDC's code hash moves mid-deposit: held with code_hash, U as held_id; held stays an end", async () => {
  const t = await setup(["SUCCESS"], { bind: bindDeposit });
  t.onTick.fn = (n) => n === 1 && t.chain.credit(CREDIT); // 1Click's SUCCESS is read first: the op is sent when held
  t.chain.codeHash = "11111111111111111111111111111111";
  assert.deepEqual(await followDeposit(t.args, t.deps), { kind: "held", why: "code_hash" });
  const op = await opOf(t.w);
  assert.equal(op.held_id, t.u);
  assert.ok(t.seeds.every((s) => s.every((b) => b === 0)), "the seed zeroed once the bind phase ended");
  t.chain.codeHash = null;
  const never: typeof bindDeposit = async () => assert.fail("a held op bound again");
  assert.deepEqual(await followDeposit(t.args, { ...t.deps, bind: never }), { kind: "held", why: "code_hash" });
  // a later quote on the same U is followed; the held op is no open op of it: never written, never counted
  t.onTick.fn = () => {};
  const before = JSON.stringify(await opOf(t.w));
  assert.equal((await opOf(t.w)).follow.sent, true);
  const B = { ...t.args, opId: "dq-B", address: "b".repeat(64) };
  // 1Click still answers SUCCESS for A's address: a held op's status is never read again nor its money counted
  const fetchFn = perAddress(t.u, { [ADDR]: [["SUCCESS", CREDIT]], ["b".repeat(64)]: ["PROCESSING"] }).fetchFn;
  await assert.rejects(followDeposit(B, { ...t.deps, fetchFn, signal: stop(t, t.ticks() + 4) }), /stop/);
  assert.equal(JSON.stringify(await opOf(t.w)), before, "held stays an end for U's next follower too");
});

/** Two RPCs whose ft_balance_of answers by block from `hist`, each naming its own final height. */
const histRpcs = (finals: [number, number], hist: (side: number, h: number) => bigint) =>
  finals.map((final, side) => ({
    name: side === 0 ? NET.fastnear[0] : NET.drpc,
    query: async (p: { block_id?: number }) => {
      const at = p.block_id ?? final;
      return { jsonrpc: "2.0", id: "x", result: { block_height: at, block_hash: `h${at}`, logs: [], result: [...Buffer.from(JSON.stringify(hist(side, at).toString()))] } };
    },
    tx: async () => ({}),
    block: async () => ({}),
  })) as unknown as [FollowRpc, FollowRpc];

test("F5: readCredit refuses two finals more than HEIGHT_SPREAD_MAX apart", async () => {
  const hist = (_s: number, h: number) => (h < 1000 ? 7_000_000n : 2_000_000n);
  assert.equal(await readCredit("a".repeat(64), NET.usdc, histRpcs([500, 275_753_809], hist)), null);
  assert.equal(await readCredit("a".repeat(64), NET.usdc, histRpcs([275_753_809 - HEIGHT_SPREAD_MAX, 275_753_809], hist)), 2_000_000n);
});

test("M4: readCredit reads both RPCs at one height", async () => {
  const hist = (side: number, h: number) => (side === 1 && h === 100 ? 0n : 2_000_000n);
  assert.equal(await readCredit("a".repeat(64), NET.usdc, histRpcs([100, 101], hist)), null);
  assert.equal(await readCredit("a".repeat(64), NET.usdc, histRpcs([100, 101], () => 2_000_000n)), 2_000_000n);
});

test("M1: a front-run at the same amount, then a reload: done lands on second arrival 0, never on the stranger's note", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const ac = new AbortController();
  const frontRun: typeof bindDeposit = async (_s, a) => {
    const n = (await t.store.get(a.noteId))!;
    t.chain.addRow(n.precommitment, { value: CREDIT, depositor: "e".repeat(64) });
    await t.store.move(a.noteId, "PLANNED", "INCOMING");
    const leaf = { value: CREDIT, label: 1000n, commitment: noteCommitment(CREDIT, 1000n, n.precommitment), leafIndex: 0n };
    const note = await t.store.move(a.noteId, "INCOMING", "UNSPENT", { leaf });
    ac.abort(new Error("page reloaded"));
    return { kind: "front_run", note };
  };
  await assert.rejects(followDeposit(t.args, { ...t.deps, bind: frontRun, signal: ac.signal }), /page reloaded/);
  const out = await followDeposit(t.args, t.deps);
  assert.equal(out.kind, "done");
  assert.deepEqual((out as { note: { ref: unknown } }).note.ref, { kind: "second", id: { id: "U", s: 1n, i: t.i }, n: 0 });
  assert.deepEqual(t.binds.map((b) => b.amount), [CREDIT]);
});

test("E6 and M13: a landed note counts whatever its state now (SPENT once withdrawn); a leaf the pages do not hold is held", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const spy = t.deps.bind!;
  const spent: typeof bindDeposit = async (s, a, dps) => {
    await spy(s, a, dps);
    return { kind: "deposited", note: await t.store.move(a.noteId, "UNSPENT", "SPENT") }; // another device withdrew it at once
  };
  assert.equal((await followDeposit(t.args, { ...t.deps, bind: spent })).kind, "done");

  const m = await setup(["SUCCESS"]);
  m.chain.credit(CREDIT);
  const mspy = m.deps.bind!;
  const relabel: typeof bindDeposit = async (s, a, dps) => {
    const out = await mspy(s, a, dps);
    for (const side of [m.chain.a, m.chain.b]) side.rows.at(-1)!.label = (BigInt(side.rows.at(-1)!.label) + 1n).toString();
    return out;
  };
  assert.deepEqual(await followDeposit(m.args, { ...m.deps, bind: relabel }), { kind: "held", why: "leaf" });
});

test("N2: two quotes before payment name one U: B's money is bound as U's next note and B is done once U's sum covers both mins, showing its own part", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const B = { ...t.args, opId: "dq-B", address: BADDR };
  const CB = 5_000_000n;
  const scripts: Record<string, (OneClickStatus | [OneClickStatus, bigint])[]> = { [ADDR]: [["SUCCESS", CREDIT]], [BADDR]: ["PENDING_DEPOSIT"] };
  const deps = { ...t.deps, fetchFn: perAddress(t.u, scripts).fetchFn };
  t.chain.credit(CREDIT);
  const a = followDeposit(t.args, deps);
  const b = followDeposit(B, deps);
  assert.equal((await a).kind, "done");
  // B is paid later: 1Click delivers CB to U and says SUCCESS for B's address
  t.chain.credit(CB);
  scripts[BADDR]!.splice(0, 1, ["SUCCESS", CB]);
  const out = await b;
  assert.equal(out.kind, "done");
  const opA = await opOf(t.w);
  const opB = await opOf(t.w, "dq-B");
  assert.equal(opB.amount_usd, usdOf(CB), "B's done is its own money");
  assert.equal(opA.amount_usd, usdOf(CREDIT));
  // U's money is one sum: both ops name U's landed notes, and each shows its own part of it once
  assert.equal(BigInt(opA.follow.bound!) + BigInt(opB.follow.bound!), CREDIT + CB, "U's sum, shown once across its ops");
  assert.deepEqual(opB.follow.notes, opA.follow.notes);
  assert.deepEqual(t.binds.map((x) => x.amount), [CREDIT, CB]);
  assert.equal(t.chain.a.balance, 0n, "nothing left in U");
});

test("N2b: two live quotes on one U, one payment: only the paid op is done; the other stays open, its money not yet seen", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const B = { ...t.args, opId: "dq-B", address: BADDR };
  const p = perAddress(t.u, { [ADDR]: [["SUCCESS", CREDIT]], [BADDR]: ["PENDING_DEPOSIT"] });
  t.chain.credit(CREDIT);
  const ac = new AbortController();
  const [a, b] = [followDeposit(t.args, { ...t.deps, fetchFn: p.fetchFn }), followDeposit(B, { ...t.deps, fetchFn: p.fetchFn, signal: ac.signal })];
  assert.equal((await a).kind, "done");
  ac.abort(new Error("stop"));
  await assert.rejects(b, /stop/);
  assert.equal((await opOf(t.w, "dq-B")).stage, "quote_checked");
  assert.equal(t.binds.length, 1, "one follower, one bind");
});

test("E5: a throw that is no refusal (a store read, an RPC) pauses and the round runs again; only the signal ends the follow", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  let fails = 3;
  const rpcs = t.chain.rpcs().map((r) => ({ ...r, query: async (p: any) => (p.method_name === "ft_balance_of" && fails-- > 0 ? Promise.reject(new TypeError("fetch failed")) : r.query(p)) })) as unknown as [FollowRpc, FollowRpc];
  let listFails = 2;
  const store = new Proxy(t.store, { get: (o, k) => (k === "list" ? async () => (listFails-- > 0 ? Promise.reject(new Error("IDB busy")) : o.list()) : (o as never)[k]) });
  assert.equal((await followDeposit(t.args, { ...t.deps, rpcs, store })).kind, "done");
  // each throw paused before the round ran again: doubling from the bind's poll
  assert.deepEqual(t.sleeps.slice(0, 2), [POLL_MS, POLL_MS * 2], t.sleeps.join());
});

test("1Click's 429: the status read waits Retry-After; a date or none is read too", async () => {
  const at = (h: string | null) => new Response("{}", { status: 429, headers: h === null ? {} : { "retry-after": h } });
  assert.deepEqual(await readDepositStatus(ADDR, "a".repeat(64), (async () => at("7")) as unknown as typeof fetch), { retry_ms: 7000 });
  assert.deepEqual(await readDepositStatus(ADDR, "a".repeat(64), (async () => at(new Date(NOW + 3000).toUTCString())) as unknown as typeof fetch, undefined, NOW), { retry_ms: 3000 });
  assert.deepEqual(await readDepositStatus(ADDR, "a".repeat(64), (async () => at("99999")) as unknown as typeof fetch), { retry_ms: STATUS_RETRY_MAX_MS });
  assert.deepEqual(await readDepositStatus(ADDR, "a".repeat(64), (async () => at(null)) as unknown as typeof fetch), { retry_ms: null });

  const t = await setup(["PROCESSING"]);
  let clock = NOW;
  let calls = 0;
  const reads: number[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => (reads.push(t.ticks()), ++calls === 1 ? at("40") : t.oc.fetchFn(url, init))) as typeof fetch;
  t.onTick.fn = () => (clock += 15_000);
  await assert.rejects(followDeposit(t.args, { ...t.deps, fetchFn, now: () => clock, signal: stop(t, 4) }), /stop/);
  assert.deepEqual(reads.slice(0, 2), [0, 3], "no status read for 40 s after the 429");
});

test("the seed opens only for a bind phase, each copy zeroed after it, under deps.seedLock; the op's txs hold the bind's tx hashes", async () => {
  const t = await setup(["PROCESSING"]);
  await assert.rejects(followDeposit(t.args, { ...t.deps, signal: stop(t, 5) }), /stop/);
  assert.equal(t.seeds.length, 0, "status and balance reads need only U");

  t.chain.credit(CREDIT);
  const store = new Proxy(t.store, {
    get: (o, k) => (k === "get" ? async (id: string) => { const n = await o.get(id); return n?.leaf ? { ...n, calls: [{ tx_hashes: ["7Yk3pQ"] }] } : n; } : (o as never)[k]),
  });
  let locked = 0;
  let inside = false;
  const seedLock = async <T,>(fn: () => Promise<T>) => {
    locked++;
    inside = true;
    try {
      return await fn();
    } finally {
      inside = false;
    }
  };
  const seed64 = async () => (assert.ok(inside, "the seed opens only under the seed lock"), t.deps.seed64());
  const out = await followDeposit(t.args, { ...t.deps, store, seedLock, seed64, fetchFn: oneClick(t.u, ["SUCCESS"]).fetchFn });
  assert.equal(out.kind, "done");
  assert.equal(locked, 1);
  assert.ok(t.seeds[0]!.every((b) => b === 0), "zeroed");
  assert.deepEqual((await opOf(t.w)).txs, [{ chain: "near", hash: "7Yk3pQ" }]);
});

test("E9: every wait of the bind ends the phase (the seed never open across a sleep); halted shows on a halt and clears in the next phase that waits on no halt", async () => {
  const t = await setup(["SUCCESS"]);
  const between: (string | undefined)[] = [];
  t.onTick.fn = (n) => (between.push(t.stages.at(-1)), n === 1 && t.chain.credit(CREDIT));
  const spy = t.deps.bind!;
  let calls = 0;
  let wentOn = 0;
  const bind: typeof bindDeposit = async (s, a, dps) => {
    calls++;
    // the halt holds 3 rounds: halted shows once and stays, no into_vault between
    if (calls <= 3) {
      await dps.onWait?.("halted");
      wentOn++;
    }
    if (calls === 4) {
      await dps.onWait?.("balance"); // the halt lifts; USDC not back yet: the phase ends here
      wentOn++;
    }
    return spy(s, a, dps);
  };
  const out = await followDeposit(t.args, { ...t.deps, bind });
  assert.equal(out.kind, "done");
  assert.equal(wentOn, 0, "a phase went on after a wait");
  assert.equal(calls, 5, "bound again on each next round");
  assert.deepEqual(t.stages, ["in_transit", "into_vault", "halted", "into_vault", "done"]);
  const h = between.indexOf("halted");
  assert.deepEqual(between.slice(h, h + 4), ["halted", "halted", "halted", "into_vault"], `halted between rounds while the halt holds, cleared by the next phase: ${between.join()}`);
});

test("the seed's U is checked against the op's U before any bind", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const other = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16).fill(0x7f)));
  assert.deepEqual(await followDeposit(t.args, { ...t.deps, seed64: async () => Uint8Array.from(other) }), { kind: "held", why: "refused" });
  assert.equal(t.binds.length, 0);
  void DepositAccountRefused;
});

test("usdcUnits reads deposit.quote's min_amount_out as base units, the inverse of usdOf", () => {
  assert.equal(usdcUnits("1.983085"), 1_983_085n);
  assert.equal(usdcUnits("24.7005"), 24_700_500n);
  assert.equal(usdcUnits(usdOf(2_003_117n)), 2_003_117n);
  for (const bad of ["1.0000001", "-1", "01", "1.", ".5", "1e6", ""]) assert.equal(usdcUnits(bad), null, bad);
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
    const dl = decodeSignedDelegate(new Uint8Array(Buffer.from(body.signed_delegate, "base64")));
    const fc = dl.actions[0] as { args: Uint8Array };
    sent.push({ nonce: dl.nonce, p: BigInt(JSON.parse(JSON.parse(Buffer.from(fc.args).toString()).msg).precommitment) });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const ac = new AbortController();
  t.onTick.fn = () => sent.length > 0 && ac.abort(new Error("page reloaded"));
  await assert.rejects(followDeposit(t.args, { ...t.deps, fetchFn, signal: ac.signal }), /page reloaded/);
  assert.equal(sent.length, 1);
  resetBindSession();
  let n = 0;
  t.onTick.fn = () => {
    if (++n === 4) {
      t.chain.a.nonce = t.chain.b.nonce = sent[0]!.nonce;
      t.chain.credit(0n);
      t.chain.addRow(sent[0]!.p, { value: CREDIT });
    }
  };
  const out = await followDeposit(t.args, { ...t.deps, fetchFn });
  assert.equal(out.kind, "done");
  assert.equal(sent.length, 1, `a second call at nonce ${sent[1]?.nonce} after the reload`);
});

test("helper-create-u: after SUCCESS, while U reads not_created, the status is read again each round (the read the helper creates U on); once U exists, no more", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const spy = t.deps.bind!;
  let calls = 0;
  const reads: number[] = [];
  const binds: number[] = [];
  const bind: typeof bindDeposit = async (s, a, dps) => {
    binds.push(t.ticks());
    if (++calls <= 3) await dps.onWait?.("not_created"); // U not created yet: the phase ends, the next round binds again
    const out = await spy(s, a, dps);
    // U exists and the note is bound; RPC b's pages hold the row only 4 rounds later, so the op stays open meanwhile
    t.chain.b.rows.pop();
    let later = 0;
    t.onTick.fn = () => ++later === 4 && t.chain.addRow(t.note.precommitment, { value: CREDIT, side: "b" });
    return out;
  };
  const fetchFn = (async (url: string, init?: RequestInit) => (reads.push(t.ticks()), t.oc.fetchFn(url, init))) as typeof fetch;
  const out = await followDeposit(t.args, { ...t.deps, bind, fetchFn });
  assert.equal(out.kind, "done");
  assert.equal(calls, 4);
  assert.deepEqual(reads, [0, 1, 2], "SUCCESS read at round 0, read again in rounds 1 and 2 while U was not created, none once it exists");
  assert.deepEqual(binds, [0, 1, 2, 3]);
  assert.ok(t.ticks() >= 7, "rounds ran after U existed, with no status read");
});

// ---------- r2: U's money as one sum, refunds per op, the refund move by nonce, no seed across a wait ----------
const settled = async <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const VAULT_MIN = 1_000_000n;

test("C1: two ops on one U, both SUCCESS, both deliveries in U as one credit before the page opens: both done, each its own part", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const B = { ...t.args, opId: "dq-B", address: BADDR };
  const CB = 5_000_000n;
  const p = perAddress(t.u, { [ADDR]: [["SUCCESS", CREDIT]], [BADDR]: [["SUCCESS", CB]] });
  t.chain.credit(CREDIT + CB);
  const deps = { ...t.deps, fetchFn: p.fetchFn, signal: stop(t, 30) };
  const [a, b] = await Promise.all([settled(followDeposit(t.args, deps)), settled(followDeposit(B, deps))]);
  assert.ok(a.ok && a.v.kind === "done");
  assert.ok(b.ok && b.v.kind === "done");
  assert.equal((await opOf(t.w)).amount_usd, usdOf(CREDIT));
  assert.equal((await opOf(t.w, "dq-B")).amount_usd, usdOf(CB));
});

test("C2: SIGN_HOST's deps (no refundMove): a stranger's 1-unit dust in intents and a 1 USDC gift bind, but no op is done before its own SUCCESS", async () => {
  const t = await setup(["PROCESSING"]);
  t.onTick.fn = (n) => {
    if (n === 1) t.chain.heldUsdc = 1n;
    if (n === 3) t.chain.credit(VAULT_MIN);
  };
  await assert.rejects(followDeposit(t.args, { ...t.deps, signal: stop(t, 20) }), /stop/);
  const op = await opOf(t.w);
  assert.deepEqual(t.binds.map((b) => b.amount), [VAULT_MIN], "the gift is bound");
  assert.notEqual(op.stage, "done");
  assert.notEqual(op.stage, "refunded", "dust under U is no refund of this op");
});

test("C3: two quotes on one U: A refunded (its origin asset under U in intents), B paid: B done on U's sum, A refunded and never done", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const B = { ...t.args, opId: "dq-B", address: BADDR };
  const CB = 5_000_000n;
  const scripts: Record<string, (OneClickStatus | [OneClickStatus, bigint])[]> = { [ADDR]: ["PROCESSING", "REFUNDED"], [BADDR]: ["PENDING_DEPOSIT"] };
  const p = perAddress(t.u, scripts);
  t.chain.a.held = t.chain.b.held = 452_500_000_000_000_000_000_000n;
  const ac = new AbortController();
  const deps = { ...t.deps, fetchFn: p.fetchFn };
  const a = settled(followDeposit(t.args, { ...deps, signal: ac.signal }));
  await turn();
  const b = settled(followDeposit(B, { ...deps, signal: ac.signal }));
  t.onTick.fn = (n) => {
    if (n === 4) (t.chain.credit(CB), scripts[BADDR]!.splice(0, 1, ["SUCCESS", CB]));
    if (n >= 30) ac.abort(new Error("stop"));
  };
  const [, rb] = await Promise.all([a, b]);
  assert.ok(rb.ok && rb.v.kind === "done");
  const opA = await opOf(t.w);
  assert.equal(opA.stage, "refunded");
  assert.equal((await opOf(t.w, "dq-B")).amount_usd, usdOf(CB));
});

test("C4: the refund move throws before it sends: recorded with its nonce, and signed again with a fresh nonce once that nonce reads unused and its deadline is past on both RPCs", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = CREDIT;
  const moves: MoveRecord[] = [];
  const refundMove = mover(async (_u, m) => {
    moves.push(m);
    assert.deepEqual((await opOf(t.w)).follow.move, m, "recorded before it is sent");
    if (moves.length === 1) throw new TypeError("fetch failed");
    t.chain.used.add(m.nonce);
    t.chain.a.held = t.chain.b.held = 0n;
  });
  let early = 0;
  let back = 0;
  t.onTick.fn = (n) => {
    // 30 s of block time a round: the first move's deadline (120 s) passes after 4 rounds
    t.chain.a.timeMs = t.chain.b.timeMs = t.chain.a.timeMs + 30_000;
    if (moves.length === 1 && t.chain.a.timeMs <= moves[0]!.deadline_ms) early++;
    if (moves.length === 2 && ++back === 2) t.chain.credit(CREDIT); // the moved USDC back on the token under U
  };
  const out = await followDeposit(t.args, { ...t.deps, refundMove });
  assert.equal(out.kind, "done");
  assert.equal(moves.length, 2, "tried again once, and only once");
  assert.notEqual(moves[1]!.nonce, moves[0]!.nonce, "a fresh nonce");
  assert.ok(moves[1]!.deadline_ms > moves[0]!.deadline_ms);
  assert.ok(early >= 3, `rounds ran while the first move could still land (${early}), and it was not sent again then`);
  assert.equal((await opOf(t.w)).refunded, true);

  // a used nonce (the move landed) is never signed again, past its deadline too
  const u = await setup(["REFUNDED"]);
  u.chain.a.held = u.chain.b.held = CREDIT;
  let sends = 0;
  const landed = mover((_u, m) => void (sends++, u.chain.used.add(m.nonce), (u.chain.a.held = u.chain.b.held = 0n)));
  u.onTick.fn = () => (u.chain.a.timeMs = u.chain.b.timeMs = u.chain.a.timeMs + 600_000);
  await assert.rejects(followDeposit(u.args, { ...u.deps, refundMove: landed, signal: stop(u, 12) }), /stop/);
  assert.equal(sends, 1);
});

test("C5: with bind.ts, the seed is never open (nor the seed lock held) across a sleep: each wait of the bind ends the phase", async () => {
  const t = await setup(["SUCCESS"], { bind: bindDeposit });
  t.chain.credit(CREDIT);
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(DEPOSIT_STATUS_URL)) return t.oc.fetchFn(url, init);
    const body = JSON.parse(init!.body as string);
    const dl = decodeSignedDelegate(new Uint8Array(Buffer.from(body.signed_delegate, "base64")));
    const fc = dl.actions[0] as { args: Uint8Array };
    sent.push({ nonce: dl.nonce, p: BigInt(JSON.parse(JSON.parse(Buffer.from(fc.args).toString()).msg).precommitment) });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  let inside = false;
  const during: boolean[] = [];
  const seedLock = async <T,>(fn: () => Promise<T>) => {
    inside = true;
    try {
      return await fn();
    } finally {
      inside = false;
    }
  };
  let n = 0;
  t.onTick.fn = () => {
    during.push(inside || t.seeds.some((s) => s.some((b) => b !== 0)));
    if (sent.length > 0 && ++n === 6) {
      t.chain.a.nonce = t.chain.b.nonce = sent[0]!.nonce;
      t.chain.credit(0n);
      t.chain.addRow(sent[0]!.p, { value: CREDIT });
    }
  };
  const out = await followDeposit(t.args, { ...t.deps, fetchFn, seedLock });
  assert.equal(out.kind, "done");
  assert.equal(sent.length, 1, "the call out is settled, never sent again at a new nonce");
  assert.ok(during.length >= 6);
  assert.equal(during.filter(Boolean).length, 0, `${during.filter(Boolean).length} of ${during.length} sleeps ran with the seed open or its lock held`);
});

test("C6: once U exists and the bind waits on another read (an RPC behind), the status is not read again", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const spy = t.deps.bind!;
  let calls = 0;
  const reads: number[] = [];
  const bind: typeof bindDeposit = async (s, a, dps) => {
    calls++;
    if (calls === 1) await dps.onWait?.("not_created");
    else if (calls <= 6) await dps.onWait?.("rpc");
    return spy(s, a, dps);
  };
  const fetchFn = (async (url: string, init?: RequestInit) => (reads.push(t.ticks()), t.oc.fetchFn(url, init))) as typeof fetch;
  assert.equal((await followDeposit(t.args, { ...t.deps, bind, fetchFn })).kind, "done");
  assert.equal(calls, 7);
  assert.ok(reads.length <= 2, `status read in ${reads.length} rounds`);
});

test("C7: a code_hash hold with bind.ts holds the op, its money under U; the money reached U, so the next quote names the lane's next index (wallet.md: one index until money reaches it)", async () => {
  const t = await setup(["SUCCESS"], { bind: bindDeposit });
  t.chain.credit(CREDIT);
  t.chain.codeHash = "11111111111111111111111111111111";
  assert.deepEqual(await followDeposit(t.args, t.deps), { kind: "held", why: "code_hash" });
  assert.equal((await opOf(t.w)).held_id, t.u, "the money under U for withdraw.open");
  assert.equal(t.chain.a.balance, CREDIT);
  assert.notEqual((await t.store.get(t.note.id))!.state, "PLANNED");
  const next = await t.store.planDeposit(1n, pc);
  assert.equal((next.ref as { i: number }).i, t.i + 8, "the lane's next index (lanes of 8)");
});

test("R1-F1': a forged REFUNDED, then the real delivery: the credit binds, refunded never shows (nothing under U in intents), and no done without SUCCESS", async () => {
  const t = await setup(["PROCESSING", "REFUNDED"]);
  t.onTick.fn = (n) => n === 3 && t.chain.credit(CREDIT);
  await assert.rejects(followDeposit(t.args, { ...t.deps, signal: stop(t, 10) }), /stop/);
  assert.deepEqual(t.binds.map((b) => b.amount), [CREDIT]);
  assert.ok(!t.stages.includes("refunded"), t.stages.join());
  const op = await opOf(t.w);
  assert.equal(op.follow.status, "REFUNDED");
  assert.ok(op.stage !== "refunded" && op.stage !== "done", op.stage);
});

test("late send: A done on U, then B, quoted earlier on the same U, is paid late: U is still followed, B's money binds and B is done; A keeps its part", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const CB = 5_000_000n;
  const scripts: Record<string, (OneClickStatus | [OneClickStatus, bigint])[]> = { [ADDR]: ["PENDING_DEPOSIT"], [BADDR]: ["PENDING_DEPOSIT"] };
  const deps = { ...t.deps, fetchFn: perAddress(t.u, scripts).fetchFn, untilFinal: true };
  // B quoted first (the older quote), A after: both name U (no deposit landed between)
  const B = { ...t.args, opId: "dq-B", address: BADDR };
  const now = { at: NOW };
  const b = settled(followDeposit(B, { ...deps, now: () => now.at }));
  while ((await t.w.get("ops", "dq-B")) === undefined) await turn();
  now.at = NOW + 60_000;
  const a = settled(followDeposit(t.args, { ...deps, now: () => now.at }));
  while ((await t.w.get("ops", "dq-1")) === undefined) await turn();
  assert.ok((await opOf(t.w, "dq-B")).created_ms < (await opOf(t.w)).created_ms);
  let aDone = 0;
  t.onTick.fn = (n) => {
    if (n === 2) (t.chain.credit(CREDIT), scripts[ADDR]!.splice(0, 1, ["SUCCESS", CREDIT]));
    if (aDone === 0 && t.stages.includes("done")) aDone = n;
    // B's late send, after A is done: 1Click delivers it to U and says SUCCESS for B's address
    if (aDone > 0 && n === aDone + 3) (t.chain.credit(CB), scripts[BADDR]!.splice(0, 1, ["SUCCESS", CB]));
    if (n === aDone + 12 && aDone > 0) t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1;
  };
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(aDone > 0);
  assert.ok(ra.ok && ra.v.kind === "done");
  assert.ok(rb.ok && rb.v.kind === "done", "B done on its late send");
  assert.deepEqual(t.binds.map((x) => x.amount), [CREDIT, CB]);
  const opA = await opOf(t.w);
  const opB = await opOf(t.w, "dq-B");
  assert.equal(opB.amount_usd, usdOf(CB));
  assert.equal(opA.amount_usd, usdOf(CREDIT), "A keeps its part");
  assert.ok(followEnded(opA) && followEnded(opB));
});

test("late send, no follow of B's own: A's follow holds U until A's deadline is past on both RPCs, so B's late send binds and B is done", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const CB = 5_000_000n;
  const scripts: Record<string, (OneClickStatus | [OneClickStatus, bigint])[]> = { [ADDR]: ["PENDING_DEPOSIT"], [BADDR]: ["PENDING_DEPOSIT"] };
  const deps = { ...t.deps, fetchFn: perAddress(t.u, scripts).fetchFn, untilFinal: true };
  // B's op is in the store (its quote answered, then its tab closed): nothing waits on it
  const ac = new AbortController();
  ac.abort(new Error("closed"));
  await assert.rejects(followDeposit({ ...t.args, opId: "dq-B", address: BADDR }, { ...deps, now: () => NOW - 60_000, signal: ac.signal }));
  let aDone = 0;
  t.onTick.fn = (n) => {
    if (n === 2) (t.chain.credit(CREDIT), scripts[ADDR]!.splice(0, 1, ["SUCCESS", CREDIT]));
    if (aDone === 0 && t.stages.includes("done")) aDone = n;
    if (aDone > 0 && n === aDone + 3) (t.chain.credit(CB), scripts[BADDR]!.splice(0, 1, ["SUCCESS", CB]));
    if (aDone > 0 && n === aDone + 12) t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1;
  };
  assert.equal((await followDeposit(t.args, deps)).kind, "done");
  assert.ok(aDone > 0 && t.ticks() >= aDone + 12, "A resolved only past its deadline");
  assert.deepEqual(t.binds.map((x) => x.amount), [CREDIT, CB]);
  const opB = await opOf(t.w, "dq-B");
  assert.equal(opB.stage, "done");
  assert.equal(opB.amount_usd, usdOf(CB));
});

test("N2c: B's SUCCESS reads before its money reaches U: B is not done until U's sum covers A's and B's mins", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const B = { ...t.args, opId: "dq-B", address: BADDR };
  const CB = 5_000_000n;
  const scripts: Record<string, (OneClickStatus | [OneClickStatus, bigint])[]> = { [ADDR]: [["SUCCESS", CREDIT]], [BADDR]: ["PENDING_DEPOSIT"] };
  let bDoneAt = -1;
  const deps: FollowDeps = { ...t.deps, fetchFn: perAddress(t.u, scripts).fetchFn, onStage: (st, f, id) => (t.deps.onStage!(st, f, id), id === "dq-B" && st === "done" && bDoneAt < 0 && (bDoneAt = t.ticks())) };
  t.chain.credit(CREDIT);
  const a = followDeposit(t.args, deps);
  const b = followDeposit(B, deps);
  assert.equal((await a).kind, "done");
  // B's SUCCESS first (1Click ahead of the chain, or forged): U's sum is A's alone for 8 rounds
  scripts[BADDR]!.splice(0, 1, ["SUCCESS", CB]);
  const from = t.ticks();
  t.onTick.fn = (n) => n === from + 8 && t.chain.credit(CB);
  assert.equal((await b).kind, "done");
  assert.equal((await opOf(t.w, "dq-B")).follow.status, "SUCCESS");
  assert.ok(bDoneAt >= from + 8, `B done at tick ${bDoneAt}, on A's money (B's arrived at ${from + 8})`);
  assert.equal((await opOf(t.w, "dq-B")).amount_usd, usdOf(CB));
});

test("L4: with untilFinal, a done op followed again (a reload) resolves only once its deadline is past on both RPCs, and a late gift binds meanwhile", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  assert.equal((await followDeposit(t.args, t.deps)).kind, "done");
  assert.equal((await opOf(t.w)).follow.final, undefined);
  const from = t.ticks();
  t.onTick.fn = (n) => {
    if (n === from + 2) t.chain.credit(VAULT_MIN);
    if (n === from + 6) t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1;
  };
  assert.equal((await followDeposit(t.args, { ...t.deps, untilFinal: true })).kind, "done");
  assert.ok(t.ticks() >= from + 6, "resolved before the deadline");
  assert.deepEqual(t.binds.map((b) => b.amount), [CREDIT, VAULT_MIN]);
  const op = await opOf(t.w);
  assert.equal(op.follow.final, true);
  assert.equal(op.amount_usd, usdOf(CREDIT + VAULT_MIN));
});

test("F5e: a forged REFUNDED with nothing under U inside intents, and a 1 USDC gift: no refund move is through, and the op is never done", async () => {
  const t = await setup(["PROCESSING", "REFUNDED"]);
  let moves = 0;
  t.onTick.fn = (n) => n === 3 && t.chain.credit(VAULT_MIN);
  await assert.rejects(followDeposit(t.args, { ...t.deps, refundMove: mover(() => void moves++), signal: stop(t, 12) }), /stop/);
  const op = await opOf(t.w);
  assert.equal(moves, 0);
  assert.equal(op.follow.moved, undefined);
  assert.notEqual(op.stage, "done");
  assert.deepEqual(t.binds.map((b) => b.amount), [VAULT_MIN], "the gift is bound all the same");
});

// ---------- r3: a held op whose money binds later, final with nothing left to bind ----------
test("D3b: a held op whose money binds later is no longer held: it counts like any SUCCESS op, each op shows its own money", async () => {
  const t = await setup(["PENDING_DEPOSIT"]);
  const BADDR = "b".repeat(64);
  const B = { ...t.args, opId: "dq-B", address: BADDR };
  const CB = 5_000_000n;
  const scripts: Record<string, (OneClickStatus | [OneClickStatus, bigint])[]> = { [ADDR]: [["SUCCESS", CREDIT]], [BADDR]: ["PENDING_DEPOSIT"] };
  const p = perAddress(t.u, scripts);
  const spy = t.deps.bind!;
  let calls = 0;
  // B's first bind is refused (B held, U's money waits under U); the next round binds it
  const bind: typeof bindDeposit = async (s, a, dps) => (++calls === 2 ? ({ kind: "refused", code: "deposit_failed" } as BindOutcome) : spy(s, a, dps));
  t.chain.credit(CREDIT);
  const ac = new AbortController();
  const deps = { ...t.deps, fetchFn: p.fetchFn, signal: ac.signal, untilFinal: true, bind };
  const a = settled(followDeposit(t.args, deps));
  const b = settled(followDeposit(B, deps));
  t.onTick.fn = (n) => {
    if (n === 3) scripts[BADDR]!.splice(0, 1, ["SUCCESS", CB]); // B's SUCCESS reads before its money reaches U
    if (n === 5) t.chain.credit(CB);
    if (n >= 20) ac.abort(new Error("stop"));
  };
  const rb = await b;
  await a;
  const opA = await opOf(t.w);
  const opB = await opOf(t.w, "dq-B");
  assert.deepEqual(rb.ok && rb.v, { kind: "held", why: "deposit_failed" }, "B's follow ended held when its bind was refused");
  assert.equal(calls, 3);
  assert.deepEqual(t.binds.map((x) => x.amount), [CREDIT, CB]);
  assert.equal(t.chain.a.balance, 0n);
  assert.equal(opB.stage, "done", `B stays ${opB.stage} with its money in the vault`);
  assert.equal(opB.amount_usd, usdOf(CB));
  assert.equal(opB.held_id, undefined);
  assert.equal(opB.follow.why, undefined);
  assert.equal(opA.amount_usd, usdOf(CREDIT), `A shows ${opA.amount_usd}, B's money as its own`);
});

test("D3c: a held op whose money never bound never stands in another op's way: A is done with its own money, the held op stays held", async () => {
  const t = await setup(["SUCCESS"]);
  // B: its status read SUCCESS, then the relayer struck U before its money bound; it is older than A
  await t.w.put("ops", "dq-B", { kind: "deposit", stage: "held", held_id: t.u, since_ms: NOW, txs: [], created_ms: NOW - 1, follow: { network: "testnet", s: "1", i: t.i, u: t.u, address: "b".repeat(64), deadline_ms: DEADLINE, origin: ORIGIN, min_out: MIN_OUT, sent: true, status: "SUCCESS", delivered: "0", why: "sender_struck" } });
  // A's SUCCESS reads first, then its money reaches U: U's sum covers A, not A and B
  t.onTick.fn = (n) => n === 2 && t.chain.credit(CREDIT);
  const out = await followDeposit(t.args, { ...t.deps, signal: stop(t, 30) });
  const opA = await opOf(t.w);
  const opB = await opOf(t.w, "dq-B");
  assert.equal(out.kind, "done");
  assert.equal(opA.amount_usd, usdOf(CREDIT));
  assert.equal(opB.stage, "held");
  assert.equal(opB.follow.why, "sender_struck");
});

/** A bind call as the note store keeps it (only its shape is read here). */
const callOf = (u: string, balance: bigint) => ({ signed_delegate: "AAAA", sender_id: u, receiver_id: NET.usdc, nonce: 1n, max_block_height: 1n, public_key: publicKeyOf(u), balance });

test("D4: with untilFinal, final is never written while U holds a credit not yet bound: a late 1.5 USDC is bound before the follow ends", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const LATE = 1_500_000n;
  const spy = t.deps.bind!;
  let calls = 0;
  // the late credit's first phase ends on a wait (one RPC behind); the next round binds it
  const bind: typeof bindDeposit = async (s, a, dps) => (++calls === 2 && (await dps.onWait?.("rpc")), spy(s, a, dps));
  let doneAt = 0;
  t.onTick.fn = (n) => {
    if (doneAt === 0 && t.stages.at(-1) === "done") {
      doneAt = n;
      t.chain.credit(LATE); // a late credit to U (a gift, an older quote's late send)
      t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1; // and the quote's deadline passes on both
    }
  };
  const out = await followDeposit(t.args, { ...t.deps, bind, untilFinal: true, signal: stop(t, 40) });
  const op = await opOf(t.w);
  assert.equal(out.kind, "done");
  assert.equal(op.follow.final, true);
  assert.equal(t.chain.a.balance, 0n, `the follow ended final with ${t.chain.a.balance} unbound in U`);
  assert.deepEqual(t.binds.map((x) => x.amount), [CREDIT, LATE]);
  assert.equal(op.amount_usd, usdOf(CREDIT + LATE));
});

test("D4b: with untilFinal, final is never written while a note's call is out (U's USDC gone with it, the relayer's tx not seen yet)", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const LATE = 1_500_000n;
  const spy = t.deps.bind!;
  let calls = 0;
  const bind: typeof bindDeposit = async (s, a, dps) => {
    calls++;
    if (calls === 2) {
      // the late credit's call is written and sent: U's USDC goes with it, and the phase waits on the relayer's tx
      if ((await t.store.get(a.noteId))!.state === "PLANNED") await t.store.move(a.noteId, "PLANNED", "INCOMING");
      await t.store.addCall(a.noteId, callOf(t.u, a.amount), 0);
      t.chain.credit(0n);
      await dps.onWait?.("rpc");
    }
    if (calls === 3) await dps.onWait?.("rpc"); // still not seen: U reads 0, the call is out
    return spy(s, a, dps);
  };
  let doneAt = 0;
  t.onTick.fn = (n) => {
    if (doneAt === 0 && t.stages.at(-1) === "done") {
      doneAt = n;
      t.chain.credit(LATE);
      t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1;
    }
  };
  const out = await followDeposit(t.args, { ...t.deps, bind, untilFinal: true, signal: stop(t, 40) });
  const op = await opOf(t.w);
  const notes = await t.store.list();
  assert.equal(out.kind, "done");
  assert.equal(op.follow.final, true);
  assert.equal(calls, 4, "the call out was settled before the follow ended");
  assert.ok(notes.every((n) => n.leaf !== undefined), `a note still in flight: ${notes.filter((n) => n.leaf === undefined).map((n) => n.state)}`);
  assert.equal(op.amount_usd, usdOf(CREDIT + LATE));
});

test("P1: with untilFinal, final is never written while U's USDC reads on one RPC only (a credit unread)", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const LATE = 1_500_000n;
  let doneAt = 0;
  t.onTick.fn = (n) => {
    if (doneAt === 0 && t.stages.at(-1) === "done") {
      doneAt = n;
      t.chain.credit(LATE, "a"); // the late credit reads on one RPC; the other is behind
      t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1;
    }
    if (doneAt !== 0 && n === doneAt + 4) t.chain.credit(LATE, "b"); // the other RPC catches up
  };
  const out = await followDeposit(t.args, { ...t.deps, untilFinal: true, signal: stop(t, 40) });
  const op = await opOf(t.w);
  assert.equal(out.kind, "done");
  assert.equal(op.follow.final, true);
  assert.equal(t.chain.a.balance + t.chain.b.balance, 0n, `the follow ended final with U's credit unbound (a ${t.chain.a.balance}, b ${t.chain.b.balance})`);
  assert.deepEqual(t.binds.map((x) => x.amount), [CREDIT, LATE]);
});

test("P2: with untilFinal, final is never written while a landed note's pages read unsure (one RPC behind)", async () => {
  const t = await setup(["SUCCESS"]);
  t.chain.credit(CREDIT);
  const LATE = 1_500_000n;
  const spy = t.deps.bind!;
  let calls = 0;
  let lagged: { p: bigint; at: number } | null = null;
  // the late credit's call lands, but only one RPC's pages hold its row for a few rounds
  const bind: typeof bindDeposit = async (s, a, dps) => {
    if (++calls !== 2) return spy(s, a, dps);
    t.binds.push({ noteId: a.noteId, amount: a.amount });
    const n = (await t.store.get(a.noteId))!;
    t.chain.addRow(n.precommitment, { value: a.amount, side: "a" });
    t.chain.credit(0n);
    if (n.state === "PLANNED") await t.store.move(a.noteId, "PLANNED", "INCOMING");
    const r = t.chain.a.rows.at(-1)!;
    const leaf = { value: a.amount, label: BigInt(r.label), commitment: noteCommitment(a.amount, BigInt(r.label), n.precommitment), leafIndex: BigInt(r.leaf_index) };
    lagged = { p: n.precommitment, at: t.ticks() };
    return { kind: "deposited", note: await t.store.move(a.noteId, "INCOMING", "UNSPENT", { leaf }) } as BindOutcome;
  };
  let doneAt = 0;
  t.onTick.fn = (n) => {
    if (doneAt === 0 && t.stages.at(-1) === "done") {
      doneAt = n;
      t.chain.credit(LATE);
      t.chain.a.timeMs = t.chain.b.timeMs = DEADLINE + 1;
    }
    if (lagged !== null && n === lagged.at + 5) t.chain.addRow(lagged.p, { value: LATE, side: "b" }); // the other RPC catches up
  };
  const out = await followDeposit(t.args, { ...t.deps, bind, untilFinal: true, signal: stop(t, 40) });
  const op = await opOf(t.w);
  assert.equal(out.kind, "done");
  assert.equal(op.follow.final, true);
  assert.equal(op.amount_usd, usdOf(CREDIT + LATE), `the follow ended final showing ${op.amount_usd}, the late note uncounted`);
});

// ---------- wallet-refund-move: the move through on its own debit, one block for its reads, a lifted op's final ----------
const SECOND = 3_000_000n; // a second refund under U inside intents, larger than the first move took

test("D1: the move is through once its own debit reads at a final block (its nonce used), with a second refund under U; that one is moved by a new move, and final waits for it", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = CREDIT;
  const moves: MoveRecord[] = [];
  let frozen = false;
  let landAt = -1;
  const refundMove = mover((_u, m) => {
    moves.push(m);
    if (moves.length === 1) {
      // the first move lands, and a second refund (more than it took) reaches U inside intents before any round reads
      // 0; the first move's USDC comes back to U on the token
      t.chain.used.add(m.nonce);
      t.chain.a.held = t.chain.b.held = SECOND;
      t.chain.credit(CREDIT);
    } else {
      // the second move is out while the op is done and its quote's deadline past: block time stops, it lands 4 rounds on
      frozen = true;
      landAt = t.ticks() + 4;
    }
  });
  t.onTick.fn = (n) => {
    if (!frozen) t.chain.a.timeMs = t.chain.b.timeMs = t.chain.a.timeMs + 1_800_000;
    if (n === landAt) (t.chain.used.add(moves[1]!.nonce), (t.chain.a.held = t.chain.b.held = 0n), t.chain.credit(SECOND));
  };
  // SIGN_HOST's follow (untilFinal): final only once no move is out
  const out = await followDeposit(t.args, { ...t.deps, refundMove, untilFinal: true, signal: stop(t, 40) });
  assert.equal(out.kind, "done");
  assert.deepEqual(moves.map((m) => m.amount), [CREDIT.toString(), SECOND.toString()], "a new move for what U held after the first");
  const op = await opOf(t.w);
  assert.equal(op.follow.final, true);
  assert.equal(op.follow.moved, true);
  assert.equal(op.follow.move, undefined, "final only once the second move read through");
  assert.deepEqual(t.binds.map((b) => b.amount), [CREDIT, SECOND], "both moves' USDC bound before the follow ends");
});

test("readMoveAt: both RPCs at one block (the lower final height): its time, the balance, the salt and the nonce, every pair equal; else no read", async () => {
  const t = await setup(["REFUNDED"]);
  const rpcs = t.chain.rpcs();
  t.chain.a.held = t.chain.b.held = CREDIT;
  const n1 = versionedNonce("252812b3", NOW);
  t.chain.used.add(n1);
  const r = await readMoveAt(INTENTS, t.u, n1, ORIGIN, rpcs);
  assert.deepEqual(r && { height: r.height, held: r.held, used: r.used, salt: r.salt }, { height: Number(t.chain.a.height), held: CREDIT, used: true, salt: "252812b3" });
  t.chain.b.held = CREDIT - 1n;
  assert.equal(await readMoveAt(INTENTS, t.u, n1, ORIGIN, rpcs), null, "balances that disagree");
  t.chain.b.held = CREDIT;
  t.chain.a.finalLag = 0n;
  t.chain.b.height += 100n;
  assert.equal(await readMoveAt(INTENTS, t.u, n1, ORIGIN, rpcs), null, "finals too far apart");
});

test("D1: a stranger's dust under U after the move lands never holds the move open; the op is done on its money back", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = CREDIT;
  let sends = 0, unders = 0;
  const move = mover((_u, m) => void (sends++, t.chain.used.add(m.nonce), (t.chain.a.held = t.chain.b.held = 1n)));
  // the quote's floor refuses 1 base unit (SIGN_HOST's refundMover answers under_min below MIN_DEPOSIT)
  const refundMove = async (ask: FollowMoveAsk): Promise<RefundMoveResult> => (ask.reads[0].held < VAULT_MIN ? (unders++, { kind: "under_min" }) : move(ask));
  // SIGN_HOST's follow (untilFinal): the dust left under U never keeps the op from its final
  t.onTick.fn = (n) => ((t.chain.a.timeMs = t.chain.b.timeMs = t.chain.a.timeMs + 600_000), n === 4 && t.chain.credit(CREDIT));
  const out = await followDeposit(t.args, { ...t.deps, refundMove, untilFinal: true, signal: stop(t, 30) });
  assert.equal(out.kind, "done");
  assert.equal(sends, 1);
  assert.equal(unders, 1, "the dust is asked about once at that balance, not every round");
  const op = await opOf(t.w);
  assert.equal(op.follow.moved, true);
  assert.equal(op.follow.final, true);
});

test("finding 5: is_nonce_used, the block time and the balance are read at one block on both RPCs: a lagging state read never re-signs a move that landed", async () => {
  const t = await setup(["REFUNDED"]);
  const h0 = t.chain.a.height;
  const T0 = t.chain.a.timeMs;
  // block time by height: 100 s a block; the move (deadline T0 + 120 s) lands at h0 + 1, inside its deadline
  t.chain.timeAt = (h) => T0 + Number(h - h0) * 100_000;
  let landed: bigint | null = null;
  t.chain.heldAt = (_k, at) => (landed !== null && at >= landed ? 0n : CREDIT);
  // both RPCs' state answers at "final" lag 5 blocks behind their final block
  t.chain.a.finalLag = t.chain.b.finalLag = 5n;
  const moves: MoveRecord[] = [];
  let readAt = 0n;
  const refundMove = mover((_u, m) => {
    moves.push(m);
    readAt = t.chain.a.height; // the lower of the two final heights, where the move's reads were made
    landed = t.chain.a.height + 1n;
    t.chain.usedFrom.set(m.nonce, landed);
  });
  await assert.rejects(followDeposit(t.args, { ...t.deps, refundMove, signal: stop(t, 12) }), /stop/);
  assert.equal(moves.length, 1, "signed once: the landed move is never signed again");
  assert.equal(moves[0]!.deadline_ms, T0 + Number(readAt - h0) * 100_000 + 120_000, "the deadline from the read block's own time");
  assert.equal((await opOf(t.w)).follow.moved, true);
});

test("intents.near prunes used nonces past their deadline: a move whose nonce reads unused past it, but whose debit the balance shows, is through", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = CREDIT;
  let sends = 0;
  // the move lands, its nonce is cleaned up (cleanup_nonces) before any round reads it, and the block time is past
  const refundMove = mover(() => void (sends++, (t.chain.a.held = t.chain.b.held = 0n), (t.chain.a.timeMs = t.chain.b.timeMs = t.chain.a.timeMs + 600_000)));
  t.onTick.fn = (n) => n === 4 && t.chain.credit(CREDIT);
  const out = await followDeposit(t.args, { ...t.deps, refundMove, signal: stop(t, 30) });
  assert.equal(out.kind, "done");
  assert.equal(sends, 1);
});

test("a move over unlanded (unused at a block past its deadline, U's balance whole): a new move for what U holds, handed the old deadline", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = CREDIT;
  const asks: (number | null)[] = [];
  const moves: MoveRecord[] = [];
  const refundMove = mover((_u, m, ask) => {
    asks.push(ask.priorMs);
    moves.push(m);
    if (moves.length === 2) (t.chain.used.add(m.nonce), (t.chain.a.held = t.chain.b.held = 0n), t.chain.credit(CREDIT));
  });
  t.onTick.fn = () => (t.chain.a.timeMs = t.chain.b.timeMs = t.chain.a.timeMs + 60_000);
  const out = await followDeposit(t.args, { ...t.deps, refundMove, signal: stop(t, 30) });
  assert.equal(out.kind, "done");
  assert.equal(moves.length, 2);
  assert.deepEqual(asks, [null, moves[0]!.deadline_ms]);
  assert.equal((await opOf(t.w)).follow.prior_ms, undefined);
});

test("a refund under MIN_DEPOSIT waits for withdraw.open: the op is held (under_min), U as held_id, and its follow ends", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = 500_000n;
  let asked = 0;
  const refundMove = async (): Promise<RefundMoveResult> => (asked++, { kind: "under_min" });
  const out = await followDeposit(t.args, { ...t.deps, refundMove, signal: stop(t, 30) });
  assert.deepEqual(out, { kind: "held", why: "under_min" });
  const op = await opOf(t.w);
  assert.equal(op.held_id, t.u);
  assert.ok(followEnded(op));
  assert.equal(asked, 1);
});

test("a refused quote (off the request, the helper down) records and sends nothing; a later round asks again", async () => {
  const t = await setup(["REFUNDED"]);
  t.chain.a.held = t.chain.b.held = CREDIT;
  let refusals = 0;
  const ok = mover((_u, m) => void (t.chain.used.add(m.nonce), (t.chain.a.held = t.chain.b.held = 0n), t.chain.credit(CREDIT)));
  const refundMove = async (ask: FollowMoveAsk): Promise<RefundMoveResult> => {
    if (refusals < 2) {
      refusals++;
      assert.equal((await opOf(t.w)).follow.move, undefined, "nothing recorded");
      assert.equal((await opOf(t.w)).stage, "refunded");
      return { kind: "refused", why: "quote_check_failed" };
    }
    return ok(ask);
  };
  const out = await followDeposit(t.args, { ...t.deps, refundMove, signal: stop(t, 60) });
  assert.equal(out.kind, "done");
  assert.equal(refusals, 2);
});

test("r4: a held op lifted to done with no waiter of its own gets its final in the same session, after the other op's follow ends", async () => {
  const t = await setup(["SUCCESS"]);
  // A: older, its status read SUCCESS, held (the relayer struck U) before its money bound; its quote outlives B's
  const A_DEADLINE = DEADLINE + 3_600_000;
  await t.w.put("ops", "dq-A", { kind: "deposit", stage: "held", held_id: t.u, since_ms: NOW, txs: [], created_ms: NOW - 1, follow: { network: "testnet", s: "1", i: t.i, u: t.u, address: "c".repeat(64), deadline_ms: A_DEADLINE, origin: ORIGIN, min_out: MIN_OUT, sent: true, status: "SUCCESS", delivered: "0", why: "sender_struck" } });
  t.chain.credit(2n * CREDIT); // both ops' money: A is lifted to done
  t.onTick.fn = () => (t.chain.a.timeMs = t.chain.b.timeMs = t.chain.a.timeMs + 600_000);
  const out = await followDeposit(t.args, { ...t.deps, untilFinal: true });
  assert.equal(out.kind, "done");
  assert.equal((await opOf(t.w)).follow.final, true);
  for (let k = 0; k < 400 && (await opOf(t.w, "dq-A")).follow.final !== true; k++) await turn();
  const a = await opOf(t.w, "dq-A");
  assert.equal(a.stage, "done");
  assert.equal(a.follow.final, true, "A's final written in this session");
});
