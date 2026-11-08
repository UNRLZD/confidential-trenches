// node packages/kit/test/pool-deposit-mutants.mjs (card kit-sol-pool-deposit-floor, audit S-01): plants one weakening of
// the Solana pool deposit's note floor at a time in a copy of the kit's src/trade/solana/pool-deposit.ts
// (test/mutant-copy.mjs), runs the named tests of test/pool-deposit.test.ts there, and expects each to fail: the
// comparison removed or off by one either way, the floor taken as a constant, without the page opening's rent, without
// the kit's own epoch fee or without MIN_DEPOSIT, and the rent's check removed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSync } from "../../../scripts/group-run.mjs";
import { kitCopy } from "./mutant-copy.mjs";

// [name, the source text, its replacement, the test name pattern]
const M = [
  ["the floor's comparison removed", "  if (value < floor) refuse(", "  if (false) refuse(", "S-01"],
  ["a note at the floor refused", "  if (value < floor) refuse(", "  if (value <= floor) refuse(", "S-01"],
  ["a note one under the floor built", "  if (value < floor) refuse(", "  if (value < floor - 1n) refuse(", "S-01"],
  ["the floor a constant (mainnet's on 2 Nov)", "  const floor = solanaPoolNoteFloor(rent);", "  const floor = 3_647_120n;", "S-01"],
  ["the floor without the page opening's rent", "  const opening = solanaPoolReleaseCost(rent) + solanaRentMin(rent, SOLANA_POOL_PAGE_HEADER);", "  const opening = solanaPoolReleaseCost(rent);", "S-01"],
  ["the floor without the kit's own epoch fee", "  const chunk = 2n * (opening > ours ? opening : ours);", "  const chunk = 2n * opening;", "S-01"],
  ["the floor without MIN_DEPOSIT", "  return chunk > SOLANA_POOL_MIN_DEPOSIT ? chunk : SOLANA_POOL_MIN_DEPOSIT;", "  return chunk;", "S-01"],
  ["the rent's check removed", "  if (rent === null || typeof rent !== \"object\"", "  if (false && typeof rent !== \"object\"", "refused before any bytes"],
];
// a sweep run inside node --test (test/mutants/pool-deposit-mutants.test.mjs) must not hand its test context on: the
// child's own runner then reports to its parent, not on stdout
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
const root = kitCopy();
const F = path.join(root, "src/trade/solana/pool-deposit.ts");
const src = readFileSync(F, "utf8");
for (const [name, from] of M) {
  if (src.split(from).length !== 2) {
    console.log(`NOT ONCE [${name}]: its source text in pool-deposit.ts`);
    process.exit(1);
  }
}
let ok = 0;
for (const [name, from, repl, pat] of M) {
  writeFileSync(F, src.replace(from, repl));
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync(process.execPath, ["--test", `--test-name-pattern=${pat}`, "test/pool-deposit.test.ts"], { cwd: root, encoding: "utf8", env: CHILD_ENV, timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  const by = [...new Set(r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("✖ ") && l !== "✖ failing tests:").map((l) => l.slice(2).replace(/ \([\d.]+ms\)$/, "")))];
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}${by.length ? `: ${by.join(" | ")}` : ""}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
else console.log(`every one of ${M.length} mutants fails its named test`);
