// The shared vector for withdraw-request.test.ts and key-zeroing.test.ts (card wallet-withdraw-request). The vault,
// its scope, the fee recipient, the recipient, register_deposit and relay_fee are the relayer's own fixture
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
import type { WithdrawRequestArgs } from "../src/withdraw/request.ts";

const RELAYER = JSON.parse(readFileSync(new URL("../../../apps/helper/src/withdraw/fixtures/withdraw-request.json", import.meta.url), "utf8")) as {
  vault: string;
  scope: string;
  fee_recipient: string;
  request: { withdrawal: { recipient: string; register_deposit: string; relay_fee: string } };
};
export const VAULT = RELAYER.vault;
export const TOKEN = VAULT_CONSTANTS.TOKEN; // the relayer's fixture leaves the 64-hex token out for the secret scan
export const SCOPE = vaultScopeOf(keccak_256, VAULT, TOKEN);
if (SCOPE !== BigInt(RELAYER.scope)) throw new Error("the relayer fixture's scope is not this vault's");
export const FEE_RECIPIENT = RELAYER.fee_recipient;
export const RECIPIENT = RELAYER.request.withdrawal.recipient;
export const REGISTER_DEPOSIT = BigInt(RELAYER.request.withdrawal.register_deposit);
export const RELAY_FEE = BigInt(RELAYER.request.withdrawal.relay_fee);

export const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
/** The block the request is made at: header.timestamp_nanosec, past 2^53 as a number, so only a string reads it exactly. */
export const BLOCK_NS = "1793750000123999999";
export const BLOCK_MS = 1_793_750_000_123;
export const NOTE_VALUES = [2_000_000n, 5_000_000n, 10_000_000n];

export type Vault = { w: WalletStore; ns: NoteStore; notes: NoteRecord[]; stateTree: VaultTree; labelTree: VaultTree; failPut: { on?: (rec: unknown) => boolean } };

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
  const ns = await openNoteStore({ ...w, put } as WalletStore);
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
  const v: Vault = { w, ns, notes, stateTree: new VaultTree(state), labelTree: new VaultTree(labels), failPut };
  open.push(v);
  return v;
}

/** The request's arguments on this vault: 3 USDC to the relayer fixture's recipient, the deadline 10 minutes out. */
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
    recipient: RECIPIENT,
    registerDeposit: REGISTER_DEPOSIT,
    feeRecipient: FEE_RECIPIENT,
    relayFee: RELAY_FEE,
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
