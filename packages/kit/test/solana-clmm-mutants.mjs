// node packages/kit/test/solana-clmm-mutants.mjs (card solana-buy-never-below-a-hidden-market): plants one weakening of
// the Raydium CLMM market read (src/trade/solana/clmm.ts) or of the set rule a market enters (src/trade/solana/pool.ts
// solanaReferenceSet) at a time in a copy of the kit (test/mutant-copy.mjs), runs the named tests of
// test/solana-clmm.test.ts there, and expects each to fail: a band, the identity bytes, the config, a vault's owner, mint
// or program, the swap switch, the open time, the one read more, a provider's fault, the cell's edge, the fee in or out,
// the dynamic fee, a USDC market priced with no SOL/USD; a market that does not raise E, one that lowers it, one under
// the cutoff counted, a cutoff over the traded pools alone, a market in the set; the finder's scans in both mint orders
// or in the order turned (src/trade/solana/dlmm.ts).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { refused, runMutant } from "../../../scripts/mutant-run.mjs";
import { kitCopy } from "./mutant-copy.mjs";

const CLMM = "src/trade/solana/clmm.ts";
const POOL = "src/trade/solana/pool.ts";
const DLMM = "src/trade/solana/dlmm.ts";
// [name, file, the source text, its replacement, the test name pattern]
const M = [
  ["the price band dropped", CLMM, "if (!solanaReservesAgree(x.pool.sqrtPriceX64 ** 2n, y.pool.sqrtPriceX64 ** 2n))", "if (false)", "CL6"],
  ["the quote vault band dropped", CLMM, "if (!solanaReservesAgree(x.vaults[q]!, y.vaults[q]!))", "if (false)", "CL6"],
  ["the liquidity band dropped", CLMM, "if (!solanaReservesAgree(x.pool.liquidity, y.pool.liquidity))", "if (false)", "CL6"],
  ["the identity bytes not compared", CLMM, "return SOLANA_CLMM_POOL_STATIC.every(", "return true || SOLANA_CLMM_POOL_STATIC.every(", "CL6"],
  ["the config not compared", CLMM, "ca.data.some((x, i) => x !== cb.data[i])", "false", "CL6"],
  ["a vault of another mint or owner taken", CLMM, "if (t.mint !== mint || t.owner !== address)", "if (false)", "CL6"],
  ["a vault of any program taken", CLMM, "if (!programs.includes(v.owner))", "if (false)", "CL6"],
  ["a pool with swaps off taken", CLMM, "const swaps = (pool.status & STATUS_SWAP_OFF) === 0;", "const swaps = true;", "CL9"],
  ["a pool not yet open taken", CLMM, "BigInt.asUintN(64, clock.unixTimestamp) >= pool.openTime", "true", "CL9"],
  ["no read more after a disagreement", CLMM, "for (let round = 0; round < 2; round++)", "for (let round = 0; round < 1; round++)", "CL8"],
  ["a provider's fault not refused", CLMM, "if (!a || !b) {", "if (!a && !b) {", "CL10"],
  ["credit past the cell's edge", CLMM, "if (atEdge !== null && forPrice >= atEdge[0]) {", "if (false) {", "CL2"],
  ["the fee on input dropped", CLMM, "const forPrice = feeOnInput ? (amountIn * (FEE_DEN - feeRate)) / FEE_DEN : amountIn;", "const forPrice = amountIn;", "CL2"],
  ["the fee on output dropped", CLMM, "if (!feeOnInput) out -= ceilDiv(out * feeRate, FEE_DEN);", "", "CL4"],
  ["the dynamic fee's cap not added", CLMM, "const total = tradeFeeRate + dynamic;", "const total = tradeFeeRate;", "CL4"],
  ["a USDC market priced with no SOL/USD", CLMM, "if (x.side.quote === \"usdc\" && solUsd === null) return { kind: \"usd\" };", "", "CL11"],
  ["a counted market never raises E", POOL, "if (counted && r.out > best.out) best = r;", "", "CL13"],
  ["a market under the cutoff counted", POOL, "if (counted && r.out > best.out) best = r;", "if (r.out > best.out) best = r;", "CL13"],
  ["a market that pays less lowers E", POOL, "if (counted && r.out > best.out) best = r;", "if (counted) best = r;", "CL13"],
  ["the cutoff over the traded pools alone", POOL, "const maxAll = all.reduce(", "const maxAll = candidates.reduce(", "CL13"],
  ["a market in the set", POOL, "const candidates = all.filter(traded);", "const candidates = all;", "CL13"],
  ["both mint orders scanned", DLMM, "const orders: (readonly [string, string])[] = kind.ordered ?", "const orders: (readonly [string, string])[] = false ?", "CL14"],
  ["the mint order turned", DLMM, "for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;", "for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;", "CL14"],
];
const root = kitCopy();
const src = new Map([CLMM, POOL, DLMM].map((f) => [f, readFileSync(path.join(root, f), "utf8")]));
for (const [name, file, from] of M) {
  if (src.get(file).split(from).length !== 2) {
    console.log(`NOT ONCE [${name}]: its source text in ${file}`);
    process.exit(1);
  }
}
let ok = 0;
for (const [name, file, from, repl, pat] of M) {
  const F = path.join(root, file);
  writeFileSync(F, src.get(file).replace(from, repl));
  let r;
  try {
    // a run past 120 s is killed, its process group with it; a run with no verdict is refused (scripts/mutant-run.mjs)
    r = runMutant([`--test-name-pattern=${pat}`, "test/solana-clmm.test.ts"], { cwd: root, timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src.get(file));
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
