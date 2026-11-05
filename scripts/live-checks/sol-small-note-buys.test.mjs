// node --test scripts/live-checks/sol-small-note-buys.test.mjs: the live check's verdict replays recorded runs
// (sol-small-note-buys.answers.json), each made on 5 Nov by sol-small-note-buys.mjs collect():
//   good: live at 19:17:14Z: the page's Solana pair (publicnode and the helper's route) agreed on the Rent sysvar (5,080
//         lamports per byte, factor 1), no mainnet pool pinned yet, the 0.01 SOL rung's tap_max 384,880: PASS;
//   bad:  --rent 3480x2 at 19:17:16Z, the older rate the signing page's testnet test also prices at: the fee 1,700,000
//         and the rung's tap_max 0: FAIL.
// Planted from the good run: a one-sided Rent read, another pair, and a pinned pool, whose helper fee answer is the
// devnet pool's of 5 Nov 19:14:28Z (fee 1,300,000, fee payer 9T3Rg…) standing for mainnet's: as answered it passes,
// and another fee, another fee payer or a 404 fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./sol-small-note-buys.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "sol-small-note-buys.answers.json"), "utf8"));
const PIN = { program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
const FEE_ANSWER = { chain: "solana", cluster: "devnet", program: PIN.program, pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr", fee_payer: PIN.feePayer, epoch_ms: 60000, epoch_start_ms: 1793906040000, fee: "1300000", step: "100000" };
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};
const pinned = (answer, status = 200) => (r) => {
  r.pin = PIN;
  r.helperFee = { status, answer };
};

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

test("planted: a pinned pool, its helper fee read: the device's fee and the pinned fee payer pass; anything else fails", () => {
  const ok = mut(pinned(FEE_ANSWER));
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  fails(mut(pinned({ ...FEE_ANSWER, fee: "1400000" })), /helper's fee .*fee 1400000/);
  fails(mut(pinned({ ...FEE_ANSWER, fee_payer: PIN.program })), /helper's fee/);
  fails(mut(pinned({ ...FEE_ANSWER, pool: PIN.feePayer })), /helper's fee/);
  fails(mut(pinned(null, 404)), /helper's fee .*HTTP 404/);
});
