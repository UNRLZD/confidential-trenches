// node --test scripts/ci/devnet-pin-today.test.mjs: every listed live check that reads the devnet pin is judged on today's
// pin, in its live run and its replay alike (card pool-senders-next-page, the delta review's MEDIUM 1). Planted: a check
// that hands devnetPin its recording's record, one that takes devnetPin() as a parameter's default, an answers file with
// a good recording on the old pool 2S5wpE7U (at the top and nested), a run file on it: each refused. A clean check, a
// file that names devnetPin only in a comment or not at all, and a bad answer on the old pool (it only has to FAIL):
// passed. The repo: the listed checks that read the pin are the
// five named here, and none has a problem.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devnetPin } from "../live-checks/pool-sol-deploy.mjs";
import { pinProblems, readListed } from "./devnet-pin-today.mjs";

const NOW = devnetPin();
const OLD = { program_id: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr" };
const TODAY = { program_id: NOW.program, pool: NOW.pool };
const CLEAN = `import { devnetPin } from "./pool-sol-deploy.mjs";\nexport function judge(a) {\n  const pin = devnetPin();\n  return pin.pool;\n}\n`;
const tree = (files) => (f) => files[f] ?? null;

test("a clean check, with its recordings and run on today's pool: no problem", () => {
  const files = { "c.mjs": CLEAN, "c.answers.json": JSON.stringify({ good: { deployment: TODAY }, bad: { deployment: TODAY } }), "c.run.json": JSON.stringify({ program: NOW.program, pool: NOW.pool }) };
  assert.deepEqual(pinProblems(["c"], tree(files)), []);
});

test("planted: a check that hands devnetPin its recording's record, or takes devnetPin() as a default: refused", () => {
  for (const line of ["  const pin = devnetPin(a.deployment ?? null);", "  const pin = devnetPin(deployment);", "export function check({ deployment = devnetPin().record } = {}) {", "export async function read(base, fetchFn = fetch, pin = devnetPin()) {"]) {
    const p = pinProblems(["c"], tree({ "c.mjs": `${CLEAN}${line}\n` }));
    assert.equal(p.length, 1, `${line}: ${p.join("\n")}`);
    assert.match(p[0], /^scripts\/live-checks\/c\.mjs:6 /);
  }
});

test("planted: a recording on the old pool 2S5wpE7U, at the top or nested, and a run file on it: refused", () => {
  const top = pinProblems(["c"], tree({ "c.mjs": CLEAN, "c.answers.json": JSON.stringify({ good: { deployment: OLD } }) }));
  assert.equal(top.length, 1, top.join("\n"));
  assert.ok(top[0].includes("$.good.deployment is on program 5V9iJECf") && top[0].includes(OLD.pool), top[0]);
  const nested = pinProblems(["c"], tree({ "c.mjs": CLEAN, "c.answers.json": JSON.stringify({ good: { deployment: TODAY }, good_runs: { runs: [{ deployment: { ...TODAY, pool: OLD.pool } }] } }) }));
  assert.equal(nested.length, 1, nested.join("\n"));
  assert.match(nested[0], /\$\.good_runs\.runs\[0\]\.deployment/);
  // a bad answer only has to FAIL: its record is not read here
  assert.deepEqual(pinProblems(["c"], tree({ "c.mjs": CLEAN, "c.answers.json": JSON.stringify({ good: { deployment: TODAY }, bad_old: { deployment: OLD } }) })), []);
  const run = pinProblems(["c"], tree({ "c.mjs": CLEAN, "c.run.json": JSON.stringify({ program: OLD.program_id, pool: OLD.pool }) }));
  assert.equal(run.length, 1, run.join("\n"));
  assert.match(run[0], /c\.run\.json is on program 5V9iJECf/);
  // no deploy record at all is not today's either
  assert.equal(pinProblems(["c"], tree({ "c.mjs": CLEAN, "c.answers.json": JSON.stringify({ good: { deployment: null } }) })).length, 1);
});

test("a check that names devnetPin only in a comment, or not at all, is not read", () => {
  const comment = `// a replay once passed devnetPin(rec.deployment)\nexport const x = 1;\n`;
  assert.deepEqual(pinProblems(["c", "d"], tree({ "c.mjs": `${CLEAN}${comment}`, "d.mjs": "export const y = 2;\n", "d.answers.json": JSON.stringify({ good: { deployment: OLD } }) })), []);
});

test("the repo: the listed checks that read the devnet pin are these five, each judged on today's pin, each recording on today's pool", () => {
  const { keys, read } = readListed();
  const reading = keys.filter((k) => /\bdevnetPin\b/.test(read(`${k}.mjs`) ?? "")).sort();
  assert.deepEqual(reading, ["pool-buy-send-fast", "pool-deposits", "signpage-pool-flow", "signpage-pool-notes", "signpage-pool-withdraw-form"]);
  assert.deepEqual(pinProblems(keys, read), []);
});
