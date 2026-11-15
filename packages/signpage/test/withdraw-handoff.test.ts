// The withdraw form's reads, the hand-off kept for the card that pays the typed account, and the settle pass (card
// signpage-withdraw-handoff): the note value over the note store, the relayer's fee bounded by the device's own fee_max,
// and the hand-off to the wallet's withdraw path, whose request, proved for real (snarkjs 0.7.5 over the kit's pinned
// withdraw.wasm and withdraw.zkey, the prover worker's call), passes the relayer's own checks
// (apps/helper/src/withdraw/checks.ts checkWithdraw) for the testnet release. The form gives no hand-off on any build.
// A page that dies at any step leaves no note held for good: the settle pass follows each RESERVED note from its stored
// request. Run as the testnet build (__SIGN_NETWORK__ "testnet", set before the modules load: the testnet relayer is
// that build's only); SIGN_HOST's build is held in test/withdraw-form.test.ts.
//   node --test test/withdraw-handoff.test.ts   (from packages/signpage)
// IndexedDB is fake-indexeddb; the fee_max reads are the wallet's recorded ones (wallet test/vectors/withdraw-feemax.json).
// Test values only, never money: the notes are the public all-zero test seed's (wallet test/vectors/a8.json).
/// <reference types="node" />
// the world first: it loads the 1Click mock and sets __SIGN_NETWORK__ before the modules that read them (./withdraw-handoff-world.ts)
import { MIN, R, RELAY_FEE, SCOPE, SEED, T, bytes, checkWithdraw, expired, feeAnswer, handoffOf, helper, leftReserved, lowerFinalTime, openNoteStore, page, pair, readTokenStorageMin, settleWith, snarkProver, testnet, tick, treesOf, withdrawFormDeps, withdrawHandoff, withdrawSettle, world, zeroed, signalsProver } from "./withdraw-handoff-world.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { armAccount, entropyToWords, refundId, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import type { RelayOutcome, RelayRpc } from "../../wallet/src/withdraw/relay.ts";
import type { WithdrawRequest } from "../../wallet/src/withdraw/request.ts";

// ---------- the form: reads only ----------
test("the testnet form, whose release names a vault and a relayer, offers the hand-off that pays the typed account", async () => {
  const v = await world([5_000_000n]);
  const d = testnet(v);
  assert.equal(typeof d.handoff, "function", "Withdraw is offered: the vault pays the typed account straight (wallet-withdraw-move-out)");
  assert.equal(await d.available(), 5_000_000n);
  assert.equal(await d.fee(), RELAY_FEE);
});

// The release names its mainnet vault and withdrawal relayer (card wallet-mainnet-relayer-pins); the release-with-no-relayer
// case is held in test/withdraw-mainnet-relayer.test.ts, with the pin planted null.
test("a mainnet form over testnet notes: the note value 0, the fee refused unasked, nothing to settle", async () => {
  const v = await world([5_000_000n]);
  const p = page(v);
  const seen: string[] = [];
  const d = withdrawFormDeps(p, { network: "mainnet", rpcs: pair("mainnet"), priceRpcs: pair("mainnet"), fetchFn: helper(feeAnswer(), seen) });
  assert.equal(d.network, "mainnet");
  assert.equal(await d.available(), 0n, "no note of this world is on the mainnet vault's scope");
  await assert.rejects(d.fee(), /withdraw relay refused \(input\): amount: not a bigint above 0/);
  assert.deepEqual(seen, [], "the helper is never asked");
  assert.deepEqual(await withdrawSettle(p, { network: "mainnet", rpcs: pair("mainnet") }), { outcomes: {} });
  assert.equal(p.opened.length, 0, "the seed is never opened");
});

test("a pair that is not the build's network's is refused before any read: the fee, the hand-off and the settle pass", async () => {
  const v = await world([5_000_000n]);
  const seen: string[] = [];
  // a mainnet form with the testnet pair: refused for the pair, not for mainnet's missing relayer
  const m = withdrawFormDeps(page(v), { network: "mainnet", rpcs: pair("testnet"), fetchFn: helper(feeAnswer(), seen) });
  await assert.rejects(m.fee(), /the RPCs must be one of https:\/\/rpc\.mainnet\.fastnear\.com/);
  // the testnet release with the mainnet pair, for the fee, the hand-off and the settle pass
  const wrong = { rpcs: pair("mainnet") };
  await assert.rejects(testnet(v, { ...wrong, fetchFn: helper(feeAnswer(), seen) }).fee(), /the RPCs must be one of https:\/\/test\.rpc\.fastnear\.com/);
  const p = page(v);
  const h = await handoffOf(v, p, { ...wrong, fetchFn: helper(feeAnswer(), seen) });
  await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), /the RPCs must be one of https:\/\/test\.rpc\.fastnear\.com/);
  await assert.rejects(withdrawSettle(p, { network: "testnet", ...wrong, priceRpcs: pair("mainnet") }), /the RPCs must be one of https:\/\/test/);
  // and a testnet price pair
  await assert.rejects(testnet(v, { priceRpcs: pair("testnet"), fetchFn: helper(feeAnswer(), seen) }).fee(), /priceRpcs: the RPCs must be one of https:\/\/rpc\.mainnet/);
  assert.deepEqual(seen, [], "no quote asked");
  assert.equal(p.opened.length, 0);
});

test("available is the largest UNSPENT note of the vault's scope in the note store", async () => {
  const v = await world([2_000_000n, 10_000_000n, 5_000_000n]);
  // a note of another scope, larger, never counts
  const other = await world([50_000_000n], SCOPE + 1n);
  assert.equal(await testnet(v).available(), 10_000_000n);
  assert.equal(await testnet(other).available(), 0n);
  // a held note no longer counts
  const ten = (await v.ns.list()).find((n) => n.leaf?.value === 10_000_000n)!;
  await v.ns.move(ten.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "1" });
  assert.equal(await testnet(v).available(), 5_000_000n);
});

test("fee is the release relayer's quote, bounded by the device's own fee_max at the token's storage minimum", async () => {
  // a note far above any fee, so the quote's "at or above the amount" refusal never comes first
  const v = await world([1_000_000_000n]);
  const seen: string[] = [];
  const asked: string[] = [];
  const d = testnet(v, { rpcs: pair("testnet", asked), fetchFn: helper(feeAnswer(), seen) });
  assert.equal(await d.fee(), RELAY_FEE);
  assert.deepEqual(seen, [`https://ct-api.unrealized.trade/v1/withdraw/fee?token=${T.usdc}`]);
  assert.deepEqual(asked, [], "the form names no A before a note is picked");
  // below the amount and above fee_max: refused for fee_max
  await assert.rejects(testnet(v, { fetchFn: helper(feeAnswer({ relay_fee: "100000000" })) }).fee(), /relay_fee: above the device's fee_max/);
  // an answer naming another relayer: refused
  await assert.rejects(testnet(v, { fetchFn: helper(feeAnswer({ fee_recipient: "f.testnet" })) }).fee(), /not the release's/);
  // the two RPCs disagree on the storage minimum: refused
  await assert.rejects(testnet(v, { rpcs: pair("testnet", [], (s) => (s === "a" ? MIN : MIN + 1n)) }).fee(), /disagree/);
});

test("readTokenStorageMin: the network's pair only, a block height on each answer, the two heights close", async () => {
  await assert.rejects(readTokenStorageMin("testnet", pair("mainnet")), /the RPCs must be one of https:\/\/test/);
  assert.equal(await readTokenStorageMin("testnet", pair("testnet")), MIN);
  const [a, b] = pair("testnet");
  const edit = (f: (r: { result: Record<string, unknown> }) => void): RelayRpc => ({
    ...b,
    async query(p) {
      const r = (await b.query(p)) as { result: Record<string, unknown> };
      if (p.method_name === "storage_balance_bounds") f(r);
      return r;
    },
  });
  await assert.rejects(readTokenStorageMin("testnet", [a, edit((r) => delete r.result.block_height)]), /block_height|block height/);
  await assert.rejects(readTokenStorageMin("testnet", [a, edit((r) => ((r.result.block_height as number) -= 1000))]), /spread/);
});

test("the synced trees are refused unless their roots are the vault's", () => {
  const leaves = [11n, 12n, 13n];
  const labels = [21n, 22n, 23n];
  const s = { leaves, labels, stateTree: { root: new VaultTree(leaves).root! }, labelTree: { root: new VaultTree(labels).root! } };
  assert.equal(treesOf(s).newestStateRoot, s.stateTree.root);
  assert.throws(() => treesOf({ ...s, stateTree: { root: s.stateTree.root + 1n } }), /roots are not the vault's/);
  assert.throws(() => treesOf({ ...s, labelTree: { root: s.labelTree.root + 1n } }), /roots are not the vault's/);
});

// ---------- the hand-off (withdrawHandoff, for wallet-withdraw-move-out) ----------
test("the hand-off proves on the page's prover, RESERVES the note with its request and hands relayWithdraw a request the relayer's checks pass", async () => {
  const v = await world([2_000_000n, 5_000_000n, 10_000_000n]);
  const asked: string[] = [];
  let sent: WithdrawRequest | null = null;
  let waited: AbortSignal | undefined;
  const p = page(v, snarkProver); // a real proof: the relayer's checks below verify it
  const h = await handoffOf(v, p, {
    rpcs: pair("testnet", asked),
    relay: async (seed, req, deps) => {
      assert.equal(deps.network, "testnet");
      waited = deps.signal;
      sent = req;
      await tick();
      assert.ok(zeroed(seed), "the seed is zeroed while the relay waits");
      return expired(v, req);
    },
  });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "expired" });
  assert.equal(p.opened.length, 1);
  assert.ok(zeroed(p.opened[0]!));
  assert.ok(waited instanceof AbortSignal, "the wait is bounded");
  const req = sent as WithdrawRequest | null;
  assert.ok(req);
  // the smallest note covering 3 USDC plus the fee, RESERVED with its request's bytes, paying the typed account straight
  const spent = (await v.ns.get(req.noteId))!;
  assert.equal(spent.leaf?.value, 5_000_000n);
  assert.equal(spent.state, "RESERVED");
  assert.equal(spent.request, JSON.stringify(req.body));
  const a = armAccount(SEED, spent.leaf!.label, 0);
  a.secretKey.fill(0);
  assert.equal(req.body.withdrawal.recipient, "alice.testnet");
  assert.equal(req.recipient, "alice.testnet");
  assert.equal(req.body.fund_recipient, false);
  assert.notEqual(req.body.withdrawal.recipient, a.id, "never the note's A");
  assert.deepEqual(asked, [], "no read names the typed account: register_deposit is the token's minimum for every recipient (card relayer-cost-guards, review F2)");
  assert.equal(req.body.withdrawal.register_deposit, String(MIN));
  assert.equal(req.body.withdrawal.fee_recipient, R.fee_recipient);
  assert.equal(req.body.withdrawal.relay_fee, String(RELAY_FEE));
  assert.equal(req.body.token, T.usdc);
  const verdict = await checkWithdraw(structuredClone(req.body), { vault: T.vault, token: T.usdc, scope: SCOPE, feeRecipient: R.fee_recipient }, { feeMin: async () => RELAY_FEE });
  assert.deepEqual(verdict.ok ? "ok" : verdict, "ok");
});

test("the hand-off's fresh quote above the fee the form drew: the new fee back, nothing proved, the seed never opened", async () => {
  const v = await world([5_000_000n]);
  let proved = 0;
  const p = page(v, { async load() {}, async prove() { proved += 1; throw new Error("not proved"); } });
  const h = await handoffOf(v, p);
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE - 1n), { kind: "fee", fee: RELAY_FEE });
  assert.equal(proved, 0);
  assert.equal(p.opened.length, 0);
  assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
});

test("the seed is zeroed when the prover throws, and the note is UNSPENT again", async () => {
  const v = await world([5_000_000n]);
  const p = page(v, { async load() {}, async prove() { throw new Error("prover down"); } });
  const h = await handoffOf(v, p);
  await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), /prover down/);
  assert.equal(p.opened.length, 1);
  assert.ok(zeroed(p.opened[0]!));
  assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
});

test("sign out stops the relay's wait: the signal the relay gets is the page's, the note left RESERVED for the settle pass", async () => {
  const v = await world([5_000_000n]);
  const out = new AbortController();
  const p = page(v, signalsProver(), out.signal);
  const h = await handoffOf(v, p, {
    relay: async (_seed, _req, deps) => {
      out.abort(); // the sign out, mid-wait
      deps.signal!.throwIfAborted();
      throw new Error("not stopped");
    },
  });
  await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), (e: unknown) => (e as Error).name === "AbortError");
  assert.ok(zeroed(p.opened[0]!));
  const [n] = await v.ns.list();
  assert.equal(n!.state, "RESERVED");
  assert.ok(n!.request);
  // the bound: a wait past waitMs stops too
  const w2 = await world([5_000_000n]);
  const h2 = await handoffOf(w2, page(w2), {
    waitMs: 5,
    relay: async (_s, _r, deps) => {
      await new Promise((r) => setTimeout(r, 40));
      deps.signal!.throwIfAborted();
      throw new Error("not bounded");
    },
  });
  await assert.rejects(h2({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), (e: unknown) => (e as Error).name === "TimeoutError");
});

// ---------- a page that dies at any step: the settle pass (withdrawSettle) ----------
test("page death during the proof: the HELD note goes back to UNSPENT when the note store opens again", async () => {
  const v = await world([5_000_000n]);
  const dying = await openNoteStore(v.w);
  const [n] = await dying.list();
  await dying.move(n!.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  dying.close(); // the page's death: its tab lock goes
  const again = await openNoteStore(v.w);
  assert.equal((await again.get(n!.id))!.state, "UNSPENT");
  again.close();
});

test("page death after RESERVED or in the relay's wait: the settle pass sends the stored request again and follows it to landed", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const got: WithdrawRequest[] = [];
  const p = page(v);
  const pass = await settleWith(v, async (seed, r, deps) => {
    got.push(r);
    assert.ok(deps.signal instanceof AbortSignal);
    await tick();
    assert.ok(zeroed(seed), "the seed is zeroed while the pass waits");
    return { kind: "landed", own: true, change: (await v.ns.get(r.noteId))!, spend: {} as never, tx: null };
  }, p);
  assert.deepEqual(pass.outcomes, { [req.noteId]: "landed" });
  assert.equal(got.length, 1);
  assert.equal(JSON.stringify(got[0]!.body), JSON.stringify(req.body), "the same bytes");
  assert.equal(got[0]!.noteId, req.noteId);
  assert.deepEqual(got[0]!.change, req.change);
  assert.deepEqual(got[0]!.refund, req.refund);
  assert.equal(got[0]!.recipient, req.recipient);
  assert.equal(got[0]!.changeValue, req.changeValue);
  assert.ok(zeroed(p.opened[0]!));
});

test("the settle pass on a ragequit of the note (context 0, no change inserted): SPENT, its request dropped", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => ({ kind: "unmatched", spend: { context: 0n } as never }));
  assert.deepEqual(pass.outcomes, { [req.noteId]: "spent" });
  const n = (await v.ns.get(req.noteId))!;
  assert.equal(n.state, "SPENT");
  assert.equal(n.request, undefined);
});

test("the settle pass on a withdraw whose new leaf is not the device's change (a drift): RESERVED with its request, unmatched, never dropped", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => ({ kind: "unmatched", spend: { context: 123n } as never }));
  assert.deepEqual(pass.outcomes, { [req.noteId]: "unmatched" });
  const n = (await v.ns.get(req.noteId))!;
  assert.equal(n.state, "RESERVED");
  assert.equal(n.request, JSON.stringify(req.body));
});

test("the settle pass: one note's stored request that cannot be read fails that note alone; the others are followed", async () => {
  const v = await world([5_000_000n, 6_000_000n]);
  const [a, b] = await v.ns.list();
  const bad = await v.ns.move(a!.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await v.ns.move(a!.id, "HELD", "RESERVED", { attempt: bad.attempt, request: "{}" }); // JSON, not a request body
  const req = await leftReserved(v);
  assert.equal(req.noteId, b!.id);
  const pass = await settleWith(v, async (_s, r) => expired(v, r));
  assert.deepEqual(pass.outcomes, { [a!.id]: "failed", [b!.id]: "expired" });
  assert.equal((await v.ns.get(a!.id))!.state, "RESERVED");
});

test("the settle pass's relay throws (no answer, sign out): the note stays RESERVED with its request for the next pass", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => {
    throw new Error("RPCs down");
  });
  assert.deepEqual(pass.outcomes, { [req.noteId]: "failed" });
  const n = (await v.ns.get(req.noteId))!;
  assert.equal(n.state, "RESERVED");
  assert.equal(n.request, JSON.stringify(req.body));
  // the next pass: past its deadline with no spend, relayWithdraw frees it (expired)
  assert.deepEqual((await settleWith(v, async (_s, r) => expired(v, r))).outcomes, { [req.noteId]: "expired" });
});

test("the settle pass leaves other notes alone: none RESERVED, the seed is never opened", async () => {
  const v = await world([5_000_000n]);
  const p = page(v);
  assert.deepEqual(await settleWith(v, async () => { throw new Error("not called"); }, p), { outcomes: {} });
  assert.equal(p.opened.length, 0);
});

test("T is the lower of the pair's final block times, refused when they differ by over 60 s", async () => {
  const at = (ns: string): RelayRpc => ({ name: "x", query: async () => ({}), block: async () => ({ result: { header: { timestamp_nanosec: ns } } }) });
  assert.equal(await lowerFinalTime([at("1030000000000"), at("1000000000000")]), "1000000000000");
  await assert.rejects(lowerFinalTime([at("61000000001"), at("1000000000")]), /over 60 s/);
  await assert.rejects(lowerFinalTime([at("1"), { ...at("1"), block: async () => ({ error: { name: "X" } }) }]), /not a final block/);
});
