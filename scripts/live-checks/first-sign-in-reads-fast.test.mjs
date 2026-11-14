// node --test scripts/live-checks/first-sign-in-reads-fast.test.mjs: the live check's verdict replays recorded runs
// (first-sign-in-reads-fast.answers.json), each the "restore: <chain> walked" lines pool-restore-wired.mjs collect() read:
//   good: this card's signing page build with the pinned hosts on the network (--local --net, box, 14 Nov 05:21Z), the
//         slowest of three runs at 7f3492ffa: Base 3.1 s and Robinhood 10.5 s after Solana, within GAP_MS: PASS;
//   bad:  live SIGN_HOST at release 133, before this card (14 Nov 03:31Z, box Chrome 156, the first of three runs):
//         Robinhood 16.7 s and Base 19.9 s after Solana: FAIL.
// Planted from the good run: a pool that never walks, Solana missing, an EVM pool past GAP_MS, an error.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GAP_MS, judge } from "./first-sign-in-reads-fast.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "first-sign-in-reads-fast.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};
const sol = (rec) => rec.walked.find((w) => w.chain === "solana").t;

test("recorded good answer: this card's build walks Base and Robinhood within GAP_MS of Solana: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: live SIGN_HOST before this card walks Base and Robinhood long after Solana: FAIL", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /^BAD base walked \d+ ms after Solana/);
  fails(r, /^BAD robinhood walked \d+ ms after Solana/);
});

test("planted: a pool that never walks, no Solana line, an EVM pool past GAP_MS, an error: FAIL; one at GAP_MS: PASS", () => {
  for (const chain of ["base", "robinhood"]) {
    fails(mut((rec) => (rec.walked = rec.walked.filter((w) => w.chain !== chain))), new RegExp(`^BAD ${chain} walked never`));
    fails(mut((rec) => (rec.walked.find((w) => w.chain === chain).t = sol(rec) + GAP_MS + 1)), new RegExp(`^BAD ${chain} walked ${GAP_MS + 1} ms`));
    assert.equal(mut((rec) => (rec.walked.find((w) => w.chain === chain).t = sol(rec) + GAP_MS)).ok, true);
  }
  fails(mut((rec) => (rec.walked = rec.walked.filter((w) => w.chain !== "solana"))), /^BAD Solana walked \(never/);
  fails(mut((rec) => (rec.walked = [])), /^BAD Solana walked/);
  fails(mut((rec) => delete rec.walked), /^BAD Solana walked/);
  fails(mut((rec) => rec.errors.push("no words field")), /no error/);
});
