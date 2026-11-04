// Card signpage-pool-withdraw-form: a pool withdraw sends exactly the typed amount to the typed address, each part one
// transaction (tag 2, then one transfer from W to To), proved on demand from a note of the pool, checked and signed on
// this page, RESERVED before it leaves, and sent only once every part read back on both RPCs (src/pool-withdraw.ts).
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
import { solanaPoolFee, solanaPoolPage, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { SOL_EPOCH_MS, SOL_LADDER, SOL_LIFE_MS, SOL_SEND_MARGIN_MS, SOL_TIP_CAP, solanaContextOf, solanaPoolOf, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { planPoolWithdraw, poolWithdrawable, runPoolWithdraw, solanaWithdrawMinPart, type PoolWithdrawHost } from "../src/pool-withdraw.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const { scope: SCOPE } = solanaPoolOf(PROGRAM);
const FEE = solanaPoolFee(rent);
const MIN = solanaWithdrawMinPart(rent);
const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
const SIG = base58.encode(new Uint8Array(64).fill(5));
const NOW = 1_800_000_000_000n + 1_000n;
const ASK: PoolAsk = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

test("the plan: the typed amount exactly, largest note first, each part at least the minimum, the fee on each part", () => {
  assert.equal(MIN, SOL_TIP_CAP + solanaRentMin(rent, 0));
  const notes = [{ id: "a", value: 10_000_000n }, { id: "b", value: 30_000_000n }, { id: "c", value: FEE + MIN - 1n }];
  // one note pays it: the largest
  assert.deepEqual(planPoolWithdraw(notes, 5_000_000n, FEE, MIN), [{ noteId: "b", part: 5_000_000n, chunk: 5_000_000n + FEE }]);
  // two notes: the largest gives all it can, the next the rest
  const two = planPoolWithdraw(notes, 30_000_000n, FEE, MIN)!;
  assert.deepEqual(two.map((p) => p.noteId), ["b", "a"]);
  assert.equal(two.reduce((t, p) => t + p.part, 0n), 30_000_000n);
  two.forEach((p) => assert.equal(p.chunk, p.part + FEE));
  // a remainder under the minimum moves back to the part before
  const tight = planPoolWithdraw(notes, 30_000_000n - FEE + 1n, FEE, MIN)!;
  assert.equal(tight.at(-1)!.part, MIN);
  assert.equal(tight.reduce((t, p) => t + p.part, 0n), 30_000_000n - FEE + 1n);
  // the most: every note that gives the minimum, less its fee; above it, or under the minimum, no plan
  const most = poolWithdrawable(notes, FEE, MIN);
  assert.equal(most, 40_000_000n - 2n * FEE);
  assert.notEqual(planPoolWithdraw(notes, most, FEE, MIN), null);
  assert.equal(planPoolWithdraw(notes, most + 1n, FEE, MIN), null);
  assert.equal(planPoolWithdraw(notes, MIN - 1n, FEE, MIN), null);
  assert.equal(planPoolWithdraw([], MIN, FEE, MIN), null);
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

type Plant = { helperFee?: bigint; readBack?: "ours" | "none"; landed?: boolean; to?: string };

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
  const binds: SolanaReleaseRequest[] = [];
  const pool: Pool<SolanaReleaseRequest> = {
    id: `sol:${PROGRAM}`, chain: "sol", scope: SCOPE, ladder: SOL_LADDER, epochMs: SOL_EPOCH_MS, lifeMs: SOL_LIFE_MS, sendMarginMs: SOL_SEND_MARGIN_MS,
    now: async () => NOW,
    trees: async () => ({ stateTree: tree(state), labelTree: tree(labels), stateRoot: tree(state).root!, labelRoot: tree(labels).root! }),
    // the wallet's solanaPool bind, with the helper's fee as planted (the real one refuses a fee not the device's)
    bind: async (b) => {
      const fee = plant.helperFee ?? FEE;
      const request: SolanaReleaseRequest = { program: PROGRAM, pool: POOL, recipient: b.wallet.address, feePayer: FEE_PAYER, relayFee: fee, relayFeeCap: fee, tipCap: SOL_TIP_CAP, deadlineMs: b.deadlineMs, salt: "00".repeat(16) };
      binds.push(request);
      return { context: solanaContextOf(request, SCOPE) % VAULT_FIELD_P, feeCap: fee, request };
    },
  };
  const sent: Uint8Array[] = [];
  const order: string[] = [];
  const rpc = (p: 0 | 1): SolanaRpc =>
    (async (method: string, params: readonly unknown[]) => {
      if (method === "getAccountInfo") {
        const k = params[0] as string;
        const acct = (owner: string, data: Uint8Array) => ({ context: { slot: 10 }, value: { owner, lamports: 1, data: [base64.encode(data), "base64"] } });
        if (k === fx.rent.account) return acct(fx.rent.answers[p].owner, base64.decode(fx.rent.answers[p].data));
        if (k === POOL) return acct(PROGRAM, poolAccount(state.length));
        if (k === solanaPoolPage(PROGRAM, 0, 0)) return acct(PROGRAM, page(rootsOf(state)));
        if (k === solanaPoolPage(PROGRAM, 1, 0)) return acct(PROGRAM, page(rootsOf(labels)));
        return { context: { slot: 10 }, value: null };
      }
      if (method === "getLatestBlockhash") return { context: { slot: 12 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
      if (method === "isBlockhashValid") return { value: true };
      if (method === "getBlockHeight") return (params[0] as { commitment: string }).commitment === "confirmed" ? 0 : 1_000;
      if (method === "getTransaction") {
        const last = sent.at(-1);
        if ((plant.readBack ?? "ours") === "none" || !last) return null;
        const tx = last.slice();
        tx.set(base58.decode(SIG), 1);
        return { transaction: [base64.encode(tx), "base64"], meta: { err: null } };
      }
      throw new Error(`unexpected ${method}`);
    }) as SolanaRpc;
  const stages: string[] = [];
  const host: PoolWithdrawHost = {
    pin: { program: PROGRAM, feePayer: FEE_PAYER },
    rpcs: [rpc(0), rpc(1)],
    pool,
    prover: signalsProver(),
    notes: async () => ns,
    seed64: async () => SEED64.slice(),
    send: async (_pool, tx) => {
      order.push(`send:${(await ns.list()).filter((n) => n.state === "RESERVED").length}`);
      sent.push(tx.slice());
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
    stage: (s) => void stages.push(s),
  };
  return { host, ns, ids, sent, order, stages, binds };
}

/** The transfer the wire carries after the release: [from, to, lamports]. */
function transferOf(wire: Uint8Array): [string, string, bigint] {
  const m = solanaDecodeMessage(wire.subarray(1 + 64 * wire[0]!));
  const keys = m.staticKeys;
  const t = m.instructions.at(-1)!;
  assert.equal(keys[t.programIndex], SOLANA_SYSTEM_PROGRAM);
  return [keys[t.accounts[0]!]!, keys[t.accounts[1]!]!, new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(4, true)];
}

test("a withdraw sends exactly the typed amount to To from one note: release + one transfer from W, RESERVED before the send, sent once read back", async () => {
  const wd = await world([30_000_000n]);
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN);
  assert.equal(a.stage, "sent");
  assert.deepEqual(a.txs, [{ chain: "solana", hash: SIG }]);
  assert.equal(wd.sent.length, 1);
  const [from, to, lamports] = transferOf(wd.sent[0]!);
  assert.equal(from, wd.binds[0]!.recipient, "from W, the release's recipient");
  assert.equal(to, TO);
  assert.equal(lamports, 2_000_000n + MIN, "exactly the typed amount arrives");
  assert.deepEqual(wd.order, ["send:1", `settle:${wd.ids[0]}`], "RESERVED before the transaction leaves");
  assert.equal(wd.stages[0], "proving");
  assert.equal(wd.stages.at(-1), "sent");
  // W signed slot 1; the fee payer's slot 0 is the helper's
  assert.ok(wd.sent[0]!.subarray(65, 129).some((b) => b !== 0));
  assert.ok(wd.sent[0]!.subarray(1, 65).every((b) => b === 0));
});

test("a withdraw over two notes: two transactions, the largest note first, the parts summing to the amount", async () => {
  const wd = await world([10_000_000n, 30_000_000n]);
  const amount = 35_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount);
  assert.equal(a.stage, "sent");
  assert.equal(wd.sent.length, 2);
  const parts = wd.sent.map(transferOf);
  assert.equal(parts[0]![2], 30_000_000n - FEE);
  assert.equal(parts[0]![2] + parts[1]![2], amount);
  parts.forEach((p) => assert.equal(p[1], TO));
  assert.notEqual(parts[0]![0], parts[1]![0], "each note's own W");
});

test("refused before anything is sent: a helper fee not the device's, an amount over the notes, the note left UNSPENT", async () => {
  for (const [values, amount, plant] of [
    [[30_000_000n], 5_000_000n, { helperFee: FEE + 100_000n }],
    [[30_000_000n], 30_000_000n, {}],
  ] as const) {
    const wd = await world(values, plant);
    const a = await runPoolWithdraw(wd.host, ASK, TO, amount);
    assert.equal(a.stage, "stopped");
    assert.equal(wd.sent.length, 0);
    assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT"]);
  }
  // refused by the rule after the note was held and proved (To is the fee payer: a signer, never a transfer's
  // destination): nothing sent, and the note freed back to UNSPENT for the proof queue
  {
    const wd = await world([30_000_000n]);
    assert.equal((await runPoolWithdraw(wd.host, ASK, FEE_PAYER, 5_000_000n)).stage, "stopped");
    assert.equal(wd.sent.length, 0);
    assert.equal(wd.binds.length, 1, "it was bound and held before the rule refused it");
    assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT"]);
  }
  // another kind or chain is never run
  const wd = await world([30_000_000n]);
  assert.equal((await runPoolWithdraw(wd.host, { ...ASK, kind: "pool.buy" }, TO, 5_000_000n)).stage, "stopped");
  assert.equal(wd.sent.length, 0);
});

test("a send that does not read back is submitted, never sent; the note stays RESERVED for the state reads", async () => {
  const wd = await world([30_000_000n], { readBack: "none" });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n);
  assert.notEqual(a.stage, "sent");
  assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["RESERVED"]);
});
