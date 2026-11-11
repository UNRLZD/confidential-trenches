// node --test scripts/live-checks/discover-matches-the-main-app.test.mjs: the live check's verdict replays recorded
// answers (discover-matches-the-main-app.answers.json), each read on 2026-11-11 by discover-matches-the-main-app.mjs:
//   good: this card's terminal build at APP_HOST's name in the stand-in shell, the helper live: every ring its pad's
//         colour, ten pad colours at 1440, four columns at 1024, logos as served: PASS;
//   bad:  APP_HOST as deployed before this card (release 116): every ring a stage colour, 2 x 2 at 1024: FAIL.
// Planted from the good answer: a ring off its pad's colour, a row served a logo that draws none, a row served none that
// draws one, a broken image, three columns at 1024, or a page error fails; a logo that failed to load and drew its
// initials passes, named.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, judge } from "./discover-matches-the-main-app.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "discover-matches-the-main-app.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const w = (rec, name) => rec.widths.find((x) => x.name === name);
const padded = (rec) => w(rec, "1440").rows.find((r) => r.pad === "pump.fun");

test("recorded good answer: every ring its launchpad's colour, four columns at 1024, logos as served: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(EXIT.PASS, 0);
});

test("recorded bad answer (as deployed before this card): FAIL, each fault named", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL");
  assert.equal(EXIT.FAIL, 1);
  assert.ok(r.lines.some((l) => /BAD 1440: \d+ of \d+ rings off/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /BAD 1024: columns .* not four in one row/.test(l)), r.lines.join("\n"));
});

test("planted: a ring off its pad's colour fails", () => {
  assert.equal(mut((rec) => (padded(rec).ring = "var(--blue)")).verdict, "FAIL");
});

test("planted: a row with no known pad drawn in a pad's colour fails", () => {
  assert.equal(mut((rec) => (w(rec, "1440").rows.find((r) => r.pad === null).ring = "oklch(0.76 0.12 154)")).verdict, "FAIL");
});

test("planted: a row served a logo that draws none, or still waits, fails; one that failed to load and drew initials passes", () => {
  const row = (rec) => w(rec, "1440").rows.find((r) => r.inView);
  assert.equal(mut((rec) => (rec.icons[row(rec).id] = true)).verdict, "FAIL");
  assert.equal(mut((rec) => ((rec.icons[row(rec).id] = true), (row(rec).logo = "waiting"))).verdict, "FAIL");
  assert.equal(mut((rec) => ((rec.icons[row(rec).id] = true), (row(rec).logo = "loaded"))).verdict, "PASS");
  const r = mut((rec) => ((rec.icons[row(rec).id] = true), (row(rec).logo = "failed")));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /failed to load and drew initials/.test(l)));
});

test("planted: a row served no logo that draws one, a broken image, no initials under no logo fail", () => {
  assert.equal(mut((rec) => (w(rec, "390").rows[0].logo = "loaded")).verdict, "FAIL");
  assert.equal(mut((rec) => (w(rec, "390").rows[0].broken = true)).verdict, "FAIL");
  assert.equal(mut((rec) => (w(rec, "390").rows[0].initials = "")).verdict, "FAIL");
});

test("planted: three columns at 1024, a page error, under three pad colours at 1440 fail", () => {
  assert.equal(mut((rec) => w(rec, "1024").cols.pop()).verdict, "FAIL");
  assert.equal(mut((rec) => w(rec, "1440").errors.push("TypeError: x")).verdict, "FAIL");
  assert.equal(mut((rec) => {
    for (const r of w(rec, "1440").rows) if (r.pad !== "pump.fun") r.pad = null, (r.ring = "var(--blue)");
  }).verdict, "FAIL");
});
