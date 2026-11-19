// node --test scripts/live-checks/signpage-backup-export.test.mjs: the live check replays its recorded answers
// (signpage-backup-export.answers.json, unedited). good: this card's branch built as the sign deploy builds it, against
// its own list entries: PASS. bad: a real run on SIGN_HOST against release-181, whose bundle still refuses export.open:
// FAIL. Then the judge on each way a record can be wrong, and the list reader on the committed lists.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, listed, newestTag, readOf } from "./signpage-backup-export.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "signpage-backup-export.mjs");
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-backup-export.answers.json"), "utf8"));
const tmp = mkdtempSync(path.join(tmpdir(), "ct-backup-export-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const replay = (record) => {
  const f = path.join(tmp, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(record));
  return spawnSync(process.execPath, [CHECK, "--answer", f], { encoding: "utf8" });
};
const copy = (o) => structuredClone(o);

test("recorded good answer: the branch's build serves both files as its list names them, the bundle with both screens: PASS", () => {
  const r = replay(ANSWERS.good);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK backup screen in \/app\.js/);
  assert.match(r.stdout, /OK export screen in \/app\.js/);
  assert.match(r.stdout, /live-check signpage-backup-export: PASS/);
});

test("recorded bad answer: SIGN_HOST's release-181 serves its listed files, but no export screen: FAIL", () => {
  const r = replay(ANSWERS.bad);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(ANSWERS.bad.release, "release-181");
  assert.deepEqual(ANSWERS.bad.list, listed("release-181"), "the bad run judged against the committed list's own entries");
  assert.match(r.stdout, /BAD \/app\.js: no export screen/);
  assert.match(r.stdout, /live-check signpage-backup-export: FAIL/);
});

test("the judge: a file served with other bytes, another status, unread, or a bundle with no backup screen: FAIL", () => {
  const cases = [
    ["app.js bytes", (g) => (g.files["/app.js"].sha384 = g.list["/"].sha384)],
    ["index bytes", (g) => (g.files["/"].bytes += 1)],
    ["index status", (g) => (g.files["/"].status = 304)],
    ["unread", (g) => delete g.files["/app.js"]],
    ["unlisted", (g) => delete g.list["/"]],
    ["no backup", (g) => (g.files["/app.js"].screens.backup = false)],
    ["no export", (g) => (g.files["/app.js"].screens.export = false)],
    ["no screens read", (g) => delete g.files["/app.js"].screens],
  ];
  for (const [what, spoil] of cases) {
    const g = copy(ANSWERS.good);
    spoil(g);
    assert.equal(judge(g).ok, false, what);
  }
  assert.equal(judge(ANSWERS.good).ok, true);
});

test("the screens found in a bundle: the backup's 12 words' list, and both of the export's marks", () => {
  const b = (s) => readOf("/app.js", 200, Buffer.from(s)).screens;
  assert.deepEqual(b('e.dataset.words=`12`;"export.open":(e,t)=>x(t);k.dataset.key=c'), { backup: true, export: true });
  assert.deepEqual(b('e.dataset.words=`12`;"export.open":5e3'), { backup: true, export: false });
  assert.deepEqual(b('"export.open":(e,t)=>x(t);k.dataset.key=c'), { backup: false, export: true });
  assert.equal(readOf("/", 200, Buffer.from("x")).screens, undefined);
  assert.equal(readOf("/", 200, Buffer.from("x")).sha384, "sha384-11LCxR+6DimqGQVwqdQlPkQHegWNMpf6OlYw1b0BJiL5fCisrtMTtcg7uZDKp9qF");
});

test("the list reader: the newest committed list by N, each with SIGN_HOST's two files and their sha384", () => {
  const tag = newestTag();
  assert.match(tag, /^release-[1-9][0-9]*$/);
  const l = listed(tag);
  assert.deepEqual(Object.keys(l), ["/", "/app.js"]);
  for (const v of Object.values(l)) assert.match(v.sha384, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.throws(() => listed("release-0"));
});
