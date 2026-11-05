// Every test mocks and resets timers through its package's test/mock-timers.ts (card evm-quote-l5b-flake): node:test's
// timers reset leaves each timer it drops its place in the mocked clock's queue, and a late clear of one took a later
// test's live timer with it (L5b, L2 and LOW-1 parked to their last tick in CI). This refuses a direct
// timers.enable( or timers.reset( in any test of any package or app, and a copy of the helper that differs.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { enableTimers, resetTimers } from "./mock-timers.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HELPERS = ["packages/kit/test/mock-timers.ts", "packages/signpage/test/mock-timers.ts", "apps/helper/test/mock-timers.ts"];
const DIRECT = /\.timers\s*\.\s*(enable|reset)\s*\(/;

/** The lines of `text` that mock or reset timers directly, not through the helper. */
export function direct(text) {
  return text.split("\n").filter((l) => DIRECT.test(l));
}

/** Every source and test file of the packages and apps (no installed modules, no build output). */
function files(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist" || e.name === "target") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("mock timers: a direct enable or reset is refused, the helper's calls pass (planted)", () => {
  const t = "timers";
  assert.deepEqual(direct(`  mock.${t}.reset();`), [`  mock.${t}.reset();`]);
  assert.deepEqual(direct(`  t.mock.${t}.enable({ apis: ["setTimeout"] });`).length, 1);
  assert.deepEqual(direct(`t.after(() => t.mock.${t} . reset ())`).length, 1);
  assert.deepEqual(direct(`  enableTimers(mock.${t}, { apis: ["setTimeout"] });\n  t.after(() => resetTimers(mock.${t}));\n  mock.${t}.tick(5);`), []);
});

test("mock timers: no test in any package or app enables or resets timers but through its package's helper", () => {
  const scanned = ["packages", "apps"].flatMap((d) => files(join(ROOT, d))).filter((p) => !HELPERS.includes(relative(ROOT, p)));
  assert.ok(scanned.length > 100, `${scanned.length} files read`);
  const found = scanned.flatMap((p) => direct(readFileSync(p, "utf8")).map((l) => `${relative(ROOT, p)}: ${l.trim()}`));
  assert.deepEqual(found, [], "use enableTimers and resetTimers from the package's test/mock-timers.ts");
});

test("mock timers: each package's helper is the same file", () => {
  const [kit, ...rest] = HELPERS.map((p) => readFileSync(join(ROOT, p), "utf8"));
  for (const [k, text] of rest.entries()) assert.equal(text, kit, `${HELPERS[k + 1]} differs from ${HELPERS[0]}`);
});

test("mock timers: a timer left set at a reset, cleared once timers are mocked again, never takes the new live timer with it", () => {
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  const left = setTimeout(() => undefined, 60_000);
  resetTimers(mock.timers);
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    let fired = false;
    setTimeout(() => (fired = true), 500);
    clearTimeout(left);
    mock.timers.tick(500);
    assert.equal(fired, true, "the live timer was taken out by the late clear of one dropped at the reset");
  } finally {
    resetTimers(mock.timers);
  }
});
