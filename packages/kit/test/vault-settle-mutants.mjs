// node packages/kit/test/vault-settle-mutants.mjs (card vault-kit-settle): plants one wrong pick of the refund note at a
// time in a copy of the kit's src/vault/settle.ts (test/mutant-copy.mjs), runs the "refund by leaf" tests of
// test/vault-settle.test.ts there, and expects each to fail. The same three picks as packages/wallet/scripts/
// note-restore-refund-mutants.mjs (card wallet-refund-note-by-leaf, PR #413): anyone can put a second note on a spend's
// refund precommitment R, sharing the refund's nullifier, so any pick but the spend row's own leaf (refund_value,
// refund_label, refund_leaf_index, checked against the state tree) can strand the refund.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSync } from "../../../scripts/group-run.mjs";
import { kitCopy } from "./mutant-copy.mjs";

const PAT = "refund by leaf";
// the pick as settle.ts writes it: the spend row's own leaf, checked against the state tree at its index
const PICK = [
  "    const commitment = vaultCommitment(spend.refundValue, spend.refundLabel, rP);",
  "    if (leaves.get(spend.refundLeafIndex) !== commitment) throw new Error(`spend ${spend.index}: the state tree's leaf ${spend.refundLeafIndex} is not its refund note`);",
  "    const leaf: VaultSettleLeaf = { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: spend.refundLeafIndex };",
].join("\n");
// every settled refund on R the spends pages show, in row order
const ON_R = "s.spends.filter((x) => x.refundPrecommitment === rP && x.status === \"settled\" && x.refundValue > 0n)";
const of = (x) => `    const commitment = vaultCommitment(${x}.refundValue, ${x}.refundLabel, rP);\n    const leaf: VaultSettleLeaf = { value: ${x}.refundValue, label: ${x}.refundLabel, commitment, leafIndex: ${x}.refundLeafIndex };`;
const M = [
  // by commitment only: the note's commitment looked up in the leaves read; refund_leaf_index never read
  ["by commitment only", "    const commitment = vaultCommitment(spend.refundValue, spend.refundLabel, rP);\n    const at = [...leaves].find(([, l]) => l === commitment);\n    if (at === undefined) throw new Error(\"no leaf\");\n    const leaf: VaultSettleLeaf = { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: at[0] };"],
  // the first leaf on R: the first settled refund row on R the pages give
  ["first leaf on R", `    const onR = ${ON_R}[0]!;\n${of("onR")}`],
  // the lowest index: of every refund on R, the one at the lowest leaf index
  ["lowest index", `    const onR = ${ON_R}.sort((x, y) => (x.refundLeafIndex < y.refundLeafIndex ? -1 : 1))[0]!;\n${of("onR")}`],
];
// a sweep run inside node --test (test/mutants/vault-settle-mutants.test.mjs) must not hand its test context on: the
// child's own runner then reports to its parent, not on stdout
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
const root = kitCopy();
const F = path.join(root, "src/vault/settle.ts");
const src = readFileSync(F, "utf8");
if (src.split(PICK).length !== 2) {
  console.log("NOT ONCE: the refund pick in settle.ts");
  process.exit(1);
}
let ok = 0;
for (const [name, repl] of M) {
  writeFileSync(F, src.replace(PICK, repl));
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync(process.execPath, ["--test", `--test-name-pattern=${PAT}`, "test/vault-settle.test.ts"], { cwd: root, encoding: "utf8", env: CHILD_ENV, timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
else console.log(`every one of ${M.length} mutants fails its named test`);
