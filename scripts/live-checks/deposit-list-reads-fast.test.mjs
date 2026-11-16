// node --test scripts/live-checks/deposit-list-reads-fast.test.mjs: the live check's verdict replays recorded runs
// (deposit-list-reads-fast.answers.json), each read by deposit-list-reads-fast.mjs read() in headless Chromium on the live
// hosts, a fresh account opening the header's Deposit cold:
//   good:   this card's signing page and app, local builds (--sign-dir, --app-dir): the probes leave before the token
//           list is back, the answer follows the last read at once, the three USDC rows; each deposit.coin answers its
//           row and the sheet draws SOL and ETH, ETH on Base and Robinhood: PASS;
//   today:  the live hosts before this card (main d3ae40db4's release): each probe leaves only after the token list is
//           back and the answer waits for the floors: FAIL for speed;
//   rows:   the signing page of 3eea13901 (the list and probes at once, the floors dropped) with the live app: no
//           deposit.coin asked, no SOL or ETH row drawn: FAIL for the missing rows.
// Planted from the good run: a probe after the list, an answer held past the slack, a missing USDC row, no answer, a
// refused or unasked coin, a coin not drawn, Robinhood missing from ETH's chains, a busy answer (INCONCLUSIVE), a
// missing width.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ANSWER_SLACK_MS, COIN_MAX_MS, judge } from "./deposit-list-reads-fast.mjs";

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

test("recorded good answer: the USDC rows at once and each pool coin's row on its own read, drawn, none lost: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad answer, today's hosts: each probe leaves only after the token list is back: FAIL for speed", () => {
  const r = judge(ANSWERS.today);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: the probes left at`) && /3 not before/.test(l)), r.lines.join("\n"));
});

test("recorded bad answer, 3eea13901's page: no deposit.coin, no SOL or ETH row drawn: FAIL for the missing rows", () => {
  const r = judge(ANSWERS.rows);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) {
    assert.ok(bad(r).some((l) => l === `BAD ${w}: deposit.coin for robinhood never asked, want "ETH robinhood"`), r.lines.join("\n"));
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: the sheet draws SOL among its assets never`)), r.lines.join("\n"));
    assert.ok(!bad(r).some((l) => l.startsWith(`BAD ${w}: the probes left at`)), "its USDC reads are already at once");
  }
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

test("planted: a coin refused or never asked, a coin not drawn or drawn late, Robinhood missing from ETH's chains fail", () => {
  fails(mut((rec) => (rec.widths.phone.coins.robinhood = { ...rec.widths.phone.coins.robinhood, ok: false, row: null, code: "not_available" })), /^BAD phone: deposit\.coin for robinhood refused not_available/);
  fails(mut((rec) => (rec.widths.desktop.coins.solana = { asked: false })), /^BAD desktop: deposit\.coin for solana never asked/);
  fails(mut((rec) => delete rec.widths.phone.drawn.SOL), /^BAD phone: the sheet draws SOL among its assets never/);
  fails(mut((rec) => (rec.widths.desktop.drawn.ETH = COIN_MAX_MS + 1)), /^BAD desktop: the sheet draws ETH among its assets \d+ ms/);
  fails(mut((rec) => (rec.widths.phone.ethChains = ["Base"])), /^BAD phone: ETH's chains read \["Base"\]/);
});

test("planted: the list answered busy proves nothing either way: INCONCLUSIVE, never a PASS", () => {
  const r = mut((rec) => (rec.widths.phone.answer = { at: 900, ok: false, rows: null, code: "busy" }));
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
});
