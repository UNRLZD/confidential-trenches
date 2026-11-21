// node packages/kit/test/solana-clmm-mutants.mjs (card solana-buy-never-below-a-hidden-market): plants one weakening of
// the Raydium CLMM market read at a time in a copy of the kit's src/trade/solana/clmm.ts (test/mutant-copy.mjs), runs
// the named tests of test/solana-clmm.test.ts there, and expects each to fail: a band, the identity bytes, a vault's
// owner, mint or program, the swap switch, the one read more, the SOL side or the price's direction dropped or swapped.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { refused, runMutant } from "../../../scripts/mutant-run.mjs";
import { kitCopy } from "./mutant-copy.mjs";

// [name, the source text, its replacement, the test name pattern]
const M = [
  ["the price band dropped", "if (!solanaReservesAgree(x.pool.sqrtPriceX64 ** 2n, y.pool.sqrtPriceX64 ** 2n))", "if (false)", "CL3"],
  ["the SOL vault band dropped", "if (!solanaReservesAgree(x.depth, y.depth))", "if (false)", "CL3"],
  ["the identity bytes not compared", "return SOLANA_CLMM_POOL_STATIC.every(", "return true || SOLANA_CLMM_POOL_STATIC.every(", "CL3"],
  ["a vault of another mint or owner taken", "if (t.mint !== mint || t.owner !== address)", "if (false)", "CL3"],
  ["a vault of any program taken", "if (!programs.includes(v.owner))", "if (false)", "CL3"],
  ["a pool with swaps off taken", "(p.status & STATUS_SWAP_OFF) === 0 && ", "", "CL6"],
  ["no read more after a disagreement", "for (let round = 0; round < 2; round++)", "for (let round = 0; round < 1; round++)", "CL5"],
  ["the coin's vault taken as the depth", "depth: held[side.solIs0 ? 0 : 1]!", "depth: held[side.solIs0 ? 1 : 0]!", "CL2"],
  ["the price read the wrong way", "const zeroIn = side === \"buy\" ? solIs0 : !solIs0;", "const zeroIn = side === \"buy\" ? !solIs0 : solIs0;", "CL1"],
  ["a provider's fault not refused", "if (!a || !b) {", "if (!a && !b) {", "CL7"],
];
const root = kitCopy();
const F = path.join(root, "src/trade/solana/clmm.ts");
const src = readFileSync(F, "utf8");
for (const [name, from] of M) {
  if (src.split(from).length !== 2) {
    console.log(`NOT ONCE [${name}]: its source text in clmm.ts`);
    process.exit(1);
  }
}
let ok = 0;
for (const [name, from, repl, pat] of M) {
  writeFileSync(F, src.replace(from, repl));
  let r;
  try {
    // a run past 120 s is killed, its process group with it; a run with no verdict is refused (scripts/mutant-run.mjs)
    r = runMutant([`--test-name-pattern=${pat}`, "test/solana-clmm.test.ts"], { cwd: root, timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src);
  }
  if (refused(name, r)) continue;
  const killed = r.verdict === "killed";
  if (killed) ok++;
  const by = [...new Set(r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("✖ ") && l !== "✖ failing tests:").map((l) => l.slice(2).replace(/ \([\d.]+ms\)$/, "")))];
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${r.pass} fail ${r.fail}${by.length ? `: ${by.join(" | ")}` : ""}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
else console.log(`every one of ${M.length} mutants fails its named test`);
