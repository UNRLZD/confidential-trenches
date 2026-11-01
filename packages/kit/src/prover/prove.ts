// One call from the device's leaves to a withdraw proof made in the prover worker (card vault-prover-e2e; the vault
// paper's rows V2.4 and V2.6, docs/plan1/vault.md l.1198 and l.1200, and the kit's call in l.1284: prove(inputs) ->
// {proof, publicSignals} in snarkjs JSON, in one same-origin worker, single thread).
//
// - The inputs are vaultWithdrawInput's (../vault/inputs.ts). It refuses, before any proof, a tree whose root is not
//   the vault's newest (a changed, missing or extra leaf), a note whose commitment or label is not in its tree, and
//   every withdrawal the vault would refuse. So a refused call never posts a prove to the worker.
// - The worker (client.ts, worker.js) loads the withdraw setup files once per Prover and checks each by sha256.
// - The worker's answer is checked here before the caller gets it: its public signals must be exactly the 8 this input
//   gives, computed apart from the circuit (Withdraw(32)'s outputs newCommitmentHash = Poseidon(value - withdrawn,
//   label, Poseidon(newNullifier, newSecret)) and existingNullifierHash = Poseidon(existingNullifier), commitment.circom
//   l.24-36 and withdraw.circom l.17-43 of Privacy Pools v1.3.0, then the input's public values, in
//   VAULT_WITHDRAW_SIGNALS order), and its proof must be in the affine form the vault parses (vaultProof). An answer
//   that differs is refused, so the proof the device hands on carries the roots, amount and context of its own request.
// - The pairing check is the vault's, with its compiled key: the page carries no verifier. prove-e2e.test.ts checks
//   the worker's proofs with snarkjs and the release's withdraw.vkey.
// Nothing here logs: the input holds the note's secrets.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { vaultWithdrawInput, type VaultWithdrawInput, type VaultWithdrawInputArgs } from "../vault/inputs.ts";
import { VAULT_WITHDRAW_SIGNALS, vaultProof, type VaultSnarkjsProof, type VaultWithdrawSignals } from "../vault/shapes.ts";
import type { Prover } from "./client.ts";

/** The worker's load and prove (startProver in client.ts gives one). */
export type VaultProver = Pick<Prover, "load" | "prove">;

/** A withdraw proof, its public signals in snarkjs order, and fullProve's own time in the worker, in ms. */
export type VaultWithdrawProof = { proof: VaultSnarkjsProof; publicSignals: VaultWithdrawSignals; proveMs: number };

// one load of the withdraw setup files per prover; a failed load is dropped, so the next call tries again
const loads = new WeakMap<VaultProver, Promise<void>>();
function loadWithdraw(prover: VaultProver): Promise<void> {
  const had = loads.get(prover);
  if (had) return had;
  const load = prover.load("withdraw");
  loads.set(prover, load);
  load.catch(() => {
    if (loads.get(prover) === load) loads.delete(prover);
  });
  return load;
}

/** The 8 public signals Withdraw(32) gives for this input, in snarkjs order. */
function signalsOf(i: VaultWithdrawInput): VaultWithdrawSignals {
  const left = BigInt(i.existingValue) - BigInt(i.withdrawnValue);
  const newCommitmentHash = poseidon3([left, BigInt(i.label), poseidon2([BigInt(i.newNullifier), BigInt(i.newSecret)])]);
  const existingNullifierHash = poseidon1([BigInt(i.existingNullifier)]);
  return [
    String(newCommitmentHash),
    String(existingNullifierHash),
    i.withdrawnValue,
    i.stateRoot,
    i.stateTreeDepth,
    i.ASPRoot,
    i.ASPTreeDepth,
    i.context,
  ];
}

/**
 * Proves the withdrawal of `args.withdrawn` from `args.note` in the prover worker, from the leaves the device holds
 * (`args.stateTree`, `args.labelTree`) against the vault's newest roots. Throws what vaultWithdrawInput refuses before
 * any proof, and refuses a worker answer whose public signals are not this input's or whose proof is not well formed.
 */
export async function vaultProveWithdraw(prover: VaultProver, args: VaultWithdrawInputArgs): Promise<VaultWithdrawProof> {
  const input = vaultWithdrawInput(args);
  const want = signalsOf(input);
  await loadWithdraw(prover);
  const got: unknown = await prover.prove("withdraw", input);
  const r = (got ?? {}) as { proof?: unknown; publicSignals?: unknown; proveMs?: unknown };
  const signals = r.publicSignals;
  if (!Array.isArray(signals) || signals.length !== want.length) throw new Error(`worker answer: not ${want.length} public signals`);
  want.forEach((w, k) => {
    if (signals[k] !== w) throw new Error(`worker answer: ${VAULT_WITHDRAW_SIGNALS[k]} is not the input's`);
  });
  try {
    vaultProof(r.proof as VaultSnarkjsProof);
  } catch (e) {
    throw new Error(`worker answer: ${e instanceof Error ? e.message : "proof: not snarkjs JSON"}`);
  }
  const proveMs = typeof r.proveMs === "number" && Number.isFinite(r.proveMs) ? r.proveMs : NaN;
  return { proof: r.proof as VaultSnarkjsProof, publicSignals: want, proveMs };
}
