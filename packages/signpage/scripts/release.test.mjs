// The release list's generator (release-list.mjs) and check-signpage's comparer (check-signpage.mjs), on two small
// builds served by a stand-in for Pages: each path its file (index.html at /), every unknown path the fallback page /,
// every response under the matching _headers rules joined as Pages joins them.
//   node --test packages/signpage/scripts/release.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { bundle, SERVED, SIGN_BUILD_INPUTS } from "./build-app.mjs";
import { SIGN_BUILD_CONFIG, SIGN_BUILD_OUTPUTS } from "../../../scripts/ci/sign-build-inputs.mjs";
import { build as buildSign } from "./deploy.mjs";
import { judge, namesOf, onlyHost, read, readList, WEBAUTHN } from "./check-signpage.mjs";
import { diffLists, headersFor, HOSTS, ledgerProblems, listDir, main as listMain, makeList, matches, newestRelease, newestReleaseOnHead, parseRules, publishedPath, RELEASED, releaseTreeProblems, unreleasedProblems } from "./release-list.mjs";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";
import { signBuilt } from "../../../scripts/signpage-built.mjs";

const PKG = signBuilt(); // the page's build, made from this tree's sources first (card signpage-generated-merge-free)
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

// ---------- the ledger: old releases never change, on every branch; the newest names the build a sign deploy serves ----------

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const STALE = "the newest release, is not this SIGN_HOST build";
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
/** deploy.mjs build() of `pkg`, handed to `f`, then removed. */
function withBuild(pkg, f) {
  const built = buildSign(pkg);
  try {
    return f(built);
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
}
/** The list text release-list.mjs writes for SIGN_HOST's build of `pkg`, named `tag`. */
const listText = (tag, pkg = PKG) => withBuild(pkg, (b) => `${JSON.stringify(makeList(tag, { SIGN_HOST: b }, null), null, 1)}\n`);

test("every committed release is as written", () => {
  assert.deepEqual(ledgerProblems(), []);
  for (const [tag, sha] of Object.entries(RELEASED)) assert.equal(sha256(readFileSync(join(PKG, "releases", `${tag}.json`))), sha, tag);
});

test("planted: on a card branch, a SIGN_HOST change with no new release leaves the ledger clean; an old release edited after it was written fails", () => {
  const dir = releasesCopy();
  const pkg = pkgCopy();
  try {
    // what SIGN_HOST serves changed, no release cut: the branch's ledger holds; only a deploy of it is refused
    writeFileSync(join(pkg, "public", "app.js"), `${readFileSync(join(pkg, "public", "app.js"), "utf8")} `);
    assert.deepEqual(ledgerProblems(dir), []);
    assert.ok(withBuild(pkg, (b) => unreleasedProblems(b, dir)).some((l) => l.includes(STALE)));
    const f = join(dir, "release-1.json");
    writeFileSync(f, readFileSync(f, "utf8").replace(/"bytes": (\d+)/, (_, n) => `"bytes": ${Number(n) + 1}`));
    assert.deepEqual(ledgerProblems(dir).map((l) => l.split(" (")[0]), ["release-1 was edited after it was written"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("planted: a deploy's build that the newest list does not name fails: /, /app.js, the worker, a header, an extra file", () => {
  // the newest list names this tree's build: release-<N+1> past every committed one, beside them, in the ledger
  const n = Math.max(...Object.keys(RELEASED).map((t) => Number(t.slice("release-".length))));
  const [tag, next] = [`release-${n + 1}`, `release-${n + 2}`];
  const dir = releasesCopy();
  const text = listText(tag);
  writeFileSync(join(dir, `${tag}.json`), text);
  const ledger = { ...RELEASED, [tag]: sha256(text) };
  const planted = (file, edit) => {
    const pkg = pkgCopy();
    try {
      const f = join(pkg, file);
      writeFileSync(f, edit(existsSync(f) ? readFileSync(f, "utf8") : ""));
      return withBuild(pkg, (b) => unreleasedProblems(b, dir, ledger));
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  };
  const one = (p, what) => {
    assert.equal(p.length, 1, p.join("\n"));
    assert.ok(p[0].startsWith(`${tag}, ${STALE} (SIGN_HOST ${what}`) && p[0].includes(`: cut ${next} on a branch from origin/main's head`), p[0]);
  };
  try {
    assert.deepEqual(withBuild(PKG, (b) => unreleasedProblems(b, dir, ledger)), []);
    one(planted("public/app.js", (t) => `${t} `), "/app.js:");
    one(planted("index.html", () => "<!doctype html>"), "/:");
    one(planted("public/prover-worker.js", (t) => t.replace("{", "{ ")), "/prover-worker.js:");
    // a connect-src added to the page's policy: the _headers file and every file's headers differ
    const wider = planted("public/_headers", (t) => {
      assert.ok(t.includes("connect-src "));
      return t.replace("connect-src ", "connect-src https://evil.example ");
    });
    assert.ok(wider.some((l) => l.startsWith(`${tag}, ${STALE} (SIGN_HOST _headers:`)), wider.join("\n"));
    assert.ok(wider.some((l) => l.startsWith(`${tag}, ${STALE} (SIGN_HOST /app.js:`)), wider.join("\n"));
    one(planted("public/extra.js", () => "steal()"), "/extra.js: built, not in the list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: the newest list is picked by N, not by text (release-1000 after release-999)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-releases-"));
  try {
    // lo an old list (release-1's, not this build), hi this build's: hi is the newest, though "release-10…" sorts first as text
    const d = String(Math.max(...Object.keys(RELEASED).map((t) => Number(t.slice("release-".length))))).length + 1;
    const [lo, hi, next] = [`release-${10 ** d - 1}`, `release-${10 ** d}`, `release-${10 ** d + 1}`];
    const [old, mine] = [readFileSync(join(PKG, "releases", "release-1.json")), listText(hi)];
    writeFileSync(join(dir, `${lo}.json`), old);
    writeFileSync(join(dir, `${hi}.json`), mine);
    assert.equal(newestRelease(dir), hi);
    assert.deepEqual(withBuild(PKG, (b) => unreleasedProblems(b, dir, { [lo]: sha256(old), [hi]: sha256(mine) })), []);
    // and the other way round, hi the stale one, fails on hi
    writeFileSync(join(dir, `${lo}.json`), mine);
    writeFileSync(join(dir, `${hi}.json`), old);
    const p = withBuild(PKG, (b) => unreleasedProblems(b, dir, { [lo]: sha256(mine), [hi]: sha256(old) }));
    assert.ok(p.length && p.every((l) => l.startsWith(`${hi}, ${STALE}`) && l.includes(`: cut ${next} on a branch from origin/main's head`)), p.join("\n"));
    assert.equal(newestRelease(mkdtempSync(join(tmp, "none-"))), null);
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
    assert.ok(ledgerProblems(dir).some((l) => l.startsWith(`${unlisted} is not in RELEASED`)));
    assert.ok(ledgerProblems(dir, { ...RELEASED, [gone]: "0".repeat(64) }).includes(`${gone} is in RELEASED but its list is gone`));
    // the deploy is held to the ledger too: an unlisted newest list is refused even when it names the build
    assert.ok(withBuild(PKG, (b) => unreleasedProblems(b, dir)).some((l) => l.startsWith(`${unlisted} is not in RELEASED`)));
    assert.deepEqual(ledgerProblems(mkdtempSync(join(tmp, "empty-")), {}), ["no release list"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const copy = releasesCopy();
  try {
    const tag = Object.keys(RELEASED).at(-1);
    assert.deepEqual(listMain([tag], copy), { code: 1, err: [`${tag} is already written: a release is never written again`] });
    // N is exactly the newest plus one: a jump (release-1060 after release-106) is refused before any build or write
    const n = Number(tag.slice("release-".length));
    for (const skip of [`release-${n + 2}`, `release-${n * 10}`])
      assert.deepEqual(listMain([skip], copy), { code: 1, err: [`${skip} is not the next release: the newest list is ${tag}, so the next is release-${n + 1}`] });
    assert.ok(!existsSync(join(copy, `release-${n + 2}.json`)));
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

test("the command line prints every line, its verdict last, to a pipe: a long NO MATCH is not cut off at exit", async () => {
  // 32 BAD lines of whole CSPs, about 90 KB, which the live-check replays cut on a loaded Mac: more than a pipe holds, so
  // the tail waits in the process until it is read
  // (macOS writes a pipe asynchronously; process.exit() dropped what was queued, the verdict with it, 8 Nov)
  const answers = JSON.parse(readFileSync(join(dirname(dirname(PKG)), "scripts", "live-checks", "signpage-release-at-deploy.answers.json"), "utf8"));
  const list = onlyHost(readList(answers.bad.release), "sign");
  const answer = structuredClone(answers.bad);
  // and 70 more files, read as /app.js was, each listed with an 8 KB policy it was not served: 140 lines of about 10 KB
  // more, so the run prints well over 1 MB and the old exit cuts it every time
  for (let i = 0; i < 70; i++) {
    const path = `/planted-${i}.js`;
    list.hosts.SIGN_HOST.files.push({ path, bytes: 1, sha256: "0".repeat(64), headers: { "content-security-policy": "x".repeat(8000) } });
    answer.hosts.SIGN_HOST.files[path] = structuredClone(answer.hosts.SIGN_HOST.files["/app.js"]);
  }
  const [listFile, answerFile] = [join(tmp, "late-list.json"), join(tmp, "late-answer.json")];
  writeFileSync(listFile, JSON.stringify(list));
  writeFileSync(answerFile, JSON.stringify(answer));
  const child = spawn(process.execPath, [join(PKG, "scripts", "check-signpage.mjs"), "--list", listFile, "--answer", answerFile], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  // a reader that falls behind once, as a loaded machine does: after the first chunk it waits 300 ms
  child.stdout.on("data", (c) => {
    if (!chunks.length) {
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 300);
    }
    chunks.push(c);
  });
  const code = await new Promise((r) => child.on("close", r));
  const lines = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n");
  assert.equal(code, 1);
  assert.ok(Buffer.concat(chunks).length > 1 << 20, `${Buffer.concat(chunks).length} bytes`);
  assert.match(lines.at(-1), /^NO MATCH release-105: 172 line\(s\) differ$/, `the last of ${lines.length} lines: ${lines.at(-1).slice(0, 120)}`);
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

test("SIGN_HOST's build reads only SIGN_BUILD_INPUTS, the paths the verify gate compares a list's tree on, and each of them", async () => {
  const repo = dirname(dirname(PKG));
  // card signpage-generated-merge-free: the bundle is built at the deploy, so what it reads is every module it carries
  // (outside node_modules, which the lockfile pins: SIGN_BUILD_CONFIG), the tracked public/ files, and SERVED
  const { modules } = await bundle();
  const rel = (abs) => relative(repo, abs.split("?")[0]).split(sep).join("/");
  const own = modules.filter((id) => !id.startsWith("\0") && !/[\\/]node_modules[\\/]/.test(id)).map(rel);
  assert.ok(own.some((p) => p.startsWith("packages/wallet/src/")) && own.some((p) => p.startsWith("packages/kit/src/")), own.join("\n"));
  // the bundler applies the nearest tsconfig.json above each module it transforms (review P2: one in packages/signpage,
  // packages/wallet or the root changes app.js), so every folder from a module's own up to the repository root may hold
  // one that the build reads, whether or not it exists today; above the root bundle() refuses one (outsideTsconfigs)
  const tsconfigs = new Set();
  for (const p of own) {
    const parts = p.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) tsconfigs.add([...parts.slice(0, i), "tsconfig.json"].join("/"));
  }
  const reads = [...own, ...tsconfigs, "packages/signpage/public/_headers", "packages/kit/src/prover/build.mjs", ...SERVED.map((e) => rel(e.from)), ...SIGN_BUILD_CONFIG];
  for (const p of reads) assert.ok(SIGN_BUILD_INPUTS.some((i) => p === i || p.startsWith(`${i}/`)), `${p} is read by the build, not in SIGN_BUILD_INPUTS`);
  for (const i of SIGN_BUILD_INPUTS) assert.ok(reads.some((p) => p === i || p.startsWith(`${i}/`)), `${i} is in SIGN_BUILD_INPUTS, read by no build step`);
  // no build output is an input: a list's tree is compared on sources only
  for (const o of SIGN_BUILD_OUTPUTS) assert.ok(!SIGN_BUILD_INPUTS.includes(o), o);
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

// delta review P3-2: the prover's two built files are named by the kit (PROVER_WORKER_FILE, PROVER_THREAD_FILE).
// SIGN_BUILD_OUTPUTS, which .gitignore and the build-output gate are held to, sits in scripts/ci, which may not read a kit
// internal (check:imports' kit-reach refuses even the path), so this test holds its two prover entries to those names
test("SIGN_BUILD_OUTPUTS names the prover's files by the kit's PROVER_WORKER_FILE and PROVER_THREAD_FILE, and .gitignore ignores each", async () => {
  const { PROVER_THREAD_FILE, PROVER_WORKER_FILE } = await import("../../kit/src/prover/build.mjs");
  assert.deepEqual(SIGN_BUILD_OUTPUTS.slice(2), [`packages/signpage/public/${PROVER_WORKER_FILE}`, `packages/signpage/public/${PROVER_THREAD_FILE}`]);
  const ignore = readFileSync(join(PKG, "..", "..", ".gitignore"), "utf8").split("\n");
  for (const f of SIGN_BUILD_OUTPUTS) assert.ok(ignore.includes(`/${f}`), `.gitignore names /${f}`);
});

// review P1(a): the bundle is built on the release machine, so CI rebuilds it on its own clean install and holds the
// newest list to it whenever that list's tree has HEAD's SIGN_BUILD_INPUTS (a release merge, or a release branch): a list
// cut from a machine whose bytes are not the sources' build (a tsconfig above the repo, an edited node_modules) fails here
test("the newest release list is this runner's clean build whenever its tree has HEAD's SIGN_BUILD_INPUTS", (t) => {
  const r = newestReleaseOnHead();
  // heavy.sh's remote box holds no history (scripts/heavy-remote.sh), so the list's tree is not there: CI's test-packages
  // job (fetch-depth: 0) holds this test; anywhere else a missing tree fails it
  if (r.missing && process.env.HEAVY_JOB) return t.skip(`${r.problems[0]}: held by CI's test-packages job, which checks out the whole history`);
  assert.deepEqual(r.problems, [], r.problems.join("\n"));
  if (!r.applies) assert.ok(r.newest, "a newest list to compare");
});

test("planted: a newest list naming HEAD's tree passes as this build, and fails with one byte of its /app.js changed", () => {
  const n = Math.max(...Object.keys(RELEASED).map((t) => Number(t.slice("release-".length))));
  const tag = `release-${n + 1}`;
  const tree = spawnSync("git", ["-C", PKG, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).stdout.trim();
  const list = JSON.parse(listText(tag));
  const plant = (edit) => {
    const dir = releasesCopy();
    const text = `${JSON.stringify(edit({ ...structuredClone(list), tree }), null, 1)}\n`;
    writeFileSync(join(dir, `${tag}.json`), text);
    try {
      return newestReleaseOnHead(dir, { ...RELEASED, [tag]: sha256(text) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const same = plant((l) => l);
  assert.equal(same.applies, true);
  assert.deepEqual(same.problems, []);
  const byte = plant((l) => {
    const app = l.hosts.SIGN_HOST.files.find((f) => f.path === "/app.js");
    app.sha256 = `${app.sha256.slice(0, -1)}${app.sha256.at(-1) === "0" ? "1" : "0"}`;
    return l;
  });
  assert.equal(byte.applies, true);
  assert.ok(byte.problems.some((l) => l.includes(`${tag}, the newest release, is not this SIGN_HOST build (SIGN_HOST /app.js`)), byte.problems.join("\n"));
  // a list whose tree's inputs are not HEAD's (here: the empty tree) is not held to this build
  const other = plant((l) => ({ ...l, tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" }));
  assert.equal(other.applies, false);
  // a list naming a tree this clone does not hold is missing, never a pass (review P3-1: the box has no history)
  const gone = plant((l) => ({ ...l, tree: "1".repeat(40) }));
  assert.equal(gone.missing, true);
  assert.match(gone.problems.join("\n"), /does not hold: check out the whole history \(fetch-depth: 0\)/);
});

// review P1: the deploy is held to the newest list's tree too. Bytes equal to the list are not enough: a list cut from
// other inputs (a tainted release machine, then a lockfile bump on main) was never compared to a clean build of HEAD
test("planted: a newest list whose tree has other SIGN_HOST build inputs than HEAD is refused for the deploy, whatever bytes it names", () => {
  const n = Math.max(...Object.keys(RELEASED).map((t) => Number(t.slice("release-".length))));
  const tag = `release-${n + 1}`;
  const head = spawnSync("git", ["-C", PKG, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).stdout.trim();
  const list = JSON.parse(listText(tag));
  const at = (tree) => {
    const dir = releasesCopy();
    writeFileSync(join(dir, `${tag}.json`), `${JSON.stringify({ ...structuredClone(list), tree }, null, 1)}\n`);
    try {
      return releaseTreeProblems(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.deepEqual(at(head), []);
  const differ = at("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.match(differ.join("\n"), new RegExp(`${tag} was cut from other SIGN_HOST build inputs than HEAD's \\(LICENSE, package\\.json, .*, \\.\\.\\.\\), so no clean build of HEAD was compared to it: cut release-${n + 2}`));
  assert.match(at("1".repeat(40)).join("\n"), /which this clone does not hold/);
  assert.match(at(undefined).join("\n"), /names tree undefined, which this clone does not hold/);
});
