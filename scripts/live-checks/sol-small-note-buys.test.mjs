// node --test scripts/live-checks/sol-small-note-buys.test.mjs: the live check's verdict replays recorded runs
// (sol-small-note-buys.answers.json), each made on 5 Nov by sol-small-note-buys.mjs collect():
//   good:   live at 19:32:12Z: the page's Solana pair (publicnode and the helper's route) agreed on the Rent sysvar (5,080
//           lamports per byte, factor 1), no mainnet pin given, the 0.01 SOL rung's tap_max 384,880: PASS;
//   bad:    --rent 3480x2 at 19:32:13Z, the older rate the signing page's testnet test also prices at: the fee 1,700,000
//           and the rung's tap_max 0: FAIL;
//   pinned: live at 19:32:13Z with --pin the devnet pool's pin (program 5V9iJ…, fee payer 9T3Rg…) standing for
//           mainnet's, so the pin branch reads a real helper answer: fee 1,300,000, the device's: PASS.
// Planted from those: a one-sided Rent read, another pair, and on the pinned run another fee, fee payer or pool, or a 404.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./sol-small-note-buys.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "sol-small-note-buys.answers.json"), "utf8"));
const mut = (f, from = ANSWERS.good) => {
  const rec = structuredClone(from);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};
const onPinned = (f) => mut(f, ANSWERS.pinned);

test("recorded good answer: mainnet's rent on the page's pair, the 0.01 SOL rung's tap_max 384,880: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /tap_max .*: 384880 lamports$/.test(l)), r.lines.join("\n"));
});

test("recorded bad answer: the older rent, the rung's tap_max 0: FAIL", () => {
  fails(judge(ANSWERS.bad), /tap_max at the worst venue, fee 1700000 .*: 0 lamports$/);
});

test("planted: a failed or one-sided Rent read, another pair", () => {
  fails(mut((r) => (r.rent = { rpcs: r.rent.rpcs, error: "the providers disagree on rent" })), /agrees on the Rent sysvar: the providers disagree/);
  fails(mut((r) => (r.rent.rpcs = [r.rent.rpcs[0], r.rent.rpcs[0]])), /page's Solana pair/);
  fails(mut((r) => (r.rent.factor = "3")), /agrees on the Rent sysvar/);
});

test("recorded pinned answer: the helper's fee for the pinned pool is the device's, with the pinned fee payer: PASS", () => {
  const r = judge(ANSWERS.pinned);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok  the helper's fee for the pinned pool .* is the device's 1300000/.test(l)), r.lines.join("\n"));
});

test("planted on the pinned run: another fee, fee payer or pool, or a 404", () => {
  fails(onPinned((r) => (r.helperFee.answer.fee = "1400000")), /helper's fee .*fee 1400000/);
  fails(onPinned((r) => (r.helperFee.answer.fee_payer = r.pin.program)), /helper's fee/);
  fails(onPinned((r) => (r.helperFee.answer.pool = r.pin.feePayer)), /helper's fee/);
  fails(onPinned((r) => (r.helperFee = { status: 404, answer: null })), /helper's fee .*HTTP 404/);
});
