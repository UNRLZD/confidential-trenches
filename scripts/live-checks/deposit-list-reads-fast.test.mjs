// node --test scripts/live-checks/deposit-list-reads-fast.test.mjs: the live check's verdict replays recorded runs
// (deposit-list-reads-fast.answers.json), each read by deposit-list-reads-fast.mjs read() in headless Chromium on the live
// hosts, a fresh account opening the header's Deposit cold, SIGN_HOST answered from a local build (--sign-dir):
//   good: this card's build: the probes leave before the token list is back, the answer follows the last read at once,
//         the three USDC rows: PASS;
//   bad:  the build before it (0e9f11dc8): each probe leaves only after the token list is back: FAIL.
// Planted from the good run: a probe after the list, an answer held past the slack, a missing row, no answer, a busy
// answer (INCONCLUSIVE), a missing width.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ANSWER_SLACK_MS, judge } from "./deposit-list-reads-fast.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "deposit-list-reads-fast.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this card's build asks the list and the probes at once and answers on the last of them: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad answer: the build before this card sends each probe only after the token list is back: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: the probes left at`) && /3 not before/.test(l)), r.lines.join("\n"));
});

test("planted: a probe after the list, an answer held past the slack, a missing USDC row, no answer, a missing width fail", () => {
  fails(mut((rec) => (rec.widths.phone.probes[1].start = rec.widths.phone.tokens.end)), /^BAD phone: the probes left at .* 1 not before/);
  fails(mut((rec) => {
    const r = rec.widths.desktop;
    r.answer.at = Math.max(r.tokens.end, ...r.probes.map((p) => p.end)) + ANSWER_SLACK_MS + 1;
  }), /^BAD desktop: the answer posted \d+ ms after the last read ended/);
  fails(mut((rec) => (rec.widths.phone.answer.rows = rec.widths.phone.answer.rows.filter((x) => x !== "USDC base"))), /^BAD phone: deposit\.assets answers/);
  fails(mut((rec) => (rec.widths.desktop.answer = null)), /^BAD desktop: the page never answered deposit\.assets/);
  fails(mut((rec) => rec.widths.phone.probes.pop()), /^BAD phone: 2 probe quote\(s\) seen/);
  fails(mut((rec) => (rec.widths.desktop.fillMs = null)), /^BAD desktop: Asset and Chain fill never/);
  fails(mut((rec) => delete rec.widths.desktop), /^BAD desktop: not read/);
});

test("planted: the list answered busy proves nothing either way: INCONCLUSIVE, never a PASS", () => {
  const r = mut((rec) => (rec.widths.phone.answer = { at: 900, ok: false, rows: null, code: "busy" }));
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
});
