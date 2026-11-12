// The NEAR buy's note and payout are its own (src/near-buy.ts): two buys begun together never share a note or a W (the
// pick and the record's write under one network lock), a record is answered landed only on proof that its own payout
// paid its W (payout_taken otherwise, nothing signed for W), and an ask is never answered by another ask's amount.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import { depsOf, NEAR_BUY_KEY, NEAR_BUY_RESUMES, nearBuyKind, nearBuyRecordOf, resumeNearBuys, type NearBuyPage } from "../src/near-buy.ts";
import { runNearBuy } from "../src/near-trade.ts";
import { vaultScope } from "../src/withdraw/checks.ts";

const SEED = new Uint8Array(64).fill(0x42); // the public test seed
const NETWORK = "mainnet" as const;
const SCOPE = vaultScope(NETWORK)!;
const FEE = 20_000n;
const TX = "4".repeat(44);
const OTHER = "cd".repeat(32);
const ASK_A = { token: "a.near", amount: 3_000_000n, slippageBps: 100 };
const ASK_B = { token: "b.near", amount: 3_000_000n, slippageBps: 100 };

// no fetch from this file
globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as typeof fetch;

const worlds: { w: WalletStore; ns: NoteStore }[] = [];
after(() => {
  for (const v of worlds.splice(0)) (v.ns.close(), v.w.close());
});
async function world(values: bigint[]) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  for (const [k, value] of values.entries()) {
    let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k + 1));
    const commitment = noteCommitment(value, label, n.precommitment);
    n = await ns.move(n.id, "PLANNED", "INCOMING");
    await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(k) } });
  }
  return { w, ns };
}
/** A withdrawal of the note to `to` as withdrawRequest makes it: HELD, then RESERVED with a request naming `to`. */
async function reserve(ns: NoteStore, note: string, to: string) {
  const n = await ns.move(note, "UNSPENT", "HELD", { deadlineMs: 1n, context: String(Math.floor(Math.random() * 1e9)) });
  return ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt!, request: JSON.stringify({ withdrawal: { recipient: to } }) });
}
type Paid = { recipient: string; note: string };
/** The page: the hand-off holds the note only inside the request (after a quote and a sync), then lands it to W. */
function pageOf(v: { w: WalletStore; ns: NoteStore }, o: { die?: boolean } = {}) {
  const paid: Paid[] = [];
  const calls: string[] = [];
  const page: NearBuyPage = {
    network: NETWORK,
    store: async () => v.w,
    notes: async () => v.ns,
    seed64: async () => Uint8Array.from(SEED),
    seedLock: (fn) => fn(),
    fee: async () => FEE,
    handoff: async (w, _drawn, note) => {
      calls.push("handoff");
      await reserve(v.ns, note!, w.recipient);
      // the page dies with the payout out: nothing answered
      if (o.die) throw new Error("page gone");
      await v.ns.move(note!, "RESERVED", "SPENT");
      paid.push({ recipient: w.recipient, note: note! });
      return { kind: "arrived", tx: TX };
    },
    settle: async () => (calls.push("settle"), { outcomes: {} }),
    rpcs: () => {
      throw new Error("no reads here");
    },
    readWallet: async () => {
      calls.push("readWallet");
      throw new Error("no reads here");
    },
    pools: async () => [],
    wait: async () => {},
    log: () => {},
  };
  return { page, paid, calls };
}
/** `f` polled until it holds, at most `n` times 10 ms apart. */
async function until(f: () => Promise<boolean>, n = 300): Promise<boolean> {
  for (let i = 0; i < n; i++) {
    if (await f()) return true;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  return false;
}
const recOf = async (v: { w: WalletStore }, id: string) => nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}${id}`))!;

test("R1 two buys of two tokens begun together pick two notes (two Ws)", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page } = pageOf(v);
  const a = depsOf(page, null, "req-a");
  const b = depsOf(page, null, "req-b");
  // a tap on token A and a tap on token B: the sign page runs trade kinds side by side (api.ts: a running kind does not hold the queue)
  const [ba, bb] = await Promise.all([a.begin(ASK_A), b.begin(ASK_B)]);
  a.release();
  b.release();
  assert.notEqual(ba!.w.id, bb!.w.id, "two buys share one W and one note");
  assert.notEqual((await recOf(v, "req-a")).note, (await recOf(v, "req-b")).note);
});

test("R2 two buys begun together: each payout is its own hand-off to its own W, never answered landed by the other's", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page, paid } = pageOf(v);
  const a = depsOf(page, null, "req-a");
  const b = depsOf(page, null, "req-b");
  const [ba, bb] = (await Promise.all([a.begin(ASK_A), b.begin(ASK_B)])) as [NonNullable<Awaited<ReturnType<typeof a.begin>>>, NonNullable<Awaited<ReturnType<typeof b.begin>>>];
  const endA = await a.payout().finally(a.release);
  const endB = await b.payout().finally(b.release);
  assert.deepEqual(endA, { kind: "landed", tx: TX });
  assert.deepEqual(endB, { kind: "landed", tx: TX }, "B's own payout's answer");
  assert.deepEqual(
    paid.map((p) => p.recipient),
    [ba.w.id, bb.w.id],
    "B answered landed with no payout of its own",
  );
});

test("a note another withdrawal spent before the record asked: payout_taken, refused, no hand-off, nothing read or signed for W", async () => {
  const v = await world([5_000_000n]);
  const { page, calls } = pageOf(v);
  const a = depsOf(page, null, "req-a");
  await a.begin(ASK_A);
  a.release();
  // the withdraw form (or any other spend) takes the note to another account before the buy asks
  const note = (await recOf(v, "req-a")).note;
  await reserve(v.ns, note, OTHER);
  await v.ns.move(note, "RESERVED", "SPENT");
  const d = depsOf(page, "req-a", "req-a");
  const answer = await runNearBuy(d, ASK_A).finally(d.release);
  assert.deepEqual(answer, { error: "payout_taken" });
  assert.deepEqual(calls, [], "no hand-off, no settle, no read of W");
  const r = await recOf(v, "req-a");
  assert.deepEqual([r.stage, r.code], ["refused", "payout_taken"]);
  assert.equal(((await v.w.get("ops", "req-a")) as { code: string }).code, "payout_taken");
});

test("a note RESERVED by a withdrawal that is not the record's (never asked, or its request pays another account): taken, no settle followed", async () => {
  for (const asked of [false, true]) {
    const v = await world([5_000_000n]);
    const { page, calls } = pageOf(v);
    const a = depsOf(page, null, "req-a");
    await a.begin(ASK_A);
    const note = (await recOf(v, "req-a")).note;
    if (asked) await v.w.put("quotes", `${NEAR_BUY_KEY}req-a`, { ...(await recOf(v, "req-a")), payout: "asked" });
    await reserve(v.ns, note, OTHER);
    a.release();
    const d = depsOf(page, "req-a", "req-a");
    const end = await d.begin(ASK_A).then(() => d.payout()).finally(d.release);
    assert.deepEqual(end, { kind: "taken" }, `asked ${asked}`);
    assert.deepEqual(calls, [], `asked ${asked}`);
  }
});

test("B3 a record whose own payout landed is answered landed on a resume (its note SPENT), with the payout's tx, no second hand-off and no read", async () => {
  const v = await world([5_000_000n]);
  const { page, calls } = pageOf(v);
  let rows = 0;
  page.arrival = async () => (rows++, Promise.reject(new Error("not read")));
  const a = depsOf(page, null, "req-a");
  await a.begin(ASK_A);
  const first = await a.payout();
  await a.progress({ step: "create", stage: "sent", txs: [{ chain: "near", hash: TX }], code: "read_failed" });
  a.release();
  assert.deepEqual(first, { kind: "landed", tx: TX });
  assert.equal((await recOf(v, "req-a")).payout, "landed");
  const d = depsOf(page, "req-a", "req-a");
  const end = await d.begin(ASK_A).then(() => d.payout()).finally(d.release);
  assert.deepEqual(end, { kind: "landed", tx: TX });
  assert.deepEqual([calls, rows], [["handoff"], 0]);
});

test("asked and not known (the page died with the payout out, the note SPENT since): the vault's spend row of the note's nullifier decides", async () => {
  for (const [kind, recipient, want] of [
    ["arrived", "W", { kind: "landed", tx: null }],
    ["elsewhere", OTHER, { kind: "taken" }],
    ["refunded", "W", { kind: "refunded" }],
  ] as const) {
    const v = await world([5_000_000n]);
    const { page, calls } = pageOf(v, { die: true });
    const asked: { nullifierHash: bigint; recipient: string }[] = [];
    const a = depsOf(page, null, "req-a");
    const begun = (await a.begin(ASK_A))!;
    await assert.rejects(a.payout().finally(a.release), /page gone/);
    const r = await recOf(v, "req-a");
    assert.equal(r.payout, "asked", "asked before the hand-off");
    // the settle pass of a later load landed the note
    await v.ns.move(r.note, "RESERVED", "SPENT");
    page.arrival = async (x) => (asked.push({ nullifierHash: x.nullifierHash, recipient: x.recipient }), { kind, spend: { recipient: recipient === "W" ? begun.w.id : recipient } } as never);
    const d = depsOf(page, "req-a", "req-a");
    const end = await d.begin(ASK_A).then(() => d.payout()).finally(d.release);
    assert.deepEqual(end, want, kind);
    const n = (await v.ns.get(r.note))!;
    assert.deepEqual(asked, [{ nullifierHash: noteSecrets(SEED, n.ref).nullifierHash, recipient: begun.w.id }], kind);
    assert.deepEqual(calls, ["handoff"], kind);
    if (kind === "arrived") assert.equal((await recOf(v, "req-a")).payout, "landed");
  }
});

test("asked, its note RESERVED by its own request (it pays W): the settle pass decides; arrived is landed, elsewhere is taken", async () => {
  for (const [out, want] of [
    ["arrived", { kind: "landed", tx: null }],
    ["elsewhere", { kind: "taken" }],
    ["refunded", { kind: "refunded" }],
  ] as const) {
    const v = await world([5_000_000n]);
    const { page } = pageOf(v, { die: true });
    page.settle = async () => ({ outcomes: Object.fromEntries((await v.ns.list()).filter((n) => n.state === "RESERVED").map((n) => [n.id, out])) });
    const a = depsOf(page, null, "req-a");
    await a.begin(ASK_A);
    await assert.rejects(a.payout().finally(a.release), /page gone/);
    const d = depsOf(page, "req-a", "req-a");
    const end = await d.begin(ASK_A).then(() => d.payout()).finally(d.release);
    assert.deepEqual(end, want, out);
  }
});

test("F5 a new ask of a token with an unfinished record runs as its own record with its own amount and op; the unfinished record is taken up after it, with its own amount", async () => {
  const v = await world([5_000_000n, 10_000_000n, 20_000_000n]);
  const { page, paid } = pageOf(v, { die: true });
  const first = depsOf(page, null, "req-1");
  const a = (await first.begin(ASK_A))!;
  // the page dies while the payout is out: the note RESERVED, the record pending
  await assert.rejects(first.payout().finally(first.release), /page gone/);
  // an unfinished record of another token, left for a load, never for this ask
  const otherToken = depsOf(page, null, "req-b");
  await otherToken.begin({ ...ASK_B, amount: 15_000_000n });
  otherToken.release();
  page.settle = async () => ({ outcomes: Object.fromEntries((await v.ns.list()).filter((n) => n.state === "RESERVED").map((n) => [n.id, "arrived"])) });
  const { page: live, paid: livePaid } = pageOf(v);
  live.settle = page.settle;
  // the app's Retry: a new request id with another amount
  const run = nearBuyKind(live)({ ...ASK_A, amount: 1_000_000n }, { id: "req-2", sha: "0", progress: () => {} } as never);
  assert.ok("running" in run);
  await run.after;
  assert.ok(await until(async () => (await recOf(v, "req-1")).resumes === 1), "the unfinished record taken up after the ask");
  const r1 = await recOf(v, "req-1");
  const r2 = await recOf(v, "req-2");
  assert.equal((await recOf(v, "req-b")).resumes, 0, "another token's record is not this ask's to take up");
  assert.equal(r1.amount, "3000000");
  assert.ok(r2, "the ask is a record of its own");
  assert.equal(r2.amount, "1000000", "the ask's own amount");
  assert.notEqual(r2.w, a.w.id);
  assert.notEqual(r2.note, r1.note);
  assert.equal(((await v.w.get("ops", "req-2")) as { stage: string } | undefined)?.stage, r2.stage, "the ask's own op");
  assert.deepEqual([...paid, ...livePaid].map((p) => p.recipient), [r2.w], "the ask's own payout, of its own amount, to its own W");
});

test("a buy that ended carry_failed at its swap (the USDC back on W) is never taken up as a buy again: not on a load, not before an ask, not by its resume", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page, calls } = pageOf(v);
  const a = depsOf(page, null, "req-a");
  await a.begin(ASK_A);
  await a.payout();
  // the run's end at the relayer's bound of swap rounds: sent, step swap, code carry_failed
  await a.progress({ step: "swap", stage: "sent", txs: [{ chain: "near", hash: TX }], code: "carry_failed" });
  a.release();
  calls.length = 0;
  const lines: string[] = [];
  page.log = (l) => void lines.push(l);
  await resumeNearBuys(page);
  const d = depsOf(page, "req-a", "req-a");
  const again = await d.begin(ASK_A).finally(d.release);
  assert.equal(again, null, "its resume finds no open buy");
  const run = nearBuyKind(page)({ ...ASK_A, amount: 1_000_000n }, { id: "req-2", sha: "0", progress: () => {} } as never);
  assert.ok("running" in run);
  await run.after;
  const r = await recOf(v, "req-a");
  assert.deepEqual([r.resumes, r.stage, r.code], [0, "sent", "carry_failed"], lines.join(" | "));
  assert.ok(!lines.some((l) => l.includes("resumed")), lines.join(" | "));
});

test("a new ask reaches its own pick at once while an older record's payout is still being followed (never waits on another record's run)", async () => {
  // the older record followed by a load, or by nobody yet (the ask never takes it up first)
  for (const loading of [true, false]) {
    const v = await world([5_000_000n, 10_000_000n]);
    const { page } = pageOf(v, { die: true });
    const first = depsOf(page, null, "req-1");
    await first.begin(ASK_A);
    await assert.rejects(first.payout().finally(first.release), /page gone/);
    // req-1's payout followed: its settle pass does not answer until freed
    let free!: () => void;
    const held = new Promise<void>((ok) => (free = ok));
    const { page: live } = pageOf(v);
    live.settle = async () => (await held, { outcomes: Object.fromEntries((await v.ns.list()).filter((n) => n.state === "RESERVED").map((n) => [n.id, "arrived"])) });
    const load = loading ? resumeNearBuys(live) : Promise.resolve();
    if (loading) assert.ok(await until(async () => (await recOf(v, "req-1")).resumes === 1), "the load took req-1 up");
    const run = nearBuyKind(live)({ ...ASK_A, amount: 1_000_000n }, { id: "req-2", sha: "0", progress: () => {} } as never);
    assert.ok("running" in run);
    const picked = await until(async () => nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}req-2`)) !== undefined, 200);
    free();
    await load;
    await run.after;
    // the take-up after the ask ends on its own
    await until(async () => (await recOf(v, "req-1")).stage !== "pending", 200);
    assert.ok(picked, `the ask's record was written while req-1's payout was still followed (load ${loading})`);
  }
});

/** A record left at the resume cap: its payout `mark`, its note in `state`. */
async function capped(mark: "none" | "asked", state: "UNSPENT" | "SPENT" | "RESERVED") {
  const v = await world([5_000_000n]);
  const { page, calls } = pageOf(v, { die: mark === "asked" });
  const a = depsOf(page, null, "req-a");
  const begun = (await a.begin(ASK_A))!;
  if (mark === "asked") await assert.rejects(a.payout(), /page gone/);
  a.release();
  const r = await recOf(v, "req-a");
  if (mark === "asked" && state === "UNSPENT") await v.ns.move(r.note, "RESERVED", "UNSPENT", { blockTimeMs: 10n ** 15n });
  if (mark === "asked" && state === "SPENT") await v.ns.move(r.note, "RESERVED", "SPENT");
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-a`, { ...r, stage: mark === "asked" ? "sent" : "pending", code: "not_known", resumes: NEAR_BUY_RESUMES });
  calls.length = 0;
  return { v, page, calls, w: begun.w.id, note: r.note };
}

test("a record at the resume cap never asked: a load ends it refused and frees its note for the next buy, nothing asked", async () => {
  const { v, page, calls, note } = await capped("none", "UNSPENT");
  await resumeNearBuys(page);
  const r = await recOf(v, "req-a");
  assert.deepEqual([r.stage, r.code, r.resumes], ["refused", "payout_none", NEAR_BUY_RESUMES]);
  assert.equal(((await v.w.get("ops", "req-a")) as { stage: string }).stage, "refused");
  assert.deepEqual(calls, []);
  const d = depsOf(page, null, "req-b");
  const b = await d.begin(ASK_A).finally(d.release);
  assert.ok(b, "the note is free again");
  assert.equal((await recOf(v, "req-b")).note, note);
});

test("a record at the resume cap that asked: a load decides it by the vault's spend row without counting a resume (landed, payout_taken, payout_refunded); its note freed and never asked again", async () => {
  for (const [kind, want] of [
    ["arrived", { payout: "landed", stage: "sent" }],
    ["elsewhere", { payout: "asked", stage: "refused", code: "payout_taken" }],
    ["refunded", { payout: "asked", stage: "refused", code: "payout_refunded" }],
  ] as const) {
    const { v, page, calls, w } = await capped("asked", "SPENT");
    page.arrival = async () => ({ kind, spend: { recipient: kind === "elsewhere" ? OTHER : w } }) as never;
    await resumeNearBuys(page);
    const r = await recOf(v, "req-a");
    assert.deepEqual({ payout: r.payout, stage: r.stage, ...(want.stage === "refused" ? { code: r.code } : {}) }, want, kind);
    assert.equal(r.resumes, NEAR_BUY_RESUMES, kind);
    assert.deepEqual(calls, [], kind);
  }
  // its payout expired and the note freed: refused, the note never asked again
  const { v, page, calls } = await capped("asked", "UNSPENT");
  await resumeNearBuys(page);
  const r = await recOf(v, "req-a");
  assert.deepEqual([r.stage, r.code], ["refused", "payout_none"]);
  assert.deepEqual(calls, []);
});
