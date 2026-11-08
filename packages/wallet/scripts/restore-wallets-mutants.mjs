// node packages/wallet/scripts/restore-wallets-mutants.mjs (card wallet-restore-wallets): plants one broken rule of the
// wallet and deposit-id restore (src/restore/wallets.ts, wallet.md §2.3 steps 4, 5 and 7) or of the lane walk's Worker
// bridge (src/restore/walk.ts) at a time, runs the test that holds that rule, expects it to fail, and puts the source
// back. "strings sent and taken" is the wallet-restore-notes round-3 review's case: a bridge that sends the
// precommitments as strings to a Worker that takes them restores no note with every check on the walk passing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const P = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const WALK = "wallet/src/restore/walk.ts";
const WAL = "wallet/src/restore/wallets.ts";
const NR = ["wallet", "test/note-restore.test.ts"];
const RW = ["wallet", "test/restore-wallets.test.ts"];
const SENT = "precommitments: [...precommitments] };";
const STRINGS = "precommitments: [...precommitments].map(String) as unknown as bigint[] };";
const CHECK = '!a.precommitments.every((p) => typeof p === "bigint")';
// [name, file, [[the source as written, the plant]...], [package, test file], test name pattern]
const M = [
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
  ["the deposit ids read one short of the margin", WAL, [["+ RESTORE_LANES * margin;", "+ RESTORE_LANES * (margin - 1);"]], RW, "step 5"],
  ["a failed id read is not money", WAL, [["        unread.push({ i, id, error: why(e) });\n        highest = Math.max(highest ?? i, i);", "        unread.push({ i, id, error: why(e) });"]], RW, "step 5"],
  ["history does not move the lane's highest", WAL, [['      (state === "money" ? money : used).push(i);\n      highest = Math.max(highest ?? i, i);', '      (state === "money" ? money : used).push(i);']], RW, "step 5"],
  ["a used id does not reset the margin (review: money past 21 used ids)", WAL, [['      if (state === "unused") continue;', '      if (state !== "money") continue;']], RW, "step 5"],
  ["failed id reads never end a lane (review: a reader that always rejects)", WAL, [["if (++failed >= margin) throw", "if (++failed >= Infinity) throw"]], RW, "step 5"],
  ["a read showing history does not restart the failure count", WAL, [["      failed = 0;\n", ""]], RW, "step 5"],
  ["the note walk's end not checked against the ids with history", WAL, [["if (highest !== null && highest > walked) throw", "if (false) throw"]], RW, "step 5"],
  ["R12: an id answer that is not money, used or unused taken", WAL, [['        if (state !== "money" && state !== "used" && state !== "unused") throw new Error("the read answered neither money, used nor unused");\n', ""]], RW, "step 5"],
  ["the walk's highest not checked against the notes", WAL, [["if (h !== (notes.length === 0 ? null : notes[notes.length - 1])) throw", "if (false) throw"]], RW, "step 5"],
  ["step 7 covers the highest plus one", WAL, [["x.highest + 2 * RESTORE_LANES", "x.highest + RESTORE_LANES"]], RW, "step 7"],
  ["step 7 covers an empty lane's first index only", WAL, [["x.highest === null ? x.lane + RESTORE_LANES :", "x.highest === null ? x.lane :"]], RW, "step 7"],
  ["the re-reads take ids that hold a note or money", WAL, [["if (!held.has(i)) rereads.push", "rereads.push"]], RW, "step 7"],
  ["the re-reads due at the window's end", WAL, [["return nowMs < plan.until ?", "return nowMs <= plan.until ?"]], RW, "step 7"],
  ["a 48 h window", WAL, [["export const REREAD_MS = 72 * 3_600_000;", "export const REREAD_MS = 48 * 3_600_000;"]], RW, "step 7"],
  ["W's secret key left in memory", WAL, [["    w.secretKey.fill(0);\n", ""]], ["wallet", "test/pool-zeroing.test.ts"], "restoreWallets zeroes"],
  ["the counter raised from lane 0's highest", WAL, [["const mine = lanes[store.lane]!;", "const mine = lanes[0]!;"]], RW, "step 7"],
  ["R19: an unread id dropped from step 7's re-reads", WAL, [["const held = new Set([...x.notes, ...x.money]);", "const held = new Set([...x.notes, ...x.money, ...x.unread.map((u) => u.i)]);"]], RW, "step 7"],
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
