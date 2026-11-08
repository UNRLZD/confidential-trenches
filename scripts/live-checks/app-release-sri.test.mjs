// node --test scripts/live-checks/app-release-sri.test.mjs: the live check replays recorded answers
// (app-release-sri.answers.json), each read on 2026-11-01. good: card app-in-shell's build served as APP_HOST by the app
// harness: PASS. liveBefore: APP_HOST as deployed before app-in-shell (frame-ancestors 'none'): FAIL. bad: the good
// build with one byte appended to its script after the build: FAIL. The other bad answers are the good one with one
// thing broken each: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read } from "./app-release-sri.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-release-sri.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const SIGN = "https://confidential.unrealized.trade";
const SCRIPT = Object.keys(GOOD.files).find((u) => u.endsWith(".js"));
const SCRIPT_PATH = new URL(SCRIPT).pathname;

const withCsp = (from, to) => {
  const csp = GOOD.headers["content-security-policy"];
  assert.ok(csp.includes(from), from);
  return { ...GOOD, headers: { ...GOOD.headers, "content-security-policy": csp.replace(from, to) } };
};
const withHtml = (from, to) => {
  assert.ok(GOOD.html.includes(from), from);
  return { ...GOOD, html: GOOD.html.replace(from, to) };
};
const bad = (answer, line) => {
  const r = judge(answer);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && (typeof line === "string" ? l === line : line.test(l))), `want ${line}, got:\n${r.lines.join("\n")}`);
};

// a fetch that answers from a recorded answer: the page, then each file as its recorded bytes' stand-in
const replay = (a) => async (u) => {
  if (u === a.url) return new Response(a.html, { status: a.status, headers: a.headers });
  return new Response(`bytes of ${u}`, { status: 200 });
};

test("recorded answers: the harness build PASSes; APP_HOST before app-in-shell and the build with one byte changed FAIL", () => {
  for (const k of ["good"]) {
    const r = judge(ANSWERS[k]);
    assert.equal(r.ok, true, `${k}:\n${r.lines.join("\n")}`);
    assert.ok(r.lines.includes(`ok  CSP frame-ancestors is exactly ${SIGN} (got "${SIGN}")`));
    assert.ok(r.lines.includes("ok  no header holds 'wasm-unsafe-eval'"));
    assert.ok(r.lines.includes('ok  Integrity-Policy: "blocked-destinations=(script)"'));
    assert.ok(r.lines.some((l) => /^ok {2}script \/assets\/index-\S+\.js: integrity sha384-\S+ equals the sha384 of the bytes served$/.test(l)));
  }
  bad(ANSWERS.bad, /^BAD script \/assets\/index-\S+\.js: integrity sha384-\S+ but the bytes served are sha384-/);
  const before = judge(ANSWERS.liveBefore);
  assert.deepEqual(before.lines.filter((l) => l.startsWith("BAD")), [`BAD CSP frame-ancestors is exactly ${SIGN} (got "'none'")`]);
});

test("read() fetches the page and every file it loads, and judge() compares the served bytes", async () => {
  const a = await read(GOOD.url, replay(GOOD));
  assert.deepEqual(Object.keys(a.files).sort(), Object.keys(GOOD.files).sort());
  assert.equal(a.files[SCRIPT].status, 200);
  bad(a, /^BAD script .*but the bytes served are sha384-/); // the replayed bytes are not the build's
});

test("bad answers: frame-ancestors * or a second host, frame-ancestors missing, 'wasm-unsafe-eval' in script-src: FAIL", () => {
  bad(withCsp(`frame-ancestors ${SIGN};`, "frame-ancestors *;"), `BAD CSP frame-ancestors is exactly ${SIGN} (got "*")`);
  bad(withCsp(`frame-ancestors ${SIGN};`, `frame-ancestors ${SIGN} https://evil.ct.test;`), /^BAD CSP frame-ancestors is exactly/);
  bad(withCsp(`frame-ancestors ${SIGN};`, ""), /^BAD CSP frame-ancestors is exactly .* \(0 frame-ancestors directives\)$/);
  bad(withCsp("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';"), "BAD no header holds 'wasm-unsafe-eval': content-security-policy");
  bad({ ...GOOD, headers: { ...GOOD.headers, "content-security-policy": undefined } }, "BAD Content-Security-Policy: none sent");
});

test("bad answers: Integrity-Policy missing or report-only in its place: FAIL", () => {
  const { "integrity-policy": _, ...rest } = GOOD.headers;
  bad({ ...GOOD, headers: rest }, 'BAD Integrity-Policy: none sent, want "blocked-destinations=(script)"');
  bad({ ...GOOD, headers: { ...rest, "integrity-policy-report-only": "blocked-destinations=(script)" } }, /^BAD Integrity-Policy: none sent/);
});

test("bad answers: a script with no integrity, an inline script, a script from another origin, two hashes, a 404, no script: FAIL", () => {
  const tag = /<script\b[^>]*>/.exec(GOOD.html)[0];
  const integrity = /\sintegrity="[^"]*"/.exec(tag)[0];
  bad(withHtml(tag, tag.replace(integrity, "")), `BAD script ${SCRIPT_PATH}: no integrity`);
  bad(withHtml("</title>", "</title><script>window.x=1</script>"), "BAD an inline script");
  bad(withHtml("</title>", '</title><script src="https://evil.ct.test/a.js" integrity="sha384-x"></script>'), "BAD script https://evil.ct.test/a.js: not on https://ct-app.unrealized.trade");
  bad(withHtml(integrity, integrity.replace(/"$/, ' sha384-AAAA"')), /^BAD script .*: integrity must be exactly one sha384/);
  bad({ ...GOOD, files: { ...GOOD.files, [SCRIPT]: { ...GOOD.files[SCRIPT], status: 404 } } }, `BAD script ${SCRIPT_PATH}: answers 404`);
  bad(withHtml(/<script\b[^>]*><\/script>/.exec(GOOD.html)[0], ""), "BAD the page loads 0 script(s)");
  bad(withHtml("</title>", '</title><script src="http://[x" integrity="sha384-x"></script>'), "BAD script http://[x: not a URL");
  bad({ ...GOOD, status: 522 }, `BAD GET ${GOOD.url} answers 522`);
});
