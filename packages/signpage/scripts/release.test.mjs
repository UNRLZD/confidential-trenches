// The release list's generator (release-list.mjs) and check-signpage's comparer (check-signpage.mjs), on two small
// builds served by a stand-in for Pages: each path its file (index.html at /), every unknown path the fallback page /,
// every response under the matching _headers rules joined as Pages joins them.
//   node --test packages/signpage/scripts/release.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SERVED, SIGN_BUILD_INPUTS } from "./build-app.mjs";
import { build as buildSign } from "./deploy.mjs";
import { judge, namesOf, onlyHost, read, readList, WEBAUTHN } from "./check-signpage.mjs";
import { diffLists, headersFor, HOSTS, listDir, main as listMain, makeList, matches, parseRules, publishedPath, RELEASED, releaseProblems } from "./release-list.mjs";
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
  Content-Security-Policy: default-src 'none'; frame-ancestors https://confidential.unrealized.trade
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
  assert.match(r.lines.at(-1), /^NO MATCH \S+: \d+ line\(s\) differ$/);
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
  assert.equal(LIST.hosts.SIGN_HOST.origin, "https://confidential.unrealized.trade");
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
  // the list's page is this tree's index.html with the release's own /app.js pinned in it: a page change after the
  // release (a new app.js, so a new integrity) is the next release's, while any other change to the page fails here
  const page = readFileSync(join(PKG, "index.html"), "utf8").replace(/(src="\/app\.js" integrity=")[^"]+(")/, `$1${sign["/app.js"].sha384}$2`);
  assert.equal(sign["/"].sha256, createHash("sha256").update(page).digest("hex"));
  const app = list.hosts.APP_HOST.files;
  assert.ok(app.some((f) => f.path === "/") && app.some((f) => /^\/assets\/index-[\w-]+\.js$/.test(f.path)));
  for (const h of Object.values(list.hosts)) {
    assert.match(h.headers_file.sha384, /^sha384-[A-Za-z0-9+/]{64}$/);
    for (const f of h.files) assert.ok(f.headers["content-security-policy"], `${f.path} has the site's policy`);
  }
  assert.ok(!existsSync(join(PKG, "releases", "release-0.json")));
});

// ---------- the ledger: old releases never change, the newest is this checkout's SIGN_HOST build ----------

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const STALE = "is not this checkout's SIGN_HOST build";
/** A copy of the package's served sources (index.html and public/), the folder deploy.mjs build() reads, to plant in. */
function pkgCopy() {
  const dir = mkdtempSync(join(tmpdir(), "ct-signpage-pkg-"));
  writeFileSync(join(dir, "index.html"), readFileSync(join(PKG, "index.html")));
  cpSync(join(PKG, "public"), join(dir, "public"), { recursive: true });
  return dir;
}
/** A copy of releases/ to plant in. */
function releasesCopy() {
  const dir = mkdtempSync(join(tmpdir(), "ct-releases-"));
  for (const f of readdirSync(join(PKG, "releases"))) writeFileSync(join(dir, f), readFileSync(join(PKG, "releases", f)));
  return dir;
}

test("every committed release is as written, and the newest is this checkout's SIGN_HOST build", () => {
  assert.deepEqual(releaseProblems(), []);
  for (const [tag, sha] of Object.entries(RELEASED)) assert.equal(sha256(readFileSync(join(PKG, "releases", `${tag}.json`))), sha, tag);
});

test("planted: an old release edited after it was written fails", () => {
  const dir = releasesCopy();
  try {
    const f = join(dir, "release-1.json");
    writeFileSync(f, readFileSync(f, "utf8").replace(/"bytes": (\d+)/, (_, n) => `"bytes": ${Number(n) + 1}`));
    assert.deepEqual(releaseProblems(dir).filter((l) => !l.includes(STALE)).map((l) => l.split(" (")[0]), ["release-1 was edited after it was written"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: any change to what SIGN_HOST serves, with no new release, fails: /, /app.js, the worker, a header", () => {
  const newest = Object.keys(RELEASED).at(-1);
  const next = `release-${Number(newest.slice(8)) + 1}`;
  const planted = (file, edit) => {
    const pkg = pkgCopy();
    try {
      const f = join(pkg, file);
      writeFileSync(f, edit(readFileSync(f, "utf8")));
      return releaseProblems(undefined, undefined, pkg);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  };
  const one = (p, what) => {
    assert.equal(p.length, 1, p.join("\n"));
    assert.ok(p[0].startsWith(`${newest} ${STALE} (SIGN_HOST ${what}`) && p[0].endsWith(`: write ${next}`), p[0]);
  };
  one(planted("public/app.js", (t) => `${t} `), "/app.js:");
  one(planted("index.html", () => "<!doctype html>"), "/:");
  one(planted("public/prover-worker.js", (t) => t.replace("{", "{ ")), "/prover-worker.js:");
  // a connect-src added to the page's policy: the _headers file and every file's headers differ
  const wider = planted("public/_headers", (t) => {
    assert.ok(t.includes("connect-src "));
    return t.replace("connect-src ", "connect-src https://evil.example ");
  });
  assert.ok(wider.some((l) => l.startsWith(`${newest} ${STALE} (SIGN_HOST _headers:`)), wider.join("\n"));
  assert.ok(wider.some((l) => l.startsWith(`${newest} ${STALE} (SIGN_HOST /app.js:`)), wider.join("\n"));
  // a file served that the list does not name
  const pkg = pkgCopy();
  try {
    writeFileSync(join(pkg, "public", "extra.js"), "steal()");
    one(releaseProblems(undefined, undefined, pkg), "/extra.js: built, not in the list");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("planted: the newest list is picked by N, not by text (release-1000 after release-999)", () => {
  const dir = releasesCopy();
  try {
    const newest = Object.keys(RELEASED).at(-1);
    // lo an old list (release-1's, not this build), hi this build's: hi is the newest. Both past any real release (one
    // more digit than the ledger's newest), so a real list is never overwritten (hi sorts before lo as text)
    const d = String(Math.max(...Object.keys(RELEASED).map((t) => Number(t.slice("release-".length))))).length + 1;
    const [lo, hi, next] = [`release-${10 ** d - 1}`, `release-${10 ** d}`, `release-${10 ** d + 1}`];
    writeFileSync(join(dir, `${lo}.json`), readFileSync(join(dir, "release-1.json")));
    writeFileSync(join(dir, `${hi}.json`), readFileSync(join(dir, `${newest}.json`)));
    const ledger = { ...RELEASED, [lo]: RELEASED["release-1"], [hi]: RELEASED[newest] };
    assert.deepEqual(releaseProblems(dir, ledger), []);
    // and the other way round, hi the stale one, fails on hi
    writeFileSync(join(dir, `${lo}.json`), readFileSync(join(dir, `${newest}.json`)));
    writeFileSync(join(dir, `${hi}.json`), readFileSync(join(dir, "release-1.json")));
    const p = releaseProblems(dir, { ...RELEASED, [lo]: RELEASED[newest], [hi]: RELEASED["release-1"] });
    assert.ok(p.length && p.every((l) => l.startsWith(`${hi} ${STALE}`) && l.endsWith(`: write ${next}`)), p.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: a list not in the ledger, and a ledger entry whose list is gone, fail; a written release is never written again", () => {
  const dir = releasesCopy();
  try {
    // planted past the ledger's newest, so a cut release never takes a planted number
    const n = Math.max(...Object.keys(RELEASED).map((t) => Number(t.slice("release-".length))));
    const [unlisted, gone] = [`release-${n + 2}`, `release-${n + 1}`];
    writeFileSync(join(dir, `${unlisted}.json`), readFileSync(join(dir, "release-1.json")));
    assert.ok(releaseProblems(dir).some((l) => l.startsWith(`${unlisted} is not in RELEASED`)));
    assert.ok(releaseProblems(dir, { ...RELEASED, [gone]: "0".repeat(64) }).includes(`${gone} is in RELEASED but its list is gone`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const copy = releasesCopy();
  try {
    const tag = Object.keys(RELEASED).at(-1);
    assert.deepEqual(listMain([tag], copy), { code: 1, err: [`${tag} is already written: a release is never written again`] });
    // and in the default folder, releases/ itself: refused before any build or write, the list as written
    assert.deepEqual(listMain([tag]), { code: 1, err: [`${tag} is already written: a release is never written again`] });
    assert.equal(sha256(readFileSync(join(PKG, "releases", `${tag}.json`))), RELEASED[tag]);
    assert.equal(sha256(readFileSync(join(copy, `${tag}.json`))), RELEASED[tag]);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
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
  noMatch(judge(LIST, { ...gone, hosts: { SIGN_HOST: gone.hosts.SIGN_HOST } }), "APP_HOST https://ct-app.unrealized.trade: not read");
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

// ---------- one host against its own build ----------

test("one host against its own build: MATCH on a matching host, NO MATCH on one changed byte, the other host never read", async () => {
  const sign = makeList("build-0123456789ab", { SIGN_HOST: site(SITES.SIGN_HOST) }, "0".repeat(40));
  assert.deepEqual(Object.keys(sign.hosts), ["SIGN_HOST"]);
  const one = async (list, sites) => judge(list, await read(list, pages(sites), "/release-check-probe"));
  // APP_HOST lags (it serves other files): a check of SIGN_HOST alone still matches, and never asks APP_HOST
  const lagging = changed((s) => (s.APP_HOST["assets/index-a.js"] = "an older build"));
  const r = await one(sign, lagging);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "MATCH build-0123456789ab");
  assert.ok(!r.lines.some((l) => l.includes("APP_HOST")));
  const seen = [];
  const spy = pages(lagging);
  await read(sign, (u, o) => (seen.push(new URL(u).origin), spy(u, o)), "/p");
  assert.deepEqual([...new Set(seen)], [HOSTS.SIGN_HOST]);
  noMatch(await one(sign, changed((s) => (s.SIGN_HOST["app.js"] = s.SIGN_HOST["app.js"].replace("s", "S")))), "SIGN_HOST /app.js (navigate): ");
  // the same through onlyHost on a list of both: APP_HOST alone, SIGN_HOST lagging
  const app = onlyHost(LIST, "app");
  assert.deepEqual(Object.keys(app.hosts), ["APP_HOST"]);
  assert.equal((await one(app, changed((s) => (s.SIGN_HOST["app.js"] += "x")))).ok, true);
  noMatch(await one(app, changed((s) => (s.APP_HOST["assets/style.css"] = "body{color:red}"))), "APP_HOST /assets/style.css (fetch): ");
  assert.throws(() => onlyHost(LIST, "helper"), /sign or app/);
  assert.throws(() => onlyHost(sign, "app"), /holds no APP_HOST/);
  assert.throws(() => makeList("build-xyz", { SIGN_HOST: site(SITES.SIGN_HOST) }, "x"), /release-<N>/);
});

// ---------- the command line on this checkout's real builds ----------

const GEN = join(PKG, "scripts", "release-list.mjs");
/**
 * release-list.mjs with `args` under a fresh TMPDIR: { status, stdout, stderr, left } where left is what stayed in it,
 * but node-compile-cache (Vite turns on Node's module compile cache, which keeps its cache there by design).
 */
function gen(args) {
  const t = mkdtempSync(join(tmp, "tmpdir-"));
  const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TMPDIR: t, TMP: t, TEMP: t } });
  return { ...r, left: readdirSync(t).filter((f) => f !== "node-compile-cache") };
}

test("--print and --check build both hosts, and leave no build folder behind on success or on failure", () => {
  const p = gen(["--print"]);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(p.left, []);
  const head = JSON.parse(p.stdout);
  assert.match(head.release, /^build-[0-9a-f]{12}(-dirty)?$/);
  assert.deepEqual(Object.keys(head.hosts), ["SIGN_HOST", "APP_HOST"]);
  assert.ok(head.hosts.SIGN_HOST.files.some((f) => f.path === "/prover-worker.js"));
  const listFile = join(tmp, "head.json");
  writeFileSync(listFile, p.stdout);
  const ok = gen(["--check", "--list", listFile]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /equals build-/);
  assert.deepEqual(ok.left, [], "a passing --check left a build behind");
  const planted = structuredClone(head);
  planted.hosts.SIGN_HOST.files.find((f) => f.path === "/app.js").sha256 = "0".repeat(64);
  writeFileSync(listFile, JSON.stringify(planted));
  const bad = gen(["--check", "--list", listFile]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /SIGN_HOST \/app\.js: the build's [0-9a-f]{64} is not the list's 0{64}/);
  assert.deepEqual(bad.left, [], "a failing --check left a build behind");
});

test("--print --host builds and lists only the host asked; a bad argument is a usage error", () => {
  const p = gen(["--print", "--host", "app"]);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(Object.keys(JSON.parse(p.stdout).hosts), ["APP_HOST"]);
  assert.deepEqual(p.left, []);
  for (const args of [["--print", "--host", "helper"], ["--check"], ["v1"], ["--print", "x"]]) assert.equal(gen(args).status, 2, args.join(" "));
});

test("SIGN_HOST's build reads only SIGN_BUILD_INPUTS, the paths the verify gate compares a list's tree on, and each of them", () => {
  const repo = dirname(dirname(PKG));
  const reads = ["packages/signpage/index.html", "packages/signpage/public", ...SERVED.map((e) => relative(repo, e.from).split(sep).join("/"))];
  for (const p of reads) assert.ok(SIGN_BUILD_INPUTS.some((i) => p === i || p.startsWith(`${i}/`)), `${p} is read by the build, not in SIGN_BUILD_INPUTS`);
  for (const i of SIGN_BUILD_INPUTS) assert.ok(reads.some((p) => p === i || p.startsWith(`${i}/`)), `${i} is in SIGN_BUILD_INPUTS, read by no build step`);
  // deploy.mjs build() copies exactly index.html, public/ and SERVED: its built folder holds nothing else
  const built = buildSign();
  try {
    const served = new Set(["index.html", ...readdirSync(join(PKG, "public"), { recursive: true }).map(String), ...SERVED.map((e) => e.to)]);
    for (const f of readdirSync(built, { recursive: true }).map(String)) {
      if (statSync(join(built, f)).isDirectory()) continue;
      assert.ok(served.has(f.split(sep).join("/")), `build() wrote ${f}, from no input named`);
    }
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
});

test("APP_HOST's part of a list is built by the terminal deploy's own build(), so the list and the deploy are one build", () => {
  const src = readFileSync(join(PKG, "scripts", "release-list.mjs"), "utf8");
  assert.match(src, /import \{ build as buildTerminal \} from "\.\.\/\.\.\/\.\.\/apps\/terminal\/scripts\/deploy\.mjs";/);
  assert.doesNotMatch(src, /vite\.js/, "release-list.mjs runs no vite build of its own");
});
