// The cash run and the quote's window (split from test/withdraw-handoff.test.ts, card readme-run-fits-an-agent-timeout;
// the world in ./withdraw-handoff-world.ts).
// Real proofs: only "the cash run sends Cash whole ...", whose relayer checks verify its first part's proof; every
// other test reads the run's plan, notes and the quote's window, so its page proves on signalsProver.
//   node --test test/withdraw-handoff-cash.test.ts   (from packages/signpage)
/// <reference types="node" />
// the world first: it loads the 1Click mock and sets __SIGN_NETWORK__ before the modules that read them (./withdraw-handoff-world.ts)
import { R, RELAY_FEE, SCOPE, SEED, T, cashNotes, cashWithdrawRun, checkWithdraw, expired, feeAnswer, handoffOf, helper, lowerFinalTime, page, pair, planCashWithdraw, snarkProver, testnet, world, h1c, signalsProver } from "./withdraw-handoff-world.ts";
import type { Page, World } from "./withdraw-handoff-world.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import { armAccount, entropyToWords, refundId, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import type { WithdrawRequest } from "../../wallet/src/withdraw/request.ts";
import type { HandoffOver, HandoffPage } from "../src/withdraw/handoff.ts";

// ---------- the cash run (card cash-withdraws-everything-to-any-chain): one withdrawal per note, in order ----------
async function runOf(v: World, p: Page, over: HandoffOver = {}) {
  const blockNs = await lowerFinalTime(pair("testnet"));
  const r = cashWithdrawRun(p, {
    network: "testnet",
    rpcs: pair("testnet"),
    priceRpcs: pair("mainnet"),
    fetchFn: helper(),
    sync: async () => ({ stateTree: v.stateTree, labelTree: v.labelTree, newestStateRoot: v.stateTree.root!, newestLabelRoot: v.labelTree.root! }),
    blockNs: async () => blockNs,
    arrival: async () => Promise.reject(new Error("no arrival read in this test")),
    ...over,
  });
  assert.ok(r);
  return r;
}

test("the cash run sends Cash whole: one withdrawal per note, largest first, each exactly its part at the fee the form drew", async () => {
  const v = await world([2_000_000n, 3_000_000n]);
  // the form drew a fee 1,000 above the relayer's quote now: each part pays that fee, so each whole note goes out
  // exactly as planned with no change left (the relayer takes any fee at or above its quote)
  const drawn = RELAY_FEE + 1_000n;
  const cash = cashNotes(await v.ns.list(), SCOPE);
  const max = cash.reduce((t, n) => t + n.value - drawn, 0n);
  const parts = planCashWithdraw(cash, max, drawn)!;
  assert.equal(parts.length, 2);
  const sent: WithdrawRequest[] = [];
  const steps: [number, string][] = [];
  const run = await runOf(v, page(v, snarkProver), { // real proofs: the relayer's checks below verify the first
    relay: async (_seed, req) => {
      sent.push(req);
      return { kind: "landed", own: false, change: (await v.ns.get(req.noteId))!, spend: { recipient: req.recipient, status: "paid", refundValue: 0n } as never, tx: null };
    },
  });
  assert.deepEqual(await run({ recipient: "alice.testnet", amount: max, parts }, drawn, (i, k) => steps.push([i, k])), { kind: "arrived" });
  assert.deepEqual(steps, [[0, "sending"], [0, "arrived"], [1, "sending"], [1, "arrived"]]);
  assert.deepEqual(sent.map((r) => [(cash.find((n) => n.id === r.noteId)!).value, r.changeValue, r.body.withdrawal.recipient, r.body.withdrawal.relay_fee]), [
    [3_000_000n, 0n, "alice.testnet", String(drawn)],
    [2_000_000n, 0n, "alice.testnet", String(drawn)],
  ]);
  // change 0 at the drawn fee: each withdrawal is its note less the drawn fee, the plan's part exactly
  assert.deepEqual(parts.map((p) => p.part), [3_000_000n - drawn, 2_000_000n - drawn]);
  // the relayer's own checks pass a request that pays more than its quote
  const verdict = await checkWithdraw(structuredClone(sent[0]!.body), { vault: T.vault, token: T.usdc, scope: SCOPE, feeRecipient: R.fee_recipient }, { feeMin: async () => RELAY_FEE });
  assert.deepEqual(verdict.ok ? "ok" : verdict, "ok");
});

// the 1Click answers here are test/oneclick-mock.ts's: 25 USDC in, signed by a key this process alone trusts
const SOL_TO = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DEPOSIT = "cd".repeat(32);
function onwardFetch(m: Parameters<typeof h1c>[0] = {}) {
  const q = h1c({ stampedAt: Date.now() - 500, before: (a) => void (a.quote.depositAddress = DEPOSIT), ...m });
  const fee = helper();
  const fetchFn = ((u: RequestInfo | URL, i?: RequestInit) => (String(u).includes("/oneclick/") ? q.fetch(u, i) : fee(u, i))) as typeof fetch;
  return { fetchFn, sent: q.sent };
}

test("the cash run to another chain: each part's own checked 1Click quote, its refund under V of the change note, the vault paying its deposit address", async () => {
  const v = await world([25_000_000n + RELAY_FEE]);
  const cash = cashNotes(await v.ns.list(), SCOPE);
  const parts = planCashWithdraw(cash, 25_000_000n, RELAY_FEE)!;
  const { fetchFn, sent: asked } = onwardFetch();
  const sent: WithdrawRequest[] = [];
  const run = await runOf(v, page(v), {
    fetchFn,
    relay: async (_seed, req) => {
      sent.push(req);
      return { kind: "landed", own: false, change: (await v.ns.get(req.noteId))!, spend: { recipient: req.recipient, status: "paid", refundValue: 0n } as never, tx: null };
    },
  });
  assert.deepEqual(await run({ recipient: SOL_TO, amount: 25_000_000n, parts, chain: "solana" }, RELAY_FEE), { kind: "arrived" });
  assert.equal(asked.length, 1);
  const q = asked[0]!.request;
  assert.equal(q.recipient, SOL_TO);
  assert.equal(q.amount, "25000000");
  assert.equal(q.destinationAsset, "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near");
  // the refund id is V_{l,0}, the change note's of the note's first spend, as restore reads it (restore/arms.ts kind "V")
  const leaf = (await v.ns.get(parts[0]!.noteId))!.leaf!;
  const k = refundId(SEED, leaf.label, 0);
  k.secretKey.fill(0);
  assert.equal(q.refundTo, k.id);
  assert.equal(q.refundType, "INTENTS");
  assert.equal(JSON.stringify(q).includes("alice"), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.withdrawal.recipient, DEPOSIT, "the vault pays the quote's deposit address");
  assert.equal(sent[0]!.body.withdrawal.relay_fee, String(RELAY_FEE));
  assert.equal(sent[0]!.changeValue, 0n, "the note less 25 USDC and the fee: the part exactly");
});

test("the cash run to another chain pays nothing on a quote the device refuses: the note stays in Cash", async () => {
  for (const [m, re] of [
    [{ before: () => {} }, /deposit address is not a NEAR implicit id/],
    [{ before: (a) => void ((a.quote.depositAddress = DEPOSIT), (a.quoteRequest.recipient = "9".repeat(44))) }, /echo|recipient/],
    [{ status: 503 }, /onward quote: HTTP 503/],
  ] as [Parameters<typeof h1c>[0], RegExp][]) {
    const v = await world([25_000_000n + RELAY_FEE]);
    const parts = planCashWithdraw(cashNotes(await v.ns.list(), SCOPE), 25_000_000n, RELAY_FEE)!;
    let relayed = 0;
    const steps: [number, string][] = [];
    const run = await runOf(v, page(v), { fetchFn: onwardFetch(m).fetchFn, relay: async (_s, req) => (relayed++, expired(v, req)) });
    await assert.rejects(run({ recipient: SOL_TO, amount: 25_000_000n, parts, chain: "solana" }, RELAY_FEE, (i, kd) => steps.push([i, kd])), re);
    assert.equal(relayed, 0);
    assert.deepEqual(steps, [[0, "sending"], [0, "failed"]]);
    assert.equal((await v.ns.get(parts[0]!.noteId))?.state, "UNSPENT");
  }
  // an address that is not the chain's is refused before any quote is asked
  const v = await world([25_000_000n + RELAY_FEE]);
  const parts = planCashWithdraw(cashNotes(await v.ns.list(), SCOPE), 25_000_000n, RELAY_FEE)!;
  const o = onwardFetch();
  const run = await runOf(v, page(v), { fetchFn: o.fetchFn });
  await assert.rejects(run({ recipient: "alice.near", amount: 25_000_000n, parts, chain: "solana" }, RELAY_FEE), /not an address on the chain/);
  assert.equal(o.sent.length, 0);
});

test("the cash run stops at the first withdrawal that does not leave the vault: the notes after it stay in Cash", async () => {
  const v = await world([2_000_000n, 3_000_000n]);
  const cash = cashNotes(await v.ns.list(), SCOPE);
  const max = cash.reduce((t, n) => t + n.value - RELAY_FEE, 0n);
  const parts = planCashWithdraw(cash, max, RELAY_FEE)!;
  let relayed = 0;
  const steps: [number, string][] = [];
  const run = await runOf(v, page(v), { relay: async (_s, req) => (relayed++, expired(v, req)) });
  assert.deepEqual(await run({ recipient: "alice.testnet", amount: max, parts }, RELAY_FEE, (i, k) => steps.push([i, k])), { kind: "expired" });
  assert.equal(relayed, 1);
  assert.deepEqual(steps, [[0, "sending"], [0, "expired"]]);
  assert.equal((await v.ns.get(parts[1]!.noteId))?.state, "UNSPENT", "the second note never left Cash");
  // a plan whose parts are not the amount is refused before anything is asked
  await assert.rejects(run({ recipient: "alice.testnet", amount: max + 1n, parts }, RELAY_FEE), /parts: not the amount/);
});

// ---------- card near-buy-works-on-live: the quote's window ----------
// The helper keeps a fee quote FEE_QUOTE_WINDOW_BLOCKS blocks (apps/helper/src/withdraw/fee.ts: 100 at this card, 1,200
// since near-cash-pays-any-amount; the world keeps 100, so a slow read or proof outlasts it); past it a POST is
// priced at the fee now and a lower relay_fee is refused fee_too_low, which holds the note RESERVED until its deadline
// with nothing paid (live 14 Nov 20:5xZ: a $1 NEAR buy's payout never reached the chain, its note held). A chain of
// heights stands in for the network: each quote is the fee at its height, open 100 blocks; fee_min rises one unit a
// block; the fake relay answers as the helper's POST does at the height it is sent.
function windowWorld(o: { slowSync?: number; slowProofs?: number[] } = {}) {
  const c = { h: 1_000, quotes: [] as { fee: bigint; until: number }[], answers: [] as string[], sent: [] as WithdrawRequest[], proofs: 0 };
  const feeMin = (h: number) => RELAY_FEE + BigInt(h - 1_000);
  const fetchFn = (async () => {
    const q = { fee: feeMin(c.h), until: c.h + 100 };
    c.quotes.push(q);
    return new Response(JSON.stringify(feeAnswer({ relay_fee: String(q.fee), valid_until_block: q.until })), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const over = (v: World): HandoffOver => ({
    fetchFn,
    height: async () => c.h,
    sync: async () => {
      c.h += o.slowSync ?? 0; // the trees' reads take their blocks
      return { stateTree: v.stateTree, labelTree: v.labelTree, newestStateRoot: v.stateTree.root!, newestLabelRoot: v.labelTree.root! };
    },
    relay: async (_seed, req) => {
      c.sent.push(req);
      const fee = BigInt(req.body.withdrawal.relay_fee);
      const open = c.quotes.filter((q) => q.until >= c.h).map((q) => q.fee);
      const floor = [feeMin(c.h), ...open].reduce((a, b) => (a < b ? a : b));
      if (fee < floor) {
        c.answers.push("fee_too_low");
        // the real relay stops sending and waits for the deadline: the note stays RESERVED meanwhile
        return { kind: "expired", note: (await v.ns.get(req.noteId))!, route: "relayer", lastAnswer: "fee_too_low" };
      }
      c.answers.push("submitted");
      return { kind: "landed", own: true, change: (await v.ns.get(req.noteId))!, spend: {} as never, tx: null };
    },
  });
  const signals = signalsProver();
  const prover: VaultProver = {
    async load() {},
    async prove(circuit, input) {
      c.h += o.slowProofs?.[c.proofs] ?? o.slowProofs?.at(-1) ?? 0; // the proof takes its blocks
      c.proofs += 1;
      return signals.prove(circuit, input);
    },
  };
  return { c, over, prover };
}

test("quote-to-send past the helper's 100-block window with fee_min rising: the quote is asked after the slow reads, so the request is sent inside its window and lands (red: fee_too_low)", async () => {
  const v = await world([5_000_000n]);
  const { c, over, prover } = windowWorld({ slowSync: 120 });
  const h = await handoffOf(v, page(v, prover), over(v));
  const end = await h({ recipient: "ab".repeat(32), amount: 1_000_000n }, RELAY_FEE + 1_000n);
  assert.deepEqual(c.answers, ["submitted"], "the helper's answer to the one request sent");
  assert.deepEqual(end, { kind: "landed" });
});

test("a proof that outlasts the quote's window: the note goes back UNSPENT before anything is sent, the request is quoted and proved again in the same tap, and lands (red: sent stale, fee_too_low, the note held RESERVED)", async () => {
  const v = await world([5_000_000n]);
  const { c, over, prover } = windowWorld({ slowProofs: [150, 0] });
  const h = await handoffOf(v, page(v, prover), over(v));
  const end = await h({ recipient: "ab".repeat(32), amount: 1_000_000n }, RELAY_FEE + 1_000n);
  assert.deepEqual(c.answers, ["submitted"], "only the fresh request is sent");
  assert.equal(c.proofs, 2, "proved again on the fresh quote");
  assert.equal(c.sent[0]!.body.withdrawal.relay_fee, String(c.quotes.at(-1)!.fee), "the fee of the fresh quote");
  assert.deepEqual(end, { kind: "landed" });
});

test("every proof outlasts its quote's window: after the tries the hand-off ends with nothing sent and the note UNSPENT at once, never held RESERVED (red: RESERVED with a stale request)", async () => {
  const v = await world([5_000_000n]);
  const { c, over, prover } = windowWorld({ slowProofs: [150] });
  const h = await handoffOf(v, page(v, prover), over(v));
  const end = await h({ recipient: "ab".repeat(32), amount: 1_000_000n }, RELAY_FEE + 10_000n);
  const [n] = await v.ns.list();
  assert.equal(n!.state, "UNSPENT", "Cash holds the whole note again");
  assert.deepEqual(c.answers, [], "nothing sent");
  assert.equal(end.kind, "fee");
});

// card wallet-withdraw-requote: a re-quote is made only before RESERVED; a request the relayer refuses once sent stands
// (wallet relay.ts: a check's refusal ends the sends, the deadline frees the note), so no tap loops on re-proofs
test("a re-quoted request the relayer still refuses fee_too_low: the tap ends on it, quoted and proved twice and sent once, never quoted or proved again", async () => {
  const v = await world([5_000_000n]);
  const { c, over, prover } = windowWorld({ slowProofs: [150, 0] });
  const refused: HandoffOver["relay"] = async (_seed, req) => {
    c.sent.push(req);
    c.answers.push("fee_too_low");
    return { kind: "expired", note: (await v.ns.get(req.noteId))!, route: "relayer", lastAnswer: "fee_too_low" };
  };
  const h = await handoffOf(v, page(v, prover), { ...over(v), relay: refused });
  const end = await h({ recipient: "ab".repeat(32), amount: 1_000_000n }, RELAY_FEE + 1_000n);
  assert.deepEqual(end, { kind: "expired" });
  assert.deepEqual(c.answers, ["fee_too_low"], "one send, its refusal shown as the end");
  assert.equal(c.quotes.length, 2, "the stale quote and one re-quote");
  assert.equal(c.proofs, 2, "the stale proof and one re-proof");
  assert.equal(c.sent[0]!.body.withdrawal.relay_fee, String(c.quotes[1]!.fee), "sent at the re-quote's fee");
});
