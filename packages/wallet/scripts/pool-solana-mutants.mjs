// node packages/wallet/scripts/pool-solana-mutants.mjs (card notes-per-pool-sol): plants one mutant at a time in the card's source, runs the named test, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const S = `${W}/src/pool/solana.ts`, R = `${W}/src/pool/solana-restore.ts`;
const M = [
  [S, "if (a?.owner !== program)", "if (false)", "another owner"],
  [S, "if (!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree || !same(d.subarray(9, 13), u32le(pageNo)))", "if (!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree)", "another owner"],
  [S, "if (l[i]!.t < l[i - 1]!.t) throw", "if (false) throw", "has not reached the cut"],
  [S, "if (beforeMs !== null && ms < beforeMs) throw", "if (false) throw", "has not reached the cut"],
  [S, "if (!same(x[i]!.bytes, y[i]!.bytes)) throw", "if (false) throw", "has not reached the cut"],
  [S, "if ((x.length > n && x[n]!.t < beforeMs) || (y.length > n && y[n]!.t < beforeMs)) throw", "if (false) throw", "has not reached the cut"],
  [S, "if (n === 0) throw", "if (false) throw", "has not reached the cut"],
  [S, "if (t.root !== cut[cut.length - 1]!.root) throw", "if (false) throw", "has not reached the cut"],
  [S, "if (fresh[i - start] === undefined || !same(fresh[i - start]!.bytes, kept[i]!.bytes)) throw", "if (false) throw", "has changed in a later read"],
  [S, "const from = [Math.floor(base[0].length / SOL_PAGE_ENTRIES), Math.floor(base[1].length / SOL_PAGE_ENTRIES)] as const;", "const from = [0, 0] as const;", "a full page is read once"],
  [S, "if (fee > bound) throw", "if (false) throw", "the fee bound"],
  [S, "if (fee < cost) throw", "if (false) throw", "the fee bound"],
  [S, "if (fee % SOL_FEE_STEP !== 0n) throw", "if (false) throw", "the fee bound"],
  [S, "export const SOL_FEE_HEADROOM = 2n * SOL_FEE_STEP;", "export const SOL_FEE_HEADROOM = 3n * SOL_FEE_STEP;", "the fee bound"],
  [S, "|| f.fee_payer !== feePayer)", ")", "the fee bound"],
  [S, "if (a.rent0 !== b.rent0 || a.rent72 !== b.rent72 || a.baseFee !== b.baseFee) throw", "if (false) throw", "the fee bound"],
  [S, "if (fee * 10_000n > chunk * MAX_RELAY_FEE_BPS) throw", "if (false) throw", "backstop"],
  [S, "if (chunk - fee - SOL_TIP_CAP < reads.rent0) throw", "if (false) throw", "backstop"],
  [S, "const cost = c.rent0 + (c.rent72 - c.rent0) + c.baseFee;", "const cost = c.rent72 + c.baseFee + 1n;", "the fee bound"],
  [S, "return a.ms < b.ms ? a.ms : b.ms;", "return a.ms;", "lower of the two"],
  [R, "if (p.size !== q.size || [...p].some(([key, d]) => q.get(key) !== d)) throw", "if (false) throw", "restore refuses"],
  [R, "if (m.value === 0n || m.nonce === 0n || m.nonce > BigInt(a.labelLeaves.length)) throw", "if (false) throw", "restore refuses"],
  [R, "if (a.labelLeaves[Number(m.nonce - 1n)] !== label) throw", "if (false) throw", "restore refuses"],
  [R, "if (at === undefined) throw", "if (false) throw", "restore refuses"],
];
let ok = 0;
for (const [f, find, repl, pat] of M) {
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { console.log(`NOT ONCE: ${find}`); process.exitCode = 1; continue; }
  writeFileSync(f, src.replace(find, repl));
  const r = spawnSync("node", ["--test", `--test-name-pattern=${pat}`, "test/pool-solana.test.ts"], { cwd: W, encoding: "utf8", timeout: 120_000 });
  writeFileSync(f, src);
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${pat}] pass ${pass} fail ${fail}: ${f.endsWith("restore.ts") ? "solana-restore.ts" : "solana.ts"}: ${find.slice(0, 70)}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
