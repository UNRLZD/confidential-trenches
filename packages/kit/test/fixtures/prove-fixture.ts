// The leaves prove-e2e.test.ts proves from, in node and in the Chromium page (prove-page.ts). It is fixture 1 of
// vault-inputs.test.ts: the research vector proofs/g1-phone-prover/vectors/ (gen-vectors.mjs, research main aa5bc1e),
// five test deposits on vault.test.near, note 2 (5,000,000) spent for 2,000,000, with the withdrawal of vault-v1.json's
// first context vector. Test values only (keccak256("g1-setup-files/test/<tag>") mod p), never money.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon2, poseidon3 } from "poseidon-lite";
import { VaultTree, type VaultWithdrawInputArgs } from "../../src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf, vaultScopeOf, type VaultWithdrawal } from "../../src/vault/shapes.ts";

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const testField = (tag: string): bigint =>
  BigInt("0x" + hex(keccak_256(new TextEncoder().encode("g1-setup-files/test/" + tag)))) % VAULT_FIELD_P;

const SCOPE = vaultScopeOf(keccak_256, "vault.test.near", "token.test.near");
const NOTES = [2_000_000n, 5_000_000n, 10_000_000n, 3_000_000n, 7_000_000n].map((value, i) => {
  const label = vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1));
  const nullifier = testField(`note${i + 1}/nullifier`);
  const secret = testField(`note${i + 1}/secret`);
  return { value, label, nullifier, secret, commitment: poseidon3([value, label, poseidon2([nullifier, secret])]) };
});

/** vault-v1.json's first context vector, as the test reads it from test/vectors (and hands it to the page). */
export type ContextVector = { input: Record<string, string>; scope: string; context: string };

/** The 8 public signals the fixture's proof must carry: withdraw.public.json's 7, then the vector's context. */
export const fixtureSignals = (cv: ContextVector): string[] => [
  "17110053328481775770369382357212930435176681876033845347408611641206377530098",
  "13656508390809383486700253218777707324848145126455925481268684662948012579156",
  "2000000",
  "19694040607821770922157628280056958563843956415515542749943686243542539030332",
  "3",
  "14742355778095561659802612499961325813236213151846608975518831588135420342697",
  "3",
  cv.context,
];

/** How a run plants a fault in the leaves: one state leaf changed, while the vault's newest root stays the true one. */
export type FixtureTamper = "none" | "state-leaf";

/** The arguments to spend note 2 from the device's leaves, built where the proof is asked for (node or the page). */
export function fixtureArgs(cv: ContextVector, tamper: FixtureTamper = "none"): VaultWithdrawInputArgs {
  const f = (k: string): string => {
    const v = cv.input[k];
    if (typeof v !== "string") throw new Error(`context vector: no ${k}`);
    return v;
  };
  const withdrawal: VaultWithdrawal = {
    recipient: f("recipient"),
    register_deposit: f("register_deposit"),
    fee_recipient: f("fee_recipient"),
    relay_fee: f("relay_fee"),
    refund_precommitment: f("refund_precommitment"),
    deadline_ms: Number(f("deadline_ms")),
    salt: f("salt"),
  };
  const state = NOTES.map((n) => n.commitment);
  const labels = NOTES.map((n) => n.label);
  const newestStateRoot = new VaultTree(state).root!;
  const newestLabelRoot = new VaultTree(labels).root!;
  if (tamper === "state-leaf") state[3] = state[3]! + 1n;
  const n = NOTES[1]!;
  return {
    stateTree: new VaultTree(state),
    labelTree: new VaultTree(labels),
    newestStateRoot,
    newestLabelRoot,
    note: { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret },
    newNullifier: testField("change/nullifier"),
    newSecret: testField("change/secret"),
    withdrawn: 2_000_000n,
    withdrawal,
    vaultId: f("processor"),
    scope: BigInt(cv.scope),
    nowMs: 1_700_000_000_000, // before the vector's deadline
  };
}
