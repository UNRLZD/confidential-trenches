// node packages/wallet/scripts/pool-solana-mutants.mjs (card notes-per-pool-sol): plants one mutant at a time in the card's source, runs the named test, expects it to fail, puts the source back.
import { readFileSync } from "node:fs";
import { refused, runMutant, runTests, withPlant } from "../../../scripts/mutant-run.mjs";
import { fileURLToPath } from "node:url";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const S = `${W}/src/pool/solana.ts`, R = `${W}/src/pool/solana-restore.ts`;
const Q = `${W}/src/pool/queue.ts`, K = `${W}/../kit/src/trade/solana/pool-buy.ts`;
const P = `${W}/src/pool/pool.ts`;
const T = "test/pool-solana.test.ts";
// [file, find, replace, test file, test name pattern]
const M = [
  [S, "if (a?.owner !== program)", "if (false)", T, "another owner"],
  [S, "if (!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree || !same(d.subarray(9, 13), u32le(pageNo)))", "if (!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree)", T, "another owner"],
  [S, "if (l[i]!.t < l[i - 1]!.t) throw", "if (false) throw", T, "has not reached the cut"],
  [S, "if (ms >= beforeMs) return r;", "return r;", T, "has not reached the cut"],
  [S, "if (ms >= beforeMs) return r;", "if (ms + 1000n >= beforeMs) return r;", T, "S9"],
  // card pool-tree-read-waits-for-its-second: the read that reached the cut is the one kept (never the first read's
  // pages after a wait), the reach cap, and the -32004 block time's own cap
  [S, "        const r = await readPages(rpc, program, from, commitment, min, signal, lagWait);\n        if (beforeMs === null) return r;\n        const { ms } = await blockTime(rpc, r.slot, lagWait, signal);\n        if (ms >= beforeMs) return r;", "        const r = await readPages(rpc, program, from, commitment, min, signal, lagWait);\n        first ??= r;\n        if (beforeMs === null) return r;\n        const { ms } = await blockTime(rpc, r.slot, lagWait, signal);\n        if (ms >= beforeMs) return first;", T, "during the wait", undefined, ["      let min = Math.max(minSlot, lastSlot[k]!);\n", "      let min = Math.max(minSlot, lastSlot[k]!);\n      let first: Awaited<ReturnType<typeof readPages>> | undefined;\n"]],
  [S, "if (waits >= SOL_REACH_WAITS) throw new SolanaNotReachedError", "if (waits >= 4 * SOL_REACH_WAITS) throw new SolanaNotReachedError", T, "never reaches the cut"],
  [S, "if (waits >= SOL_REACH_WAITS || !(e instanceof Error) || !NOT_YET.test(e.message)) throw e;", "if (!(e instanceof Error) || !NOT_YET.test(e.message)) throw e;", T, "never available"],
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
  // the epoch's fee read once per epoch: pool.ts perEpoch since 56489f2fb
  [P, "if (h === undefined) {", "if (true) {", T, "RV1"],
  [S, "|| deadlineMs <= nowMs + SOL_SEND_MARGIN_MS)", ")", T, "bind refuses a deadline"],
  [S, "if (typeof epochStartMs !== \"bigint\" || epochStartMs % SOL_EPOCH_MS !== 0n) throw", "if (false) throw", T, "bind refuses a deadline"],
  [S, "if (wallet.address === pool || wallet.address === feePayer) throw", "if (false) throw", T, "bind refuses a deadline"],
  [S, "if (fee * 10_000n > chunk * MAX_RELAY_FEE_BPS) throw", "if (false) throw", T, "backstop"],
  [S, "if (chunk - fee - tipCap < solanaRentMin(rent, 0)) throw", "if (false) throw", T, "backstop"],
  [S, "return a.ms < b.ms ? a.ms : b.ms;", "return a.ms;", T, "lower of the two"],
  [S, "if (solanaSameProvider(rpcs[0], rpcs[1])) throw", "if (rpcs[0] === rpcs[1]) throw", T, "RV10"],
  [S, "if (feePayer === pool) throw", "if (false) throw", T, "RV10"],
  [K, "solanaRentMin(rent, SOLANA_POOL_SPENT_MARK_LEN)", "solanaRentMin(rent, 0)", T, "the epoch fee is the device's own"],
  [R, "if (got[0][j] !== got[1][j]) throw", "if (false) throw", T, "restore refuses"],
  [S, "slot = Math.min(slot, at);", "slot = Math.max(slot === Number.MAX_SAFE_INTEGER ? 0 : slot, at);", T, "S4"],
  [S, "for (let i = Math.max(1, start); i < l.length; i++)", "for (let i = start + 1; i < l.length; i++)", T, "S5"],
  [S, "if (next[tree]!.length > held[tree]!.length) held[tree] = next[tree]!;", "held[tree] = next[tree]!;", T, "S6"],
  [R, "if (keys.includes(key as string) || out[z].has(key as string)) throw", "if (false) throw", T, "restore refuses"],
  [R, "x?.owner !== program || ", "", T, "restore refuses"],
  [R, "a.stateLeaves.forEach((c, k) => {\n    if (leafAt.has(c)) throw", "a.stateLeaves.forEach((c, k) => {\n    if (false) throw", T, "R4"],
  [R, "if (m.value === 0n || m.nonce === 0n || ", "if (", T, "sol-marks-scale fold 1 R11"],
  [R, "const at = Math.max(min, slots[k]!);", "const at = slots[k]!;", T, "RV5"],
  [R, "if (bytes.length !== size) throw", "if (false) throw", T, "restore refuses"],
  [R, "return marksOf(out[0], out[1], Math.max(slots[0]!, slots[1]!, held?.slot ?? 0));", "return marksOf(out[0], out[1], Math.max(slots[0]!, slots[1]!));", T, "review P3-1 of e3489b3b"],
  [R, "if (m.value === 0n || m.nonce === 0n || m.nonce > BigInt(a.labelLeaves.length)) throw", "if (false) throw", T, "restore refuses|sol-marks-scale fold 1 R11"],
  [R, "if (a.labelLeaves[Number(m.nonce - 1n)] !== label) throw", "if (false) throw", T, "restore refuses"],
  [R, "if (at === undefined) throw", "if (false) throw", T, "restore refuses"],
  [R, "if (withdrawn === 0n || withdrawn > leaf.value) throw", "if (false) throw", T, "restore refuses"],
  [R, "const cValue = leaf.value - withdrawn;", "const cValue = 0n;", T, "R5"],
  [R, "const j = ref.kind === \"change\" ? ref.j + 1 : 0;", "const j = ref.kind === \"change\" ? ref.j : 0;", T, "R5"],
  [R, "    yield* asDeposit({ kind: \"move\", l, j });\n", "", T, "RV6"],
  [R, "    yield* seconds({ id: \"V\", l, j });\n", "", T, "RV6"],
  [R, "    yield* seconds({ id: \"A\", l, j });\n", "", T, "RV6"],
  [R, "      yield* seconds({ id: \"R\", c, l, j });\n", "", T, "RV6"],
  [R, "    w.secretKey.fill(0);\n", "", "test/pool-zeroing.test.ts", "solanaRestore zeroes"],
  // card sol-restore-elsewhere: a release the device did not make stops nothing: the walk lists it and goes on past it,
  // and a settle of it writes the note SPENT with no change note, never a refusal that leaves it RESERVED
  [R, "      // not the device's release (its change is not the note's): spent all the same, listed", "      throw new Error(\"refused\");\n      //", T, "sol-restore-elsewhere"],
  [R, "      elsewhere.push({ note: key, withdrawn, number: mark.number });\n", "", T, "sol-restore-elsewhere"],
  [R, "      elsewhere.push({ note: key, withdrawn, number: mark.number });\n", "      elsewhere.push({ note: key, withdrawn, number: mark.number });\n      continue;\n", T, "sol-restore-elsewhere"],
  [R, "        if (note.state !== \"SPENT\")\n", "        if (false)\n", T, "sol-restore-elsewhere"],
  [R, "        out.push({ kind: \"spent\", change: null, withdrawn, elsewhere: true });\n        continue;\n", "        throw new Error(\"refused\");\n", T, "sol-restore-elsewhere"],
  // card sol-restore-race, review round 4: the first read's answers kept for the never-closed rule (G7); fold 7: the
  // earlier answer checked against the new one (G4, solana-restore.ts:101), told apart by an equal slot
  // G7 (a mark the lister plants in its first read only) is refused where rpc 1 is asked for it: "is not on it" below
  [R, "const again = solanaMarksUnion(marks, read);", "const again = read;", T, "N1", "equivalent: the cache holds every mark read (held), so no later read changes one, and a mark the lister drops is still refused by each RPC's own pages' count (solanaMarkCounts)"],
  [R, "if (have !== undefined && (have.value !== m.value || have.nonce !== m.nonce)) throw", "if (false) throw", T, "N1 union"],
  // fold 8: the merged marks carried into the next round (M7): without them the restore never walks
  [R, "        });\n      }\n      marks = again;\n", "        });\n      }\n", T, "N1 race"],
  // fold 10: the release number read from a spent mark, and compared across reads
  [R, " || have.number !== w.number)) throw", ")) throw", T, "fold 10 \\(number|N1 union"],
  [R, "number: new DataView(d.buffer, d.byteOffset, d.length).getUint32(8, true) }", "number: 0 }", T, "fold 10 \\(number"],
  // card sol-marks-scale: the marks in buckets of 256 counters, each bucket's answer checked, the never-closed rule per bucket
  [R, "if (c < BigInt(first) || c >> 8n !== BigInt(b)) throw", "if (c < BigInt(first)) throw", T, "sol-marks-scale: a listed mark outside the bucket"],
  [R, "if (c < BigInt(first) || c >> 8n !== BigInt(b)) throw", "if (c >> 8n !== BigInt(b)) throw", T, "restore refuses two RPCs whose marks differ"],
  // the bucket scan on both RPCs (its waves, a stopped RPC, a short bucket that speaks) went with 07d5d6872 (10 Nov) and
  // its mutants with it; the rules it held, every bucket read whole and each mark on both RPCs, hold on the listed path
  [R, "if (counted < room) break;", "break;", T, "sol-marks-scale: a pool of 20,000"],
  [R, "const room = SOL_MARK_BUCKET - (b === 0 ? first : 0);", "const room = SOL_MARK_BUCKET;", T, "listed restore past one bucket"],
  [R, "const a = (await solanaLagRetry(() => lister(\"getProgramAccounts\", ", "const a = (await ((f: () => Promise<unknown>, ..._: unknown[]) => f())(() => lister(\"getProgramAccounts\", ", T, "sol-marks-scale: a bucket whose lister lags"],
  // fold 1 (the review): S1 a zeroed record passed over, S2 both RPCs wave by wave with the stopped one's lowest bucket
  // not full read again at the other's slot and one stop for every read, S3 a counter is one mark's, S4 the settle's
  // spent marks only
  [R, "          if (bytes.subarray(0, 8).every((v) => v === 0)) return;\n", "", T, "sol-marks-scale fold 1 RV-B1"],
  [R, "if (bytes.subarray(0, 8).every((v) => v === 0)) return;", "if (bytes.subarray(0, 8).some((v) => v === 0)) return;", T, "sol-marks-scale fold 1 RV-B1"],
  [R, "if (owner !== undefined) throw", "if (false) throw", T, "sol-marks-scale fold 1 RV-F|listed restore refuses a lister or an RPC breaking"],
  [R, " || out[z].has(key as string)", "", T, "sol-marks-scale fold 1 S3"],
  [R, "if (a.value.length > room) throw", "if (false) throw", T, "sol-marks-scale fold 1 RV-C2|sol-marks-scale fold 1 RV-F"],
  [R, "if ((slot as number) < at) throw", "if (false) throw", T, "N1 re-read"],
  [R, "(slot as number) < at || !Array.isArray(a.value)", "!Array.isArray(a.value)", T, "listed restore refuses a lister or an RPC breaking"],
  [R, "if (x === null) throw", "if (false) throw", T, "sol-marks-scale: one RPC missing a listed mark|fold 6 \\(G7"],
  [R, "    stop.abort(e);\n", "", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "  signal?.addEventListener(\"abort\", onAbort, { once: true });\n", "", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "filters }]), lagWait, signal))", "filters }]), lagWait))", T, "sol-marks-scale fold 1 S2: a throw|fold 3 \\(L1"],
  [R, "    signal?.removeEventListener(\"abort\", onAbort);\n", "", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "  signal?.throwIfAborted(); // a signal aborted already never fires its event\n", "", T, "sol-marks-scale fold 1 S2: a throw"],
  [R, "for (const z of [0, 1] as const) {", "for (const z of [0] as const) {", T, "S4, inverted"],
  // card pool-sol-mark-tag: the bucket's memcmp without the tag (the old filter), and a record without the tag taken
  [R, "const high = new Uint8Array(width);", "const high = new Uint8Array(width - 1);", T, "sol-marks-scale fold 1 RV-B3"],
  [R, "if (bytes[size - 1] !== SOL_MARK_TAG) throw", "if (false) throw", T, "card pool-sol-mark-tag: a record"],
  [Q, "if (newest instanceof Error) out.failed.push({ noteId: n.id, error: msg(newest), reason: \"network\" });", "if (newest instanceof Error) {}", "test/pool-queue.test.ts", "a failed newest read"],
  [Q, ".catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))); // every leaf up to now", "; // every leaf up to now", "test/pool-queue.test.ts", "a failed newest read"],
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
let none = 0;
const equivalent = [];
for (const [f, find, repl, file, pat, why, pre] of M) {
  // an equivalent mutant (no test can tell it apart: its reason given) is listed, never run or counted
  if (why !== undefined) { equivalent.push(`[${pat}] ${find.slice(0, 70)}: ${why}`); continue; }
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2 || (pre !== undefined && src.split(pre[0]).length !== 2)) { console.log(`NOT ONCE: ${find}`); process.exitCode = 1; continue; }
  // pre: a second edit the mutant needs to type-check (a variable it reads), made beside it
  const out = src.replace(find, () => repl);
  const r = withPlant(f, pre === undefined ? out : out.replace(pre[0], () => pre[1]), () => runMutant([`--test-name-pattern=${pat}`, file], { cwd: W, timeoutMs: cap.get(file) }));
  // HUNG: past the cap, killed by the runner; CANCELLED: only tests stopped at their own timeout, on two runs; NO TEST: no
  // test ran; each refused, never a kill (scripts/mutant-run.mjs)
  if (refused(`${pat} ${f.split("/").pop()}: ${find.slice(0, 70)}`, r)) { none++; continue; }
  if (r.verdict === "killed") ok++;
  console.log(`${r.verdict === "killed" ? "KILLED" : "SURVIVED"} [${pat}] pass ${r.pass} fail ${r.fail} runs ${r.runs}: ${f.split("/").pop()}: ${find.slice(0, 70)}`);
}
for (const e of equivalent) console.log(`EQUIVALENT ${e}`);
const runs = M.length - equivalent.length;
console.log(`${ok}/${runs - none} killed; ${none} with no verdict, refused (not counted); ${equivalent.length} equivalent`);
if (ok !== runs) process.exitCode = 1;
