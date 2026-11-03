// pool.deposit on the Solana pool (src/pool-deposit.ts; card signpage-pool-notes), on the devnet pool's recorded answers
// (fixtures/pool-devnet.json, both devnet RPCs at finalized: the pool account, page 0 of each tree and the deploy run's
// mark). A sent deposit is applied here as the program applies it (contracts/pool-solana/src/deposit.rs: nonce + 1, the
// label keccak256(scope ‖ nonce) mod p, the commitment Poseidon(value, label, precommitment), one leaf on each tree's
// page, the 17-byte mark), only once its signature by U verifies. The note store is the wallet's own on fake-indexeddb,
// the seed the published all-zero entropy vector.
//   node --test test/pool-deposit.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { depositId, entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { solanaPoolOf, SOL_POOLS } from "../../wallet/src/pool/solana.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import { solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { runPoolDeposit, type PoolDepositHost } from "../src/pool-deposit.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

type Acc = { owner: string; lamports: number; data: Uint8Array };
const FIX = JSON.parse(readFileSync(new URL("./fixtures/pool-devnet.json", import.meta.url), "utf8")) as {
  program: string;
  pool: string;
  addresses: Record<"pool" | "state0" | "label0" | "mark", string>;
  answers: { rpc: string; slot: number; accounts: Record<string, { owner: string; lamports: number; data: [string, string] } | null> }[];
};
const PIN = { program: FIX.program, feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
const { scope: SCOPE } = solanaPoolOf(FIX.program);
const ENTROPY = () => new Uint8Array(16); // the published all-zero vector (packages/wallet/test/vectors/a8.json)
const SEED64 = wordsToSeed64(entropyToWords(ENTROPY()));
const U = (i: number): string => {
  const u = depositId(SEED64, SCOPE, i);
  u.secretKey.fill(0);
  return base58.encode(u.publicKey);
};
const RUNG = 10_000_000n; // 0.01 SOL, SOL_LADDER.min
const ask = (amount: bigint): PoolAsk => ({ kind: "pool.deposit", chain: "solana", token: null, amount, slippageBps: 0, decimals: 9 });
const enc = new TextEncoder();
const be32 = (x: bigint): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => Number((x >> BigInt(8 * (31 - i))) & 255n));
const beInt = (b: Uint8Array): bigint => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const page = (tree: 0 | 1, n: number): string => solanaProgramAddress([enc.encode("page"), Uint8Array.of(tree), Uint8Array.of(n & 255, (n >> 8) & 255, 0, 0)], FIX.program);

test("the fixture is the devnet pool both RPCs gave, and the testnet pin is its program", () => {
  assert.equal(SOL_POOLS.devnet, undefined, "the test build carries no pin; the testnet build's is checked in pool-testnet.test.ts");
  assert.equal(solanaPoolOf(FIX.program).pool, FIX.pool);
  const [a, b] = FIX.answers;
  assert.deepEqual(a!.accounts, b!.accounts);
  assert.equal(base64.decode(a!.accounts.pool!.data[0]).length, 2179);
});

/** One chain: the recorded accounts, the program's deposit applied to a signed tx. `rpc(k)` answers as RPC k, with `over`. */
function chain() {
  const accounts = new Map<string, Acc>();
  for (const [k, v] of Object.entries(FIX.answers[0]!.accounts)) if (v) accounts.set(FIX.addresses[k as keyof typeof FIX.addresses], { owner: v.owner, lamports: v.lamports, data: base64.decode(v.data[0]) });
  let slot = FIX.answers[0]!.slot;
  const sent: string[] = [];
  const c = {
    accounts,
    sent,
    /** whether a sent deposit lands */
    lands: true,
    /** a lying pair: the state leaf written is not the deposit's */
    wrongLeaf: false,
    /** a lying pair: the label leaf written is not keccak256(scope ‖ nonce) mod p */
    wrongLabel: false,
    /** a lying pair: the mark and both leaves say one lamport more than the tx deposited */
    moreValue: false,
    fund(address: string, lamports: number) {
      accounts.set(address, { owner: "11111111111111111111111111111111", lamports, data: new Uint8Array(0) });
    },
    apply(tx: Uint8Array) {
      const sigs = tx[0]!;
      const message = tx.subarray(1 + 64 * sigs);
      const m = solanaDecodeMessage(message);
      const signer = m.staticKeys[0]!;
      if (!ed25519.verify(tx.subarray(1, 65), message, base58.decode(signer))) throw new Error("signature");
      const ix = m.instructions[0]!;
      const keys = ix.accounts.map((i) => m.staticKeys[i]!);
      if (m.staticKeys[ix.programIndex] !== FIX.program || ix.data[0] !== 1 || keys[0] !== FIX.pool || keys[1] !== signer) throw new Error("not a deposit into the pool");
      const value = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
      const pre = beInt(ix.data.subarray(9, 41));
      const mark = solanaProgramAddress([enc.encode("pre"), be32(pre)], FIX.program);
      if (accounts.has(mark)) throw new Error("the mark exists: AccountAlreadyInUse");
      const u = accounts.get(signer);
      if (!u || BigInt(u.lamports) < value) throw new Error("insufficient lamports");
      if (!c.lands) return;
      const pool = accounts.get(FIX.pool)!.data;
      const dv = new DataView(pool.buffer, pool.byteOffset);
      const nonce = dv.getBigUint64(9, true) + 1n;
      const stateSize = Number(dv.getBigUint64(49, true));
      const labelSize = Number(dv.getBigUint64(49 + 1065, true));
      if (keys[2] !== page(0, Math.floor(stateSize / 1024)) || keys[3] !== page(1, Math.floor(labelSize / 1024))) throw new Error("page");
      const label = vaultLabelOf(keccak_256, SCOPE, nonce);
      const said = c.moreValue ? value + 1n : value;
      const commitment = c.wrongLeaf ? 7n : noteCommitment(said, label, pre);
      for (const [tree, leaf] of [[0, commitment], [1, c.wrongLabel ? 9n : label]] as const) {
        const at = tree === 0 ? keys[2]! : keys[3]!;
        const pg = accounts.get(at)!;
        const last = pg.data.subarray(pg.data.length - 72);
        const entry = new Uint8Array(72);
        entry.set(be32(leaf), 0);
        new DataView(entry.buffer).setBigInt64(64, new DataView(last.buffer, last.byteOffset + 64, 8).getBigInt64(0, true) + 1n, true);
        const data = new Uint8Array(pg.data.length + 72);
        data.set(pg.data);
        data.set(entry, pg.data.length);
        accounts.set(at, { ...pg, data });
      }
      dv.setBigUint64(9, nonce, true);
      dv.setBigUint64(49, BigInt(stateSize + 1), true);
      dv.setBigUint64(49 + 1065, BigInt(labelSize + 1), true);
      const md = new Uint8Array(17);
      new DataView(md.buffer).setBigUint64(0, said, true);
      new DataView(md.buffer).setBigUint64(8, nonce, true);
      md[16] = 1;
      accounts.set(mark, { owner: FIX.program, lamports: 1_009_200, data: md });
      u.lamports -= Number(value) + 5000;
      slot += 40;
    },
    rpc(over: { hide?: (address: string) => boolean } = {}) {
      const answer = (address: string) => {
        const a = over.hide?.(address) ? undefined : accounts.get(address);
        return a ? { owner: a.owner, lamports: a.lamports, data: [base64.encode(a.data), "base64"], executable: false, rentEpoch: 0, space: a.data.length } : null;
      };
      return async (method: string, params: readonly unknown[]): Promise<unknown> => {
        const ctx = { context: { slot } };
        switch (method) {
          case "getAccountInfo":
            return { ...ctx, value: answer(params[0] as string) };
          case "getMultipleAccounts":
            return { ...ctx, value: (params[0] as string[]).map(answer) };
          case "getLatestBlockhash":
            // a new blockhash each slot, as the chain gives
            return { ...ctx, value: { blockhash: base58.encode(be32(BigInt(++slot))), lastValidBlockHeight: 1 } };
          case "sendTransaction": {
            const tx = base64.decode(params[0] as string);
            const sig = base58.encode(tx.subarray(1, 65));
            if (!sent.includes(sig)) {
              c.apply(tx);
              sent.push(sig);
            }
            return sig;
          }
          default:
            throw new Error(`no fixture for ${method}`);
        }
      };
    },
  };
  return c;
}

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function notes(): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return ns;
}
function host(c: ReturnType<typeof chain>, ns: NoteStore, over: Partial<PoolDepositHost> = {}): PoolDepositHost & { landedNotes: NoteRecord[]; seeds: Uint8Array[] } {
  const landedNotes: NoteRecord[] = [];
  const seeds: Uint8Array[] = [];
  return {
    pin: PIN,
    rpcs: [c.rpc(), c.rpc()],
    notes: async () => ns,
    seed64: async () => {
      const s = SEED64.slice();
      seeds.push(s);
      return s;
    },
    landed: (n) => landedNotes.push(n),
    reads: 3,
    wait: async () => {},
    landedNotes,
    seeds,
    ...over,
  };
}
const ours = async (ns: NoteStore) => (await ns.list()).filter((n) => n.scope === SCOPE);
/** U of the index the store plans for the pool's scope (its lane is the device's, drawn at random). */
const plannedU = async (ns: NoteStore): Promise<{ i: number; address: string }> => {
  const n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED64, ref).precommitment);
  const i = (n.ref as { i: number }).i;
  return { i, address: U(i) };
};

test("a deposit for the pinned pool: U's tx lands, its note is stored UNSPENT with its devnet leaf, one proof starts", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const h = host(c, ns);
  const got = await runPoolDeposit(h, ask(RUNG));
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
  const [n, ...rest] = await ours(ns);
  assert.equal(rest.length, 0);
  assert.equal(n!.state, "UNSPENT");
  assert.equal(n!.ref.kind, "deposit");
  // the recorded pool held one deposit (nonce 1, leaf 0): this one is nonce 2, leaf 1
  const label = vaultLabelOf(keccak_256, SCOPE, 2n);
  const P = noteSecrets(SEED64, n!.ref).precommitment;
  assert.deepEqual(n!.leaf, { value: RUNG, label, commitment: noteCommitment(RUNG, label, P), leafIndex: 1n });
  assert.deepEqual(h.landedNotes.map((x) => x.id), [n!.id], "one proof started, for the landed note");
  assert.ok(h.seeds.every((s) => s.every((b) => b === 0)), "the seed is zeroed");
});

test("a move of three rungs' worth lands as the deposit note and its second arrivals, each after the one before", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const h = host(c, ns);
  const got = await runPoolDeposit(h, ask(35_000_000n)); // 0.02 + 0.01 + 0.005 left on U: below the smallest rung
  assert.equal((got as { stage: string }).stage, "filled");
  assert.equal(c.sent.length, 2);
  const all = (await ours(ns)).sort((x, y) => Number(x.leaf!.leafIndex - y.leaf!.leafIndex));
  assert.deepEqual(all.map((n) => [n.ref.kind, n.state, n.leaf?.value, n.leaf?.leafIndex]), [
    ["deposit", "UNSPENT", 20_000_000n, 1n],
    ["second", "UNSPENT", 10_000_000n, 2n],
  ]);
  assert.equal(h.landedNotes.length, 2);
});

test("another pool: a pin the RPCs hold no pool for, or a pool account another program owns, is refused before anything is signed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const other = { program: "11111111111111111111111111111112", feePayer: PIN.feePayer };
  assert.deepEqual(await runPoolDeposit(host(c, ns, { pin: other }), ask(RUNG)), { error: "not_allowed" });
  const pool = c.accounts.get(FIX.pool)!;
  c.accounts.set(FIX.pool, { ...pool, owner: "BPFLoaderUpgradeab1e11111111111111111111111" });
  const got = await runPoolDeposit(host(c, ns), ask(RUNG));
  assert.ok("error" in got);
  assert.equal(c.sent.length, 0, "nothing sent");
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["PLANNED"], "the planned note only: none INCOMING or UNSPENT");
});

test("a deposit that does not read back answers not_landed and its note stays INCOMING; the next run stores it once it lands", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  const h = host(c, ns);
  const got = await runPoolDeposit(h, ask(RUNG));
  assert.deepEqual(got, { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"]);
  assert.equal(h.landedNotes.length, 0, "no proof for a note that has not landed");
  // only one RPC holds the mark: still not read back
  c.lands = true;
  const one = host(c, ns, { rpcs: [c.rpc(), c.rpc({ hide: (a) => a !== FIX.pool && c.accounts.get(a)?.data.length === 17 })] });
  assert.equal(((await runPoolDeposit(one, ask(RUNG))) as { stage: string }).stage, "not_landed");
  assert.equal((await ours(ns)).filter((n) => n.state === "UNSPENT").length, 0);
  // both hold it: the next run settles the cut-short note first, then moves on to its own U (none funded here)
  const two = host(c, ns);
  assert.deepEqual(await runPoolDeposit(two, ask(RUNG)), { error: "not_funded" });
  assert.deepEqual((await ours(ns)).map((n) => n.state).sort(), ["PLANNED", "UNSPENT"]);
  assert.equal(two.landedNotes.length, 1);
  assert.equal(c.sent.length, 2, "the cut-short deposit sent again once; nothing for the unfunded U");
});

test("a note the tree does not hold is refused: the mark reads back but its commitment is not a state leaf", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.wrongLeaf = true;
  const h = host(c, ns);
  assert.deepEqual(await runPoolDeposit(h, ask(RUNG)), { error: "failed" });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"]);
  assert.equal(h.landedNotes.length, 0);
});

test("a label leaf that is not the deposit's nonce's, or a mark of another value than the rung sent, is refused", async () => {
  for (const lie of ["wrongLabel", "moreValue"] as const) {
    const c = chain();
    const ns = await notes();
    c.fund((await plannedU(ns)).address, 50_000_000);
    c[lie] = true;
    const h = host(c, ns);
    assert.deepEqual(await runPoolDeposit(h, ask(RUNG)), { error: "failed" }, lie);
    assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"], lie);
    assert.equal(h.landedNotes.length, 0, lie);
  }
});

test("U short of the move: not_funded, the note stays PLANNED on the same U and nothing is sent", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 5_000_000);
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { error: "not_funded" });
  assert.equal(c.sent.length, 0);
  assert.deepEqual((await ours(ns)).map((n) => [n.state, (n.ref as { i: number }).i]), [["PLANNED", u.i]]);
});
