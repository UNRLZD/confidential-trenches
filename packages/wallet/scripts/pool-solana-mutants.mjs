// node packages/wallet/scripts/pool-solana-mutants.mjs (card notes-per-pool-sol): plants one mutant at a time in the card's source, runs the named test, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { runMutant, runTests } from "./mutant-run.mjs";
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
  [R, "if (keys.has(x.pubkey)) throw", "if (false) throw", T, "restore refuses"],
  [R, "x.account?.owner !== program || ", "", T, "restore refuses"],
  [R, "a.stateLeaves.forEach((c, k) => {\n    if (leafAt.has(c)) throw", "a.stateLeaves.forEach((c, k) => {\n    if (false) throw", T, "R4"],
  [R, "if (m.value === 0n || m.nonce === 0n || ", "if (", T, "restore refuses"],
  [R, "for (const [key, d] of marks[1][i]) {", "for (const [key, d] of [] as [string, string][]) {", T, "RV5"],
  [R, "if (bytes.length !== size) throw", "if (false) throw", T, "restore refuses"],
  [R, "const slot = Math.max(...calls.flat(2).map((c) => c.slot));", "const slot = Math.min(...calls.flat(2).map((c) => c.slot));", T, "RV7"],
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
  // card sol-restore-race, review round 4: the first read's answers kept for the never-closed rule (G7); fold 7: the
  // earlier answer checked against the new one (G4, solana-restore.ts:101), told apart by an equal slot
  [R, "  solanaMarksGaps(calls, first.calls);\n", "", T, "fold 6 \\(G7"],
  [R, "          lacks(i, x, j, y);\n", "", T, "fold 7 \\(G4"],
  // fold 8: the merged marks carried into the next round (M7): without them the restore never walks
  [R, "    marks = again;\n", "", T, "N1 race"],
  // fold 10: the release number read from a spent mark, and compared across reads
  [R, " || have.number !== w.number)) throw", ")) throw", T, "fold 10 \\(number"],
  [R, "number: new DataView(d.buffer, d.byteOffset, d.length).getUint32(8, true) }", "number: 0 }", T, "fold 10 \\(number"],
  // card sol-marks-scale: the marks in buckets of 256 counters, each bucket's answer checked, the never-closed rule per bucket
  [R, "if (c < BigInt(first) || c >> 8n !== BigInt(b)) throw", "if (c < BigInt(first)) throw", T, "sol-marks-scale: a mark outside the bucket"],
  [R, "if (c < BigInt(first) || c >> 8n !== BigInt(b)) throw", "if (c >> 8n !== BigInt(b)) throw", T, "restore refuses two RPCs whose marks differ"],
  [R, "stopped[k] = last.open;", "stopped[k] = true;", T, "sol-marks-scale: a pool of 20,000"],
  [R, "open: keys.size < SOL_MARK_BUCKET - (b === 0 ? first : 0), keys", "open: keys.size < SOL_MARK_BUCKET, keys", T, "sol-marks-scale: a pool of 20,000"],
  [R, "w = Math.min(2 * w, SOL_MARK_WAVE)", "w = 1", T, "sol-marks-scale: a pool of 20,000"],
  [R, " || (y.open && y.bucket < x.bucket)", "", T, "sol-marks-scale: a short bucket speaks"],
  [R, "if (y.slot < x.slot || !(y.bucket === x.bucket || (y.open && y.bucket < x.bucket))) return;", "if (y.slot < x.slot) return;", T, "sol-marks-scale: a pool of 20,000"],
  [R, "const a = (await solanaLagRetry(() => rpc(\"getProgramAccounts\", [program, { commitment: \"finalized\", encoding: \"base64\", withContext: true, ...(min > 0 ? { minContextSlot: min } : {}), filters }]), lagWait, stop.signal))", "const a = (await rpc(\"getProgramAccounts\", [program, { commitment: \"finalized\", encoding: \"base64\", withContext: true, ...(min > 0 ? { minContextSlot: min } : {}), filters }]))", T, "sol-marks-scale: a bucket whose node lags"],
  // fold 1 (the Opus review): S1 a zeroed record passed over, S2 both RPCs wave by wave with the stopped one's lowest bucket
  // not full read again at the other's slot and one stop for every read, S3 a counter is one mark's, S4 the settle's
  // spent marks only
  [R, "        if (bytes.subarray(0, 8).every((v) => v === 0)) continue;\n", "", T, "sol-marks-scale fold 1 RV-B1"],
  [R, "if (bytes.subarray(0, 8).every((v) => v === 0)) continue;", "if (bytes.subarray(0, 8).some((v) => v === 0)) continue;", T, "sol-marks-scale fold 1 RV-B1"],
  [R, "if (owner !== undefined && owner !== x.pubkey) throw", "if (false) throw", T, "sol-marks-scale fold 1 RV-F"],
  [R, "if (have !== undefined && have !== d[0]) throw new Error(`rpc ${k}: mark ${x.pubkey}: two answers differ`);", "", T, "sol-marks-scale fold 1 S3"],
  [R, "return [await bucket(k, low[k]!, Math.max(min, top(k === 0 ? 1 : 0)))];", "return [await bucket(k, low[k]!, min)];", T, "sol-marks-scale fold 1 RV-C2"],
  [R, "return [await bucket(k, low[k]!, Math.max(min, top(k === 0 ? 1 : 0)))];", "return [await bucket(k, next[k]! - 1, Math.max(min, top(k === 0 ? 1 : 0)))];", T, "sol-marks-scale: a short bucket speaks"],
  [R, "        while (full[k].has(low[k]!)) low[k]!++;\n", "", T, "sol-marks-scale: a short bucket speaks"],
  [R, "        if (stopped[k] && !last.open) next[k] = low[k]!;\n", "", T, "sol-marks-scale fold 1 S2: a stopped RPC"],
  [R, "      solanaMarksGaps(calls, add);\n", "", T, "sol-marks-scale: one RPC missing a mark"],
  [R, "    stop.abort(e);\n", "", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "  signal?.addEventListener(\"abort\", onAbort, { once: true });\n", "", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "lagWait, stop.signal))", "lagWait))", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "  signal?.throwIfAborted(); // a signal aborted already never fires its event\n", "", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "a.lagWait, \"spent\");", "a.lagWait);", T, "sol-marks-scale fold 1 S4"],
  [R, "(only === \"spent\" ? [0] : [0, 1])", "[0, 1]", T, "sol-marks-scale fold 1 S4"],
  [Q, "        if (newest instanceof Error) out.failed.push({ noteId: n.id, error: msg(newest) });\n        else todo.push({ n, trees: newest, root: \"newest\" });", "        todo.push({ n, trees: newest as PoolTrees, root: \"newest\" });", "test/pool-queue.test.ts", "a failed newest read"],
  [Q, ".catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))", "", "test/pool-queue.test.ts", "a failed newest read"],
];
// The unmutated run, timed once per test file: it must pass, and its time sets the cap (three times it, plus the longest
// per-test timeout, 60 s), so a run past the cap hangs and a run that fails at a test's own timeout does not.
const cap = new Map();
for (const file of new Set(M.map((m) => m[3]))) {
  const t0 = Date.now();
  const r = runTests([file], { cwd: W, timeoutMs: 600_000 });
  if (r.hung || r.status !== 0) throw new Error(`the unmutated ${file} does not pass`);
  cap.set(file, 3 * (Date.now() - t0) + 60_000);
  console.log(`unmutated ${file}: ${Date.now() - t0} ms, cap ${cap.get(file)} ms`);
}
let ok = 0;
const hung = [], cancelled = [], equivalent = [];
for (const [f, find, repl, file, pat, why] of M) {
  // an equivalent mutant (no test can tell it apart: its reason given) is listed, never run or counted
  if (why !== undefined) { equivalent.push(`[${pat}] ${find.slice(0, 70)}: ${why}`); continue; }
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { console.log(`NOT ONCE: ${find}`); process.exitCode = 1; continue; }
  writeFileSync(f, src.replace(find, repl));
  const r = runMutant([`--test-name-pattern=${pat}`, file], { cwd: W, timeoutMs: cap.get(file) });
  writeFileSync(f, src);
  // HUNG: past the cap, killed by the runner; CANCELLED: only tests stopped at their own timeout, on two runs; both listed
  // apart, never a kill
  const at = `[${pat}] ${f.split("/").pop()}: ${find.slice(0, 70)}`;
  if (r.verdict === "hung") { hung.push(at); continue; }
  if (r.verdict === "cancelled") { cancelled.push(at); continue; }
  if (r.verdict === "killed") ok++;
  console.log(`${r.verdict === "killed" ? "KILLED" : "SURVIVED"} [${pat}] pass ${r.pass} fail ${r.fail} runs ${r.runs}: ${f.split("/").pop()}: ${find.slice(0, 70)}`);
}
for (const h of hung) console.log(`HUNG ${h}`);
for (const c of cancelled) console.log(`CANCELLED ${c}`);
for (const e of equivalent) console.log(`EQUIVALENT ${e}`);
const runs = M.length - equivalent.length;
console.log(`${ok}/${runs - hung.length - cancelled.length} killed; ${hung.length} hung, ${cancelled.length} cancelled only (not counted); ${equivalent.length} equivalent`);
if (ok !== runs) process.exitCode = 1;
