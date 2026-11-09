// The harness's sockets in a real browser (card market-data-push, scripts/harness-sockets.mjs): a page in a harness
// browser that opens the helper's push socket gets the run's mock, open and sending what the run sends; any other socket
// is closed and named as a failure of the run, and so is an http host no route of the run's answers. It starts Chrome, so
// it is one of test:e2e's runs (the browser job), not of `pnpm test`, which a machine with no Chrome runs. Its source
// half, that every run starts the harness browser, is test/harness/sockets.test.mjs.
//   node apps/terminal/test/harness-sockets/run.mjs     PASS exit 0, FAIL exit 1
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchHarnessBrowser, pushSockets } from "../../../../scripts/harness-sockets.mjs";

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
