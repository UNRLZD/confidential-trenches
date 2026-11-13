// The page's binding of the NEAR buy (src/near-buy.ts): the record before the payout, W from the picked note, an
// unfinished record taken up again instead of a second payout, the payout routed by the note's state, the helper's
// answer checked, the signer held to the record's W. A fake store (fake-indexeddb) and fakes for every network part.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { HELPER_CODE_STATUS, type HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import { nearSwapWallet } from "../../wallet/src/near/swap-delegate.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { depsOf, NEAR_BUY_KEY, NEAR_BUY_RESUMES, NEAR_SELL_RESUMES, nearBuyRecordOf, nearPositions, nearSellKind, readNearDecimals, resumeNearBuys, resumeNearSells, sellDepsOf, sendNearTrade, type NearBuyPage } from "../src/near-buy.ts";
import { vaultScope } from "../src/withdraw/checks.ts";
import type { HandoffEnd } from "../src/withdraw/handoff.ts";

const SEED = new Uint8Array(64).fill(0x42); // the public test seed
const NETWORK = "mainnet" as const;
const SCOPE = vaultScope(NETWORK)!;
const FEE = 20_000n;
const TOKEN = "token.rhealab.near";
const ASK = { token: TOKEN, amount: 3_000_000n, slippageBps: 100 };
const TX = "4".repeat(44);

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
type Ev = [string, ...unknown[]];
function pageOf(v: { w: WalletStore; ns: NoteStore }, o: { end?: HandoffEnd; settle?: string } = {}) {
  const ev: Ev[] = [];
  const page: NearBuyPage = {
    network: NETWORK,
    store: async () => v.w,
    notes: async () => v.ns,
    seed64: async () => Uint8Array.from(SEED),
    seedLock: (fn) => fn(),
    fee: async () => FEE,
    handoff: async (w, drawn, note) => {
      // the record is on the store before the payout is asked
      ev.push(["handoff", w, drawn, note, (await v.w.keys("quotes")).filter((k) => k.startsWith(NEAR_BUY_KEY)).length]);
      await v.ns.move(note!, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" }).then((n) => v.ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt!, request: JSON.stringify({ withdrawal: { recipient: w.recipient } }) }));
      return o.end ?? { kind: "arrived", tx: TX };
    },
    settle: async () => (ev.push(["settle"]), { outcomes: Object.fromEntries((await v.ns.list()).filter((n) => n.state === "RESERVED").map((n) => [n.id, (o.settle ?? "arrived") as never])) }),
    rpcs: () => {
      throw new Error("no reads here");
    },
    pools: async () => [],
    log: (line) => void ev.push(["log", line]),
  };
  return { page, ev };
}

test("a new buy: the smallest note covering the amount and the fee is picked, W is W_{near,l,j} of it, and the record and its op are written before the payout is asked", async () => {
  const v = await world([2_000_000n, 5_000_000n, 10_000_000n]);
  const { page, ev } = pageOf(v);
  const d = depsOf(page, null, "req-1");
  const begun = await d.begin(ASK);
  assert.ok(begun);
  const note = (await v.ns.list()).find((n) => n.leaf?.value === 5_000_000n)!;
  const w = nearSwapWallet(SEED, note.leaf!.label, jOf(note.ref)).id;
  assert.deepEqual(begun.w, { id: w, l: note.leaf!.label, j: jOf(note.ref) });
  const rec = nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}req-1`))!;
  assert.equal(rec.note, note.id);
  assert.equal(rec.w, w);
  assert.equal(rec.stage, "pending");
  assert.deepEqual(await v.w.get("ops", "req-1"), { kind: "buy", chain: "near", token: TOKEN, stage: "pending", txs: [], created_ms: rec.created_ms });
  // the op the frame reads names no W, note or index
  assert.ok(!JSON.stringify(await v.w.get("ops", "req-1")).includes(w));
  const end = await d.payout();
  assert.deepEqual(end, { kind: "landed", tx: TX });
  assert.deepEqual(ev.find((e) => e[0] === "handoff"), ["handoff", { recipient: w, amount: ASK.amount }, FEE, note.id, 1]);
  d.release();
});

test("no note covers the amount and the fee: refused, nothing written", async () => {
  const v = await world([3_000_000n]);
  const { page } = pageOf(v);
  const d = depsOf(page, null, "req-1");
  assert.equal(await d.begin(ASK), null);
  assert.deepEqual(await v.w.keys("quotes"), []);
});

test("P1-1 an unfinished buy is taken up by its own resume: the same W and note, its payout followed, never asked twice; a new ask never takes it", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page, ev } = pageOf(v);
  const first = depsOf(page, null, "req-1");
  const a = (await first.begin(ASK))!;
  // the page dies while the payout is out: the note RESERVED, the record pending
  await first.payout();
  first.release();
  ev.length = 0;
  // a new ask of the token is a record of its own: another note, never the unfinished one
  const other = depsOf(page, null, "req-2");
  const b = (await other.begin({ ...ASK, amount: 1_000_000n }))!;
  other.release();
  assert.notDeepEqual(b.w, a.w);
  assert.equal(b.ask.amount, 1_000_000n, "the ask's own amount");
  assert.equal(((await v.w.get("ops", "req-2")) as { stage: string }).stage, "pending", "the ask's own op");
  // the record's resume follows its payout
  const again = depsOf(page, "req-1", "req-1");
  const c = (await again.begin(ASK))!;
  assert.deepEqual(c.w, a.w);
  assert.equal(c.ask.amount, ASK.amount, "the record's own ask");
  assert.deepEqual(await again.payout(), { kind: "landed", tx: null });
  assert.deepEqual(ev.map((e) => e[0]).filter((x) => x !== "log"), ["settle"]);
  const rec = nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}req-1`))!;
  assert.equal(rec.resumes, 1);
  again.release();
  // past NEAR_BUY_RESUMES the record is left as it is
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-1`, { ...rec, resumes: NEAR_BUY_RESUMES });
  const third = depsOf(page, "req-1", "req-1");
  assert.equal(await third.begin(ASK), null);
  third.release();
});

test("an ended record (filled or refused) is not taken: a new buy of the same token picks a new note", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page } = pageOf(v);
  const d = depsOf(page, null, "req-1");
  const a = (await d.begin(ASK))!;
  await d.payout();
  await d.progress({ step: "receive", stage: "filled", txs: [] });
  d.release();
  const e = depsOf(page, null, "req-2");
  const b = (await e.begin(ASK))!;
  assert.notDeepEqual(b.w, a.w);
  e.release();
});

test("a payout that did not reach W ends with its kind (refunded, the fee's new quote); a spend that is not this device's throws", async () => {
  for (const [end, want] of [
    [{ kind: "refunded" }, { kind: "refunded" }],
    [{ kind: "fee", fee: 1n }, { kind: "fee" }],
  ] as const) {
    const v = await world([5_000_000n]);
    const { page } = pageOf(v, { end: end as HandoffEnd });
    const d = depsOf(page, null, "r");
    await d.begin(ASK);
    assert.deepEqual(await d.payout(), want);
    d.release();
  }
  const v = await world([5_000_000n]);
  const { page } = pageOf(v, { end: { kind: "unmatched" } as HandoffEnd });
  const d = depsOf(page, null, "r");
  await d.begin(ASK);
  await assert.rejects(d.payout(), /not this device's/);
  d.release();
});

test("the progress lands on the record and its op: stage, code, cause, txs, the swap's floor; the code goes when a later step has none", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  const d = depsOf(page, null, "r");
  await d.begin(ASK);
  await d.progress({ step: "swap", stage: "sent", txs: [{ chain: "near", hash: TX }], code: "in_flight", cause: "Error at send", swap: { floor: "5", before: "0" } });
  let rec = nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}r`))!;
  assert.deepEqual([rec.step, rec.stage, rec.code, rec.cause, rec.swap, rec.txs], ["swap", "sent", "in_flight", "Error at send", { floor: "5", before: "0" }, [{ chain: "near", hash: TX }]]);
  assert.deepEqual(await v.w.get("ops", "r"), { kind: "buy", chain: "near", token: TOKEN, stage: "sent", txs: [{ chain: "near", hash: TX }], created_ms: rec.created_ms, code: "in_flight" });
  await d.progress({ step: "receive", stage: "filled", txs: [{ chain: "near", hash: TX }] });
  rec = nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}r`))!;
  assert.equal(rec.code, undefined);
  assert.deepEqual(rec.swap, { floor: "5", before: "0" });
  d.release();
});

test("the signer is held to the record's W: a request for another wallet is refused before any key signs", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  const d = depsOf(page, null, "r");
  await d.begin(ASK);
  await assert.rejects(Promise.resolve().then(() => d.sign([], { network: NETWORK, side: "buy", token: TOKEN, amountIn: ASK.amount, wallet: "cd".repeat(32), slippageBps: 100 }, {} as never, {} as never, TOKEN)), /not the record's/);
  d.release();
});

test("the helper's answer is checked: tx hashes at 200, a trade code at its own status (with the txs it carried), anything else thrown", async () => {
  const body = { trade: {}, signed_delegates: [] } as unknown as HelperBindTradeRequest;
  const at = (status: number, json: unknown) => (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
  assert.deepEqual(await sendNearTrade(body, at(200, { tx_hashes: [TX] })), { ok: true, tx_hashes: [TX] });
  assert.deepEqual(await sendNearTrade(body, at(HELPER_CODE_STATUS.wallet_exists, { error: { code: "wallet_exists" } })), { ok: false, code: "wallet_exists" });
  assert.deepEqual(await sendNearTrade(body, at(HELPER_CODE_STATUS.carry_failed, { error: { code: "carry_failed" }, tx_hashes: [TX] })), { ok: false, code: "carry_failed", tx_hashes: [TX] });
  assert.deepEqual(await sendNearTrade(body, at(503, { error: { code: "upstream" } })), { ok: false, code: "upstream" });
  // the relayer at bcb795f2's new codes, each at the kit's status for it
  for (const code of ["already_registered", "token_mismatch", "token_untrusted", "no_account"] as const) {
    const status = (HELPER_CODE_STATUS as Record<string, number>)[code] ?? 400;
    assert.deepEqual(await sendNearTrade(body, at(status, { error: { code } })), { ok: false, code }, code);
  }
  assert.deepEqual([(HELPER_CODE_STATUS as Record<string, number>).already_registered, (HELPER_CODE_STATUS as Record<string, number>).token_mismatch, (HELPER_CODE_STATUS as Record<string, number>).no_account ?? 400], [409, 409, 400], "no_account at the kit's default, 400");
  assert.deepEqual(await sendNearTrade(body, at(200, { tx_hashes: [] })), { ok: true, tx_hashes: [] }, "an adopted W");
  assert.deepEqual(await sendNearTrade(body, at(429, { error: { code: "rate_limited" } })), { ok: false, code: "upstream" });
  for (const [status, json] of [
    [400, { error: { code: "wallet_exists" } }],
    [200, { tx_hashes: [TX], extra: 1 }],
    [400, { error: { code: "made_up" } }],
    [200, { tx_hashes: "x" }],
  ] as const)
    await assert.rejects(sendNearTrade(body, at(status, json)), /not an answer/);
  await assert.rejects(sendNearTrade(body, (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch), /not JSON/);
});

// ---- the sell's binding (deps.near.sell) ----

/** A buy whose payout landed: its record at `stage`, its note SPENT (or left RESERVED when `spent` is false). */
async function paid(page: NearBuyPage, v: { ns: NoteStore }, id: string, stage: "sent" | "filled" | "pending" | "refused" = "filled", spent = true) {
  let t = 0;
  page.now ??= () => ++t;
  const d = depsOf(page, null, id);
  const b = (await d.begin(ASK))!;
  await d.payout();
  // filled first, so the next buy of the token is a new one; then the stage asked. The floor as the flow writes it
  // before its swap leaves (src/near-trade.ts): a coin of 1 or more is W's
  await d.progress({ step: "receive", stage: "filled", txs: [{ chain: "near", hash: TX }], swap: { floor: "1", before: "0" } });
  d.release();
  const store = await page.store();
  const rec = nearBuyRecordOf(await store.get("quotes", `${NEAR_BUY_KEY}${id}`))!;
  if (spent) await v.ns.move(rec.note, "RESERVED", "SPENT");
  return { w: b.w, set: () => store.put("quotes", `${NEAR_BUY_KEY}${id}`, { ...rec, stage }) };
}
const recOf = async (v: { w: WalletStore }, id: string) => nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}${id}`))!;

test("sell: W is the oldest paid buy of the token (its note SPENT), its sell and the sell's op written before W is answered; the buy's own run never takes that record again", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page } = pageOf(v);
  const b1 = await paid(page, v, "b1", "sent");
  await paid(page, v, "b2");
  await b1.set();
  const w1 = b1.w;
  const d = sellDepsOf(page, null, "s1", 150);
  const got = await d.wallet(TOKEN);
  d.release();
  assert.deepEqual(got, { ...w1, token: TOKEN, coinMin: 1n }, "the older paid buy, with the token its record names");
  const rec = await recOf(v, "b1");
  assert.deepEqual({ ...rec.sell, created_ms: 0 }, { id: "s1", slippage_bps: 150, created_ms: 0, resumes: 0, stage: "pending", step: "read", txs: [] });
  assert.deepEqual(await v.w.get("ops", "s1"), { kind: "sell", chain: "near", token: TOKEN, stage: "pending", txs: [], created_ms: rec.sell!.created_ms });
  assert.ok(!JSON.stringify(await v.w.get("ops", "s1")).includes(w1.id), "the op names no W");
  d.release();
  // b1 was "sent" (an open buy): its own run leaves it now, on an ask and on a load
  const ev: string[] = [];
  const { page: p2 } = pageOf(v);
  p2.log = (line) => void ev.push(line);
  await resumeNearBuys(p2);
  assert.ok(!ev.some((l) => l.includes("resumed")), ev.join("|"));
  const again = depsOf(page, null, "b3");
  const b3 = await again.begin(ASK);
  assert.equal(b3, null, "no note left, and b1 is not taken");
  again.release();
});

test("sell: a buy not paid (pending, refused, or its note not SPENT with its payout not proven landed) and a W already sold are never sold; none left: null, nothing written", async () => {
  const v = await world([5_000_000n, 6_000_000n, 7_000_000n, 8_000_000n]);
  const { page } = pageOf(v);
  const sets = [await paid(page, v, "pending", "pending", false), await paid(page, v, "refused", "refused"), await paid(page, v, "reserved", "filled", false)];
  await paid(page, v, "sold");
  for (const x of sets) await x.set();
  // the note RESERVED and the payout only asked: no proof W was paid
  await v.w.put("quotes", `${NEAR_BUY_KEY}reserved`, { ...(await recOf(v, "reserved")), payout: "asked" });
  const r = await recOf(v, "sold");
  await v.w.put("quotes", `${NEAR_BUY_KEY}sold`, { ...r, sell: { id: "s0", slippage_bps: 100, created_ms: 1, resumes: 0, stage: "filled", step: "done", txs: [] } });
  for (const token of [TOKEN, "other.near"]) {
    const d = sellDepsOf(page, null, "s1", 100);
    assert.equal(await d.wallet(token), null);
    d.release();
  }
  assert.equal(await v.w.get("ops", "s1"), undefined);
});

test("sell: an unfinished sell is continued by the next tap (same op, resumes + 1, even past the load's bound), never a second one on another W", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page } = pageOf(v);
  const w1 = (await paid(page, v, "b1")).w;
  await paid(page, v, "b2");
  const r = await recOf(v, "b2");
  await v.w.put("quotes", `${NEAR_BUY_KEY}b2`, { ...r, sell: { id: "s0", slippage_bps: 120, created_ms: 1, resumes: NEAR_BUY_RESUMES, stage: "sent", step: "move", txs: [{ chain: "near", hash: TX }] } });
  const d = sellDepsOf(page, null, "s-new", 300);
  const w = await d.wallet(TOKEN);
  assert.notDeepEqual(w, w1, "the W with the open sell, not the older unsold one");
  const m = (await recOf(v, "b2")).sell!;
  assert.deepEqual([m.id, m.resumes, m.slippage_bps, m.txs.length], ["s0", NEAR_BUY_RESUMES + 1, 120, 1]);
  assert.equal(await v.w.get("ops", "s-new"), undefined);
  d.release();
});

test("sell: the end lands on the record and its op: sent keeps the stop's code and cause, filled clears them, an error is refused with its code; txs kept once each", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  const d = sellDepsOf(page, null, "s1", 100);
  await d.wallet(TOKEN);
  d.log("swap", "swapped");
  d.stop!("move", "sender_struck", "Error at bind");
  await d.end({ result: { stage: "sent", txs: [{ chain: "near", hash: TX }] } });
  let m = (await recOf(v, "b1")).sell!;
  assert.deepEqual([m.stage, m.step, m.code, m.cause, m.txs], ["sent", "move", "sender_struck", "Error at bind", [{ chain: "near", hash: TX }]]);
  assert.deepEqual(await v.w.get("ops", "s1"), { kind: "sell", chain: "near", token: TOKEN, stage: "sent", txs: [{ chain: "near", hash: TX }], created_ms: m.created_ms, code: "sender_struck" });
  const TX2 = "5".repeat(44);
  await d.end({ result: { stage: "filled", txs: [{ chain: "near", hash: TX }, { chain: "near", hash: TX2 }] } });
  m = (await recOf(v, "b1")).sell!;
  assert.deepEqual([m.stage, m.code, m.cause, m.txs.length], ["filled", undefined, undefined, 2]);
  d.release();
  const v2 = await world([5_000_000n]);
  const { page: p2 } = pageOf(v2);
  await paid(p2, v2, "b1");
  const e = sellDepsOf(p2, null, "s2", 100);
  await e.wallet(TOKEN);
  await e.end({ error: "quote_check_failed" });
  m = (await recOf(v2, "b1")).sell!;
  assert.deepEqual([m.stage, m.code], ["refused", "quote_check_failed"]);
  e.release();
  // a refused sell is ended: the next tap starts a new one on the same W (its token is still there)
  const f = sellDepsOf(p2, null, "s3", 100);
  assert.ok(await f.wallet(TOKEN));
  assert.equal((await recOf(v2, "b1")).sell!.id, "s3");
  f.release();
});

test("sell: the signer is held to the record's W, its indexes and its token; W's return note is the vault scope's, written PLANNED", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  const w = (await paid(page, v, "b1")).w;
  const d = sellDepsOf(page, null, "s1", 100);
  await d.wallet(TOKEN);
  const req = { network: NETWORK, side: "sell" as const, token: TOKEN, amountIn: 1n, wallet: w.id, slippageBps: 100 };
  for (const [l, j, r, bound] of [
    [w.l + 1n, w.j, req, TOKEN],
    [w.l, w.j + 1, req, TOKEN],
    [w.l, w.j, { ...req, wallet: "cd".repeat(32) }, TOKEN],
    [w.l, w.j, req, "other.near"],
  ] as const)
    await assert.rejects(Promise.resolve().then(() => d.sign(l, j, [], r, {} as never, {} as never, bound)), /not the record's/);
  assert.equal(await d.note({ ...w, token: TOKEN }, 0, false), null);
  const n = (await d.note({ ...w, token: TOKEN }, 0, true))!;
  assert.equal(n.state, "PLANNED");
  const stored = (await v.ns.get(n.id))!;
  assert.deepEqual([stored.ref, stored.scope], [{ kind: "return", c: "near", l: w.l, j: w.j }, SCOPE]);
  d.release();
});

test("sell kind: no W for the token answers not_allowed and frees the token's lock (a buy of it is taken next)", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  const run = nearSellKind(page)({ token: TOKEN, slippageBps: 100 }, { id: "s1" } as never);
  assert.ok("running" in run);
  await run.after;
  assert.deepEqual(run.answer(), { error: "not_allowed" });
  const d = depsOf(page, null, "b1");
  assert.ok(await d.begin(ASK));
  d.release();
});

/** The page's reads of W: `token` and `usdc` held (undefined: the read fails). */
function reads(page: NearBuyPage, w: { token?: bigint; usdc?: bigint }) {
  const asked: string[] = [];
  page.readWallet = async (a) => {
    asked.push(a.side);
    const held = a.side === "sell" ? w.token : w.usdc;
    if (held === undefined) throw new Error("rpc down");
    return { account: a.wallet, height: 1, blockHash: "b", nonce: 1n, held, registered: true, storageMin: 0n, lostfound: 0n };
  };
  page.wait = async () => {};
  // nothing here reaches a network: the move's providers throw, its wait is over before it starts
  const no = { name: "none", query: async () => Promise.reject(new Error("no network in tests")), tx: async () => Promise.reject(new Error("no network in tests")) };
  page.bindRpcs = () => [no, no];
  page.signal = () => AbortSignal.abort();
  return asked;
}
// and no fetch at all from this file
globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as typeof fetch;

test("P2-3 load: a sell is taken up for a paid W whose money is on its way home (an open sell, a return note PLANNED or INCOMING, or none of the token and 1 USDC or more), never for a W holding the token unasked", async () => {
  for (const [name, set, w, want] of [
    ["open sell (past any count)", "open", { token: 0n, usdc: 0n }, true],
    ["return note PLANNED", "note", { token: 5n, usdc: 0n }, true],
    ["R note INCOMING", "r-note", { token: 5n, usdc: 0n }, true],
    ["a sale part filled", "part", { token: 0n, usdc: 0n }, false],
    ["1 USDC, no token", null, { token: 0n, usdc: 1_000_000n }, true],
    ["just under 1 USDC", null, { token: 0n, usdc: 999_999n }, false],
    // every build writes the floor before its swap leaves (src/near-trade.ts, swap step): a W holding its coin has one
    ["the token held, no sell asked", "floor", { token: 5n, usdc: 2_000_000n }, false],
    // a buy stopped before its swap (no floor: no swap ever left W) past its resumes: a stranger's dust on W never holds
    // its USDC back
    ["dust on a W whose buy stopped before its swap", "register", { token: 1n, usdc: 2_000_000n } as { token: bigint; usdc: bigint }, true],
    // a buy stopped at its swap, its floor written and the swap landed, no fill read yet: its coin is its own
    ["a buy at its swap, the floor written, the swap landed", "swap", { token: 5n, usdc: 2_000_000n }, false],
    ["W not read", null, {}, false],
  ] as const) {
    const v = await world([5_000_000n]);
    const { page } = pageOf(v);
    const b = await paid(page, v, "b1");
    if (set === "open") {
      const r = await recOf(v, "b1");
      await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...r, sell: { id: "s0", slippage_bps: 100, created_ms: 1, resumes: 9, stage: "sent", step: "move", txs: [] } });
    }
    if (set === "note") await v.ns.add({ ref: { kind: "return", c: "near", l: b.w.l, j: b.w.j }, scope: SCOPE, precommitment: 1n, state: "PLANNED" });
    if (set === "r-note") {
      // W's return note landed first (the store plans an R note only after it), then R's first second arrival on its way
      let ret = await v.ns.add({ ref: { kind: "return", c: "near", l: b.w.l, j: b.w.j }, scope: SCOPE, precommitment: 1n, state: "PLANNED" });
      ret = await v.ns.move(ret.id, "PLANNED", "INCOMING");
      await v.ns.move(ret.id, "INCOMING", "UNSPENT", { leaf: { value: 1_000_000n, label: 9n, commitment: noteCommitment(1_000_000n, 9n, 1n), leafIndex: 90n } });
      const n = await v.ns.add({ ref: { kind: "second", id: { id: "R", c: "near", l: b.w.l, j: b.w.j }, n: 0 }, scope: SCOPE, precommitment: 2n, state: "PLANNED" });
      await v.ns.move(n.id, "PLANNED", "INCOMING");
    }
    if (set === "part") {
      const r = await recOf(v, "b1");
      await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...r, sell: { id: "s0", slippage_bps: 100, created_ms: 1, resumes: 0, stage: "part_filled", step: "done", txs: [] } });
    }
    if (set === "floor") await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), swap: { floor: "5", before: "0" } });
    if (set === "register") {
      // stopped before its swap: no floor written
      const { swap: _s, ...r } = await recOf(v, "b1");
      await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...r, stage: "sent", step: "register", resumes: NEAR_BUY_RESUMES });
    }
    if (set === "swap") await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), stage: "sent", step: "swap", resumes: NEAR_BUY_RESUMES, swap: { floor: "5", before: "0" } });
    reads(page, w);
    // the dust row: W's USDC is moved into the vault (the move given, so the amount is seen), never stopped at a quote
    const moved: bigint[] = [];
    if (set === "register") page.move = async (_x, _n, amount) => (moved.push(amount), w.usdc !== undefined && (w.usdc -= amount), { kind: "deposited", txs: [TX], height: 1 });
    const lines: string[] = [];
    page.log = (l) => void lines.push(l);
    await resumeNearSells(page);
    const took = lines.some((l) => l.startsWith("near sell recorded") || l.startsWith("near sell resumed"));
    assert.equal(took, want, `${name}: ${lines.join(" | ")}`);
    if (took) assert.ok((await recOf(v, "b1")).sell, name);
    if (set === "register") {
      assert.ok(lines.includes("near sell move: in the vault"), `${name}: the move reached: ${lines.join(" | ")}`);
      assert.deepEqual(moved, [2_000_000n], `${name}: W's USDC in the vault`);
    }
  }
});

test("a part filled sale ends the sell: its stage kept, its code cleared, and the W is not sold again on a tap", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  const d = sellDepsOf(page, null, "s1", 100);
  await d.wallet(TOKEN);
  d.stop!("move", "p_used");
  await d.end({ result: { stage: "part_filled", txs: [] } });
  d.release();
  const m = (await recOf(v, "b1")).sell!;
  assert.deepEqual([m.stage, m.code], ["part_filled", undefined]);
  const e = sellDepsOf(page, null, "s2", 100);
  assert.equal(await e.wallet(TOKEN), null);
  e.release();
});

test("the record is never in the wallets store (arming/records.ts is its one writer)", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  assert.deepEqual(await v.w.keys("wallets"), []);
  assert.ok((await v.w.keys("quotes")).includes(`${NEAR_BUY_KEY}b1`));
});

test("P2-3 a sell sent before is never recorded or answered as nothing sold: an error after it keeps sent, with its txs", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  const r = await recOf(v, "b1");
  await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...r, sell: { id: "s0", slippage_bps: 100, created_ms: 1, resumes: 0, stage: "sent", step: "move", txs: [{ chain: "near", hash: TX }] } });
  // the tap that continues it: W's reads fail, the flow answers read_failed
  reads(page, {});
  const run = nearSellKind(page)({ token: TOKEN, slippageBps: 100 }, { id: "s-tap" } as never);
  assert.ok("running" in run);
  await run.after;
  assert.deepEqual(run.answer(), { result: { stage: "sent", txs: [{ chain: "near", hash: TX }] } });
  const m = (await recOf(v, "b1")).sell!;
  assert.deepEqual([m.id, m.stage, m.code], ["s0", "sent", "read_failed"]);
  assert.equal(((await v.w.get("ops", "s0")) as { stage: string }).stage, "sent");
});

test("sell: trade_used with nothing of the sell sent keeps it open (its stage, the code), in positions, and taken up again on load and on the next tap; after a swap went out it stays sent", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), stage: "filled", fill: { out: "1000000000000000000", decimals: 18 } });
  const d = sellDepsOf(page, null, "s1", 100);
  await d.wallet(TOKEN);
  d.log("swap", "trade_used");
  assert.deepEqual(await d.end({ error: "trade_used" }), { error: "trade_used" }, "the tap is answered with the code");
  d.release();
  const m = (await recOf(v, "b1")).sell!;
  assert.deepEqual([m.stage, m.code], ["pending", "trade_used"]);
  assert.equal((await nearPositions(page)).length, 1, "the token is still W's: the row stays");
  // the next tap continues the same sell (same op, resumes + 1)
  const e = sellDepsOf(page, null, "s2", 100);
  assert.ok(await e.wallet(TOKEN));
  assert.deepEqual([(await recOf(v, "b1")).sell!.id, (await recOf(v, "b1")).sell!.resumes], ["s1", 1]);
  // a swap already sent: trade_used after it never reopens nor refuses
  await e.end({ result: { stage: "sent", txs: [{ chain: "near", hash: TX }] } });
  await e.end({ error: "trade_used" });
  assert.equal((await recOf(v, "b1")).sell!.stage, "sent");
  e.release();
});

test("state.positions on NEAR: each token's filled buys with their fill and no sell (or one refused), summed by token, the USDC paid as cost; nothing else", async () => {
  const v = await world([5_000_000n, 6_000_000n, 7_000_000n, 8_000_000n]);
  const { page } = pageOf(v);
  const ws: string[] = [];
  for (const id of ["a", "b", "c", "d"]) ws.push((await paid(page, v, id)).w.id);
  const put = async (id: string, f: (r: NonNullable<ReturnType<typeof nearBuyRecordOf>>) => object) => {
    const r = await recOf(v, id);
    await v.w.put("quotes", `${NEAR_BUY_KEY}${id}`, f(r));
  };
  await put("a", (r) => ({ ...r, fill: { out: "1500000000000000000", decimals: 18 } }));
  await put("b", (r) => ({ ...r, fill: { out: "500000000000000000", decimals: 18 }, sell: { id: "s", slippage_bps: 1, created_ms: 1, resumes: 0, stage: "refused", step: "quote", txs: [] } }));
  await put("c", (r) => ({ ...r, fill: { out: "9", decimals: 18 }, sell: { id: "s2", slippage_bps: 1, created_ms: 1, resumes: 0, stage: "sent", step: "move", txs: [] } }));
  // d: filled with no fill read: not shown
  assert.deepEqual(await nearPositions(page), [{ chain: "near", token: TOKEN, amount: "2", cost: "6", wallets: [ws[0], ws[1]], decimals: 18 }]);
});

test("F4 a W that holds the token is a position whatever code its buy ended with (below the floor, a read failed), from the record's last read: what W holds; no fill read or a buy refused: none", async () => {
  const v = await world([5_000_000n, 6_000_000n, 7_000_000n, 8_000_000n]);
  const { page } = pageOf(v);
  const ws: string[] = [];
  for (const id of ["a", "b", "c", "d"]) ws.push((await paid(page, v, id)).w.id);
  const put = async (id: string, f: (r: NonNullable<ReturnType<typeof nearBuyRecordOf>>) => object) => {
    const r = await recOf(v, id);
    await v.w.put("quotes", `${NEAR_BUY_KEY}${id}`, f(r));
  };
  // a: the swap landed below the floor; its last read on the record (1.5 received over a baseline of 0.25)
  await put("a", (r) => ({ ...r, stage: "sent", code: "received_below_floor", swap: { floor: "2000000000000000000", before: "250000000000000000" }, fill: { out: "1500000000000000000", decimals: 18 } }));
  // b: ended on a read that failed after one that saw the token
  await put("b", (r) => ({ ...r, stage: "sent", code: "read_failed", swap: { floor: "1", before: "0" }, fill: { out: "250000000000000000", decimals: 18 } }));
  // c: sent with no read of the token on its record: not shown (no chain read here)
  await put("c", (r) => ({ ...r, stage: "sent", code: "carry_failed", swap: { floor: "1", before: "0" } }));
  // d: refused (the payout never landed): not shown whatever the record holds
  await put("d", (r) => ({ ...r, stage: "refused", code: "payout_failed", fill: { out: "9", decimals: 18 } }));
  assert.deepEqual(await nearPositions(page), [{ chain: "near", token: TOKEN, amount: "2", cost: "6", wallets: [ws[0], ws[1]], decimals: 18 }]);
});

test("readNearDecimals: ft_metadata on both providers, which must agree, a u8; kept once read", async () => {
  const answer = (d: unknown) => ({ result: { result: [...new TextEncoder().encode(JSON.stringify({ spec: "ft-1.0.0", decimals: d }))] } });
  let asked = 0;
  const rpc = (d: unknown) => ({ name: "r", query: async () => (asked++, answer(d)) });
  assert.equal(await readNearDecimals("mainnet", [rpc(24), rpc(24)] as never, "wrap.near"), 24);
  const n = asked;
  assert.equal(await readNearDecimals("mainnet", [rpc(1), rpc(1)] as never, "wrap.near"), 24, "kept");
  assert.equal(asked, n);
  await assert.rejects(readNearDecimals("mainnet", [rpc(6), rpc(8)] as never, "x.near"), /disagree/);
  for (const d of [256, -1, 1.5, "6", null]) await assert.rejects(readNearDecimals("mainnet", [rpc(d), rpc(d)] as never, `t${String(d)}.near`), /no decimals/);
});

test("the buy kind hands the app's route to the flow (W first)", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  reads(page, {});
  const told: unknown[] = [];
  const run = (await import("../src/near-buy.ts")).nearBuyKind(page)(ASK, { id: "r1", sha: "0", progress: () => {}, route: (r: unknown) => void told.push(r) } as never);
  assert.ok("running" in run);
  await run.after;
  assert.deepEqual(told[0], { wallet: (await recOf(v, "r1")).w });
});

test("D5: a sell of W1 that ended refused amount_too_low (dust) does not hold up W2: the next sell of the token takes W2, and W1 only once no other W holds anything", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page } = pageOf(v);
  const w1 = (await paid(page, v, "b1")).w;
  const w2 = (await paid(page, v, "b2")).w;
  assert.notDeepEqual(w1, w2);
  const held = new Map<string, { token: bigint; usdc: bigint }>([
    [w1.id, { token: 5n, usdc: 0n }],
    [w2.id, { token: 7_000n, usdc: 0n }],
  ]);
  page.readWallet = async (a) => ({ account: a.wallet, height: 1, blockHash: "b", nonce: 1n, held: a.side === "sell" ? held.get(a.wallet)!.token : held.get(a.wallet)!.usdc, registered: true, storageMin: 0n, lostfound: 0n });
  const s1 = sellDepsOf(page, null, "s1", 100);
  assert.deepEqual(await s1.wallet(TOKEN), { ...w1, token: TOKEN, coinMin: 1n });
  await s1.end({ error: "amount_too_low" });
  s1.release();
  const s2 = sellDepsOf(page, null, "s2", 100);
  assert.deepEqual(await s2.wallet(TOKEN), { ...w2, token: TOKEN, coinMin: 1n }, "W2, not the dust W1 again");
  await s2.end({ result: { stage: "filled", txs: [{ chain: "near", hash: TX }] } });
  s2.release();
  assert.equal((await recOf(v, "b2")).sell!.stage, "filled");
  // with W2 sold, the dust W1 is the one left: asked again (its price may have moved)
  const s3 = sellDepsOf(page, null, "s3", 100);
  assert.deepEqual(await s3.wallet(TOKEN), { ...w1, token: TOKEN, coinMin: 1n });
  s3.release();
});

test("D5: a paid W that holds no token and under the least deposit in USDC is passed over for the next W; a W whose read fails is taken (its run reads it again)", async () => {
  const v = await world([5_000_000n, 10_000_000n]);
  const { page } = pageOf(v);
  const w1 = (await paid(page, v, "b1")).w;
  const w2 = (await paid(page, v, "b2")).w;
  const held = new Map<string, { token: bigint; usdc: bigint } | null>([
    [w1.id, { token: 0n, usdc: 999_999n }],
    [w2.id, { token: 7_000n, usdc: 0n }],
  ]);
  page.readWallet = async (a) => {
    const h = held.get(a.wallet);
    if (h === null) throw new Error("rpc down");
    return { account: a.wallet, height: 1, blockHash: "b", nonce: 1n, held: a.side === "sell" ? h!.token : h!.usdc, registered: true, storageMin: 0n, lostfound: 0n };
  };
  const s1 = sellDepsOf(page, null, "s1", 100);
  assert.deepEqual(await s1.wallet(TOKEN), { ...w2, token: TOKEN, coinMin: 1n });
  s1.release();
  assert.equal((await recOf(v, "b1")).sell, undefined, "the empty W1 is not taken");
  held.set(w1.id, null);
  const s2 = sellDepsOf(page, null, "s2", 100);
  // W2's sell is open (recorded by s1): it goes first; with it ended, the unread W1 is taken
  assert.deepEqual(await s2.wallet(TOKEN), { ...w2, token: TOKEN, coinMin: 1n });
  await s2.end({ result: { stage: "filled", txs: [] } });
  s2.release();
  const s3 = sellDepsOf(page, null, "s3", 100);
  assert.deepEqual(await s3.wallet(TOKEN), { ...w1, token: TOKEN, coinMin: 1n });
  s3.release();
});

test("a tap's W pick passes over a W holding only a stranger's dust (under its record's floor): the W with the coin is sold", async () => {
  const v = await world([5_000_000n, 5_000_000n]);
  const { page } = pageOf(v);
  const w1 = (await paid(page, v, "b1")).w;
  const w2 = (await paid(page, v, "b2")).w;
  // both buys' floors at 1000: W1 holds 1 unit a stranger sent and under the least deposit, W2 its coin
  for (const id of ["b1", "b2"]) await v.w.put("quotes", `${NEAR_BUY_KEY}${id}`, { ...(await recOf(v, id)), swap: { floor: "1000", before: "0" } });
  const held = new Map([
    [w1.id, { token: 1n, usdc: 999_999n }],
    [w2.id, { token: 7_000n, usdc: 0n }],
  ]);
  page.readWallet = async (a) => {
    const h = held.get(a.wallet)!;
    return { account: a.wallet, height: 1, blockHash: "b", nonce: 1n, held: a.side === "sell" ? h.token : h.usdc, registered: true, storageMin: 0n, lostfound: 0n };
  };
  const s1 = sellDepsOf(page, null, "s1", 100);
  const got = await s1.wallet(TOKEN);
  s1.release();
  assert.equal(got?.id, w2.id, "W2, the W with the coin");
  assert.equal((await recOf(v, "b1")).sell, undefined, "the dust W1 is not taken");
});

test("D5b: a sell that ends part_filled (the token sold, under the least deposit left in W) is recorded part_filled, a sale done: never refused, never taken again", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  const d = sellDepsOf(page, null, "s1", 100);
  await d.wallet(TOKEN);
  await d.end({ result: { stage: "part_filled", txs: [{ chain: "near", hash: TX }] } });
  d.release();
  assert.equal((await recOf(v, "b1")).sell!.stage, "part_filled");
  const again = sellDepsOf(page, null, "s2", 100);
  assert.equal(await again.wallet(TOKEN), null);
  again.release();
});

test("D3: the sell's record keeps the last trade delegate signed (before it is sent) and answers it to the next run, a new sell on that W included; a kept trade that is not one throws", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  const w1 = (await paid(page, v, "b1")).w;
  const s1 = sellDepsOf(page, null, "s1", 100);
  await s1.wallet(TOKEN);
  assert.equal(await s1.lastTrade(), null);
  await s1.traded({ nonce: 52n, mbh: 1_120n });
  assert.deepEqual((await recOf(v, "b1")).sell!.trade, { nonce: "52", mbh: "1120" });
  await s1.end({ error: "not_known" }); // ended refused, nothing known sold
  s1.release();
  const s2 = sellDepsOf(page, null, "s2", 100);
  assert.deepEqual(await s2.wallet(TOKEN), { ...w1, token: TOKEN, coinMin: 1n });
  assert.deepEqual(await s2.lastTrade(), { nonce: 52n, mbh: 1_120n }, "a new sell on the W keeps it");
  s2.release();
  const store = await page.store();
  const r = await recOf(v, "b1");
  await store.put("quotes", `${NEAR_BUY_KEY}b1`, { ...r, sell: { ...r.sell!, stage: "sent", trade: { nonce: "-1", mbh: "x" } } });
  const s3 = sellDepsOf(page, null, "s3", 100);
  await s3.wallet(TOKEN);
  assert.throws(() => s3.lastTrade(), /not one/);
  s3.release();
});

test("F3: a sell kept open by trade_used with nothing sent is taken up at most NEAR_SELL_RESUMES times; then it ends with its code (the token still in positions), a load leaves it, and the next tap starts a fresh sell", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), stage: "filled", fill: { out: "1000000000000000000", decimals: 18 } });
  const d = sellDepsOf(page, null, "s1", 100);
  await d.wallet(TOKEN);
  await d.end({ error: "trade_used" });
  d.release();
  for (let i = 1; i <= NEAR_SELL_RESUMES; i++) {
    const e = sellDepsOf(page, null, `t${i}`, 100);
    assert.ok(await e.wallet(TOKEN));
    assert.deepEqual([(await recOf(v, "b1")).sell!.id, (await recOf(v, "b1")).sell!.resumes], ["s1", i]);
    await e.end({ error: "trade_used" });
    e.release();
  }
  // a load past the cap: the sell ends with its code, nothing is run
  const reads = page.readWallet;
  let asked = 0;
  page.readWallet = async (a) => (asked++, reads ? reads(a) : Promise.reject(new Error("no reads")));
  await resumeNearSells(page);
  const m = (await recOf(v, "b1")).sell!;
  assert.deepEqual([m.id, m.stage, m.code], ["s1", "refused", "trade_used"]);
  assert.equal((await nearPositions(page)).length, 1, "the token is still W's: the row stays");
  // the next tap: a fresh sell of that W
  const f = sellDepsOf(page, null, "fresh", 100);
  assert.ok(await f.wallet(TOKEN));
  const n = (await recOf(v, "b1")).sell!;
  assert.deepEqual([n.id, n.resumes, n.stage], ["fresh", 0, "pending"]);
  f.release();
});

test("F3: a sell kept open by trade_used counts as nothing sent only with no tx of it: one with a tx is not listed as held", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  const mark = { id: "s", slippage_bps: 1, created_ms: 1, resumes: 0, stage: "pending", step: "swap", code: "trade_used" };
  await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), stage: "filled", fill: { out: "1000000000000000000", decimals: 18 }, sell: { ...mark, txs: [] } });
  assert.equal((await nearPositions(page)).length, 1);
  await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), sell: { ...mark, txs: [{ chain: "near", hash: TX }] } });
  assert.deepEqual(await nearPositions(page), []);
});

test("a buy that ended sent with a fill (its swap's token on W): a tap sells it as a filled one's; a load never sends that W home", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  const w1 = (await paid(page, v, "b1")).w;
  await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), stage: "sent", code: "carry_failed", fill: { out: "1000000000000000000", decimals: 18 } });
  // a load: W read with no token and USDC (a lagging read): left alone, no sell recorded
  let asked = 0;
  page.readWallet = async (a) => (asked++, { account: a.wallet, height: 1, blockHash: "b", nonce: 1n, held: a.side === "sell" ? 0n : 2_000_000n, registered: true, storageMin: 0n, lostfound: 0n });
  await resumeNearSells(page);
  assert.equal((await recOf(v, "b1")).sell, undefined);
  assert.equal(asked, 0, "not even read");
  // a tap: W is the sell's, as a filled buy's
  page.readWallet = async (a) => ({ account: a.wallet, height: 1, blockHash: "b", nonce: 1n, held: a.side === "sell" ? 7_000n : 0n, registered: true, storageMin: 0n, lostfound: 0n });
  const d = sellDepsOf(page, null, "s1", 100);
  assert.deepEqual(await d.wallet(TOKEN), { ...w1, token: TOKEN, coinMin: 1n });
  d.release();
  assert.equal((await recOf(v, "b1")).sell!.id, "s1");
});

test("a load never reads, creates or sends home a W whose buy has a fill (a position), whatever its stage", async () => {
  const v = await world([5_000_000n]);
  const { page } = pageOf(v);
  await paid(page, v, "b1");
  await v.w.put("quotes", `${NEAR_BUY_KEY}b1`, { ...(await recOf(v, "b1")), stage: "sent", resumes: NEAR_BUY_RESUMES, fill: { out: "5", decimals: 0 } });
  let asked = 0;
  page.readWallet = async () => {
    asked++;
    throw new Error("rpc: W's keys: no account");
  };
  page.fetchFn = (async () => (asked++, new Response(JSON.stringify({ tx_hashes: [] }), { status: 200 }))) as typeof fetch;
  await resumeNearSells(page);
  assert.equal(asked, 0);
  assert.equal((await recOf(v, "b1")).sell, undefined);
});
