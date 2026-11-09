// The withdrawal through the relayer (card wallet-withdraw-relay; docs/plan1/wallet.md W2.4 l.1115, §2.3 "own"
// l.227-230, the arming row l.915; markets.md /v1/withdraw/fee and /v1/withdraw l.3346-3347, LD5 l.1052-1075, H3.6
// l.1509-1524).
//   node --test test/withdraw-relay.test.ts      (from packages/wallet)
// - The fee and the send answers are hostile: the recorded answers (test/vectors/withdraw-relay.json, in the kit's
//   frozen shapes) pass, and every bad one is refused.
// - Confirm first: the change note is written only once the vault's pages on both RPCs hold the spend and this seed's
//   change leaf, never on the relayer's answer or one RPC; the note goes back to UNSPENT only past its deadline_ms in
//   block time with nothing in the pages.
// - The same bytes go again while check 9 takes them; withdraw_failed names self-submit.
// The pages are two fake RPCs serving a model vault's views as near RPC answers; IndexedDB is fake-indexeddb. Test
// values only, never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { type HelperWithdrawAnswer, type HelperWithdrawFeeAnswer } from "@blindfill/kit";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { askWithdrawFee, type RelayDeps, type RelayRpc, relayWithdraw, WITHDRAW_FEE_URL, WITHDRAW_URL, withdrawAnswerOf, WithdrawRelayRefused } from "../src/withdraw/relay.ts";
import { type WithdrawRequest, WITHDRAW_SEND_MARGIN_MS, withdrawRequest } from "../src/withdraw/request.ts";
import { BUSY_ASKS, BUSY_WAIT_FIRST_MS, BUSY_WAIT_MAX_MS } from "../src/busy.ts";
import { argsFor, BLOCK_MS, closeVaults, FEE_MAX, type FeeEdit, feeReplay, RELAY_FEE, SEED, signalsProver, TOKEN, type Vault, vaultWith } from "./withdraw-fixture.ts";

after(closeVaults);

type Answer = { status: number; body: unknown };
const A = JSON.parse(readFileSync(new URL("vectors/withdraw-relay.json", import.meta.url), "utf8")) as {
  relayer: { relayer_account: string; fee_recipient: string };
  fee: { good: Answer; bad: Record<string, Answer>; busy: Answer };
  withdraw: { submitted: Answer; codes: Record<string, Answer>; bad: Record<string, Answer> };
};
// the recorded good answers are the kit's frozen shapes
const GOOD_FEE: HelperWithdrawFeeAnswer = A.fee.good.body as HelperWithdrawFeeAnswer;
const SUBMITTED: HelperWithdrawAnswer = A.withdraw.submitted.body as HelperWithdrawAnswer;

// ---------- a fake helper ----------
type Sent = { url: string; init: RequestInit; timeMs: bigint };
function helper(answer: (n: number) => Answer, sent: Sent[] = [], clock: { timeMs: bigint } = { timeMs: 0n }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init!, timeMs: clock.timeMs });
    const a = answer(sent.length - 1);
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

// ---------- the fee ----------
const feeArgs = (fetchFn: typeof fetch, over: Partial<Parameters<typeof askWithdrawFee>[0]> = {}) => ({
  token: TOKEN,
  relayer: A.relayer,
  amount: 3_000_000n,
  fetchFn,
  ...over,
});

test("the fee: the recorded answer gives relay_fee and the release's fee recipient, asked by GET with no credentials", async () => {
  const sent: Sent[] = [];
  const fee = await askWithdrawFee(feeArgs(helper(() => A.fee.good, sent)));
  assert.deepEqual(fee, { relayFee: BigInt(GOOD_FEE.relay_fee), feeRecipient: A.relayer.fee_recipient, validUntilBlock: GOOD_FEE.valid_until_block });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, `${WITHDRAW_FEE_URL}?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(sent[0]!.init.method, "GET");
  assert.equal(sent[0]!.init.credentials, "omit");
  assert.equal(sent[0]!.init.redirect, "error");
  assert.equal(sent[0]!.init.body, undefined);
});

test("the fee: every recorded bad answer is refused, and the amount bounds a good one (fee_max is the device's own: withdraw-feemax.test.ts)", async () => {
  const OVER = "a fee one above the device fee_max";
  for (const [name, bad] of Object.entries(A.fee.bad)) {
    if (name !== OVER) await assert.rejects(askWithdrawFee(feeArgs(helper(() => bad))), WithdrawRelayRefused, name);
  }
  // a fee above the device's own fee_max reads as a fee; withdrawRequest, which binds it, refuses it (no proof, no send)
  const over = await askWithdrawFee(feeArgs(helper(() => A.fee.bad[OVER]!)));
  assert.equal(over.relayFee, FEE_MAX + 1n);
  const v = await vaultWith();
  await assert.rejects(withdrawRequest(argsFor(v, signalsProver(), { relayFee: over.relayFee })), /fee_max/);
  const busySent: Sent[] = [];
  await assert.rejects(askWithdrawFee(feeArgs(helper(() => A.fee.busy, busySent), { sleep: async () => {} })), (e: WithdrawRelayRefused) => e.code === "helper" && /upstream/.test(e.message));
  assert.equal(busySent.length, BUSY_ASKS); // a busy answer is asked again, BUSY_ASKS asks at most (the busy tests below)
  // the amount, exactly at the fee, is refused; one above it takes the fee
  assert.equal((await askWithdrawFee(feeArgs(helper(() => A.fee.good), { amount: RELAY_FEE + 1n }))).relayFee, RELAY_FEE);
  await assert.rejects(askWithdrawFee(feeArgs(helper(() => A.fee.good), { amount: RELAY_FEE })), (e: WithdrawRelayRefused) => e.code === "fee");
  // an answer over the size limit is refused unread
  const big = { status: 200, body: { ...GOOD_FEE, px: `1.${"0".repeat(1_100)}` } };
  await assert.rejects(askWithdrawFee(feeArgs(helper(() => big))), WithdrawRelayRefused);
});

// ---------- the fee: a busy helper (card withdraw-fee-busy-waits) ----------
// The mainnet run's fee ask met 429 rate_limited (helper log 9 Nov ~04:08Z) and the withdrawal stopped. A busy answer
// (429 rate_limited, 503 upstream) is waited out for its Retry-After, capped, and asked again, bounded; any other refuses
// at once.
const RATE_LIMITED = { error: { code: "rate_limited" } };
const UPSTREAM = { error: { code: "upstream" } };
type Timed = Answer & { retryAfter?: string };
function timedHelper(answers: readonly Timed[], sent: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    sent.push(String(url));
    const a = answers[Math.min(sent.length - 1, answers.length - 1)]!;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (a.retryAfter !== undefined) headers["retry-after"] = a.retryAfter;
    return new Response(JSON.stringify(a.body), { status: a.status, headers });
  }) as typeof fetch;
}
const waits = (into: number[]) => async (ms: number) => void into.push(ms);

test("the fee, busy: a 429 rate_limited with Retry-After 1, then a 200, gives the fee after a 1 s wait", async () => {
  const sent: string[] = [];
  const slept: number[] = [];
  const fee = await askWithdrawFee(feeArgs(timedHelper([{ status: 429, body: RATE_LIMITED, retryAfter: "1" }, A.fee.good], sent), { sleep: waits(slept) }));
  assert.equal(fee.relayFee, BigInt(GOOD_FEE.relay_fee));
  assert.deepEqual(slept, [1_000]);
  assert.equal(sent.length, 2);
  // a 503 upstream with no Retry-After waits BUSY_WAIT_FIRST_MS, then asks again
  const slept503: number[] = [];
  assert.equal((await askWithdrawFee(feeArgs(timedHelper([{ status: 503, body: UPSTREAM }, A.fee.good]), { sleep: waits(slept503) }))).relayFee, BigInt(GOOD_FEE.relay_fee));
  assert.deepEqual(slept503, [BUSY_WAIT_FIRST_MS]);
});

test("the fee, busy: a 429 that never clears ends, named rate_limited, after BUSY_ASKS asks within the bound", async () => {
  const sent: string[] = [];
  const slept: number[] = [];
  await assert.rejects(
    askWithdrawFee(feeArgs(timedHelper([{ status: 429, body: RATE_LIMITED, retryAfter: "75" }], sent), { sleep: waits(slept) })),
    (e: WithdrawRelayRefused) => e.code === "helper" && /rate_limited/.test(e.message),
  );
  assert.equal(sent.length, BUSY_ASKS);
  assert.equal(slept.length, BUSY_ASKS - 1);
  assert.ok(slept.reduce((x, y) => x + y, 0) <= (BUSY_ASKS - 1) * BUSY_WAIT_MAX_MS);
});

test("the fee, busy: a 400, a 404 and a 429 or 503 not the helper's busy answer refuse at once, never asked again", async () => {
  for (const a of [
    { status: 400, body: { error: { code: "bad_shape" } }, retryAfter: "1" },
    { status: 404, body: { error: { code: "not_found" } } },
    { status: 429, body: { error: { code: "in_flight" } }, retryAfter: "1" },
    { status: 503, body: { error: { code: "upstream" }, more: 1 }, retryAfter: "1" },
    { status: 503, body: RATE_LIMITED, retryAfter: "1" },
  ] as const) {
    const sent: string[] = [];
    const slept: number[] = [];
    await assert.rejects(askWithdrawFee(feeArgs(timedHelper([a, A.fee.good], sent), { sleep: waits(slept) })), WithdrawRelayRefused, `HTTP ${a.status}`);
    assert.equal(sent.length, 1, `HTTP ${a.status} ${JSON.stringify(a.body)}: one ask`);
    assert.deepEqual(slept, []);
  }
});

test("the fee, busy: a Retry-After over the cap waits only the cap", async () => {
  for (const retryAfter of ["3600", "99999999999999999999999", new Date(Date.now() + 3_600_000).toUTCString()]) {
    const slept: number[] = [];
    const fee = await askWithdrawFee(feeArgs(timedHelper([{ status: 429, body: RATE_LIMITED, retryAfter }, A.fee.good]), { sleep: waits(slept) }));
    assert.equal(fee.relayFee, BigInt(GOOD_FEE.relay_fee));
    assert.deepEqual(slept, [BUSY_WAIT_MAX_MS], retryAfter);
  }
});

test("the fee, busy: the caller's signal ends a wait at once", async () => {
  const stop = new AbortController();
  const sent: string[] = [];
  const t0 = Date.now();
  setTimeout(() => stop.abort(new Error("stopped")), 50);
  await assert.rejects(askWithdrawFee(feeArgs(timedHelper([{ status: 429, body: RATE_LIMITED, retryAfter: "10" }], sent), { signal: stop.signal })), /stopped/);
  assert.equal(sent.length, 1);
  assert.ok(Date.now() - t0 < 2_000);
});

// ---------- the send's answers ----------
test("the send: submitted and the frozen codes at their status are answers; anything else is not", async () => {
  const res = (a: Answer) => new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status });
  assert.deepEqual(await withdrawAnswerOf(res(A.withdraw.submitted)), { ok: true, txHash: SUBMITTED.tx_hash });
  for (const [code, a] of Object.entries(A.withdraw.codes)) assert.deepEqual(await withdrawAnswerOf(res(a)), { ok: false, code });
  for (const [name, bad] of Object.entries(A.withdraw.bad)) await assert.rejects(withdrawAnswerOf(res(bad)), WithdrawRelayRefused, name);
  // no sender but relayWithdraw: the send itself is not on the module's surface
  const mod = await import("../src/withdraw/relay.ts");
  assert.equal(Object.hasOwn(mod, "sendWithdraw"), false);
});

// ---------- a model vault's pages on two RPCs ----------
// The testnet release pair, named by URL as nearRpc names a provider (relayWithdraw refuses any other pair).
const NET = NEAR_NETWORKS.testnet;
const RPC_A = NET.fastnear[0];
const RPC_B = NET.drpc;
type Spend = { nh: bigint; withdrawn: bigint; newLeaf: number; context: bigint; h: number };
/** Blocks with their times; spends and leaves stamped with the block they landed in, served at any block. */
class Chain {
  height = 175_000_000;
  times = new Map<number, bigint>([[this.height, BigInt(BLOCK_MS)]]);
  leaves: { v: bigint; h: number }[] = Array.from({ length: 8 }, (_, k) => ({ v: BigInt(100 + k), h: 0 })); // the vault's leaves before this withdrawal
  spends: Spend[] = [{ nh: 41n, withdrawn: 1_000_000n, newLeaf: 7, context: 43n, h: 0 }]; // another user's spend
  status = "in_flight";
  hideLastFromB = false; // rpc-b leaves out the newest spend and leaf, at the same block
  bDown = false;
  lagB = 0; // rpc-b's final height this many blocks back
  timeLieB = 0n; // rpc-b adds this to every block's time
  hashLieB = false; // rpc-b names another hash for every block header
  get timeMs(): bigint {
    return this.times.get(this.height)!;
  }
  set timeMs(t: bigint) {
    this.times.set(this.height, t);
  }
  /** The next block, `step` ms later. */
  next(step: bigint): void {
    const t = this.timeMs;
    this.height += 1;
    this.timeMs = t + step;
  }
  land(nh: bigint, withdrawn: bigint, leaf: bigint, context: bigint): void {
    this.leaves.push({ v: leaf, h: this.height });
    this.spends.push({ nh, withdrawn, newLeaf: this.leaves.length - 1, context, h: this.height });
  }
  views(at: number, hideLast: boolean) {
    let leaves = this.leaves.filter((l) => l.h <= at);
    let spends = this.spends.filter((s) => s.h <= at);
    if (hideLast) (leaves = leaves.slice(0, -1)), (spends = spends.slice(0, -1));
    const tree = (n: number) => ({ size: n, depth: n <= 1 ? 0 : Math.ceil(Math.log2(n)), root: "7" });
    return {
      state_tree: tree(leaves.length),
      label_tree: tree(0),
      spends: spends.map((s, index) => ({
        index, nullifier_hash: String(s.nh), withdrawn: String(s.withdrawn), new_leaf_index: s.newLeaf, refund_precommitment: "5",
        refund_value: "0", refund_label: "0", refund_leaf_index: 0, status: this.status,
        payer: "relayer.confidential.unrlzd.near", reserve: "0", recipient: "a".repeat(64), fee: "30000", context: String(s.context),
      })),
      leaves: leaves.map((l) => String(l.v)),
    } as Record<string, unknown>;
  }
  rpcs(names: [string, string] = [RPC_A, RPC_B]): [RelayRpc, RelayRpc] {
    const one = (name: string, b: boolean): RelayRpc => ({
      name,
      query: async (p) => {
        if (b && this.bDown) throw new Error("down");
        const at = p.finality === "final" ? this.height - (b ? this.lagB : 0) : (p.block_id as number);
        const args = JSON.parse(atob(p.args_base64 as string)) as { from?: number; limit?: number };
        let view = this.views(at, b && this.hideLastFromB)[p.method_name as string];
        if (Array.isArray(view)) view = view.slice(Math.min(args.from!, view.length), Math.min(args.from! + args.limit!, view.length));
        return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${at}`, block_height: at, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] } };
      },
      block: async (p) => {
        if (b && this.bDown) throw new Error("down");
        const block_id = "block_id" in p ? p.block_id : this.height - (b ? this.lagB : 0);
        const t = this.times.get(block_id)! + (b ? this.timeLieB : 0n);
        const header = { height: block_id, hash: b && this.hashLieB ? `fork-${block_id}` : `hash-${block_id}`, timestamp: 0, timestamp_nanosec: (t * 1_000_000n).toString(), gas_price: "100000000" };
        return { jsonrpc: "2.0", id: "x", result: { header } };
      },
    });
    return [one(names[0], false), one(names[1], true)];
  }
}

/** Mainnet's recorded release pair (test/vectors/withdraw-feemax.json) as RelayRpc, for fee_max's price pool. */
const priceRpcs = (edit?: FeeEdit): [RelayRpc, RelayRpc] => feeReplay("mainnet", edit) as [RelayRpc, RelayRpc];

const sig = (r: WithdrawRequest, k: number): bigint => BigInt(r.body.public_signals[k]);
/** This attempt's own spend, as the vault writes it: its nullifier hash, withdrawn value, change leaf and context. */
const landOwn = (c: Chain, r: WithdrawRequest) => c.land(sig(r, 1), sig(r, 2), sig(r, 0), sig(r, 7));

async function reserved(): Promise<{ v: Vault; req: WithdrawRequest }> {
  const v = await vaultWith();
  return { v, req: await withdrawRequest(argsFor(v, signalsProver())) };
}

/** Each round's wait moves the chain one block and `step` seconds, then runs the test's script for that round. */
function depsOf(v: Vault, c: Chain, fetchFn: typeof fetch, script: (round: number) => Promise<void> | void = () => {}, step = 1_000n, over: Partial<RelayDeps> = {}): RelayDeps {
  let round = 0;
  return {
    notes: v.ns,
    network: "testnet",
    rpcs: c.rpcs(),
    priceRpcs: priceRpcs(),
    fetchFn,
    pollMs: 1_000,
    resendMs: 5_000,
    sleep: async () => {
      round += 1;
      if (round > 5_000) throw new Error("the test ran away");
      c.next(step);
      await script(round);
    },
    ...over,
  };
}
const changeOf = async (v: Vault) => (await v.ns.list()).find((n) => n.ref.kind === "change");

// ---------- confirm first ----------
test("confirm first: the relayer's submitted answer and one RPC's pages record nothing; both RPCs' pages record the change", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const sent: Sent[] = [];
  const checks: string[] = [];
  const nothingYet = async (when: string) => {
    assert.equal(await changeOf(v), undefined, `${when}: no change note yet`);
    assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED", `${when}: the note stays RESERVED`);
    checks.push(when);
  };
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted, sent), async (round) => {
    if (round <= 3) await nothingYet(`round ${round}, the relayer said submitted`);
    if (round === 3) (landOwn(c, req), (c.hideLastFromB = true)); // on chain, but rpc-b does not show it yet
    if (round === 4 || round === 5) await nothingYet(`round ${round}, only rpc-a shows the spend`);
    if (round === 5) c.hideLastFromB = false;
  }));
  assert.deepEqual(checks.length, 5);
  assert.equal(out.kind, "landed");
  if (out.kind !== "landed") return;
  assert.equal(out.own, true);
  const change = await changeOf(v);
  assert.deepEqual(change, out.change);
  const leaf = (await v.ns.get(req.noteId))!.leaf!;
  assert.deepEqual(change!.leaf, { value: leaf.value - sig(req, 2), label: leaf.label, commitment: sig(req, 0), leafIndex: 8n });
  assert.equal(change!.state, "UNSPENT");
  assert.equal(change!.parent, req.noteId);
  assert.deepEqual(change!.ref, req.change);
  assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
  // one send: the body's bytes exactly, to the release's relayer
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, WITHDRAW_URL);
  assert.equal(sent[0]!.init.method, "POST");
  assert.equal(sent[0]!.init.body, JSON.stringify(req.body));
});

test("nothing landed: a lying RPC and a relayer that says submitted never record a change; past deadline_ms the note is UNSPENT", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const sent: Sent[] = [];
  const deadline = BigInt(req.body.withdrawal.deadline_ms);
  let heldPast = 0;
  let lieFrom = 0n;
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted, sent, c), async (round) => {
    // while the RPCs disagree nothing is concluded, past the deadline too: the note stays RESERVED
    assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED");
    assert.equal(await changeOf(v), undefined);
    // from round 20, rpc-a lies: it shows this attempt's spend and change leaf; rpc-b, the honest one, never does
    if (round === 20) (landOwn(c, req), (c.hideLastFromB = true), (lieFrom = c.timeMs));
    if (c.timeMs > deadline && ++heldPast === 3) (c.spends.pop(), c.leaves.pop(), (c.hideLastFromB = false)); // the lie ends
  }, 10_000n));
  assert.equal(heldPast, 3);
  assert.equal(out.kind, "expired");
  if (out.kind !== "expired") return;
  assert.equal(out.route, "relayer");
  assert.equal(out.note.state, "UNSPENT");
  assert.equal(await changeOf(v), undefined);
  assert.ok(c.timeMs > deadline);
  // the same bytes each time, every 5 rounds after submitted, never while the RPCs disagree, never past check 9's margin
  assert.ok(sent.length >= 2);
  for (const s of sent) assert.equal(s.init.body, JSON.stringify(req.body));
  for (const s of sent) assert.ok(s.timeMs < lieFrom && s.timeMs + BigInt(WITHDRAW_SEND_MARGIN_MS) < deadline);
});

test("past deadline_ms, the note is freed only once both RPCs' pages are read at or above that block", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  c.timeMs = BigInt(req.body.withdrawal.deadline_ms) + 1n; // already past
  c.bDown = true;
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted), async (round) => {
    assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED", "no pages read: nothing is concluded");
    if (round === 3) c.bDown = false;
  }));
  assert.equal(out.kind, "expired");
});

test("another device's spend of the note: its change (this seed's note j of label l) is recorded, own false", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const note = (await v.ns.get(req.noteId))!;
  const withdrawn = 1_120_000n;
  const value = note.leaf!.value - withdrawn;
  const commitment = noteCommitment(value, note.leaf!.label, noteSecrets(SEED, req.change).precommitment);
  c.land(sig(req, 1), withdrawn, commitment, 987_654_321n); // another attempt's context
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.codes.fee_too_low!)));
  assert.equal(out.kind, "landed");
  if (out.kind !== "landed") return;
  assert.equal(out.own, false);
  assert.deepEqual(out.change.leaf, { value, label: note.leaf!.label, commitment, leafIndex: 8n });
  assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
});

test("a spend of the note whose change leaf is not this seed's records nothing and frees nothing", async () => {
  for (const wrong of ["another leaf", "withdrawn above the note"] as const) {
    const { v, req } = await reserved();
    const c = new Chain();
    if (wrong === "another leaf") c.land(sig(req, 1), sig(req, 2), sig(req, 0) + 1n, sig(req, 7));
    else c.land(sig(req, 1), 10n ** 12n, sig(req, 0), sig(req, 7));
    const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted)));
    assert.equal(out.kind, "unmatched", wrong);
    assert.equal(await changeOf(v), undefined, wrong);
    assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED", wrong);
  }
});

// ---------- the sends ----------
test("busy answers send the same bytes next round; in_flight waits; withdraw_failed stops and names self-submit", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const sent: Sent[] = [];
  const script = ["rate_limited", "index_behind", "in_flight", "withdraw_failed"];
  const answer = (n: number): Answer => A.withdraw.codes[script[Math.min(n, script.length - 1)]!]!;
  const rounds: number[] = [];
  let round = 0;
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper((n) => (rounds.push(round), answer(n)), sent), (r) => void (round = r), 10_000n, { resendMs: 30_000 }));
  assert.equal(out.kind, "expired");
  if (out.kind !== "expired") return;
  assert.equal(out.route, "self_submit");
  assert.equal(out.lastAnswer, "withdraw_failed");
  assert.equal(sent.length, 4, "nothing more after withdraw_failed");
  assert.deepEqual(rounds, [0, 1, 2, 32], "rate_limited and index_behind: next round; in_flight: 30 rounds of 1 s later");
  for (const s of sent) assert.equal(s.init.body, JSON.stringify(req.body));
});

test("a check's refusal ends the sends; a request whose note is not RESERVED by this attempt is never sent", async () => {
  {
    const { v, req } = await reserved();
    const sent: Sent[] = [];
    const out = await relayWithdraw(SEED, req, depsOf(v, new Chain(), helper(() => A.withdraw.codes.fee_too_low!, sent), undefined, 30_000n));
    assert.equal(out.kind, "expired");
    assert.equal(sent.length, 1);
  }
  const { v, req } = await reserved();
  const sent: Sent[] = [];
  const deps = depsOf(v, new Chain(), helper(() => A.withdraw.submitted, sent));
  const ctx = req.body.public_signals[7];
  const other = { ...req, body: { ...req.body, public_signals: req.body.public_signals.map((s, k) => (k === 7 ? String(BigInt(ctx) + 1n) : s)) as typeof req.body.public_signals } };
  await assert.rejects(relayWithdraw(SEED, other, deps), (e: WithdrawRelayRefused) => e.code === "note");
  const late = { ...req, body: { ...req.body, withdrawal: { ...req.body.withdrawal, deadline_ms: req.body.withdrawal.deadline_ms + 1 } } };
  await assert.rejects(relayWithdraw(SEED, late, deps), (e: WithdrawRelayRefused) => e.code === "note");
  const unspent = v.notes.find((n) => n.id !== req.noteId)!;
  await assert.rejects(relayWithdraw(SEED, { ...req, noteId: unspent.id }, deps), (e: WithdrawRelayRefused) => e.code === "note");
  assert.equal(sent.length, 0);
});

test("a stop by the caller ends the wait with nothing written; a later call finds the spend in the pages", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const stop = new AbortController();
  await assert.rejects(
    relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted), (round) => void (round === 2 && stop.abort()), 1_000n, { signal: stop.signal })),
    (e: Error) => e.name === "AbortError",
  );
  assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED");
  assert.equal(await changeOf(v), undefined);
  landOwn(c, req);
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.codes.in_flight!)));
  assert.equal(out.kind, "landed");
});

test("a body whose relay_fee is above the device's own fee_max is never sent; the deadline frees the note", async () => {
  for (const [fee, sends] of [[FEE_MAX, true], [FEE_MAX + 1n, false]] as const) {
    const { v, req } = await reserved();
    const over = { ...req, body: { ...req.body, withdrawal: { ...req.body.withdrawal, relay_fee: String(fee) } } };
    const sent: Sent[] = [];
    const out = await relayWithdraw(SEED, over, depsOf(v, new Chain(), helper(() => A.withdraw.codes.fee_too_low!, sent), undefined, 30_000n));
    assert.equal(out.kind, "expired");
    assert.equal(sent.length > 0, sends, `relay_fee ${fee}`);
    if (!sends) assert.equal(out.kind === "expired" && out.lastAnswer, "fee_max");
  }
  // price reads that disagree (dRPC's gas price at the pool's block) send nothing until they agree
  {
    const { v, req } = await reserved();
    const c = new Chain();
    const sent: Sent[] = [];
    let lie = true;
    let firstAt = -1;
    const price = priceRpcs((r, s, j) => (lie && r === "at" && s === "b" ? { ...j, result: { header: { ...(j.result as { header: object }).header, gas_price: "1" } } } : j));
    const script = (round: number) => {
      if (sent.length > 0 && firstAt < 0) firstAt = round;
      if (round === 4) lie = false;
      if (round === 8) landOwn(c, req);
    };
    const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted, sent), script, 1_000n, { priceRpcs: price }));
    assert.equal(out.kind, "landed");
    assert.equal(firstAt, 5, "the first send is in the round after the reads agree");
  }
  // the price pair must be mainnet's release pair
  const { v, req } = await reserved();
  await assert.rejects(relayWithdraw(SEED, req, depsOf(v, new Chain(), helper(() => A.withdraw.submitted), undefined, 1_000n, { priceRpcs: new Chain().rpcs() })), (e: WithdrawRelayRefused) => e.code === "input" && /priceRpcs/.test(e.message));
});

// ---------- the review's cases (one operator, a cursor, the block's time, the change another tab wrote) ----------
test("two hosts of one operator are one read: a pair that is not the network's release pair is refused before any read or send", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const sent: Sent[] = [];
  let reads = 0;
  const counted = (pair: [RelayRpc, RelayRpc]): [RelayRpc, RelayRpc] =>
    pair.map((r) => ({ name: r.name, query: (p: Record<string, unknown>) => (reads++, r.query(p)), block: (p: { block_id: number }) => (reads++, r.block(p)) })) as [RelayRpc, RelayRpc];
  const pairs: [string, string][] = [
    [NET.fastnear[0], NET.fastnear[1]], // FastNEAR's two hosts: one operator
    [RPC_B, RPC_B],
    ["rpc-a", "rpc-b"],
    [NEAR_NETWORKS.mainnet.fastnear[0], NEAR_NETWORKS.mainnet.drpc], // another network's pair
  ];
  for (const names of pairs) {
    const deps = depsOf(v, c, helper(() => A.withdraw.submitted, sent), undefined, 1_000n, { rpcs: counted(c.rpcs(names)) });
    await assert.rejects(relayWithdraw(SEED, req, deps), (e: WithdrawRelayRefused) => e.code === "input" && /exactly/.test(e.message), names.join(" + "));
  }
  // a provider with no block read is refused too
  const noBlock = c.rpcs().map((r) => ({ name: r.name, query: r.query })) as unknown as [RelayRpc, RelayRpc];
  await assert.rejects(relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted, sent), undefined, 1_000n, { rpcs: noBlock })), WithdrawRelayRefused);
  assert.equal(reads, 0);
  assert.equal(sent.length, 0);
  assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED");
});

test("D1: a spend that landed and settled before the call is found (the spends are read from the first row)", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  c.status = "settled";
  landOwn(c, req);
  for (let k = 0; k < 3; k++) c.land(BigInt(500 + k), 1_000_000n, BigInt(600 + k), BigInt(700 + k)); // later spends, settled too
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.codes.in_flight!), undefined, 30_000n));
  assert.equal(out.kind, "landed");
  assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
});

test("D2: the time is the pages' own block's, on both RPCs: a lagging RPC that claims a later time frees nothing, and the spend is recorded", async () => {
  for (const lie of [0n, 200_000n]) {
    const { v, req } = await reserved();
    const c = new Chain();
    c.lagB = 100; // rpc-b's final height 100 blocks back: the pages are read there
    c.timeLieB = lie; // and, in the second run, it says each block is 200 s later than it is
    const D = BigInt(req.body.withdrawal.deadline_ms);
    let landedAt = 0n;
    const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.codes.in_flight!), async () => {
      assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED", `lie ${lie}: never freed while the spend can still show`);
      if (landedAt === 0n && c.timeMs >= D - 5_000n) (landOwn(c, req), (landedAt = c.timeMs));
    }));
    assert.ok(landedAt > 0n && landedAt <= D, "the spend landed at or before deadline_ms: the vault took it");
    assert.equal(out.kind, "landed", `lie ${lie}`);
    assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
  }
});

test("a change of the note another tab wrote first is taken only when it holds this very leaf", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const note = (await v.ns.get(req.noteId))!;
  const P = noteSecrets(SEED, req.change).precommitment;
  const label = note.leaf!.label;
  const other = 1n; // another value, so another leaf, at another index
  await assert.rejects(
    relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.codes.in_flight!), async (round) => {
      if (round === 1) await v.ns.add({ ref: req.change, scope: note.scope, precommitment: P, state: "UNSPENT", parent: note.id, leaf: { value: other, label, commitment: noteCommitment(other, label, P), leafIndex: 99n } });
      if (round === 2) landOwn(c, req);
    })),
    /already in the store/,
  );
  assert.equal((await changeOf(v))!.leaf!.leafIndex, 99n, "the store keeps what it holds; nothing is taken as this spend's change");
});

test("the pages' block must be the same block on both RPCs: a header with another hash concludes nothing", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  c.timeMs = BigInt(req.body.withdrawal.deadline_ms) + 1n; // already past
  c.hashLieB = true;
  let rounds = 0;
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted), async (round) => {
    assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED", "two blocks under one height: nothing is concluded");
    if ((rounds = round) === 3) c.hashLieB = false;
  }));
  assert.equal(out.kind, "expired");
  assert.equal(rounds, 3, "freed only once both RPCs name the pages' block");
});

test("busy without end: the same bytes every round up to check 9's margin, never past it", async () => {
  const { v, req } = await reserved();
  const c = new Chain();
  const sent: Sent[] = [];
  const deadline = BigInt(req.body.withdrawal.deadline_ms);
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.codes.rate_limited!, sent, c), undefined, 10_000n));
  assert.equal(out.kind, "expired");
  const margin = BigInt(WITHDRAW_SEND_MARGIN_MS);
  for (const s of sent) assert.ok(s.timeMs + margin < deadline, "never inside the margin");
  assert.ok(sent.at(-1)!.timeMs + margin >= deadline - 10_000n, "sent up to the last round before the margin");
  assert.equal(new Set(sent.map((s) => s.init.body)).size, 1);
});

test("a note HELD by this very attempt (its context and deadline written, the proof not yet RESERVED) is never sent", async () => {
  const { v, req } = await reserved();
  const other = v.notes.find((n) => n.id !== req.noteId && n.state === "UNSPENT")!;
  const held = await v.ns.move(other.id, "UNSPENT", "HELD", { deadlineMs: BigInt(req.body.withdrawal.deadline_ms), context: req.body.public_signals[7] });
  const sent: Sent[] = [];
  const asHeld = { ...req, noteId: held.id, change: { ...req.change, l: held.leaf!.label } };
  await assert.rejects(relayWithdraw(SEED, asHeld, depsOf(v, new Chain(), helper(() => A.withdraw.submitted, sent))), (e: WithdrawRelayRefused) => e.code === "note");
  assert.equal(sent.length, 0);
});

test("the fee read's own edges: its input refusal is the caller's, a relay_fee that is not a decimal, no read while the pages fail", async () => {
  {
    const { v, req } = await reserved();
    const huge = { ...req, body: { ...req.body, withdrawal: { ...req.body.withdrawal, register_deposit: String(1n << 128n) } } };
    const sent: Sent[] = [];
    await assert.rejects(relayWithdraw(SEED, huge, depsOf(v, new Chain(), helper(() => A.withdraw.submitted, sent))), (e: WithdrawRelayRefused) => e.code === "input" && /registerDeposit/.test(e.message));
    assert.equal(sent.length, 0);
  }
  {
    const { v, req } = await reserved();
    const odd = { ...req, body: { ...req.body, withdrawal: { ...req.body.withdrawal, relay_fee: "3e4" } } };
    await assert.rejects(relayWithdraw(SEED, odd, depsOf(v, new Chain(), helper(() => A.withdraw.submitted))), (e: WithdrawRelayRefused) => e.code === "input" && /relay_fee/.test(e.message));
  }
  // while one RPC is down the pages give no block, and fee_max is not read either
  const { v, req } = await reserved();
  const c = new Chain();
  c.bDown = true;
  let priceReads = 0;
  let readsWhileDown = -1;
  const price = priceRpcs().map((r) => ({ ...r, name: r.name, block: (p: Parameters<RelayRpc["block"]>[0]) => (priceReads++, r.block(p)), query: r.query })) as [RelayRpc, RelayRpc];
  const script = (round: number) => {
    if (round === 3) (readsWhileDown = priceReads), (c.bDown = false);
    if (round === 6) landOwn(c, req);
  };
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted), script, 1_000n, { priceRpcs: price }));
  assert.equal(out.kind, "landed");
  assert.equal(readsWhileDown, 0);
  assert.ok(priceReads > 0);
});
