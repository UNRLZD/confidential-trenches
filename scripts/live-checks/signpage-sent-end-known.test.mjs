// node --test scripts/live-checks/signpage-sent-end-known.test.mjs: the live check's verdict replays recorded runs
// (signpage-sent-end-known.answers.json), each read on 22 Nov by signpage-sent-end-known.mjs --harness in headless
// Chrome, a terminal build at APP_HOST's name framed by the stand-in shell signed in with a Base pool, its Base buy
// answered sent with no progress after it, and LATE_END_MS later its op recorded filled with a Base tx in the state's
// ops, at 390 and 1440:
//   good: the build with card signpage-sent-end-known: Landing before the op, Filled with the fill toast on basescan
//         after it: PASS;
//   bad:  main's build before it (2d870021c): the box stays Landing with no toast: FAIL.
// Planted from the good run: no Filled (Landing kept, or an end), no toast or another link, the op never recorded or
// out before the Landing read, the box not Landing before it, two buys or one on another chain, Buy off, no frame or
// page, a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LATE, TX, TX_URL } from "./signpage-sent-end-known.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-sent-end-known.answers.json"), "utf8"));
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

test("recorded good answer: both widths Landing before the op, then Filled with the toast on basescan: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
});

test("recorded bad answer: main's build before the card stays Landing with no toast after the op: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: after it the box reads "Landing`)), r.lines.join("\n"));
    assert.ok(bad(r).includes(`BAD ${w}: no fill toast, want ${TX_URL}`), r.lines.join("\n"));
  }
  // and nothing else of the run failed: the op went out after a Landing box, so only its end is missing
  assert.equal(bad(r).length, 4, r.lines.join("\n"));
});

test("the shell's end is the signing page's op: the buy's op recorded filled with a Base tx the toast links", () => {
  assert.deepEqual(LATE["pool.buy"], [{ stage: "filled", txs: [TX], op: true }]);
  assert.match(TX.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(TX_URL, `https://basescan.org/tx/${TX.hash}`);
});

test("planted: each broken fact fails by its own line", () => {
  fails(planted((r) => (r.runs[0].after.cta = "Landing 3.5s")), /reads "Landing 3\.5s", want Filled/);
  fails(planted((r) => (r.runs[1].after.stage = "not_landed")), /\(ended not_landed\), want Filled/);
  fails(planted((r) => ((r.runs[0].after.toast = false), (r.runs[0].after.href = null))), /no fill toast/);
  fails(planted((r) => (r.runs[1].after.href = "https://basescan.org/tx/0x00")), /the fill toast links https:\/\/basescan\.org\/tx\/0x00,/);
  fails(planted((r) => (r.runs[0].late = false)), /never recorded/);
  fails(planted((r) => (r.runs[1].before.lateOut = true)), /read after the op went out/);
  fails(planted((r) => ((r.runs[0].before.stage = "refused"), (r.runs[0].before.cta = "Retry"))), /reads "Retry" \(ended refused\), want Landing with no end/);
  fails(planted((r) => (r.runs[1].before.cta = "Filled 0.4s")), /reads "Filled 0\.4s", want Landing with no end/);
  fails(planted((r) => (r.runs[1].buys = 2)), /2 pool\.buy sent/);
  fails(planted((r) => (r.runs[0].chain = "solana")), /sent on solana, want 1 on base/);
  fails(planted((r) => (r.runs[0].buyOn = false)), /Buy off/);
  fails(planted((r) => (r.runs[1].framed = false)), /not inside SIGN_HOST's shell/);
  fails(planted((r) => (r.runs[1].ready = false)), /the coin's page not ready/);
  fails(planted((r) => r.runs.pop()), /run\(s\) of 2/);
  fails({ runs: [] }, /run\(s\) of 2/);
});
