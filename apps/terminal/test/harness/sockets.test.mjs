// The harness's sockets (card market-data-push, scripts/harness-sockets.mjs): every terminal harness run starts the
// harness browser, which mocks the helper's push socket: a bare launchBrowser in a run, or in a live check the e2e list
// runs with --harness, is refused here (CI, PR #554: BAR-10's loads met the deployed helper's socket, 404, because
// context.route never sees a WebSocket). This reads source only, so `pnpm test` needs no Chrome; the browser half of the
// card, the mock socket itself, is test/harness-sockets/run.mjs, in test:e2e.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { harnessProblem } from "./held.mjs";

const TERMINAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = path.resolve(TERMINAL, "../..");

/** The browser runs test:e2e starts: its run.mjs files and the live checks it runs with --harness. */
function e2eFiles() {
  const line = JSON.parse(readFileSync(path.join(TERMINAL, "package.json"), "utf8")).scripts["test:e2e"];
  return line
    .split("&&")
    .map((c) => c.trim().split(/\s+/))
    .filter((w) => w[0] === "node")
    .map((w) => path.resolve(TERMINAL, w[1]));
}

// the planted live checks: test/harness/planted/<name>.txt read as <name>.mjs, text a default test never imports
const PLANTED = path.join(TERMINAL, "test/harness/planted");
const rel = (f) => path.relative(REPO, f);

test("harnessProblem: refuses a check that launches a bare browser, itself or through a module it imports", () => {
  const at = (n) => path.join(PLANTED, `${n}.mjs`);
  const read = (f) => readFileSync(path.join(PLANTED, path.basename(f, ".mjs") + ".txt"), "utf8");
  assert.equal(harnessProblem(at("held"), rel, read), null);
  assert.equal(harnessProblem(at("bare"), rel, read), "apps/terminal/test/harness/planted/bare.mjs runs with --harness and never starts the harness browser");
  assert.equal(harnessProblem(at("none"), rel, read), null);
  assert.equal(harnessProblem(at("via-held"), rel, read), null);
  assert.match(harnessProblem(at("via-bare"), rel, read), /via-bare\.mjs runs with --harness and imports apps\/terminal\/test\/harness\/planted\/bare\.mjs, which launches a browser/);
  assert.match(harnessProblem(at("via-bare-dynamic"), rel, read), /via-bare-dynamic\.mjs runs with --harness and imports apps\/terminal\/test\/harness\/planted\/bare\.mjs/);
});

test("every harness run starts the harness browser: no bare launchBrowser in a run, and every --harness check can", () => {
  const files = e2eFiles();
  assert.ok(files.length >= 25, `the e2e list names ${files.length} runs`);
  const runs = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (/\.mjs$/.test(e.name) && !e.name.endsWith(".test.mjs")) runs.push(path.join(d, e.name));
    }
  };
  walk(path.join(TERMINAL, "test"));
  // a recorder that is not a harness run: it reads Chrome with no route on, on local servers only, and opens no socket
  const KEEP = new Set(["apps/terminal/test/preflight/record.mjs"]);
  const bare = runs.filter((f) => !KEEP.has(path.relative(REPO, f)) && /\blaunchBrowser\s*\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(bare.map((f) => path.relative(REPO, f)), [], "a terminal test run launches a browser that routes no socket");
  for (const f of files) {
    assert.ok(existsSync(f), f);
    if (!f.startsWith(path.join(TERMINAL, "test"))) assert.equal(harnessProblem(f, rel), null);
  }
  // the shared collectors the runs call with a route
  for (const m of ["app-shell", "app-verify-mount", "app-no-blank-pages"]) {
    const text = readFileSync(path.join(REPO, `scripts/live-checks/${m}.mjs`), "utf8");
    assert.match(text, /route \? launchHarnessBrowser : launchBrowser/, m);
    assert.match(text, /^import \{ launchHarnessBrowser \} from "\.\.\/harness-sockets\.mjs";$/m, `${m} imports it`);
  }
});
