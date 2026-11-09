// node packages/wallet/scripts/restore-wallets-mutants.mjs (card wallet-restore-wallets): plants one broken rule of the
// wallet and deposit-id restore (src/restore/wallets.ts, wallet.md §2.3 steps 4, 5 and 7) or of the lane walk's Worker
// bridge (src/restore/walk.ts) at a time, runs the test that holds that rule, expects it to fail, and puts the source
// back. Also the same-chain deposit's rent hand-off to the kit's builder (card kit-sol-pool-deposit-floor, src/pool/
// same-chain.ts). "strings sent and taken" is the wallet-restore-notes round-3 review's case: a bridge that sends the
// precommitments as strings to a Worker that takes them restores no note with every check on the walk passing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const P = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const WALK = "wallet/src/restore/walk.ts";
const WAL = "wallet/src/restore/wallets.ts";
const ARMS = "wallet/src/restore/arms.ts";
const IDR = "wallet/src/restore/id-reader.ts";
const AFT = "wallet/src/restore/after.ts";
const NOTES = "wallet/src/notes/restore.ts";
const ID = ["wallet", "test/restore-id-reader.test.ts"];
const NR = ["wallet", "test/note-restore.test.ts"];
const RW = ["wallet", "test/restore-wallets.test.ts"];
// card kit-sol-pool-deposit-floor (S-01 review): the same-chain deposit hands the kit's builder the rent the device read
const SC = "wallet/src/pool/same-chain.ts";
const PSC = ["wallet", "test/pool-same-chain.test.ts"];
const RENT_IN = "a.sizes, a.blockhash, a.rent) };";
const SENT = "precommitments: [...precommitments] };";
const STRINGS = "precommitments: [...precommitments].map(String) as unknown as bigint[] };";
const CHECK = '!a.precommitments.every((p) => typeof p === "bigint")';
// [name, file, [[the source as written, the plant]...], [package, test file], test name pattern]
const M = [
  ["S-01 review: the same-chain deposit builds at a rent of 0, not the rent read", SC, [[RENT_IN, "a.sizes, a.blockhash, { lamportsPerByte: 0n, factor: 1n }) };"]], PSC, "S-01 review"],
  ["S-01 review: the same-chain deposit builds at mainnet's rent, not the rent read", SC, [[RENT_IN, "a.sizes, a.blockhash, { lamportsPerByte: 5_080n, factor: 1n }) };"]], PSC, "S-01 review"],
  ["the bridge sends the precommitments as strings", WALK, [[SENT, STRINGS]], NR, "Worker bridge"],
  ["the Worker takes precommitments that are not bigints", WALK, [[CHECK, "false"]], NR, "Worker bridge"],
  ["strings sent and taken (round-3 review)", WALK, [[SENT, STRINGS], [CHECK, "false"]], NR, "Worker bridge"],
  ["a Worker's refusal taken as an empty walk", WALK, [["a?.ok === true ? resolve(a.walk)", "a?.ok !== undefined ? resolve(a.ok ? a.walk : { found: [], last: lane, lastPrecommitment: 0n })"]], NR, "Worker bridge"],
  ["a failed history read taken as no history", WAL, [["        s.failed = true;\n        unread.push({ c: s.c, l: s.l, j: s.j, address: s.address, chain, error: why(e) });\n        continue;", "        continue;"]], RW, "step 4"],
  ["no hop target read after a failed read", WAL, [["slots.some((s) => found(s) || s.failed)", "slots.some((s) => found(s))"]], RW, "step 4"],
  ["an evm wallet read on Base only", WAL, [['  evm: ["base", "robinhood"],', '  evm: ["base"],']], RW, "step 4"],
  ["a hop-evm target read on Base only", WAL, [['  "hop-evm": ["base", "robinhood"],', '  "hop-evm": ["base"],']], RW, "step 4"],
  ["a return note does not make a wallet found", WAL, [["s.history.length > 0 || s.returnNote !== null", "s.history.length > 0"]], RW, "step 4"],
  ["a hop's return note does not read the hop targets", WAL, [["|| hopReturn(armsList[k]!) ?", "?"]], RW, "step 4"],
  ["an answer that is not yes or no taken", WAL, [['        yes = await read(chain, s.address);\n        if (typeof yes !== "boolean") throw new Error("the read answered neither yes nor no");', "        yes = await read(chain, s.address);"]], RW, "step 4"],
  ["the reads in the notes' order", WAL, [["for (const [s, chain] of shuffled(slots.flatMap((s) => READS[s.c].map((chain) => [s, chain] as const)), pick))", "for (const [s, chain] of slots.flatMap((s) => READS[s.c].map((chain) => [s, chain] as const)))"]], RW, "step 4"],
  ["no hop target read", WAL, [["await readAll(hops.flat());", ""]], RW, "step 4"],
  ["one arm per label", WAL, [["    const k = `${s.l}:${s.j}`;", "    const k = `${s.l}`;"]], RW, "step 4"],
  ["the deposit ids read one short of the margin", WAL, [["(highest ?? lane - RESTORE_LANES) + RESTORE_LANES * margin);", "(highest ?? lane - RESTORE_LANES) + RESTORE_LANES * (margin - 1));"]], RW, "step 5"],
  ["a failed id read is not money", WAL, [["        unread.push({ i, id, error: why(e) });\n        highest = Math.max(highest ?? i, i);", "        unread.push({ i, id, error: why(e) });"]], RW, "step 5"],
  ["history does not move the lane's highest", WAL, [['      (state === "money" ? money : used).push(i);\n      highest = Math.max(highest ?? i, i);', '      (state === "money" ? money : used).push(i);']], RW, "step 5"],
  ["a used id does not reset the margin (review: money past 21 used ids)", WAL, [['      if (state === "unused") continue;', '      if (state !== "money") continue;']], RW, "step 5"],
  ["failed id reads never end a lane (review: a reader that always rejects)", WAL, [["if (++failed >= margin) throw", "if (++failed >= Infinity) throw"]], RW, "step 5"],
  ["a read showing history does not restart the failure count", WAL, [["      failed = 0;\n", ""]], RW, "step 5"],
  ["the note walk's end not checked against the ids with history", WAL, [["      failed = 0;\n      if (highest > walked) {", "      failed = 0;\n      if (false) {"]], RW, "step 5"],
  ["review F4: the walk's end taken from the default gap, not the restore's laneWalked", WAL, [["const walked = r.laneWalked[lane]!;", "const walked = (h ?? lane - RESTORE_LANES) + RESTORE_LANES * 10_000;"]], RW, "step 5"],
  ["review F4: a walk end that is not the lane's, or below its highest note, taken", WAL, [["      throw new Error(`lane ${lane}: its walk end", "      void new Error(`lane ${lane}: its walk end"]], RW, "step 5"],
  ["review F5: a lane past its walk's end stops the restore instead of returning what it found", WAL, [["        reach = highest;\n        break;\n      }\n    }", "        throw new Error(`lane ${lane}: past the walk's end`);\n      }\n    }"]], RW, "step 5"],
  ["review F5: the lane's reach not returned", WAL, [["highest, readTo, reach });", "highest, readTo, reach: null });"]], RW, "step 5"],
  ["R29: a failed id read past the walk's end does not stop the lane", WAL, [["to be retried`);\n        if (highest > walked) {", "to be retried`);\n        if (false) {"]], RW, "step 5"],
  ["review 2 R27: a never-used id restarts the failure count", WAL, [['      if (state === "unused") continue;', '      if (state === "unused") { failed = 0; continue; }']], RW, "step 5"],
  ["review 2 R28: history at the walk's last index stops", WAL, [["      failed = 0;\n      if (highest > walked) {", "      failed = 0;\n      if (highest >= walked) {"]], RW, "step 5"],
  ["R12: an id answer that is not money, used or unused taken", WAL, [['        if (state !== "money" && state !== "used" && state !== "unused") throw new Error("the read answered neither money, used nor unused");\n', ""]], RW, "step 5"],
  ["the walk's highest not checked against the notes", WAL, [["if (h !== (notes.length === 0 ? null : notes[notes.length - 1])) throw", "if (false) throw"]], RW, "step 5"],
  ["step 7 covers the highest plus one", WAL, [["x.highest + 2 * RESTORE_LANES", "x.highest + RESTORE_LANES"]], RW, "step 7"],
  ["step 7 covers an empty lane's first index only", WAL, [["x.highest === null ? x.lane + RESTORE_LANES :", "x.highest === null ? x.lane :"]], RW, "step 7"],
  ["the re-reads take ids that hold a note", WAL, [["if (!held.has(i)) rereads.push", "rereads.push"]], RW, "step 7"],
  ["the re-reads due at the window's end", AFT, [["if (Math.min(...now.timesMs) >= restoreMs + REREAD_MS) return", "if (Math.min(...now.timesMs) > restoreMs + REREAD_MS) return"]], ID, "step 7's re-reads"],
  ["a 48 h window", WAL, [["export const REREAD_MS = 72 * 3_600_000;", "export const REREAD_MS = 48 * 3_600_000;"]], ID, "step 7's re-reads"],
  ["W's secret key left in memory", WAL, [["    w.secretKey.fill(0);\n", ""]], ["wallet", "test/pool-zeroing.test.ts"], "restoreWallets zeroes"],
  ["review N1 fold: the pass's floor the lower final", IDR, [["const floor = Math.max(fin[0].h, fin[1].h);", "const floor = Math.min(fin[0].h, fin[1].h);"]], ID, "the pass:"],
  ["review N1 fold: no bound on the wait for the provider behind", IDR, [["if (k >= passTries) throw", "if (false) throw"]], ID, "the pass:"],
  ["review N1 fold: the floor block's hashes not agreed", IDR, [["if (x.hash !== y.hash) throw", "if (false) throw"]], ID, "the pass:"],
  ["review N1 fold: the finals not held within 120 blocks", IDR, [["if (Math.abs(fin[0].h - fin[1].h) > VAULT_SYNC_LAG_MAX) throw", "if (false) throw"]], ID, "the pass:"],
  ["review N1 fold: the views pinned by height, not by the pass's hash", IDR, [['block_id: "hash" in ask ? ask.hash : ask.height', 'block_id: "hash" in ask ? ask.h : ask.height']], ID, "one block for the pass"],
  ["review N1 fold: a view's block not checked against the pass's", IDR, [['("hash" in ask ? b.hash !== ask.hash || b.h !== ask.h : b.h !== ask.height)', '("hash" in ask ? false : b.h !== ask.height)']], ID, "one block for the pass"],
  ["review P1: a stale pass taken", IDR, [["if (pass.h < Math.max(a.h, b.h) - VAULT_SYNC_LAG_MAX)", "if (false)"]], ID, "a stale pass"],
  ["review P1: a pass exactly 120 below the finals refused", IDR, [["if (pass.h < Math.max(a.h, b.h) - VAULT_SYNC_LAG_MAX)", "if (pass.h <= Math.max(a.h, b.h) - VAULT_SYNC_LAG_MAX)"]], ID, "a stale pass"],
  ["review P1 fold: freshness judged against the lower final", IDR, [["if (pass.h < Math.max(a.h, b.h) - VAULT_SYNC_LAG_MAX)", "if (pass.h < Math.min(a.h, b.h) - VAULT_SYNC_LAG_MAX)"]], ID, "a stale pass"],
  ["review P1: a scan's pass not held above its height", IDR, [["if (opts.after !== undefined && floor <= opts.after) throw", "if (false) throw"]], ID, "step 7's"],
  ["review P1: the second scan's pass at its bound height taken", AFT, [["openRestorePass(network, rpcs, passOpts(o, bound));", "openRestorePass(network, rpcs, passOpts(o, bound - 1));"]], ID, "second scan:"],
  ["review P1: the re-reads' pass at the restore's height taken", AFT, [["openRestorePass(network, rpcs, passOpts(o, restored.h));", "openRestorePass(network, rpcs, passOpts(o, restored.h - 1));"]], ID, "step 7's re-reads"],
  ["review P2: a pass's providers matched by name", IDR, [["own[0] !== rpcs[0] || own[1] !== rpcs[1]", "own[0].name !== rpcs[0].name || own[1].name !== rpcs[1].name"]], ID, "a stale pass"],
  // delta review 5: the steps that look for money after a height own their reads (src/restore/after.ts)
  ["review R1: the re-reads take a pass openRestorePass never opened", AFT, [["  ownPass(restored, network, rpcs);\n  if (plan?.after", "  if (plan?.after"]], ID, "owned steps take no reader"],
  ["review R1: the second scan takes a pass openRestorePass never opened", AFT, [["  ownPass(restored, network, rpcs);\n  const restoreMs", "  const restoreMs"]], ID, "owned steps take no reader"],
  ["review R1: a restore's pass taken on other provider objects", IDR, [["own[0] === on.rpcs[0] && own[1] === on.rpcs[1]", "true"]], ID, "owned steps take no reader"],
  ["review R1: afterRestore takes a pass openRestorePass never opened", WAL, [["if (!isRestorePass(restored)) throw", "if (false) throw"]], RW, "step 7"],
  ["review R1: the re-reads take a plan of another height", AFT, [["if (plan?.after !== restored.h) throw", "if (false) throw"]], ID, "owned steps take no reader"],
  ["review R1: the re-reads read on the restore's pass", AFT, [["const read = await nearIdReader(network, rpcs, pass,", "const read = await nearIdReader(network, rpcs, restored,"]], ID, "owned steps take no reader"],
  ["review R1: the second scan's ids read on the restore's pass", AFT, [["notes, await nearIdReader(network, rpcs, pass,", "notes, await nearIdReader(network, rpcs, restored,"]], ID, "second scan:"],
  ["review R1: the second scan's arms read on the restore's pass", AFT, [["await nearBalanceReader(network, rpcs, pass,", "await nearBalanceReader(network, rpcs, restored,"]], ID, "second scan:"],
  ["review R1: the re-reads' clock the higher final", AFT, [["if (Math.min(...now.timesMs) >= restoreMs", "if (Math.max(...now.timesMs) >= restoreMs"]], ID, "step 7's re-reads"],
  ["review R1: the pass block's header hash not checked at the open", IDR, [["if (y === NO_BLOCK || y.hash !== x.hash) throw", "if (y === NO_BLOCK) throw"]], ID, "step 7's clock"],
  ["delta review 6 P2: the providers' times of the pass block not agreed", IDR, [["if (t0!.ms !== t1!.ms) throw", "if (false) throw"]], ID, "step 7's clock"],
  ["delta review 6 P1: the bound block read by height however old", AFT, [["const h = Math.max(bound, now.heights[k] - d);", "const h = bound;"]], ID, "step 7's clock"],
  ["delta review 7 P2: a header read not retried", IDR, [["      if (k + 1 >= tries) throw e;\n      await sleep(backoff * 2 ** k);\n    }\n  }\n}", "      throw e;\n    }\n  }\n}"]], ID, "step 7's clock: header reads"],
  ["delta review 7 P2: the pass's block unserved once taken as a wrong hash", IDR, [["if (served && y === NO_BLOCK) throw", "if (false) throw"]], ID, "step 7's clock: header reads"],
  ["delta review 7 P3: the bound's stand-in older than its own final only", AFT, [["ms + SECOND_SCAN_DELIVERY_MS < Math.min(...now.timesMs)", "ms + SECOND_SCAN_DELIVERY_MS < now.timesMs[k]"]], ID, "step 7's clock: header reads"],
  ["delta review 7 P3: a time-less pass taken", AFT, [["if (ms === null) throw", "if (false) throw"]], ID, "step 7's clock: header reads"],
  ["review R2: the pass holds the caller's own array", IDR, [["rpcs: Object.freeze([rpcs[0], rpcs[1]] as const), ms }", "rpcs, ms }"]], ID, "a stale pass"],
  ["review R3: the second scan runs before it is due", AFT, [["  if (!secondScanDue(at, now, boundMs)) return { due: false };\n", ""]], ID, "second scan:"],
  ["review R3: the second scan's bound is the restore's block", AFT, [["await boundTimesMs(rpcs, bound, now, o)", "await boundTimesMs(rpcs, restored.h, now, o)"]], ID, "second scan:"],
  ["review R3: a skipped bound block stops the scan", IDR, [['if ("block_id" in params && cause === "UNKNOWN_BLOCK") return NO_BLOCK;', ""]], ID, "second scan:"],
  ["review R3: the second scan's vault read below its bound", AFT, [["    atLeast: bound,\n", ""]], ID, "second scan:"],
  ["review R3: restoreNotes drops atLeast", NOTES, [["height: a.atLeast ?? 0 }", "height: 0 }"]], ID, "second scan:"],
  ["review N2: an id read as money left out of step 7's re-reads", WAL, [["const held = new Set(x.notes);", "const held = new Set([...x.notes, ...x.money]);"]], RW, "step 7"],
  ["review N3: step 7 takes a restore with a lane stopped at its reach", WAL, [["  if (stopped.length > 0)\n    throw", "  if (false)\n    throw"]], RW, "N3"],
  ["review N3: an unfinished restore called complete", WAL, [["complete: out.every((x) => x.reach === null)", "complete: true"]], RW, "N3"],
  ["review F7: an R, V or A secret key left in memory", ARMS, [["  k.secretKey.fill(0);\n  return k.id;", "  return k.id;"]], ["wallet", "test/pool-zeroing.test.ts"], "restoreArmAccounts zeroes"],
  ["the counter raised from lane 0's highest", WAL, [["const mine = lanes[store.lane]!;", "const mine = lanes[0]!;"]], RW, "step 7"],
  ["R19: an unread id dropped from step 7's re-reads", WAL, [["const held = new Set(x.notes);", "const held = new Set([...x.notes, ...x.unread.map((u) => u.i)]);"]], RW, "step 7"],
  ["R13: the lanes' order not checked", WAL, [["|| !lanes.every((x, k) => x.lane === k)", ""]], RW, "step 7"],
  ["R01: the seed in the Worker's message", WALK, [[SENT, "precommitments: [...precommitments], seed64 } as WalkAsk;"]], NR, "Worker bridge"],
  ["R02: no Worker error listener", WALK, [['      w.addEventListener("error", () => end(() => reject(new Error(`lane ${lane}: the walk worker failed`))));\n', ""]], NR, "Worker bridge"],
];
// one plant alone: node packages/wallet/scripts/restore-wallets-mutants.mjs "<part of its name>"
const only = process.argv[2];
const RUN = only === undefined ? M : M.filter(([name]) => name.includes(only));
if (RUN.length === 0) throw new Error(`no plant named ${only}`);
let ok = 0;
for (const [name, file, edits, [pkg, test], pat] of RUN) {
  const path = `${P}/${file}`;
  const src = readFileSync(path, "utf8");
  let planted = src;
  for (const [from, to] of edits) {
    if (planted.split(from).length !== 2) {
      console.log(`NOT ONCE [${name}]: ${from.slice(0, 60)}`);
      process.exit(1);
    }
    planted = planted.replace(from, to);
  }
  writeFileSync(path, planted);
  // a run past 180 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync("node", ["--test", `--test-name-pattern=${pat}`, test], { cwd: `${P}/${pkg}`, encoding: "utf8", timeoutMs: 180_000 });
  } finally {
    writeFileSync(path, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}`);
}
console.log(`${ok}/${RUN.length} killed`);
if (ok !== RUN.length) process.exitCode = 1;
