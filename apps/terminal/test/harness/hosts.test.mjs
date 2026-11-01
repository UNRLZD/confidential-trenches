// node --test apps/terminal/test/harness/hosts.test.mjs: the harness's certificate and server without a browser.
// Every host is served over TLS with a certificate valid for its own name, under its own build's _headers file; an
// unmapped host, a path out of the build and the _headers file itself are refused; the key is gone after remove().
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHeadersFile } from "../../scripts/check-deploy.ts";
import { makeCert } from "./certs.mjs";
import { buildSignpage, defaultSites, HOSTS, MAPPED, SIGNPAGE, TERMINAL } from "./harness.mjs";
import { headersFor, startServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let cert;
let server;
let appRoot;
let signRoot;

// GET https://<name><urlPath> from the server, checking the certificate against <name> with the run's cert as the CA
const get = (name, urlPath = "/") =>
  new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: server.port, servername: name, path: urlPath, headers: { host: name }, ca: cert.cert }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });

before(async () => {
  cert = makeCert(MAPPED);
  // APP_HOST's real _headers file over a stand-in index.html: the test needs no build
  appRoot = mkdtempSync(path.join(tmpdir(), "ct-harness-app-"));
  cpSync(path.join(TERMINAL, "public/_headers"), path.join(appRoot, "_headers"));
  writeFileSync(path.join(appRoot, "index.html"), "<!doctype html><title>app</title>");
  signRoot = buildSignpage();
  server = await startServer({ cert: cert.cert, key: cert.key, sites: { ...defaultSites(signRoot), [HOSTS.app]: { root: appRoot, spa: true } } });
});

after(async () => {
  await server?.close();
  cert?.remove();
  rmSync(appRoot, { recursive: true, force: true });
  rmSync(signRoot, { recursive: true, force: true });
});

const fileHeaders = (file) => headersFor(parseHeadersFile(readFileSync(file, "utf8")).rules, "/");

test("every host serves over TLS with a certificate valid for its name, under its own build's _headers", async () => {
  const want = {
    [HOSTS.app]: fileHeaders(path.join(TERMINAL, "public/_headers")),
    [HOSTS.sign]: fileHeaders(path.join(SIGNPAGE, "public/_headers")),
    [HOSTS.sibling]: new Map(),
    [HOSTS.cross]: new Map(),
  };
  for (const [name, headers] of Object.entries(want)) {
    const r = await get(name);
    assert.equal(r.status, 200, name);
    for (const [k, v] of headers) assert.equal(r.headers[k], v, `${name} ${k}`);
    if (headers.size === 0) assert.equal(r.headers["content-security-policy"], undefined, name);
  }
  assert.ok(want[HOSTS.app].get("content-security-policy")?.includes("frame-ancestors https://sign.confidential.unrealized.trade;"));
  assert.match(want[HOSTS.sign].get("permissions-policy") ?? "", /publickey-credentials-create=\(self\)/);
  assert.match(want[HOSTS.sign].get("content-security-policy") ?? "", /frame-ancestors https:\/\/confidential\.unrealized\.trade/);
  // a route with no file is the SPA's index.html, as Pages serves a build with no 404.html
  assert.equal((await get(HOSTS.app, "/discover")).status, 200);
  assert.deepEqual(new Set(server.log.map((e) => e.host)), new Set(Object.values(HOSTS)));
});

test("an unmapped host, a path out of the build and the _headers file are refused", async () => {
  // the certificate covers *.ct.test, so the TLS check passes and the server refuses the name
  assert.equal((await get("nothere.ct.test")).status, 421);
  assert.equal((await get(HOSTS.sibling, "/../../harness.mjs")).status, 404);
  assert.equal((await get(HOSTS.sibling, "/..%2F..%2Fharness.mjs")).status, 404);
  assert.equal((await get(HOSTS.sign, "/_headers")).status, 404);
  assert.equal((await get(HOSTS.sign, "/%E0%A4%A")).status, 400);
  // a name the certificate does not cover fails the TLS check
  await assert.rejects(get("app.ct.example"), /altnames|Hostname\/IP does not match/);
});

test("the certificate's key exists only in its temp dir while a run lasts", () => {
  const c = makeCert(["*.ct.test"]);
  assert.ok(c.dir.startsWith(tmpdir()) || c.dir.startsWith("/private" + tmpdir()));
  assert.ok(existsSync(path.join(c.dir, "key.pem")));
  assert.match(c.spki, /^[A-Za-z0-9+/]{43}=$/);
  c.remove();
  assert.equal(existsSync(c.dir), false);
});

test("headersFor applies every matching rule in order, joins a repeat and honours a removal", () => {
  const { rules } = parseHeadersFile("/*\n  A: 1\n  B: 2\n/x/*\n  A: 3\n  ! B\n/y/:id\n  C: 4\n");
  assert.deepEqual([...headersFor(rules, "/")], [["a", "1"], ["b", "2"]]);
  assert.deepEqual([...headersFor(rules, "/x/z")], [["a", "1, 3"]]);
  assert.deepEqual([...headersFor(rules, "/y/7")], [["a", "1"], ["b", "2"], ["c", "4"]]);
  assert.deepEqual([...headersFor(rules, "/y/7/8")], [["a", "1"], ["b", "2"]]);
});
