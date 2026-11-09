// The provider-answer gate (live-checks-provider-answer.mjs) on planted files: a live check that builds a JSON-RPC
// request outside the shared module is refused in every quoting, a comment or a test is not, NOT_MOVED only shrinks,
// and the repo's own tree passes.
//   node --test scripts/ci/live-checks-provider-answer.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildsRpc, NOT_MOVED, refusalsOf } from "./live-checks-provider-answer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/live-checks-provider-answer.mjs");
const F = "scripts/live-checks/planted.mjs";

// each one builds a JSON-RPC request or answer in code
const BUILDS = [
  `body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })`,
  `const b = { "jsonrpc": "2.0", id: 1 };`,
  `const b = { 'jsonrpc': '2.0' };`,
  "const b = `{\"jsonrpc\":\"2.0\",\"id\":1}`;",
  `body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`,
  `body: "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1}"`,
  `const b = {jsonrpc:"2.0"};`,
  `fetch("https://rpc.example", { body: JSON.stringify({ jsonrpc: "2.0" }) })`,
];
// none of these builds one
const NOT = [
  `// body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })`,
  `/* {"jsonrpc":"2.0","error":{"message":"rate limit"}} */`,
  ` * dRPC answer, HTTP 429: {"id":187,"jsonrpc":"2.0"}`.replace(/^/, "/**\n").concat("\n */"),
  `const a = await rpcAnswer(url, "eth_call", params);`,
  `const v = "jsonrpc 2.0 answers";`,
];

test("a JSON-RPC request or answer in code is found in every quoting; in a comment or in words it is not", () => {
  for (const s of BUILDS) assert.equal(buildsRpc(s), true, s);
  for (const s of NOT) assert.equal(buildsRpc(s), false, s);
});

test("planted: a check that builds its own request is refused; one on the shared module passes; tests and the module are not read", () => {
  const read = (m) => (f) => m[f];
  for (const s of BUILDS) {
    const r = refusalsOf([F], read({ [F]: s }), []);
    assert.equal(r.length, 1, s);
    assert.match(r[0], /builds a JSON-RPC request outside provider-answer\.mjs/);
  }
  assert.deepEqual(refusalsOf([F], read({ [F]: `import { rpcAnswer } from "./provider-answer.mjs";\nawait rpcAnswer(u, "eth_chainId", []);` }), []), []);
  // both: imports the module and still builds its own
  const both = refusalsOf([F], read({ [F]: `import { rpcAnswer } from "./provider-answer.mjs";\nconst b = { jsonrpc: "2.0" };` }), [F]);
  assert.equal(both.length, 1);
  assert.match(both[0], /imports provider-answer\.mjs and builds a JSON-RPC request itself too/);
  // tests, the shared module and its plants, and files outside scripts/live-checks/*.mjs are not this gate's
  const files = ["scripts/live-checks/x.test.mjs", "scripts/live-checks/provider-answer.mjs", "scripts/live-checks/provider-answer.plants.mjs", "scripts/ci/x.mjs", "scripts/live-checks/sub/x.mjs"];
  assert.deepEqual(refusalsOf(files, () => BUILDS[0], []), []);
});

test("planted: NOT_MOVED only shrinks: a listed check that builds none, or is gone, is refused", () => {
  assert.deepEqual(refusalsOf([F], () => BUILDS[0], [F]), [], "listed and builds one: allowed until moved");
  const moved = refusalsOf([F], () => `await rpcAnswer(u, "m", []);`, [F]);
  assert.equal(moved.length, 1);
  assert.match(moved[0], /NOT_MOVED names it but it builds no JSON-RPC request/);
  const gone = refusalsOf([], () => "", [F]);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /NOT_MOVED names a file that is not there/);
});

test("the moved checks are off NOT_MOVED and on the shared module", () => {
  for (const f of ["evm-buy-gas-depth.mjs", "evm-buy-hookdata-fee.mjs", "evm-quote-read-gas-starve.mjs"]) assert.equal(NOT_MOVED.includes(`scripts/live-checks/${f}`), false, f);
});

test("the gate's own run: a planted tree exits 1 naming the file; the repo's tree exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcpa-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "scripts/live-checks"), { recursive: true });
    // every NOT_MOVED file there and building one, so only the planted file is refused
    for (const f of NOT_MOVED) writeFileSync(join(dir, f), `const b = { jsonrpc: "2.0" };\n`);
    writeFileSync(join(dir, F), `export const b = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });\n`);
    const bad = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /REFUSED: scripts\/live-checks\/planted\.mjs: builds a JSON-RPC request outside provider-answer\.mjs/);
    writeFileSync(join(dir, F), `import { rpcAnswer } from "./provider-answer.mjs";\nexport const a = () => rpcAnswer("https://x", "eth_chainId", []);\n`);
    const good = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const repo = spawnSync(process.execPath, [GATE, ROOT], { encoding: "utf8" });
  assert.equal(repo.status, 0, repo.stdout + repo.stderr);
  assert.match(repo.stdout, /^live-checks-provider-answer: OK/);
});
