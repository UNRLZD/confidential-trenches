// node --test scripts/live-checks/signpage-pool-pins.test.mjs: the live check's verdict replays recorded runs
// (signpage-pool-pins.answers.json), each read on 5 Nov by signpage-pool-pins.mjs collect():
//   good: --harness at 16:29:00Z, this card's signing page bundle and public/_headers as SIGN_HOST's: the bundle carries
//         no testnet pin, the page's Solana pair (publicnode and the helper's route) agreed on the Rent sysvar (5,080
//         lamports per byte, factor 1), the CSP names both: PASS;
//   bad:  live SIGN_HOST at 16:29:02Z, serving release-33's bundle from before this card (its sha384 is not the
//         checkout's): FAIL.
// Planted from the good run: a testnet pin in the served bundle, a disagreeing Rent read, another pair, a CSP without
// the helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./signpage-pool-pins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-pool-pins.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this card's bundle, no testnet pin, the page's pair agrees on the Rent sysvar: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST serving the bundle from before this card: FAIL", () => {
  fails(judge(ANSWERS.bad), /^BAD SIGN_HOST's \/app\.js is this checkout's signing page bundle: served sha384-/);
});

test("planted: a testnet pin served, a failed or one-sided Rent read, another pair, a CSP without the helper", () => {
  fails(mut((r) => (r.signBundle.testnet = ["9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8"])), /mainnet table/);
  fails(mut((r) => (r.rent = { rpcs: r.rent.rpcs, error: "the two providers' Rent differ" })), /agrees on the Rent sysvar: the two providers/);
  fails(mut((r) => (r.rent.rpcs = [r.rent.rpcs[0], r.rent.rpcs[0]])), /page's Solana pair/);
  fails(mut((r) => (r.signCsp = r.signCsp.replace("https://ct-api.unrealized.trade", ""))), /connect-src names both: not https:\/\/ct-api\./);
  fails(mut((r) => (r.signBundle.status = 404)), /HTTP 404/);
});
