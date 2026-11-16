// node --test scripts/live-checks/app-deploy-refuses-an-unlisted-build.test.mjs: the live check replays recorded answers
// (app-deploy-refuses-an-unlisted-build.answers.json, two real runs of it on APP_HOST, 2026-11-16, unedited). good:
// APP_HOST read against release-163, the build it served: PASS. bad: APP_HOST read against release-160, whose APP_HOST
// part is another build: FAIL. With no --release the check judges against the newest committed list by N.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "./app-deploy-refuses-an-unlisted-build.mjs";
import { newestTag } from "./signpage-release-at-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "app-deploy-refuses-an-unlisted-build.mjs");
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-deploy-refuses-an-unlisted-build.answers.json"), "utf8"));
const tmp = mkdtempSync(path.join(tmpdir(), "ct-app-release-at-deploy-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (obj) => {
  const f = path.join(tmp, `${n++}.json`);
  writeFileSync(f, JSON.stringify(obj));
  return f;
};
const replay = (answer, tag = answer.release) => check(tag, ["--answer", file(answer)]);

test("recorded good answer: APP_HOST serves every file of release-163's APP_HOST part, in both modes: PASS", () => {
  const r = replay(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "MATCH release-163");
  assert.ok(!r.lines.some((l) => l.includes("SIGN_HOST")), "APP_HOST alone");
});

test("recorded bad answer: APP_HOST read against release-160, another build: FAIL, naming / and the main bundle", () => {
  const r = replay(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^NO MATCH release-160: \d+ line\(s\) differ$/);
  assert.ok(r.lines.some((l) => l.startsWith("BAD APP_HOST / (navigate): ")), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^BAD APP_HOST \/assets\/index-[\w-]+\.js \(navigate\): /.test(l)), r.lines.join("\n"));
  // and the good answer judged as if release-160 were the newest: the served build is not that list, FAIL
  assert.equal(replay(ANSWERS.good, "release-160").ok, false);
});

test("with no --release the check judges against the newest committed list by N; a list with no APP_HOST part is an error", () => {
  const r = check(null, ["--answer", file(ANSWERS.good)]);
  assert.equal(r.release, newestTag());
  const d = mkdtempSync(path.join(tmp, "releases-"));
  writeFileSync(path.join(d, "release-1.json"), JSON.stringify({ release: "release-1", hosts: { SIGN_HOST: {} } }));
  assert.throws(() => check(null, ["--answer", file(ANSWERS.good)], d), /release-1 holds no APP_HOST/);
});

test("the command line: PASS exit 0 on the good answer, FAIL exit 1 on the bad one, a bad argument exit 2", () => {
  const cli = (...a) => spawnSync(process.execPath, [CHECK, ...a], { encoding: "utf8", maxBuffer: 16 << 20 });
  const good = cli("--release", "release-163", "--answer", file(ANSWERS.good));
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout.trim().split("\n").at(-1), /^live-check app-deploy-refuses-an-unlisted-build: PASS \(release-163, https:\/\/ct-app\.unrealized\.trade, replay of /);
  const bad = cli("--release", "release-160", "--answer", file(ANSWERS.bad));
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout.trim().split("\n").at(-1), /^live-check app-deploy-refuses-an-unlisted-build: FAIL \(release-160, /);
  for (const a of [["--release", "v1"], ["--answer", "x", "--record", "y"], ["--host", "app"], ["--release"]]) assert.equal(cli(...a).status, 2, a.join(" "));
});
