// node --test scripts/live-checks/terminal-harness-sign-spa.test.mjs: card terminal-harness-sign-spa's live check,
// replayed. terminal-harness-sign-spa.answers.json: good, SIGN_HOST read live with this card's harness (sign.ct.test with
// spa): PASS; bad, the same answers with main 4729bfb8's harness (no fallback): FAIL on the harness line alone.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, PATHS, read, SIGN_ORIGIN } from "./terminal-harness-sign-spa.mjs";

const A = JSON.parse(readFileSync(new URL("./terminal-harness-sign-spa.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good run passes: every path with no file is SIGN_HOST's index, and the harness falls back as SIGN_HOST does", () => {
  const r = judge(A.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 2 + PATHS.length);
});

test("the recorded bad run (main 4729bfb8's harness, no fallback) fails on the harness line alone", () => {
  const r = judge(A.bad);
  assert.equal(r.pass, false);
  assert.deepEqual(bad(r), ["BAD the terminal's harness serves sign.ct.test without the index for a path with no file"]);
  assert.deepEqual(A.bad.answers, A.good.answers);
});

test("planted on the good run: a 404 for /favicon.ico, the _headers file served as text, another body, no index: each FAIL on its line", () => {
  const plant = (f) => {
    const rec = structuredClone(A.good);
    f(rec.answers);
    return judge(rec);
  };
  assert.ok(bad(plant((a) => (a["/favicon.ico"] = { ...a["/favicon.ico"], status: 404, type: "text/plain" }))).some((l) => /\/favicon\.ico: 404/.test(l)));
  assert.ok(bad(plant((a) => (a["/_headers"] = { status: 200, type: "text/plain", bytes: 3842, sha256: "0".repeat(64) }))).some((l) => /\/_headers: 200 text\/plain.*not the index/.test(l)));
  assert.ok(bad(plant((a) => (a["/no-such-path"] = { ...a["/no-such-path"], sha256: "1".repeat(64) }))).some((l) => /\/no-such-path: .*not the index/.test(l)));
  assert.ok(bad(plant((a) => (a["/"] = { status: 503, type: "text/plain", bytes: 0, sha256: null }))).some((l) => /index: 503/.test(l)));
});

test("the read asks SIGN_HOST's index and each path, and reads this tree's harness, which falls back", async () => {
  const body = "<!doctype html><title>x</title>";
  const asked = [];
  const f = async (url) => (asked.push(url), new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
  const rec = await read(f);
  assert.deepEqual(asked, ["/", ...PATHS].map((p) => `${SIGN_ORIGIN}${p}`));
  assert.equal(rec.answers["/_headers"].sha256, createHash("sha256").update(body).digest("hex"));
  assert.deepEqual(rec.harness, { sign: "sign.ct.test", spa: true });
  assert.equal(judge(rec).pass, true);
});
