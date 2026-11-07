// node packages/kit/test/vault-settle-mutants.mjs (card vault-kit-settle): plants one wrong pick of the refund note at a
// time in a copy of the kit's src/vault/settle.ts (test/mutant-copy.mjs), runs the "refund by leaf" tests of
// test/vault-settle.test.ts there, and expects each to fail. The same three picks as packages/wallet/scripts/
// note-restore-refund-mutants.mjs (card wallet-refund-note-by-leaf, PR #413): anyone can put a second note on a spend's
// refund precommitment R, sharing the refund's nullifier, so any pick but the spend row's own leaf (refund_value,
// refund_label, refund_leaf_index, checked against the state tree) can strand the refund. Then the mutants the review of
// 3da33a6b found surviving, each run against the whole test file: the held-note check (F3), the moved-leaf refusal
// (F4), the duplicate nullifier refusal, the abort check before a send, the leaves read from the lowest refund leaf and
// the rows taken again with the leaves.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSync } from "../../../scripts/group-run.mjs";
import { kitCopy } from "./mutant-copy.mjs";

// the pick as settle.ts writes it: the spend row's own leaf, checked against the state tree at its index
const PICK = [
  "    const commitment = vaultCommitment(spend.refundValue, spend.refundLabel, rP);",
  "    if (leaves.get(spend.refundLeafIndex) !== commitment) throw new Error(`spend ${spend.index}: the state tree's leaf ${spend.refundLeafIndex} is not its refund note`);",
  "    const leaf: VaultSettleLeaf = { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: spend.refundLeafIndex };",
].join("\n");
// every settled refund on R the spends pages show, in row order
const ON_R = "s.spends.filter((x) => x.refundPrecommitment === rP && x.status === \"settled\" && x.refundValue > 0n)";
const of = (x) => `    const commitment = vaultCommitment(${x}.refundValue, ${x}.refundLabel, rP);\n    const leaf: VaultSettleLeaf = { value: ${x}.refundValue, label: ${x}.refundLabel, commitment, leafIndex: ${x}.refundLeafIndex };`;
const PICKS = [
  // by commitment only: the note's commitment looked up in the leaves read; refund_leaf_index never read
  ["by commitment only", "    const commitment = vaultCommitment(spend.refundValue, spend.refundLabel, rP);\n    const at = [...leaves].find(([, l]) => l === commitment);\n    if (at === undefined) throw new Error(\"no leaf\");\n    const leaf: VaultSettleLeaf = { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: at[0] };"],
  // the first leaf on R: the first settled refund row on R the pages give
  ["first leaf on R", `    const onR = ${ON_R}[0]!;\n${of("onR")}`],
  // the lowest index: of every refund on R, the one at the lowest leaf index
  ["lowest index", `    const onR = ${ON_R}.sort((x, y) => (x.refundLeafIndex < y.refundLeafIndex ? -1 : 1))[0]!;\n${of("onR")}`],
];
// [name, the source text, its replacement, the test name pattern or null for the whole file]
const M = [
  ...PICKS.map(([name, repl]) => [name, PICK, repl, "refund by leaf"]),
  ["F3: any note held on R taken as the refund", "    if (!written && !sameLeaf(held.get(rP), leaf)) throw", "    if (false) throw", null],
  ["F4: a leaf moved below the leaves read not refused", "    if (low !== null && low < from) throw", "    if (false) throw", null],
  ["a nullifier hash held twice not refused", "      if (by.has(row.nullifierHash)) throw", "      if (false) throw", null],
  ["no abort check before a send", "      a.signal?.throwIfAborted();\n", "", null],
  ["leaves read from 0", "leaves: Number(from) }", "leaves: 0 }", null],
  ["the step-1 rows kept past the leaves read", "    rows = ours(s); // a settle that landed by this read is taken too\n", "", null],
  // the second review's survivors (L1): each against the whole test file
  ["F6: any add refusal taken as the note held", "        if (!held.has(rP)) throw e;\n", "", null],
  ["sameLeaf ignoring the leaf index", " && h.leafIndex === l.leafIndex;", ";", null],
  ["sameLeaf letting a held note with no leaf pass", "  return h !== undefined && h.value === l.value && h.label === l.label && h.commitment === l.commitment && h.leafIndex === l.leafIndex;", "  return h === undefined || (h.value === l.value && h.label === l.label && h.commitment === l.commitment && h.leafIndex === l.leafIndex);", null],
];
// a sweep run inside node --test (test/mutants/vault-settle-mutants.test.mjs) must not hand its test context on: the
// child's own runner then reports to its parent, not on stdout
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
const root = kitCopy();
const F = path.join(root, "src/vault/settle.ts");
const src = readFileSync(F, "utf8");
for (const [name, from] of M) {
  if (src.split(from).length !== 2) {
    console.log(`NOT ONCE [${name}]: its source text in settle.ts`);
    process.exit(1);
  }
}
let ok = 0;
for (const [name, from, repl, pat] of M) {
  writeFileSync(F, src.replace(from, repl));
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync(process.execPath, ["--test", ...(pat ? [`--test-name-pattern=${pat}`] : []), "test/vault-settle.test.ts"], { cwd: root, encoding: "utf8", env: CHILD_ENV, timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  // the tests that killed it, each named once (the runner repeats them under "failing tests")
  const by = [...new Set(r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("✖ ") && l !== "✖ failing tests:").map((l) => l.slice(2).replace(/ \([\d.]+ms\)$/, "")))];
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}${by.length ? `: ${by.join(" | ")}` : ""}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
else console.log(`every one of ${M.length} mutants fails its named test`);
