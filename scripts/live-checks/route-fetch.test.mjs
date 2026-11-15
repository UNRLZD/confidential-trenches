// node --test scripts/live-checks/route-fetch.test.mjs: a route handler's route.fetch that rejects never ends the run
// (card outside-app-route-never-crashes; merge queue run 43673463187, outside-app.e2e.mjs:137, "socket hang up"):
// fetchOrAbort tries a dropped connection once more, then aborts the route so the page's own request fails, and no file
// that routes a page calls route.fetch any other way.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchOrAbort } from "./route-fetch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// node's own error on a kept-alive socket the server closed, as Playwright's route.fetch passed it on in job 132688370700
const HANG_UP = () => Object.assign(new Error("apiRequestContext.fetch: socket hang up"), { code: "ECONNRESET" });

/** A route whose fetch answers each try from `tries` in turn (an Error rejects), keeping every call. */
function route(...tries) {
  const calls = { fetch: [], abort: [], fulfill: [] };
  return {
    calls,
    fetch: async (o) => {
      calls.fetch.push(o);
      const t = tries.shift();
      if (t instanceof Error) throw t;
      return t;
    },
    abort: async (code) => void calls.abort.push(code),
    fulfill: async (o) => void calls.fulfill.push(o),
  };
}
const RES = { status: () => 200 };
const OPTS = { url: "http://127.0.0.1:8788/prover-worker.js", maxRedirects: 0 };

test("planted: a read that hangs up once is tried once more and answers; the route is not aborted", async () => {
  const r = route(HANG_UP(), RES);
  assert.equal(await fetchOrAbort(r, OPTS), RES);
  assert.deepEqual(r.calls.fetch, [OPTS, OPTS]);
  assert.deepEqual(r.calls.abort, []);
});

test("planted: a read that hangs up twice aborts the route as a failed request and resolves null, never rejects", async () => {
  const r = route(HANG_UP(), HANG_UP());
  assert.equal(await fetchOrAbort(r, OPTS), null);
  assert.equal(r.calls.fetch.length, 2);
  assert.deepEqual(r.calls.abort, ["failed"]);
});

test("planted: any other failure aborts at once, with no second read", async () => {
  for (const e of [new Error("apiRequestContext.fetch: getaddrinfo ENOTFOUND confidential.unrealized.trade"), new Error("Request context disposed.")]) {
    const r = route(e, RES);
    assert.equal(await fetchOrAbort(r), null);
    assert.equal(r.calls.fetch.length, 1);
    assert.deepEqual(r.calls.abort, ["failed"]);
  }
});

test("a read that answers is returned as it is, once", async () => {
  const r = route(RES);
  assert.equal(await fetchOrAbort(r, OPTS), RES);
  assert.equal(r.calls.fetch.length, 1);
  assert.deepEqual(r.calls.abort, []);
});

// every tracked file that routes a page (Playwright's .route() reads route.fetch only through fetchOrAbort
const ROUTE_FETCH = /\b(?!globalThis\b|window\b|self\b)\w+\.fetch\((?:\)|\{)/;
function bareRouteFetches(files) {
  const out = [];
  for (const [f, text] of files) {
    if (f === "scripts/live-checks/route-fetch.mjs" || !/\.route\(/.test(text)) continue;
    text.split("\n").forEach((l, i) => ROUTE_FETCH.test(l) && out.push(`${f}:${i + 1}`));
  }
  return out;
}

test("planted: a bare route.fetch in a file that routes a page is refused; fetchOrAbort's are not", () => {
  assert.deepEqual(bareRouteFetches([["a.mjs", 'await ctx.route("**/*", async (r) => r.fulfill({ response: await r.fetch({ url }) }));']]), ["a.mjs:1"]);
  assert.deepEqual(bareRouteFetches([["b.mjs", "await page.route(u, async (rt) => {\n  const res = await rt.fetch();\n});"]]), ["b.mjs:2"]);
  assert.deepEqual(bareRouteFetches([["c.mjs", 'await ctx.route("**/*", async (r) => { const res = await fetchOrAbort(r, { url }); });\nconst x = await fetch(u); globalThis.fetch({});']]), []);
  assert.deepEqual(bareRouteFetches([["d.mjs", "const res = await r.fetch({ url });"]]), [], "no route in the file: not a route handler");
});

test("no tracked file that routes a page calls route.fetch but through fetchOrAbort", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.mjs", "*.js", "*.ts"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f && !f.includes("node_modules/") && f !== "scripts/live-checks/route-fetch.test.mjs");
  assert.deepEqual(bareRouteFetches(files.map((f) => [f, readFileSync(path.join(ROOT, f), "utf8")])), []);
});
