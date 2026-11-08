// node --test scripts/live-checks/app-discover-toolbar.test.mjs: the live check's verdict replays recorded answers
// (app-discover-toolbar.answers.json), each read on 2026-11-08 by app-discover-toolbar.mjs collect():
//   good: this card's terminal build at APP_HOST's name in the stand-in shell, the helper live: every control drawn and
//         each narrowing holds on the live lists, at both widths: PASS;
//   bad:  APP_HOST as deployed before this card (no toolbar): FAIL, each missing control named.
// Planted from the good answer: a flagged row left by Fewer flags, a row under $10K left by the MC chip, a row of another
// launchpad, a search miss, an amount not kept, a No creator dumps chip drawn, a list that did not hold, or a page error
// fails; a MC of "—" passes the chip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, judge, usd } from "./app-discover-toolbar.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-discover-toolbar.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: every control drawn and each narrowing holds on the live lists, at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(EXIT.PASS, 0);
  assert.ok(ANSWERS.good.desktop.fewer.rows.length < ANSWERS.good.desktop.rows, "Fewer flags hid rows in the recorded run");
});

test("recorded bad answer: the deployed Discover before this card has no toolbar: FAIL, each control named", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.includes("missing: All, Fewer flags, MC ≥ $10K, Launchpad, Quick buy")), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => l.startsWith("BAD phone: the chips")), r.lines.join("\n"));
});

test("planted: each narrowing that lets a row through fails and names it", () => {
  assert.equal(mut((rec) => rec.desktop.fewer.rows.push({ symbol: "FLAG", levels: ["none", "warn"] })).verdict, "FAIL");
  assert.equal(mut((rec) => rec.desktop.mc.rows.push({ symbol: "TINY", mc: 9_999 })).verdict, "FAIL");
  assert.equal(mut((rec) => rec.desktop.mc.rows.push({ symbol: "NOMC", mc: null })).verdict, "PASS");
  assert.equal(mut((rec) => rec.desktop.pad.rows.push({ symbol: "OTHER", pad: "letsbonk.fun-not-picked" })).verdict, "FAIL");
  assert.equal(mut((rec) => rec.desktop.search.rows.push({ symbol: "ZZZ", name: "nothing" })).verdict, "FAIL");
  assert.equal(mut((rec) => rec.phone.fewer.rows.push({ symbol: "DEV", level: "sell" })).verdict, "FAIL");
  const pressed = mut((rec) => (rec.desktop.fewer.pressed = false));
  assert.ok(bad(pressed).some((l) => l.includes("Fewer flags: pressed false")), pressed.lines.join("\n"));
});

test("planted: an amount not kept, a No creator dumps chip, a list that did not hold, a page error or no rows fails", () => {
  assert.equal(mut((rec) => (rec.desktop.amountAfterReload = "25")).verdict, "FAIL");
  assert.equal(mut((rec) => rec.desktop.controls.push("No creator dumps")).verdict, "FAIL");
  assert.equal(mut((rec) => (rec.phone.held = false)).verdict, "FAIL");
  assert.equal(mut((rec) => rec.phone.errors.push("TypeError: x")).verdict, "FAIL");
  assert.equal(mut((rec) => (rec.desktop.rows = 0)).verdict, "FAIL");
  assert.equal(mut((rec) => (rec.desktop.searchButtons = 3)).verdict, "FAIL");
  assert.equal(mut((rec) => delete rec.phone).verdict, "FAIL");
});

test("usd reads the drawn MC: $4.20K, $2.32M, $244.30M, $1.08B and — (none)", () => {
  assert.equal(usd("$4.20K"), 4200);
  assert.equal(usd("$2.32M"), 2_320_000);
  assert.equal(usd("$244.30M"), 244_300_000);
  assert.equal(usd("$1.08B"), 1_080_000_000);
  assert.equal(usd("$950"), 950);
  assert.equal(usd("—"), null);
});
