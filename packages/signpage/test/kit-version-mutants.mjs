// Weakens what the page sends a kit-v1.4 client (card kit-frame-version: src/kit-version.ts and its use in src/api.ts),
// one mutant at a time, and runs test/kit-version.test.ts on each: it passes on the code as it is and fails on every
// mutant. Each later deposit stage's mapping is mutated to every other kit-v1.4 stage, so a mapping that tells an older
// app another place for its money (a refund move read as done, a failed deposit read as held) is caught. A mutant is
// written to a copy of src/api.ts and src/kit-version.ts in packages/.kit-version-mutant-<pid>/src/ (the same depth, so
// their ../../kit/src imports resolve), run by a copy of the test and its kit-v1.4 and kit-v1.7 fixtures beside it, all removed after,
// so the sources are never changed and a test run beside the sweep never reads a mutant. Exits 1 when the test fails on
// the code as it is, passes on a mutant, or a mutant's text is not in its file exactly once.
// test/kit-version-mutants.test.mjs runs it in the package's test:mutants.
//   node packages/signpage/test/kit-version-mutants.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const COPY = fileURLToPath(new URL(`../../.kit-version-mutant-${process.pid}/`, import.meta.url));
const FILES = { api: "src/api.ts", kit: "src/kit-version.ts" };
const TEST = "test/kit-version.test.ts";

const V1_4 = ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted"];
const MAPPED = { failed: "in_transit", short: "in_transit", expired: "quote_checked", refund_move: "refunded" };

// [file, text, replacement]
export const MUTANTS = [
  // every later deposit stage, mapped to each other stage kit-v1.4 has
  ...Object.entries(MAPPED).flatMap(([from, to]) =>
    V1_4.filter((s) => s !== to).map((s) => ["kit", `  ${from}: "${to}",`, `  ${from}: "${s}",`]),
  ),
  // an old stage moved
  ["kit", '  refunded: "refunded",', '  refunded: "done",'],
  ["kit", '  halted: "halted",', '  halted: "held",'],
  // a client with no hello read as current, and a version before 1.5 read as current
  ["kit", 'export const KIT_DEFAULT: KitLevel = "1.4";', 'export const KIT_DEFAULT: KitLevel = "current";'],
  ["kit", 'const CURRENT_FROM = SIGNPAGE_KIT_VERSION.split(".").map(Number) as [number, number];', "const CURRENT_FROM = [1, 4] as [number, number];"],
  ["kit", 'const CURRENT_FROM = SIGNPAGE_KIT_VERSION.split(".").map(Number) as [number, number];', "const CURRENT_FROM = [1, 7] as [number, number];"],
  ["kit", 'const CURRENT_FROM = SIGNPAGE_KIT_VERSION.split(".").map(Number) as [number, number];', "const CURRENT_FROM = [1, 9] as [number, number];"],
  // a refund's later leg read as a new deposit's, or a landed refund read as still moving
  ["kit", 'return d.refunded === true && (stage === "in_transit" || stage === "into_vault") ? "refunded" : stage;', "return stage;"],
  ["kit", 'return d.refunded === true && (stage === "in_transit" || stage === "into_vault") ? "refunded" : stage;', 'return d.refunded === true && stage === "in_transit" ? "refunded" : stage;'],
  ["kit", 'return d.refunded === true && (stage === "in_transit" || stage === "into_vault") ? "refunded" : stage;', 'return d.refunded === true ? "refunded" : stage;'],
  // a new document sent events before its own first answer
  ["api", "      sent = null;\n", ""],
  ["kit", "(major === m && minor >= n)", "(major === m && minor > n)"],
  ["kit", 'if (!v) return KIT_DEFAULT;', 'if (!v) return "current";'],
  // the hello's exact shape
  ["kit", "keys.length !== 3 || ", ""],
  ["kit", 'h.v !== 1 || ', ""],
  // pools, deposit_wallets or a deposit's facts kept
  ["kit", "  if (level === \"current\") return given;\n", "  if (level === \"current\" || given.pools === undefined) return given;\n"],
  ["kit", '"orders", "held", "ops"]);', '"orders", "held", "ops", "pools"]);'],
  ["kit", '"orders", "held", "ops"]);', '"orders", "held", "ops", "deposit_wallets"]);'],
  ["kit", 'out[k] = k === "ops" ? s.ops.map(opV1_4).filter((o) => o !== null) : s[k as keyof SignpageState];', "out[k] = s[k as keyof SignpageState];"],
  ['kit', 'if (V1_4_STATE_KEYS.has(k)) out[k]', 'if (k !== "pools") out[k]'],
  ["kit", 'return stage === null ? null : { id: op.id, kind: "deposit", stage, txs: op.txs };', "return stage === null ? null : { ...op, stage };"],
  ["kit", "return stage === null ? result : { stage };", "return stage === null ? result : { ...(result as object), stage };"],
  // an op it cannot read sent anyway
  ["kit", "!V1_4_OP_STAGES[op.kind].includes(op.stage)) return null;", "false) return null;"],
  // a progress stage not mapped, a route event sent
  ["kit", "  return own(V1_4_DEPOSIT_STAGE, stage) ? V1_4_DEPOSIT_STAGE[stage as DepositStage] : null;", "  return stage;"],
  ["api", 'if (!("stage" in msg)) return level !== "1.4" ? msg : null;', 'if (!("stage" in msg)) return msg;'],
  ["api", 'if (!("stage" in msg)) return level !== "1.4" ? msg : null;', 'if (!("stage" in msg)) return level === "current" ? msg : null;'],
  // card held-move-forgotten-tx: kit-v1.5 sent moved_out (which it refuses the whole state for), or read at another level
  ["kit", 'from(1, 5) ? "1.5" : KIT_DEFAULT', 'from(1, 5) ? "current" : KIT_DEFAULT'],
  ["kit", 'from(1, 5) ? "1.5" : KIT_DEFAULT', 'from(1, 4) ? "1.5" : KIT_DEFAULT'],
  ["kit", 'from(1, 5) ? "1.5" : KIT_DEFAULT', 'from(1, 6) ? "1.5" : KIT_DEFAULT'],
  ["kit", "  return rest as T;\n", "  return d;\n"],
  ["kit", "const { moved_out: _m, held_id: _h, ...rest }", "const { moved_out: _m, ...rest }"],
  ["kit", '  if (level === "1.5") return { ...s, ops: noPoolOps(s.ops).map((o) => (o.kind === "deposit" ? factsV1_5(o) : o)) };\n', '  if (level === "1.5") return s;\n'],
  ["kit", '  if (level === "1.5") return { ...s, ops: noPoolOps(s.ops).map((o) => (o.kind === "deposit" ? factsV1_5(o) : o)) };\n', ""],
  // card pool-deposit-stages: a pool_deposit op sent to kit-v1.6 or kit-v1.5, which have no kind for it, or kit-v1.6 read
  // at another level
  ["kit", '  if (level === "1.5") return { ...s, ops: noPoolOps(s.ops).map(', '  if (level === "1.5") return { ...s, ops: s.ops.map('],
  ["kit", '  if (level === "1.6") return { ...s, ops: noPoolOps(s.ops) };\n', '  if (level === "1.6") return s;\n'],
  ["kit", '  if (level === "1.6") return { ...s, ops: noPoolOps(s.ops) };\n', ""],
  ["kit", 'ops.filter((o) => o.kind !== "pool_deposit")', "[...ops]"],
  ["kit", 'from(1, 6) ? "1.6" : ', ""],
  ["kit", 'from(1, 6) ? "1.6" : ', 'from(1, 6) ? "current" : '],
  ["kit", 'from(1, 6) ? "1.6" : ', 'from(1, 5) ? "1.6" : '],
  ["kit", '  if (level === "1.6") return kind === "state" ? stateFor(level, result as SignpageState) : result;\n', ""],
  ["kit", '  if (level === "1.6") return kind === "state" ? stateFor(level, result as SignpageState) : result;\n', '  if (level === "1.6") return result;\n'],
  // card signpage-state-holdings: a position's decimals sent to kit-v1.7 or below, whose schema refuses the key, or
  // kit-v1.7 read at another level
  ["kit", "  const s = noDecimals(given);\n", "  const s = given;\n"],
  ["kit", "positions: s.positions.map(({ decimals: _d, ...p }) => p)", "positions: s.positions"],
  ["kit", '  if (level === "1.7") return s;\n', '  if (level === "1.7") return given;\n'],
  ["kit", '  if (level === "1.7") return s;\n', ""],
  ["kit", 'from(1, 7) ? "1.7" : ', ""],
  ["kit", 'from(1, 7) ? "1.7" : ', 'from(1, 7) ? "current" : '],
  ["kit", 'from(1, 7) ? "1.7" : ', 'from(1, 6) ? "1.7" : '],
  ["kit", '  if (level === "1.7") return kind === "state" ? stateFor(level, result as SignpageState) : result;\n', '  if (level === "1.7") return result;\n'],
  // review of edc6815f: kit-v1.7's answers through no level of its own (the kit-v1.4 path, every deposit fact lost)
  ["kit", '  if (level === "1.7") return kind === "state" ? stateFor(level, result as SignpageState) : result;\n', ""],
  ["kit", 'kind === "deposit.confirm" && typeof result === "object" && result !== null ? factsV1_5(result) : result;', 'result;'],
  ["kit", 'kind === "state" ? stateFor(level, result as SignpageState) : kind === "deposit.confirm"', 'kind === "deposit.confirm"'],
  ["kit", 'if (level !== "1.4" || V1_4_STAGES.has(stage)) return stage;', 'if (level === "current" || V1_4_STAGES.has(stage)) return stage;'],
  // the level not read, not reset on a ready, an answer's kind not passed, a replay not shaped
  ["api", "if (kit !== null) return void (level = kitLevel(kit));", "if (kit !== null) return;"],
  ["api", "      level = KIT_DEFAULT;\n", ""],
  ["api", "    post(answer, kind);", "    post(answer);"],
  ["api", "first.answer ? post(first.answer, first.kind)", "first.answer ? post(first.answer)"],
  ["api", "    sent = JSON.stringify(stateFor(level, s));", "    sent = JSON.stringify(s);"],
];

// a child test run must not inherit this process's own node --test context
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
// a run past 5 min is killed, its process group with it, and counts as a fail (scripts/group-run.mjs)
const RUN_MS = 300_000;
/** "pass", "fail" or "none" (no test ran) of the test file at `root`. */
const run = (root) => {
  const r = runSync(process.execPath, ["--test", "--test-timeout=60000", `${root}${TEST}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, timeoutMs: RUN_MS });
  if (r.status !== 0) return "fail";
  return /ℹ pass [1-9]/.test(r.stdout) ? "pass" : "none";
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const original = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readFileSync(`${PKG}${f}`, "utf8")]));
  process.on("exit", () => rmSync(COPY, { recursive: true, force: true }));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  mkdirSync(`${COPY}src`, { recursive: true });
  mkdirSync(`${COPY}test/fixtures`, { recursive: true });
  cpSync(`${PKG}${TEST}`, `${COPY}${TEST}`);
  cpSync(`${PKG}test/fixtures/kit-v1.4`, `${COPY}test/fixtures/kit-v1.4`, { recursive: true });
  cpSync(`${PKG}test/fixtures/kit-v1.7`, `${COPY}test/fixtures/kit-v1.7`, { recursive: true });
  // the kit-v1.7 fixture's schema imports @scure/base: the copy resolves packages the way the package does (a link, which
  // the removal after drops without following)
  symlinkSync(`${PKG}node_modules`, `${COPY}node_modules`, "dir");
  const write = (mut) => {
    for (const [k, f] of Object.entries(FILES)) writeFileSync(`${COPY}${f}`, mut?.[0] === k ? original[k].replace(mut[1], () => mut[2]) : original[k]);
  };
  let bad = 0;
  write(null);
  const asIs = run(COPY);
  if (asIs !== "pass") {
    console.log(`BAD  kit-version.test.ts ${asIs === "none" ? "runs nothing" : "fails on the code as it is"}`);
    process.exit(1);
  }
  for (const mut of MUTANTS) {
    const [k, text] = mut;
    const n = original[k].split(text).length - 1;
    if (n !== 1) {
      console.log(`BAD  mutant text ${n} times in ${FILES[k]}, not once: ${text}`);
      bad++;
      continue;
    }
    write(mut);
    const r = run(COPY);
    if (r !== "fail") {
      console.log(`LIVE kit-version.test.ts ${r === "pass" ? "passes" : "runs nothing"} with ${FILES[k]}: ${text} -> ${mut[2]}`);
      bad++;
    } else console.log(`killed  ${FILES[k]}: ${text.trim()} -> ${mut[2].trim()}`);
  }
  for (const [k, f] of Object.entries(FILES)) if (readFileSync(`${PKG}${f}`, "utf8") !== original[k]) throw new Error(`${f} changed under the sweep`);
  console.log(bad === 0 ? `all ${MUTANTS.length} mutants killed` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
