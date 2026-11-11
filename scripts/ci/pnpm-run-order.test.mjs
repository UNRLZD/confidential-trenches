// Card ci-fresh-run-ends-with-room: the packages' tests run side by side, never one after the package it imports.
//   node --test scripts/ci/pnpm-run-order.test.mjs
// pnpm -r runs a package only after the workspace packages it depends on have finished (kit, then the wallet, then the
// signing page: 3 stages on the README's `pnpm -r --if-present --no-bail run test`, with one stage alone for minutes on a
// 4-core runner). pnpm-workspace.yaml's `sort: false` runs them in name order, up to the job's concurrency, whatever imports
// what. That is safe because no package's tests need another package's tests (or a build of it) run first: the kit's
// exports are its .ts sources and every build output a test reads is made by that test (signBuilt). This test runs a
// recursive command that records each package's start and end, and fails when the signing page waits for the wallet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("pnpm -r starts a package before the packages it imports have ended (pnpm-workspace.yaml sort: false)", () => {
  assert.match(readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8"), /^sort:\s*false\s*$/m);
  const out = execFileSync(
    "pnpm",
    ["-r", "--workspace-concurrency=16", "exec", "node", "-e", "const n=require('./package.json').name,t=()=>Date.now();const a=t();setTimeout(()=>console.log('RUN '+n+' '+a+' '+t()),700)"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const run = Object.fromEntries([...out.matchAll(/RUN (\S+) (\d+) (\d+)/g)].map((m) => [m[1], { start: +m[2], end: +m[3] }]));
  const sign = Object.keys(run).find((n) => n.endsWith("signpage"));
  const wallet = Object.keys(run).find((n) => n.endsWith("wallet"));
  assert.ok(sign && wallet, `both packages ran: ${Object.keys(run)}`);
  assert.ok(run[sign].start < run[wallet].end, "the signing page's run began before the wallet's ended: its stage does not wait for the wallet");
});
