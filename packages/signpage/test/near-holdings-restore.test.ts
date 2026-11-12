// The NEAR buy records rebuilt from the chain (card near-holdings-restore, src/near-buy.ts nearHoldingsPass): after a
// sign out, a new device or a restore from the 12 words, a W of a NEAR buy shows again as a position and sells, and USDC
// left on a W goes home; never from a hint alone, never a second record, never over the store's own. A fake store
// (fake-indexeddb), the vault's spends rows and both providers' views faked.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { VaultSpendRow } from "../../kit/src/vault/sync.ts";
import type { NearRpc } from "../../kit/src/near/networks.ts";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA } from "../../kit/src/near/rhea.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import { nearSwapWallet } from "../../wallet/src/near/swap-delegate.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { depsOf, NEAR_BUY_KEY, NEAR_BUY_RESUMES, NEAR_HOLDINGS_EMPTY_AFTER_MS, NEAR_HOLDINGS_EMPTY_KEY, nearBuyRecordOf, nearHoldingsPass, nearPositions, nearSellKind, nearTokenHints, resumeNearBuys, resumeNearSells, sellDepsOf, type NearBuyPage, type NearBuyRecord } from "../src/near-buy.ts";
import { vaultScope } from "../src/withdraw/checks.ts";

const SEED = new Uint8Array(64).fill(0x42); // the public test seed
const NETWORK = "mainnet" as const;
const SCOPE = vaultScope(NETWORK)!;
const USDC = NEAR_NETWORKS.mainnet.usdc;
const TOKEN = "token.rhealab.near";
const PAID = 3_000_000n;

const worlds: { w: WalletStore; ns: NoteStore }[] = [];
after(() => {
  for (const v of worlds.splice(0)) (v.ns.close(), v.w.close());
});

/** A store as a restore leaves it: the notes, each SPENT when `spent` says so, and no buy record. */
async function world(values: bigint[], spent: boolean[]) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  for (const [k, value] of values.entries()) {
    let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k + 1));
    const commitment = noteCommitment(value, label, n.precommitment);
    n = await ns.move(n.id, "PLANNED", "INCOMING");
    n = await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(k) } });
    if (spent[k]) n = await ns.move(n.id, "UNSPENT", "SPENT");
  }
  const notes = (await ns.list()).filter((n) => n.state === "SPENT");
  const ws = notes.map((n) => ({ note: n, w: nearSwapWallet(SEED, n.leaf!.label, jOf(n.ref)).id, nh: noteSecrets(SEED, n.ref).nullifierHash }));
  return { w, ns, ws };
}

/** The vault's spends row of a note: paid to `recipient`. */
const row = (nh: bigint, recipient: string, o: Partial<VaultSpendRow> = {}): VaultSpendRow => ({
  index: 0, nullifierHash: nh, withdrawn: PAID, newLeafIndex: 0n, refundPrecommitment: 0n, refundValue: 0n, refundLabel: 0n, refundLeafIndex: 0n, status: "paid", payer: "r.near", reserve: 0n, recipient, fee: 20_000n, context: 0n, ...o,
});

/** Two providers answering ft_balance_of and ft_metadata from `held` (token -> account -> units; `b` overrides the second). */
function providers(held: Record<string, Record<string, bigint>>, b?: Record<string, Record<string, bigint>>, reads: string[] = []): readonly [NearRpc, NearRpc] {
  const one = (name: string, h: Record<string, Record<string, bigint>>): NearRpc => ({
    name,
    async query(p) {
      const args = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString());
      reads.push(`${name} ${String(p.account_id)} ${String(p.method_name)}`);
      const v = p.method_name === "ft_balance_of" ? String(h[String(p.account_id)]?.[args.account_id] ?? 0n) : p.method_name === "ft_metadata" ? { decimals: 18 } : null;
      return { result: { result: [...Buffer.from(JSON.stringify(v))] } };
    },
  });
  return [one(NEAR_NETWORKS.mainnet.fastnear[0], held), one(NEAR_NETWORKS.mainnet.drpc, b ?? held)];
}

function pageOf(v: { w: WalletStore; ns: NoteStore }, rpcs: readonly [NearRpc, NearRpc], log: string[] = []): NearBuyPage {
  return {
    network: NETWORK,
    store: async () => v.w,
    notes: async () => v.ns,
    seed64: async () => Uint8Array.from(SEED),
    seedLock: (fn) => fn(),
    fee: async () => 20_000n,
    handoff: null,
    settle: async () => ({ outcomes: {} }),
    rpcs: () => rpcs,
    pools: async () => [],
    wait: async () => {},
    log: (line) => void log.push(line),
  };
}
const records = async (w: WalletStore): Promise<NearBuyRecord[]> =>
  (await Promise.all((await w.keys("quotes")).filter((k) => k.startsWith(NEAR_BUY_KEY)).map(async (k) => nearBuyRecordOf(await w.get("quotes", k))))).filter((r): r is NearBuyRecord => r !== undefined);

test("a: after a sign out, a W holding its token comes back as a position at the payout's cost, and the sell takes that W", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  const page = pageOf(v, providers({ [TOKEN]: { [W]: 7n * 10n ** 18n }, [USDC]: { [W]: 0n } }));
  assert.deepEqual(await nearPositions(page), [], "the store holds no record: nothing shows (the strand)");
  const p = await nearHoldingsPass(page, { spends: async () => [row(v.ws[0]!.nh, W)], hints: async () => [TOKEN] });
  assert.deepEqual(p, { written: [W], empty: [], unread: [] });
  const [r] = await records(v.w);
  assert.equal(r!.w, W);
  assert.equal(r!.token, TOKEN);
  assert.equal(r!.stage, "filled");
  assert.equal(r!.payout, "landed");
  assert.equal(r!.amount, PAID.toString(), "the cost: the vault's payout to W, from its spends row");
  assert.equal(r!.note, v.ws[0]!.note.id);
  assert.deepEqual(r!.fill, { out: (7n * 10n ** 18n).toString(), decimals: 18 });
  const pos = await nearPositions(page);
  assert.equal(pos.length, 1);
  assert.equal(pos[0]!.token, TOKEN);
  assert.equal(pos[0]!.amount, "7");
  assert.equal(pos[0]!.cost, "3");
  assert.deepEqual(pos[0]!.wallets, [W]);
  // the sell of the token takes the rebuilt W (W read as holding the token)
  const sp = { ...page, readWallet: async (a: { wallet: string; side: string }) => ({ account: a.wallet, height: 1, blockHash: "h", nonce: 1n, held: a.side === "sell" ? 7n * 10n ** 18n : 0n, registered: true, storageMin: 0n, lostfound: 0n }) };
  const d = sellDepsOf(sp, null, "sell-1", 100);
  const x = await d.wallet(TOKEN);
  d.release();
  assert.equal(x?.id, W);
});

test("a: a token the FT list leaves out is found from the store's other records; a hint is believed only when both providers read it", async () => {
  const v = await world([5_000_000n, 6_000_000n], [true, true]);
  const [A, B] = v.ws.map((x) => x.w);
  // a record of another W names the token (a buy this store still has)
  await v.w.put("quotes", `${NEAR_BUY_KEY}live`, { v: 1, id: "live", network: NETWORK, token: TOKEN, amount: "1000000", slippage_bps: 100, w: B, l: "1", j: 0, note: v.ws[1]!.note.id, fee: "0", created_ms: 1, resumes: 0, stage: "filled", step: "receive", txs: [], payout: "landed" });
  // the FT list names only a token W does not hold (both providers read 0): no holding from it
  const page = pageOf(v, providers({ [TOKEN]: { [A!]: 5n }, "fake.near": { [A!]: 0n } }));
  const p = await nearHoldingsPass(page, { spends: async () => v.ws.map((x) => row(x.nh, x.w)), hints: async () => ["fake.near"] });
  assert.deepEqual(p.written, [A], "A from the records' token; B has its record");
  const r = (await records(v.w)).find((x) => x.w === A)!;
  assert.equal(r.token, TOKEN);
  // a token held on one provider only is no holding
  const v2 = await world([5_000_000n], [true]);
  const W2 = v2.ws[0]!.w;
  const p2 = await nearHoldingsPass(pageOf(v2, providers({ [TOKEN]: { [W2]: 5n } }, { [TOKEN]: { [W2]: 4n } })), { spends: async () => [row(v2.ws[0]!.nh, W2)], hints: async () => [TOKEN] });
  assert.deepEqual(p2, { written: [], empty: [], unread: [W2] });
  assert.deepEqual(await records(v2.w), []);
});

test("b, c: a paid W holding only USDC (a swap that never ran, or a sale's USDC not yet home) gets a record past its resumes that no buy runs from and the load's sell pass takes home", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  const log: string[] = [];
  const page = pageOf(v, providers({ [USDC]: { [W]: 2_500_000n } }), log);
  const p = await nearHoldingsPass(page, { spends: async () => [row(v.ws[0]!.nh, W)], hints: async () => [USDC] });
  assert.deepEqual(p.written, [W]);
  const [r] = await records(v.w);
  assert.equal(r!.stage, "sent");
  assert.equal(r!.fill, undefined, "no position: it is cash on its way home");
  assert.equal(r!.token, NEAR_RHEA.mainnet.wrap);
  assert.equal(r!.resumes, NEAR_BUY_RESUMES);
  assert.deepEqual(await nearPositions(page), []);
  // no buy is run from it
  await resumeNearBuys(page);
  assert.ok(!log.some((l) => l.startsWith("near buy resumed")), "never taken up as a buy");
  assert.equal((await records(v.w))[0]!.stage, "sent");
});

test("c, a: USDC under the least deposit and no token: no record; kept as empty only when read so again ten minutes on, then never read again", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  const reads: string[] = [];
  let t = 1_000_000;
  const page = { ...pageOf(v, providers({ [USDC]: { [W]: 10n } }, undefined, reads)), now: () => t };
  let asked = 0;
  const pass = () => nearHoldingsPass(page, { spends: async () => (asked++, [row(v.ws[0]!.nh, W)]), hints: async () => [] });
  assert.deepEqual(await pass(), { written: [], empty: [], unread: [] });
  // a second load inside the FT list's lag: read again, not kept (a token bought moments ago may be unnamed yet)
  t += NEAR_HOLDINGS_EMPTY_AFTER_MS - 1;
  assert.deepEqual(await pass(), { written: [], empty: [], unread: [] });
  assert.deepEqual(((await v.w.get("quotes", `${NEAR_HOLDINGS_EMPTY_KEY}mainnet`)) as { final: string[] }).final, []);
  t += 1;
  assert.deepEqual(await pass(), { written: [], empty: [W], unread: [] });
  assert.deepEqual(await v.w.get("quotes", `${NEAR_HOLDINGS_EMPTY_KEY}mainnet`), { final: [W], first: {} });
  reads.length = 0;
  asked = 0;
  await pass();
  assert.equal(asked, 0, "no spends read for a W kept as empty");
  assert.deepEqual(reads, []);
});

test("a: a W read empty while the FT list lagged, then naming its token on the next load: the position shows", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  const held: Record<string, Record<string, bigint>> = { [USDC]: { [W]: 0n } };
  const page = pageOf(v, providers(held));
  let hints: string[] = [];
  const reads = { spends: async () => [row(v.ws[0]!.nh, W)], hints: async () => hints };
  assert.deepEqual(await nearHoldingsPass(page, reads), { written: [], empty: [], unread: [] });
  hints = [TOKEN];
  held[TOKEN] = { [W]: 77n };
  assert.deepEqual((await nearHoldingsPass(page, reads)).written, [W]);
  assert.equal((await nearPositions(page)).length, 1);
});

test("d: twice, or beside the store's own record of W: one record, the store's own never rewritten", async () => {
  const v = await world([5_000_000n, 6_000_000n], [true, true]);
  const [A, B] = v.ws.map((x) => x.w);
  const mine = { v: 1, id: "req-9", network: NETWORK, token: TOKEN, amount: "1", slippage_bps: 100, w: B, l: "1", j: 0, note: v.ws[1]!.note.id, fee: "0", created_ms: 1, resumes: 0, stage: "sent", step: "swap", txs: [], payout: "landed" };
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-9`, mine);
  const page = pageOf(v, providers({ [TOKEN]: { [A!]: 5n, [B!]: 5n } }));
  const reads = { spends: async () => v.ws.map((x) => row(x.nh, x.w)), hints: async () => [TOKEN] };
  const [p1, p2] = await Promise.all([nearHoldingsPass(page, reads), nearHoldingsPass(page, reads)]);
  assert.deepEqual([...p1.written, ...p2.written], [A], "A once, B never");
  const all = await records(v.w);
  assert.equal(all.length, 2);
  assert.deepEqual(await v.w.get("quotes", `${NEAR_BUY_KEY}req-9`), mine, "the store's own record as it was");
  assert.deepEqual((await nearHoldingsPass(page, reads)).written, []);
});

test("d: a live buy's record of W written while the pass reads: the pass writes nothing, the live one stands", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  const live = { v: 1, id: "req-live", network: NETWORK, token: TOKEN, amount: "1", slippage_bps: 100, w: W, l: "1", j: 0, note: v.ws[0]!.note.id, fee: "0", created_ms: 2, resumes: 0, stage: "sent", step: "swap", txs: [], payout: "landed" };
  const page = pageOf(v, providers({ [TOKEN]: { [W]: 5n } }));
  const reads = {
    spends: async () => [row(v.ws[0]!.nh, W)],
    hints: async () => (await v.w.put("quotes", `${NEAR_BUY_KEY}req-live`, live), [TOKEN]),
  };
  assert.deepEqual((await nearHoldingsPass(page, reads)).written, []);
  assert.deepEqual(await v.w.get("quotes", `${NEAR_BUY_KEY}req-live`), live);
  assert.equal(await v.w.get("quotes", `${NEAR_BUY_KEY}restored:${W}`), undefined);
});

test("d: a value under the rebuilt record's key that reads as no record is never overwritten", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  await v.w.put("quotes", `${NEAR_BUY_KEY}restored:${W}`, { kept: "as is" });
  const page = pageOf(v, providers({ [TOKEN]: { [W]: 5n } }));
  assert.deepEqual((await nearHoldingsPass(page, { spends: async () => [row(v.ws[0]!.nh, W)], hints: async () => [TOKEN] })).written, []);
  assert.deepEqual(await v.w.get("quotes", `${NEAR_BUY_KEY}restored:${W}`), { kept: "as is" });
});

test("e: a spends read that fails, a hint list that fails, a withdrawal to anyone else or one refunded: nothing invented, the pass never throws", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  const nh = v.ws[0]!.nh;
  const page = pageOf(v, providers({ [TOKEN]: { [W]: 5n } }));
  assert.deepEqual(await nearHoldingsPass(page, { spends: async () => Promise.reject(new Error("503")), hints: async () => [TOKEN] }), { written: [], empty: [], unread: ["spends"] });
  assert.deepEqual(await nearHoldingsPass(page, { spends: async () => [row(nh, W)], hints: async () => Promise.reject(new Error("503")) }), { written: [], empty: [], unread: [W] });
  // not on the list yet, or still moving: nothing written, nothing kept, read again on the next pass
  for (const rows of [[], [row(nh, W, { status: "refund_pending" })], [row(nh, W, { status: "in_flight" })]]) {
    assert.deepEqual(await nearHoldingsPass(page, { spends: async () => rows, hints: async () => [TOKEN] }), { written: [], empty: [], unread: [] });
  }
  assert.deepEqual(await records(v.w), []);
  assert.equal(await v.w.get("quotes", `${NEAR_HOLDINGS_EMPTY_KEY}mainnet`), undefined, "nothing kept as empty from a read that was not made");
});

test("e: a note's final spend that paid someone else, or was refunded, is no buy: no record, never read again", async () => {
  for (const r of [(nh: bigint) => row(nh, "someone.near"), (nh: bigint, w: string) => row(nh, w, { status: "settled", refundValue: 5n })]) {
    const v = await world([5_000_000n], [true]);
    const W = v.ws[0]!.w;
    const page = pageOf(v, providers({ [TOKEN]: { [W]: 5n } }));
    let asked = 0;
    const reads = { spends: async () => (asked++, [r(v.ws[0]!.nh, W)]), hints: async () => [TOKEN] };
    assert.deepEqual(await nearHoldingsPass(page, reads), { written: [], empty: [], unread: [] });
    assert.deepEqual(((await v.w.get("quotes", `${NEAR_HOLDINGS_EMPTY_KEY}mainnet`)) as { final: string[] }).final, [W]);
    await nearHoldingsPass(page, reads);
    assert.equal(asked, 1, "the spends list is not read again for it");
    assert.deepEqual(await records(v.w), []);
  }
});

test("the FT list's answer is hostile until shaped: another account's list, a row out of shape, too many rows, a redirect", async () => {
  const W = "a".repeat(64);
  const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await nearTokenHints("mainnet", W, answer({ account_id: W, tokens: [{ contract_id: TOKEN, balance: "1" }, { contract_id: TOKEN }] })), [TOKEN]);
  await assert.rejects(nearTokenHints("mainnet", W, answer({ account_id: "b".repeat(64), tokens: [] })));
  await assert.rejects(nearTokenHints("mainnet", W, answer({ account_id: W, tokens: [{ contract_id: "Not An Id" }] })));
  await assert.rejects(nearTokenHints("mainnet", W, answer({ account_id: W, tokens: Array.from({ length: 65 }, (_, k) => ({ contract_id: `t${k}.near` })) })));
  await assert.rejects(nearTokenHints("mainnet", W, answer({}, 500)));
  await assert.rejects(nearTokenHints("mainnet", "x.near", answer({ account_id: "x.near", tokens: [] })));
  let asked = "";
  await nearTokenHints("testnet", W, (async (u: string, init: RequestInit) => ((asked = `${u} ${init.redirect}`), new Response(JSON.stringify({ account_id: W, tokens: [] })))) as unknown as typeof fetch);
  assert.equal(asked, `https://test.api.fastnear.com/v1/account/${W}/ft error`);
});

test("the sign out, end to end in the page's own code: a buy's record, the store signed out, the same words in a new store, the load's pass: the position is back and its sell takes W", async () => {
  // device one: a buy of TOKEN whose payout landed and whose swap filled
  const a = await world([5_000_000n], [false]);
  const pa = pageOf(a, providers({}));
  const note = (await a.ns.list())[0]!;
  const W = nearSwapWallet(SEED, note.leaf!.label, jOf(note.ref)).id;
  const live = { ...pa, handoff: async () => (await a.ns.move(note.id, "UNSPENT", "SPENT"), { kind: "arrived", tx: "4".repeat(44) }) as never };
  const d = depsOf(live, null, "req-1");
  assert.ok(await d.begin({ token: TOKEN, amount: PAID, slippageBps: 100 }));
  assert.equal((await d.payout()).kind, "landed");
  await d.progress({ step: "receive", stage: "filled", txs: [], fill: { out: "7000000000000000000", decimals: 18 } });
  d.release();
  assert.equal((await nearPositions(pa)).length, 1);
  // signed out: the whole store goes
  a.ns.close();
  await a.w.signOut();
  // the same words on a new device: the restore writes the vault's notes (the note SPENT), no record
  const b = await world([5_000_000n], [true]);
  assert.equal(b.ws[0]!.w, W, "the same W from the same words");
  const log: string[] = [];
  const pb = pageOf(b, providers({ [TOKEN]: { [W]: 7n * 10n ** 18n } }), log);
  assert.deepEqual(await nearPositions(pb), []);
  await nearHoldingsPass(pb, { spends: async () => [row(b.ws[0]!.nh, W)], hints: async () => [TOKEN] });
  const pos = await nearPositions(pb);
  assert.equal(pos.length, 1);
  assert.equal(pos[0]!.amount, "7");
  // the sell: the kind takes W from the rebuilt record and records its sell before it reads on
  const sp = { ...pb, readWallet: async () => Promise.reject(new Error("no reads past the pick here")) };
  const r = nearSellKind(sp)({ token: TOKEN, slippageBps: 100 }, { id: "sell-1", sha: "00", progress: () => {} });
  assert.ok("running" in r);
  await r.after;
  const rec = (await records(b.w))[0]!;
  assert.equal(rec.sell?.id, "sell-1", "the sell took the rebuilt W");
  assert.ok(log.includes("near sell recorded"));
});

test("b: the load after the pass sends a USDC-only W's money home (resumeNearSells takes the rebuilt record)", async () => {
  const v = await world([5_000_000n], [true]);
  const W = v.ws[0]!.w;
  const log: string[] = [];
  const page = { ...pageOf(v, providers({ [USDC]: { [W]: 2_500_000n } }), log), readWallet: async (x: { wallet: string; side: string }) => ({ account: x.wallet, height: 1, blockHash: "h", nonce: 1n, held: x.side === "sell" ? 0n : 2_500_000n, registered: true, storageMin: 0n, lostfound: 0n }),
    // the move home is the wallet's bindDeposit, not run here: a pair that is no network's refuses it at once
    bindRpcs: () => [{ name: "x", query: async () => Promise.reject(new Error("no")) }, { name: "y", query: async () => Promise.reject(new Error("no")) }] as never };
  await nearHoldingsPass(page, { spends: async () => [row(v.ws[0]!.nh, W)], hints: async () => [] });
  await resumeNearSells(page).catch(() => {});
  assert.ok(log.includes("near sell recorded"), "the sell pass took it up on the load");
  assert.ok((await records(v.w))[0]!.sell !== undefined);
});
