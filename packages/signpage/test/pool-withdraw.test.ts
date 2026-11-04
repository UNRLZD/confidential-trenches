// Card signpage-pool-withdraw-form: a pool withdraw sends exactly the typed amount to the typed address, each part two
// transactions (the release alone to W, then W's own transfer of all it holds less its fee to To), proved on demand
// from a note of the pool, checked and signed on this page, RESERVED before the release leaves, and sent only once
// every part's onward send read back on both RPCs (src/pool-withdraw.ts).
// The seed is the published all-zero entropy vector (packages/wallet/test/vectors/a8.json); the Rent sysvar is the
// kit's recorded answer of both providers (packages/kit/test/fixtures/solana-pool-buy.json).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { solanaDecodePoolRelease, solanaPoolFee, solanaPoolPage, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { SOL_EPOCH_MS, SOL_LADDER, SOL_LIFE_MS, SOL_SEND_MARGIN_MS, solanaContextOf, solanaPoolOf, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { finishPoolOnward, nearestPlannable, planPoolWithdraw, poolWithdrawable, runPoolWithdraw, solanaWithdrawMinPart, withdrawNoteFloor, type PoolWithdrawHost, type WithdrawCosts } from "../src/pool-withdraw.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const { scope: SCOPE } = solanaPoolOf(PROGRAM);
const FEE = solanaPoolFee(rent);
const W_FEE = 5_000n;
const MIN = solanaWithdrawMinPart(rent, FEE, W_FEE);
const C: WithdrawCosts = { fee: FEE, wFee: W_FEE, minPart: MIN };
const FLOOR = withdrawNoteFloor(C);
const COST = FEE + W_FEE;
const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
const SIG = base58.encode(new Uint8Array(64).fill(5));
const NOW = 1_800_000_000_000n + 1_000n;
const ASK: PoolAsk = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

test("the min part: rent(0), and the relay fee less W's fee where that is more (the 2 x fee backstop); no tip cap", () => {
  const r0 = solanaRentMin(rent, 0);
  assert.equal(MIN, FEE - W_FEE > r0 ? FEE - W_FEE : r0);
  assert.equal(solanaWithdrawMinPart(rent, 0n, 0n), r0);
  assert.equal(solanaWithdrawMinPart(rent, r0 + 10n * W_FEE, W_FEE), r0 + 9n * W_FEE);
});

test("the plan: the typed amount exactly, the fewest parts, each part at least the minimum, each chunk part + fee + W's fee", () => {
  const notes = [{ id: "a", value: 10_000_000n }, { id: "b", value: 30_000_000n }, { id: "c", value: COST + MIN - 1n }];
  // one note pays it: the largest
  assert.deepEqual(planPoolWithdraw(notes, 5_000_000n, C), [{ noteId: "b", part: 5_000_000n, chunk: 5_000_000n + COST }]);
  // two notes: one gives all it can, the other the rest, the sum exact
  const two = planPoolWithdraw(notes, 30_000_000n, C)!;
  assert.deepEqual(two.map((p) => p.noteId).sort(), ["a", "b"]);
  assert.equal(two.reduce((t, p) => t + p.part, 0n), 30_000_000n);
  two.forEach((p) => assert.equal(p.chunk, p.part + COST));
  // the most: every note that gives the minimum, less its two fees; above it, or under the minimum, no plan
  const most = poolWithdrawable(notes, C);
  assert.equal(most, 40_000_000n - 2n * COST);
  assert.notEqual(planPoolWithdraw(notes, most, C), null);
  assert.equal(planPoolWithdraw(notes, most + 1n, C), null);
  assert.equal(planPoolWithdraw(notes, MIN - 1n, C), null);
  assert.equal(planPoolWithdraw([], MIN, C), null);
});

// review #232 HIGH 2: a part that leaves 0 < change < the note floor strands that change in the pool for good
test("the plan never leaves a change between 0 and the note floor: across every amount near a note's top", () => {
  const value = 10_000_000n;
  const cap = value - COST;
  const notes = [{ id: "a", value }];
  for (let amount = cap - FLOOR - 3n; amount <= cap; amount += 1n) {
    const plan = planPoolWithdraw(notes, amount, C);
    const ok = amount === cap || amount <= cap - FLOOR;
    assert.equal(plan !== null, ok, String(amount));
    for (const p of plan ?? []) {
      const change = value - p.chunk;
      assert.ok(change === 0n || change >= FLOOR, `change ${change}`);
    }
  }
  // the one the review found: one lamport under the note's whole withdrawable; refused, the nearest named
  assert.equal(planPoolWithdraw(notes, cap - 1n, C), null);
  assert.deepEqual(nearestPlannable(notes, cap - 1n, C), { below: cap - FLOOR, above: cap });
});

// review #232 LOW: an exact plan where one exists, never the largest-first walk's dead end
test("the plan finds an exact plan the largest-first walk misses, and names the nearest when none exists", () => {
  const u = MIN;
  assert.ok(u < FLOOR, "a unit under the note floor: a change of one unit is dust");
  // [4u, 3u, 3u]: largest first takes 4u, then 2u of a 3u note leaves u of dust; 3u + 3u is exact
  const notes = [{ id: "a", value: 4n * u + COST }, { id: "b", value: 3n * u + COST }, { id: "c", value: 3n * u + COST }];
  const plan = planPoolWithdraw(notes, 6n * u, C)!;
  assert.deepEqual(plan.map((p) => [p.noteId, p.part]), [["b", 3n * u], ["c", 3n * u]]);
  // the review's [5u, u, u] at 6.5u: 4.5u of the 5u note leaves 0.5u, dust under the floor; u notes go whole or not
  // at all; so no plan sends 6.5u without dust, and the nearest each side are named, each one plannable
  const five = [{ id: "a", value: 5n * u + COST }, { id: "b", value: u + COST }, { id: "c", value: u + COST }];
  const amount = (13n * u) / 2n;
  assert.equal(planPoolWithdraw(five, amount, C), null);
  const near = nearestPlannable(five, amount, C);
  assert.ok(near.below! < amount && near.above! > amount);
  for (const x of [near.below!, near.above!]) {
    const p = planPoolWithdraw(five, x, C)!;
    assert.equal(p.reduce((t, q) => t + q.part, 0n), x);
  }
  assert.deepEqual(near, { below: 6n * u, above: 7n * u }, "the 5u note whole with one u note, or with both");
});

// ---------- the run ----------

const b32 = (x: bigint): number[] => [...Buffer.from(x.toString(16).padStart(64, "0"), "hex")];
const page = (roots: readonly bigint[]): Uint8Array => {
  const d = new Uint8Array(16 + roots.length * 72);
  roots.forEach((r, i) => d.set(b32(r), 16 + i * 72 + 32));
  return d;
};
const poolAccount = (size: number): Uint8Array => {
  const d = new Uint8Array(2179);
  d.set(new TextEncoder().encode("bfpool01"));
  const v = new DataView(d.buffer);
  v.setBigUint64(49, BigInt(size), true);
  v.setBigUint64(49 + 8 + 1 + 33 * 32, BigInt(size), true);
  return d;
};

type Plant = { helperFee?: bigint; readBack?: "ours" | "none"; landed?: boolean; onward?: "ok" | "drop"; toAccount?: { owner: string; executable: boolean } };

async function world(values: readonly bigint[], plant: Plant = {}) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns: NoteStore = await openNoteStore(w);
  closers.push(() => ns.close());
  // each note a landed deposit of the pool: its leaves on both trees
  const state: bigint[] = [];
  const labels: bigint[] = [];
  const ids: string[] = [];
  for (const value of values) {
    const planned = await ns.planDeposit(SCOPE, (r) => noteSecrets(SEED64, r).precommitment);
    const inc = await ns.move(planned.id, "PLANNED", "INCOMING", { send: { signature: base58.encode(new Uint8Array(64).fill(9 + ids.length)), value, last_valid_block_height: 1_000n } });
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(labels.length + 1));
    const commitment = noteCommitment(value, label, inc.precommitment);
    state.push(commitment);
    labels.push(label);
    await ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(state.length - 1) } });
    ids.push(inc.id);
  }
  const tree = (xs: bigint[]) => new VaultTree(xs);
  const rootsOf = (xs: bigint[]) => xs.map((_, i) => tree(xs.slice(0, i + 1)).root!);
  const binds: (SolanaReleaseRequest & { chunk: bigint })[] = [];
  const pool: Pool<SolanaReleaseRequest> = {
    id: `sol:${PROGRAM}`, chain: "sol", scope: SCOPE, ladder: SOL_LADDER, epochMs: SOL_EPOCH_MS, lifeMs: SOL_LIFE_MS, sendMarginMs: SOL_SEND_MARGIN_MS,
    now: async () => NOW,
    trees: async () => ({ stateTree: tree(state), labelTree: tree(labels), stateRoot: tree(state).root!, labelRoot: tree(labels).root! }),
    // the wallet's solanaPool bind, with the helper's fee as planted (the real one refuses a fee not the device's)
    bind: async (b) => {
      const fee = plant.helperFee ?? FEE;
      const request: SolanaReleaseRequest = { program: PROGRAM, pool: POOL, recipient: b.wallet.address, feePayer: FEE_PAYER, relayFee: fee, relayFeeCap: fee, tipCap: b.tipCap!, deadlineMs: b.deadlineMs, salt: "00".repeat(16) };
      binds.push({ ...request, chunk: b.chunk });
      return { context: solanaContextOf(request, SCOPE) % VAULT_FIELD_P, feeCap: fee, request };
    },
  };
  // the chain: lamports by account; the helper's releases and W's onward sends, each read back by its signature
  const balance = new Map<string, bigint>();
  const add = (k: string, v: bigint) => balance.set(k, (balance.get(k) ?? 0n) + v);
  const releases: Uint8Array[] = [];
  const onwards = new Map<string, Uint8Array>();
  const order: string[] = [];
  const keysOf = (wire: Uint8Array) => solanaDecodeMessage(wire.subarray(1 + 64 * wire[0]!));
  const rpc = (p: 0 | 1): SolanaRpc =>
    (async (method: string, params: readonly unknown[]) => {
      if (method === "getAccountInfo") {
        const k = params[0] as string;
        const acct = (owner: string, data: Uint8Array) => ({ context: { slot: 10 }, value: { owner, lamports: 1, executable: false, data: [base64.encode(data), "base64"] } });
        if (k === fx.rent.account) return acct(fx.rent.answers[p].owner, base64.decode(fx.rent.answers[p].data));
        if (k === POOL) return acct(PROGRAM, poolAccount(state.length));
        if (k === solanaPoolPage(PROGRAM, 0, 0)) return acct(PROGRAM, page(rootsOf(state)));
        if (k === solanaPoolPage(PROGRAM, 1, 0)) return acct(PROGRAM, page(rootsOf(labels)));
        if (k === TO && plant.toAccount) return { context: { slot: 10 }, value: { ...plant.toAccount, lamports: 1, data: ["", "base64"] } };
        return { context: { slot: 10 }, value: null };
      }
      if (method === "getLatestBlockhash") return { context: { slot: 12 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
      if (method === "isBlockhashValid") return { value: true };
      if (method === "getBlockHeight") return (params[0] as { commitment: string }).commitment === "confirmed" ? 0 : 1_000;
      if (method === "getFeeForMessage") return { context: { slot: 12 }, value: Number(W_FEE) };
      if (method === "getBalance") return { context: { slot: 12 }, value: Number(balance.get(params[0] as string) ?? 0n) };
      if (method === "sendTransaction") {
        const wire = base64.decode(params[0] as string);
        const sig = base58.encode(wire.subarray(1, 65));
        if ((plant.onward ?? "ok") === "drop" || onwards.has(sig)) return sig;
        const m = keysOf(wire);
        const t = m.instructions[0]!;
        const [from, to] = [m.staticKeys[t.accounts[0]!]!, m.staticKeys[t.accounts[1]!]!];
        const v = new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(4, true);
        if ((balance.get(from) ?? 0n) < v + W_FEE) return sig;
        add(from, -(v + W_FEE));
        add(to, v);
        onwards.set(sig, wire.slice());
        return sig;
      }
      if (method === "getTransaction") {
        const sig = params[0] as string;
        const on = onwards.get(sig);
        if (on) return { transaction: [base64.encode(on), "base64"], meta: { err: null } };
        const last = releases.at(-1);
        if (sig !== SIG || (plant.readBack ?? "ours") === "none" || !last) return null;
        const tx = last.slice();
        tx.set(base58.decode(SIG), 1);
        return { transaction: [base64.encode(tx), "base64"], meta: { err: null } };
      }
      throw new Error(`unexpected ${method}`);
    }) as SolanaRpc;
  const stages: string[] = [];
  const pendings: unknown[] = [];
  const host: PoolWithdrawHost = {
    pin: { program: PROGRAM, feePayer: FEE_PAYER },
    rpcs: [rpc(0), rpc(1)],
    pool,
    prover: signalsProver(),
    notes: async () => ns,
    seed64: async () => SEED64.slice(),
    send: async (_pool, tx) => {
      order.push(`send:${(await ns.list()).filter((n) => n.state === "RESERVED").length}`);
      releases.push(tx.slice());
      if (plant.landed !== false && (plant.readBack ?? "ours") === "ours") {
        const m = keysOf(tx);
        const ix = m.instructions.at(-1)!;
        const r = solanaDecodePoolRelease(ix.data);
        add(m.staticKeys[ix.accounts[1]!]!, r.withdrawnValue - r.relayFee);
      }
      return { signature: SIG };
    },
    settle: async (noteId) => {
      if (plant.landed === false || (plant.readBack ?? "ours") === "none") return { kind: "unspent" };
      const n = await ns.get(noteId);
      if (n?.state === "RESERVED") order.push(`settle:${noteId}`);
      return { kind: "spent" };
    },
    now: () => NOW,
    reads: 2,
    wait: async () => {},
    stage: (s, _txs, pending) => void (stages.push(s), pendings.push(pending)),
  };
  return { host, ns, ids, releases, onwards: () => [...onwards.values()], balance, order, stages, pendings, binds, plant };
}

/** A wire's signers and instructions, as keys: [signers, [program, accounts, data][]]. */
function read(wire: Uint8Array): { signers: string[]; ixs: { program: string; accounts: string[]; data: Uint8Array }[] } {
  const m = solanaDecodeMessage(wire.subarray(1 + 64 * wire[0]!));
  const k = m.staticKeys;
  return { signers: k.slice(0, wire[0]!), ixs: m.instructions.map((x) => ({ program: k[x.programIndex]!, accounts: x.accounts.map((i) => k[i]!), data: x.data })) };
}
const lamportsOf = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset).getBigUint64(4, true);

test("a withdraw sends exactly the typed amount to To from one note: the release alone to W, then W's own send of all it holds, W at 0", async () => {
  const wd = await world([30_000_000n]);
  const amount = 2_000_000n + MIN;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  assert.equal(a.stage, "sent");
  assert.equal(a.pending, null);
  assert.equal(wd.releases.length, 1);
  assert.equal(wd.onwards().length, 1);
  const W = wd.binds[0]!.recipient;
  // review #232 HIGH 1: the fee payer's transaction is the release alone (after its compute limit), tip cap 0
  const rel = read(wd.releases[0]!);
  assert.deepEqual(rel.signers, [FEE_PAYER, W]);
  assert.deepEqual(rel.ixs.map((x) => x.program), ["ComputeBudget111111111111111111111111111111", PROGRAM]);
  assert.equal(wd.binds[0]!.tipCap, 0n);
  assert.equal(wd.binds[0]!.chunk, amount + COST);
  // W's own send: W the only signer and fee payer, one transfer of all it holds less its fee, to To
  const on = read(wd.onwards()[0]!);
  assert.deepEqual(on.signers, [W]);
  assert.equal(on.ixs.length, 1);
  assert.equal(on.ixs[0]!.program, SOLANA_SYSTEM_PROGRAM);
  assert.deepEqual(on.ixs[0]!.accounts, [W, TO]);
  assert.equal(lamportsOf(on.ixs[0]!.data), amount, "exactly the typed amount arrives");
  assert.equal(wd.balance.get(TO), amount);
  assert.equal(wd.balance.get(W), 0n, "W ends at 0");
  assert.deepEqual(a.txs, [{ chain: "solana", hash: SIG }, { chain: "solana", hash: base58.encode(wd.onwards()[0]!.subarray(1, 65)) }]);
  assert.deepEqual(wd.order, ["send:1", `settle:${wd.ids[0]}`], "RESERVED before the release leaves");
  assert.deepEqual([wd.stages[0], wd.stages.includes("in_transit"), wd.stages.at(-1)], ["proving", true, "sent"]);
  // W signed the release's slot 1; the fee payer's slot 0 is the helper's
  assert.ok(wd.releases[0]!.subarray(65, 129).some((b) => b !== 0));
  assert.ok(wd.releases[0]!.subarray(1, 65).every((b) => b === 0));
});

test("a withdraw over two notes: two releases and two onward sends, each note its own W, the parts summing to the amount", async () => {
  const wd = await world([10_000_000n, 30_000_000n]);
  const amount = 33_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, 2n * COST);
  assert.equal(a.stage, "sent");
  assert.equal(wd.releases.length, 2);
  const ons = wd.onwards().map(read);
  assert.equal(ons.length, 2);
  assert.equal(ons.reduce((t, o) => t + lamportsOf(o.ixs[0]!.data), 0n), amount);
  assert.notEqual(ons[0]!.signers[0], ons[1]!.signers[0], "each note's own W");
  assert.equal(wd.balance.get(TO), amount);
  for (const o of ons) assert.equal(wd.balance.get(o.signers[0]!), 0n);
  assert.equal(a.txs.length, 4);
});

// review #232 MEDIUM 1: the Max fee the screen drew is a bound the run keeps
test("a plan that costs more than the Max fee drawn stops before its first part: nothing bound, nothing sent", async () => {
  const wd = await world([10_000_000n, 30_000_000n]);
  assert.equal(planPoolWithdraw([{ id: "a", value: 10_000_000n }, { id: "b", value: 30_000_000n }], 33_000_000n, C)!.length, 2);
  const a = await runPoolWithdraw(wd.host, ASK, TO, 33_000_000n, 2n * COST - 1n);
  assert.equal(a.stage, "stopped");
  assert.equal(wd.binds.length, 0);
  assert.equal(wd.releases.length, 0);
  assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT", "UNSPENT"]);
});

test("refused before anything is sent: a helper fee not the device's, an amount over the notes or one no plan sends without dust", async () => {
  for (const [values, amount, plant] of [
    [[30_000_000n], 5_000_000n, { helperFee: FEE + 100_000n }],
    [[30_000_000n], 30_000_000n, {}],
    [[30_000_000n], 30_000_000n - COST - 1n, {}],
  ] as const) {
    const wd = await world(values, plant);
    const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
    assert.equal(a.stage, "stopped");
    assert.equal(wd.releases.length, 0);
    assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT"]);
  }
  // another kind or chain is never run
  const wd = await world([30_000_000n]);
  assert.equal((await runPoolWithdraw(wd.host, { ...ASK, kind: "pool.buy" }, TO, 5_000_000n, COST)).stage, "stopped");
  assert.equal(wd.releases.length, 0);
});

// review #232 LOW: To is never the pool's own account nor executable, checked before any note moves
test("To that is the fee payer, the pool, its program, System, an executable account or one the pool program owns: stopped before the bind", async () => {
  for (const [to, toAccount] of [
    [FEE_PAYER, undefined],
    [POOL, undefined],
    [PROGRAM, undefined],
    [SOLANA_SYSTEM_PROGRAM, undefined],
    [TO, { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }],
    [TO, { owner: PROGRAM, executable: false }],
  ] as const) {
    const wd = await world([30_000_000n], toAccount ? { toAccount } : {});
    assert.equal((await runPoolWithdraw(wd.host, ASK, to, 5_000_000n, COST)).stage, "stopped", to);
    assert.equal(wd.binds.length, 0, to);
    assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT"]);
  }
  // an account with lamports the System program owns (a wallet) is a To
  const wd = await world([30_000_000n], { toAccount: { owner: SOLANA_SYSTEM_PROGRAM, executable: false } });
  assert.equal((await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST)).stage, "sent");
});

test("a release that does not read back is never sent; the note stays RESERVED for the state reads, nothing sent on", async () => {
  const wd = await world([30_000_000n], { readBack: "none" });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  assert.notEqual(a.stage, "sent");
  assert.notEqual(a.stage, "in_transit");
  assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["RESERVED"]);
  assert.equal(wd.onwards().length, 0);
});

test("an onward send that never lands leaves the part on W, in_transit and owed; the state reads' finish sends it, once", async () => {
  const wd = await world([30_000_000n], { onward: "drop" });
  const amount = 5_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  assert.equal(a.stage, "in_transit");
  const W = wd.binds[0]!.recipient;
  assert.equal(wd.balance.get(W), amount + W_FEE, "the part and W's fee on W");
  assert.ok(a.pending && a.pending.to === TO && a.pending.last === true);
  assert.deepEqual(wd.pendings.at(-1), a.pending, "the op record carries what is owed");
  // a page reload: the state reads' pass finds it and sends it on
  wd.plant.onward = "ok";
  const done = await finishPoolOnward(wd.host, a.pending!);
  assert.equal(done?.stage, "sent");
  assert.equal(done?.txs.length, 1);
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount);
  // again (two tabs, or a second read): W holds 0, nothing sent, the op sent
  assert.deepEqual(await finishPoolOnward(wd.host, a.pending!), { stage: "sent", txs: [] });
  assert.equal(wd.onwards().length, 1);
});
