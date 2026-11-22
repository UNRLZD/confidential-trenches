// node --test scripts/live-checks/evm-buy-late-fill-reaches-app.test.mjs: the live check's verdict replays recorded runs
// (evm-buy-late-fill-reaches-app.answers.json), each read on 22 Nov by evm-buy-late-fill-reaches-app.mjs --harness in
// headless Chrome, a terminal build at APP_HOST's name framed by the stand-in shell signed in with a Base pool, its Base
// buy answered refused and LATE_END_MS later its late ends posted (refused, then filled with a Base tx), at 390 and 1440:
//   good: the build with card evm-buy-late-fill-reaches-app: ended refused before the late ends, Filled with the fill
//         toast on basescan after them: PASS;
//   bad:  main's build before it (5d7c3a99d): the box stays ended refused (Retry) with no toast: FAIL.
// Planted from the good run: no Filled (refused kept, or another end), no toast or another link, the late ends never
// posted or out before the refused read, the box not ended refused before them, two buys or one on another chain, Buy
// off, no frame or page, a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LATE, TX, TX_URL } from "./evm-buy-late-fill-reaches-app.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "evm-buy-late-fill-reaches-app.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const fails = (rec, re) => {
  const r = judge(rec);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};
const planted = (edit) => {
  const rec = structuredClone(ANSWERS.good);
  edit(rec);
  return rec;
};

test("recorded good answer: both widths ended refused before the late ends, then Filled with the toast on basescan: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
});

test("recorded bad answer: main's build before the card stays refused with no toast after the late ends: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: after them the box reads "Retry" (ended refused)`)), r.lines.join("\n"));
    assert.ok(bad(r).includes(`BAD ${w}: no fill toast, want ${TX_URL}`), r.lines.join("\n"));
  }
  // and nothing else of the run failed: the late ends went out after a refused box, so only the late fill is missing
  assert.equal(bad(r).length, 4, r.lines.join("\n"));
});

test("the shell's late ends are the signing page's: refused, then filled with a Base tx the toast links", () => {
  assert.deepEqual(LATE["pool.buy"].map((x) => x.stage), ["refused", "filled"]);
  assert.deepEqual(LATE["pool.buy"][1].txs, [TX]);
  assert.match(TX.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(TX_URL, `https://basescan.org/tx/${TX.hash}`);
});

test("planted: each broken fact fails by its own line", () => {
  fails(planted((r) => ((r.runs[0].after.cta = "Retry"), (r.runs[0].after.stage = "refused"))), /box reads "Retry" \(ended refused\), want Filled/);
  fails(planted((r) => (r.runs[1].after.stage = "owed_back")), /\(ended owed_back\), want Filled/);
  fails(planted((r) => (r.runs[1].after.cta = "Landing 1.5s")), /reads "Landing 1\.5s", want Filled/);
  fails(planted((r) => ((r.runs[0].after.toast = false), (r.runs[0].after.href = null))), /no fill toast/);
  fails(planted((r) => (r.runs[1].after.href = "https://basescan.org/tx/0x00")), /the fill toast links https:\/\/basescan\.org\/tx\/0x00,/);
  fails(planted((r) => (r.runs[0].late = false)), /never posted/);
  fails(planted((r) => (r.runs[1].before.lateOut = true)), /read after the late ends went out/);
  fails(planted((r) => ((r.runs[0].before.stage = null), (r.runs[0].before.cta = "Landing 0.3s"))), /the box is "Landing 0\.3s", want ended refused/);
  fails(planted((r) => (r.runs[1].buys = 2)), /2 pool\.buy sent/);
  fails(planted((r) => (r.runs[0].chain = "solana")), /sent on solana, want 1 on base/);
  fails(planted((r) => (r.runs[0].buyOn = false)), /Buy off/);
  fails(planted((r) => (r.runs[1].framed = false)), /not inside SIGN_HOST's shell/);
  fails(planted((r) => (r.runs[1].ready = false)), /the coin's page not ready/);
  fails(planted((r) => r.runs.pop()), /run\(s\) of 2/);
  fails({ runs: [] }, /run\(s\) of 2/);
});
