// node --test scripts/live-checks/app-in-shell.test.mjs: the live check's verdict replays recorded runs
// (app-in-shell.answers.json), each read on 2026-11-01 by app-in-shell.mjs --harness --record on the Mac, in
// Playwright 1.63's Chromium, Firefox and WebKit, at 390 and 1440 wide:
//   good: this card's terminal build at APP_HOST and the stand-in shell at SIGN_HOST: PASS;
//   bad:  today's terminal (main 592955f) with the same shell: APP_HOST stays top-level with SIGN_HOST framed: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_HOST, ENGINES, judge, PATH, SIGN_HOST, WIDTHS } from "./app-in-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-in-shell.answers.json"), "utf8"));

test("recorded good answer: every engine and width lands on SIGN_HOST with the path kept and reads signed in, no hop: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const e of ENGINES) {
    for (const w of WIDTHS) {
      const n = `${e} ${w.name}`;
      assert.ok(r.lines.includes(`ok  ${n}: APP_HOST${PATH} top-level lands on ${SIGN_HOST}${PATH}`), n);
      assert.ok(r.lines.includes(`ok  ${n}: APP_HOST top-level drew nothing before it moved`), n);
      assert.ok(r.lines.includes(`ok  ${n}: the shell frames ${APP_HOST}${PATH}`), n);
      assert.ok(r.lines.includes(`ok  ${n}: inside the shell, signing page ready, header S1.4 (want ready, S1.4)`), n);
      assert.ok(r.lines.some((l) => l.startsWith(`ok  ${n}: no hop`)), n);
    }
  }
});

test("recorded bad answer: today's APP_HOST stays top-level with SIGN_HOST framed: FAIL on landing, drawing and the frame", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const e of ENGINES) {
    for (const w of WIDTHS) {
      const n = `${e} ${w.name}`;
      assert.ok(r.lines.includes(`BAD ${n}: APP_HOST${PATH} top-level ends at ${APP_HOST}${PATH}`), n);
      assert.ok(r.lines.includes(`BAD ${n}: APP_HOST top-level drew the app`), n);
      assert.ok(r.lines.includes(`BAD ${n}: no APP_HOST frame in the top window`), n);
    }
  }
});

test("a run missing, an engine missing, or the header signed out where signed in is expected: FAIL", () => {
  const drop = structuredClone(ANSWERS.good);
  drop.runs = drop.runs.filter((x) => x.engine !== "webkit");
  assert.ok(judge(drop).lines.includes("BAD webkit phone: no run"));
  const out = structuredClone(ANSWERS.good);
  out.runs[0].app.header = "S1.1";
  assert.equal(judge(out).ok, false);
  const hop = structuredClone(ANSWERS.good);
  hop.runs[0].topNavigations.push(`${SIGN_HOST}/`);
  assert.equal(judge(hop).ok, false);
});
