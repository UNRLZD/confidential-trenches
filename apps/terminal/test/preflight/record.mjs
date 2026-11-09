#!/usr/bin/env node
// Records what watchPreflights (scripts/live-checks/rpc-outage.mjs) reads from a real Chrome with no route on: a JSON POST
// from a page in a frame of another site (and, for sameSite, of its own) to a local RPC whose preflight answers 503, 403 or
// has nothing listening. Playwright
// shows no preflight and gives the POST the same net::ERR_FAILED for the first two, so only the CDP record tells them apart;
// rpc-outage.test.mjs replays the record (card app-shell-rpc-outage-judge).
//   node apps/terminal/test/preflight/record.mjs --record scripts/live-checks/rpc-outage.preflights.json
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { watchPreflights } from "../../../../scripts/live-checks/rpc-outage.mjs";

const listen = (handler) => new Promise((resolve) => {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1", () => resolve(s));
});
const close = (s) => new Promise((resolve) => s.close(resolve));
const out = process.argv.includes("--record") ? process.argv[process.argv.indexOf("--record") + 1] : null;

const browser = await launchBrowser("chromium");
const record = { at: new Date().toISOString(), browser: browserLabel(browser), cases: {} };
try {
  // "sameSite": the frame on the page's own site (another port of 127.0.0.1) and the RPC on another origin (localhost), as the
  // live terminal sits in the signing page (same site), so its preflights come through the page's own session
  for (const [name, answer, sameSite] of [["503", 503, false], ["403", 403, false], ["closed", null, false], ["sameSite", 503, true]]) {
    const rpc = await listen((q, s) => {
      if (q.method === "OPTIONS") {
        s.writeHead(answer, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
        s.end();
      } else {
        s.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" });
        s.end("{}");
      }
    });
    const port = rpc.address().port;
    const rpcHost = sameSite ? "localhost" : "127.0.0.1";
    if (answer === null) await close(rpc);
    const frame = await listen((q, s) => {
      s.writeHead(200, { "content-type": "text/html" });
      s.end(`<script>fetch("http://${rpcHost}:${port}/", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});</script>`);
    });
    const top = await listen((q, s) => {
      s.writeHead(200, { "content-type": "text/html" });
      s.end(`<iframe src="http://${sameSite ? "127.0.0.1" : "localhost"}:${frame.address().port}/"></iframe>`);
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const preflights = [];
    const reads = [];
    const byReq = new Map();
    page.on("request", (q) => {
      if (q.method() !== "POST") return;
      const e = { url: q.url(), method: q.method(), status: null };
      byReq.set(q, e);
      reads.push(e);
    });
    page.on("response", (r) => {
      const e = byReq.get(r.request());
      if (e) e.status = r.status();
    });
    page.on("requestfailed", (q) => {
      const e = byReq.get(q);
      if (e) e.failure = q.failure()?.errorText ?? "";
    });
    watchPreflights(ctx, page, preflights);
    await page.goto(`http://127.0.0.1:${top.address().port}/`);
    await page.waitForTimeout(1_500);
    record.cases[name] = { preflightAnswer: answer, preflights, reads };
    await ctx.close();
    for (const s of [top, frame]) await close(s);
    if (answer !== null) await close(rpc);
  }
} finally {
  await browser.close();
}
const text = JSON.stringify(record, null, 1).replace(/(127\.0\.0\.1|localhost):\d+/g, "$1:PORT");
if (out) writeFileSync(out, `${text}\n`);
else console.log(text);
process.exit(0);
