// Weakens src/pool-price.ts's retry of a failed read (card signpage-price-read-retry), one mutant at a time, and runs
// test/pool-price.test.ts's "retry" test on each: it passes on the code as it is and fails on every mutant. A mutant is
// written to a copy beside pool-price.ts (src/.pool-price-mutant-<pid>.ts) and run by a copy of the test file that
// imports it, both removed after, so pool-price.ts itself is never changed and a test run beside the sweep never reads a
// mutant (as test/rules-pool-mutants.mjs does for src/rules/pool.ts). Exits 1 when the test fails or runs nothing on
// the code as it is, passes on a mutant, or a mutant's text is not in pool-price.ts exactly once.
// test/pool-price-mutants.test.mjs runs it in the package's tests.
//   node packages/signpage/test/pool-price-mutants.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/pool-price.ts", import.meta.url));
const TEST = fileURLToPath(new URL("./pool-price.test.ts", import.meta.url));
const MUTANT_SRC = fileURLToPath(new URL(`../src/.pool-price-mutant-${process.pid}.ts`, import.meta.url));
const MUTANT_TEST = fileURLToPath(new URL(`./.pool-price-mutant-${process.pid}.test.ts`, import.meta.url));
const IMPORT = 'from "../src/pool-price.ts";';
const NAME = "retry";

// [text, replacement]
export const MUTANTS = [
  ["export const POOL_PRICE_RETRY_MS = 1_000;", "export const POOL_PRICE_RETRY_MS = 15_000;"],
  ["if (p.chain !== chain || p.price <= 0n) return false;", "if (p.chain !== chain || p.price <= 0n) return true;"],
  [".catch(() => false)", ".catch(() => true)"],
  ["if (ok) failed.delete(chain);", "if (ok) {}"],
  ["waitMs = Math.min(POOL_PRICE_RETRY_MS * 2 ** (n - 1), POOL_PRICE_REFRESH_MS);", "waitMs = POOL_PRICE_RETRY_MS;"],
  ["waitMs = Math.min(POOL_PRICE_RETRY_MS * 2 ** (n - 1), POOL_PRICE_REFRESH_MS);", "waitMs = POOL_PRICE_RETRY_MS * 2 ** (n - 1);"],
  ["due.set(chain, now() + waitMs);", ""],
  ["after(waitMs, tell);", "after(POOL_PRICE_REFRESH_MS, tell);"],
  ["if (at !== undefined && now() < at) continue;", "if (false) continue;"],
];

// a child test run must not inherit this process's own node --test context
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
/** "pass", "fail" or "none" (no test ran) of the tests named NAME in `file`. */
const run = (file) => {
  try {
    const out = execFileSync(process.execPath, ["--test", "--test-timeout=60000", "--test-name-pattern", `^${NAME}`, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV });
    return /ℹ pass [1-9]/.test(out) ? "pass" : "none";
  } catch {
    return "fail";
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const original = readFileSync(SRC, "utf8");
  const test = readFileSync(TEST, "utf8");
  if (test.split(IMPORT).length !== 2) {
    console.log("BAD  pool-price.test.ts imports pool-price.ts not once");
    process.exit(1);
  }
  process.on("exit", () => {
    rmSync(MUTANT_TEST, { force: true });
    rmSync(MUTANT_SRC, { force: true });
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  writeFileSync(MUTANT_TEST, test.replace(IMPORT, `from "../src/.pool-price-mutant-${process.pid}.ts";`));
  let bad = 0;
  const asIs = run(TEST);
  if (asIs !== "pass") {
    console.log(`BAD  "${NAME}" ${asIs === "none" ? "names no test" : "fails on the code as it is"}`);
    process.exit(1);
  }
  for (const [text, repl] of MUTANTS) {
    const n = original.split(text).length - 1;
    if (n !== 1) {
      console.log(`BAD  mutant text ${n} times in pool-price.ts, not once: ${text}`);
      bad++;
      continue;
    }
    writeFileSync(MUTANT_SRC, original.replace(text, () => repl));
    try {
      const r = run(MUTANT_TEST);
      if (r !== "fail") {
        console.log(`LIVE "${NAME}" ${r === "pass" ? "passes" : "runs nothing"} with: ${text}`);
        bad++;
      } else console.log(`killed  ${text}`);
    } finally {
      rmSync(MUTANT_SRC, { force: true });
    }
  }
  if (readFileSync(SRC, "utf8") !== original) throw new Error("pool-price.ts changed under the sweep");
  console.log(bad === 0 ? `all ${MUTANTS.length} mutants killed` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
