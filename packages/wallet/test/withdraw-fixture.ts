// The shared vector for withdraw-request.test.ts and key-zeroing.test.ts (card wallet-withdraw-request). The vault,
// its scope, the fee recipient, register_deposit and relay_fee are the relayer's own fixture
// (apps/helper/src/withdraw/fixtures/withdraw-request.json, the vector its checks 1-4 are tested on), so the request is
// built for the config those checks run with. The notes are deposit notes of the public test seed (all-zero BIP-39
// entropy, test/vectors/a8.json), 2, 5 and 10 USDC, with labels vaultLabelOf(scope, 1..3), among other test leaves.
// Test values only, never money.
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { IDBFactory } from "fake-indexeddb";
import { VAULT_CONSTANTS, VaultTree, vaultLabelOf, vaultScopeOf, type VaultProver } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import type { FeeRpc } from "../src/withdraw/feemax.ts";
import type { WithdrawRequestArgs } from "../src/withdraw/request.ts";

const RELAYER = JSON.parse(readFileSync(new URL("../../../apps/helper/src/withdraw/fixtures/withdraw-request.json", import.meta.url), "utf8")) as {
  vault: string;
  scope: string;
  fee_recipient: string;
  request: { withdrawal: { register_deposit: string; relay_fee: string } };
};
export const VAULT = RELAYER.vault;
export const TOKEN = VAULT_CONSTANTS.TOKEN; // the relayer's fixture leaves the 64-hex token out for the secret scan
export const SCOPE = vaultScopeOf(keccak_256, VAULT, TOKEN);
if (SCOPE !== BigInt(RELAYER.scope)) throw new Error("the relayer fixture's scope is not this vault's");
export const FEE_RECIPIENT = RELAYER.fee_recipient;
export const REGISTER_DEPOSIT = BigInt(RELAYER.request.withdrawal.register_deposit);
export const RELAY_FEE = BigInt(RELAYER.request.withdrawal.relay_fee);

export const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
/** The block the request is made at: header.timestamp_nanosec, past 2^53 as a number, so only a string reads it exactly. */
export const BLOCK_NS = "1793750000123999999";
export const BLOCK_MS = 1_793_750_000_123;
export const NOTE_VALUES = [2_000_000n, 5_000_000n, 10_000_000n];

export type Vault = {
  w: WalletStore;
  ns: NoteStore;
  notes: NoteRecord[];
  stateTree: VaultTree;
  labelTree: VaultTree;
  failPut: { on?: (rec: unknown) => boolean };
  /** The two trees' leaves in insert order (the arrays the trees were built from; tests append to both). */
  stateLeaves: bigint[];
  labelLeaves: bigint[];
  /** A new tab's note store on the same database (as after the page died), now v.ns. */
  reopen: () => Promise<NoteStore>;
};

const open: Vault[] = [];
/** Lets every vault's stores go (their Web Locks keep the test process alive). */
export function closeVaults(): void {
  for (const v of open.splice(0)) (v.ns.close(), v.w.close());
}

/** A note store holding the seed's deposit notes, UNSPENT on their leaves, and the vault's two trees. */
export async function vaultWith(values = NOTE_VALUES): Promise<Vault> {
  const failPut: Vault["failPut"] = {};
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const put: WalletStore["put"] = async (s, k, v) => {
    if (s === "notes" && failPut.on?.(v)) throw new Error("the store refused the write");
    return w.put(s, k, v);
  };
  const store = { ...w, put } as WalletStore;
  const ns = await openNoteStore(store);
  const state: bigint[] = [11n, 12n]; // other depositors' leaves
  const labels: bigint[] = [21n, 22n];
  const notes: NoteRecord[] = [];
  for (const [k, value] of values.entries()) {
    let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k + 1));
    const commitment = noteCommitment(value, label, n.precommitment);
    n = await ns.move(n.id, "PLANNED", "INCOMING");
    n = await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(state.length) } });
    state.push(commitment, 13n + BigInt(k));
    labels.push(label);
    notes.push(n);
  }
  const v: Vault = { w, ns, notes, stateTree: new VaultTree(state), labelTree: new VaultTree(labels), failPut, stateLeaves: state, labelLeaves: labels, reopen: async () => (v.ns = await openNoteStore(store)) };
  open.push(v);
  return v;
}

// ---------- fee_max's reads, replayed (test/record-withdraw-feemax.mjs) ----------
type Rec = { url: string; status: number; json: Record<string, unknown> };
type NetRec = { final: Record<"a" | "b", Rec>; at: Record<"a" | "b", Rec>; pool?: Record<"a" | "b", Rec>; metadata?: Record<"a" | "b", Rec> };
export const FEE_READS = JSON.parse(readFileSync(new URL("./vectors/withdraw-feemax.json", import.meta.url), "utf8")) as {
  recorded_at: string;
  answers: Record<"mainnet" | "testnet", NetRec>;
};
/** An edit of one side's answer before it is handed back: (read, side, answer JSON) -> answer JSON. */
export type FeeEdit = (read: "final" | "at" | "pool", side: "a" | "b", json: Record<string, unknown>) => Record<string, unknown>;
/** The recorded release pair of `net` (names: the recorded URLs), each answer through `edit`. */
export function feeReplay(net: "mainnet" | "testnet", edit: FeeEdit = (_r, _s, j) => j): [FeeRpc, FeeRpc] {
  const rec = FEE_READS.answers[net];
  const one = (side: "a" | "b"): FeeRpc => ({
    name: rec.final[side].url,
    async block(params) {
      if ("finality" in params) return edit("final", side, structuredClone(rec.final[side].json));
      const at = rec.at[side].json as { result: { header: { height: number } } };
      if (params.block_id !== at.result.header.height) throw new Error(`no recorded block ${params.block_id}`);
      return edit("at", side, structuredClone(rec.at[side].json));
    },
    async query(params) {
      const pool = rec.pool?.[side].json as { result: { block_height: number } } | undefined;
      if (pool === undefined || params.method_name !== "get_pool" || params.block_id !== pool.result.block_height) throw new Error("no recorded answer");
      return edit("pool", side, structuredClone(rec.pool![side].json));
    },
  });
  return [one("a"), one("b")];
}
/** The fixture's fee_max: LD5 at the recorded reads (gas price 1e8, Ref pool 4512) and REGISTER_DEPOSIT. */
export const FEE_MAX = 433_462n;

/** The ids registerDepositOf was asked about, in order (the request asks for its A_{l,j} only). */
export const registerAsked: string[] = [];

/** The request's arguments on this vault: 3 USDC to the note's A_{l,j}, the deadline 590 s out. */
export function argsFor(v: Vault, prover: VaultProver, over: Partial<WithdrawRequestArgs> = {}): WithdrawRequestArgs {
  return {
    seed64: SEED,
    notes: v.ns,
    prover,
    vaultId: VAULT,
    token: TOKEN,
    stateTree: v.stateTree,
    labelTree: v.labelTree,
    newestStateRoot: v.stateTree.root!,
    newestLabelRoot: v.labelTree.root!,
    registerDepositOf: async (id) => (registerAsked.push(id), REGISTER_DEPOSIT),
    feeRecipient: FEE_RECIPIENT,
    relayFee: RELAY_FEE,
    network: "mainnet",
    rpcs: feeReplay("mainnet"),
    priceRpcs: feeReplay("mainnet"),
    amount: 3_000_000n,
    deadlineMs: BLOCK_MS + 590_000,
    blockTimestampNanosec: BLOCK_NS,
    ...over,
  };
}

/**
 * A prover that answers without proving: the 8 signals Withdraw(32) gives for the input (commitment.circom and
 * withdraw.circom of Privacy Pools v1.3.0, as the kit's prove.ts computes them) and an affine proof of 1s and 2s. It
 * passes the kit's answer checks, never the relayer's check 4. `log` records each call.
 */
export function signalsProver(log: string[] = []): VaultProver & { log: string[] } {
  return {
    log,
    async load(circuit) {
      log.push(`load ${circuit}`);
    },
    async prove(circuit, input) {
      log.push(`prove ${circuit}`);
      const i = input as Record<string, string>;
      const n = (k: string): bigint => BigInt(i[k]!);
      const publicSignals = [
        poseidon3([n("existingValue") - n("withdrawnValue"), n("label"), poseidon2([n("newNullifier"), n("newSecret")])]),
        poseidon1([n("existingNullifier")]),
        n("withdrawnValue"),
        n("stateRoot"),
        n("stateTreeDepth"),
        n("ASPRoot"),
        n("ASPTreeDepth"),
        n("context"),
      ].map(String);
      return { proof: { pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["1", "2", "1"] }, publicSignals, proveMs: 0 };
    },
  };
}
