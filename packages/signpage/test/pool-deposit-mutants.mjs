// The deposit runners' end rules (card pool-deposit-sent-end, review 8): each rule of src/pool-deposit.ts and
// src/pool-deposit-evm.ts that tells the app a deposit's end, removed or weakened one at a time, fails the test named for
// it (the reviewer's 15 survivors at 6f20021b, and the fold's own rules; the delta review of 37abecea's 10 survivors and
// the second fold's rules, "fold review N" below, with src/pool-testnet.ts's wiring; the delta review of 09542dc6's five
// Lows and the reviewer's own R-mutants, "low N" below; the delta review of bce5cde5, "review 2 M1" and "review 2
// (info" below). A mutant is written to a copy beside its source
// (src/.<name>-mutant-<pid>.ts) and run by a copy of the test file that imports it, all removed after: no tracked file is
// changed, so a test run at the same time never reads a mutant. Exits 1 when a named test passes on its mutant, fails or
// runs no test on the code as it is, or a mutant's text is not in its source exactly once.
// test/pool-deposit-mutants.test.mjs runs it in the package's test:mutants.
//   node packages/signpage/test/pool-deposit-mutants.mjs
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";

const SOL = { src: "pool-deposit.ts", test: "pool-deposit.test.ts" };
const EVM = { src: "pool-deposit-evm.ts", test: "pool-deposit-evm.test.ts" };
const TESTNET = { src: "pool-testnet.ts", test: "pool-testnet-evm-deposit.test.ts" };

// the follower's new-window rule, and the same with it gone
const SEEN = "      const seen = (s: string) => void (s !== last[k] && ((last[k] = s), (since[k] = waited)));";
const NO_SEEN = "      const seen = (_s: string) => {};";
// [runner, [[text in its source, its replacement], ...], the test (a name prefix) that must fail]
export const MUTANTS = [
  // S1: the follower's mark read before its heights
  [SOL, [["  stopped(h);\n  const fs = await finals(h);\n  const expired = sends.map((x) => fs.every((y) => y.height > x.last_valid_block_height));\n  stopped(h);\n  const dead = expired.every(Boolean) ? expired : await failedOnBoth(h, sends, expired);\n  stopped(h);\n  const m = await markOf(h, n.precommitment, [fs[0].slot, fs[1].slot], wait);\n", "  const m = await markOf(h, n.precommitment);\n  const fs = await finals(h);\n  const expired = sends.map((x) => fs.every((y) => y.height > x.last_valid_block_height));\n  const dead = expired.every(Boolean) ? expired : await failedOnBoth(h, sends, expired);\n"]], "review 8 S1:"],
  // the run's rebuild: its mark read before its heights
  [SOL, [["        const fs = await finals(h);\n        const expired", "        const early = await markOf(h, n.precommitment);\n        const fs = await finals(h);\n        const expired"], ["        const m = await markOf(h, n.precommitment, [fs[0].slot, fs[1].slot], wait);\n", "        const m = early;\n"]], "R3: the heights are read before the mark, so a send"],
  // S3: a mark on one RPC read as landed
  [SOL, [['  if (m === "one") return null;\n  if (m === null) return dead.every(Boolean) ? "expired" : null;', '  if (m === "one") return "landed";\n  if (m === null) return dead.every(Boolean) ? "expired" : null;']], "review 8 S3:"],
  // S4: dead when any one send is dead
  [SOL, [['  if (m === null) return dead.every(Boolean) ? "expired" : null;', '  if (m === null) return dead.some(Boolean) ? "expired" : null;']], "review 8 S4:"],
  // S5: taken with no refusal when both RPCs say a send succeeded
  [SOL, [['  if (m.value !== value) return (await bothLanded(h, sends)) ? null : "dead";', '  if (m.value !== value) return "dead";']], "review 8 S5 and S6:"],
  // S6: a mark at another value read as landed (on chain, and from the store)
  [SOL, [['  if (m.value !== value) return (await bothLanded(h, sends)) ? null : "dead";\n', ""]], "review 8 S5 and S6:"],
  [SOL, [['return rec.state === "PLANNED" ? null : rec.leaf?.value === value ? "landed" : "dead";', 'return rec.state === "PLANNED" ? null : "landed";']], "review 8 S5 and S6:"],
  // S7: the leaf not checked
  [SOL, [['  await leafOf(sync, scope, n.precommitment, m);\n  return "landed";', '  return "landed";']], "review 8 S7:"],
  // S9 and S13: filled without every rung sent
  [SOL, [['  if (left.whole && ends.length > 0 && ends.every((e) => e === "landed")) return "filled";', '  if (ends.length > 0 && ends.every((e) => e === "landed")) return "filled";']], "review 8 S9 and S13:"],
  [SOL, [["whole: unsent === 0 });", "whole: true });"]], "review 8 S9 and S13:"],
  // S12: the end reads sends the run settled
  [SOL, [["      const still = new Set(open().map((t) => t.hash));", "      const still = new Set(sentTxs.map((t) => t.hash));"]], "review 8 S12:"],
  // S11: no "sent" answer for a send no RPC accepted
  [SOL, [["                if (!ended && ctx && l !== null && l.notes.length > 0) {", "                if (false) {"]], "review 8 S11:"],
  // review 1: the note followed by its captured sends only; every send dead read as an end; the pass not started
  [SOL, [["  const sends = rec?.sends?.length ? rec.sends : n.sends;", "  const sends = n.sends;"]], "review 8 S4:"],
  [SOL, [['  if (m === null) return dead.every(Boolean) ? "expired" : null;', '  if (m === null) return dead.every(Boolean) ? "dead" : null;']], "pool-deposit-sent-end review 1 (repro R)"],
  [SOL, [["    if (kick) h.settle?.();\n", ""]], "pool-deposit-sent-end review 1 (repro R)"],
  // review 2: the mark read with no slot pin
  [SOL, [['return await account(r, address, "finalized", at?.[k]);', 'return await account(r, address, "finalized");']], "pool-deposit-sent-end review 2 (repro Q)"],
  // review 3: part_filled while a send of the ask may land read as the end
  [SOL, [['(a.stage === "part_filled" && (l === null || l.notes.length === 0))', 'a.stage === "part_filled"']], "pool-deposit-sent-end review 3: rung 1"],
  // review 4: no backoff, no give-up, no stop
  [SOL, [["    if (quiet) gap = Math.min(gap * 2, POOL_DEPOSIT_FOLLOW_MAX_MS);\n", ""]], "pool-deposit-sent-end review 1: a note the pass cannot"],
  // fold review 5: a give-up on a clock (the old hour) back in
  [SOL, [["    await pause(gap);\n    waited += gap;\n", "    if (waited + gap > 3_600_000) return null;\n    await pause(gap);\n    waited += gap;\n"]], "pool-deposit-sent-end review 1: a note the pass cannot"],
  // the sign out read before each note's read (delta review low 4: the loop's own check folded into it)
  [SOL, [["      if (h.signal?.aborted) return null;\n      // a send not read before", "      // a send not read before"]], "pool-deposit-sent-end review 4: the end's reads stop"],
  // delta review 2 of release-86: the stop read before the wait for an RPC behind, not after it
  [SOL, [["    await pause(ms);\n    stopped(h);\n", "    stopped(h);\n    await pause(ms);\n"]], "pool-deposit-sent-end review 2 M1"],
  // E1: the follower's round read before U's finalized nonce
  [EVM, [['  const fin = await both(h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [n.u, "finalized"]), `rpc ${k} finalized nonce`));\n  stopped(h);\n  const round = await h.round();\n', '  const round = await h.round();\n  const fin = await both(h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [n.u, "finalized"]), `rpc ${k} finalized nonce`));\n']], "review 8 E1:"],
  // E4: a take read from a Deposited not final yet; E5: a Deposited at another value read as landed
  [EVM, [['  if (d !== undefined) return d.block > round.finalBlock ? null : d.value === n.value ? "landed" : "dead";', '  if (d !== undefined) return d.value !== n.value ? "dead" : d.block > round.finalBlock ? null : "landed";']], "review 8 E4 and E5:"],
  [EVM, [['  if (d !== undefined) return d.block > round.finalBlock ? null : d.value === n.value ? "landed" : "dead";', '  if (d !== undefined) return d.block > round.finalBlock ? null : "landed";']], "review 8 E4 and E5:"],
  // E7: filled without the whole ask sent
  [EVM, [['  if (left.whole && ends.length > 0 && ends.every((e) => e === "landed")) return "filled";', '  if (ends.length > 0 && ends.every((e) => e === "landed")) return "filled";']], "review 8 E7:"],
  // E8: the first send's nonce, not the highest
  [EVM, [["  const nonce = (rec?.evmSends ?? []).reduce((m, x) => (x.nonce > m ? x.nonce : m), n.nonce);", "  const nonce = rec?.evmSends?.[0]?.nonce ?? n.nonce;"]], "review 8 E8:"],
  // review 1 (EVM): every send dead read as an end; the pass not started
  [EVM, [['  return fin[0] > nonce && fin[1] > nonce ? "expired" : null;', '  return fin[0] > nonce && fin[1] > nonce ? "dead" : null;']], "pool-deposit-sent-end review 1 (EVM)"],
  [EVM, [["    if (kick) h.settle?.();\n", ""]], "pool-deposit-sent-end review 1 (EVM)"],
  // review 3 (EVM)
  [EVM, [['(a.stage === "part_filled" && (l === null || l.notes.length === 0))', 'a.stage === "part_filled"']], "pool-deposit-sent-end review 3 (EVM)"],
  // fold review 1: a rung's landing posted as "filled" (an end) again; X12 / X13: the run's own end never posted
  [SOL, [['          h.landed?.(done);\n          return "landed";', '          h.landed?.(done);\n          if (own) h.progress?.("filled");\n          return "landed";']], "pool-deposit-sent-end fold review 1: a two-rung"],
  [EVM, [["          // no stage per note: \"filled\" ends the trade in the app, so the ask's one end goes from the kind (review 1)\n          continue;", '          h.progress?.("filled");\n          continue;']], "pool-deposit-sent-end fold review 1 (EVM)"],
  [SOL, [["              } else if (ended) ctx?.progress((a as { stage: TradeStage }).stage);\n", "              } else if (ended) {\n              }\n"]], "M5:"],
  [EVM, [["            else if (ended) ctx?.progress((a as { stage: TradeStage }).stage);\n", "            else if (ended) {\n            }\n"]], "pool-deposit-sent-end fold review 1 (EVM)"],
  // fold review 4: X1, the EVM record restored at another value read as landed; X7, the EVM follower ignores the sign out;
  // X14, a failed read counted as a send that may land (no backoff)
  [EVM, [['return rec.state === "PLANNED" ? null : rec.leaf?.value === n.value ? "landed" : "dead";', 'return rec.state === "PLANNED" ? null : "landed";']], "pool-deposit-sent-end fold review 4 X1 (EVM)"],
  [EVM, [["      if (h.signal?.aborted) return null;\n      // a send not read before", "      // a send not read before"]], "pool-deposit-sent-end review 4 (EVM)"],
  [SOL, [['      const e = await noteEnd(h, sync, scope, n, wait, seen).catch(() => "fault" as const);', "      const e = await noteEnd(h, sync, scope, n, wait, seen).catch(() => null);"]], "pool-deposit-sent-end fold review 4 X14:"],
  [EVM, [['      const e = await noteEndEvm(h, n, seen).catch(() => "fault" as const);', "      const e = await noteEndEvm(h, n, seen).catch(() => null);"]], "pool-deposit-sent-end fold review 4 X14 (EVM)"],
  // fold review 5 (EVM): the give-up back in
  [EVM, [["    await wait(gap);\n    waited += gap;\n", "    if (waited + gap > 3_600_000) return null;\n    await wait(gap);\n    waited += gap;\n"]], "pool-deposit-sent-end review 4 (EVM)"],
  // fold review 6: the follower opens the note store (whose open and list settle, and may write) again
  [SOL, [["  const rec = (await h.records()).find(", "  const rec = (await (await h.notes()).list()).find("]], "pool-deposit-sent-end fold review 6:"],
  [EVM, [["  const rec = (await h.records()).find(", "  const rec = (await (await h.notes()).list()).find("]], "pool-deposit-sent-end fold review 6 (EVM)"],
  // fold review 3 (W1-W5): the page's wiring, each follow's pass and sign-out signal, and the sign out's abort
  [TESTNET, [["      settle: () => void settleSolana(),\n", ""]], "pool-deposit-sent-end fold review 3"],
  [TESTNET, [["        settle: () => void settleEvm(chain),\n", ""]], "pool-deposit-sent-end fold review 3"],
  [TESTNET, [["      settle: () => void settleSolana(),\n      signal: follows.signal,\n", "      settle: () => void settleSolana(),\n"]], "pool-deposit-sent-end fold review 3"],
  [TESTNET, [["        settle: () => void settleEvm(chain),\n        signal: follows.signal,\n", "        settle: () => void settleEvm(chain),\n"]], "pool-deposit-sent-end fold review 3"],
  [TESTNET, [["    follows.abort();\n", ""]], "pool-deposit-sent-end fold review 3"],
  // the delta review of 09542dc6 (its five Lows, "low N" below; R-ids are the reviewer's own mutants)
  // low 1: a read that stays "may land" never backs off (no landing window), or a note the pass sends anew keeps the old one
  [SOL, [["      else if (e === null && waited - since[k]! < POOL_DEPOSIT_LANDING_MS) quiet = false;", "      else if (e === null) quiet = false;"]], "pool-deposit-sent-end low 1: a send that stays"],
  [EVM, [["      else if (e === null && waited - since[k]! < POOL_DEPOSIT_EVM_LANDING_MS) quiet = false;", "      else if (e === null) quiet = false;"]], "pool-deposit-sent-end low 1 (EVM, REV E2)"],
  // a new send starts no new window; or only the follower's own kick does (delta review 2, info): a state read's pass
  // sends anew and the note is read a minute apart
  [SOL, [[SEEN, NO_SEEN]], "pool-deposit-sent-end low 1: a note the pass sends anew"],
  [SOL, [["  seen(sends[sends.length - 1]!.signature);\n", ""]], "pool-deposit-sent-end low 1: a note the pass sends anew"],
  [SOL, [[SEEN, NO_SEEN], ['      else if (e === "expired") kick = true;', '      else if (e === "expired") ((kick = true), (since[k] = waited));']], "pool-deposit-sent-end review 2 (info):"],
  [EVM, [[SEEN, NO_SEEN]], "pool-deposit-sent-end low 1 (EVM): a note the pass sends anew"],
  [EVM, [["  if (newest !== undefined) seen(newest.hash);\n", ""]], "pool-deposit-sent-end low 1 (EVM): a note the pass sends anew"],
  [EVM, [[SEEN, NO_SEEN], ['      else if (e === "expired") kick = true;', '      else if (e === "expired") ((kick = true), (since[k] = waited));']], "pool-deposit-sent-end review 2 (info, EVM)"],
  // low 2: R1/R2, an ask that ended followed too (a second end); R5, part_filled with no note open told filled; R10/R11,
  // no stop check after the last read
  [SOL, [["              else if (l !== null) follow = { h, left: l };", "              if (l !== null) follow = { h, left: l };"]], "pool-deposit-sent-end low 2 (REV S"],
  [EVM, [["            else if (l !== null) follow = { h, left: l };", "            if (l !== null) follow = { h, left: l };"]], "pool-deposit-sent-end low 2 (REV E1)"],
  [EVM, [["            else if (ended) ctx?.progress((a as { stage: TradeStage }).stage);", "            else if (ended) ctx?.progress(\"filled\");"]], "pool-deposit-sent-end low 2 R5 (EVM)"],
  [SOL, [["  if (h.signal?.aborted) return null;\n  if (left.whole", "  if (left.whole"]], "pool-deposit-sent-end low 2 R10:"],
  [EVM, [["  if (h.signal?.aborted) return null;\n  if (left.whole", "  if (left.whole"]], "pool-deposit-sent-end low 2 R11 (EVM)"],
  // low 3: R6/R7, the page's records reopen the note store (the notes lock, a settle that may write); R8, they read nothing
  [TESTNET, [["      records: async () => readNotes(await page.store()),\n      seed64", "      records: async () => (await openNoteStore(await page.store())).list(),\n      seed64"]], "pool-deposit-sent-end low 3"],
  [TESTNET, [["        records: async () => readNotes(await page.store()),\n        seed64", "        records: async () => (await openNoteStore(await page.store())).list(),\n        seed64"]], "pool-deposit-sent-end low 3"],
  [TESTNET, [["      records: async () => readNotes(await page.store()),\n      seed64", "      records: async () => [],\n      seed64"]], "pool-deposit-sent-end low 3"],
  // low 4: no stop before each read; the end's wait not ended by the sign out, or not given its signal
  [SOL, [['  if (h.signal?.aborted) throw new Error("signed out");\n', ""]], "pool-deposit-sent-end low 4: a sign out during"],
  [EVM, [["  stopped(h);\n  const fin", "  const fin"], ["  stopped(h);\n  const round", "  const round"]], "pool-deposit-sent-end low 4 (EVM, REV E3)"],
  [SOL, [['    signal?.addEventListener("abort", done, { once: true });\n', ""]], "pool-deposit-sent-end low 4: the end's own wait"],
  [SOL, [["  const pause = h.wait ?? ((ms: number) => followWait(ms, h.signal));", "  const pause = h.wait ?? ((ms: number) => followWait(ms));"]], "pool-deposit-sent-end low 4: the end's own wait"],
  // delta review 2 M1: a wait inside a note's reads not ended in the stop, so the mark's reads again go out after it
  [SOL, [["    await pause(ms);\n    stopped(h);\n", "    await pause(ms);\n"]], "pool-deposit-sent-end review 2 M1"],
  [EVM, [["  const wait = h.wait ?? ((ms: number) => followWait(ms, h.signal));", "  const wait = h.wait ?? ((ms: number) => followWait(ms));"]], "pool-deposit-sent-end low 4 (EVM): the end's own wait"],
  // low 5: a hand-off whose store read fails hands no note over (part_filled told unproved, or nothing after "sent")
  [EVM, [["        notes = [...askNotes.values()];\n", "        notes = [];\n"]], "pool-deposit-sent-end low 5 (EVM)"],
  // card kit-sol-pool-deposit-floor (S-01 review): the deposit hands the kit's builder the rent both RPCs read
  [SOL, [["{ value, precommitment }, st.sizes, blockhash, st.rent);", "{ value, precommitment }, st.sizes, blockhash, { lamportsPerByte: 0n, factor: 1n });"]], "H1 (probe B):"],
  [SOL, [["{ value, precommitment }, st.sizes, blockhash, st.rent);", "{ value, precommitment }, st.sizes, blockhash, { lamportsPerByte: 5_080n, factor: 1n });"]], "S-01 review:"],
];

const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
const RUN_MS = 300_000;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const run = (name, file) => {
  const r = runSync(process.execPath, ["--test", "--test-timeout=120000", "--test-name-pattern", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, timeoutMs: RUN_MS });
  if (r.status !== 0) return { ok: false, ran: true };
  return { ok: true, ran: /ℹ pass [1-9]/.test(r.stdout) };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const made = [];
  process.on("exit", () => made.forEach((f) => rmSync(f, { force: true })));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  let bad = 0;
  for (const [r, name] of new Set(MUTANTS.map((m) => `${m[0].test}\u0000${m[2]}`).values().map((x) => x.split("\u0000")))) {
    const x = run(name, here(`./${r}`));
    if (!x.ok || !x.ran) (console.log(`BAD  "${name}" does not pass on the code as it is`), bad++);
  }
  for (const [{ src, test }, edits, name] of MUTANTS) {
    const original = readFileSync(here(`../src/${src}`), "utf8");
    const base = src.replace(/\.ts$/, "");
    const mutantSrc = here(`../src/.${base}-mutant-${process.pid}.ts`);
    const mutantTest = here(`./.${base}-mutant-${process.pid}.test.ts`);
    const tests = readFileSync(here(`./${test}`), "utf8");
    const imp = `"../src/${src}"`;
    if (!tests.includes(imp)) (console.log(`BAD  ${test} does not import ${src}`), bad++);
    let text = original;
    let ok = true;
    for (const [from, to] of edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) (console.log(`BAD  mutant text ${n} times in ${src}, not once: ${from.slice(0, 80)}`), bad++, (ok = false));
      else text = text.replace(from, () => to);
    }
    if (!ok) continue;
    made.push(mutantSrc, mutantTest);
    writeFileSync(mutantSrc, text);
    writeFileSync(mutantTest, tests.split(imp).join(`"../src/.${base}-mutant-${process.pid}.ts"`));
    try {
      const x = run(name, mutantTest);
      const what = edits[0][0].trim().slice(0, 90).replace(/\n/g, " ");
      if (x.ok) (console.log(`LIVE "${name}" passes with: ${what}`), bad++);
      else console.log(`killed  ${src}: ${what}`);
    } finally {
      rmSync(mutantSrc, { force: true });
      rmSync(mutantTest, { force: true });
    }
  }
  console.log(bad === 0 ? `all ${MUTANTS.length} mutants killed` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
