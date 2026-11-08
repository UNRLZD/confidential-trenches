// Removes each of src/checks/evm/pool-index.ts's rules (F4a-F4d, F5, F6, card evm-pool-index, and the money review of
// 44002c66's F1-F7), one at a time, and runs the test named for it in test/evm-pool-index.test.ts: each named test
// passes on the code as it is and fails on every mutant. The file is changed in a copy of the kit (test/mutant-copy.mjs),
// never the kit's own, and put back after each mutant (and checked to be back); exits 1 when a named test passes on its
// mutant, fails or runs no test on the code as it is, or a mutant's text is not in its file exactly once.
//   node packages/kit/test/evm-pool-index-mutants.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
import { KIT, kitCopy } from "./mutant-copy.mjs";

const BASE = process.argv[1] === fileURLToPath(import.meta.url) ? kitCopy() : KIT;
const SRC = path.join(BASE, "src/checks/evm/pool-index.ts");
const TEST = path.join(BASE, "test/evm-pool-index.test.ts");

const F4A = "F4a: a span counts only when both readers answered it";
const F4B = "F4b: the index head is the lower of the two proven heads";
const F4C = "F4c: the gap read ends at the agreed block";
const F4D = "F4d: stored only up to the reorg margin below the head";
const F5 = "F5: a pool only one reader reported is kept only if";
const F6 = "F6: past the hard pool cap the index refuses by name";
const HALVES = "a span answered with an error is asked as its halves";
const LIMITED = "a rate limit answered inside a batch is asked again";
const LAG = "a sync whose readers lag the last sync's head";
const FLOOD = "one reader's made-up pools never refuse the index as too many";
const P1 = "P1: a reader that omits a pool and answers its state 0";
const P2 = "P2: both readers report a pool, one at another block";
const P3 = "P3: a reader that moves a deep pool into the margin";
const P4 = "P4: heads more than the margin apart refuse";
const P5 = "P5: a sync at the stored head keeps the head it stood at";
const ALONE = "a batch whose tries are spent on throws is asked one span a request";
const WAIT = "a batch waits on 429s at most INDEX_LIMITED_WAIT_MS";
const FORK = "a span's last block on another fork on one reader is asked again";
const UNREAD = "a pool whose state is not answered leaves its span unproven";
const LOGS = "a log of another block range, another address, removed or of another event is no pool";
const BUDGET = "the halves' budget spent ends the sync rpc_error";
const Q1 = "Q1: a 429 whose Retry-After is 0 or a past date waits at least the backoff";
const Q2 = "Q2: one lying reader in a partial sync never stores a pool at its block";
const Q3 = "Q3: a pool one reader logs inside the depth whose transaction's receipt on the other is another block refuses";
const R1 = "R1: a receipt answered null is asked again after the backoff";
const R2 = "R2: one-reader pools' receipts are asked in batches small enough";
const R3 = "R3: a receipt answer that is not a receipt";
const S1 = "S1: a liar's";
const S2 = "S2: a receipt answered with a rate limit inside the batch once";

/** [find, replace, test]: each a rule removed. */
export const MUTANTS = [
  // F4a: an answer without its last block counts; a failed span not asked again; one reader's answer enough
  ["if (!Array.isArray(logs) || !blk || !isHash(blk.hash) || !isQty(blk.number) || Number(blk.number) !== j.b) return null;", "if (!Array.isArray(logs)) return null;", F4A],
  ["export const INDEX_TRIES = 4;", "export const INDEX_TRIES = 1;", F4A],
  ["return js.flatMap((j) => (j.ans[0] !== null && j.ans[1] !== null ? settle(j) : [j]));", "return js.flatMap((j) => (j.ans[0] !== null || j.ans[1] !== null ? ((j.ans[0] ??= j.ans[1]), (j.ans[1] ??= j.ans[0]), settle(j)) : [j]));", F4A],
  // F4b: the higher head; F3 (review): heads any distance apart
  ["const n = Math.min(heads[0]!, heads[1]!);", "const n = Math.max(heads[0]!, heads[1]!);", F4B],
  ["if (Math.max(heads[0]!, heads[1]!) - n > c.margin) return refuse(", "if (false) return refuse(", P4],
  // F4c: no pin at once; the newest span not asked alone first
  ['if (j.b === n && x.hash !== y.hash) return refuse("rpc_disagree", `the index readers do not agree on block ${n}`);', "", F4C],
  ["let at = queue.shift();\n  while (at !== undefined && pin === null) {", "let at = queue.shift();\n  if (at !== undefined) queue.push(at);\n  at = undefined;\n  while (at !== undefined && pin === null) {", F4C],
  // F4d: no margin; a lagging sync lowers what an earlier one stored
  ["const stored = Math.max(old?.through ?? from - 1, n - c.margin);", "const stored = n;", F4D],
  ["const stored = Math.max(old?.through ?? from - 1, n - c.margin);", "const stored = Math.max(from - 1, n - c.margin);", LAG],
  // F5: one reader's pool kept unread; any non-zero word enough; words apart not refused (F1); the log's id word trusted
  ["(y.pools.has(id) ? both : one).push(p);", "both.push(p);", F5],
  ["else if (BigInt.asUintN(160, BigInt(u)) !== 0n) held.add(p.id);", "else held.add(p.id);", F5],
  ["else if (BigInt(u) !== BigInt(v)) refuse(", "else if (false) refuse(", P1],
  ["if (id !== t[1]!.toLowerCase()) return null;", "", F5],
  // F7 (review): an unread state keeps its span, or leaves the sync whole
  ["proved = proved.filter((p) => !p.one.some((o) => unread.has(o.id)));", "", UNREAD],
  ["error ??= new EvmQuoteError(\"rpc_error\", `the index readers did not answer the PoolManager's state", "void new EvmQuoteError(\"rpc_error\", `the index readers did not answer the PoolManager's state", UNREAD],
  // F2 (review): a pool at two blocks on the two readers; one id in two spans; a span's last block apart not asked
  // again, or asked once
  ["const sameBlocks = [...x.pools].every(([id, p]) => !y.pools.has(id) || y.pools.get(id)!.block === p.block);", "const sameBlocks = true;", P2],
  ["if (where.has(p.id)) return refuse(", "if (false) return refuse(", P3],
  ["if (x.hash !== y.hash || !sameBlocks) {", "if (!sameBlocks) {", FORK],
  ["if (++j.disagree >= INDEX_TRIES) return refuse(", "if (++j.disagree >= 1) return refuse(", FORK],
  // F6: no cap; one reader's pools counted before F5; held pools past the cap (F4); more single-reader pools than the cap
  ["count += both.length;\n    if (count > c.cap) return refuse(", "count += both.length;\n    if (false) return refuse(", F6],
  ["count += both.length;\n", "count += both.length + one.length;\n", FLOOD],
  ["if (count + [...held].filter((id) => kept.has(id)).length > c.cap) return refuse(", "if (false) return refuse(", F6],
  ["if (ones.length > c.cap) return refuse(", "if (false) return refuse(", FLOOD],
  // F6 (review): a sync at the stored head writes N with the old hash; a head below the stored one served
  ["head: pin !== null ? { number: n, hash: pin } : old!.head,", "head: { number: n, hash: pin ?? old!.head.hash },", P5],
  ["if (old !== null && n < old.through) return refuse(", "if (false) return refuse(", P5],
  // the log's checks (F7, review): block range, address, removed, event
  ["if (n < a || n > b) return null;", "", LOGS],
  ["if (typeof o.address !== \"string\" || o.address.toLowerCase() !== pm || !Array.isArray(t)", "if (typeof o.address !== \"string\" || !Array.isArray(t)", LOGS],
  ["if (typeof o !== \"object\" || o === null || o.removed === true) return null;", "if (typeof o !== \"object\" || o === null) return null;", LOGS],
  ["if (t[0]!.toLowerCase() !== INITIALIZE || !isQty(o.blockNumber)", "if (!isQty(o.blockNumber)", LOGS],
  // the halves: an error answer is no cut; a rate limit in a batch asked as halves; one block's error named too many
  // pools (F4); no budget (F7)
  ["if (l?.error !== undefined && l.result === undefined) return limited(l.error) ? null : NO_ANSWER;", "", HALVES],
  ["return limited(l.error) ? null : NO_ANSWER;", "return NO_ANSWER;", LIMITED],
  ['x.cut === "full" && y.cut === "full" ? refuse("too_many_pools"', 'true ? refuse("too_many_pools"', HALVES],
  ["if ((halves -= 2) < 0) return refuse(", "if (false) return refuse(", BUDGET],
  // 429s: one spends a try; no bound on a batch's wait; the wait not clipped to the bound (F5)
  ["if (/429|rate limit/i.test(String((e as Error)?.message)) && waited < INDEX_LIMITED_WAIT_MS) {", "if (false) {", HALVES],
  ["if (/429|rate limit/i.test(String((e as Error)?.message)) && waited < INDEX_LIMITED_WAIT_MS) {", "if (/429|rate limit/i.test(String((e as Error)?.message))) {", WAIT],
  ["const ms = Math.min(Math.max(typeof after === \"number\" && after >= 0 ? after : 0, BACKOFF_MS * 2 ** waits++), INDEX_LIMITED_WAIT_MS - waited);", "const ms = Math.max(typeof after === \"number\" && after >= 0 ? after : 0, BACKOFF_MS * 2 ** waits++);", WAIT],
  // review 2 of 1fb6b198, P1: a 429 of Retry-After 0 (or a past date) waits nothing
  ["Math.max(typeof after === \"number\" && after >= 0 ? after : 0, BACKOFF_MS * 2 ** waits++)", "(typeof after === \"number\" && after >= 0 ? after : BACKOFF_MS * 2 ** waits++)", Q1],
  // review 2 of 1fb6b198, P1: a one-reader pool's block taken on that reader's word: no receipt asked; asked of the
  // reader that logged it; each of the receipt's checks; an unanswered receipt taken as agreeing; a log with no hashes
  ["const check = ones.filter((p) => held.has(p.id));", "const check = ones.filter(() => false);", Q3],
  ["let of = check.filter((p) => logged.get(p.id)!.by !== r);", "let of = check.filter((p) => logged.get(p.id)!.by === r);", Q3],
  ["isQty(rc.blockNumber) && Number(rc.blockNumber) === p.block && ", "", Q3],
  ["typeof rc.blockHash === \"string\" && rc.blockHash.toLowerCase() === f.at && ", "", Q3],
  ["Array.isArray(rc.logs) && rc.logs.some((l) => {", "(Array.isArray(rc.logs) || true) && [true].some((l) => { return true;", Q3],
  ["return g !== null && g.p.id === p.id && g.tx === f.tx && g.at === f.at;", "return g !== null && g.tx === f.tx && g.at === f.at;", Q3],
  ["return g !== null && g.p.id === p.id && g.tx === f.tx && g.at === f.at;", "return g !== null && g.p.id === p.id && g.at === f.at;", Q3],
  ["return g !== null && g.p.id === p.id && g.tx === f.tx && g.at === f.at;", "return g !== null && g.p.id === p.id && g.tx === f.tx;", Q3],
  ["if (typeof a !== \"object\" || Array.isArray(a)) return void unread.add(p.id);", "if (typeof a !== \"object\" || Array.isArray(a)) return;", Q3],
  ["if (!isHash(o.transactionHash) || !isHash(o.blockHash)) return null;", "", LOGS],
  // review 2 of 1fb6b198, P2 (Q2): the liar's one-reader pool kept, at its block
  ["if (!same) refuse(", "if (false) refuse(", Q2],
  // review 3 of 7f1ad79a: a null receipt unread at once, or refused, or never asked again, or asked again at once; a
  // receipt null on every try kept; 500 receipts a batch; an answer that is not a receipt checked as one
  ["if (a === null || (a === undefined", "if (false || (a === undefined", R1],
  ["if (a === null || (a === undefined", "if (a === null) refuse(\"rpc_disagree\", \"null\");\n            if (false || (a === undefined", R1],
  ["for (let t = 0; t < INDEX_TRIES && of.length > 0; t++) {", "for (let t = 0; t < 1 && of.length > 0; t++) {", R1],
  ["if (t > 0) await nap(BACKOFF_MS * 2 ** t);", "", R1],
  ["for (const p of of) unread.add(p.id);", "", R1],
  ["for (const p of of) unread.add(p.id);", "", Q3],
  ["const INDEX_RECEIPT_BATCH = 10;", "const INDEX_RECEIPT_BATCH = 500;", R2],
  ["if (typeof a !== \"object\" || Array.isArray(a)) return void unread.add(p.id);", "if (a === undefined) return void unread.add(p.id);", R3],
  // review 4 of 43f8e45f: no receipt budget, or one past the honest reader's means; the pools past it kept (unasked, so
  // never checked), or the liar not named; a rate limit inside a receipt batch unread at once
  ["const INDEX_RECEIPT_BUDGET = INDEX_STATE_BATCH;", "const INDEX_RECEIPT_BUDGET = 1_000_000;", S1],
  ["for (const p of of.slice(budget)) unread.add(p.id);", "", S1],
  ["if (over > 0) spent ??=", "if (false) spent ??=", S1],
  ["if (spent !== null) error = spent;", "", S1],
  ["if (t === 0) never = Math.max(0, of.length - budget);", "", S1],
  ["(a === undefined && limited(e?.error))", "false", S2],
  // F5 (review): a failed batch not asked one span a request; a span alone that fails not asked as halves
  ["else j.alone[r] = true;", "else j.ans[r] = NO_ANSWER;", ALONE],
  ["for (const j of g) if (j.alone[r]) j.ans[r] = NO_ANSWER;", "for (const j of g) if (j.alone[r]) throw new EvmQuoteError(\"rpc_error\", \"alone\");", ALONE],
];

// a child test run must not inherit this process's own node --test context (run as a test, test/mutants/
// evm-pool-mutants.test.mjs, the child reports to the parent's runner and prints no "# pass N": every mutant "names no
// test", CI run 42527434981), as evm-pool-buy-mutants.mjs and evm-pool-sell-mutants.mjs clear it
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const RUN_MS = 120_000;
function run(name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, TEST];
  const r = runSync("node", args, { stdio: "pipe", encoding: "utf8", env: CHILD_ENV, timeoutMs: RUN_MS });
  if (r.status !== 0) return "fail";
  return /^# pass ([1-9]\d*)$/m.test(r.stdout) ? "pass" : "none";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = readFileSync(SRC, "utf8");
  let bad = 0;
  for (const t of new Set(MUTANTS.map((m) => m[2]))) {
    const r = run(t);
    if (r !== "pass") {
      console.log(`FAIL "${t}" ${r === "none" ? "names no test" : "fails on the code as it is"}`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  MUTANTS.forEach(([find, repl, t], i) => {
    if (src.split(find).length !== 2) {
      console.log(`FAIL mutant ${i + 1}: its text is not in pool-index.ts exactly once`);
      bad++;
      return;
    }
    writeFileSync(SRC, src.replace(find, repl));
    let r;
    try {
      r = run(t);
    } finally {
      writeFileSync(SRC, src);
    }
    if (readFileSync(SRC, "utf8") !== src) throw new Error(`mutant ${i + 1} left pool-index.ts changed`);
    console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
    if (r !== "fail") bad++;
  });
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
