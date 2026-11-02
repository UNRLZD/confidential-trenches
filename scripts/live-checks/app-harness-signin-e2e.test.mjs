// node --test scripts/live-checks/app-harness-signin-e2e.test.mjs: the live check's verdict on its recorded answers,
// with no network. Every record is a real run of the check:
// - good: the card's builds (the ones release-3 lists) served at / on 127.0.0.1, which passes;
// - bad: the live APP_HOST and SIGN_HOST before the deploy: it fails on the boot frame, its rules and the backdrop;
// - badSign: the card's APP_HOST build beside the live SIGN_HOST: it fails on the backdrop alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN, judge, SIGN_ORIGIN } from "./app-harness-signin-e2e.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "app-harness-signin-e2e.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
const BOOT = "APP_HOST / holds the boot frame";
const RULES = "APP_HOST's stylesheet draws and hides the boot frame";
const BACKDROP = "SIGN_HOST's /app.js draws the backdrop";

test("the recorded good answer passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
});

test("the live hosts before the deploy fail: no boot frame, no rules for it, no backdrop", () => {
  assert.equal(answers.bad.app.url, APP_ORIGIN);
  assert.equal(answers.bad.sign.url, SIGN_ORIGIN);
  assert.deepEqual(BAD(answers.bad), [BOOT, RULES, BACKDROP]);
});

test("the card's APP_HOST beside the live SIGN_HOST fails on the backdrop alone", () => {
  assert.equal(answers.badSign.sign.url, SIGN_ORIGIN);
  assert.deepEqual(BAD(answers.badSign), [BACKDROP]);
});

test("a stylesheet or script that is not the one the page names fails, and an empty record fails every line", () => {
  const css = structuredClone(answers.good);
  css.app.css.sha384 = answers.bad.app.css.sha384;
  assert.deepEqual(BAD(css), ["APP_HOST / names one stylesheet, its sha384 the integrity"]);
  const js = structuredClone(answers.good);
  js.sign.index.integrity = answers.bad.sign.index.integrity;
  assert.deepEqual(BAD(js), ["SIGN_HOST / names one module script, /app.js, its sha384 the integrity"]);
  assert.equal(judge({}).lines.filter((l) => l.startsWith("BAD")).length, 5);
});
