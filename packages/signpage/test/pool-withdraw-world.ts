// The pool withdraw tests' world (card signpage-pool-withdraw-form): a fake devnet pool and chain over two RPCs, the
// device's note store with the pool's landed notes, and the helper's send, shared by pool-withdraw.test.ts and
// pool-testnet.test.ts (the testnet page's own run on it). The seed is the published all-zero entropy vector
// (packages/wallet/test/vectors/a8.json); the Rent sysvar is the kit's recorded answer of both providers
// (packages/kit/test/fixtures/solana-pool-buy.json).
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
import { solanaWithdrawMinPart, withdrawNoteFloor, type PoolWithdrawHost, type WithdrawCosts } from "../src/pool-withdraw.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import { after } from "node:test";
export { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, rent };

export const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
export const { scope: SCOPE } = solanaPoolOf(PROGRAM);
export const FEE = solanaPoolFee(rent);
export const W_FEE = 5_000n;
export const MIN = solanaWithdrawMinPart(rent, FEE, W_FEE);
export const C: WithdrawCosts = { fee: FEE, wFee: W_FEE, minPart: MIN };
export const FLOOR = withdrawNoteFloor(C);
export const COST = FEE + W_FEE;
export const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
export const SIG = base58.encode(new Uint8Array(64).fill(5));
export const NOW = 1_800_000_000_000n + 1_000n;
export const ASK: PoolAsk = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
export const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

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

export type Plant = {
  helperFee?: bigint;
  readBack?: "ours" | "none";
  landed?: boolean;
  onward?: "ok" | "drop";
  toAccount?: { owner: string; executable: boolean };
  /** the release landed and read back, its spend never read at finalized in time (sendAndSettle answers "sent") */
  settleUnspent?: boolean;
  /** the network's fee for a message (default W_FEE); the chain charges what it answers */
  feeFor?: (message: Uint8Array) => bigint;
  /** after each release lands: another tab's finish, say */
  afterRelease?: (w: string) => void;
  /** both RPCs' nodes behind: a balance read with no minContextSlot, or one below FINAL_SLOT, answers 0 (review
   *  #232b LOW 2: a lagging node behind a load balancer) */
  stale?: boolean;
  /** the release's read-back never answers: the run hangs there, as a tab closed during the send */
  hangReadBack?: boolean;
  /** W's history as RPC p lists it (newest first): the world's own by default */
  history?: (sigs: string[], p: 0 | 1) => string[];
};
/** Both RPCs' finalized slot in the world. */
export const FINAL_SLOT = 20;

export async function world(values: readonly bigint[], plant: Plant = {}) {
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
      // a fresh salt per bind, as the wallet's (16 random bytes): each attempt its own context
      const salt = (binds.length + 1).toString(16).padStart(32, "0");
      const request: SolanaReleaseRequest = { program: PROGRAM, pool: POOL, recipient: b.wallet.address, feePayer: FEE_PAYER, relayFee: fee, relayFeeCap: fee, tipCap: b.tipCap!, deadlineMs: b.deadlineMs, salt };
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
  const fees: Uint8Array[] = [];
  const owed: unknown[] = [];
  // each landed release by its own id (the fee payer's signature, distinct per release) with its wire, for W's history
  // (getSignaturesForAddress, newest first) and its getTransaction; `history` holds every landed tx naming an address
  const landed = new Map<string, Uint8Array>();
  // another device's release or buy of the note landed: this device's own release, read by the sender's id, failed
  let spentByOther = false;
  const history = new Map<string, string[]>();
  const touch = (address: string, sig: string) => history.set(address, [sig, ...(history.get(address) ?? [])]);
  // transactions that landed and failed (the runtime's error in their meta): W's history lists them too
  const failed = new Set<string>();
  // older than every transaction W's history holds so far
  const touchOldest = (address: string, sig: string) => history.set(address, [...(history.get(address) ?? []), sig]);
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
      if (method === "getFeeForMessage") {
        const m = base64.decode(params[0] as string);
        fees.push(m);
        return { context: { slot: 12 }, value: Number(plant.feeFor?.(m) ?? W_FEE) };
      }
      if (method === "getSlot") return FINAL_SLOT;
      if (method === "getBalance") {
        const min = (params[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
        if (plant.stale && (min === undefined || min < FINAL_SLOT)) return { context: { slot: 12 }, value: 0 };
        return { context: { slot: min ?? 12 }, value: Number(balance.get(params[0] as string) ?? 0n) };
      }
      if (method === "sendTransaction") {
        const wire = base64.decode(params[0] as string);
        const sig = base58.encode(wire.subarray(1, 65));
        if ((plant.onward ?? "ok") === "drop" || onwards.has(sig)) return sig;
        const m = keysOf(wire);
        const t = m.instructions[0]!;
        const [from, to] = [m.staticKeys[t.accounts[0]!]!, m.staticKeys[t.accounts[1]!]!];
        const v = new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(4, true);
        const fee = plant.feeFor?.(wire.subarray(65)) ?? W_FEE;
        if ((balance.get(from) ?? 0n) < v + fee) return sig;
        add(from, -(v + fee));
        add(to, v);
        onwards.set(sig, wire.slice());
        touch(from, sig);
        return sig;
      }
      if (method === "getSignaturesForAddress") {
        // as an RPC pages it: newest first, after `before` when given, at most `limit`
        const sigs = history.get(params[0] as string) ?? [];
        const all = plant.history?.(sigs, p) ?? sigs;
        const o = (params[1] ?? {}) as { before?: string; limit?: number };
        const from = o.before === undefined ? 0 : all.indexOf(o.before) + 1;
        if (o.before !== undefined && from === 0) return [];
        return all.slice(from, from + (o.limit ?? 1_000)).map((signature) => ({ signature, slot: FINAL_SLOT, err: null }));
      }
      if (method === "getTransaction") {
        const sig = params[0] as string;
        const rel = landed.get(sig);
        if (rel) return { transaction: [base64.encode(rel), "base64"], meta: { err: failed.has(sig) ? { InstructionError: [1, { Custom: 6 }] } : null } };
        const on = onwards.get(sig);
        if (on) return { transaction: [base64.encode(on), "base64"], meta: { err: null } };
        const last = releases.at(-1);
        if (sig === SIG && plant.hangReadBack) return new Promise(() => {});
        if (sig !== SIG || (plant.readBack ?? "ours") === "none" || !last) return null;
        const tx = last.slice();
        tx.set(base58.decode(SIG), 1);
        return { transaction: [base64.encode(tx), "base64"], meta: { err: spentByOther ? { InstructionError: [1, { Custom: 6 }] } : null } };
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
        const id = base58.encode(new Uint8Array(64).fill(100 + landed.size));
        const wire = tx.slice();
        wire.set(base58.decode(id), 1);
        landed.set(id, wire);
        touch(m.staticKeys[ix.accounts[1]!]!, id);
        plant.afterRelease?.(m.staticKeys[ix.accounts[1]!]!);
        // the sender's word for the id: the landed transaction's own
        return { signature: id };
      }
      return { signature: SIG };
    },
    settle: async (noteId) => {
      if (plant.settleUnspent) return { kind: "unspent" };
      if (plant.landed === false || (plant.readBack ?? "ours") === "none") return { kind: "unspent" };
      const n = await ns.get(noteId);
      if (n?.state === "RESERVED") order.push(`settle:${noteId}`);
      return { kind: "spent" };
    },
    now: () => NOW,
    reads: 2,
    wait: async () => {},
    stage: (s, _txs, pending) => void (stages.push(s), pendings.push(pending)),
    owe: async (p) => void (owed.push(p), order.push(`owe:${(await ns.get(p.noteId))?.state}`)),
  };
  /** Another device's spend of a landed release: its salt changed, so its context is not this device's attempt's. */
  const foreign = (i = 0): void => {
    const id = [...landed.keys()][i]!;
    const wire = landed.get(id)!;
    wire[wire.length - 2]! ^= 1; // the salt's last byte: the release data ends the message, before its 0 lookups
    landed.set(id, wire);
  };
  /** Another device's release of note `noteId`'s part to W, never this device's (its context another attempt's):
   *  this device's own release bytes for it, its salt changed, landed on W. */
  const foreignLand = (wire: Uint8Array, value: bigint): void => {
    const m = keysOf(wire);
    const ix = m.instructions.at(-1)!;
    const id = base58.encode(new Uint8Array(64).fill(200 + landed.size));
    const tx = wire.slice();
    tx.set(base58.decode(id), 1);
    tx[tx.length - 2]! ^= 1;
    landed.set(id, tx);
    spentByOther = true;
    touch(m.staticKeys[ix.accounts[1]!]!, id);
    add(m.staticKeys[ix.accounts[1]!]!, value);
  };
  /** Another id for a landed release's very bytes: what an RPC that names another transaction for it would list. */
  const alias = (sig: string): string => {
    const id = base58.encode(new Uint8Array(64).fill(150 + landed.size));
    const tx = landed.get(sig)!.slice();
    tx.set(base58.decode(id), 1);
    landed.set(id, tx);
    return id;
  };
  /** A transaction in W's history older than the rest: `wire` with its own id, failed or landed. `nullifier` set: its
   *  release's nullifier hash and salt changed (another note's release to W, which anyone can make). */
  const landOlder = (wire: Uint8Array, o: { failed?: boolean; nullifier?: boolean } = {}): string => {
    const m = keysOf(wire);
    const ix = m.instructions.at(-1)!;
    const id = base58.encode(new Uint8Array(64).fill(230 + landed.size));
    const tx = wire.slice();
    tx.set(base58.decode(id), 1);
    // another note's release: its own nullifier hash and its own context (its salt)
    if (o.nullifier) {
      tx[tx.length - 1 - 387 + 1 + 256 + 63]! ^= 1;
      tx[tx.length - 2]! ^= 1;
    }
    landed.set(id, tx);
    if (o.failed) failed.add(id);
    else if (!o.nullifier) spentByOther = true;
    touchOldest(m.staticKeys[ix.accounts[1]!]!, id);
    return id;
  };
  return { w, host, ns, ids, releases, onwards: () => [...onwards.values()], balance, add, order, stages, pendings, binds, plant, fees, owed, landed, foreign, foreignLand, alias, landOlder };
}

/** A wire's signers and instructions, as keys: [signers, [program, accounts, data][]]. */
export function read(wire: Uint8Array): { signers: string[]; ixs: { program: string; accounts: string[]; data: Uint8Array }[] } {
  const m = solanaDecodeMessage(wire.subarray(1 + 64 * wire[0]!));
  const k = m.staticKeys;
  return { signers: k.slice(0, wire[0]!), ixs: m.instructions.map((x) => ({ program: k[x.programIndex]!, accounts: x.accounts.map((i) => k[i]!), data: x.data })) };
}
export const lamportsOf = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset).getBigUint64(4, true);
