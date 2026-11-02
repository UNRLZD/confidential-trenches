// node --test scripts/live-checks/signpage-release.test.mjs: the live check replays recorded answers
// (signpage-release.answers.json) through check-signpage, against the release list they were read for. good: the run
// on SIGN_HOST and APP_HOST against release-1: PASS, for both hosts and for each alone (the after-deploy mode). bad:
// that answer with SIGN_HOST's /app.js served one byte changed: FAIL for both hosts and for SIGN_HOST alone, and PASS
// for APP_HOST alone, since a host that lags never fails the other host's check. The other bad answers are the good
// one, or the list, with one fault planted each: FAIL.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ORIGINS, run } from "./signpage-release.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-release.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const LIST_FILE = path.join(HERE, "../../packages/signpage/releases", `${GOOD.release}.json`);
const LIST = JSON.parse(readFileSync(LIST_FILE, "utf8"));

const tmp = mkdtempSync(path.join(tmpdir(), "ct-signpage-release-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (obj) => {
  const f = path.join(tmp, `${n++}.json`);
  writeFileSync(f, JSON.stringify(obj));
  return f;
};
const replay = (answer, list = LIST, host = null) => run(file(list), ["--answer", file(answer)], host);
/** LIST with only `name`'s host, as release-list.mjs --print --host writes a build's list after a deploy. */
const one = (name) => ({ ...LIST, hosts: { [name]: LIST.hosts[name] } });
const bad = (r, line) => {
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${line}`)), `no "BAD ${line}" in:\n${r.lines.join("\n")}`);
};

test("recorded good answer: every listed file of both hosts in both modes, the probes answered by the fallback page: PASS", () => {
  const r = run(LIST_FILE, ["--answer", file(GOOD)]);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "MATCH release-1");
  const files = Object.values(LIST.hosts).reduce((k, h) => k + h.files.length, 0);
  assert.equal(r.lines.length, files * 2 + 2 * 2 * 2 + 1);
  assert.deepEqual(Object.keys(GOOD.hosts).sort(), ["APP_HOST", "SIGN_HOST"]);
});

test("recorded bad answer: SIGN_HOST's /app.js with one byte changed: FAIL, the path named", () => {
  const r = replay(ANSWERS.bad);
  bad(r, "SIGN_HOST /app.js (navigate): ");
  bad(r, "SIGN_HOST /app.js (fetch): ");
  assert.equal(r.lines.filter((l) => l.startsWith("BAD")).length, 2);
  assert.match(r.lines.at(-1), /^NO MATCH release-1/);
});

test("planted: a list that names another origin, or drops a host: FAIL", () => {
  const moved = structuredClone(LIST);
  moved.hosts.SIGN_HOST.origin = "https://sign.example.com";
  bad(replay(GOOD, moved), `release-1 SIGN_HOST is https://sign.example.com, want ${ORIGINS.SIGN_HOST}`);
  const one = structuredClone(LIST);
  delete one.hosts.APP_HOST;
  bad(replay(GOOD, one), "release-1 names hosts SIGN_HOST, want APP_HOST,SIGN_HOST");
});

test("planted: a changed header, a 404, a webauthn file: FAIL", () => {
  const a = structuredClone(GOOD);
  a.hosts.APP_HOST.files["/"].navigate.headers["content-security-policy"] += "; script-src *";
  bad(replay(a), "APP_HOST / (navigate): content-security-policy ");
  const b = structuredClone(GOOD);
  b.hosts.SIGN_HOST.files["/prover-worker.js"].fetch.status = 404;
  bad(replay(b), "SIGN_HOST /prover-worker.js (fetch): answers 404, want 200");
  const c = structuredClone(GOOD);
  Object.assign(c.hosts.SIGN_HOST.probes["/.well-known/webauthn"].navigate, { bytes: 40, sha256: "0".repeat(64) });
  bad(replay(c), "SIGN_HOST /.well-known/webauthn (navigate): 200, 40 B");
});

test("one host alone, as after its deploy: the recorded good answer PASSes per host; the bad one FAILs SIGN_HOST only", () => {
  for (const [host, name] of [["sign", "SIGN_HOST"], ["app", "APP_HOST"]]) {
    const r = replay(GOOD, one(name), host);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(r.lines.length, LIST.hosts[name].files.length * 2 + 2 * 2 + 1);
    assert.ok(r.lines.slice(0, -1).every((l) => l.startsWith(`ok  ${name} `)), host);
  }
  bad(replay(ANSWERS.bad, one("SIGN_HOST"), "sign"), "SIGN_HOST /app.js (navigate): ");
  // SIGN_HOST lagging (its /app.js not this build's) does not fail APP_HOST's check
  assert.equal(replay(ANSWERS.bad, one("APP_HOST"), "app").ok, true);
  // a one-host list for the other host is an error; a list of both under --host: FAIL
  assert.throws(() => replay(GOOD, one("APP_HOST"), "sign"), /release-1 holds no SIGN_HOST/);
  bad(replay(GOOD, LIST, "app"), "release-1 names hosts APP_HOST,SIGN_HOST, want APP_HOST");
});
