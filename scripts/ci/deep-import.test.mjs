// The deep-import rule on a planted tree, run as package.json's check:imports runs it (.dependency-cruiser.cjs for the
// imports, then scripts/ci/kit-reach.mjs for the reaches that are not imports): every spelling of a reach into the
// kit's internals must be refused by name, and the public entry must pass. Run: node --test scripts/ci/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEPCRUISE = join(ROOT, "node_modules/.bin/depcruise");
const CONFIG = join(ROOT, ".dependency-cruiser.cjs");

// a git work tree (the text rule reads the files git lists) with the kit's own .gitignore
function tree(files, forceAdd = []) {
  const dir = mkdtempSync(join(tmpdir(), "deep-import-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  writeFileSync(join(dir, ".gitignore"), readFileSync(join(ROOT, ".gitignore")));
  // the workspace link pnpm makes for the kit package
  mkdirSync(join(dir, "node_modules/@blindfill"), { recursive: true });
  symlinkSync(join(dir, "packages/kit"), join(dir, "node_modules/@blindfill/kit"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (forceAdd.length) execFileSync("git", ["add", "-f", "--", ...forceAdd], { cwd: dir });
  return dir;
}

// the steps of package.json's check:imports, each run as it is written there (the config and the script by their
// absolute paths); a step this test does not know fails the test, so the two cannot drift apart
const STEPS = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  .scripts["check:imports"].split("&&")
  .map((step) => step.trim().match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"(.*)"$/, "$1")));

function run(bin, args, dir) {
  try {
    return { rc: 0, out: execFileSync(bin, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }) };
  } catch (e) {
    return { rc: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

// every step on the tree (all of them, so a test sees each one's refusals): the outputs joined, the first failing rc
function check(dir) {
  let rc = 0;
  let out = "";
  for (const [bin, ...args] of STEPS) {
    let r;
    if (bin === "depcruise") r = run(DEPCRUISE, args.map((a) => (a === ".dependency-cruiser.cjs" ? CONFIG : a)), dir);
    else if (bin === "node") r = run(process.execPath, args.map((a) => (a.startsWith("scripts/") ? join(ROOT, a) : a)), dir);
    else assert.fail(`check:imports has a step this test does not know: ${bin}`);
    rc ||= r.rc;
    out += r.out;
  }
  return { rc, out };
}

const KIT = {
  "packages/kit/package.json": JSON.stringify({
    name: "@blindfill/kit",
    type: "module",
    exports: { ".": "./src/index.ts", "./core": "./src/core/index.ts" },
  }),
  "packages/kit/src/index.ts": 'export { seed } from "./core/seed";\n',
  "packages/kit/src/core/index.ts": 'export { seed } from "./seed";\n',
  "packages/kit/src/core/seed.ts": "export const seed = 1;\n",
  "apps/terminal/src/main.ts": 'import { seed } from "@blindfill/kit";\nexport const x = seed;\n',
  "packages/wallet/src/keys/derive.ts": "export const derive = 1;\n",
  "contracts/vault/abi.ts": "export const abi = 1;\n",
};

const UP2 = "../..";
const PLANTED = {
  "apps/terminal/src/p1-relative.ts": 'import { seed } from "../../../packages/kit/src/core/seed";\nexport const a = seed;\n',
  "apps/terminal/src/p2-package-subpath.ts": 'import { seed } from "@blindfill/kit/src/core/seed";\nexport const a = seed;\n',
  "apps/terminal/src/p3-dynamic-subpath.ts": 'export const a = import("@blindfill/kit/src/core/seed");\n',
  "apps/terminal/src/p4-reexport.ts": 'export { seed } from "../../../packages/kit/src/core/seed";\n',
  "apps/terminal/src/p5-type-only.ts": 'import type { seed } from "../../../packages/kit/src/core/seed";\nexport type A = typeof seed;\n',
  "apps/terminal/src/p6-require.cjs": 'module.exports = require("../../../packages/kit/src/core/seed");\n',
  "apps/terminal/src/p7-dynamic-relative.ts": 'export const a = import("../../../packages/kit/src/core/seed");\n',
  "apps/terminal/src/p8-core-subpath.ts": 'import { seed } from "@blindfill/kit/core";\nexport const a = seed;\n',
  "apps/terminal/src/p9-wallet.ts": 'import { derive } from "../../../packages/wallet/src/keys/derive";\nexport const a = derive;\n',
  "apps/terminal/src/dist/p10-in-a-dist-folder.ts": 'import { seed } from "../../../../packages/kit/src/core/seed";\nexport const a = seed;\n',
  // (${UP2}: this file sits two folders down, so the two-up path to packages/ written out here, in quotes, would be a
  // reach from this file itself to the text rule)
  "examples/private-buy/p11-example.ts": `import { seed } from "${UP2}/packages/kit/src/core/seed";\nexport const a = seed;\n`,
  "apps/terminal/src/p12-contract.ts": 'import { abi } from "../../../contracts/vault/abi";\nexport const a = abi;\n',
  // packages/exit is held as an app is (card exit-pages-rpcs): the kit's internals, the wallet, a contract and an app
  "packages/exit/src/p13-exit-kit.ts": 'import { seed } from "../../kit/src/core/seed";\nexport const a = seed;\n',
  "packages/exit/src/p14-exit-wallet.ts": 'import { derive } from "../../wallet/src/keys/derive";\nexport const a = derive;\n',
  "packages/exit/test/p15-exit-contract.ts": 'import { abi } from "../../../contracts/vault/abi";\nexport const a = abi;\n',
  "packages/exit/src/p16-exit-app.ts": 'import { x } from "../../../apps/terminal/src/main";\nexport const a = x;\n',
};

// plain strings next to the entry: a path to the entry itself, the app's own files, a URL path, the workspace globs
const CONTROL = {
  "apps/terminal/src/entry-relative.ts": 'export { seed } from "../../../packages/kit/src/index";\n',
  "apps/terminal/src/own.ts": 'export const w = new URL("./worker.ts", import.meta.url);\nexport const api = "/api/quote";\n',
  "apps/terminal/src/worker.ts": "export {};\n",
  // the exit package's own files and the kit's entry, by its bare name
  "packages/exit/src/own.ts": 'import { seed } from "@blindfill/kit";\nimport { b } from "./b";\nexport const a = seed + b;\n',
  "packages/exit/src/b.ts": "export const b = 1;\n",
  "packages/exit/test/own.test.ts": 'import { a } from "../src/own";\nexport const t = new URL("../src/b.ts", import.meta.url) && a;\n',
  "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n',
  "README.md": "The kit lives in `packages/kit`; see 'packages/kit/src/index.ts'.\n",
  // normal configs and routes that name packages/ or contracts/ without reaching them (outside read of fd72db5)
  "eslint.config.js": 'export default [{ files: ["packages/**/*.ts"], rules: {} }];\n',
  "vitest.workspace.ts": 'export default ["packages/*", "apps/*"];\n',
  "apps/terminal/src/route.ts": 'export const abi = () => fetch("/contracts/abi");\nexport const docs = "../../../packages/kit/README.md";\n',
  "apps/terminal/src/notes.js": "// the vault's ABI lives in contracts/vault/abi.ts; see ../../../packages/kit/src/core\n/** @type {import(\"../../../packages/kit/src/index\").Seed} */\nexport const s = 1;\n",
  "apps/terminal/src/app.css": '@import "./theme.css";\nbody { background: url(./bg.png); }\n/* url(../../../packages/kit/x.css) in a comment */\n',
  "apps/terminal/src/theme.css": ":root { --bg: #000; }\n",
  // an app page (task B4): its own entry from "/", URLs, a link that is not a load, anchors
  "apps/terminal/index.html": [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">',
    '<script src="//cdn.jsdelivr.net/npm/x@1.0.0/x.js"></script>',
    '<script type="module" src="/src/main.ts"></script>',
    '<link rel="next" href="#contracts">',
    "</head>",
    "<body>",
    '<a href="/contracts/abi">ABI</a> <a href="#packages">Packages</a> <a href="https://near.org/packages">NEAR</a>',
    '<img src="./src/logo.png" alt="see ../../packages/kit">',
    "</body>",
    "</html>",
    "",
  ].join("\n"),
};

test("the public entry passes", () => {
  const dir = tree({ ...KIT, ...CONTROL });
  try {
    const r = check(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^kit-reach: OK/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every planted deep import is refused by name", () => {
  const dir = tree({ ...KIT, ...PLANTED });
  try {
    const r = check(dir);
    assert.notEqual(r.rc, 0, r.out);
    for (const f of Object.keys(PLANTED)) assert.match(r.out, new RegExp(`error \\S+: ${f.replace(/\./g, "\\.")}`), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal main that never reaches the kit's entry is refused", () => {
  const dir = tree({ ...KIT, "apps/terminal/src/main.ts": "export const x = 1;\n" });
  try {
    const r = check(dir);
    assert.notEqual(r.rc, 0, r.out);
    assert.match(r.out, /terminal-uses-kit-entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A relay: a file outside packages/ and contracts/ that re-exports a kit internal, imported by the terminal. The rule
// holds every module outside packages/ and contracts/, so the relay itself is refused wherever it sits, the folders a
// build or a test fixture uses included.
const RELAYS = {
  "shared/shim.ts": 'export { seed } from "../packages/kit/src/core/seed";\n',
  "apps/terminal/test/deep-import/planted/shim.ts": 'export { seed } from "../../../../../packages/kit/src/core/seed";\n',
  "apps/terminal/dist/shim.js": 'export { seed } from "../../../packages/kit/src/core/seed";\n',
};
const USERS = {
  "apps/terminal/src/r1-root-relay.ts": 'import { seed } from "../../../shared/shim";\nexport const a = seed;\n',
  "apps/terminal/src/r2-planted-relay.ts": 'import { seed } from "../test/deep-import/planted/shim";\nexport const a = seed;\n',
  "apps/terminal/src/r3-dist-relay.ts": 'import { seed } from "../dist/shim.js";\nexport const a = seed;\n',
};

test("a relay to a kit internal is refused, at the root, in a planted folder and in a dist folder", () => {
  const dir = tree({ ...KIT, ...RELAYS, ...USERS });
  try {
    const r = check(dir);
    assert.notEqual(r.rc, 0, r.out);
    for (const f of Object.keys(RELAYS)) assert.match(r.out, new RegExp(`error \\S+: ${f.replace(/\./g, "\\.")} → packages/kit/src/core/seed\\.ts`), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Reaches that are not imports, so depcruise never sees them (review round 2 at 41dbf4a). kit-reach.mjs refuses each
// by file and line: a reach form (new URL, import.meta.glob, require.resolve, a template import(), a comment import(),
// a CSS @import or url()) whose path lands in packages/ or contracts/ from its file, other than the kit's entry, or
// whose path is not a static string; a Blindfill package named past the kit's bare name; a node_modules path git
// lists; a symlink into them. Any other string is not read (CONTROL above).
const SEED = "../../../packages/kit/src/core/seed";
const FORMS = {
  "a Worker URL": {
    files: { "apps/terminal/src/f1-worker.ts": 'export const w = new Worker(new URL("../../../packages/kit/src/core/prover.worker.ts", import.meta.url), { type: "module" });\n' },
    want: [/apps\/terminal\/src\/f1-worker\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/prover\.worker\.ts/],
  },
  "an import.meta.glob": {
    files: { "apps/terminal/src/f2-glob.ts": "export const m = import.meta.glob('../../../packages/kit/src/core/*.ts');\n" },
    want: [/apps\/terminal\/src\/f2-glob\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/\*\.ts/],
  },
  "a require.resolve, by path and by package subpath": {
    files: {
      "apps/terminal/src/f3-resolve.cjs": `module.exports = require.resolve("${SEED}.ts");\n`,
      "apps/terminal/src/f3-resolve-name.cjs": 'module.exports = require.resolve("@blindfill/kit/src/core/seed");\n',
    },
    want: [/apps\/terminal\/src\/f3-resolve\.cjs:1: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/, /apps\/terminal\/src\/f3-resolve-name\.cjs:1: "@blindfill\/kit\/src\/core\/seed" names @blindfill\/kit past its entry/],
  },
  "a JSDoc typedef import in a .js file": {
    files: { "apps/terminal/src/f4-jsdoc.js": `/**\n * @typedef {import("${SEED}").Seed} Seed\n */\n/** @type {Seed} */\nexport const s = 1;\n` },
    want: [/apps\/terminal\/src\/f4-jsdoc\.js:2: "[^"]*" reaches packages\/kit\/src\/core\/seed/],
  },
  "a relay under a committed node_modules folder": {
    files: {
      "apps/terminal/src/node_modules/shim/index.ts": 'export { seed } from "../../../../../packages/kit/src/core/seed";\n',
      "apps/terminal/src/f5-uses-shim.ts": 'import { seed } from "./node_modules/shim/index";\nexport const a = seed;\n',
    },
    add: ["apps/terminal/src/node_modules/shim/index.ts"],
    want: [/apps\/terminal\/src\/node_modules\/shim\/index\.ts: a node_modules path in git/],
  },
  "a template string up to its first ${": {
    files: { "apps/terminal/src/f6-template.ts": "export const load = (n: string) => import(`../../../packages/kit/src/core/${n}.ts`);\n" },
    want: [/apps\/terminal\/src\/f6-template\.ts:1: "[^"]*" reaches packages\/kit\/src\/core/],
  },
  "a reach from the exit package": {
    files: {
      "packages/exit/src/f-exit-worker.ts": 'export const w = new URL("../../kit/src/core/prover.worker.ts", import.meta.url);\n',
      "packages/exit/src/f-exit-dynamic.ts": 'export const m = import("@blindfill/wallet/derive");\n',
      "packages/wallet/package.json": JSON.stringify({ name: "@blindfill/wallet", type: "module" }),
    },
    want: [
      /packages\/exit\/src\/f-exit-worker\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/prover\.worker\.ts/,
      /packages\/exit\/src\/f-exit-dynamic\.ts:1: "@blindfill\/wallet\/derive" names @blindfill\/wallet/,
    ],
  },
  "a root-relative path": {
    // (joined, so this file's own text holds no root-relative path to packages/)
    files: { "apps/terminal/src/f7-root.ts": 'export const w = new URL("' + "/" + 'packages/kit/src/core/prover.worker.ts", import.meta.url);\n' },
    want: [/apps\/terminal\/src\/f7-root\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/prover\.worker\.ts/],
  },
  // review of B4: a root path that climbs above the root first, which a browser reads from the root
  "a root path that starts with ..": {
    files: { "apps/terminal/src/f7b-root-up.ts": 'export const w = new URL("' + "/../" + 'packages/kit/src/core/prover.worker.ts", import.meta.url);\n' },
    want: [/apps\/terminal\/src\/f7b-root-up\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/prover\.worker\.ts/],
  },
  // outside read of fd72db5 (task B2): the CSS forms, a glob array, and a reach whose target cannot be read
  "an import.meta.glob array": {
    files: { "apps/terminal/src/f8-glob-array.ts": "export const m = import.meta.glob(['./own/*.ts', '../../../packages/kit/src/core/*.ts']);\n" },
    want: [/apps\/terminal\/src\/f8-glob-array\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/\*\.ts/],
  },
  "an import.meta.glob whose first folder is a pattern": {
    files: { "apps/terminal/src/f8-glob-root.ts": "export const m = import.meta.glob('../../../{apps,packages}/**/*.ts');\n" },
    want: [/apps\/terminal\/src\/f8-glob-root\.ts:1: "[^"]*" reaches \{apps,packages\}\/\*\*\/\*\.ts/],
  },
  "a CSS @import": {
    files: { "apps/terminal/src/f9-theme.css": '@import "../../../packages/kit/src/ui/theme.css";\n' },
    want: [/apps\/terminal\/src\/f9-theme\.css:1: "[^"]*" reaches packages\/kit\/src\/ui\/theme\.css/],
  },
  "a CSS url()": {
    files: { "apps/terminal/src/f10-bg.css": "body {\n  background: url(../../../packages/kit/assets/bg.png);\n}\n" },
    want: [/apps\/terminal\/src\/f10-bg\.css:2: "[^"]*" reaches packages\/kit\/assets\/bg\.png/],
  },
  "a reach whose first argument is not a static string": {
    files: {
      "apps/terminal/src/f11-url.ts": "const name = 'x';\nexport const w = new URL(name, import.meta.url);\n",
      "apps/terminal/src/f11-glob.ts": "const dir = 'x';\nexport const m = import.meta.glob(dir + '/*.ts');\n",
      "apps/terminal/src/f11-resolve.cjs": "const id = 'x';\nmodule.exports = require.resolve(id);\n",
      "apps/terminal/src/f11-template.ts": "const base = 'x';\nexport const load = () => import(`${base}/seed.ts`);\n",
      "apps/terminal/src/f11-glob-array.ts": "const dir = 'x';\nexport const m = import.meta.glob(['./own/*.ts', `${dir}/*.ts`]);\n",
    },
    want: [
      /apps\/terminal\/src\/f11-url\.ts:2: new URL\(\) with a first argument that is not a static string \(name\): not checkable/,
      /apps\/terminal\/src\/f11-glob\.ts:2: import\.meta\.glob\(\) with a first argument that is not a static string \(dir \+ '\/\*\.ts'\): not checkable/,
      /apps\/terminal\/src\/f11-resolve\.cjs:2: require\.resolve\(\) with a first argument that is not a static string \(id\): not checkable/,
      /apps\/terminal\/src\/f11-template\.ts:2: import\(\) with a first argument that is not a static string \(`\$\{base\}\/seed\.ts`\): not checkable/,
      /apps\/terminal\/src\/f11-glob-array\.ts:2: import\.meta\.glob\(\) with a first argument that is not a static string \(`\$\{dir\}\/\*\.ts`\): not checkable/,
    ],
  },
  // task B4: the src and href of the tags that load what they name, in a page outside packages/ and contracts/ (the
  // every-string rule at fd72db5 caught them, depcruise does not read HTML). A "/" value lands from the repo root and
  // from the page's folder.
  "an HTML script src": {
    files: { "apps/terminal/index.html": '<!doctype html>\n<html>\n<body>\n<script type="module" src="../../packages/kit/src/core/x.ts"></script>\n</body>\n</html>\n' },
    want: [/apps\/terminal\/index\.html:4: "[^"]*" reaches packages\/kit\/src\/core\/x\.ts/],
  },
  "an HTML link href": {
    files: { "apps/terminal/h2.html": '<!doctype html>\n<link\n  rel="stylesheet"\n  href="../../packages/kit/src/ui/theme.css">\n' },
    want: [/apps\/terminal\/h2\.html:4: "[^"]*" reaches packages\/kit\/src\/ui\/theme\.css/],
  },
  "a root-absolute src": {
    files: {
      "apps/terminal/h3.html": '<!doctype html>\n<script type="module" src="/packages/kit/src/core/x.ts"></script>\n',
      "apps/terminal/src/H3.vue": '<template>\n  <img src="/../../../packages/kit/assets/logo.png" />\n</template>\n',
    },
    want: [
      /apps\/terminal\/h3\.html:2: "[^"]*" reaches packages\/kit\/src\/core\/x\.ts/,
      /apps\/terminal\/src\/H3\.vue:2: "[^"]*" reaches packages\/kit\/assets\/logo\.png/,
    ],
  },
  // task C2: a // line comment in SCSS and Less is not a reach (the test below), but a // in a string or a url(http://)
  // starts none, so what follows it on the line is still read, and so is the next line
  "a reach after a // in a string, in a url(http://) or on the line after a comment, in SCSS and Less": {
    files: {
      "apps/terminal/src/f12-sep.scss": '$sep: "//"; body { background: url(../../../packages/kit/a.png); }\n',
      "apps/terminal/src/f12-cdn.less": "body { background: url(http://cdn.example.com/a.png), url(../../../packages/kit/b.png); }\n",
      "apps/terminal/src/f12-next.scss": "$a: 1; // a note /* not a block\nbody { background: url(../../../packages/kit/c.png); }\n",
    },
    want: [
      /apps\/terminal\/src\/f12-sep\.scss:1: "[^"]*" reaches packages\/kit\/a\.png/,
      /apps\/terminal\/src\/f12-cdn\.less:1: "[^"]*" reaches packages\/kit\/b\.png/,
      /apps\/terminal\/src\/f12-next\.scss:2: "[^"]*" reaches packages\/kit\/c\.png/,
    ],
  },
  // task R2-K, F2: a static import or export-from in a page's <script> block or .astro frontmatter (depcruise reads no
  // .html, .svelte, .astro or .vue file, and Vite builds what they import)
  "an inline module script's import in a page": {
    files: {
      "apps/terminal/index.html": [
        "<!doctype html>",
        "<html>",
        "<body>",
        '<script type="module">',
        'import { seed } from "../../packages/kit/src/core/seed.ts";',
        'import "../../packages/wallet/src/keys/derive.ts";',
        'export * from "@blindfill/kit/core";',
        "console.log(seed);",
        "</script>",
        "</body>",
        "</html>",
        "",
      ].join("\n"),
    },
    want: [
      /apps\/terminal\/index\.html:5: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/index\.html:6: "[^"]*" reaches packages\/wallet\/src\/keys\/derive\.ts/,
      /apps\/terminal\/index\.html:7: "@blindfill\/kit\/core" names @blindfill\/kit past its entry/,
    ],
  },
  "a .svelte script's import and export from": {
    files: {
      "apps/terminal/src/F2.svelte": `<script context="module" lang="ts">\nexport { seed } from "${SEED}";\n</script>\n<script lang="ts">\nimport type { Seed } from "${SEED}";\n</script>\n<p>seed</p>\n`,
    },
    want: [
      /apps\/terminal\/src\/F2\.svelte:2: "[^"]*" reaches packages\/kit\/src\/core\/seed/,
      /apps\/terminal\/src\/F2\.svelte:5: "[^"]*" reaches packages\/kit\/src\/core\/seed/,
    ],
  },
  "an .astro frontmatter import and import = require": {
    files: {
      "apps/terminal/src/F2.astro": `---\nimport { seed } from "${SEED}.ts";\nimport abi = require("../../../contracts/vault/abi");\n---\n<p>{seed}</p>\n`,
    },
    want: [
      /apps\/terminal\/src\/F2\.astro:2: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/src\/F2\.astro:3: "[^"]*" reaches contracts\/vault\/abi/,
    ],
  },
  "a .vue script's import": {
    files: { "apps/terminal/src/F2.vue": `<template>\n  <p>{{ seed }}</p>\n</template>\n<script setup lang="ts">\nimport { seed } from "${SEED}";\n</script>\n` },
    want: [/apps\/terminal\/src\/F2\.vue:5: "[^"]*" reaches packages\/kit\/src\/core\/seed/],
  },
  // task R2-K, F3: a new URL on any base (a static path; one that is not static is not checkable only on
  // import.meta.url), the script of a worker or a service worker, and a page's <embed src> and <object data>
  "a new URL on a base other than a literal import.meta.url": {
    files: {
      "apps/terminal/src/f13-base.ts": `const base = import.meta.url;\nexport const a = new URL("${SEED}.ts", base);\nexport const b = new URL("${SEED}.ts", import.meta["url"]);\nexport const c = new URL("${SEED}.ts", location.href);\n`,
      "apps/terminal/src/f13-name.ts": "const name = 'x';\nexport const w = new URL(name, import.meta[\"url\"]);\n",
    },
    want: [
      /apps\/terminal\/src\/f13-base\.ts:2: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/src\/f13-base\.ts:3: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/src\/f13-base\.ts:4: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/src\/f13-name\.ts:2: new URL\(\) with a first argument that is not a static string \(name\): not checkable/,
    ],
  },
  "a worker, a shared worker, importScripts and a service worker by a static path": {
    files: {
      "apps/terminal/src/f14-worker.ts": [
        'export const w = new Worker("../../../packages/kit/src/core/prover.worker.ts", { type: "module" });',
        "export const s = new SharedWorker(`../../../packages/kit/src/core/shared.ts`);",
        'export const r = navigator.serviceWorker.register("../../../packages/kit/src/core/sw.ts");',
        "",
      ].join("\n"),
      "apps/terminal/src/f14-sw.js": 'serviceWorker.register("../../../packages/kit/src/core/sw2.js");\n',
      "apps/terminal/src/f14.worker.js": 'importScripts("./own.js", "../../../packages/kit/src/core/prover.worker.js");\nself.importScripts("../../../packages/kit/src/core/self.js");\n',
    },
    want: [
      /apps\/terminal\/src\/f14-worker\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/prover\.worker\.ts/,
      /apps\/terminal\/src\/f14-worker\.ts:2: "[^"]*" reaches packages\/kit\/src\/core\/shared\.ts/,
      /apps\/terminal\/src\/f14-worker\.ts:3: "[^"]*" reaches packages\/kit\/src\/core\/sw\.ts/,
      /apps\/terminal\/src\/f14-sw\.js:1: "[^"]*" reaches packages\/kit\/src\/core\/sw2\.js/,
      /apps\/terminal\/src\/f14\.worker\.js:1: "[^"]*" reaches packages\/kit\/src\/core\/prover\.worker\.js/,
      /apps\/terminal\/src\/f14\.worker\.js:2: "[^"]*" reaches packages\/kit\/src\/core\/self\.js/,
    ],
  },
  "an HTML embed src and object data": {
    files: { "apps/terminal/h4.html": '<!doctype html>\n<embed src="../../packages/kit/src/core/a.wasm">\n<object data="../../packages/kit/src/core/b.svg"></object>\n' },
    want: [
      /apps\/terminal\/h4\.html:2: "[^"]*" reaches packages\/kit\/src\/core\/a\.wasm/,
      /apps\/terminal\/h4\.html:3: "[^"]*" reaches packages\/kit\/src\/core\/b\.svg/,
    ],
  },
  // review round 3: an import map's addresses, in "imports" and in "scopes", from the page's folder and from the root;
  // an import map that is not JSON is not checkable
  "an import map's imports and scopes": {
    files: {
      "apps/terminal/im.html": [
        "<!doctype html>",
        '<script type="importmap">',
        '{ "imports": { "seed": "../../packages/kit/src/core/seed.ts", "own": "./src/own.ts", "cdn": "https://esm.sh/x" },',
        '  "scopes": { "/apps/": { "derive": "/packages/wallet/src/keys/derive.ts" } } }',
        "</script>",
        "<SCRIPT TYPE=' ImportMap '>",
        '{ "imports": { "abi": "/contracts/vault/abi.ts" } }',
        "</SCRIPT>",
        "",
      ].join("\n"),
      "apps/terminal/im2.html": '<!doctype html>\n<script type="importmap">\n{ imports: { seed: "x" } }\n</script>\n',
    },
    want: [
      /apps\/terminal\/im\.html:3: "\.\.\/\.\.\/packages\/kit\/src\/core\/seed\.ts" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/im\.html:4: "\/packages\/wallet\/src\/keys\/derive\.ts" reaches packages\/wallet\/src\/keys\/derive\.ts/,
      /apps\/terminal\/im\.html:7: "\/contracts\/vault\/abi\.ts" reaches contracts\/vault\/abi\.ts/,
      /apps\/terminal\/im2\.html:2: an import map that is not JSON \([^)]*\): not checkable/,
    ],
  },
};

for (const [name, { files, add = [], want }] of Object.entries(FORMS))
  test(`${name} into the kit is refused`, () => {
    const dir = tree({ ...KIT, ...files }, add);
    try {
      const r = check(dir);
      assert.notEqual(r.rc, 0, r.out);
      for (const w of want) assert.match(r.out, new RegExp(`^kit-reach: REFUSED: ${w.source}`, "m"), r.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

// Task R2-K: a page's inline module script that imports the kit's bare name and its own file passes, and so do a URL
// built from a variable on a base other than import.meta.url (an API call) and a worker or service worker started from
// a variable (the inner new URL is read on its own).
test("an inline module script on the kit's bare name, and URLs and workers built from variables, pass", () => {
  const dir = tree({
    ...KIT,
    "apps/terminal/index.html": '<!doctype html>\n<script type="module">\nimport { seed } from "@blindfill/kit";\nimport { own } from "./src/own.ts";\nconsole.log(seed, own);\n</script>\n',
    "apps/terminal/src/own.ts": "export const own = 1;\n",
    "apps/terminal/src/worker.ts": "export {};\n",
    "apps/terminal/src/api.ts": [
      'const apiBase = "https://api.example.com/";',
      "export const quote = (path: string) => fetch(new URL(path, apiBase));",
      "export const page = (path: string) => new URL(`${path}?x=1`, location.origin);",
      'export const route = new URL("/api/quote", location.origin);',
      "export const start = (url: string) => new Worker(url, { type: \"module\" });",
      'export const own = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });',
      "export const sw = (u: string) => navigator.serviceWorker.register(u);",
      "",
    ].join("\n"),
  });
  try {
    const r = check(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^kit-reach: OK/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 3: a root path of a new URL is read only on a base made from the page's own address. On another base
// it is a route of that base, not a file here: an API's route under /contracts/ or /packages/ passes, while a relative
// path on that base, and a root path on location, document or import.meta.url, are still read.
test("an API route under /contracts/ on another base passes, and a root path on the page's own address is read", () => {
  const dir = tree({
    ...KIT,
    "apps/terminal/src/api.ts": [
      'const apiBase = "https://api.example.com/";',
      'const config = { document: "https://api.example.com/" };',
      'export const abi = new URL("/contracts/vault/abi", apiBase);',
      "export const pool = (id: string) => new URL(`/contracts/pools/${id}`, apiBase);",
      'export const pkg = new URL("/packages/kit/latest", config.document);',
      "",
    ].join("\n"),
  });
  try {
    const r = check(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^kit-reach: OK/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const read = tree({
    ...KIT,
    "apps/terminal/src/api.ts": `const apiBase = "https://api.example.com/";\nexport const a = new URL("${SEED}.ts", apiBase);\n`,
    "apps/terminal/src/f15-page.ts": [
      'export const a = new URL("/packages/kit/src/core/seed.ts", location.origin);',
      'export const b = new URL("/packages/kit/src/core/seed.ts", window.location.href);',
      'export const c = new URL("/contracts/vault/abi.ts", document.baseURI);',
      'export const d = new URL("/packages/kit/src/core/seed.ts", String(import.meta.url));',
      "",
    ].join("\n"),
  });
  try {
    const r = check(read);
    assert.notEqual(r.rc, 0, r.out);
    for (const w of [
      /apps\/terminal\/src\/api\.ts:2: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/src\/f15-page\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/src\/f15-page\.ts:2: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
      /apps\/terminal\/src\/f15-page\.ts:3: "[^"]*" reaches contracts\/vault\/abi\.ts/,
      /apps\/terminal\/src\/f15-page\.ts:4: "[^"]*" reaches packages\/kit\/src\/core\/seed\.ts/,
    ])
      assert.match(r.out, new RegExp(`^kit-reach: REFUSED: ${w.source}`, "m"), r.out);
  } finally {
    rmSync(read, { recursive: true, force: true });
  }
});

// Task C2 (second outside read of 080a962): a // line comment in SCSS, Less, Sass and Stylus (and in a page's <style
// lang="scss">) is a comment, so a path in it is not a reach.
test("a // line comment in SCSS, Less or a scss style block is not a reach", () => {
  const dir = tree({
    ...KIT,
    "apps/terminal/src/old.scss": "// url(../../../packages/kit/x.png) is old\n$bg: url(./bg.png); // was ../../../packages/kit/x.png\n",
    "apps/terminal/src/old.less": '// @import "../../../packages/kit/x.less";\n@bg: url(./bg.png);\n',
    "apps/terminal/src/Old.vue": '<template>\n  <div />\n</template>\n<style lang="scss">\n// url(../../../packages/kit/x.png) is old\n</style>\n',
  });
  try {
    const r = check(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^kit-reach: OK/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Task C2: valid code nested deep (a 2000-call chain, an 8000-term + or comma chain) is read, a reach deep inside one is
// refused by name, and a file that cannot be read at all (a parser that runs out of stack) is refused by name while
// every other file is still read. Only the kit-reach step runs: these are its forms.
function reachStep(dir) {
  const [, ...args] = STEPS.find(([bin]) => bin === "node");
  return run(process.execPath, args.map((a) => (a.startsWith("scripts/") ? join(ROOT, a) : a)), dir);
}
const DEEP = {
  "apps/terminal/src/deep-calls.ts": "declare const x: any;\nexport const y = x" + ".f()".repeat(2000) + ";\n",
  "apps/terminal/src/deep-plus.ts": "export const s = 1" + " + 1".repeat(7999) + ";\n",
  "apps/terminal/src/deep-comma.ts": "export const c = (1" + ", 1".repeat(7999) + ");\n",
};

test("valid code nested deep is read and passes", () => {
  const dir = tree({ ...KIT, ...DEEP });
  try {
    const r = reachStep(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^kit-reach: OK/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reach deep in valid code is refused by name, and a file that cannot be read is refused by name alone", () => {
  const dir = tree({
    ...KIT,
    ...DEEP,
    "apps/terminal/src/deep-reach.ts": 'export const y = new URL("../../../packages/kit/src/core/x.ts", import.meta.url)' + ".f()".repeat(2000) + ";\n",
    "apps/terminal/src/deep-parens.ts": "export const p = " + "(".repeat(50000) + "1" + ")".repeat(50000) + ";\n",
  });
  try {
    const r = reachStep(dir);
    assert.notEqual(r.rc, 0, r.out);
    assert.match(r.out, /^kit-reach: REFUSED: apps\/terminal\/src\/deep-reach\.ts:1: "[^"]*" reaches packages\/kit\/src\/core\/x\.ts$/m, r.out);
    assert.match(r.out, /^kit-reach: REFUSED: apps\/terminal\/src\/deep-parens\.ts: could not be read/m, r.out);
    assert.doesNotMatch(r.out, /deep-(calls|plus|comma)\.ts|could not read the files here/, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink into the kit's internals is refused", () => {
  const dir = tree(KIT);
  try {
    symlinkSync("../../../packages/kit/src/core", join(dir, "apps/terminal/src/core"));
    const r = check(dir);
    assert.notEqual(r.rc, 0, r.out);
    assert.match(r.out, /^kit-reach: REFUSED: apps\/terminal\/src\/core: a symlink to "[^"]*", which reaches packages\/kit\/src\/core$/m, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The kit's own packages/ folder as this tree has it (not the planted KIT above): the terminal's import of the bare
// name must resolve to the public entry with no build, the wallet core stays refused from apps/, and the Blindfill
// packages that need the wallet core (the exit tool, the signing page) reach it from inside packages/ (merge note M304
// D-5, D-6). No file of the kit but core.ts reaches core or the wallet (kit-entry-never-core): the device's quote
// checks sit in the public entry's graph, so a reach from them would hand every app the seed tools.
function ownPackages() {
  const files = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else files[p] = readFileSync(join(ROOT, p), "utf8");
    }
  };
  walk("packages");
  return files;
}

// the resolved target of each import a module makes, as dependency-cruiser resolves it
function targets(dir, from) {
  const r = run(DEPCRUISE, ["--config", CONFIG, "--output-type", "json", "."], dir);
  const mod = JSON.parse(r.out).modules.find((m) => m.source === from);
  assert.ok(mod, `${from} is not in the graph: ${r.out.slice(0, 400)}`);
  return mod.dependencies.map((d) => ({ name: d.module, to: d.resolved, unresolved: d.couldNotResolve }));
}

const TERMINAL_MAIN = { "apps/terminal/src/main.tsx": 'import * as kit from "@blindfill/kit";\nexport const k = kit;\n' };

test("the kit's own entry: a terminal main importing @blindfill/kit passes with no build", () => {
  const dir = tree({ ...ownPackages(), ...TERMINAL_MAIN });
  try {
    const r = check(dir);
    assert.equal(r.rc, 0, r.out);
    assert.deepEqual(targets(dir, "apps/terminal/src/main.tsx"), [
      { name: "@blindfill/kit", to: "packages/kit/src/index.ts", unresolved: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the kit's own ./core entry is refused from apps/ by the public-entry rule", () => {
  const dir = tree({
    ...ownPackages(),
    ...TERMINAL_MAIN,
    "apps/terminal/src/core-use.ts": 'import * as core from "@blindfill/kit/core";\nexport const c = core;\n',
  });
  try {
    const r = check(dir);
    assert.notEqual(r.rc, 0, r.out);
    assert.match(r.out, /error kit-public-entry-only: apps\/terminal\/src\/core-use\.ts → packages\/kit\/src\/core\.ts/, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packages/exit and packages/signpage reach the kit's ./core and pass", () => {
  const dir = tree({
    ...ownPackages(),
    ...TERMINAL_MAIN,
    "packages/exit/src/index.ts": 'import * as core from "@blindfill/kit/core";\nexport const c = core;\n',
    "packages/signpage/src/main.ts": 'import * as core from "@blindfill/kit/core";\nexport const c = core;\n',
  });
  try {
    const r = check(dir);
    assert.equal(r.rc, 0, r.out);
    for (const from of ["packages/exit/src/index.ts", "packages/signpage/src/main.ts"]) {
      assert.deepEqual(targets(dir, from), [{ name: "@blindfill/kit/core", to: "packages/kit/src/core.ts", unresolved: false }], from);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Card exit-note-scan (review F1): every way a kit file other than core.ts could reach core or the wallet, the kit's
// own package name included, is refused by name; core.ts itself and the kit's tests reach them and pass.
const KIT_SELF = (f) => readFileSync(join(ROOT, f), "utf8");
const KIT_REACHES = {
  "packages/kit/src/index.ts": `${KIT_SELF("packages/kit/src/index.ts")}export { typedSeed } from "@blindfill/kit/core";\n`,
  "packages/kit/src/near/networks.ts": `${KIT_SELF("packages/kit/src/near/networks.ts")}export const loadCore = () => import("@blindfill/kit/core");\n`,
  "packages/kit/src/checks/oneclick.ts": `${KIT_SELF("packages/kit/src/checks/oneclick.ts")}export { restoreNotes } from "../core.ts";\n`,
  "packages/kit/src/freeze.ts": `${KIT_SELF("packages/kit/src/freeze.ts")}export type { NoteRef } from "../../wallet/src/notes/secrets.ts";\n`,
  "packages/kit/zk/core-use.mjs": 'export const c = await import("../src/core.ts");\n',
};

test("a kit file other than core.ts that reaches core or the wallet, by package name, relative path or import(), is refused", () => {
  const dir = tree({ ...ownPackages(), ...TERMINAL_MAIN, ...KIT_REACHES });
  try {
    const r = check(dir);
    assert.notEqual(r.rc, 0, r.out);
    for (const f of Object.keys(KIT_REACHES)) {
      assert.match(r.out, new RegExp(`error kit-entry-never-core: ${f.replace(/\./g, "\\.")} → packages/(kit/src/core\\.ts|wallet/)`), f);
    }
    assert.doesNotMatch(r.out, /kit-entry-never-core: packages\/kit\/(src\/core\.ts|test\/)/, "core.ts and the kit's tests pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
