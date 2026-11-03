// Card ci-test-shards: the share of apps/terminal's test:e2e that one part of ci.yml's test-browser matrix runs.
//   node scripts/ci/test-shards.mjs e2e <index> <total>    (prints the part's command; exit 1 and the reason otherwise)
//
// test:e2e is one chain, `a && b && c ...`: its first command (the build) runs in every part, and each later command
// in exactly one, command i in part (i - 1) % total. ci.yml passes the job's own strategy.job-index and
// strategy.job-total, so every command runs in some part whatever the matrix lists. A chain this cannot split into
// commands that stand alone (||, ;, a pipe, a newline) is refused rather than split wrong, and so is a part left
// with nothing but the build.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function e2ePart(script, index, total) {
  if (typeof script !== "string" || !script.trim()) throw new Error("apps/terminal has no test:e2e script");
  if (!Number.isInteger(total) || total < 1) throw new Error(`total ${total} is not a count of parts`);
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error(`index ${index} is not a part of ${total}`);
  if (/[|;&\n`]|\$\(/.test(script.replaceAll("&&", ""))) {
    throw new Error(`test:e2e is not a plain a && b chain: ${script}`);
  }
  const [build, ...runs] = script.split("&&").map((c) => c.trim());
  if ([build, ...runs].some((c) => !c)) throw new Error(`test:e2e has an empty command: ${script}`);
  if (runs.length < total) throw new Error(`test:e2e has ${runs.length} command(s) after the build, fewer than ${total} parts`);
  return [build, ...runs.filter((_, i) => i % total === index)].join(" && ");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [what, index, total] = process.argv.slice(2);
  try {
    if (what !== "e2e") throw new Error("usage: node scripts/ci/test-shards.mjs e2e <index> <total>");
    const script = JSON.parse(readFileSync(path.join(ROOT, "apps/terminal/package.json"), "utf8")).scripts?.["test:e2e"];
    const int = (s) => (/^\d+$/.test(s ?? "") ? Number(s) : NaN);
    console.log(e2ePart(script, int(index), int(total)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
