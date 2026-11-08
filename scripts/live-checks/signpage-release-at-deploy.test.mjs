// node --test scripts/live-checks/signpage-release-at-deploy.test.mjs: the live check replays recorded answers
// (signpage-release-at-deploy.answers.json, two real runs of it on SIGN_HOST, 2026-11-08, unedited). good: SIGN_HOST
// read against release-102, the build it served: PASS. bad: SIGN_HOST read against the newest committed list,
// release-105, which it did not serve (a build no newer release had been deployed for): FAIL. With no --release the
// check judges against the newest committed list by N.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, newestTag } from "./signpage-release-at-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "signpage-release-at-deploy.mjs");
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-release-at-deploy.answers.json"), "utf8"));
const tmp = mkdtempSync(path.join(tmpdir(), "ct-release-at-deploy-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (obj) => {
  const f = path.join(tmp, `${n++}.json`);
  writeFileSync(f, JSON.stringify(obj));
  return f;
};
const replay = (answer, tag = answer.release) => check(tag, ["--answer", file(answer)]);
const newest = () => `release-${Math.max(...readdirSync(path.join(HERE, "../../packages/signpage/releases")).map((f) => Number(/^release-(\d+)\.json$/.exec(f)?.[1] ?? 0)))}`;

test("the newest list is picked by N, not by text (release-1000 after release-999)", () => {
  const d = mkdtempSync(path.join(tmp, "releases-"));
  for (const t of ["release-999", "release-1000", "release-2"]) writeFileSync(path.join(d, `${t}.json`), "{}");
  writeFileSync(path.join(d, "release-3.json.bak"), "{}");
  assert.equal(newestTag(d), "release-1000");
  assert.equal(newestTag(), newest());
});

test("recorded good answer: SIGN_HOST serves exactly release-102's SIGN_HOST part, every file in both modes: PASS", () => {
  const r = replay(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "MATCH release-102");
  assert.ok(!r.lines.some((l) => l.includes("APP_HOST")), "SIGN_HOST alone");
});

test("recorded bad answer: SIGN_HOST read against the newest committed list, release-105, serves another build: FAIL", () => {
  const r = replay(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^NO MATCH release-105: \d+ line\(s\) differ$/);
  assert.ok(r.lines.some((l) => l.startsWith("BAD SIGN_HOST /app.js (navigate): ")), r.lines.join("\n"));
  // and the good answer judged as if release-105 were the newest: the same build, FAIL
  assert.equal(replay(ANSWERS.good, "release-105").ok, false);
});

test("with no --release the check judges against the newest committed list by N", () => {
  const r = check(null, ["--answer", file(ANSWERS.good)]);
  assert.equal(r.release, newest());
  assert.equal(r.ok, newest() === "release-102");
});

test("the command line: PASS exit 0 on the good answer, FAIL exit 1 on the bad one, a bad argument exit 2", () => {
  const cli = (...a) => spawnSync(process.execPath, [CHECK, ...a], { encoding: "utf8", maxBuffer: 16 << 20 });
  const good = cli("--release", "release-102", "--answer", file(ANSWERS.good));
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout.trim().split("\n").at(-1), /^live-check signpage-release-at-deploy: PASS \(release-102, https:\/\/confidential\.unrealized\.trade, replay of /);
  const bad = cli("--release", "release-105", "--answer", file(ANSWERS.bad));
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout.trim().split("\n").at(-1), /^live-check signpage-release-at-deploy: FAIL \(release-105, /);
  for (const a of [["--release", "v1"], ["--answer", "x", "--record", "y"], ["--host", "sign"], ["--release"]]) assert.equal(cli(...a).status, 2, a.join(" "));
});
