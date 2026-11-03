// pool.deposit on the Solana pool (src/pool-deposit.ts; card signpage-pool-notes), on the devnet pool's recorded answers
// (fixtures/pool-devnet.json, both devnet RPCs at finalized: the pool account, page 0 of each tree, the deploy run's mark
// and the Rent sysvar). A sent deposit is applied here as the program and the runtime apply it
// (contracts/pool-solana/src/deposit.rs: nonce + 1, the label keccak256(scope ‖ nonce) mod p, the commitment
// Poseidon(value, label, precommitment), one leaf on each tree's page, the 17-byte mark; U pays the rung, the mark's rent,
// each page's growth and the fee, and must keep 0 or an empty account's rent), only once its signature by U verifies;
// a tx on a precommitment whose mark exists fails, its status an error. The note store is the wallet's own on
// fake-indexeddb, the seed the published all-zero entropy vector. The review's probes (A front-run, B unfunded costs,
// C a late landing, D a lying value) are tests here.
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
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { solanaPoolOf, SOL_POOLS } from "../../wallet/src/pool/solana.ts";
import { solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { solanaPoolPage } from "../../kit/src/trade/solana/pool-buy.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { poolDepositKind, runPoolDeposit, settlePoolDeposits, type PoolDepositHost } from "../src/pool-deposit.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

type Acc = { owner: string; lamports: number; data: Uint8Array };
const FIX = JSON.parse(readFileSync(new URL("./fixtures/pool-devnet.json", import.meta.url), "utf8")) as {
  program: string;
  pool: string;
  addresses: Record<"pool" | "state0" | "label0" | "mark" | "rent", string>;
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
// the recorded Rent sysvar: lamports per byte, factor 1 (devnet, 3 Nov)
const PER_BYTE = (() => {
  const d = base64.decode(FIX.answers[0]!.accounts.rent!.data[0]);
  return Number(new DataView(d.buffer, d.byteOffset).getBigUint64(0, true));
})();
const FEE = 5_000;
const MARK_RENT = (128 + 17) * PER_BYTE;
const ENTRY = 72 * PER_BYTE;
const EMPTY_RENT = 128 * PER_BYTE;
/** What one rung costs U on the recorded pool (both pages grow by one entry). */
const COST = MARK_RENT + 2 * ENTRY + FEE;

test("the fixture is the devnet pool both RPCs gave, and the testnet pin is its program", () => {
  assert.equal(SOL_POOLS.devnet, undefined, "the test build carries no pin; the testnet build's is checked in pool-testnet.test.ts");
  assert.equal(solanaPoolOf(FIX.program).pool, FIX.pool);
  const [a, b] = FIX.answers;
  assert.deepEqual(a!.accounts, b!.accounts);
  assert.equal(base64.decode(a!.accounts.pool!.data[0]).length, 2179);
});

type Status = { err: unknown; confirmationStatus: "finalized" };
/** One chain: the recorded accounts, the program's deposit applied to a signed tx. */
function chain() {
  const accounts = new Map<string, Acc>();
  for (const [k, v] of Object.entries(FIX.answers[0]!.accounts)) if (v) accounts.set(FIX.addresses[k as keyof typeof FIX.addresses], { owner: v.owner, lamports: v.lamports, data: base64.decode(v.data[0]) });
  let slot = FIX.answers[0]!.slot;
  const sent: string[] = [];
  const statuses = new Map<string, Status>();
  const c = {
    accounts,
    sent,
    statuses,
    height: 1_000,
    /** whether a sent deposit lands now (false: dropped, unseen) */
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
    lamports: (address: string) => accounts.get(address)?.lamports ?? 0,
    /** the deposit's checks and effects; `dry` checks only (simulation, no signature) */
    apply(tx: Uint8Array, dry = false): void {
      const message = tx.subarray(1 + 64 * tx[0]!);
      const m = solanaDecodeMessage(message);
      const signer = m.staticKeys[0]!;
      const sig = base58.encode(tx.subarray(1, 65));
      if (!dry && !ed25519.verify(tx.subarray(1, 65), message, base58.decode(signer))) throw new Error("signature");
      const ix = m.instructions[0]!;
      const keys = ix.accounts.map((i) => m.staticKeys[i]!);
      if (m.staticKeys[ix.programIndex] !== FIX.program || ix.data[0] !== 1 || keys[0] !== FIX.pool || keys[1] !== signer) throw new Error("not a deposit into the pool");
      const value = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
      const pre = beInt(ix.data.subarray(9, 41));
      const mark = solanaProgramAddress([enc.encode("pre"), be32(pre)], FIX.program);
      const fail = (why: string): never => {
        if (!dry) statuses.set(sig, { err: { InstructionError: [0, why] }, confirmationStatus: "finalized" });
        throw new Error(why);
      };
      if (accounts.has(mark)) fail("PrecommitmentAlreadyUsed");
      const u = accounts.get(signer);
      const pool = accounts.get(FIX.pool)!.data;
      const dv = new DataView(pool.buffer, pool.byteOffset);
      const stateSize = Number(dv.getBigUint64(49, true));
      const labelSize = Number(dv.getBigUint64(49 + 1065, true));
      const left = (u?.lamports ?? 0) - Number(value) - COST;
      if (left < 0 || (left > 0 && left < EMPTY_RENT)) fail("InsufficientFundsForRent");
      if (dry || !c.lands) return;
      const nonce = dv.getBigUint64(9, true) + 1n;
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
        accounts.set(at, { ...pg, data, lamports: pg.lamports + ENTRY });
      }
      dv.setBigUint64(9, nonce, true);
      dv.setBigUint64(49, BigInt(stateSize + 1), true);
      dv.setBigUint64(49 + 1065, BigInt(labelSize + 1), true);
      const md = new Uint8Array(17);
      new DataView(md.buffer).setBigUint64(0, said, true);
      new DataView(md.buffer).setBigUint64(8, nonce, true);
      md[16] = 1;
      accounts.set(mark, { owner: FIX.program, lamports: MARK_RENT, data: md });
      u!.lamports = left;
      statuses.set(sig, { err: null, confirmationStatus: "finalized" });
      slot += 40;
      c.height += 40;
    },
    rpc(over: { hide?: (address: string) => boolean; hideStatus?: boolean; blockhashUnknown?: boolean; simFails?: boolean } = {}) {
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
            // a new blockhash each slot, as the chain gives, valid 150 blocks
            return { ...ctx, value: { blockhash: base58.encode(be32(BigInt(++slot))), lastValidBlockHeight: c.height + 150 } };
          case "isBlockhashValid":
            return { ...ctx, value: !over.blockhashUnknown };
          case "getFeeForMessage":
            return { ...ctx, value: FEE };
          case "getBlockHeight":
            return c.height;
          case "getSignatureStatuses":
            return { ...ctx, value: (params[0] as string[]).map((s) => (over.hideStatus ? null : (statuses.get(s) ?? null))) };
          case "simulateTransaction": {
            try {
              if (over.simFails) throw new Error("simulation");
              c.apply(base64.decode(params[0] as string), true);
              return { ...ctx, value: { err: null, logs: [] } };
            } catch (e) {
              return { ...ctx, value: { err: String(e), logs: [] } };
            }
          }
          case "sendTransaction": {
            const tx = base64.decode(params[0] as string);
            const sig = base58.encode(tx.subarray(1, 65));
            if (!sent.includes(sig)) {
              sent.push(sig);
              try {
                c.apply(tx);
              } catch {
                // landed as a failed tx (its status says so), or refused
              }
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
type Host = PoolDepositHost & { landedNotes: NoteRecord[]; seeds: Uint8Array[]; stages: string[] };
function host(c: ReturnType<typeof chain>, ns: NoteStore, over: Partial<PoolDepositHost> = {}): Host {
  const landedNotes: NoteRecord[] = [];
  const seeds: Uint8Array[] = [];
  const stages: string[] = [];
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
    progress: (s) => stages.push(s),
    reads: 3,
    wait: async () => {},
    landedNotes,
    seeds,
    stages,
    ...over,
  };
}
const ours = async (ns: NoteStore) => (await ns.list()).filter((n) => n.scope === SCOPE);
const shape = async (ns: NoteStore) =>
  (await ours(ns)).sort((x, y) => (x.ref.kind === y.ref.kind ? ((x.ref as { n?: number }).n ?? 0) - ((y.ref as { n?: number }).n ?? 0) : x.ref.kind === "deposit" ? -1 : 1)).map((n) => [n.ref.kind, n.state, n.leaf?.value]);
/** U of the index the store plans for the pool's scope (its lane is the device's, drawn at random). */
const plannedU = async (ns: NoteStore): Promise<{ i: number; address: string }> => {
  const n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED64, ref).precommitment);
  const i = (n.ref as { i: number }).i;
  return { i, address: U(i) };
};
const sigOf = (tx: Uint8Array) => base58.encode(tx.subarray(1, 65));

test("a deposit for the pinned pool: U's tx lands, its note is stored UNSPENT with its devnet leaf and its send, one proof starts", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST); // exactly the rung and its costs: U ends at 0
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
  assert.deepEqual(n!.sends!.map((s) => [s.signature, s.value]), [[c.sent[0], RUNG]], "its send was written with INCOMING");
  assert.equal(c.lamports(u.address), 0);
  assert.deepEqual(h.landedNotes.map((x) => x.id), [n!.id], "one proof started, for the landed note");
  assert.deepEqual(h.stages, ["sent", "filled"]);
  assert.ok(h.seeds.every((s) => s.every((b) => b === 0)), "the seed is zeroed");
});

test("a move of three rungs' worth lands as the deposit note and its second arrival, each after the one before", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const h = host(c, ns);
  const got = await runPoolDeposit(h, ask(35_000_000n)); // 0.02 + 0.01; 0.005 below the smallest rung stays on U
  assert.equal((got as { stage: string }).stage, "filled");
  assert.deepEqual((got as { txs: unknown[] }).txs.length, 2);
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", 20_000_000n],
    ["second", "UNSPENT", 10_000_000n],
  ]);
  assert.equal(h.landedNotes.length, 2);
});

test("H1 (probe B): U holding the rung but not its costs, or a remainder below an empty account's rent, is not_funded with nothing written or sent; funded, the same note lands", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  for (const lamports of [Number(RUNG), Number(RUNG) + COST - 1, Number(RUNG) + COST + EMPTY_RENT - 1]) {
    c.fund(u.address, lamports);
    for (let k = 0; k < 2; k++) assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { error: "not_funded" }, `${lamports}`);
    assert.equal(c.sent.length, 0);
    assert.deepEqual((await ours(ns)).map((n) => [n.state, (n.ref as { i: number }).i]), [["PLANNED", u.i]], "the note stays PLANNED on the same U");
  }
  c.fund(u.address, Number(RUNG) + COST + EMPTY_RENT);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
});

test("H1: a simulation either RPC fails is not_funded before anything is written", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ simFails: true })] }), ask(RUNG)), { error: "not_funded" });
  assert.equal(c.sent.length, 0);
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["PLANNED"]);
});

test("L6: a blockhash the other RPC does not know is refused before anything is written", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ blockhashUnknown: true })] }), ask(RUNG)), { error: "failed" });
  assert.equal(c.sent.length, 0);
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["PLANNED"]);
});

// an attacker's own deposit with a precommitment it saw in the user's signed tx
function attackerTx(c: ReturnType<typeof chain>, pre: bigint, value: bigint): Uint8Array {
  const sk = new Uint8Array(32).fill(7);
  const pk = base58.encode(ed25519.getPublicKey(sk));
  if (!c.accounts.has(pk)) c.fund(pk, 1_000_000_000);
  const pool = c.accounts.get(FIX.pool)!.data;
  const dv = new DataView(pool.buffer, pool.byteOffset);
  const ss = Number(dv.getBigUint64(49, true));
  const ls = Number(dv.getBigUint64(49 + 1065, true));
  const u64 = new Uint8Array(8);
  new DataView(u64.buffer).setBigUint64(0, value, true);
  const ix = {
    program: FIX.program,
    accounts: [
      { key: FIX.pool, signer: false, writable: true },
      { key: pk, signer: true, writable: true },
      { key: solanaPoolPage(FIX.program, 0, ss), signer: false, writable: true },
      { key: solanaPoolPage(FIX.program, 1, ls), signer: false, writable: true },
      { key: solanaProgramAddress([enc.encode("pre"), be32(pre)], FIX.program), signer: false, writable: true },
      { key: "11111111111111111111111111111111", signer: false, writable: false },
    ],
    data: Uint8Array.of(1, ...u64, ...be32(pre)),
  };
  const { message } = solanaCompileV0(pk, [ix], base58.encode(be32(999n)), []);
  const wire = new Uint8Array(65 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  wire.set(ed25519.sign(message, sk), 1);
  return wire;
}
const preOf = (tx: Uint8Array): bigint => beInt(solanaDecodeMessage(tx.subarray(65)).instructions[0]!.data.subarray(9, 41));

test("H2 (probe A): a front-run deposit on the user's precommitment is never the user's note: the note goes TAKEN and U's money moves on its next note", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const base = c.rpc();
  let raced = false;
  const racing = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction" && !raced) {
      raced = true;
      c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), 1_000_000n)); // lands first, 0.001 SOL
    }
    return base(method, params);
  };
  const got = await runPoolDeposit(host(c, ns, { rpcs: [racing, c.rpc()] }), ask(RUNG));
  assert.equal(c.statuses.get(c.sent[0]!)?.err !== null, true, "the user's first tx failed on chain");
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[1] }] }, "the signature that landed");
  assert.deepEqual(await shape(ns), [
    ["deposit", "TAKEN", undefined],
    ["second", "UNSPENT", RUNG],
  ]);
  // a later run stores nothing of the attacker's
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  assert.ok((await ours(ns)).every((n) => n.leaf?.value !== 1_000_000n));
});

test("H2 (probe D): a mark of another value than the note's own landed send is refused on every run, never stored", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.moreValue = true;
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { error: "failed" });
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { error: "failed" });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"]);
});

test("M1 (probe C): a cut-short note is finished as its own move, sent again only at its own value once its blockhash expired, and its landed signature reported", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  c.lands = false; // dropped: never seen
  const r1 = await runPoolDeposit(host(c, ns), ask(20_000_000n));
  assert.deepEqual(r1, { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  const [stuck] = await ours(ns);
  assert.deepEqual([stuck!.state, stuck!.sends!.map((s) => s.value)], ["INCOMING", [20_000_000n]]);
  // its blockhash still valid: a new ask waits for it, sends nothing new
  c.lands = true;
  const r2 = await runPoolDeposit(host(c, ns), ask(10_000_000n));
  assert.deepEqual(r2, { stage: "not_landed", txs: [] });
  assert.equal(c.sent.length, 1);
  // past its last valid height: sent again at 0.02, its own value, then the new ask's 0.01 on the same U
  c.height += 1_000;
  const r3 = await runPoolDeposit(host(c, ns), ask(10_000_000n));
  assert.equal(c.sent.length, 3);
  assert.deepEqual(r3, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[1] }, { chain: "solana", hash: c.sent[2] }] });
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", 20_000_000n],
    ["second", "UNSPENT", 10_000_000n],
  ]);
  assert.deepEqual((await ours(ns)).find((n) => n.ref.kind === "deposit")!.sends!.map((s) => s.value), [20_000_000n, 20_000_000n]);
});

test("M1: the first tx landing late is the note's, at its own value, whatever the next ask is", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  c.lands = false;
  let first: Uint8Array | null = null;
  const base = c.rpc();
  const keep = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction" && !first) first = base64.decode(params[0] as string);
    return base(method, params);
  };
  await runPoolDeposit(host(c, ns, { rpcs: [keep, c.rpc()] }), ask(20_000_000n));
  c.lands = true;
  c.apply(first!); // lands now
  const r = await runPoolDeposit(host(c, ns), ask(10_000_000n));
  assert.deepEqual((r as { txs: { hash: string }[] }).txs.map((t) => t.hash)[0], sigOf(first!));
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", 20_000_000n],
    ["second", "UNSPENT", 10_000_000n],
  ]);
});

test("a deposit that does not read back on both RPCs answers not_landed and its note stays INCOMING; page load settles it once both hold it", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const h = host(c, ns, { rpcs: [c.rpc(), c.rpc({ hideStatus: true })] });
  assert.deepEqual(await runPoolDeposit(h, ask(RUNG)), { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"]);
  assert.equal(h.landedNotes.length, 0, "no proof for a note that has not landed");
  const one = host(c, ns, { rpcs: [c.rpc(), c.rpc({ hide: (a) => c.accounts.get(a)?.data.length === 17 })] });
  assert.equal(((await settlePoolDeposits(one)) as { stage: string }).stage, "not_landed");
  const load = host(c, ns);
  assert.deepEqual(await settlePoolDeposits(load), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["UNSPENT"]);
  assert.equal(load.landedNotes.length, 1);
  assert.equal(c.sent.length, 1, "never sent again while it could land");
});

test("a note the tree does not hold, or a label leaf that is not its nonce's, is refused and stays INCOMING", async () => {
  for (const lie of ["wrongLeaf", "wrongLabel"] as const) {
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

test("another pool: a pin the RPCs hold no pool for, or a pool account another program owns, is refused before anything is planned or signed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  assert.deepEqual(await runPoolDeposit(host(c, ns, { pin: { program: "11111111111111111111111111111112", feePayer: PIN.feePayer } }), ask(RUNG)), { error: "not_allowed" });
  const pool = c.accounts.get(FIX.pool)!;
  c.accounts.set(FIX.pool, { ...pool, owner: "BPFLoaderUpgradeab1e11111111111111111111111" });
  assert.ok("error" in (await runPoolDeposit(host(c, ns), ask(RUNG))));
  assert.equal(c.sent.length, 0, "nothing sent");
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["PLANNED"], "the planned note only: none INCOMING or UNSPENT");
});

test("M4: the U a move used stays the source while it covers a rung and its costs; then the planned index's U", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) * 2 + COST * 2);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  // the rest of U_i covers the next move: it goes as U_i's second arrival, not a new index
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", RUNG],
    ["second", "UNSPENT", RUNG],
  ]);
  assert.equal(c.lamports(u.address), 0);
  // U_i spent: the next move names the planned index's U, funded there
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { error: "not_funded" });
  const next = (await ours(ns)).find((n) => n.ref.kind === "deposit" && n.state === "PLANNED")!;
  const v = U((next.ref as { i: number }).i);
  c.fund(v, 50_000_000);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  assert.equal(c.statuses.size, 3);
});

test("M5: the kind answers at the first send, then posts each rung's landing as progress", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const stages: string[] = [];
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  const kind = poolDepositKind(() => ({ ...host(c, ns), end: ended }));
  const r = kind(ask(30_000_000n), { id: "d1", sha: "00", progress: (s) => stages.push(String(s)) });
  assert.ok("running" in r);
  await r.after;
  assert.deepEqual(r.answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: c.sent[0] }] } });
  await done;
  assert.deepEqual(stages, ["filled", "sent", "filled"]);
  assert.equal(poolDepositKind(() => host(c, ns), null)(ask(RUNG), null).hasOwnProperty("error"), true, "no Web Locks: refused");
});

test("the store refuses a pool note planned past a note that has not landed or been taken", async () => {
  const ns = await notes();
  const d = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED64, ref).precommitment);
  const r: NoteRef = { kind: "second", id: { id: "U", s: SCOPE, i: (d.ref as { i: number }).i }, n: 0 };
  await assert.rejects(ns.add({ ref: r, scope: SCOPE, precommitment: noteSecrets(SEED64, r).precommitment, state: "PLANNED" }), /waits until the note before it has landed/);
});
