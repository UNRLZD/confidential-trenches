// The release list's generator (release-list.mjs) and check-signpage's comparer (check-signpage.mjs), on two small
// builds served by a stand-in for Pages: each path its file (index.html at /), every unknown path the fallback page /,
// every response under the matching _headers rules joined as Pages joins them.
//   node --test packages/signpage/scripts/release.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, namesOf, read, readList, WEBAUTHN } from "./check-signpage.mjs";
import { diffLists, headersFor, HOSTS, listDir, makeList, matches, parseRules, publishedPath } from "./release-list.mjs";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const ZK = "a".repeat(64);
const SIGN_HEADERS = `# a comment
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'
  X-Content-Type-Options: nosniff
/prover-worker.js
  Content-Security-Policy: default-src 'none'; connect-src 'self'
/assets/zk/*
  Cache-Control: public, max-age=31536000, immutable
`;
const APP_HEADERS = `/*
  Content-Security-Policy: default-src 'none'; frame-ancestors https://sign.confidential.unrealized.trade
  Integrity-Policy: blocked-destinations=(script)
`;
const SITES = {
  SIGN_HOST: {
    _headers: SIGN_HEADERS,
    "index.html": `<!doctype html><script type="module" src="/app.js" integrity="sha384-x"></script>`,
    "app.js": "console.log('sign')",
    "prover-worker.js": "self.onmessage = () => {}",
    [`assets/zk/${ZK}.zkey`]: "zkey bytes",
  },
  APP_HOST: {
    _headers: APP_HEADERS,
    "index.html": `<!doctype html><link rel="preload" href="/assets/f.woff2" as="font"><script type="module" src="/assets/index-a.js"></script><link rel="stylesheet" href="/assets/style.css">`,
    "assets/index-a.js": "console.log('app')",
    "assets/style.css": "body{}",
    "assets/f.woff2": "font",
  },
};

const tmp = mkdtempSync(join(tmpdir(), "ct-release-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** Writes `files` into a fresh folder and returns its path. */
function site(files) {
  const d = join(tmp, String(n++));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}
const dirsOf = (sites) => Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, site(v)]));
const LIST = makeList("release-1", dirsOf(SITES), "0".repeat(40));

/** A stand-in for Pages serving `sites` ({ host name: { path: body } }) at HOSTS' origins. */
function pages(sites, { headers: extra = {} } = {}) {
  const byOrigin = Object.fromEntries(Object.entries(sites).map(([k, v]) => [HOSTS[k], v]));
  return async (url, opts) => {
    const u = new URL(url);
    const files = byOrigin[u.origin];
    if (!files) throw new Error(`no host ${u.origin}`);
    assert.equal(opts.redirect, "manual");
    const rel = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    const hit = rel !== "_headers" && Object.hasOwn(files, rel);
    const path = hit ? u.pathname : "/";
    const body = hit ? files[rel] : files["index.html"];
    const h = new Headers({ "content-type": (hit ? rel : "index.html").endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    for (const [k, v] of Object.entries(headersFor(parseRules(files._headers), path))) h.set(k, v);
    for (const [k, v] of Object.entries(extra[u.pathname] ?? {})) h.set(k, v);
    return new Response(body, { status: 200, headers: h });
  };
}
/** SITES with `f` applied to a copy. */
const changed = (f) => {
  const s = structuredClone(SITES);
  f(s);
  return s;
};
const check = async (fetchFn) => judge(LIST, await read(LIST, fetchFn, "/release-check-probe"));
const noMatch = (r, line) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^NO MATCH release-1: \d+ line\(s\) differ$/);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${line}`)), `no "BAD ${line}" in:\n${r.lines.join("\n")}`);
};

// ---------- the generator ----------

test("the list names every served file at its published path, index.html at /, never _headers", () => {
  assert.deepEqual(LIST.hosts.SIGN_HOST.files.map((f) => f.path), ["/", "/app.js", `/assets/zk/${ZK}.zkey`, "/prover-worker.js"]);
  assert.deepEqual(LIST.hosts.APP_HOST.files.map((f) => f.path), ["/", "/assets/f.woff2", "/assets/index-a.js", "/assets/style.css"]);
  const app = LIST.hosts.SIGN_HOST.files[1];
  const bytes = Buffer.from(SITES.SIGN_HOST["app.js"]);
  assert.deepEqual([app.bytes, app.sha256, app.sha384], [bytes.length, createHash("sha256").update(bytes).digest("hex"), `sha384-${createHash("sha384").update(bytes).digest("base64")}`]);
  assert.equal(LIST.hosts.SIGN_HOST.headers_file.sha256, createHash("sha256").update(SIGN_HEADERS).digest("hex"));
  assert.equal(LIST.hosts.SIGN_HOST.origin, "https://sign.confidential.unrealized.trade");
  assert.equal(LIST.release, "release-1");
});

test("each file carries the headers of every rule that matches it, one header's values joined as Pages joins them", () => {
  const h = Object.fromEntries(LIST.hosts.SIGN_HOST.files.map((f) => [f.path, f.headers]));
  assert.deepEqual(h["/prover-worker.js"], {
    "content-security-policy": "default-src 'none'; script-src 'self', default-src 'none'; connect-src 'self'",
    "x-content-type-options": "nosniff",
  });
  assert.equal(h[`/assets/zk/${ZK}.zkey`]["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(h["/"]["cache-control"], undefined);
  assert.ok(matches("/*", "/"));
  assert.ok(matches("/a/:id/b", "/a/x/b"));
  assert.ok(!matches("/a/:id/b", "/a/x/y/b"));
  assert.ok(!matches("/prover-worker.js", "/prover-workerXjs"));
});

test("the generator refuses what it cannot model: another .html page, a _redirects file, no _headers, a bad tag", () => {
  assert.equal(publishedPath("docs/index.html"), "/docs/");
  assert.throws(() => publishedPath("about.html"), /about\.html/);
  assert.throws(() => listDir(site({ ...SITES.SIGN_HOST, _redirects: "/a /b" })), /_redirects/);
  const { _headers, ...rest } = SITES.APP_HOST;
  assert.throws(() => listDir(site(rest)), /no _headers/);
  assert.throws(() => makeList("v1", dirsOf(SITES), "x"), /release-<N>/);
  assert.throws(() => parseRules("  X: y\n"), /cannot be read/);
});

test("two builds of the same files give the same list; a build with one changed byte is named", () => {
  assert.deepEqual(diffLists(makeList("release-1", dirsOf(SITES), "1".repeat(40)), LIST), []);
  const p = diffLists(makeList("release-1", dirsOf(changed((s) => (s.SIGN_HOST["app.js"] += " "))), "x"), LIST);
  assert.equal(p.length, 1);
  assert.match(p[0], /^SIGN_HOST \/app\.js: the build's /);
  assert.deepEqual(diffLists(makeList("release-1", dirsOf(changed((s) => (s.APP_HOST._headers += "  X-A: b\n"))), "x"), LIST).slice(0, 1), ["APP_HOST _headers: the build's is not the list's"]);
});

test("the committed release-1 names both hosts' pages and scripts, the worker and the six setup files, each with its headers", () => {
  const list = readList("release-1");
  assert.equal(list.release, "release-1");
  assert.match(list.commit, /^[0-9a-f]{40}$/);
  const sign = Object.fromEntries(list.hosts.SIGN_HOST.files.map((f) => [f.path, f]));
  for (const p of ["/", "/app.js", "/prover-worker.js"]) assert.ok(sign[p], p);
  for (const [name, pin] of Object.entries(ZK_SETUP_FILES)) {
    const f = sign[`/assets/zk/${pin.sha256}.${name.split(".").pop()}`];
    assert.ok(f, name);
    assert.deepEqual([f.bytes, f.sha256, f.headers["cache-control"]], [pin.bytes, pin.sha256, "public, max-age=31536000, immutable"]);
  }
  assert.equal(sign["/prover-worker.js"].headers["content-security-policy"].split(", default-src").length, 2, "the worker's two policies");
  assert.equal(sign["/"].sha256, createHash("sha256").update(readFileSync(join(PKG, "index.html"))).digest("hex"));
  const app = list.hosts.APP_HOST.files;
  assert.ok(app.some((f) => f.path === "/") && app.some((f) => /^\/assets\/index-[\w-]+\.js$/.test(f.path)));
  for (const h of Object.values(list.hosts)) {
    assert.match(h.headers_file.sha384, /^sha384-[A-Za-z0-9+/]{64}$/);
    for (const f of h.files) assert.ok(f.headers["content-security-policy"], `${f.path} has the site's policy`);
  }
  assert.ok(!existsSync(join(PKG, "releases", "release-0.json")));
});

// ---------- the comparer ----------

test("a matching set: every file in both modes, the probes answered by the fallback page: MATCH", async () => {
  const r = await check(pages(SITES));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "MATCH release-1");
  assert.equal(r.lines.length, (4 + 4) * 2 + 2 * 2 * 2 + 1);
  assert.ok(r.lines.includes(`ok  SIGN_HOST ${WEBAUTHN} (navigate): the release's fallback page /`));
});

test("one changed byte in one file: no MATCH, the path named", async () => {
  noMatch(await check(pages(changed((s) => (s.SIGN_HOST["prover-worker.js"] = s.SIGN_HOST["prover-worker.js"].replace("{", "["))))), "SIGN_HOST /prover-worker.js (navigate): 25 B sha256 ");
  noMatch(await check(pages(changed((s) => (s.APP_HOST["assets/index-a.js"] += "x")))), "APP_HOST /assets/index-a.js (fetch): ");
});

test("a missing file: no MATCH, the path named (Pages answers it with the fallback page)", async () => {
  const r = await check(pages(changed((s) => delete s.SIGN_HOST[`assets/zk/${ZK}.zkey`])));
  noMatch(r, `SIGN_HOST /assets/zk/${ZK}.zkey (navigate): `);
  noMatch(r, `SIGN_HOST /assets/zk/${ZK}.zkey (fetch): `);
  const gone = await read(LIST, pages(SITES), "/p");
  delete gone.hosts.APP_HOST.files["/assets/style.css"];
  noMatch(judge(LIST, gone), "APP_HOST /assets/style.css (navigate): not read");
  noMatch(judge(LIST, { ...gone, hosts: { SIGN_HOST: gone.hosts.SIGN_HOST } }), "APP_HOST https://confidential.unrealized.trade: not read");
});

test("an extra script on a host: no MATCH, the script named", async () => {
  const added = changed((s) => {
    s.APP_HOST["index.html"] += `<script src="/assets/extra.js"></script>`;
    s.APP_HOST["assets/extra.js"] = "steal()";
  });
  noMatch(await check(pages(added)), "APP_HOST / (navigate) loads /assets/extra.js, which the release does not name");
  noMatch(await check(pages(changed((s) => (s.SIGN_HOST["index.html"] += "<script>steal()</script>")))), "SIGN_HOST / (fetch) loads (inline), which the release does not name");
  noMatch(await check(pages(changed((s) => (s.SIGN_HOST["index.html"] += `<script src="https://evil.example/x.js"></script>`)))), "SIGN_HOST / (navigate) loads https://evil.example/x.js");
  // a file served at a path the release does not name, where the fallback page belongs
  noMatch(await check(pages(changed((s) => (s.SIGN_HOST[".well-known/webauthn"] = `{"origins":["https://evil.example"]}`)))), `SIGN_HOST ${WEBAUTHN} (navigate): 200, `);
  noMatch(await check(pages(changed((s) => (s.APP_HOST["release-check-probe"] = "steal()")))), "APP_HOST /release-check-probe (fetch): 200, 7 B");
});

test("a changed header: no MATCH, the path and the header named", async () => {
  const weaker = { "/prover-worker.js": { "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-eval'" } };
  noMatch(await check(pages(SITES, { headers: weaker })), `SIGN_HOST /prover-worker.js (navigate): content-security-policy "default-src 'none'; script-src 'self' 'unsafe-eval'", the release's`);
  noMatch(await check(pages(changed((s) => (s.APP_HOST._headers = s.APP_HOST._headers.replace("  Integrity-Policy: blocked-destinations=(script)\n", ""))))), "APP_HOST / (navigate): integrity-policy none, the release's");
  noMatch(await check(pages(SITES, { headers: { [`/assets/zk/${ZK}.zkey`]: { "cache-control": "no-store" } } })), `SIGN_HOST /assets/zk/${ZK}.zkey (fetch): cache-control "no-store"`);
});

test("a redirect, or a host that answers a navigation and a plain fetch differently: no MATCH", async () => {
  const base = pages(SITES);
  const moved = async (url, opts) => (new URL(url).pathname === "/" ? new Response(null, { status: 308, headers: { location: "/x" } }) : base(url, opts));
  noMatch(await check(moved), "SIGN_HOST / (navigate): answers 308, want 200");
  const cloaked = async (url, opts) => {
    const r = await base(url, opts);
    return opts.headers["sec-fetch-mode"] === "navigate" && new URL(url).pathname === "/app.js" ? new Response("evil", { status: 200, headers: r.headers }) : r;
  };
  const r = await check(cloaked);
  noMatch(r, "SIGN_HOST /app.js (navigate): 4 B");
  assert.ok(r.lines.some((l) => l.startsWith("ok  SIGN_HOST /app.js (fetch)")));
});

test("namesOf reads script srcs, inline scripts and preload, modulepreload and stylesheet hrefs, any case and quoting", () => {
  assert.deepEqual(namesOf(`<SCRIPT src='/a.js'></SCRIPT><script>x</script><link rel="modulepreload" href=/b.js><link rel="icon" href="/i.png"><link rel="Stylesheet" href="/s.css"><link rel="preload" as="worker" href="/w.js">`), ["/a.js", "(inline)", "/b.js", "/s.css", "/w.js"]);
});
