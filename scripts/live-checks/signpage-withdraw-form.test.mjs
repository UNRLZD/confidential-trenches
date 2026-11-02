// node --test scripts/live-checks/signpage-withdraw-form.test.mjs: the live check's verdict on its recorded answers,
// with no network. Every record is a real run of the check:
// - good: the card's build (index.html and public/app.js) served at / and /app.js, which passes;
// - bad: the live SIGN_HOST before the card's deploy, main's page with no withdraw form: it fails on the form alone;
// - badIntegrity: the card's app.js under the old index.html, whose integrity names another script: it fails on that.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, MARKERS, SIGN_ORIGIN } from "./signpage-withdraw-form.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-withdraw-form.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
const FORM = "/app.js holds the withdraw form";
const SAME = "/app.js is the script / names: its sha384 is the integrity";

test("the recorded good answer passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  for (const m of MARKERS) assert.ok(answers.good.app.markers[m] >= 1, m);
});

test("the live SIGN_HOST before the deploy fails: no withdraw form in its script", () => {
  assert.equal(answers.bad.url, SIGN_ORIGIN);
  assert.deepEqual(BAD(answers.bad), [FORM]);
});

test("the form's script under a page whose integrity names another script fails", () => {
  assert.deepEqual(BAD(answers.badIntegrity), [SAME]);
});

test("a record with no script, or no answer, fails every line", () => {
  assert.equal(judge({}).pass, false);
  assert.equal(judge({ index: { scripts: 2, src: "/app.js", integrity: answers.good.index.integrity }, app: answers.good.app }).pass, false);
});
