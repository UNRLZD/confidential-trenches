// node --test scripts/live-checks/discover-matches-the-main-app.test.mjs: the live check's verdict replays recorded
// answers (discover-matches-the-main-app.answers.json), each read on 2026-11-11 by discover-matches-the-main-app.mjs:
//   good: this card's terminal build at APP_HOST's name in the stand-in shell, the helper live: every ring its pad's
//         colour, ten pad colours at 1440, four columns at 1024, logos as served: PASS;
//   bad:  APP_HOST as deployed before this card (release 116): every ring a stage colour, 2 x 2 at 1024: FAIL.
// Planted from the good answer: a ring off its pad's colour, a row served a logo whose route did not answer 200 with an
// image or that is not drawn, a row served none that asks for one, a broken image, three columns at 1024, or a page
// error fails. The record holds no name or symbol.
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

test("planted: a row served a logo whose route did not answer 200 with an image, or that is not drawn, fails; one that did passes", () => {
  const row = (rec) => w(rec, "1440").rows.find((r) => r.inView);
  // the token served a logo, its answer the same at every width it is drawn in
  const served = (logo) =>
    mut((rec) => {
      const id = row(rec).id;
      rec.icons[id] = true;
      for (const x of rec.widths) for (const r of x.rows) if (r.id === id) r.logo = logo;
    });
  assert.equal(mut((rec) => (rec.icons[row(rec).id] = true)).verdict, "FAIL");
  assert.equal(served({ status: 404, type: "application/json", drawn: false }).verdict, "FAIL");
  assert.equal(served({ status: 200, type: "image/svg+xml", drawn: true }).verdict, "FAIL");
  assert.equal(served({ status: 200, type: "image/png", drawn: false }).verdict, "FAIL");
  const r = served({ status: 200, type: "image/png", drawn: true });
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("planted: a row served no logo that asks for one, a broken image, no initials under no logo fail", () => {
  assert.equal(mut((rec) => (w(rec, "390").rows[0].logo = { status: 200, type: "image/png", drawn: true })).verdict, "FAIL");
  assert.equal(mut((rec) => (w(rec, "390").rows[0].broken = true)).verdict, "FAIL");
  assert.equal(mut((rec) => (w(rec, "390").rows[0].initials = false)).verdict, "FAIL");
});

test("the record holds no token text: each row only its id, chain, pad, ring, view, initials flag, logo answer and broken flag", () => {
  const KEYS = ["broken", "chain", "id", "inView", "initials", "logo", "pad", "ring"];
  for (const rec of [ANSWERS.good, ANSWERS.bad]) for (const x of rec.widths) for (const r of x.rows) assert.deepEqual(Object.keys(r).sort(), KEYS);
});

test("planted: three columns at 1024, a page error, under three pad colours at 1440 fail", () => {
  assert.equal(mut((rec) => w(rec, "1024").cols.pop()).verdict, "FAIL");
  assert.equal(mut((rec) => w(rec, "1440").errors.push("TypeError: x")).verdict, "FAIL");
  assert.equal(mut((rec) => {
    for (const r of w(rec, "1440").rows) if (r.pad !== "pump.fun") r.pad = null, (r.ring = "var(--blue)");
  }).verdict, "FAIL");
});
