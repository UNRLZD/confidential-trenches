// node --test packages/kit/test/vault-inputs.test.ts: a withdrawal's proof inputs built from the leaves on the device
// (src/vault/inputs.ts, card vault-input-builder) are the ones the circuit takes. The pinned withdraw.wasm computes a
// witness from them, with the circuit's own witness calculator (snarkjs 0.7.5's wtns.calculate, circom_runtime), and
// any root the circuit would not reach fails there with "Assert Failed" (withdraw.circom l.73 and l.82).
// Fixture 1 is the research vector proofs/g1-phone-prover/vectors/ (gen-vectors.mjs, research main aa5bc1e): five test
// deposits, note 2 spent in part; its roots, siblings and the circuit's public signals are pinned below. Its context
// is now the kit's (vault-v1.json's first context vector), computed from the withdrawal. Test values only
// (keccak256("g1-setup-files/test/<tag>") mod p), never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { VaultTree, vaultCommitment, vaultRootOfPath, vaultWithdrawInput, type VaultWithdrawInput, type VaultWithdrawInputArgs } from "../src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf, vaultScopeOf, vaultWithdrawalProblems, type VaultWithdrawal } from "../src/vault/shapes.ts";

type Wtns = { type: "mem"; data?: Uint8Array };
const snarkjs = createRequire(import.meta.url)("snarkjs") as {
  wtns: { calculate(input: unknown, wasm: Uint8Array, out: Wtns): Promise<void>; exportJson(w: Wtns): Promise<bigint[]> };
};
const WASM = new Uint8Array(readFileSync(new URL("../zk/withdraw.wasm", import.meta.url)));

/** The witness's public part: [1, newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context]. */
async function witness(input: VaultWithdrawInput): Promise<string[]> {
  const out: Wtns = { type: "mem" };
  await snarkjs.wtns.calculate(input, WASM, out);
  return (await snarkjs.wtns.exportJson(out)).slice(0, 9).map(String);
}
const ASSERT = /Assert Failed/;

const vectors = JSON.parse(readFileSync(new URL("./vectors/vault-v1.json", import.meta.url), "utf8")) as {
  label: { scope: string; nonce: string; label: string }[];
  context: { input: Record<string, string>; scope: string; context: string }[];
};
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const testField = (tag: string): bigint =>
  BigInt("0x" + hex(keccak_256(new TextEncoder().encode("g1-setup-files/test/" + tag)))) % VAULT_FIELD_P;
const commit = (value: bigint, label: bigint, nullifier: bigint, secret: bigint): bigint =>
  poseidon3([value, label, poseidon2([nullifier, secret])]);
const zeros = (n: number): string[] => Array<string>(n).fill("0");

// Fixture 1 (gen-vectors.mjs): vault.test.near on token.test.near, deposits with nonces 1-5.
const SCOPE = vaultScopeOf(keccak_256, "vault.test.near", "token.test.near");
const DEPOSITS = [2_000_000n, 5_000_000n, 10_000_000n, 3_000_000n, 7_000_000n];
const NOTES = DEPOSITS.map((value, i) => {
  const label = vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1));
  const nullifier = testField(`note${i + 1}/nullifier`);
  const secret = testField(`note${i + 1}/secret`);
  return { value, label, nullifier, secret, commitment: commit(value, label, nullifier, secret) };
});
const STATE = NOTES.map((n) => n.commitment);
const LABELS = NOTES.map((n) => n.label);
const CHANGE = { nullifier: testField("change/nullifier"), secret: testField("change/secret") };

// The withdrawal of vault-v1.json's first context vector ("base, salt all zero"), and its context.
const CV = vectors.context[0]!;
const VAULT_ID = CV.input.processor!;
const CV_SCOPE = BigInt(CV.scope);
const WITHDRAWAL: VaultWithdrawal = {
  recipient: CV.input.recipient!,
  register_deposit: CV.input.register_deposit!,
  fee_recipient: CV.input.fee_recipient!,
  relay_fee: CV.input.relay_fee!,
  refund_precommitment: CV.input.refund_precommitment!,
  deadline_ms: Number(CV.input.deadline_ms),
  salt: CV.input.salt!,
};
const NO_FEE: VaultWithdrawal = { ...WITHDRAWAL, relay_fee: "0" };
const NOW_MS = 1_700_000_000_000; // before the vector's deadline

// proofs/g1-phone-prover/vectors/withdraw.input.json and expected.json at research aa5bc1e, the context the kit's
const FIXTURE_1: VaultWithdrawInput = {
  withdrawnValue: "2000000",
  stateRoot: "19694040607821770922157628280056958563843956415515542749943686243542539030332",
  stateTreeDepth: "3",
  ASPRoot: "14742355778095561659802612499961325813236213151846608975518831588135420342697",
  ASPTreeDepth: "3",
  context: CV.context,
  label: "21191667877100653879994570629138790103806258137606979449794495332957801757350",
  existingValue: "5000000",
  existingNullifier: "5167432713543849691669372229876238371551184851489376383337680122844515589001",
  existingSecret: "610564222651660383309139864082342321471986686129495337129421798287255001770",
  newNullifier: "435926882517854223419705721032557235689729807900982829830502095855616458144",
  newSecret: "9906398643276167292115241945932626924081447791502658224167153476529016246875",
  stateSiblings: [
    "8499859752932370550671001217394789767391951536670225367033658110958675062099",
    "18460099182874720517321811922424949874871394512135505136538365482650754885951",
    "7197033730596184833926326171655847741624026191254888622075668419707580736041",
    ...zeros(29),
  ],
  stateIndex: "1",
  ASPSiblings: [
    "4658404729088525114212902432163076279164051564274758828674194602518397827952",
    "6579407269730807145615902490936650763414898157842175773544529180591263279341",
    "21849742818759825417587640575331978719810059319426080405927000061567926427032",
    ...zeros(29),
  ],
  ASPIndex: "1",
};
const SIGNALS_1 = [
  "1",
  "17110053328481775770369382357212930435176681876033845347408611641206377530098",
  "13656508390809383486700253218777707324848145126455925481268684662948012579156",
  "2000000",
  FIXTURE_1.stateRoot,
  "3",
  FIXTURE_1.ASPRoot,
  "3",
  CV.context,
];

/** The arguments to spend note i from trees of these leaves, proving against their own roots. */
function args(i: number, withdrawn: bigint, o: { state?: bigint[]; labels?: bigint[]; withdrawal?: VaultWithdrawal } = {}): VaultWithdrawInputArgs {
  const n = NOTES[i]!;
  const stateTree = new VaultTree(o.state ?? STATE);
  const labelTree = new VaultTree(o.labels ?? LABELS);
  return {
    stateTree,
    labelTree,
    newestStateRoot: stateTree.root!,
    newestLabelRoot: labelTree.root!,
    note: { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret },
    newNullifier: CHANGE.nullifier,
    newSecret: CHANGE.secret,
    withdrawn,
    withdrawal: o.withdrawal ?? NO_FEE,
    vaultId: VAULT_ID,
    scope: CV_SCOPE,
    nowMs: NOW_MS,
  };
}
const spend = (i: number, withdrawn: bigint, o: Parameters<typeof args>[2] = {}): VaultWithdrawInput => vaultWithdrawInput(args(i, withdrawn, o));

/** The public signals the circuit must output for these inputs, computed apart from the wasm. */
function expectedSignals(inp: VaultWithdrawInput): string[] {
  const left = BigInt(inp.existingValue) - BigInt(inp.withdrawnValue);
  const newCommitment = commit(left, BigInt(inp.label), BigInt(inp.newNullifier), BigInt(inp.newSecret));
  const nullifierHash = poseidon1([BigInt(inp.existingNullifier)]);
  return ["1", newCommitment, nullifierHash, inp.withdrawnValue, inp.stateRoot, inp.stateTreeDepth, inp.ASPRoot, inp.ASPTreeDepth, inp.context].map(String);
}

test("the fixture's labels are the kit's vectors (vault-v1.json, nonces 1 and 2)", () => {
  for (const v of vectors.label.filter((l) => BigInt(l.scope) === SCOPE)) {
    assert.equal(String(LABELS[Number(v.nonce) - 1]), v.label, `nonce ${v.nonce}`);
  }
  assert.equal(vectors.label.filter((l) => BigInt(l.scope) === SCOPE).length, 2);
});

test("fixture 1: the inputs equal the research vector key for key, and the context is the kit's vector for the withdrawal", () => {
  const got = spend(1, 2_000_000n, { withdrawal: WITHDRAWAL });
  assert.deepEqual(got, FIXTURE_1);
  assert.equal(JSON.stringify(got), JSON.stringify(FIXTURE_1));
});

test("fixture 1: withdraw.wasm computes a witness whose 8 public signals are the research vector's, with the kit's context", async () => {
  assert.deepEqual(await witness(spend(1, 2_000_000n, { withdrawal: WITHDRAWAL })), SIGNALS_1);
  assert.deepEqual(expectedSignals(FIXTURE_1), SIGNALS_1);
});

test("every leaf of fixture trees of 1 to 100 leaves: the circuit's root rule reaches the tree's root", () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 33, 64, 65, 100]) {
    const leaves = Array.from({ length: n }, (_, i) => testField(`tree/${n}/${i}`));
    const t = new VaultTree(leaves);
    assert.equal(t.depth, n === 1 ? 0 : Math.ceil(Math.log2(n)), `depth of ${n}`);
    for (const [i, leaf] of leaves.entries()) {
      const p = t.path(leaf);
      assert.equal(p.siblings.length, 32);
      assert.equal(vaultRootOfPath(leaf, p.index, p.siblings), p.root, `${n} leaves, leaf ${i}`);
      const kept = p.siblings.findIndex((s) => s === 0n);
      assert.ok(p.siblings.slice(kept < 0 ? 32 : kept).every((s) => s === 0n), "every 0 is after the last sibling");
    }
  }
});

test("a tree kept on the device and grown page by page has the root and paths of one build, at every page", () => {
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const all = Array.from({ length: 1_100 }, (_, i) => testField(`pages/${i}`));
  const kept = new VaultTree();
  assert.equal(kept.root, undefined);
  let n = 0;
  while (n < all.length) {
    const size = Math.min(all.length - n, 1 + rnd(n < 40 ? 4 : 160));
    kept.append(all.slice(n, n + size));
    n += size;
    const once = new VaultTree(all.slice(0, n));
    assert.equal(kept.size, n);
    assert.equal(kept.root, once.root, `root at ${n}`);
    assert.equal(kept.depth, once.depth);
    for (const j of [0, n - 1, rnd(n), rnd(n)]) assert.deepEqual(kept.path(all[j]!), once.path(all[j]!), `path ${j} at ${n}`);
  }
  // a page with a leaf the vault never holds changes nothing
  const before = kept.root;
  assert.throws(() => kept.append([testField("pages/x"), 0n]), /page\[1\]: a leaf is never 0/);
  assert.throws(() => kept.append([VAULT_FIELD_P]), /page\[0\]: not a field element/);
  assert.throws(() => kept.append([]), /page: no leaves/);
  assert.equal(kept.root, before);
  assert.equal(kept.size, all.length);
});

test("withdraw.wasm accepts sparse paths, a change note at a later state index, a one-leaf tree and a full withdrawal", async () => {
  // note 5 of 5, all of it: levels 0 and 1 have no sibling, so LeanIMT's index (1) is not the leaf's position (4)
  const sparse = spend(4, 7_000_000n);
  assert.equal(sparse.stateIndex, "1");
  assert.deepEqual(sparse.stateSiblings.slice(1), zeros(31));
  assert.deepEqual(await witness(sparse), expectedSignals(sparse));

  // the change note of fixture 1, leaf 6 of the state tree, spent again: its label is still leaf 2 of the label tree
  const n = NOTES[1]!;
  const stateTree = new VaultTree(STATE);
  stateTree.append([commit(3_000_000n, n.label, CHANGE.nullifier, CHANGE.secret)]);
  const labelTree = new VaultTree(LABELS);
  const again = vaultWithdrawInput({
    ...args(1, 1_000_000n),
    stateTree,
    labelTree,
    newestStateRoot: stateTree.root!,
    newestLabelRoot: labelTree.root!,
    note: { value: 3_000_000n, label: n.label, nullifier: CHANGE.nullifier, secret: CHANGE.secret },
    newNullifier: testField("change2/nullifier"),
    newSecret: testField("change2/secret"),
  });
  assert.equal(again.stateIndex, "3"); // position 5 (0b101) of 6: level 1 has no sibling, so LeanIMT's index is 0b11
  assert.equal(again.ASPIndex, "1");
  assert.deepEqual(await witness(again), expectedSignals(again));

  // a vault of one deposit: depth 0, every sibling 0, the root is the leaf
  const one = spend(0, 2_000_000n, { state: [STATE[0]!], labels: [LABELS[0]!] });
  assert.equal(one.stateTreeDepth, "0");
  assert.equal(one.stateRoot, String(STATE[0]));
  assert.deepEqual(one.stateSiblings, zeros(32));
  assert.deepEqual(await witness(one), expectedSignals(one));
});

test("withdraw.wasm on random trees up to 300 leaves: every input it is given reaches its roots", async () => {
  let seed = 1;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let k = 0; k < 6; k++) {
    const extra = Array.from({ length: rnd(300) }, (_, i) => testField(`random/${k}/${i}`));
    const at = rnd(extra.length + 1);
    const state = [...extra.slice(0, at), STATE[2]!, ...extra.slice(at)];
    const labels = [...extra.slice(0, rnd(extra.length + 1)).map((x) => (x + 1n) % VAULT_FIELD_P), LABELS[2]!];
    const inp = spend(2, 1n, { state, labels });
    assert.deepEqual(await witness(inp), expectedSignals(inp));
  }
});

test("plants: 0s before the siblings, siblings out of order, or the leaf's position for LeanIMT's index fail at witness time", async () => {
  const f1 = spend(1, 1n); // three siblings in each tree
  assert.deepEqual(await witness(f1), expectedSignals(f1));
  const frontState = { ...f1, stateSiblings: [...zeros(29), ...f1.stateSiblings.slice(0, 3)] };
  await assert.rejects(witness(frontState), ASSERT);
  const frontLabel = { ...f1, ASPSiblings: [...zeros(29), ...f1.ASPSiblings.slice(0, 3)] };
  await assert.rejects(witness(frontLabel), ASSERT);
  const swapped = { ...f1, stateSiblings: [f1.stateSiblings[1]!, f1.stateSiblings[0]!, ...f1.stateSiblings.slice(2)] };
  await assert.rejects(witness(swapped), ASSERT);
  const sparse = spend(4, 1n); // note 5 of 5: one sibling, LeanIMT's index 1, position 4
  assert.deepEqual(await witness(sparse), expectedSignals(sparse));
  await assert.rejects(witness({ ...sparse, stateIndex: "4" }), ASSERT);
  await assert.rejects(witness({ ...sparse, ASPIndex: "4" }), ASSERT);
  await assert.rejects(witness({ ...sparse, stateSiblings: [...zeros(31), sparse.stateSiblings[0]!] }), ASSERT);
});

test("roots: a stale prefix of leaves or a forged leaf is refused against the vault's newest roots", async () => {
  const a = args(1, 1n);
  // the vault has a sixth leaf the device has not read: the five-leaf tree proves an old root the vault still accepts
  const newest = new VaultTree([...STATE, testField("later/commitment")]).root!;
  const stale = { ...a, newestStateRoot: newest };
  assert.throws(() => vaultWithdrawInput(stale), /stateTree: its root is not the vault's newest/);
  const staleLabels = { ...a, newestLabelRoot: new VaultTree([...LABELS, testField("later/label")]).root! };
  assert.throws(() => vaultWithdrawInput(staleLabels), /labelTree: its root is not the vault's newest/);
  // without the check, the stale tree's inputs are a good witness: only the root comparison stops them
  assert.deepEqual(await witness(vaultWithdrawInput(a)), expectedSignals(vaultWithdrawInput(a)));
  // a forged leaf in place of leaf 4: the device's root is one the vault never had
  const forged = new VaultTree([...STATE.slice(0, 3), testField("forged"), STATE[4]!]);
  assert.throws(() => vaultWithdrawInput({ ...a, stateTree: forged }), /stateTree: its root is not the vault's newest/);
  assert.throws(() => vaultWithdrawInput({ ...a, newestStateRoot: VAULT_FIELD_P }), /newestStateRoot: not a field element/);
  assert.throws(() => vaultWithdrawInput({ ...a, stateTree: new VaultTree() }), /stateTree: its root is not the vault's newest/);
});

test("a repeated leaf blocks only its own note, never another", async () => {
  // a leaf of the state tree repeats (the vault refuses that, LeafAlreadyExists, but a bug must not stop every exit)
  const state = [...STATE, STATE[0]!];
  const other = spend(2, 1n, { state });
  assert.deepEqual(await witness(other), expectedSignals(other));
  assert.throws(() => spend(0, 1n, { state }), /the note's commitment: leaf: repeats in the tree/);
  const labels = [...LABELS, LABELS[3]!];
  assert.deepEqual(await witness(spend(2, 1n, { labels })), expectedSignals(spend(2, 1n, { labels })));
  assert.throws(() => spend(3, 1n, { labels }), /the note's label: leaf: repeats in the tree/);
});

test("context: computed from the withdrawal after every check the vault makes of it", () => {
  assert.equal(spend(1, 2_000_000n, { withdrawal: WITHDRAWAL }).context, CV.context);
  // every other context vector whose withdrawal the vault would take for note 2 (5,000,000): context is the vector's
  let checked = 0;
  for (const c of vectors.context.slice(1)) {
    const w: VaultWithdrawal = {
      recipient: c.input.recipient!,
      register_deposit: c.input.register_deposit!,
      fee_recipient: c.input.fee_recipient!,
      relay_fee: c.input.relay_fee!,
      refund_precommitment: c.input.refund_precommitment!,
      deadline_ms: Number(c.input.deadline_ms),
      salt: c.input.salt!,
    };
    if (vaultWithdrawalProblems(w, 5_000_000n, c.input.processor!, 0).length > 0) continue;
    const got = vaultWithdrawInput({ ...args(1, 5_000_000n, { withdrawal: w }), vaultId: c.input.processor!, scope: BigInt(c.scope), nowMs: 0 });
    assert.equal(got.context, c.context, c.input.processor);
    checked++;
  }
  assert.ok(checked >= 5, `${checked} context vectors checked`);
  const refused: [string, Partial<VaultWithdrawal>, RegExp, number?][] = [
    ["recipient intents.near", { recipient: "intents.near" }, /recipient: intents\.near/],
    ["fee_recipient the vault", { fee_recipient: VAULT_ID }, /fee_recipient: the vault/],
    ["deadline passed", { deadline_ms: NOW_MS - 1 }, /deadline_ms: passed/],
    ["fee over the backstop", { relay_fee: "1" }, /relay_fee: over the backstop/],
    ["salt with 0x", { salt: "0x" + "0".repeat(32) }, /salt/],
  ];
  for (const [name, change, err] of refused) {
    assert.throws(() => vaultWithdrawInput(args(1, 1n, { withdrawal: { ...NO_FEE, ...change } })), err, name);
  }
  assert.throws(() => vaultWithdrawInput({ ...args(1, 1n), scope: VAULT_FIELD_P }), /scope: not a field element/);
});

test("refusals: what the circuit or the vault would refuse never reaches a proof", () => {
  const n = NOTES[1]!;
  const P = VAULT_FIELD_P;
  const base = args(1, 1n);
  const cases: [string, Partial<VaultWithdrawInputArgs>, RegExp][] = [
    ["wrong value", { note: { ...base.note, value: n.value + 1n } }, /commitment: leaf: not in the tree/],
    ["label absent", { ...args(1, 1n, { labels: LABELS.filter((_, i) => i !== 1) }) }, /label: leaf: not in the tree/],
    ["withdrawn 0", { withdrawn: 0n }, /withdrawn: 0/],
    ["withdrawn over value", { withdrawn: n.value + 1n }, /over the note's value/],
    ["value 2^128", { note: { ...base.note, value: 1n << 128n } }, /2\^128/],
    ["nullifier reused", { newNullifier: n.nullifier }, /equals the spent note's nullifier/],
    ["secret = p", { note: { ...base.note, secret: P } }, /note.secret: not a field element/],
    ["negative", { newSecret: -1n }, /newSecret: not a field element/],
  ];
  for (const [name, change, err] of cases) {
    assert.throws(() => vaultWithdrawInput({ ...base, ...change }), err, name);
  }
  const t = new VaultTree(STATE);
  assert.throws(() => t.path(LABELS[0]!), /leaf: not in the tree/);
  assert.throws(() => t.path(P), /leaf: not a field element/);
  assert.throws(() => vaultRootOfPath(1n, 0, [0n]), /not 32/);
  assert.throws(() => vaultRootOfPath(1n, 2 ** 32, Array<bigint>(32).fill(0n)), /index/);
});

test("vaultCommitment is Poseidon(value, label, precommitment): the devnet pool's leaf of the signing page's deposit, and inputs out of the field refused", () => {
  // scripts/live-checks/signpage-pool-notes.run.json: the leaf both devnet RPCs hold at state index 1
  const value = 10_000_000n;
  const label = 0x0efaebfbf3dcb8e13144b46ea286a820df0958a6ded265ee691a50591316fdddn;
  const pre = 0x28fb4aaedb8bc5a86143b4404719b308e41c297bcccd058edd831d990c064b48n;
  assert.equal(vaultCommitment(value, label, pre), 0x0446b3c85886af8a2b4ae432180fa6383587a2444f4df91581e2341426a1df3bn);
  assert.equal(vaultCommitment(value, label, pre), poseidon3([value, label, pre]));
  assert.throws(() => vaultCommitment(value, VAULT_FIELD_P, pre), /label: not a field element/);
  assert.throws(() => vaultCommitment(value, label, -1n), /precommitment: not a field element/);
  assert.throws(() => vaultCommitment(1n << 128n, label, pre), /value: 2\^128 or more/);
});
