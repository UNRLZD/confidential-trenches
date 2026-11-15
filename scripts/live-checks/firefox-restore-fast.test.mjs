// node --test scripts/live-checks/firefox-restore-fast.test.mjs: the live check replays recorded answers
// (firefox-restore-fast.answers.json). bad: SIGN_HOST's /walk-worker.js read 15 Nov 02:40Z (release 144: its own policy
// "default-src 'none'; script-src 'self'", BigInt only): FAIL. good: that answer as this card's build serves it (no
// served answer of it until the next sign deploy): its CSP the committed _headers' /* policy joined with the file's own,
// as Pages joins them, and its bytes packages/signpage/public/walk-worker.js's, built by scripts/build-app.mjs (it carries the field's mark):
// PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIELD_MARK, judge, WALK_POLICY } from "./firefox-restore-fast.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "firefox-restore-fast.answers.json"), "utf8"));
const HEADERS = readFileSync(path.join(HERE, "../../packages/signpage/public/_headers"), "utf8");
const SITE = /^\/\*\n(?: {2}[^\n]*\n)*? {2}Content-Security-Policy: ([^\n]*)/m.exec(HEADERS)[1];
const WALK = /^\/walk-worker\.js\n {2}Content-Security-Policy: ([^\n]*)/m.exec(HEADERS)[1];

test("good is the build's: the committed /* policy joined with the walk file's own, and the field in the built bytes", () => {
  assert.equal(WALK, WALK_POLICY);
  assert.equal(ANSWERS.good.csp, `${SITE}, ${WALK}`);
  // the built walk-worker.js (gitignored) carries the field's mark, as the source it is built from does
  assert.equal(ANSWERS.good.field, true);
  assert.ok(readFileSync(path.join(HERE, "../../packages/wallet/src/notes/field-wasm.ts"), "utf8").includes(`"${FIELD_MARK}"`));
  // the recorded bad answer differs from good only in the walk file's own policy and the field
  assert.equal(ANSWERS.bad.csp, `${SITE}, default-src 'none'; script-src 'self'`);
});

test("good passes", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("bad (SIGN_HOST before this card) fails on the walk's policy and on the field", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 2, v.lines.join("\n"));
  assert.match(v.lines[0], /policy is not/);
  assert.match(v.lines[1], /no WebAssembly field/);
});

test("planted: 'unsafe-eval' beside it, the field missing, the walk policy missing, a 404", () => {
  const g = ANSWERS.good;
  assert.equal(judge({ ...g, csp: `${g.csp}, script-src 'unsafe-eval'` }).ok, false);
  assert.equal(judge({ ...g, field: false }).ok, false);
  assert.equal(judge({ ...g, csp: SITE }).ok, false);
  assert.equal(judge({ ...g, status: 404 }).ok, false);
});
