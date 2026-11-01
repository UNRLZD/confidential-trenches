// node --test packages/kit/test/poseidon-imports.test.mjs: no kit source imports poseidon-lite's root.
// The root (index.js) loads all 16 arities and their constants; the kit uses poseidon1, 2 and 3 only. Through the
// public entry (prove.ts and inputs.ts) the root grew the terminal's main script from 338 kB to 946 kB (111 kB to
// 550 kB gzip). Each arity is its own subpath, poseidon-lite/poseidonN (its package.json exports), and is imported so.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(m?[jt]s|tsx?)$/.test(e.name) ? [join(dir, e.name)] : []));
// any import, export-from, dynamic import or require of the bare package name
const ROOT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']poseidon-lite["']/;

test("the rule sees a root import in every form it can take", () => {
  for (const s of [`import { poseidon2 } from "poseidon-lite";`, `export { poseidon1 } from 'poseidon-lite'`, `await import("poseidon-lite")`, `require("poseidon-lite")`, `import "poseidon-lite";`])
    assert.ok(ROOT.test(s), s);
  for (const s of [`import { poseidon2 } from "poseidon-lite/poseidon2";`, `require("poseidon-lite/poseidon1")`]) assert.ok(!ROOT.test(s), s);
});

test("no kit source imports poseidon-lite's root: each arity comes from its own subpath", () => {
  const all = files(SRC);
  assert.ok(all.length > 10, "the kit's sources were read");
  const hits = all.filter((f) => ROOT.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length + 1));
  assert.deepEqual(hits, []);
});
