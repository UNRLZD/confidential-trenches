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
import { type HelperWithdrawAnswer, type HelperWithdrawFeeAnswer, type VaultSyncRpc } from "@blindfill/kit";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { askWithdrawFee, type RelayDeps, relayWithdraw, sendWithdraw, WITHDRAW_FEE_URL, WITHDRAW_URL, WithdrawRelayRefused } from "../src/withdraw/relay.ts";
import { type WithdrawRequest, WITHDRAW_SEND_MARGIN_MS, withdrawRequest } from "../src/withdraw/request.ts";
import { argsFor, BLOCK_MS, closeVaults, RELAY_FEE, SEED, signalsProver, TOKEN, VAULT, type Vault, vaultWith } from "./withdraw-fixture.ts";

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
  feeMax: 60_000n,
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

test("the fee: every recorded bad answer is refused, and fee_max and the amount bound a good one", async () => {
  for (const [name, bad] of Object.entries(A.fee.bad)) {
    await assert.rejects(askWithdrawFee(feeArgs(helper(() => bad))), WithdrawRelayRefused, name);
  }
  await assert.rejects(askWithdrawFee(feeArgs(helper(() => A.fee.busy))), (e: WithdrawRelayRefused) => e.code === "helper" && /upstream/.test(e.message));
  // the device's own fee_max, exactly at and one below the answer's fee
  assert.equal((await askWithdrawFee(feeArgs(helper(() => A.fee.good), { feeMax: RELAY_FEE }))).relayFee, RELAY_FEE);
  await assert.rejects(askWithdrawFee(feeArgs(helper(() => A.fee.good), { feeMax: RELAY_FEE - 1n })), (e: WithdrawRelayRefused) => e.code === "fee");
  await assert.rejects(askWithdrawFee(feeArgs(helper(() => A.fee.good), { amount: RELAY_FEE })), (e: WithdrawRelayRefused) => e.code === "fee");
  // an answer over the size limit is refused unread
  const big = { status: 200, body: { ...GOOD_FEE, px: `1.${"0".repeat(1_100)}` } };
  await assert.rejects(askWithdrawFee(feeArgs(helper(() => big))), WithdrawRelayRefused);
});

// ---------- the send's answers ----------
test("the send: submitted and the frozen codes at their status are answers; anything else is not", async () => {
  assert.deepEqual(await sendWithdraw("{}", helper(() => A.withdraw.submitted)), { ok: true, txHash: SUBMITTED.tx_hash });
  for (const [code, a] of Object.entries(A.withdraw.codes)) assert.deepEqual(await sendWithdraw("{}", helper(() => a)), { ok: false, code });
  for (const [name, bad] of Object.entries(A.withdraw.bad)) await assert.rejects(sendWithdraw("{}", helper(() => bad)), WithdrawRelayRefused, name);
});

// ---------- a model vault's pages on two RPCs ----------
type Spend = { nh: bigint; withdrawn: bigint; newLeaf: number; context: bigint };
class Chain {
  height = 175_000_000;
  timeMs = BigInt(BLOCK_MS);
  leaves: bigint[] = Array.from({ length: 8 }, (_, k) => BigInt(100 + k)); // the vault's leaves before this withdrawal
  spends: Spend[] = [{ nh: 41n, withdrawn: 1_000_000n, newLeaf: 7, context: 43n }]; // another user's spend
  hideLastFromB = false; // rpc-b has not got the newest spend yet, at the same height
  bDown = false;
  land(nh: bigint, withdrawn: bigint, leaf: bigint, context: bigint): void {
    this.spends.push({ nh, withdrawn, newLeaf: this.leaves.push(leaf) - 1, context });
  }
  views(hideLast: boolean) {
    const leaves = hideLast ? this.leaves.slice(0, -1) : this.leaves;
    const spends = hideLast ? this.spends.slice(0, -1) : this.spends;
    const tree = (n: number) => ({ size: n, depth: n <= 1 ? 0 : Math.ceil(Math.log2(n)), root: "7" });
    return {
      state_tree: tree(leaves.length),
      label_tree: tree(0),
      spends: spends.map((s, index) => ({
        index, nullifier_hash: String(s.nh), withdrawn: String(s.withdrawn), new_leaf_index: s.newLeaf, refund_precommitment: "5",
        refund_value: "0", refund_label: "0", refund_leaf_index: 0, status: "in_flight",
        payer: "relayer.confidential.unrlzd.near", reserve: "0", recipient: "a".repeat(64), fee: "30000", context: String(s.context),
      })),
      leaves: leaves.map(String),
    };
  }
  rpcs(): [VaultSyncRpc, VaultSyncRpc] {
    const one = (name: string): VaultSyncRpc => ({
      name,
      query: async (p) => {
        if (name === "rpc-b" && this.bDown) throw new Error("down");
        const v = this.views(name === "rpc-b" && this.hideLastFromB) as Record<string, unknown>;
        const method = p.method_name as string;
        const args = JSON.parse(atob(p.args_base64 as string)) as { from?: number; limit?: number };
        let view = v[method];
        if (Array.isArray(view)) view = view.slice(Math.min(args.from!, view.length), Math.min(args.from! + args.limit!, view.length));
        return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${this.height}`, block_height: this.height, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] } };
      },
    });
    return [one("rpc-a"), one("rpc-b")];
  }
}

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
    vault: VAULT,
    rpcs: c.rpcs(),
    newestBlock: async () => ({ height: c.height, timestampNanosec: (c.timeMs * 1_000_000n).toString() }),
    fetchFn,
    pollMs: 1_000,
    resendMs: 5_000,
    sleep: async () => {
      round += 1;
      if (round > 5_000) throw new Error("the test ran away");
      c.height += 1;
      c.timeMs += step;
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
  // rpc-a lies: it shows this attempt's spend and change leaf; rpc-b, the honest one, never does
  landOwn(c, req);
  c.hideLastFromB = true;
  const sent: Sent[] = [];
  const deadline = BigInt(req.body.withdrawal.deadline_ms);
  let heldPast = 0;
  const out = await relayWithdraw(SEED, req, depsOf(v, c, helper(() => A.withdraw.submitted, sent, c), async () => {
    // while the RPCs disagree nothing is concluded, past the deadline too: the note stays RESERVED
    assert.equal((await v.ns.get(req.noteId))!.state, "RESERVED");
    assert.equal(await changeOf(v), undefined);
    if (c.timeMs > deadline && ++heldPast === 3) (c.spends.pop(), c.leaves.pop(), (c.hideLastFromB = false)); // the lie ends
  }, 10_000n));
  assert.equal(heldPast, 3);
  assert.equal(out.kind, "expired");
  if (out.kind !== "expired") return;
  assert.equal(out.route, "relayer");
  assert.equal(out.note.state, "UNSPENT");
  assert.equal(await changeOf(v), undefined);
  assert.ok(c.timeMs > deadline);
  // the same bytes each time, every 5 s of rounds after submitted, never once check 9's margin is reached
  assert.ok(sent.length >= 2);
  for (const s of sent) assert.equal(s.init.body, JSON.stringify(req.body));
  for (const s of sent) assert.ok(s.timeMs + BigInt(WITHDRAW_SEND_MARGIN_MS) < deadline);
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
