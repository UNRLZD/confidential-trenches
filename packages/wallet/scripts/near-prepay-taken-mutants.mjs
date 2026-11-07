// node packages/wallet/scripts/near-prepay-taken-mutants.mjs (card wallet-near-prepay-taken, audit V-01): plants one
// mutant at a time in the value check (bind.ts ownRow, callAmount, and their two uses) and in the resend (follow.ts:
// U's refund bound on U's next second-arrival note, the stranger's note never counted), in a landed note's calls still
// out (the review of 20766bb9) and in the ran call's receipts (the review of 9c218554: amount_above_balance settled, the
// FINAL gate with the relayer named, a failed key read's pace; the review of 59c2db71: the last nonce's FINAL, the wait
// past the nonce with no relayer named, a short read held), runs the named test, expects it to fail, puts the source
// back.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const B = `${W}/src/deposit/bind.ts`, F = `${W}/src/deposit/follow.ts`;
const V = "test/deposit-prepay-taken.test.ts", TB = "test/deposit-bind.test.ts";
// [name, file, find, replace, test file, test name pattern]
const M = [
  // the value check
  ["no value check", B, "if (calls.length > 0) return calls.some((c) => callAmount(c) === row.value);", "if (calls.length > 0) return true;", V, "names U at 1 USDC"],
  ["no depositor check", B, "  if (row.depositor !== u) return false;\n", "", TB, "audit V-01"],
  ["the amount read off by one", B, "  return BigInt(a);\n}", "  return BigInt(a) + 1n;\n}", V, "names U at the call's own amount"],
  ["the bind lands by depositor", B, "kind: ownRow(r, U, cur, own.amount) ?", "kind: r.depositor === U ?", TB, "audit V-01"],
  ["the follow counts by depositor", F, "state: ownRow(r.row, U, note) ?", "state: r.row.depositor === U ?", V, "names U at the quote's min"],
  // the resend
  ["a stranger's note counted", F, "      else theirs.add(note.id);", "      else ours.set(note.id, p.value);", V, "a stranger takes P after the relayer's prepay"],
  ["the refund bound on the taken note", F, "let note = mine.find((x) => x.note.leaf === undefined)?.note;", "let note = mine[0]!.note;", V, "a stranger takes P after the relayer's prepay"],
  // a landed note's calls still out (the review's M1, L2, L3)
  ["no wait for a call still out", F, "        } else if (low <= window) out = true;", "        } else if (false) out = true;", V, "answer lost"],
  ["calls out never read", F, "const calls = out === undefined ? await callsOut() :", "const calls = false ? await callsOut() :", V, "answer lost"],
  ["the slow refund at the slow pace", F, "    if (calls.due) fast = true;", "    if (calls.out) fast = true;", V, "refund slow"],
  ["final before the refund window", F, "const idle = out === undefined && !calls.late &&", "const idle = out === undefined && !calls.due &&", V, "refund slow"],
  ["no resend of U's refund", F, "if (!outLanded && amount !== null && amount >= VAULT_CONSTANTS.MIN_DEPOSIT) {", "if (!outLanded && amount !== null && amount >= VAULT_CONSTANTS.MIN_DEPOSIT && out !== undefined) {", V, "a stranger takes P after the relayer's prepay"],
  // the ran call's receipts (the review of 9c218554: M1, L1)
  ["amount_above_balance refused", B, '"p_used", "amount_above_balance"]);', '"p_used"]);', V, "release relayer not named"],
  ["amount_above_balance refused in the bind", B, '"p_used", "amount_above_balance"]);', '"p_used"]);', TB, "amount_above_balance settles"],
  ["no FINAL gate with the relayer named", F, "    return (await findDeadCall(calls, top, rpcs, relayer)) !== null;\n", "    return top >= 0n;\n", V, "release relayer named"],
  // the review of 59c2db71 (L1, L2, Info)
  ["FINAL on any of the note's nonces", F, "    return (await findDeadCall(calls, top, rpcs, relayer)) !== null;\n", "    for (const n of new Set(calls.map((c) => c.nonce))) if ((await findDeadCall(calls, n, rpcs, relayer)) !== null) return true;\n    return top < 0n;\n", V, "two nonces on a taken note"],
  ["no wait past the nonce with no relayer named", F, "      return low >= passedAt.get(id)! + REFUND_HEIGHTS;", "      return true;", V, "relayer that carries at once"],
  ["a short read never held", B, "        if (seen.size >= SHORT_READ_CALLS) return { kind: \"refused\", code: answer.code };\n", "", V, "short of every call"],
  ["a failed key read keeps the poll's pace", F, "if (u === null) return { out: true, due: owed(), late: true };", "if (u === null) return { out: true, due: true, late: true };", V, "L1"],
];
const src = { [B]: readFileSync(B, "utf8"), [F]: readFileSync(F, "utf8") };
let ok = 0;
for (const [name, file, find, repl, test, pat] of M) {
  if (src[file].split(find).length !== 2) {
    console.log(`NOT ONCE [${name}]: ${find}`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(file, src[file].replace(find, repl));
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync("node", ["--test", `--test-name-pattern=${pat}`, test], { cwd: W, encoding: "utf8", timeoutMs: 120_000 });
  } finally {
    writeFileSync(file, src[file]);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
