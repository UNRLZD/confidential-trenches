// Removes each of src/checks/evm/pool-index.ts's rules (F4a-F4d, F5, F6, card evm-pool-index), one at a time, and runs
// the test named for it in test/evm-pool-index.test.ts: each named test passes on the code as it is and fails on every
// mutant. The file is changed in a copy of the kit (test/mutant-copy.mjs), never the kit's own, and put back after each
// mutant (and checked to be back); exits 1 when a named test passes on its mutant, fails or runs no test on the code as
// it is, or a mutant's text is not in its file exactly once.
//   node packages/kit/test/evm-pool-index-mutants.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
import { KIT, kitCopy } from "./mutant-copy.mjs";

const BASE = process.argv[1] === fileURLToPath(import.meta.url) ? kitCopy() : KIT;
const SRC = path.join(BASE, "src/checks/evm/pool-index.ts");
const TEST = path.join(BASE, "test/evm-pool-index.test.ts");

const F4A = "F4a: a span counts only when both readers answered it";
const F4B = "F4b: the index head is the lower of the two proven heads";
const F4C = "F4c: the gap read ends at the agreed block";
const F4D = "F4d: stored only up to the reorg margin below the head";
const F5 = "F5: a pool only one reader reported is kept only if";
const F6 = "F6: past the hard pool cap the index refuses by name";
const HALVES = "a span answered with an error is asked as its halves";
const LIMITED = "a rate limit answered inside a batch is asked again";
const LAG = "a sync whose readers lag the last sync's head";
const FLOOD = "one reader's made-up pools never refuse the index as too many";
const F6B = F6;

/** [find, replace, test]: each a rule removed. */
export const MUTANTS = [
  // F4a: an answer without its last block counts
  ["if (!Array.isArray(logs) || !blk || !isHash(blk.hash) || !isQty(blk.number) || Number(blk.number) !== j.b) return null;", "if (!Array.isArray(logs)) return null;", F4A],
  // F4a: a failed span is not asked again
  ["export const INDEX_TRIES = 4;", "export const INDEX_TRIES = 1;", F4A],
  // F4a: one reader's answer is enough
  ["return js.flatMap((j) => (j.ans[0] !== null && j.ans[1] !== null ? settle(j) : [j]));", "return js.flatMap((j) => (j.ans[0] !== null || j.ans[1] !== null ? ((j.ans[0] ??= j.ans[1]), (j.ans[1] ??= j.ans[0]), settle(j)) : [j]));", F4A],
  // F4b: the higher head
  ["const n = Math.min(heads[0]!, heads[1]!);", "const n = Math.max(heads[0]!, heads[1]!);", F4B],
  // F4c: no pin
  ['if (x.hash !== y.hash) return refuse("rpc_disagree", `the index readers do not agree on block ${n}`);', "", F4C],
  // F4c: the newest span not asked alone first
  ["let at = queue.shift();\n  while (at !== undefined && pin === null) {", "let at = queue.shift();\n  if (at !== undefined) queue.push(at);\n  at = undefined;\n  while (at !== undefined && pin === null) {", F4C],
  // F4d: no margin
  ["const stored = Math.max(old?.through ?? from - 1, n - c.margin);", "const stored = n;", F4D],
  // a lagging sync lowers what an earlier one stored
  ["const stored = Math.max(old?.through ?? from - 1, n - c.margin);", "const stored = Math.max(from - 1, n - c.margin);", LAG],
  // F5: one reader's pool kept unread
  ["(y.pools.has(id) ? both : one).push(p);", "both.push(p);", F5],
  // F5: one provider's state is enough
  ["else if (w.every((x) => BigInt.asUintN(160, BigInt(x)) !== 0n)) held.add(p.id);", "else if (w.some((x) => BigInt.asUintN(160, BigInt(x)) !== 0n)) held.add(p.id);", F5],
  // F5: the log's id word trusted
  ["if (id !== t[1]!.toLowerCase()) return null;", "", F5],
  // F6: no cap
  ["count += both.length;\n    if (count > c.cap) return refuse(", "count += both.length;\n    if (false) return refuse(", F6],
  // one reader's pools counted before F5
  ["count += both.length;\n", "count += both.length + one.length;\n", FLOOD],
  // F5's held pools not counted
  ["count += held.size;", "", F6B],
  // the halves: an error answer is no cut
  ["if (l?.error !== undefined && l.result === undefined) return limited(l.error) ? null : { hash: \"\", pools: new Map(), cut: true };", "", HALVES],
  // a rate limit in a batch asked as halves
  ["return limited(l.error) ? null : { hash", "return false ? null : { hash", LIMITED],
  // a 429 spends a try
  ["if (/429|rate limit/i.test(String((e as Error)?.message)) && waits < INDEX_LIMITED_WAITS) {", "if (false) {", HALVES],
];

const RUN_MS = 120_000;
function run(name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, TEST];
  const r = runSync("node", args, { stdio: "pipe", encoding: "utf8", timeoutMs: RUN_MS });
  if (r.status !== 0) return "fail";
  return /^# pass ([1-9]\d*)$/m.test(r.stdout) ? "pass" : "none";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = readFileSync(SRC, "utf8");
  let bad = 0;
  for (const t of new Set(MUTANTS.map((m) => m[2]))) {
    const r = run(t);
    if (r !== "pass") {
      console.log(`FAIL "${t}" ${r === "none" ? "names no test" : "fails on the code as it is"}`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  MUTANTS.forEach(([find, repl, t], i) => {
    if (src.split(find).length !== 2) {
      console.log(`FAIL mutant ${i + 1}: its text is not in pool-index.ts exactly once`);
      bad++;
      return;
    }
    writeFileSync(SRC, src.replace(find, repl));
    let r;
    try {
      r = run(t);
    } finally {
      writeFileSync(SRC, src);
    }
    if (readFileSync(SRC, "utf8") !== src) throw new Error(`mutant ${i + 1} left pool-index.ts changed`);
    console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
    if (r !== "fail") bad++;
  });
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
