// node packages/wallet/scripts/pool-solana-mutants.mjs (card notes-per-pool-sol): plants one mutant at a time in the card's source, runs the named test, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { runTests } from "./mutant-run.mjs";
import { fileURLToPath } from "node:url";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const S = `${W}/src/pool/solana.ts`, R = `${W}/src/pool/solana-restore.ts`;
const Q = `${W}/src/pool/queue.ts`, K = `${W}/../kit/src/trade/solana/pool-buy.ts`;
const T = "test/pool-solana.test.ts";
// [file, find, replace, test file, test name pattern]
const M = [
  [S, "if (a?.owner !== program)", "if (false)", T, "another owner"],
  [S, "if (!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree || !same(d.subarray(9, 13), u32le(pageNo)))", "if (!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree)", T, "another owner"],
  [S, "if (l[i]!.t < l[i - 1]!.t) throw", "if (false) throw", T, "has not reached the cut"],
  [S, "if (ms < beforeMs) throw", "if (false) throw", T, "has not reached the cut"],
  [S, "if (ms < beforeMs) throw", "if (ms + 1000n < beforeMs) throw", T, "S9"],
  [S, "if (!same(x[i]!.bytes, y[i]!.bytes)) throw", "if (false) throw", T, "has not reached the cut"],
  [S, "if ((x.length > n && x[n]!.t < beforeMs) || (y.length > n && y[n]!.t < beforeMs)) throw", "if ((x.length > n && x[n]!.t < beforeMs)) throw", T, "RV2"],
  [S, "if (n === 0) throw", "if (false) throw", T, "has not reached the cut"],
  [S, "if (t.root !== cut[cut.length - 1]!.root) throw", "if (tree === 0 && t.root !== cut[cut.length - 1]!.root) throw", T, "RV2"],
  [S, "if (!same(fresh[i - start]!.bytes, kept[i]!.bytes)) throw", "if (false) throw", T, "has changed in a later read"],
  [S, "const from = [Math.floor(base[0].length / SOL_PAGE_ENTRIES), Math.floor(base[1].length / SOL_PAGE_ENTRIES)] as const;", "const from = [0, 0] as const;", T, "a full page is read once"],
  [S, "Math.max(minSlot, lastSlot[k]!)", "minSlot", T, "RV11"],
  [S, "if (at < minContextSlot) throw", "if (false) throw", T, "RV7"],
  [S, "opts?.newest === true ? \"confirmed\" : \"finalized\"", "\"finalized\"", T, "RV9"],
  [S, "if (commitment === \"finalized\") {", "if (true) {", T, "RV9"],
  [S, "if (typeof f.fee !== \"string\" || f.fee !== fee.toString()) throw", "if (false) throw", T, "the epoch fee is the device's own"],
  [K, "export const SOLANA_POOL_FEE_HEADROOM = 2n * SOLANA_POOL_FEE_STEP;", "export const SOLANA_POOL_FEE_HEADROOM = 3n * SOLANA_POOL_FEE_STEP;", T, "the epoch fee is the device's own"],
  [K, "export const SOLANA_POOL_SEND_MARGIN_MS = 90_000n;", "export const SOLANA_POOL_SEND_MARGIN_MS = 30_000n;", T, "the epoch fee is the device's own"],
  [K, "const room = solanaPoolPriorityBudget(rent, release.relayFee);", "const room = release.relayFee - solanaPoolReleaseCost(rent);", "../kit/test/solana-pool-buy.test.ts", "priority budget"],
  [K, "return (open + n - 1n) / n;", "return open / n;", "../kit/test/solana-pool-buy.test.ts", "priority budget"],
  [S, "if (f?.chain !== \"solana\" || f.program !== program ||", "if (", T, "the epoch fee is the device's own"],
  [S, "|| f.fee_payer !== feePayer)", ")", T, "the epoch fee is the device's own"],
  [S, "|| f.step !== SOL_FEE_STEP.toString())", ")", T, "the epoch fee is the device's own"],
  [S, "if (f.epoch_ms !== Number(SOL_EPOCH_MS) || ", "if (", T, "the epoch fee is the device's own"],
  [S, "if (a !== b) throw new Error(\"the two RPCs' base fee differ\")", "if (false) throw new Error(\"\")", T, "the epoch fee is the device's own"],
  [S, "if (a !== SOL_TWO_SIGNATURES) throw", "if (false) throw", T, "the epoch fee is the device's own"],
  [S, "base64.encode(cat(Uint8Array.of(2, 0, 0, 2), feePayer, pool, blockhash, Uint8Array.of(0)))", "base64.encode(cat(Uint8Array.of(2, 0, 0, 2), feePayer, feePayer, blockhash, Uint8Array.of(0)))", T, "RV1"],
  [S, "if (f === undefined) {", "if (true) {", T, "RV1"],
  [S, "|| deadlineMs <= nowMs + SOL_SEND_MARGIN_MS)", ")", T, "bind refuses a deadline"],
  [S, "if (typeof epochStartMs !== \"bigint\" || epochStartMs % SOL_EPOCH_MS !== 0n) throw", "if (false) throw", T, "bind refuses a deadline"],
  [S, "if (wallet.address === pool || wallet.address === feePayer) throw", "if (false) throw", T, "bind refuses a deadline"],
  [S, "if (fee * 10_000n > chunk * MAX_RELAY_FEE_BPS) throw", "if (false) throw", T, "backstop"],
  [S, "if (chunk - fee - SOL_TIP_CAP < solanaRentMin(rent, 0)) throw", "if (false) throw", T, "backstop"],
  [S, "return a.ms < b.ms ? a.ms : b.ms;", "return a.ms;", T, "lower of the two"],
  [S, "if (solanaSameProvider(rpcs[0], rpcs[1])) throw", "if (rpcs[0] === rpcs[1]) throw", T, "RV10"],
  [S, "if (feePayer === pool) throw", "if (false) throw", T, "RV10"],
  [K, "solanaRentMin(rent, SOLANA_POOL_SPENT_MARK_LEN)", "solanaRentMin(rent, 0)", T, "the epoch fee is the device's own"],
  [R, "if (have !== undefined && have !== d) throw", "if (false) throw", T, "restore refuses"],
  [S, "slot = Math.min(slot, at);", "slot = Math.max(slot === Number.MAX_SAFE_INTEGER ? 0 : slot, at);", T, "S4"],
  [S, "for (let i = Math.max(1, start); i < l.length; i++)", "for (let i = start + 1; i < l.length; i++)", T, "S5"],
  [S, "if (next[tree]!.length > held[tree]!.length) held[tree] = next[tree]!;", "held[tree] = next[tree]!;", T, "S6"],
  [R, "if (m.has(x.pubkey)) throw", "if (false) throw", T, "restore refuses"],
  [R, "x.account?.owner !== program || ", "", T, "restore refuses"],
  [R, "a.stateLeaves.forEach((c, k) => {\n    if (leafAt.has(c)) throw", "a.stateLeaves.forEach((c, k) => {\n    if (false) throw", T, "R4"],
  [R, "if (m.value === 0n || m.nonce === 0n || ", "if (", T, "restore refuses"],
  [R, "for (const [key, d] of reads[1]![i].marks) {", "for (const [key, d] of [] as [string, string][]) {", T, "RV5"],
  [R, "if (base64.decode(d[0]).length !== size) throw", "if (false) throw", T, "restore refuses"],
  [R, "const slot = Math.max(...reads.flatMap((r) => [r[0].slot, r[1].slot]));", "const slot = Math.min(...reads.flatMap((r) => [r[0].slot, r[1].slot]));", T, "RV7"],
  [R, "if (m.value === 0n || m.nonce === 0n || m.nonce > BigInt(a.labelLeaves.length)) throw", "if (false) throw", T, "restore refuses"],
  [R, "if (a.labelLeaves[Number(m.nonce - 1n)] !== label) throw", "if (false) throw", T, "restore refuses"],
  [R, "if (at === undefined) throw", "if (false) throw", T, "restore refuses"],
  [R, "if (withdrawn === 0n || withdrawn > leaf.value) throw", "if (false) throw", T, "restore refuses"],
  [R, "const cValue = leaf.value - withdrawn;", "const cValue = 0n;", T, "R5"],
  [R, "const j = ref.kind === \"change\" ? ref.j + 1 : 0;", "const j = ref.kind === \"change\" ? ref.j : 0;", T, "R5"],
  [R, "    asDeposit({ kind: \"move\", l, j });\n", "", T, "RV6"],
  [R, "    seconds({ id: \"V\", l, j });\n", "", T, "RV6"],
  [R, "    seconds({ id: \"A\", l, j });\n", "", T, "RV6"],
  [R, "      seconds({ id: \"R\", c, l, j });\n", "", T, "RV6"],
  [R, "    w.secretKey.fill(0);\n", "", "test/pool-zeroing.test.ts", "solanaRestore zeroes"],
  [Q, "        if (newest instanceof Error) out.failed.push({ noteId: n.id, error: msg(newest) });\n        else todo.push({ n, trees: newest, root: \"newest\" });", "        todo.push({ n, trees: newest as PoolTrees, root: \"newest\" });", "test/pool-queue.test.ts", "a failed newest read"],
  [Q, ".catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))", "", "test/pool-queue.test.ts", "a failed newest read"],
];
let ok = 0;
for (const [f, find, repl, file, pat] of M) {
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { console.log(`NOT ONCE: ${find}`); process.exitCode = 1; continue; }
  writeFileSync(f, src.replace(find, repl));
  const r = runTests([`--test-name-pattern=${pat}`, file], { cwd: W, timeoutMs: 120_000 });
  writeFileSync(f, src);
  // HUNG: only the planted tests run (the name pattern), so the one that hangs is the planted one: killed
  const killed = r.hung || (r.status !== 0 && r.fail > 0);
  if (killed) ok++;
  console.log(`${r.hung ? "HUNG" : killed ? "KILLED" : "SURVIVED"} [${pat}] pass ${r.pass} fail ${r.fail}: ${f.split("/").pop()}: ${find.slice(0, 70)}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
