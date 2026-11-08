#!/usr/bin/env node
// Every after-deploy live check that reads the devnet pin judges its replay on today's pin, as its live run does (card
// pool-senders-next-page, the delta review's MEDIUM 1). At 5059541a four SIGN_HOST checks FAILED live, since their
// recorded devnet runs were on the pool the branch un-pinned (program 5V9iJECf, pool 2S5wpE7U), while their replays
// passed: each replay handed the check its recording's own deploy record. A check in a host's list (scripts/ci/live-plan.mjs
// HOSTS, read as live.yml reads them) whose file names devnetPin (scripts/live-checks/pool-sol-deploy.mjs) passes only when:
//   - its file calls devnetPin() with no argument, and never as a parameter's default: no caller, a replay included, can
//     hand it another deploy record or pin;
//   - every `deployment` (at any depth) of each good answer in its <key>.answers.json (a top-level key that starts with
//     "good") names today's program and pool (devnetPin().program, devnetPin().pool); a bad answer only has to FAIL, which
//     the check's own test holds line by line, on today's pin;
//   - its <key>.run.json, when it has one, names today's program and pool.
//   node scripts/ci/devnet-pin-today.mjs      PASS exit 0; the problems and exit 1
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./live-plan.mjs";
import { readTree } from "./live-listed.mjs";
import { devnetPin } from "../live-checks/pool-sol-deploy.mjs";

const DIR = "scripts/live-checks";
/** A devnetPin call with an argument, or devnetPin() as a parameter's default (`x = devnetPin()` after `(` or `,`). */
const PIN_ARG = /\bdevnetPin\(\s*[^)\s]/;
const PIN_DEFAULT = /[(,{]\s*[A-Za-z_$][\w$]*\s*=\s*devnetPin\(/;

/** The `deployment` objects in `v`, at any depth, each with its JSON path. */
function deployments(v, at = "$", out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => deployments(x, `${at}[${i}]`, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "deployment") out.push([`${at}.deployment`, x]);
      deployments(x, `${at}.${k}`, out);
    }
  return out;
}

/**
 * The problems of the listed checks `keys` that read the devnet pin, against `pin` ({ program, pool }): `read(file)`
 * gives a file's text under DIR, or null when there is none. [] when each is judged on today's pin alone.
 */
export function pinProblems(keys, read, pin = devnetPin()) {
  const p = [];
  for (const key of [...keys].sort()) {
    const src = read(`${key}.mjs`);
    if (src === null || !/\bdevnetPin\b/.test(src)) continue;
    const file = `${DIR}/${key}.mjs`;
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (PIN_ARG.test(line)) p.push(`${file}:${i + 1} calls devnetPin with an argument: a replay could judge on another deploy record`);
      if (PIN_DEFAULT.test(line)) p.push(`${file}:${i + 1} takes devnetPin() as a parameter's default: a caller could pass another pin`);
    });
    const answers = read(`${key}.answers.json`);
    if (answers !== null)
      for (const [at, d] of Object.entries(JSON.parse(answers)).filter(([k]) => k.startsWith("good")).flatMap(([k, v]) => deployments(v, `$.${k}`)))
        if (d?.program_id !== pin.program || d?.pool !== pin.pool) p.push(`${DIR}/${key}.answers.json ${at} is on program ${d?.program_id ?? "none"}, pool ${d?.pool ?? "none"}, not today's devnet pin ${pin.program}, ${pin.pool}: record it again on today's pool`);
    const run = read(`${key}.run.json`);
    if (run !== null) {
      const r = JSON.parse(run);
      if (r.program !== pin.program || r.pool !== pin.pool) p.push(`${DIR}/${key}.run.json is on program ${r.program ?? "none"}, pool ${r.pool ?? "none"}, not today's devnet pin ${pin.program}, ${pin.pool}: run it again on today's pool`);
    }
  }
  return p;
}

/** The listed checks under `root` (every host's list) and a reader of DIR's files. */
export function readListed(root = ROOT) {
  const { listed } = readTree(root);
  const read = (f) => {
    const file = path.join(root, DIR, f);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  return { keys: [...listed.keys()], read };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { keys, read } = readListed();
  const p = pinProblems(keys, read);
  for (const l of p) console.log(l);
  console.log(p.length ? `FAIL devnet-pin-today: ${p.length}` : "PASS devnet-pin-today");
  process.exit(p.length ? 1 : 0);
}
