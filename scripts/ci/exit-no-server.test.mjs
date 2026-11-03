// The exit tool's no-server gate (exit-no-server.mjs) on planted trees: every address of ours but the mirror's, and every
// import of the helper's names from the kit, is refused by file and line; the repo's own packages/exit passes.
//   node --test scripts/ci/exit-no-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitNoServer, MIRROR } from "./exit-no-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/exit-no-server.mjs");
// (joined, so this file's own text names our domain only where it plants it)
const OURS = ["unrealized", "trade"].join(".");

const HELPER = { "packages/kit/src/helper/v1.ts": 'export const HELPER_V1_PREFIX = "/v1";\nexport type HelperWithdrawRequest = { a: 1 };\nexport function helperBase() {}\nconst x = 1;\nexport { x as HELPER_ALIAS };\n' };
const GOOD = {
  "packages/exit/package.json": '{ "name": "@blindfill/exit" }\n',
  "packages/exit/src/rpc.ts": 'import { vaultSync, type VaultSyncRpc } from "@blindfill/kit";\nexport const u = "https://test.rpc.fastnear.com";\nexport { vaultSync };\nexport type R = VaultSyncRpc;\n',
  "packages/exit/src/setup.ts": `export const M = "${MIRROR}";\nexport const u = (s: string) => \`${MIRROR}\${s}.zkey\`;\n`,
  "packages/exit/src/core.ts": 'import { thing } from "@blindfill/kit/core";\nexport const t = thing;\n',
  // the word "helper" alone, and a domain that only ends like ours, are not ours
  "packages/exit/src/notes.ts": '// no helper in the path\nexport const other = "https://example.trade/x";\n',
};

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "exit-no-server-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
function run(dir) {
  try {
    return { rc: 0, out: execFileSync(process.execPath, [GATE, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { rc: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test("the repo's own packages/exit passes", () => {
  const r = exitNoServer(ROOT);
  assert.deepEqual(r.refusals, []);
  assert.ok(r.read >= 4, `${r.read} files read`);
  // and the package does fetch the mirror, so the one allowed address is in use, not a dead rule
  assert.match(readFileSync(join(ROOT, "packages/exit/src/setup.ts"), "utf8"), new RegExp(MIRROR.replace(/[./]/g, "\\$&")));
});

test("a package with only public RPCs, the kit's non-helper names and the mirror passes", () => {
  const dir = tree({ ...HELPER, ...GOOD });
  try {
    const r = run(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^exit-no-server: OK \(5 file\(s\) under packages\/exit\/ read\)/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PLANTED = {
  "packages/exit/src/a1-helper-url.ts": [`export const H = "https://api.confidential.${OURS}/v1/relay";\n`, /a1-helper-url\.ts:1: our server's address/],
  "packages/exit/src/a2-app-url.ts": [`export const x = 1;\nexport const A = "https://confidential.${OURS}";\n`, /a2-app-url\.ts:2: our server's address/],
  "packages/exit/src/a3-comment.ts": [`// fall back to api.confidential.${OURS.toUpperCase()} if both RPCs fail\nexport const x = 1;\n`, /a3-comment\.ts:1: our server's address/],
  "packages/exit/src/a4-sign-not-mirror.ts": [`export const S = "https://sign.confidential.${OURS}/assets/";\n`, /a4-sign-not-mirror\.ts:1: our server's address/],
  "packages/exit/src/a5-mirror-on-http.ts": [`export const S = "http://sign.confidential.${OURS}/assets/zk/";\n`, /a5-mirror-on-http\.ts:1: our server's address/],
  "packages/exit/test/fixtures/a6-data.json": [`{ "rpc": "https://api.confidential.${OURS}/v1/rpc/near" }\n`, /a6-data\.json:1: our server's address/],
  "packages/exit/README.md": [`Run it against https://api.confidential.${OURS}.\n`, /README\.md:1: our server's address/],
  "packages/exit/src/b1-named.ts": ['import { HELPER_V1_PREFIX } from "@blindfill/kit";\nexport const p = HELPER_V1_PREFIX;\n', /b1-named\.ts:1: imports HELPER_V1_PREFIX from @blindfill\/kit/],
  "packages/exit/src/b2-renamed.ts": ['import { helperBase as base } from "@blindfill/kit";\nexport const b = base;\n', /b2-renamed\.ts:1: imports helperBase from @blindfill\/kit/],
  "packages/exit/src/b3-type.ts": ['import type { HelperWithdrawRequest } from "@blindfill/kit";\nexport type W = HelperWithdrawRequest;\n', /b3-type\.ts:1: imports HelperWithdrawRequest from @blindfill\/kit/],
  "packages/exit/src/b4-reexport.ts": ['export { HELPER_ALIAS } from "@blindfill/kit/core";\n', /b4-reexport\.ts:1: imports HELPER_ALIAS from @blindfill\/kit\/core/],
  "packages/exit/src/b5-namespace.ts": ['import * as kit from "@blindfill/kit";\nexport const k = kit;\n', /b5-namespace\.ts:1: import \* from @blindfill\/kit/],
  "packages/exit/src/b6-star.ts": ['export * from "@blindfill/kit";\n', /b6-star\.ts:1: export \* from @blindfill\/kit/],
  "packages/exit/src/b7-dynamic.ts": ['export const k = () => import("@blindfill/kit");\n', /b7-dynamic\.ts:1: import\(\) of @blindfill\/kit/],
  "packages/exit/src/b8-require.cjs": ['module.exports = require("@blindfill/kit");\n', /b8-require\.cjs:1: require\(\) of @blindfill\/kit/],
  "packages/exit/src/b9-type-import.ts": ['export type W = import("@blindfill/kit").HelperWithdrawRequest;\n', /b9-type-import\.ts:1: imports HelperWithdrawRequest from @blindfill\/kit/],
};

test("every planted address of ours and every helper import is refused by file and line", () => {
  const dir = tree({ ...HELPER, ...GOOD, ...Object.fromEntries(Object.entries(PLANTED).map(([f, [body]]) => [f, body])) });
  try {
    const r = run(dir);
    assert.equal(r.rc, 1, r.out);
    for (const [f, [, want]] of Object.entries(PLANTED)) assert.match(r.out, new RegExp(`^exit-no-server: REFUSED: ${f.replace(/\./g, "\\.").replace(/\/[^/]*$/, "/")}.*${want.source}`, "m"), f);
    // the good files stay unrefused
    for (const f of Object.keys(GOOD)) assert.doesNotMatch(r.out, new RegExp(`REFUSED: ${f.replace(/\./g, "\\.")}:`), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a kit with no helper module read is an error, not a pass", () => {
  const dir = tree({ ...GOOD, "packages/kit/src/helper/v1.ts": "const x = 1;\n" });
  try {
    const r = run(dir);
    assert.notEqual(r.rc, 0, r.out);
    assert.match(r.out, /no export read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
