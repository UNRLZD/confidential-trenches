// node --test scripts/live-checks/kit-on-npm.test.mjs: the live check replays recorded answers (kit-on-npm.answers.json).
// "good" is the registry's answer for a published 0.1.0 and its tarball: PASS. "bad_404" is the registry read live
// before the publish: FAIL. The rest plant one fault each in the good answer: a tarball that does not hash to
// dist.integrity, a release other than --integrity, a manifest without the repository's version, and a tarball whose
// exports point at TypeScript source (the tarball before this card, which plain Node refuses under node_modules): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, repoVersion } from "./kit-on-npm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "kit-on-npm.answers.json"), "utf8"));
const replay = (a) => ({ manifest: async () => a.manifest, tarball: async () => a.tarball ?? { status: 404 } });
const good = () => structuredClone(ANSWERS.good);

test("the recording is of the version packages/kit/package.json names", () => {
  assert.equal(repoVersion(), "0.1.0");
  assert.ok(JSON.parse(ANSWERS.good.manifest.body).versions[repoVersion()]);
});

test("recorded good answer: 0.1.0 on the registry, its tarball whole and built: PASS", async () => {
  const r = await check({ ...replay(ANSWERS.good), version: "0.1.0", integrity: ANSWERS.good.tarball.sha512 });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^ok  @blindfill\/kit on the registry holds 0\.1\.0; latest is 0\.1\.0/);
  assert.equal(r.lines[1], "ok  dist.tarball https://registry.npmjs.org/@blindfill/kit/-/kit-0.1.0.tgz");
  assert.match(r.lines[4], /^ok  its package\.json: @blindfill\/kit@0\.1\.0, Apache-2\.0; exports \. -> \.\/dist\/kit\/src\/index\.js, \.\/core -> \.\/dist\/kit\/src\/core\.js \(built, in the tarball\); 0 \.ts source files; LICENSE held$/);
});

test("recorded bad answer: today's 404, nothing published: FAIL", async () => {
  const r = await check({ ...replay(ANSWERS.bad_404), version: "0.1.0" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines, ['BAD @blindfill/kit is not on the registry: 404 {"error":"Not found"}']);
});

test("planted: a tarball that does not hash to dist.integrity: FAIL", async () => {
  const a = good();
  a.tarball.sha512 = a.tarball.sha512.replace(/^sha512-./, (s) => (s.endsWith("A") ? "sha512-B" : "sha512-A"));
  const r = await check({ ...replay(a), version: "0.1.0" });
  assert.equal(r.ok, false);
  assert.match(r.lines[3], /^BAD the tarball/);
});

test("planted: the registry's tarball is not the release --integrity names: FAIL", async () => {
  const r = await check({ ...replay(ANSWERS.good), version: "0.1.0", integrity: "sha512-" + "A".repeat(86) + "==" });
  assert.equal(r.ok, false);
  assert.match(r.lines[3], /^BAD .*; the release sha512-A+==$/);
});

test("planted: the registry holds another version, not the repository's: FAIL", async () => {
  const r = await check({ ...replay(ANSWERS.good), version: "0.1.1" });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^BAD @blindfill\/kit on the registry holds 0\.1\.1 NOT; latest is 0\.1\.0/);
});

test("planted: exports at TypeScript source, as the kit packed before this card: FAIL", async () => {
  const a = good();
  a.tarball.manifest.exports["."] = { types: "./src/index.ts", default: "./src/index.ts" };
  a.tarball.files.push("package/src/index.ts");
  const r = await check({ ...replay(a), version: "0.1.0" });
  assert.equal(r.ok, false);
  assert.match(r.lines[4], /^BAD .*\(NOT built JS and \.d\.ts in the tarball\); 1 \.ts source files/);
});
