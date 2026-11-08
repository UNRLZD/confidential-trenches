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
import { throughApi } from "./api-ends.ts";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { depositId, entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore, type PoolSend } from "../../wallet/src/notes/store.ts";
import { solanaPoolOf, SOL_POOLS } from "../../wallet/src/pool/solana.ts";
import { solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { solanaPoolPage } from "../../kit/src/trade/solana/pool-buy.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { followPoolDeposit, POOL_DEPOSIT_LANDING_MS, POOL_DEPOSIT_READS, POOL_DEPOSIT_REBUILDS, POOL_DEPOSIT_WAIT_MS, poolDepositKind, runPoolDeposit, settlePoolDeposits, type PoolDepositHost } from "../src/pool-deposit.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import { pairDown } from "./outage.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";

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
const MIN_DEPOSIT = 1_000_000n; // the pool's smallest deposit, contracts/pool-solana/src/lib.rs:78: below the smallest rung
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
const SYSTEM = "11111111111111111111111111111111";

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
  /** every RPC call, in order, with the RPC it went to (c.rpc()'s count) */
  const calls: { rpc: number; method: string; params: readonly unknown[] }[] = [];
  const c = {
    accounts,
    sent,
    statuses,
    calls,
    rpcs: 0,
    height: 1_000,
    /** sends that land as a failed tx, their fee paid (an insert overtook the deposit at a page's last slot) */
    failNext: 0,
    /** whether a sent deposit lands now (false: dropped, unseen) */
    lands: true,
    /** a lying pair: the state leaf written is not the deposit's */
    wrongLeaf: false,
    /** a lying pair: the label leaf written is not keccak256(scope ‖ nonce) mod p */
    wrongLabel: false,
    /** a lying pair: the mark and both leaves say one lamport more than the tx deposited */
    moreValue: false,
    /** a lying pair: the deposit's commitment written twice on the state tree */
    twiceLeaf: false,
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
      // a tx that fails on chain still pays its fee
      const fail = (why: string): never => {
        if (!dry) {
          statuses.set(sig, { err: { InstructionError: [0, why] }, confirmationStatus: "finalized" });
          const payer = accounts.get(signer);
          if (payer) payer.lamports = Math.max(0, payer.lamports - FEE);
        }
        throw new Error(why);
      };
      // a mark the program made: used; a system account with no data (a stranger's lamports) is taken over (src/state.rs
      // create_pda: the shortfall to its rent, then allocate and assign); any other account cannot be assigned
      const held = accounts.get(mark);
      if (held?.owner === FIX.program) fail("PrecommitmentAlreadyUsed");
      if (held && (held.owner !== SYSTEM || held.data.length > 0)) fail("AccountAlreadyInUse");
      const u = accounts.get(signer);
      const pool = accounts.get(FIX.pool)!.data;
      const dv = new DataView(pool.buffer, pool.byteOffset);
      const stateSize = Number(dv.getBigUint64(49, true));
      const labelSize = Number(dv.getBigUint64(49 + 1065, true));
      // as the program charges (src/state.rs create_pda, push_entry): the mark's rent and each page's rent at its new
      // length, less what each already holds, never below 0; and the fee
      const pageCost = (at: string, size: number) => Math.max(0, (128 + 16 + 72 * ((size % 1024) + 1)) * PER_BYTE - (accounts.get(at)?.lamports ?? 0));
      const cost = FEE + Math.max(0, MARK_RENT - (held?.lamports ?? 0)) + pageCost(keys[2]!, stateSize) + pageCost(keys[3]!, labelSize);
      const left = (u?.lamports ?? 0) - Number(value) - cost;
      if (left < 0 || (left > 0 && left < EMPTY_RENT)) fail("InsufficientFundsForRent");
      if (!dry && c.failNext > 0) {
        c.failNext--;
        fail("PageOvertaken");
      }
      if (dry || !c.lands) return;
      const nonce = dv.getBigUint64(9, true) + 1n;
      if (keys[2] !== page(0, Math.floor(stateSize / 1024)) || keys[3] !== page(1, Math.floor(labelSize / 1024))) throw new Error("page");
      const label = vaultLabelOf(keccak_256, SCOPE, nonce);
      const said = c.moreValue ? value + 1n : value;
      const commitment = c.wrongLeaf ? 7n : noteCommitment(said, label, pre);
      const writes: (readonly [0 | 1, bigint])[] = [[0, commitment], [1, c.wrongLabel ? 9n : label], ...(c.twiceLeaf ? [[0, commitment] as const] : [])];
      for (const [tree, leaf] of writes) {
        const at = tree === 0 ? keys[2]! : keys[3]!;
        const pg = accounts.get(at)!;
        const last = pg.data.subarray(pg.data.length - 72);
        const entry = new Uint8Array(72);
        entry.set(be32(leaf), 0);
        new DataView(entry.buffer).setBigInt64(64, new DataView(last.buffer, last.byteOffset + 64, 8).getBigInt64(0, true) + 1n, true);
        const data = new Uint8Array(pg.data.length + 72);
        data.set(pg.data);
        data.set(entry, pg.data.length);
        accounts.set(at, { ...pg, data, lamports: pg.lamports + pageCost(at, tree === 0 ? stateSize : labelSize) });
      }
      dv.setBigUint64(9, nonce, true);
      dv.setBigUint64(49, BigInt(stateSize + (c.twiceLeaf ? 2 : 1)), true);
      dv.setBigUint64(49 + 1065, BigInt(labelSize + 1), true);
      const md = new Uint8Array(17);
      new DataView(md.buffer).setBigUint64(0, said, true);
      new DataView(md.buffer).setBigUint64(8, nonce, true);
      md[16] = 1;
      accounts.set(mark, { owner: FIX.program, lamports: Math.max(MARK_RENT, held?.lamports ?? 0), data: md });
      u!.lamports = left;
      statuses.set(sig, { err: null, confirmationStatus: "finalized" });
      slot += 40;
      c.height += 40;
    },
    rpc(over: { hide?: (address: string) => boolean; hideStatus?: boolean; blockhashUnknown?: boolean; simFails?: boolean; simFailsOnce?: boolean; saysFailed?: boolean; mapAccount?: (address: string, a: Acc) => Acc } = {}) {
      const answer = (address: string) => {
        const held = over.hide?.(address) ? undefined : accounts.get(address);
        const a = held && over.mapAccount ? over.mapAccount(address, held) : held;
        return a ? { owner: a.owner, lamports: a.lamports, data: [base64.encode(a.data), "base64"], executable: false, rentEpoch: 0, space: a.data.length } : null;
      };
      const id = c.rpcs++;
      let simFailed = false;
      return async (method: string, params: readonly unknown[]): Promise<unknown> => {
        calls.push({ rpc: id, method, params });
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
          case "getEpochInfo":
            // the finalized height with the slot it is of, one node's one view (src/pool-deposit.ts finals)
            return { absoluteSlot: slot, blockHeight: c.height, epoch: 0, slotIndex: slot, slotsInEpoch: 432_000, transactionCount: null };
          case "getSignatureStatuses":
            // saysFailed: a lying RPC, every signature finalized with an error
            return { ...ctx, value: (params[0] as string[]).map((s) => (over.saysFailed ? { err: { InstructionError: [0, "lie"] }, confirmationStatus: "finalized" } : over.hideStatus ? null : (statuses.get(s) ?? null))) };
          case "simulateTransaction": {
            try {
              if (over.simFails) throw new Error("simulation");
              if (over.simFailsOnce && !simFailed) throw new Error((simFailed = true) && "simulation");
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
/** A precommitment mark of the pool (not the 17-byte Rent sysvar): what `hide` keeps from one RPC. */
const isMark = (c: ReturnType<typeof chain>) => (a: string) => {
  const x = c.accounts.get(a);
  return x?.owner === FIX.program && x.data.length === 17;
};
type Host = PoolDepositHost & { landedNotes: NoteRecord[]; seeds: Uint8Array[]; stages: string[] };
function host(c: ReturnType<typeof chain>, ns: NoteStore, over: Partial<PoolDepositHost> = {}): Host {
  const landedNotes: NoteRecord[] = [];
  const seeds: Uint8Array[] = [];
  const stages: string[] = [];
  return {
    pin: PIN,
    rpcs: [c.rpc(), c.rpc()],
    notes: async () => ns,
    records: async () => ns.list(),
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
  assert.deepEqual(h.stages, ["sent"], "the run posts no end stage itself: the kind tells the ask's one end (fold review 1)");
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

test("slice-2 review Low 4: the top-up named leaves U an empty account's rent as margin, so a stranger's lamport sent after it never stalls the deposit", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG));
  const short: [string, bigint][] = [];
  assert.deepEqual(await runPoolDeposit(host(c, ns, { short: (a, l) => short.push([a, l]) }), ask(RUNG)), { error: "not_funded" });
  assert.deepEqual(short, [[u.address, BigInt(COST + EMPTY_RENT)]], "the costs and the rent as margin, never the exact need");
  // the user sends the top-up named, and a stranger 1 lamport: the deposit goes, U keeps the margin and the lamport
  c.fund(u.address, Number(RUNG) + COST + EMPTY_RENT + 1);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
});

test("pool-answer-unknown's ask path: a simulation that fails once with no mark (the pool moved between the read and the simulation) is read and simulated again, and the deposit goes", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  assert.equal(((await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ simFailsOnce: true })] }), ask(RUNG))) as { stage: string }).stage, "filled");
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
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

test("H2 (probe A), precommit-taken-recover: a front-run deposit of MIN_DEPOSIT on the user's precommitment is restored as the user's note at that value, and the rung lands on U's next note in the same run", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const base = c.rpc();
  let raced = false;
  const pres: bigint[] = [];
  const racing = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction") pres.push(preOf(base64.decode(params[0] as string)));
    if (method === "sendTransaction" && !raced) {
      raced = true;
      c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), MIN_DEPOSIT)); // lands first, 0.001 SOL
    }
    return base(method, params);
  };
  const h = host(c, ns, { rpcs: [racing, c.rpc()] });
  const got = await runPoolDeposit(h, ask(RUNG));
  assert.equal(c.statuses.get(c.sent[0]!)?.err !== null, true, "the user's first tx failed on chain");
  assert.equal(c.sent.length, 2, "the rung is signed again, on the next precommitment");
  assert.equal(pres.length, 2);
  assert.notEqual(pres[1], pres[0], "the second send names another precommitment");
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[1] }] }, "the ask fills in the same run, its own tx only");
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", MIN_DEPOSIT],
    ["second", "UNSPENT", RUNG],
  ]);
  // the restored note is a real leaf of the pool, on the precommitment's own commitment
  const taken = (await ours(ns)).find((n) => n.ref.kind === "deposit")!;
  assert.equal(taken.leaf!.commitment, noteCommitment(MIN_DEPOSIT, taken.leaf!.label, taken.precommitment));
  assert.deepEqual(h.landedNotes.map((n) => n.leaf?.value), [MIN_DEPOSIT, RUNG], "each restored or landed note starts the proof queue's pass");
  assert.ok(!(await ours(ns)).some((n) => n.state === "TAKEN"), "never TAKEN");
});

test("precommit-taken-recover: a host with no landed hook still stores the restored note UNSPENT (the devnet front-run run's host), and the rung lands on U's next note", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const base = c.rpc();
  let raced = false;
  const racing = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction" && !raced) {
      raced = true;
      c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), MIN_DEPOSIT));
    }
    return base(method, params);
  };
  const got = await runPoolDeposit(host(c, ns, { rpcs: [racing, c.rpc()], landed: undefined }), ask(RUNG));
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[1] }] });
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", MIN_DEPOSIT],
    ["second", "UNSPENT", RUNG],
  ]);
});

test("precommit-taken-recover: a precommitment taken while its note was PLANNED (the mark already there at the simulation) is restored with nothing signed for it, and the rung goes on the next note", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const first = (await ours(ns)).find((n) => n.state === "PLANNED")!;
  c.apply(attackerTx(c, first.precommitment, MIN_DEPOSIT)); // a stranger lands first, before U signs anything
  const got = await runPoolDeposit(host(c, ns), ask(RUNG));
  assert.equal(c.sent.length, 1, "only the next note's deposit is sent");
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", MIN_DEPOSIT],
    ["second", "UNSPENT", RUNG],
  ]);
});

test("precommit-taken-recover: a page closed between a taken note's two moves (INCOMING, no send) restores it from its mark at the next load", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const first = (await ours(ns)).find((n) => n.state === "PLANNED")!;
  c.apply(attackerTx(c, first.precommitment, 3n * MIN_DEPOSIT));
  await ns.move(first.id, "PLANNED", "INCOMING"); // the first of the two moves, then the page closed
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "filled", txs: [] });
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", 3n * MIN_DEPOSIT]]);
});

test("precommit-taken-recover: a front-runner who takes every send ends the run after as many taken notes as the ask has rungs, each restored; the next run lands the rung", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const base = c.rpc();
  let on = true;
  const racing = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction" && on) c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), MIN_DEPOSIT));
    return base(method, params);
  };
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [racing, c.rpc()] }), ask(RUNG)), { error: "failed" });
  assert.equal(c.sent.length, 2, "one taken note per rung, then one more try, never an endless run");
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", MIN_DEPOSIT],
    ["second", "UNSPENT", MIN_DEPOSIT],
  ]);
  on = false;
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[2] }] });
  assert.deepEqual((await shape(ns)).at(-1), ["second", "UNSPENT", RUNG]);
});

test("precommit-taken-recover: one RPC alone saying a taken note's send succeeded does not stop the restore", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const base = c.rpc();
  let raced = false;
  const racing = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction" && !raced) {
      raced = true;
      c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), MIN_DEPOSIT));
    }
    return base(method, params);
  };
  const liar = c.rpc();
  const lying = async (method: string, params: readonly unknown[]) =>
    method === "getSignatureStatuses" ? { context: { slot: 1 }, value: (params[0] as string[]).map(() => ({ err: null, confirmationStatus: "finalized" })) } : liar(method, params);
  const got = await runPoolDeposit(host(c, ns, { rpcs: [racing, lying] }), ask(RUNG));
  assert.ok("stage" in got && got.stage === "filled", JSON.stringify(got));
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", MIN_DEPOSIT],
    ["second", "UNSPENT", RUNG],
  ]);
});

test("H2 (probe D): a mark of another value while an RPC says the note's own send succeeded is a lie: refused, the note stays INCOMING, nothing restored or sent again; answered sent with it (card pool-answer-unknown: the tx may land)", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, Number(RUNG) + COST);
  c.moreValue = true;
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { stage: "sent", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.equal(c.sent.length, 1);
  assert.deepEqual(await shape(ns), [["deposit", "INCOMING", undefined]]);
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
  // past its last valid height: sent again at 0.02, its own value, never told to the new ask, which waits for it
  c.height += 1_000;
  const r3 = await runPoolDeposit(host(c, ns), ask(10_000_000n));
  assert.equal(c.sent.length, 2);
  assert.deepEqual(r3, { stage: "not_landed", txs: [] });
  // landed: the new ask's 0.01 goes on the same U, its own send the only one it reports
  const r4 = await runPoolDeposit(host(c, ns), ask(10_000_000n));
  assert.equal(c.sent.length, 3);
  assert.deepEqual(r4, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[2] }] });
  assert.deepEqual((await shape(ns)).filter((x) => x[1] !== "PLANNED"), [
    ["deposit", "UNSPENT", 20_000_000n],
    ["second", "UNSPENT", 10_000_000n],
  ]);
  assert.deepEqual((await ours(ns)).find((n) => n.ref.kind === "deposit" && n.sends)!.sends!.map((s) => s.value), [20_000_000n, 20_000_000n]);
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
  assert.deepEqual(r, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[1] }] }, "the new ask reports its own send only");
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", 20_000_000n],
    ["second", "UNSPENT", 10_000_000n],
  ]);
});

test("a deposit that does not read back on both RPCs answers not_landed and its note stays INCOMING; page load settles it once both hold it", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const h = host(c, ns, { rpcs: [c.rpc(), c.rpc({ hide: isMark(c) })] });
  assert.deepEqual(await runPoolDeposit(h, ask(RUNG)), { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"]);
  assert.equal(h.landedNotes.length, 0, "no proof for a note that has not landed");
  const one = host(c, ns, { rpcs: [c.rpc(), c.rpc({ hide: isMark(c) })] });
  assert.equal(((await settlePoolDeposits(one)) as { stage: string }).stage, "not_landed");
  const load = host(c, ns);
  assert.deepEqual(await settlePoolDeposits(load), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["UNSPENT"]);
  assert.equal(load.landedNotes.length, 1);
  assert.equal(c.sent.length, 1, "never sent again while it could land");
});

test("card pool-answer-unknown: a read back that does not check out after the send (a mark of nonce 0, a label leaf that is not its nonce's, the commitment missing from the state tree or there twice) answers sent with the signature, never failed; the note stays INCOMING and settles at the next load once the reads check out", async () => {
  for (const lie of ["nonce0", "wrongLabel", "wrongLeaf", "twiceLeaf"] as const) {
    const c = chain();
    const ns = await notes();
    c.fund((await plannedU(ns)).address, 50_000_000);
    const nonce0 = (_: string, a: Acc): Acc => (a.owner === FIX.program && a.data.length === 17 ? { ...a, data: Uint8Array.from([...a.data.subarray(0, 8), 0, 0, 0, 0, 0, 0, 0, 0, 1]) } : a);
    if (lie !== "nonce0") c[lie] = true;
    const rpcs = lie === "nonce0" ? ([c.rpc({ mapAccount: nonce0 }), c.rpc({ mapAccount: nonce0 })] as const) : undefined;
    const h = host(c, ns, rpcs ? { rpcs } : {});
    assert.deepEqual(await runPoolDeposit(h, ask(RUNG)), { stage: "sent", txs: [{ chain: "solana", hash: c.sent[0] }] }, lie);
    assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"], lie);
    assert.equal(h.landedNotes.length, 0, lie);
    // page load while the reads still do not check out: pending, never failed, nothing sent again
    assert.deepEqual(await settlePoolDeposits(host(c, ns, rpcs ? { rpcs } : {})), { stage: "not_landed", txs: [] }, lie);
    assert.equal(c.sent.length, 1, lie);
    if (lie === "nonce0") {
      // the RPCs' reads check out at the next load: the note lands
      assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
      assert.deepEqual((await ours(ns)).map((n) => n.state), ["UNSPENT"]);
    }
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

test("M5: the kind answers at the first send, then posts each later send, and the ask's end once (fold review 1: a rung's landing is no end stage)", async () => {
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
  assert.deepEqual(stages, ["sent", "filled"]);
  assert.equal(poolDepositKind(() => host(c, ns), null)(ask(RUNG), null).hasOwnProperty("error"), true, "no Web Locks: refused");
});

test("the store refuses a pool note planned past a note that has not landed or been taken", async () => {
  const ns = await notes();
  const d = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED64, ref).precommitment);
  const r: NoteRef = { kind: "second", id: { id: "U", s: SCOPE, i: (d.ref as { i: number }).i }, n: 0 };
  await assert.rejects(ns.add({ ref: r, scope: SCOPE, precommitment: noteSecrets(SEED64, r).precommitment, state: "PLANNED" }), /waits until the note before it has landed/);
});

test("N1 (probe F1): one RPC without the tx's history: the note lands on its mark, and every later ask runs", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 3 * (Number(RUNG) + COST));
  const r1 = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ hideStatus: true })] }), ask(RUNG));
  assert.deepEqual(r1, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] }, "named from the RPC that holds it");
  const r2 = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc({ hideStatus: true }), c.rpc({ hideStatus: true })] }), ask(RUNG));
  assert.deepEqual(r2, { stage: "filled", txs: [] }, "landed, its tx named by neither RPC");
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", RUNG],
    ["second", "UNSPENT", RUNG],
  ]);
});

test("N1 (probe F2): the note's own deposit, read back hours later with no RPC holding its history, is UNSPENT, never TAKEN", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 3 * (Number(RUNG) + COST));
  // cut short: one RPC has not the mark yet
  const r1 = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ hide: isMark(c) })], reads: 1 }), ask(RUNG));
  assert.equal((r1 as { stage: string }).stage, "not_landed");
  const left = c.lamports(u.address);
  c.height += 500; // past its last valid height; the RPCs' status caches no longer hold it
  const load = host(c, ns, { rpcs: [c.rpc({ hideStatus: true }), c.rpc({ hideStatus: true })] });
  assert.deepEqual(await settlePoolDeposits(load), { stage: "filled", txs: [] });
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
  assert.equal(load.landedNotes.length, 1);
  assert.equal(c.sent.length, 1, "never sent again");
  assert.equal(c.lamports(u.address), left);
});

test("N1: a same-value deposit by another on the note's precommitment funds the user's note: UNSPENT, and U keeps its money", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const base = c.rpc();
  let raced = false;
  const racing = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction" && !raced) {
      raced = true;
      c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), RUNG));
    }
    return base(method, params);
  };
  const r = await runPoolDeposit(host(c, ns, { rpcs: [racing, c.rpc()] }), ask(RUNG));
  assert.deepEqual(r, { stage: "filled", txs: [] }, "no tx of the user's landed");
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
  assert.equal(c.lamports(u.address), 50_000_000 - FEE, "only the failed tx's fee left U");
});

test("N2 (probe G): one RPC's far-future last valid height is capped at its own height + 2 x 151 (the slack for a node behind, delta review r2 P8): the dropped send goes again, told to no new ask", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 3 * (Number(RUNG) + COST));
  const base = c.rpc();
  const lie = async (m: string, p: readonly unknown[]) => {
    const r = (await base(m, p)) as { value: { lastValidBlockHeight: number } };
    if (m === "getLatestBlockhash") r.value.lastValidBlockHeight = 1e12;
    return r;
  };
  c.lands = false;
  const at = c.height;
  assert.equal(((await runPoolDeposit(host(c, ns, { rpcs: [lie, c.rpc()] }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  assert.deepEqual((await ours(ns))[0]!.sends!.map((s) => s.last_valid_block_height), [BigInt(at + 2 * 151)]);
  c.lands = true;
  c.height += 10_000;
  const told: string[] = [];
  const r2 = await runPoolDeposit(host(c, ns, { sent: (s) => told.push(s) }), ask(RUNG));
  assert.equal(c.sent.length, 2, "sent again at its own value");
  assert.deepEqual([r2, told], [{ stage: "not_landed", txs: [] }, []], "the resend is not the new ask's");
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[2] }] });
  assert.deepEqual((await shape(ns)).filter((x) => x[1] !== "PLANNED"), [
    ["deposit", "UNSPENT", RUNG],
    ["second", "UNSPENT", RUNG],
  ]);
});

test("N3 (probe E): a send again U cannot pay leaves its note INCOMING, names the top-up, and blocks no other U", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST);
  const base = c.rpc();
  let once = false;
  const f = async (m: string, p: readonly unknown[]) => {
    if (m === "sendTransaction" && !once) {
      once = true; // fails on chain after a passing simulation (a page-boundary race): the fee is taken
      const tx = base64.decode(p[0] as string);
      c.statuses.set(sigOf(tx), { err: { InstructionError: [0, "WrongAccount"] }, confirmationStatus: "finalized" });
      c.accounts.get(u.address)!.lamports -= FEE;
      c.sent.push(sigOf(tx));
      c.height += 200;
      return sigOf(tx);
    }
    return base(m, p);
  };
  const short: [string, bigint][] = [];
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [f, c.rpc()], short: (a, l) => short.push([a, l]) }), ask(RUNG)), { error: "not_funded" });
  assert.deepEqual(short, [[u.address, BigInt(FEE + EMPTY_RENT)]], "the fee and an empty account's rent as margin (Low 4)");
  // another U, funded: its ask runs; the stuck note waits for its top-up
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { error: "not_funded" });
  const next = (await ours(ns)).find((n) => n.ref.kind === "deposit" && n.state === "PLANNED")!;
  c.fund(U((next.ref as { i: number }).i), 50_000_000);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { error: "not_funded" });
  // topped up: page load sends it again at its own value, and the next load reads it landed
  c.accounts.get(u.address)!.lamports += FEE;
  assert.equal(((await settlePoolDeposits(host(c, ns))) as { stage: string }).stage, "not_landed");
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent.at(-1) }] });
  assert.deepEqual((await ours(ns)).filter((n) => n.ref.kind === "deposit").map((n) => [n.state, n.leaf?.value]).sort(), [["UNSPENT", RUNG], ["UNSPENT", RUNG]]);
});

test("M5: page load reads an open note once and never waits on it, so an ask behind it answers at once", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  assert.equal(((await runPoolDeposit(host(c, ns, { reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  let waits = 0;
  const load = host(c, ns, { reads: 120, wait: async () => void waits++ });
  assert.deepEqual(await settlePoolDeposits(load), { stage: "not_landed", txs: [] });
  assert.equal(waits, 0);
  assert.deepEqual(await runPoolDeposit(host(c, ns, { reads: 120, wait: async () => void waits++ }), ask(RUNG)), { stage: "not_landed", txs: [] });
  assert.equal(waits, 0, "the ask did not wait on the earlier note");
});

// Review round 3 of d2d442a (card signpage-pool-notes-2): the heights are read before the mark; an ask whose U is unfunded
// behind a pending earlier note answers not_funded with the top-up; one TAKEN stops the move for that run.

test("R3: the heights are read before the mark, so a send that finalizes between the two reads lands and is never sent again", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false; // dropped for now
  let first: Uint8Array | null = null;
  const base = c.rpc();
  const keep = async (m: string, p: readonly unknown[]) => {
    if (m === "sendTransaction" && !first) first = base64.decode(p[0] as string);
    return base(m, p);
  };
  assert.equal(((await runPoolDeposit(host(c, ns, { rpcs: [keep, c.rpc()], reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  c.lands = true;
  // the send finalizes, and the chain moves past its last valid height, at the first finalized height read
  let moved = false;
  const late = (rpc: ReturnType<typeof c.rpc>) => async (m: string, p: readonly unknown[]) => {
    if (m === "getEpochInfo" && (p[0] as { commitment?: string } | undefined)?.commitment === "finalized" && !moved) {
      moved = true;
      c.apply(first!);
      c.height += 1_000;
    }
    return rpc(m, p);
  };
  assert.deepEqual(await settlePoolDeposits(host(c, ns, { rpcs: [late(c.rpc()), late(c.rpc())] })), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.equal(c.sent.length, 1, "never sent again");
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
});

test("R3: an ask whose U is unfunded behind a pending earlier note answers not_funded with the top-up, not not_landed", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST); // its own rung and costs only: nothing left once it lands
  c.lands = false; // still landing: its blockhash valid
  assert.equal(((await runPoolDeposit(host(c, ns, { reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  const short: [string, bigint][] = [];
  assert.deepEqual(await runPoolDeposit(host(c, ns, { short: (a, l) => short.push([a, l]) }), ask(RUNG)), { error: "not_funded" });
  const next = (await ours(ns)).find((n) => n.ref.kind === "deposit" && n.state === "PLANNED")!;
  assert.notEqual((next.ref as { i: number }).i, u.i);
  assert.deepEqual(short, [[U((next.ref as { i: number }).i), RUNG + BigInt(COST + EMPTY_RENT)]], "the top-up names the ask's own U and what it lacks, with the rent as margin (Low 4)");
  assert.equal(c.sent.length, 1, "nothing sent");
});

test("R3: a pending earlier note whose U still holds the next rung once it lands: the ask waits (not_landed), no top-up named", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 2 * (Number(RUNG) + COST));
  c.lands = false;
  assert.equal(((await runPoolDeposit(host(c, ns, { reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  const short: [string, bigint][] = [];
  assert.deepEqual(await runPoolDeposit(host(c, ns, { short: (a, l) => short.push([a, l]) }), ask(RUNG)), { stage: "not_landed", txs: [] });
  assert.deepEqual(short, []);
});

test("R3: a front-run on the second rung of a move restores the front-runner's deposit and lands the rung on the next note: the move fills", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const base = c.rpc();
  let sends = 0;
  const racing = async (method: string, params: readonly unknown[]) => {
    if (method === "sendTransaction" && ++sends === 2) c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), MIN_DEPOSIT));
    return base(method, params);
  };
  const got = await runPoolDeposit(host(c, ns, { rpcs: [racing, c.rpc()] }), ask(30_000_000n));
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }, { chain: "solana", hash: c.sent[2] }] });
  assert.equal(c.sent.length, 3, "the taken rung is sent once more, on the next note");
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", 20_000_000n],
    ["second", "UNSPENT", MIN_DEPOSIT],
    ["second", "UNSPENT", 10_000_000n],
  ]);
});

test("R3 fold 1: an earlier send already landed but its note still INCOMING is in U's balance once, never subtracted again: the ask waits; if one RPC has not seen it, the lower reading holds", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 2 * (Number(RUNG) + COST)); // its own rung and the next one, with costs
  // the send lands (its status confirmed on both RPCs, U charged), but one RPC has not the mark yet: the note stays INCOMING
  const lagging = () => [c.rpc(), c.rpc({ hide: isMark(c) })] as const;
  assert.equal(((await runPoolDeposit(host(c, ns, { rpcs: [...lagging()], reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  assert.equal(c.lamports(u.address), Number(RUNG) + COST, "U already paid the first rung");
  const short: [string, bigint][] = [];
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [...lagging()], short: (a, l) => short.push([a, l]) }), ask(RUNG)), { stage: "not_landed", txs: [] });
  assert.equal(short.length, 0, "no top-up asked: U covers the rung once the note lands");
  // the RPCs disagree (one has not seen the send): the lower reading, U less the send's value, is short
  const r = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ hide: isMark(c), hideStatus: true })], short: (a, l) => short.push([a, l]) }), ask(RUNG));
  assert.deepEqual(r, { error: "not_funded" });
  assert.equal(short.length, 1);
  assert.deepEqual((await ours(ns)).filter((n) => n.state !== "PLANNED").map((n) => n.state), ["INCOMING"]);
});

// the review of 54b2f65 (finding 1, in every path): the read-back is a time budget, so one RPC down (each read its own
// retry) never holds the seed's lock for minutes
test("a deposit that never lands stops at POOL_DEPOSIT_READS seconds on the wall clock, whatever its read count", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  let waited = 0;
  const a = (await runPoolDeposit(host(c, ns, { reads: 1_000, wait: async (ms: number) => void (waited += ms), now: () => BigInt(1_000 + waited) }), ask(RUNG))) as { stage: string };
  assert.notEqual(a.stage, "filled");
  assert.ok(waited <= POOL_DEPOSIT_READS * POOL_DEPOSIT_WAIT_MS, `waited ${waited} ms`);
});

// Card signpage-error-after-timeout: a deposit refused after the client's 10 s window still ends the app's button.
test("a pool.deposit refused (U holds the rung but not its costs: not_funded) reaches the app as progress refused after its answer", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, Number(RUNG));
  const r = await throughApi("pool.deposit", (_p, ctx) => poolDepositKind(() => host(c, ns))(ask(RUNG), ctx), { chain: "solana", amount: "0.01" });
  assert.ok(Object.hasOwn(r.answer as object, "error"), JSON.stringify(r.answer));
  assert.equal((r.answer as { error: { code: string } }).error.code, "not_funded");
  assert.deepEqual(r.stages, ["refused"]);
  assert.equal(c.sent.length, 0);
});

// Card pool-read-down: one provider down past the page's own retry, from each of its calls in turn. Before U signs, the
// deposit answers "down" (api.ts RETRY_CODES: the same request again runs again), never failed or not_allowed, with
// nothing sent and the note still PLANNED; the other provider's word alone is never taken. From U's first send on, it
// is never "down".
for (const p of [0, 1] as const) {
  test(`card pool-read-down: provider ${p} down past the page's retry answers down before U signs; after the send, sent or the read-back's verdict, never failed, down or a throw`, async () => {
    let before = 0;
    let after = 0;
    for (let from = 0; ; from++) {
      const c = chain();
      const ns = await notes();
      const u = await plannedU(ns);
      c.fund(u.address, Number(RUNG) + COST);
      const d = pairDown([c.rpc(), c.rpc()] as const, p, from);
      // a throw past the send would reach poolDepositKind's catch as failed while the tx may land
      const a = await runPoolDeposit(host(c, ns, { rpcs: d.rpcs }), ask(RUNG)).catch((e: unknown) => ({ thrown: String(e) }));
      if (!d.fired()) break;
      if (c.sent.length === 0) {
        before++;
        assert.deepEqual(a, { error: "down" }, `from call ${from}`);
        assert.deepEqual((await ours(ns)).map((n) => n.state), ["PLANNED"], `from call ${from}`);
      } else {
        after++;
        assert.ok("stage" in a, `from call ${from}: ${JSON.stringify(a)}`);
        if (a.stage === "sent") assert.deepEqual(a.txs.map((t) => t.hash), [c.sent[0]!], `from call ${from}`);
        else assert.ok(["filled", "not_landed"].includes(a.stage), `from call ${from}: ${a.stage}`);
      }
    }
    assert.ok(before > 0 && after > 0, `${before} before, ${after} after`);
  });
}

// card pool-deposits, slice 2: the signing page's deposit is the kit's (built, priced and its marks read by
// packages/kit/src/trade/solana/pool-deposit.ts), read at one commitment, simulated on both RPCs before it is signed,
// and built again from fresh reads after a send that failed.
const markOf = (precommitment: bigint) => solanaProgramAddress([enc.encode("pre"), be32(precommitment)], FIX.program);
const optsOf = (params: readonly unknown[]) => params.find((p): p is Record<string, unknown> => p !== null && typeof p === "object" && !Array.isArray(p));
/** The deposit's 32 precommitment bytes and the message of a wire tx. */
const txParts = (wire: Uint8Array) => {
  const message = wire.subarray(1 + 64 * wire[0]!);
  const m = solanaDecodeMessage(message);
  return { signer: m.staticKeys[0]!, precommitment: base58.encode(m.instructions[0]!.data.subarray(9, 41)), message: base64.encode(message) };
};

test("pool-deposits (a): a stranger's lamports on a page lower the cost as the program charges it: U holding the rung and that lower cost lands at 0", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.accounts.get(page(0, 0))!.lamports += 1_000;
  c.fund(u.address, Number(RUNG) + COST - 1_000);
  const got = await runPoolDeposit(host(c, ns), ask(RUNG));
  assert.equal((got as { stage?: string }).stage, "filled", JSON.stringify(got));
  assert.equal(c.lamports(u.address), 0);
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
});

test("pool-deposits (b) I-3: a stranger's lamports at an open note's mark address never fail a run: the note goes again once its send expired and lands, the mark's rent lowered by them", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST);
  c.lands = false; // dropped
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage?: string }).stage, "not_landed");
  const [open] = await ours(ns);
  assert.equal(open!.state, "INCOMING");
  const at = markOf(open!.precommitment);
  c.fund(at, EMPTY_RENT); // a stranger's system account at the mark's address
  c.fund(u.address, Number(RUNG) + COST - EMPTY_RENT); // only the cost those lamports lower
  // its blockhash still valid: read, not failed, left INCOMING
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "not_landed", txs: [] });
  c.lands = true;
  c.height += 1_000;
  // sent again (a settle reads once, never waits), then read landed
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[1] }] });
  const got = await settlePoolDeposits(host(c, ns));
  assert.equal((got as { stage?: string }).stage, "filled", JSON.stringify(got));
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
  assert.equal(c.sent.length, 2);
  assert.equal(c.accounts.get(at)!.owner, FIX.program, "the deposit took the account over");
  assert.equal(c.lamports(u.address), 0, "U paid the mark's rent less the stranger's lamports");
  // and an ask runs on
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { error?: string }).error, "not_funded");
});

test("pool-deposits (c): a send that failed on chain is built again at once from fresh reads of the pool, both pages, the mark's address and U on both RPCs: the same note and U, new bytes, never the old tx again", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST + EMPTY_RENT + FEE); // the failed tx's fee too
  c.failNext = 1;
  const got = await runPoolDeposit(host(c, ns), ask(RUNG));
  assert.equal((got as { stage?: string }).stage, "filled", JSON.stringify(got));
  assert.equal(c.lamports(u.address), EMPTY_RENT);
  const [n, ...rest] = await ours(ns);
  assert.equal(rest.length, 0, "no deposit at a new index");
  assert.equal(n!.state, "UNSPENT");
  assert.deepEqual(n!.sends!.map((s) => [s.signature, s.value]), c.sent.map((s) => [s, RUNG]));
  assert.equal(c.sent.length, 2);
  assert.equal(c.statuses.get(c.sent[0]!)!.err !== null, true, "the first send failed on chain");
  const sends = c.calls.filter((x) => x.method === "sendTransaction").map((x) => base64.decode(x.params[0] as string));
  const [first, second] = [sends.find((t) => sigOf(t) === c.sent[0])!, sends.find((t) => sigOf(t) === c.sent[1])!];
  assert.equal(sends.filter((t) => sigOf(t) === c.sent[0]).length, 2, "the failed tx went once, to each RPC, never again");
  const [p1, p2] = [txParts(first), txParts(second)];
  assert.deepEqual([p1.signer, p2.signer], [u.address, u.address]);
  assert.equal(p1.precommitment, p2.precommitment, "the same note");
  assert.equal(base58.encode(be32(n!.precommitment)), p1.precommitment);
  assert.notEqual(p1.message, p2.message, "built again, not re-sent");
  const lastOld = c.calls.findLastIndex((x) => x.method === "sendTransaction" && sigOf(base64.decode(x.params[0] as string)) === c.sent[0]);
  const firstNew = c.calls.findIndex((x) => x.method === "sendTransaction" && sigOf(base64.decode(x.params[0] as string)) === c.sent[1]);
  const want = [FIX.pool, page(0, 0), page(1, 0), markOf(n!.precommitment), u.address];
  const fresh = c.calls.slice(lastOld + 1, firstNew).filter((x) => x.method === "getMultipleAccounts" && want.every((k) => (x.params[0] as string[]).includes(k)));
  assert.deepEqual([...new Set(fresh.map((x) => x.rpc))].sort(), [0, 1], "read again on both RPCs between the two sends");
});

test("pool-deposits (d): every send's exact bytes were simulated unsigned on both RPCs at confirmed before they were signed, a send again's too", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  c.lands = false;
  await runPoolDeposit(host(c, ns), ask(RUNG));
  c.lands = true;
  c.height += 1_000;
  await settlePoolDeposits(host(c, ns)); // sent again
  assert.equal(((await settlePoolDeposits(host(c, ns))) as { stage?: string }).stage, "filled");
  assert.equal(c.sent.length, 2);
  for (const sig of c.sent) {
    const at = c.calls.findIndex((x) => x.method === "sendTransaction" && sigOf(base64.decode(x.params[0] as string)) === sig);
    const tx = base64.decode(c.calls[at]!.params[0] as string);
    const unsigned = tx.slice();
    unsigned.fill(0, 1, 65);
    const sims = c.calls.slice(0, at).filter((x) => x.method === "simulateTransaction" && x.params[0] === base64.encode(unsigned));
    assert.equal(new Set(sims.map((x) => x.rpc)).size, 2, `${sig} simulated on both RPCs`);
    for (const s of sims) assert.deepEqual([optsOf(s.params)!.sigVerify, optsOf(s.params)!.commitment], [false, "confirmed"]);
  }
});

test("pool-deposits (e): one deposit's numbers are of one slot on each RPC: the pool, both pages, the mark's address, U and the Rent sysvar in one read at confirmed, and every read before the send at confirmed", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage?: string }).stage, "filled");
  const [n] = await ours(ns);
  const send = c.calls.findIndex((x) => x.method === "sendTransaction");
  const before = c.calls.slice(0, send);
  const want = [FIX.pool, page(0, 0), page(1, 0), markOf(n!.precommitment), u.address, FIX.addresses.rent];
  const one = before.filter((x) => x.method === "getMultipleAccounts" && want.every((k) => (x.params[0] as string[]).includes(k)));
  assert.deepEqual([...new Set(one.map((x) => x.rpc))].sort(), [0, 1], "one read per RPC holds them all");
  assert.equal(before.filter((x) => x.method === "getAccountInfo" && x.params[0] === u.address).length, 0, "U's balance is never read apart from the pages");
  for (const x of before) {
    const o = optsOf(x.params);
    if (o && "commitment" in o) assert.equal(o.commitment, "confirmed", x.method);
  }
});

test("pool-deposits (c): one RPC alone saying a send failed never builds it again while its blockhash lives: the note waits, one send", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  c.lands = false; // dropped: the honest RPC has no status for it
  const got = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ saysFailed: true })] }), ask(RUNG));
  assert.deepEqual(got, { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.equal(c.sent.length, 1);
});

test("pool-deposits (e): a pool the two RPCs give different bytes of is read again, then refused: nothing signed or sent", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  // RPC 1 a slot behind on the pool's nonce from the build's read on (the run's first read of it agrees)
  let reads = 0;
  const behind = (address: string, a: Acc): Acc => {
    if (address !== FIX.pool || ++reads === 1) return a;
    const data = a.data.slice();
    data[9] = data[9]! ^ 1;
    return { ...a, data };
  };
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ mapAccount: behind })] }), ask(RUNG)), { error: "failed" });
  assert.equal(c.sent.length, 0);
  assert.equal(c.calls.filter((x) => x.method === "getMultipleAccounts" && (x.params[0] as string[]).includes(FIX.pool)).length, 6, "three reads on each RPC");
  assert.equal(c.calls.filter((x) => x.method === "simulateTransaction").length, 0);
});

// card pool-answer-unknown: the independent review of pool-deposits slice 2 (SHIP, 7 Nov 03:55Z), its findings F1-F6
// folded here; R1-R7 are its tests, each now with the answer the device must give. A mutant of each rule fails one.
/** `rpc` with one method's answer changed (the rest as the chain gives). */
const remap = (rpc: SolanaRpc, method: string, f: (params: readonly unknown[], answer: unknown) => unknown): SolanaRpc => async (m, params) => {
  const a = await rpc(m, params);
  return m === method ? f(params, a) : a;
};
type SolanaRpc = PoolDepositHost["rpcs"][0];
const shortsOf = (short: [string, bigint][]) => (a: string, l: bigint) => void short.push([a, l]);

test("review R2 (F1): an RPC that says U holds more than it does never prices the deposit: each RPC's reading must go, so the true one names the top-up (with an empty account's rent as margin, Low 4)", async () => {
  for (const liar of [0, 1] as const) {
    const c = chain();
    const ns = await notes();
    const u = await plannedU(ns);
    c.fund(u.address, Number(RUNG) + COST - 1_000);
    const more = (address: string, a: Acc): Acc => (address === u.address ? { ...a, lamports: a.lamports + 5_000_000 } : a);
    const short: [string, bigint][] = [];
    const rpcs = liar === 0 ? ([c.rpc({ mapAccount: more }), c.rpc()] as const) : ([c.rpc(), c.rpc({ mapAccount: more })] as const);
    const got = await runPoolDeposit(host(c, ns, { rpcs, short: shortsOf(short) }), ask(RUNG));
    assert.deepEqual(got, { error: "not_funded" }, `liar ${liar}`);
    assert.deepEqual(short, [[u.address, 1_000n + BigInt(EMPTY_RENT)]], `liar ${liar}`);
    assert.equal(c.sent.length, 0);
  }
});

test("review R7 (F1): an RPC that says a page holds more than it does never lowers the price: the top-up named makes the deposit go on either reading, and with it the deposit lands", async () => {
  for (const liar of [0, 1] as const) {
    for (const at of [page(0, 0), page(1, 0)]) {
      const c = chain();
      const ns = await notes();
      const u = await plannedU(ns);
      c.fund(u.address, Number(RUNG) + COST - 1);
      const more = (address: string, a: Acc): Acc => (address === at ? { ...a, lamports: a.lamports + 1_000 } : a);
      const short: [string, bigint][] = [];
      const rpcs = liar === 0 ? ([c.rpc({ mapAccount: more }), c.rpc()] as const) : ([c.rpc(), c.rpc({ mapAccount: more })] as const);
      const got = await runPoolDeposit(host(c, ns, { rpcs, short: shortsOf(short) }), ask(RUNG));
      assert.deepEqual(got, { error: "not_funded" }, `liar ${liar} ${at}`);
      // 1 short on the true reading; on the liar's U would keep 999, under an empty account's rent: the least top-up
      // that goes on both leaves U an empty account's rent on the true one
      assert.deepEqual(short, [[u.address, BigInt(EMPTY_RENT) + 1n]], `liar ${liar} ${at}`);
      c.accounts.get(u.address)!.lamports += EMPTY_RENT + 1;
      const again = await runPoolDeposit(host(c, ns, { rpcs }), ask(RUNG));
      assert.equal((again as { stage?: string }).stage, "filled", `liar ${liar} ${at}: ${JSON.stringify(again)}`);
      assert.equal(c.lamports(u.address), EMPTY_RENT, `liar ${liar} ${at}`);
    }
  }
});

test("F1: an RPC that says the mark's address holds lamports it does not never lowers the price", async () => {
  for (const liar of [0, 1] as const) {
    const c = chain();
    const ns = await notes();
    const u = await plannedU(ns);
    c.fund(u.address, Number(RUNG) + COST - 1);
    const [n] = await ours(ns);
    const mark = markOf(n!.precommitment);
    // the liar shows a stranger's 1,000 lamports at the mark's address, which the chain does not hold
    const rpc = (k: number) => {
      const r = c.rpc();
      return k !== liar ? r : remap(r, "getMultipleAccounts", (params, a) => {
        const keys = params[0] as string[];
        const v = (a as { value: unknown[] }).value.map((x, i) => (keys[i] === mark && x === null ? { owner: SYSTEM, lamports: 1_000, data: ["", "base64"], executable: false, rentEpoch: 0, space: 0 } : x));
        return { ...(a as object), value: v };
      });
    };
    const short: [string, bigint][] = [];
    const got = await runPoolDeposit(host(c, ns, { rpcs: [rpc(0), rpc(1)], short: shortsOf(short) }), ask(RUNG));
    assert.deepEqual(got, { error: "not_funded" }, `liar ${liar}`);
    assert.deepEqual(short, [[u.address, BigInt(EMPTY_RENT) + 1n]], `liar ${liar}`);
  }
});

test("review R5 (F6): a page's lamports differ between the RPCs and U holds exactly the higher reading's price: on the other reading U would keep dust, so the top-up named makes both go, and with it the deposit lands", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST);
  c.accounts.get(page(0, 0))!.lamports += 1_000; // on chain; RPC 1 has not seen it
  const behind = (address: string, a: Acc): Acc => (address === page(0, 0) ? { ...a, lamports: a.lamports - 1_000 } : a);
  const short: [string, bigint][] = [];
  const got = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ mapAccount: behind })], short: shortsOf(short) }), ask(RUNG));
  assert.deepEqual(got, { error: "not_funded" });
  assert.deepEqual(short, [[u.address, BigInt(EMPTY_RENT)]], "the top-up: an empty account's rent, so U keeps at least that on both readings");
  assert.equal(c.sent.length, 0);
  c.accounts.get(u.address)!.lamports += EMPTY_RENT;
  const again = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ mapAccount: behind })] }), ask(RUNG));
  assert.equal((again as { stage?: string }).stage, "filled", JSON.stringify(again));
  assert.equal(c.lamports(u.address), EMPTY_RENT + 1_000);
});

test("review R1 (F6): a landed deposit whose mark one RPC still reads as a stranger's system account is never stuck: page load answers not_landed (the deposit may have landed), never not_funded, sends nothing again; it lands once both show the mark", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST + EMPTY_RENT + 10 * FEE);
  const lagMark = { on: true };
  const lag = (_: string, a: Acc): Acc => (lagMark.on && a.owner === FIX.program && a.data.length === 17 ? { owner: SYSTEM, lamports: 1_000_000, data: new Uint8Array(0) } : a);
  const r1 = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ mapAccount: lag })] }), ask(RUNG));
  assert.deepEqual(r1, { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  const balAfter = c.lamports(u.address);
  c.height += 1_000; // every send past its last valid height while the lag lasts
  const r2 = await settlePoolDeposits(host(c, ns, { rpcs: [c.rpc(), c.rpc({ mapAccount: lag })] }));
  assert.deepEqual(r2, { stage: "not_landed", txs: [] });
  assert.equal(c.sent.length, 1, "no send again while one RPC lags");
  assert.equal(c.lamports(u.address), balAfter);
  assert.equal((await ours(ns)).length, 1, "no new index");
  lagMark.on = false;
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", RUNG]]);
});

test("review R3 (F3): a deposit that keeps failing on chain after both simulations pass is built again at most POOL_DEPOSIT_REBUILDS times in a run, then waits for its blockhash to expire; the next run after expiry goes again and lands", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST + 200 * FEE);
  c.failNext = 1_000;
  const got = await runPoolDeposit(host(c, ns, { reads: POOL_DEPOSIT_READS }), ask(RUNG));
  assert.equal(c.sent.length, 1 + POOL_DEPOSIT_REBUILDS, "the send and its capped rebuilds, never one per read");
  assert.deepEqual(got, { stage: "not_landed", txs: c.sent.map((hash) => ({ chain: "solana", hash })) });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"]);
  c.failNext = 0;
  c.height += 1_000; // the last send's blockhash expired on both
  // page load: one read, the note sent again (its one read spent), then the next load reads it landed
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent.at(-1) }] });
  assert.equal(c.sent.length, 2 + POOL_DEPOSIT_REBUILDS);
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent.at(-1) }] });
});

test("F2: one RPC a slot behind on the pool is read again at the higher slot (minContextSlot) on both; a node not there yet answers -32016 and is read again; the deposit lands", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, Number(RUNG) + COST);
  let refusedOnce = false;
  const mins: unknown[] = [];
  const base = c.rpc();
  const behind: SolanaRpc = async (method, params) => {
    const a = (await base(method, params)) as { context: { slot: number }; value: unknown };
    if (method !== "getMultipleAccounts" || !(params[0] as string[]).includes(FIX.pool)) return a;
    const min = optsOf(params)?.minContextSlot;
    mins.push(min);
    if (min === undefined) {
      // a slot behind: the pool's bytes as they were (its nonce one lower)
      const v = (a.value as ({ data: [string, string] } | null)[]).map((x, i) => {
        if (i !== 0 || x === null) return x;
        const d = base64.decode(x.data[0]);
        d[9] = d[9]! ^ 1;
        return { ...x, data: [base64.encode(d), "base64"] };
      });
      return { context: { slot: a.context.slot - 1 }, value: v };
    }
    if (!refusedOnce) {
      refusedOnce = true;
      throw new Error("RPC error -32016: Minimum context slot has not been reached");
    }
    return a;
  };
  const got = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), behind] }), ask(RUNG));
  assert.equal((got as { stage?: string }).stage, "filled", JSON.stringify(got));
  assert.ok(refusedOnce);
  const firstSlots = mins.filter((m) => m !== undefined);
  assert.ok(firstSlots.length >= 2 && firstSlots.every((m) => typeof m === "number"), JSON.stringify(mins));
  const onHonest = c.calls.filter((x) => x.method === "getMultipleAccounts" && (x.params[0] as string[]).includes(FIX.pool) && optsOf(x.params)?.minContextSlot !== undefined);
  assert.ok(onHonest.length >= 1, "the read again names the slot on the other RPC too");
});

test("F3/M5: a send both RPCs say failed only at confirmed is not dead: never built again while its blockhash lives", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  c.failNext = 1;
  const confirmedOnly = (r: SolanaRpc) => remap(r, "getSignatureStatuses", (_, a) => ({ ...(a as object), value: ((a as { value: (Status | null)[] }).value).map((st) => (st && st.err !== null ? { ...st, confirmationStatus: "confirmed" } : st)) }));
  const got = await runPoolDeposit(host(c, ns, { rpcs: [confirmedOnly(c.rpc()), confirmedOnly(c.rpc())] }), ask(RUNG));
  assert.deepEqual(got, { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.equal(c.sent.length, 1);
});

test("F1/M3b: a read whose pages are not the ones the pool's sizes name (the pool moved past a page since the sizes were read) is read again at the named pages: the price is the true one", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST);
  // the run's first read of the pool, on both RPCs, names a state tree a page further on (1024 entries more)
  const stale = (r: SolanaRpc) => {
    let first = true;
    return remap(r, "getAccountInfo", (params, a) => {
      if (params[0] !== FIX.pool || !first) return a;
      first = false;
      const x = (a as { value: { data: [string, string] } }).value;
      const d = base64.decode(x.data[0]);
      const dv = new DataView(d.buffer, d.byteOffset);
      dv.setBigUint64(49, dv.getBigUint64(49, true) + 1024n, true);
      return { ...(a as object), value: { ...x, data: [base64.encode(d), "base64"] } };
    });
  };
  const got = await runPoolDeposit(host(c, ns, { rpcs: [stale(c.rpc()), stale(c.rpc())] }), ask(RUNG));
  assert.equal((got as { stage?: string }).stage, "filled", JSON.stringify(got));
  assert.equal(c.lamports(u.address), 0);
});

test("F1/M10: RPCs that disagree on rent are refused before anything is signed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const rent = (address: string, a: Acc): Acc => {
    if (address !== FIX.addresses.rent) return a;
    const d = a.data.slice();
    new DataView(d.buffer).setBigUint64(0, BigInt(PER_BYTE + 1), true);
    return { ...a, data: d };
  };
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ mapAccount: rent })] }), ask(RUNG)), { error: "failed" });
  assert.equal(c.sent.length, 0);
});

test("F1/M18: a pool account RPC 1 gives with another owner in the deposit's read is refused before anything is signed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const owner = remap(c.rpc(), "getMultipleAccounts", (params, a) => {
    const keys = params[0] as string[];
    return { ...(a as object), value: (a as { value: ({ owner: string } | null)[] }).value.map((x, i) => (keys[i] === FIX.pool && x ? { ...x, owner: "BPFLoaderUpgradeab1e11111111111111111111111" } : x)) };
  });
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), owner] }), ask(RUNG)), { error: "failed" });
  assert.equal(c.sent.length, 0);
});

test("F1/M16: a mark the two RPCs give at different nonces is never settled on one's word: the note stays INCOMING, answered sent; it lands once both agree", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const other = (_: string, a: Acc): Acc => {
    if (a.owner !== FIX.program || a.data.length !== 17) return a;
    const d = a.data.slice();
    const dv = new DataView(d.buffer);
    dv.setBigUint64(8, dv.getBigUint64(8, true) + 1n, true);
    return { ...a, data: d };
  };
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [c.rpc(), c.rpc({ mapAccount: other })] }), ask(RUNG)), { stage: "sent", txs: [{ chain: "solana", hash: c.sent[0] }] });
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["INCOMING"]);
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[0] }] });
});

test("F5: the pool's own balance past 2^53 lamports is never parsed (it is never priced): the deposit lands", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, Number(RUNG) + COST);
  const rich = (address: string, a: Acc): Acc => (address === FIX.pool || address === FIX.addresses.rent ? { ...a, lamports: 2 ** 60 } : a);
  const got = await runPoolDeposit(host(c, ns, { rpcs: [c.rpc({ mapAccount: rich }), c.rpc({ mapAccount: rich })] }), ask(RUNG));
  assert.equal((got as { stage?: string }).stage, "filled", JSON.stringify(got));
});

test("F6: a send built again whose simulation fails on an RPC (the pool moving under the read, a node behind) is never stuck: page load answers not_landed with no top-up, and a later load sends it again and it lands", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  c.lands = false; // dropped, unseen
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG)), { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[0] }] });
  c.height += 1_000; // its blockhash expired on both: built again at the next load
  const short: [string, bigint][] = [];
  assert.deepEqual(await settlePoolDeposits(host(c, ns, { rpcs: [c.rpc(), c.rpc({ simFails: true })], short: shortsOf(short) })), { stage: "not_landed", txs: [] });
  assert.deepEqual(short, [], "no top-up named: U is not short");
  assert.equal(c.sent.length, 1, "nothing signed on a failed simulation");
  c.lands = true;
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "not_landed", txs: [{ chain: "solana", hash: c.sent[1] }] });
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "filled", txs: [{ chain: "solana", hash: c.sent[1] }] });
});

// card pool-answer-unknown, its independent review (FIX, 91056543): the probes P1, P5 and P6 and the mutants G and J,
// each a test here with the answer the device must give.
const down = () => new SolanaRpcTransportError("http_429", "HTTP 429", 4, "provider.down.example");
const RENT_SYSVAR = FIX.addresses.rent;
/** A two-rung ask's RPCs: rung 1's tx lands though both RPCs reject its sendTransaction (h.sent never fires) and both
 *  history reads fail (no tx named for it); then rung 2's state read is down, or RPC 1 refuses its blockhash. */
function p1Rpcs(c: ReturnType<typeof chain>, rung2: "transport" | "refused"): readonly [SolanaRpc, SolanaRpc] {
  const w = (rpc: SolanaRpc, k: number): SolanaRpc => async (m, p) => {
    if (m === "sendTransaction") {
      await rpc(m, p);
      throw down();
    }
    if (m === "getSignatureStatuses" && optsOf(p)?.searchTransactionHistory === true && c.sent.length >= 1) throw down();
    if (rung2 === "transport" && c.sent.length >= 1 && m === "getMultipleAccounts" && (p[0] as string[]).includes(RENT_SYSVAR)) throw down();
    if (rung2 === "refused" && k === 1 && c.sent.length >= 1 && m === "isBlockhashValid") return { context: { slot: 1 }, value: false };
    return rpc(m, p);
  };
  return [w(c.rpc(), 0), w(c.rpc(), 1)] as const;
}

for (const rung2 of ["transport", "refused"] as const) {
  test(`review P1 (${rung2}): a rung that landed with no tx named is always in the answer: rung 2 ${rung2 === "transport" ? "down" : "refused"} before it signs answers part_filled, never failed or down`, async () => {
    const c = chain();
    const ns = await notes();
    c.fund((await plannedU(ns)).address, 100_000_000);
    const a = await runPoolDeposit(host(c, ns, { rpcs: p1Rpcs(c, rung2) }), ask(3n * RUNG));
    assert.deepEqual(a, { stage: "part_filled", txs: [] });
    assert.equal(c.sent.length, 1);
    assert.deepEqual((await ours(ns)).map((n) => n.state).sort(), ["PLANNED", "UNSPENT"]);
  });
}

test("review P1 via the kind: the app is answered part_filled for a landed rung with no tx named, never failed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  const kind = poolDepositKind(() => ({ ...host(c, ns, { rpcs: p1Rpcs(c, "transport") }), end: ended }));
  const r = kind(ask(3n * RUNG), { id: "p1", sha: "00", progress: () => {} });
  assert.ok("running" in r);
  await r.after;
  await done;
  assert.deepEqual(r.answer(), { result: { stage: "part_filled", txs: [] } });
});

test("review P5: a page-load pass that sends an earlier note again never makes the ask's own read fault answer failed: nothing of the ask was signed, down", async () => {
  const c = chain();
  const ns = await notes();
  const u1 = await plannedU(ns);
  c.fund(u1.address, Number(RUNG) + COST + EMPTY_RENT + 50 * FEE);
  c.failNext = 1_000;
  assert.equal(((await runPoolDeposit(host(c, ns, { reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  c.failNext = 0;
  const before = c.sent.length;
  // the ask's own state read (not U1's) is down
  const w = (rpc: SolanaRpc): SolanaRpc => async (m, p) => {
    if (m === "getMultipleAccounts" && (p[0] as string[]).includes(RENT_SYSVAR) && !(p[0] as string[]).includes(u1.address)) throw down();
    return rpc(m, p);
  };
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  const kind = poolDepositKind(() => ({ ...host(c, ns, { rpcs: [w(c.rpc()), w(c.rpc())] }), end: ended }));
  const r = kind(ask(RUNG), { id: "p5", sha: "00", progress: () => {} });
  assert.ok("running" in r);
  await r.after;
  await done;
  assert.equal(c.sent.length - before, 1, "the pass sent the earlier note again");
  assert.deepEqual(r.answer(), { error: "down" });
});

test("review P6: one RPC's low last valid height never reads a live send expired: no send again while its blockhash has blocks left on either RPC", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, Number(RUNG) + COST + EMPTY_RENT + 10 * FEE);
  const r0 = c.rpc();
  const low: SolanaRpc = async (m, p) => {
    const a = (await r0(m, p)) as { value?: { lastValidBlockHeight?: number } };
    return m === "getLatestBlockhash" ? { ...a, value: { ...a.value, lastValidBlockHeight: c.height + 2 } } : a;
  };
  c.lands = false;
  await runPoolDeposit(host(c, ns, { rpcs: [low, c.rpc()], reads: 1 }), ask(RUNG));
  c.height += 10; // past RPC 0's word, 140 blocks inside the blockhash's life
  assert.deepEqual(await settlePoolDeposits(host(c, ns)), { stage: "not_landed", txs: [] });
  assert.equal(c.sent.length, 1, "never built again while the first send's blockhash lives");
  c.height += 200; // past it on both
  c.lands = true;
  assert.equal(((await settlePoolDeposits(host(c, ns))) as { stage: string }).stage, "not_landed");
  assert.equal(c.sent.length, 2, "built again once expired on both");
});

test("review G: a send built again on its blockhash's expiry never counts toward POOL_DEPOSIT_REBUILDS: after one, the run still builds again on each failure up to the cap and lands", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, Number(RUNG) + COST + EMPTY_RENT + 50 * FEE);
  c.lands = false; // the first send is dropped
  let bumped = false;
  const wait = async () => {
    if (bumped) return;
    bumped = true;
    c.height += 1_000; // the first send's blockhash expires: built again on expiry
    c.lands = true;
    c.failNext = POOL_DEPOSIT_REBUILDS; // that send and the first failure rebuild fail on chain
  };
  const got = await runPoolDeposit(host(c, ns, { reads: POOL_DEPOSIT_READS, wait }), ask(RUNG));
  assert.equal(c.sent.length, 2 + POOL_DEPOSIT_REBUILDS, "the dropped send, its expiry rebuild, then POOL_DEPOSIT_REBUILDS failure rebuilds");
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: c.sent.at(-1) }] });
});

test("review J (r2: down): a provider fault after the ask's only send was taken, with nothing of the ask landed and no send of it that may still land, answers down, so the user can ask again", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const base = c.rpc();
  let raced = false;
  const racing: SolanaRpc = async (m, p) => {
    if (m === "sendTransaction" && !raced) {
      raced = true;
      c.apply(attackerTx(c, preOf(base64.decode(p[0] as string)), MIN_DEPOSIT)); // lands first: the note is taken
    }
    if (raced && m === "getMultipleAccounts" && (p[0] as string[]).includes(RENT_SYSVAR)) throw down(); // the next note's read
    return base(m, p);
  };
  const other = c.rpc();
  const both: SolanaRpc = async (m, p) => {
    if (raced && m === "getMultipleAccounts" && (p[0] as string[]).includes(RENT_SYSVAR)) throw down();
    return other(m, p);
  };
  assert.deepEqual(await runPoolDeposit(host(c, ns, { rpcs: [racing, both] }), ask(RUNG)), { error: "down" });
  assert.equal(c.sent.length, 1);
  assert.deepEqual(await shape(ns), [
    ["deposit", "UNSPENT", MIN_DEPOSIT],
    ["second", "PLANNED", undefined],
  ]);
});

// card pool-answer-unknown, delta review r2 (FIX, 4c38ff10): P8 and the reads of `landed` (mutants L1-L4).

test("review P8: RPC 0's height read 5 blocks behind the node that gave its blockhash (a load-balanced URL), and RPC 1's 100 low, never read a live send expired: no send again before the blockhash's true expiry", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, Number(RUNG) + COST + EMPTY_RENT + 10 * FEE);
  const behind = (rpc: SolanaRpc, n: number): SolanaRpc => async (m, p) => {
    const a = await rpc(m, p);
    return m === "getBlockHeight" && optsOf(p)?.commitment === "confirmed" ? (a as number) - n : a;
  };
  c.lands = false;
  const said = c.height + 150; // the blockhash RPC 0 gives lives to here
  await runPoolDeposit(host(c, ns, { rpcs: [behind(c.rpc(), 5), behind(c.rpc(), 100)], reads: 1 }), ask(RUNG));
  const [n] = await ours(ns);
  assert.equal(n!.sends![0]!.last_valid_block_height, BigInt(said), "RPC 0's word stands: its height read 5 behind never caps it lower");
  c.height = said - 2; // finalized two blocks before the true expiry on both
  await settlePoolDeposits(host(c, ns));
  assert.equal(c.sent.length, 1, "built again while the first send's blockhash still lives");
  c.height = said + 1;
  c.lands = true;
  await settlePoolDeposits(host(c, ns));
  assert.equal(c.sent.length, 2, "built again once past it");
});

/** RPCs whose history reads fail from the first send on: a rung that lands is read landed with no tx named. `over`
 *  maps each RPC's other calls (k: which RPC). */
function unnamed(c: ReturnType<typeof chain>, rpcs: readonly [SolanaRpc, SolanaRpc] = [c.rpc(), c.rpc()], over?: (k: number, rpc: SolanaRpc) => SolanaRpc): readonly [SolanaRpc, SolanaRpc] {
  const w = (rpc: SolanaRpc, k: number): SolanaRpc => {
    const inner = over ? over(k, rpc) : rpc;
    return async (m, p) => {
      if (m === "getSignatureStatuses" && optsOf(p)?.searchTransactionHistory === true && c.sent.length >= 1) throw down();
      return inner(m, p);
    };
  };
  return [w(rpcs[0], 0), w(rpcs[1], 1)] as const;
}

test("review L1: a rung landed with no tx named, then the next note's precommitment taken on one RPC only: part_filled with the landed rung, never not_landed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const lagging = { on: false };
  const lag = (_: string, a: Acc): Acc => (lagging.on && a.owner === FIX.program && a.data.length === 17 ? { owner: SYSTEM, lamports: 1_000_000, data: new Uint8Array(0) } : a);
  const front = (k: number, rpc: SolanaRpc): SolanaRpc => async (m, p) => {
    if (k === 0 && m === "simulateTransaction" && c.sent.length >= 1 && !lagging.on) {
      c.apply(attackerTx(c, preOf(base64.decode(p[0] as string)), MIN_DEPOSIT)); // rung 2's precommitment, taken first
      lagging.on = true; // RPC 1's finalized view lacks the new mark
    }
    return rpc(m, p);
  };
  const got = await runPoolDeposit(host(c, ns, { rpcs: unnamed(c, [c.rpc(), c.rpc({ mapAccount: lag })], front) }), ask(3n * RUNG));
  assert.ok(lagging.on, "rung 2's precommitment was taken");
  assert.equal(c.sent.length, 1);
  assert.deepEqual(got, { stage: "part_filled", txs: [] });
});

test("review L2: a rung landed with no tx named, then U short for the next rung: part_filled with the landed rung, never not_funded", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 100_000_000);
  const short: [string, bigint][] = [];
  const got = await runPoolDeposit(host(c, ns, { rpcs: unnamed(c), short: shortsOf(short), landed: () => void (c.accounts.get(u.address)!.lamports = 0) }), ask(3n * RUNG));
  assert.equal(c.sent.length, 1);
  assert.deepEqual(got, { stage: "part_filled", txs: [] });
});

test("pool-deposit-sent-end fold review 1: a two-rung ask whose first rung lands and whose second U cannot pay tells the app part_filled once, never filled at the first rung", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 100_000_000);
  const stages: string[] = [];
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  // rung 1 lands, then U is drained: rung 2 is short
  const kind = poolDepositKind(() => ({ ...host(c, ns, { landed: () => void (c.accounts.get(u.address)!.lamports = 0) }), end: ended }));
  const r = kind(ask(3n * RUNG), { id: "f1", sha: "00", progress: (s) => void stages.push(String(s)) });
  assert.ok("running" in r);
  await r.after;
  await done;
  assert.deepEqual(r.answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: c.sent[0] }] } });
  assert.equal(c.sent.length, 1);
  assert.deepEqual(stages, ["part_filled"], "one end, the real one: no filled for rung 1");
});

test("review L3: a rung landed with no tx named, then the kit refuses the next rung's pool read: part_filled with the landed rung, never failed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const after = { on: false };
  const other = (address: string, a: Acc): Acc => (after.on && address === FIX.pool ? { ...a, owner: SYSTEM } : a);
  const got = await runPoolDeposit(host(c, ns, { rpcs: unnamed(c, [c.rpc({ mapAccount: other }), c.rpc({ mapAccount: other })]), landed: () => void (after.on = true) }), ask(3n * RUNG));
  assert.equal(c.sent.length, 1);
  assert.deepEqual(got, { stage: "part_filled", txs: [] });
});

test("review L4: a page-load pass where one note lands with no tx named and another is stuck on its top-up answers not_landed, never not_funded", async () => {
  const c = chain();
  const ns = await notes();
  const u1 = await plannedU(ns);
  c.fund(u1.address, Number(RUNG) + COST + EMPTY_RENT + 10 * FEE);
  const kept: string[] = [];
  const keep = (rpc: SolanaRpc): SolanaRpc => async (m, p) => {
    if (m === "sendTransaction") kept.push(p[0] as string);
    return rpc(m, p);
  };
  c.lands = false; // note A's send is dropped, kept here
  assert.equal(((await runPoolDeposit(host(c, ns, { rpcs: [keep(c.rpc()), c.rpc()], reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed");
  const u2 = await plannedU(ns);
  assert.notEqual(u2.address, u1.address);
  c.fund(u2.address, Number(RUNG) + COST + EMPTY_RENT + 10 * FEE);
  assert.equal(((await runPoolDeposit(host(c, ns, { reads: 1 }), ask(RUNG))) as { stage: string }).stage, "not_landed"); // note B on U2, dropped
  c.lands = true;
  c.apply(base64.decode(kept[0]!)); // A's send lands late
  c.height += 1_000; // B's send past its last valid height
  c.accounts.get(u2.address)!.lamports = 0; // U2 cannot pay B's send again
  const sent = c.sent.length;
  const got = await settlePoolDeposits(host(c, ns, { rpcs: unnamed(c) }));
  assert.equal(c.sent.length, sent, "nothing sent");
  assert.deepEqual(await shape(ns).then((s) => s.map((x) => x[1]).sort()), ["INCOMING", "UNSPENT"]);
  assert.deepEqual(got, { stage: "not_landed", txs: [] });
});

// Card pool-deposit-sent-end: after the kind answers "sent", the app hears the deposit's end. not_landed only once no
// send of the ask can land: each one past its last valid height at finalized on both RPCs (or failed on both) with no
// mark, or taken (the precommitment's mark holds another deposit on both); a send that lands late is "filled".
/** The kind run with its stages: `ran` once the run ends; every wait after that (the end's reads) parks until `go`. */
function followed(c: ReturnType<typeof chain>, ns: NoteStore, over: Partial<PoolDepositHost> = {}, a: PoolAsk = ask(RUNG)) {
  const stages: string[] = [];
  let ended = false;
  let ran!: () => void;
  const runEnd = new Promise<void>((r) => (ran = r));
  const parked: (() => void)[] = [];
  let onPark: (() => void) | null = null;
  let onStage: (() => void) | null = null;
  const wait = async (): Promise<void> => {
    if (!ended) return;
    await new Promise<void>((r) => {
      parked.push(r);
      onPark?.();
    });
  };
  const kind = poolDepositKind(() => ({ ...host(c, ns, { wait, ...over }), end: () => ((ended = true), ran()) }));
  const r = kind(a, { id: "e1", sha: "00", progress: (s) => (stages.push(String(s)), onStage?.()) });
  const within = (p: Promise<void>, ms = 2_000): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), ms))]);
  return {
    r,
    stages,
    runEnd,
    /** the end's reads parked at their next wait (false: none within the time, so nothing follows the send) */
    parked: () => within(new Promise<void>((ok) => (parked.length ? ok() : (onPark = ok)))),
    /** a stage posted (false: none within the time) */
    staged: (n: number) => within(new Promise<void>((ok) => (stages.length >= n ? ok() : (onStage = () => stages.length >= n && ok())))),
    go: () => parked.splice(0).forEach((f) => f()),
  };
}

test("pool-deposit-sent-end, review pool-answer-unknown r2 item 5: the only send taken, then a provider down: the app hears not_landed, never left at sent", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const base = c.rpc();
  let sends = 0;
  let blockhashes = 0;
  const racing: SolanaRpc = async (method, params) => {
    if (method === "getLatestBlockhash" && ++blockhashes > 1) throw new SolanaRpcTransportError("http_429", "HTTP 429", 4, "provider.down.example");
    if (method === "sendTransaction" && sends++ === 0) c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), MIN_DEPOSIT));
    return base(method, params);
  };
  const f = followed(c, ns, { rpcs: [racing, c.rpc()] });
  await (f.r as { after: Promise<void> }).after;
  assert.deepEqual((f.r as { answer(): unknown }).answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: c.sent[0] }] } });
  await f.runEnd;
  assert.equal(await f.staged(1), true, `no end told: ${JSON.stringify(f.stages)}`);
  assert.deepEqual(f.stages, ["not_landed"]);
  assert.equal(c.sent.length, 1, "nothing sent past the take");
  assert.deepEqual(await shape(ns), [["deposit", "UNSPENT", MIN_DEPOSIT], ["second", "PLANNED", undefined]], "the front-runner's deposit is the user's note; the rung's money stays in U");
});

test("pool-deposit-sent-end review 1 (repro R): every send of the ask past its last valid height on both RPCs with no mark is no end: the pass builds the note again from U's money, so the app is never told not_landed; the end's reads start the pass and follow the rebuilt send to filled", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  c.lands = false; // the send is dropped
  let kicks = 0;
  const ahead = (rpc: SolanaRpc): SolanaRpc => async (m, p) => (m === "getEpochInfo" && (p[0] as { commitment?: string })?.commitment === "finalized" ? { ...((await rpc(m, p)) as object), blockHeight: c.height + 10_000 } : rpc(m, p));
  const f = followed(c, ns, { rpcs: [c.rpc(), ahead(c.rpc())], settle: () => void kicks++ });
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  assert.deepEqual(f.stages, [], "nothing told at the run's end while the send may land");
  assert.equal(await f.parked(), true, "the end's reads go on while the send may land");
  for (let k = 0; k < 3; k++) {
    f.go();
    assert.equal(await f.parked(), true);
  }
  assert.deepEqual(f.stages, [], "one RPC's expiry alone tells the app nothing");
  assert.equal(kicks, 0, "no pass started while a send may land");
  c.height += 1_000; // past the last valid height on both, no mark
  f.go();
  assert.equal(await f.parked(), true, "every send dead with no mark is no end: the reads go on");
  assert.deepEqual(f.stages, [], "never not_landed for a note the pass builds again");
  assert.equal(kicks, 1, "the end's reads start the pass");
  // the page's passes (the state read the kick starts): the same note built again from U's money, then it lands
  c.lands = true;
  assert.equal(((await settlePoolDeposits(host(c, ns))) as { stage: string }).stage, "not_landed", "built again and sent: pending");
  assert.equal(((await settlePoolDeposits(host(c, ns))) as { stage: string }).stage, "filled");
  assert.deepEqual((await ours(ns)).map((n) => n.state), ["UNSPENT"]);
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"], "the ask's end is the rebuilt send's landing, never not_landed");
  assert.equal(c.sent.length, 2);
});

test("pool-deposit-sent-end review 1: a note the pass cannot build again (U short of its send again) is no end either: nothing told, the reads back off to POOL_DEPOSIT_FOLLOW_MAX_MS and go on past an hour (fold review 5: no give-up); a top-up after the hour lands it and the app is told filled, never not_landed", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  c.lands = false;
  const waits: number[] = [];
  let ended = false;
  let open!: () => void;
  let cut = false;
  let topped = false;
  const gate = new Promise<void>((r) => (open = r));
  const stages: string[] = [];
  const shorts: bigint[] = [];
  let passing: Promise<unknown> | null = null;
  const kind = poolDepositKind(() => ({
    ...host(c, ns),
    wait: async (ms: number) => {
      if (!ended) return;
      await gate;
      if (cut) throw new Error("cut");
      waits.push(ms);
      // the top-up comes past an hour of the end's reads
      if (!topped && waits.reduce((a, b) => a + b, 0) > 3_600_000) {
        topped = true;
        assert.deepEqual(stages, [], "nothing told while U is short: the note may still land once U is topped up");
        assert.ok(shorts.length > 0, "the pass was started and named the top-up");
        assert.equal(c.sent.length, 1, "nothing sent while U is short");
        c.fund(u.address, 50_000_000);
        c.lands = true;
      }
    },
    // the page's pass, one at a time (pool-testnet.ts settleSolana), as the kick starts it
    settle: () => void (passing ??= settlePoolDeposits(host(c, ns, { short: (_, l) => void shorts.push(l) })).finally(() => (passing = null))),
    // at the run's end, before the end's first read (fold review 2: set here, never raced by a poll): dead on both, and
    // U below the rung and its costs, so the pass's send again is short (fees and rent rose)
    end: () => {
      c.height += 1_000;
      c.accounts.get(u.address)!.lamports = 1_000_000;
      ended = true;
    },
  }));
  const r = kind(ask(RUNG), { id: "e2", sha: "00", progress: (s) => void stages.push(String(s)) }) as { after: Promise<void> };
  await r.after;
  open();
  // until the app is told (a follow that gives up never tells: cut at 10 s, and fails below)
  for (const t0 = Date.now(); stages.length === 0 && Date.now() - t0 < 10_000; ) await new Promise((ok) => setTimeout(ok, 20));
  cut = true;
  await passing;
  assert.equal(topped, true, `the reads went on past an hour: ${waits.reduce((a, b) => a + b, 0)} ms`);
  assert.deepEqual(waits.slice(0, 7), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000], "doubling from 2 s to 60 s, every send dead from the first read");
  assert.deepEqual(stages, ["filled"], "the top-up's landing told, never not_landed");
  assert.equal(c.sent.length, 2, "built again once, from U's topped-up money");
});

test("pool-deposit-sent-end fold review 6: the end's reads read each note's record read only (records), never opening the note store, whose open and list settle under the notes lock and may write", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  let opens = 0;
  let reads = 0;
  const f = followed(c, ns, { notes: async () => (opens++, ns), records: async () => (reads++, ns.list()) });
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  const atEnd = opens;
  assert.equal(await f.parked(), true);
  f.go();
  assert.equal(await f.parked(), true);
  assert.ok(reads >= 2, `the record read on each read: ${reads}`);
  assert.equal(opens, atEnd, "the note store is never opened by the end's reads");
});

test("pool-deposit-sent-end fold review 4 X14: a read that fails (a provider down) backs the end's reads off, 2 s doubling to 60 s, never read as a send that may land", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  const waits: number[] = [];
  let ended = false;
  let cut = false;
  const downed = (rpc: SolanaRpc): SolanaRpc => async (m, p) => {
    if (ended) throw new SolanaRpcTransportError("http_429", "HTTP 429", 4, "provider.down.example");
    return rpc(m, p);
  };
  const kind = poolDepositKind(() => ({
    ...host(c, ns, { rpcs: [downed(c.rpc()), c.rpc()] }),
    wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (ended) waits.push(ms);
    },
    end: () => void (ended = true),
  }));
  await (kind(ask(RUNG), { id: "e5", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  for (const t0 = Date.now(); waits.length < 7 && Date.now() - t0 < 10_000; ) await new Promise((ok) => setTimeout(ok, 20));
  cut = true;
  assert.deepEqual(waits.slice(0, 7), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
});

test("pool-deposit-sent-end review 4: the end's reads stop when the page leaves the deposit (signal aborted at sign out): no read, no stage", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  const out = new AbortController();
  const f = followed(c, ns, { signal: out.signal });
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  const before = c.calls.length;
  out.abort();
  c.lands = true;
  c.height += 1_000;
  f.go();
  assert.equal(await f.parked(), false, "no read after the sign out");
  assert.equal(c.calls.length, before, "no RPC call after the sign out");
  assert.deepEqual(f.stages, []);
});

test("pool-deposit-sent-end review 2 (repro Q): the mark is read at or past each RPC's slot of its finalized height (minContextSlot): a node behind answers -32016 and is read again, so a deposit that landed late in its life is filled, never not_landed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  const kept: string[] = [];
  let behind = 0;
  let stale = 0;
  // a load-balanced URL: each finalized mark read goes first to a node whose finalized view predates the deposit's slot.
  // A real node answers a read below minContextSlot with -32016; with no minContextSlot it answers its stale view
  const lb = (rpc: SolanaRpc, keep: boolean): SolanaRpc => async (m, p) => {
    if (keep && m === "sendTransaction") kept.push(p[0] as string);
    const o = (p[1] ?? {}) as { commitment?: string; minContextSlot?: number };
    if (behind > 0 && m === "getAccountInfo" && o.commitment === "finalized") {
      behind--;
      const r = (await rpc(m, p)) as { context: { slot: number } };
      const nodeSlot = r.context.slot - 100;
      if (o.minContextSlot !== undefined && o.minContextSlot > nodeSlot) throw new Error(`RPC error -32016: Minimum context slot has not been reached`);
      stale++;
      return { context: { slot: nodeSlot }, value: null };
    }
    return rpc(m, p);
  };
  const f = followed(c, ns, { rpcs: [lb(c.rpc(), true), lb(c.rpc(), false)] });
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  c.lands = true;
  c.apply(base64.decode(kept[0]!)); // it lands, late in its life
  c.height += 1_000; // and the finalized height is past its last valid height on both
  behind = 2; // each RPC's next mark read hits the node behind
  f.go();
  assert.equal(await f.parked(), true, "a node behind the height's slot is read again after a wait");
  assert.deepEqual(f.stages, []);
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"], "never not_landed for a deposit that landed");
  assert.equal(stale, 0, "no stale mark read was ever taken for no mark");
});

test("pool-deposit-sent-end: a send that lands late, before its last valid height, gives filled and never not_landed", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  const kept: string[] = [];
  const base = c.rpc();
  const keep: SolanaRpc = async (m, p) => {
    if (m === "sendTransaction") kept.push(p[0] as string);
    return base(m, p);
  };
  const f = followed(c, ns, { rpcs: [keep, c.rpc()] });
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  assert.deepEqual(f.stages, [], "nothing told at the run's end while the send may land");
  assert.equal(await f.parked(), true, "the end's reads go on while the send may land");
  c.lands = true;
  c.apply(base64.decode(kept[0]!)); // lands at height + 40, well before its last valid height (+ 150)
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"]);
  assert.equal(c.sent.length, 1, "never sent again");
});

test("pool-deposit-sent-end review 3: rung 1 landed, rung 2 sent, then a provider read down: no end at part_filled while rung 2 may land; its send is read on and the ask ends filled once it lands", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const kept: string[] = [];
  let sends = 0;
  let down2 = false;
  const base = c.rpc();
  const w: SolanaRpc = async (m, p) => {
    if (m === "sendTransaction" && ++sends === 2) {
      c.lands = false; // rung 2 is dropped for now
      kept.push(p[0] as string);
      down2 = true;
    }
    // the run's read back of rung 2 (its finalized height): a provider down
    if (down2 && (m === "getEpochInfo" || (m === "getBlockHeight" && optsOf(p)?.commitment === "finalized"))) throw down();
    return base(m, p);
  };
  const f = followed(c, ns, { rpcs: [w, c.rpc()] }, ask(3n * RUNG));
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  down2 = false;
  assert.equal(c.sent.length, 2);
  assert.deepEqual(f.stages, ["sent"], "rung 2's send only: rung 1's landing is no end (fold review 1), and never part_filled while rung 2 may land");
  assert.equal(await f.parked(), true, "rung 2's send is read on");
  c.lands = true;
  c.apply(base64.decode(kept[0]!));
  f.go();
  assert.equal(await f.staged(2), true);
  assert.deepEqual(f.stages, ["sent", "filled"], "the whole ask went in: filled, once");
});

test("pool-deposit-sent-end review 5: the only send taken, then a raw store error past it: the run's throw still hands the kind its end (not_landed), never left at sent", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 50_000_000);
  const base = c.rpc();
  let sends = 0;
  const racing: SolanaRpc = async (method, params) => {
    if (method === "sendTransaction" && sends++ === 0) c.apply(attackerTx(c, preOf(base64.decode(params[0] as string)), MIN_DEPOSIT));
    return base(method, params);
  };
  // the rung's next note cannot be written: a raw store fault (not a Refused, not a provider's)
  const broken: NoteStore = new Proxy(ns, { get: (t, k) => (k === "add" ? async () => { throw new Error("store write failed"); } : (t as unknown as Record<string | symbol, unknown>)[k as string]) }) as NoteStore;
  const f = followed(c, ns, { rpcs: [racing, c.rpc()], notes: async () => broken });
  await (f.r as { after: Promise<void> }).after;
  assert.deepEqual((f.r as { answer(): unknown }).answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: c.sent[0] }] } });
  await f.runEnd;
  assert.equal(await f.staged(1), true, `no end told: ${JSON.stringify(f.stages)}`);
  assert.deepEqual(f.stages, ["not_landed"]);
});

// Card pool-deposit-sent-end review 8: the rules the reviewer's mutants showed unplanted, each planted here
// (test/pool-deposit-mutants.mjs runs each mutant against its named test).
/** The ask's send dropped and kept (`kept`), the run ended and the end's reads parked. */
async function droppedAndFollowed(over: Partial<PoolDepositHost> = {}, a: PoolAsk = ask(RUNG), wrap?: (c: ReturnType<typeof chain>, rpc: SolanaRpc, k: number) => SolanaRpc) {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 100_000_000);
  c.lands = false;
  const kept: string[] = [];
  const keep = (rpc: SolanaRpc, k: number): SolanaRpc => async (m, p) => {
    if (k === 0 && m === "sendTransaction") kept.push(p[0] as string);
    return rpc(m, p);
  };
  const rpcs = [0, 1].map((k) => keep(wrap ? wrap(c, c.rpc(), k) : c.rpc(), k)) as unknown as readonly [SolanaRpc, SolanaRpc];
  let kicks = 0;
  const f = followed(c, ns, { rpcs, settle: () => void kicks++, ...over }, a);
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  return { c, ns, u, f, kept, kicks: () => kicks };
}

test("review 8 S1: the follower reads the heights before the mark: a send that lands and finalizes between the two reads is filled at that read, never read dead (no pass started)", async () => {
  let plant: (() => void) | null = null;
  const d = await droppedAndFollowed({}, ask(RUNG), (_c, rpc) => async (m, p) => {
    if (m === "getEpochInfo" && plant) (plant(), (plant = null));
    return rpc(m, p);
  });
  plant = () => {
    d.c.lands = true;
    d.c.apply(base64.decode(d.kept[0]!));
    d.c.height += 1_000;
  };
  d.f.go();
  assert.equal(await d.f.staged(1), true, "filled at that read");
  assert.deepEqual(d.f.stages, ["filled"]);
  assert.equal(d.kicks(), 0, "never read dead");
});

test("review 8 S3: a mark one RPC holds and the other not yet is no end: nothing told until both hold it", async () => {
  let hide = true;
  const d = await droppedAndFollowed({}, ask(RUNG), (c, rpc, k) => (k === 1 ? async (m, p) => {
    const r = await rpc(m, p);
    if (hide && m === "getAccountInfo" && isMark(c)(p[0] as string)) return { ...(r as object), value: null };
    return r;
  } : rpc));
  d.c.lands = true;
  d.c.apply(base64.decode(d.kept[0]!));
  d.f.go();
  assert.equal(await d.f.parked(), true);
  assert.deepEqual(d.f.stages, [], "one RPC's mark tells nothing");
  hide = false;
  d.f.go();
  assert.equal(await d.f.staged(1), true);
  assert.deepEqual(d.f.stages, ["filled"]);
});

test("review 8 S4: a note with a send dead and a send built again still live is no dead read: no pass started, the reads stay at their base wait", async () => {
  const d = await droppedAndFollowed();
  d.c.height += 1_000; // the first send past its life on both
  assert.equal(((await settlePoolDeposits(host(d.c, d.ns))) as { stage: string }).stage, "not_landed", "the pass builds it again: a live second send");
  assert.equal((await ours(d.ns))[0]!.sends!.length, 2);
  d.f.go();
  assert.equal(await d.f.parked(), true);
  assert.deepEqual(d.f.stages, []);
  assert.equal(d.kicks(), 0, "a live send of the note keeps it from a dead read");
});

test("review 8 S5 and S6: a mark of another value while both RPCs saying a send of the note succeeded is a contradiction, no end; a take read from the store (restored at another value) is not_landed, never filled", async () => {
  // the chain read: a front-runner's MIN_DEPOSIT on the note's precommitment, and both RPCs saying the note's send succeeded
  const d = await droppedAndFollowed();
  const pre = (await ours(d.ns))[0]!.precommitment;
  d.c.lands = true;
  d.c.apply(attackerTx(d.c, pre, MIN_DEPOSIT));
  assert.equal(d.c.accounts.get(markOf(pre))?.data.length, 17, "the front-runner's mark");
  const sig = (await ours(d.ns))[0]!.sends![0]!.signature;
  d.c.statuses.set(sig, { err: null, confirmationStatus: "finalized" });
  d.f.go();
  assert.equal(await d.f.parked(), true);
  assert.deepEqual(d.f.stages, [], "a mark that contradicts both RPCs' word is no end");
  d.c.statuses.delete(sig);
  d.f.go();
  assert.equal(await d.f.staged(1), true);
  assert.deepEqual(d.f.stages, ["not_landed"], "taken: the rung's money stays in U");
  // the store read: the pass restored the take (UNSPENT at MIN_DEPOSIT) before the end's read
  const e = await droppedAndFollowed();
  e.c.lands = true;
  e.c.apply(attackerTx(e.c, (await ours(e.ns))[0]!.precommitment, MIN_DEPOSIT));
  await settlePoolDeposits(host(e.c, e.ns));
  assert.deepEqual((await ours(e.ns)).map((n) => [n.state, n.leaf?.value]), [["UNSPENT", MIN_DEPOSIT]]);
  e.f.go();
  assert.equal(await e.f.staged(1), true);
  assert.deepEqual(e.f.stages, ["not_landed"], "restored at another value: never filled");
});

test("review 8 S7: a mark at the note's value whose leaf does not check out is no landing: nothing told", async () => {
  const d = await droppedAndFollowed();
  d.c.lands = true;
  d.c.wrongLeaf = true; // the state leaf written is not the deposit's
  d.c.apply(base64.decode(d.kept[0]!));
  d.f.go();
  assert.equal(await d.f.parked(), true);
  assert.deepEqual(d.f.stages, [], "never filled on a mark whose leaf is not in the tree");
});

test("review 8 S9 and S13: an ask whose run ended before its last rung was sent ends part_filled when its sent rung lands, never filled", async () => {
  const d = await droppedAndFollowed({}, ask(3n * RUNG)); // rungs 0.02 and 0.01: the run ends pending on the first
  assert.equal(d.c.sent.length, 1, "rung 2 never sent");
  d.c.lands = true;
  d.c.apply(base64.decode(d.kept[0]!));
  d.f.go();
  assert.equal(await d.f.staged(1), true);
  assert.deepEqual(d.f.stages, ["part_filled"]);
});

test("review 8 S12: the end reads only the sends the run left open: a taken send before the rung's next note is no part of it, and that note's landing fills the ask", async () => {
  let sends = 0;
  const d = await droppedAndFollowed({}, ask(RUNG), (c, rpc, k) => async (m, p) => {
    // the first send is front-run (its rung goes on U's next note, in the run); that next send is dropped
    if (k === 0 && m === "sendTransaction" && sends++ === 0) {
      c.lands = true;
      c.apply(attackerTx(c, preOf(base64.decode(p[0] as string)), MIN_DEPOSIT));
      const r = await rpc(m, p);
      c.lands = false;
      return r;
    }
    return rpc(m, p);
  });
  assert.equal(d.c.sent.length, 2);
  d.c.lands = true;
  d.c.apply(base64.decode(d.kept[1]!));
  d.f.go();
  assert.equal(await d.f.staged(2), true);
  assert.deepEqual(d.f.stages, ["sent", "filled"], "the next note's send, then the whole rung went in on it");
});

test("review 8 S11: a send no RPC accepted, with no end at the run's end, is answered sent with its signature and read on", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  const refuse = (rpc: SolanaRpc): SolanaRpc => async (m, p) => (m === "sendTransaction" ? Promise.reject(down()) : rpc(m, p));
  const f = followed(c, ns, { rpcs: [refuse(c.rpc()), refuse(c.rpc())] });
  await (f.r as { after: Promise<void> }).after;
  await f.runEnd;
  const sig = (await ours(ns))[0]!.sends![0]!.signature;
  assert.deepEqual((f.r as { answer(): unknown }).answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: sig }] } });
  assert.equal(await f.parked(), true, "read on");
});

// ---- the delta review of 09542dc6 (five Lows): the reviewer's REV tests adopted as written, and the folds' own ----
const settleMs = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
test("pool-deposit-sent-end low 2 (REV S1): every rung lands, answered at the first send: exactly one end reaches the app, and nothing after it", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 100_000_000);
  const stages: string[] = [];
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  const kind = poolDepositKind(() => ({ ...host(c, ns), end: ended }));
  const r = kind(ask(30_000_000n), { id: "rv1", sha: "00", progress: (s) => stages.push(String(s)) });
  assert.ok("running" in r);
  await r.after;
  await done;
  await settleMs(500); // the follow, if any, runs after the run's end hook
  assert.deepEqual(stages, ["sent", "filled"]);
});
test("pool-deposit-sent-end low 2 (REV S2): a two-rung ask, rung 2 short: part_filled once and nothing after it", async () => {
  const c = chain();
  const ns = await notes();
  const u = await plannedU(ns);
  c.fund(u.address, 100_000_000);
  const stages: string[] = [];
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  const kind = poolDepositKind(() => ({ ...host(c, ns, { landed: () => void (c.accounts.get(u.address)!.lamports = 0) }), end: ended }));
  const r = kind(ask(3n * RUNG), { id: "rv2", sha: "00", progress: (s) => void stages.push(String(s)) });
  await (r as { after: Promise<void> }).after;
  await done;
  await settleMs(500);
  assert.deepEqual(stages, ["part_filled"]);
});

/** Open notes of an ask for followPoolDeposit, each with one made-up send (no record of them in the store). */
const openLeft = (n: number, value = RUNG) => ({ notes: Array.from({ length: n }, (_, k) => ({ precommitment: 7_000n + BigInt(k), sends: [{ signature: "1".repeat(63) + String(k + 1), value, last_valid_block_height: 1_000_000n } as PoolSend] })), landed: false, whole: true });

test("pool-deposit-sent-end low 2 R10: a sign out during the last read tells nothing, even when that read finds the note landed", async () => {
  const c = chain();
  const ns = await notes();
  const stop = new AbortController();
  const left = openLeft(1);
  // the read finds the note's record UNSPENT at its value, and the sign out lands while it is read
  const rec = { scope: SCOPE, precommitment: left.notes[0]!.precommitment, state: "UNSPENT", leaf: { value: RUNG } } as unknown as NoteRecord;
  const h = { ...host(c, ns), signal: stop.signal, records: async () => (stop.abort(), [rec]) };
  assert.equal(await followPoolDeposit(h, left), null, "no end after the sign out");
  // the same read with no sign out: filled (the test reads the end it means to stop)
  assert.equal(await followPoolDeposit({ ...host(c, ns), records: async () => [rec] }, left), "filled");
});

test("pool-deposit-sent-end low 1: a send that stays 'may land' (never landed, its blockhash never past on both RPCs) is read every 2 s through its landing window, then backs off as a quiet one, 4 s doubling to 60 s, and is never stopped", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false; // dropped, and the height never moves: no read can call it dead
  const waits: number[] = [];
  let ended = false;
  let cut = false;
  const kind = poolDepositKind(() => ({
    ...host(c, ns),
    wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (ended) {
        if (waits.reduce((a, b) => a + b, 0) >= 6 * 3_600_000) throw new Error("cut"); // the follower stops here, not at the 20 ms poll below
        waits.push(ms);
      }
    },
    end: () => void (ended = true),
  }));
  await (kind(ask(RUNG), { id: "l1", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  const sum = () => waits.reduce((a, b) => a + b, 0);
  for (const t0 = Date.now(); sum() < 6 * 3_600_000 && Date.now() - t0 < 30_000; ) await settleMs(20);
  cut = true;
  const inside = POOL_DEPOSIT_LANDING_MS / 2_000;
  assert.equal(POOL_DEPOSIT_LANDING_MS, POOL_DEPOSIT_READS * POOL_DEPOSIT_WAIT_MS, "the window is the run's own verdict window");
  // each read inside the window waits 2 s, and so does the first read past it (a quiet wait doubles after it is waited)
  assert.ok(waits.slice(0, inside + 1).every((w) => w === 2_000), "every 2 s inside the window");
  assert.deepEqual(waits.slice(inside + 1, inside + 8), [4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000], "past it, backed off and capped");
  assert.ok(sum() >= 6 * 3_600_000, `still reading after 6 h: ${sum()} ms over ${waits.length} reads`);
  assert.ok(waits.length < inside + 400, `the reads past the window come a minute apart: ${waits.length}`);
});

test("pool-deposit-sent-end low 4: a sign out during a pass's reads stops at once: no RPC read after it, for any open note", async () => {
  const c = chain();
  const ns = await notes();
  const stop = new AbortController();
  let after = 0;
  const counted = (rpc: SolanaRpc): SolanaRpc => async (m, p) => (stop.signal.aborted && after++, rpc(m, p));
  const h = { ...host(c, ns), rpcs: [counted(c.rpc()), counted(c.rpc())] as const, signal: stop.signal, records: async () => (stop.abort(), ns.list()), wait: async () => {} };
  assert.equal(await followPoolDeposit(h, openLeft(3)), null);
  assert.equal(after, 0, "no read naming U after the sign out");
  // the same pass with no sign out reads each note on both RPCs (the count above means something)
  let reads = 0;
  const h2 = { ...host(c, ns), rpcs: [c.rpc(), c.rpc()].map((r) => (async (m, p) => (reads++, r(m, p))) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc], wait: () => Promise.reject(new Error("cut")) };
  await followPoolDeposit(h2, openLeft(3)).catch(() => null);
  assert.ok(reads >= 6, `3 open notes read on both RPCs: ${reads}`);
});

test("pool-deposit-sent-end low 4: the end's own wait ends at the sign out, its timer cleared: the follow returns at once, not a wait later", async () => {
  const c = chain();
  const ns = await notes();
  const stop = new AbortController();
  const { wait: _no, ...bare } = host(c, ns); // the page's host: no wait of its own, so the follower's is used
  const got = followPoolDeposit({ ...bare, signal: stop.signal }, openLeft(1));
  await settleMs(300); // the first read done, the 2 s wait running
  const t0 = Date.now();
  stop.abort();
  const end = await Promise.race([got, settleMs(1_200).then(() => "still waiting" as const)]);
  assert.equal(end, null, "the follow ended with the sign out");
  assert.ok(Date.now() - t0 < 1_000, `ended ${Date.now() - t0} ms after the sign out`);
});

test("pool-deposit-sent-end low 1: a note the pass sends anew gets a new landing window: past the window, a dead read starts the pass, and the new send is read every 2 s again", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  const waits: number[] = [];
  let ended = false;
  let cut = false;
  let killed = -1;
  let pass: Promise<unknown> | null = null;
  const sum = () => waits.reduce((a, b) => a + b, 0);
  const kind = poolDepositKind(() => ({
    ...host(c, ns),
    settle: () => void (pass ??= settlePoolDeposits(host(c, ns))),
    wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (!ended) return;
      waits.push(ms);
      if (killed < 0 && sum() > POOL_DEPOSIT_LANDING_MS + 180_000) {
        killed = waits.length;
        c.height += 1_000; // the send past its blockhash's life on both: dead, with no mark
      }
      if (pass) await pass;
    },
    end: () => void (ended = true),
  }));
  await (kind(ask(RUNG), { id: "l1n", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  for (const t0 = Date.now(); (killed < 0 || waits.length < killed + 4) && Date.now() - t0 < 30_000; ) await settleMs(20);
  cut = true;
  assert.ok(killed > 0, "the reads went past the window");
  assert.equal(waits[killed - 1], 60_000, "backed off past the window");
  assert.equal((await ours(ns))[0]!.sends!.length, 2, "the pass sent the note anew");
  assert.deepEqual(waits.slice(killed, killed + 3), [60_000, 2_000, 2_000], "the dead read waits quiet, then the new send is read every 2 s");
});

test("pool-deposit-sent-end review 2 M1 (REV2 M1): a sign out while an RPC is behind the mark's slot: no mark read goes out after the sign out, with the follower's wait or the host's", async () => {
  for (const own of [false, true]) {
    const c = chain();
    const ns = await notes();
    const stop = new AbortController();
    let after = 0;
    let armed = false;
    // the sign out lands inside the wait for the RPC behind (the host's wait, or 100 ms into the follower's own), so the
    // order "the wait, then the stop" is what keeps the next mark read from going out
    const behind = (rpc: SolanaRpc): SolanaRpc => async (m, p) => {
      const pinned = m === "getAccountInfo" && (p[1] as { minContextSlot?: number } | undefined)?.minContextSlot !== undefined;
      if (stop.signal.aborted) after++;
      if (pinned) {
        if (!own && !armed) (armed = true), setTimeout(() => stop.abort(), 100);
        throw new Error("RPC error -32016 Minimum context slot has not been reached");
      }
      return rpc(m, p);
    };
    const { wait: _no, ...bare } = host(c, ns);
    const got = await followPoolDeposit({ ...bare, ...(own ? { wait: async () => void stop.abort() } : {}), rpcs: [behind(c.rpc()), behind(c.rpc())] as const, signal: stop.signal }, openLeft(1));
    assert.equal(got, null);
    assert.equal(after, 0, `no read after a sign out inside the wait (${own ? "the host's wait" : "the follower's"})`);
  }
});

test("pool-deposit-sent-end review 2 (info): a note a pass the follower did not start sends anew (a state read's) gets a new landing window too: read every 2 s again, not a minute on", async () => {
  const c = chain();
  const ns = await notes();
  c.fund((await plannedU(ns)).address, 50_000_000);
  c.lands = false;
  const waits: number[] = [];
  let ended = false;
  let cut = false;
  let killed = -1;
  const sum = () => waits.reduce((a, b) => a + b, 0);
  const kind = poolDepositKind(() => ({
    ...host(c, ns),
    settle: () => {}, // the follower starts no pass here
    wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (!ended) return;
      waits.push(ms);
      if (killed < 0 && sum() > POOL_DEPOSIT_LANDING_MS + 180_000) {
        killed = waits.length;
        c.height += 1_000; // the send past its blockhash's life on both: dead, with no mark
        await settlePoolDeposits(host(c, ns)); // the page's state read: its pass sends the note anew
      }
    },
    end: () => void (ended = true),
  }));
  await (kind(ask(RUNG), { id: "l1s", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  for (const t0 = Date.now(); (killed < 0 || waits.length < killed + 4) && Date.now() - t0 < 30_000; ) await settleMs(20);
  cut = true;
  assert.ok(killed > 0, "the reads went past the window");
  assert.equal(waits[killed - 1], 60_000, "backed off past the window");
  assert.equal((await ours(ns))[0]!.sends!.length, 2, "the state read's pass sent the note anew");
  assert.deepEqual(waits.slice(killed, killed + 3), [2_000, 2_000, 2_000], "the new send is read every 2 s");
});

test("from a fixed U_X (card pool-deposit-follow, review H1): a late send to an older U_X goes in from U_X, never from the newest used U", async () => {
  const c = chain();
  const ns = await notes();
  const ux = await plannedU(ns); // U_X: the planned index a quote named
  c.fund(ux.address, Number(RUNG) + COST);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  const nv = await plannedU(ns);
  assert.notEqual(nv.i, ux.i);
  c.fund(nv.address, Number(RUNG) + COST);
  { const r2 = await runPoolDeposit(host(c, ns), ask(RUNG)); assert.equal((r2 as { stage: string }).stage, "filled", JSON.stringify(r2) + " ux " + c.lamports(ux.address)); }
  // the newest used U covers a rung again, and a late send (an older quote to U_X, or its refund carried back) credits U_X
  c.fund(nv.address, Number(RUNG) + COST);
  c.fund(ux.address, 50_000_000);
  const vBefore = c.lamports(nv.address);
  // with no fixed source pool.deposit picks the newest used U: the follow must not take that path
  const r = await runPoolDeposit(host(c, ns), ask(RUNG), { s: SCOPE, i: ux.i });
  assert.equal((r as { stage: string }).stage, "filled", JSON.stringify(r));
  assert.equal(c.lamports(nv.address), vBefore, "the newest used U is not touched");
  assert.ok(c.lamports(ux.address) <= 50_000_000 - Number(RUNG), "the rung went in from U_X");
  const mine = (await ours(ns)).filter((n) => n.ref.kind === "second" && n.ref.id.id === "U" && n.ref.id.i === ux.i && n.state !== "PLANNED");
  assert.equal(mine.length, 1, "U_X's next second arrival is the note");
});

test("from a fixed U_X: a U the store never planned, or another pool's scope, is refused and nothing is sent", async () => {
  const c = chain();
  const ns = await notes();
  const ux = await plannedU(ns);
  c.fund(ux.address, Number(RUNG) + COST);
  c.fund(U(ux.i + 7), Number(RUNG) + COST);
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG), { s: SCOPE, i: ux.i + 7 }), { error: "not_allowed" });
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG), { s: SCOPE + 1n, i: ux.i }), { error: "not_allowed" });
  assert.equal(c.lamports(ux.address), Number(RUNG) + COST);
  // its own planned deposit note: filled from U_X
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG), { s: SCOPE, i: ux.i })) as { stage: string }).stage, "filled");
  assert.equal(c.lamports(ux.address), 0);
});

test("from a fixed U_X: U_X short with the planned U funded answers not_funded and never falls back to the planned U; the kind passes its fixed source through", async () => {
  const c = chain();
  const ns = await notes();
  const ux = await plannedU(ns);
  c.fund(ux.address, Number(RUNG) + COST);
  assert.equal(((await runPoolDeposit(host(c, ns), ask(RUNG))) as { stage: string }).stage, "filled");
  // U_X, the newest used U, now holds less than a rung; the next planned U is funded
  c.fund(ux.address, 1_000_000);
  const nv = await plannedU(ns);
  c.fund(nv.address, Number(RUNG) + COST);
  assert.deepEqual(await runPoolDeposit(host(c, ns), ask(RUNG), { s: SCOPE, i: ux.i }), { error: "not_funded" });
  assert.equal(c.lamports(nv.address), Number(RUNG) + COST, "the planned U is not touched");
  // through the kind: the fixed source reaches the run (U_X short: not_funded, the planned U untouched)
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  const r = poolDepositKind(() => ({ ...host(c, ns), end: ended }))(ask(RUNG), { id: "d1", sha: "00", progress: () => {} }, { s: SCOPE, i: ux.i });
  assert.ok("running" in r);
  await r.after;
  await done;
  assert.deepEqual(r.answer(), { error: "not_funded" });
  assert.equal(c.lamports(nv.address), Number(RUNG) + COST, "the kind ran from U_X, not the planned U");
});
