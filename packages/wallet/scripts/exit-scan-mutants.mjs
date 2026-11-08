// node packages/wallet/scripts/exit-scan-mutants.mjs (card exit-note-scan): plants one wrong take/skip rule at a time in
// the wallet's restore (src/notes/restore.ts), which the exit tool's scan runs unchanged through the kit's ./core
// (packages/exit/src/scan.ts), then runs the exit's packages/exit/test/scan.test.ts, the killing test, and expects it to
// fail; the source is put back after each run, whatever happens. Each mutant is a way the scan could take a leaf on one
// of our precommitments that is not ours to take, the stranger's 1 USDC twin on our refund precommitment R above all,
// whose spend would burn our refund F through their shared nullifier.
// It lives here, beside note-restore-refund-mutants.mjs (the same refund pick, killed by the wallet's own test), and
// not in packages/exit, because two gates hold that folder apart: every mutant sweep runs its test runs through
// scripts/group-run.mjs (scripts/ci/mutant-groups.test.mjs), and an import from packages/exit must resolve in the
// deep-import gate's copy of packages/ alone (.dependency-cruiser.cjs exit-imports-must-resolve,
// scripts/ci/deep-import.test.mjs), where scripts/group-run.mjs is not.
// A stale entry stops the sweep before any run: every text an entry replaces must occur in restore.ts exactly once.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";

const F = fileURLToPath(new URL("../src/notes/restore.ts", import.meta.url));
const EXIT = fileURLToPath(new URL("../../exit/", import.meta.url));
const T = "test/scan.test.ts";

const STOP = "    if (spend.refundValue > 0n && spend.refundPrecommitment !== rP) throw new Error(`spend ${spend.index}: its refund is on a precommitment that is not refund note (l ${l}, j ${j})`);\n";
const SETTLED = '      if (spend.status === "settled") {\n';
const PICK = [
  "        const commitment = noteCommitment(spend.refundValue, spend.refundLabel, rP);",
  "        treeHas(commitment, spend.refundLeafIndex, `spend ${spend.index}'s refund note`);",
  "        put(rref, rP, { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: spend.refundLeafIndex }, key);",
].join("\n");
const MOVE = '    asDeposit({ kind: "move", l, j });\n';
// the first leaf on R the pages give: a deposit row on R before the spend row's own refund
const FIRST_ON_R = [
  "        const d = byP.get(rP);",
  "        const m = d ? { value: d.value, label: d.label, leafIndex: d.leafIndex } : { value: spend.refundValue, label: spend.refundLabel, leafIndex: spend.refundLeafIndex };",
  "        put(rref, rP, { ...m, commitment: noteCommitment(m.value, m.label, rP) }, key);",
].join("\n");
// a deposit row on R taken as the refund only when it holds the refund's own value: a stranger picks the value, so a
// twin of F's value must still never be taken
const SAME_VALUE_ON_R = FIRST_ON_R.replace("d ? {", "d && d.value === spend.refundValue ? {");

/** [name, [from, to] replacements, each of which must match restore.ts exactly once] */
const M = [
  ["a deposit row on rP taken as the refund", [[PICK, FIRST_ON_R]]],
  ["a deposit row on rP of the refund's value taken as the refund", [[PICK, SAME_VALUE_ON_R]]],
  ["refund_pending taken as settled, from the leaf on R", [[SETTLED, '      if (spend.status === "settled" || (spend.status === "refund_pending" && byP.has(rP))) {\n'], [PICK, FIRST_ON_R]]],
  ["a refund on a precommitment other than rP taken", [[STOP, ""], [PICK, PICK.replaceAll("rP", "spend.refundPrecommitment")]]],
  ["a deposit row on R taken as a deposit-kind note", [[MOVE, `    asDeposit(rref);\n${MOVE}`]]],
];

const src = readFileSync(F, "utf8");
for (const [name, reps] of M)
  for (const [from] of reps)
    if (src.split(from).length !== 2) {
      console.log(`NOT ONCE in restore.ts, for [${name}]: ${JSON.stringify(from.slice(0, 60))}`);
      process.exit(1);
    }
let killed = 0;
for (const [name, reps] of M) {
  writeFileSync(F, reps.reduce((s, [from, to]) => s.replace(from, () => to), src));
  let r;
  try {
    // a run past 180 s is killed, its process group with it (scripts/group-run.mjs)
    r = runSync("node", ["--test", T], { cwd: EXIT, encoding: "utf8", timeoutMs: 180_000 });
  } finally {
    writeFileSync(F, src);
  }
  const fail = Number((r.stdout.match(/ℹ fail (\d+)/) ?? [])[1] ?? 0);
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const dead = r.status !== 0 && fail > 0;
  if (dead) killed++;
  const which = [...r.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((x) => x[1]).filter((x) => x !== T && !x.startsWith("failing"));
  console.log(`${dead ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}${which.length ? `: ${[...new Set(which)].join(" | ")}` : ""}`);
}
if (readFileSync(F, "utf8") !== src) throw new Error("restore.ts was not put back");
console.log(`${killed}/${M.length} killed`);
if (killed !== M.length) process.exitCode = 1;
