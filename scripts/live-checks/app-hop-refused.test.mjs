// node --test scripts/live-checks/app-hop-refused.test.mjs: the live check's verdict replays recorded runs
// (app-hop-refused.answers.json), each read on 2026-11-01 by app-hop-refused.mjs --record in headless Chromium 153:
//   good:    --harness, this card's build at APP_HOST and SIGN_HOST's real page (which answers signin.open not_allowed,
//            as the live SIGN_HOST does today): PASS ("Not available" under Use passkey, no Retry, within 100 ms);
//   badLive: the live APP_HOST before this card's deploy: Sign in, Use passkey, and nothing shows or opens: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, WIDTHS } from "./app-hop-refused.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-hop-refused.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: a refused Use passkey shows its line in the sheet, no Retry, no pop-up: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of WIDTHS) {
    assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name}: the tap shows "Not available" \\(refused, Retry not shown, in the sheet\\) \\d+ ms after it, limit 6500 ms$`).test(l)), w.name);
    assert.ok(r.lines.includes(`ok  ${w.name}: no pop-up`));
  }
});

test("recorded bad answer: the live APP_HOST before this card, a silent tap: FAIL", () => {
  const r = judge(ANSWERS.badLive);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), [
    "BAD phone: the tap shows nothing and opens nothing within 6500 ms (still on https://confidential.unrealized.trade/, control on)",
    "BAD desktop: the tap shows nothing and opens nothing within 6500 ms (still on https://confidential.unrealized.trade/, control on)",
  ]);
});

test("planted cases: an opened hop passes; Retry on a refusal, no Retry on a silent tap, a late line, a line outside the sheet, a pop-up and no READY each FAIL", () => {
  const plant = (f) => {
    const rec = structuredClone(ANSWERS.good);
    f(rec.runs.find((x) => x.width === "phone"));
    return judge(rec);
  };
  const opened = plant((p) => Object.assign(p, { outcome: "opened", ms: 900, line: null, url: "https://sign.confidential.unrealized.trade/" }));
  assert.equal(opened.ok, true, opened.lines.join("\n"));
  assert.ok(opened.lines.includes("ok  phone: the tap opened SIGN_HOST 900 ms after it, limit 6500 ms"));
  const silent = plant((p) => Object.assign(p.line, { why: "silent", retry: true }, { text: "No response" }));
  assert.equal(silent.ok, true, silent.lines.join("\n"));
  const cases = [
    ["Retry on a refusal", (p) => (p.line.retry = true), /Retry shown/],
    ["no Retry on a silent tap", (p) => Object.assign(p.line, { why: "silent", retry: false }), /silent, Retry not shown/],
    ["a line after the window", (p) => (p.ms = 6_501), /6501 ms after it/],
    ["a line outside the sheet", (p) => (p.line.inPlace = false), /NOT in the sheet/],
    ["an empty line", (p) => (p.line.text = " "), /the tap shows " "/],
    ["a pop-up", (p) => p.dialogs.push("alert"), /pop-ups alert/],
    ["no READY", (p) => Object.assign(p, { ready: false, signpage: "down" }), /never READY \(down\)/],
    ["no screenshot", (p) => delete p.shot, /no screenshot/],
  ];
  for (const [name, f, re] of cases) {
    const r = plant(f);
    assert.equal(r.ok, false, name);
    assert.ok(bad(r.lines).some((l) => re.test(l)), `${name}: ${bad(r.lines).join("; ")}`);
  }
});
