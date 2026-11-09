// The harness's sockets (card market-data-push, scripts/harness-sockets.mjs): a page in a harness browser that opens the
// helper's push socket gets the run's mock, open and sending what the run sends; any other socket is closed and named
// as a failure of the run. And every terminal harness run starts that browser: a bare launchBrowser in a run, or in a
// live check the e2e list runs with --harness, is refused here (CI, PR #554: BAR-10's loads met the deployed helper's
// socket, 404, because context.route never sees a WebSocket).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHarnessBrowser, pushSockets } from "../../../../scripts/harness-sockets.mjs";

const TERMINAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = path.resolve(TERMINAL, "../..");

test("a harness page's push socket is the run's mock; any other socket is closed and fails the run", async () => {
  const unrouted = [];
  const browser = await launchHarnessBrowser("chromium", {}, { onUnrouted: (u) => unrouted.push(u) });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const opened = page.evaluate(
      () =>
        new Promise((ok) => {
          const ws = new WebSocket("wss://ct-api.unrealized.trade/v1/market/push?chain=solana&token=Mint1");
          ws.onopen = () => (ws.onmessage = (e) => ok(String(e.data)));
          ws.onerror = () => ok("error");
        }),
    );
    for (let i = 0; i < 100 && pushSockets(ctx).length === 0; i++) await page.waitForTimeout(20);
    assert.equal(pushSockets(ctx).length, 1, "the push socket reached the mock");
    await page.waitForTimeout(100);
    pushSockets(ctx)[0].send('{"trades":[]}');
    assert.equal(await opened, '{"trades":[]}', "the page read what the run sent");
    const other = await page.evaluate(
      () =>
        new Promise((ok) => {
          const ws = new WebSocket("wss://example.com/feed");
          ws.onclose = (e) => ok(e.code);
        }),
    );
    assert.equal(other, 1008, "another host's socket is closed");
    assert.deepEqual(unrouted, ["wss://example.com/feed"], "and named as the run's failure");
    // http: a host no route of the run's answers is refused and named; the run's local server goes on
    const http = await page.evaluate(() => fetch("https://ct-api.unrealized.trade/v1/health").then((r) => r.status, () => "refused"));
    assert.equal(http, "refused");
    assert.deepEqual(unrouted, ["wss://example.com/feed", "https://ct-api.unrealized.trade/v1/health"]);
    await ctx.route("https://answered.test/**", (r) => r.fulfill({ status: 200, body: "ok", headers: { "access-control-allow-origin": "*" } }));
    assert.equal(await page.evaluate(() => fetch("https://answered.test/x").then((r) => r.text())), "ok", "a route of the run's is asked first");
    assert.equal(unrouted.length, 2);
    const own = await browser.newPage();
    assert.deepEqual(pushSockets(own.context()), [], "browser.newPage's context is routed too");
  } finally {
    await browser.close();
  }
});

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
