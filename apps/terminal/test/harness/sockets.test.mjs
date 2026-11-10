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
    const text = readFileSync(f, "utf8");
    if (!f.startsWith(path.join(TERMINAL, "test"))) assert.match(text, /^import \{[^}]*\blaunchHarnessBrowser\b[^}]*\} from "\.\.\/harness-sockets\.mjs";$/m, `${path.relative(REPO, f)} runs with --harness and never starts the harness browser`);
  }
  // the shared collectors the runs call with a route
  for (const m of ["app-shell", "app-verify-mount", "app-no-blank-pages"]) {
    const text = readFileSync(path.join(REPO, `scripts/live-checks/${m}.mjs`), "utf8");
    assert.match(text, /route \? launchHarnessBrowser : launchBrowser/, m);
    assert.match(text, /^import \{ launchHarnessBrowser \} from "\.\.\/harness-sockets\.mjs";$/m, `${m} imports it`);
  }
});
