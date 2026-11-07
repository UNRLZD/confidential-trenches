// node packages/wallet/scripts/note-restore-refund-mutants.mjs (card wallet-refund-note-by-leaf): plants one wrong pick of
// the refund note at a time in restore.ts, runs the "refund by leaf" test, expects it to fail, puts the source back. A
// stranger's 1 USDC on a spend's refund precommitment R is a second note on R with the same nullifier: a pick that takes
// it in place of the spend row's own leaf (refund_value, refund_label, refund_leaf_index) would strand the refund.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const F = `${W}/src/notes/restore.ts`;
const T = "test/note-restore.test.ts";
const PAT = "refund by leaf";
// the pick as restore.ts writes it: the spend row's own leaf, checked against the state tree at its index
const PICK = [
  "        const commitment = noteCommitment(spend.refundValue, spend.refundLabel, rP);",
  "        treeHas(commitment, spend.refundLeafIndex, `spend ${spend.index}'s refund note`);",
  "        put(rref, rP, { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: spend.refundLeafIndex }, key);",
].join("\n");
// every leaf on R the pages show: the deposit rows on R, then the spend row's refund
const ON_R = "const onR = [...pages.deposits.filter((d) => d.precommitment === rP).map((d) => ({ value: d.value, label: d.label, leafIndex: d.leafIndex })), { value: spend.refundValue, label: spend.refundLabel, leafIndex: spend.refundLeafIndex }].map((x) => ({ ...x, commitment: noteCommitment(x.value, x.label, rP) }));";
const M = [
  // by commitment only: the first commitment on R found in the state tree, its index looked up by commitment; refund_leaf_index never read
  ["by commitment only", `        ${ON_R}\n        const m = onR.find((x) => leafAt.has(x.commitment))!;\n        put(rref, rP, { value: m.value, label: m.label, commitment: m.commitment, leafIndex: BigInt(leafAt.get(m.commitment)!) }, key);`],
  // the first leaf on R: the row the pages give first for R (a deposit row before the spend's refund)
  ["first leaf on R", "        const d = byP.get(rP);\n        const m = d ? { value: d.value, label: d.label, leafIndex: d.leafIndex } : { value: spend.refundValue, label: spend.refundLabel, leafIndex: spend.refundLeafIndex };\n        put(rref, rP, { ...m, commitment: noteCommitment(m.value, m.label, rP) }, key);"],
  // the lowest index: of every leaf on R, the one at the lowest leaf index
  ["lowest index", `        ${ON_R}\n        const m = onR.sort((x, y) => (x.leafIndex < y.leafIndex ? -1 : 1))[0]!;\n        put(rref, rP, { value: m.value, label: m.label, commitment: m.commitment, leafIndex: m.leafIndex }, key);`],
];
const src = readFileSync(F, "utf8");
if (src.split(PICK).length !== 2) {
  console.log("NOT ONCE: the refund pick in restore.ts");
  process.exit(1);
}
let ok = 0;
for (const [name, repl] of M) {
  writeFileSync(F, src.replace(PICK, repl));
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync("node", ["--test", `--test-name-pattern=${PAT}`, T], { cwd: W, encoding: "utf8", timeoutMs: 120_000 });
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
