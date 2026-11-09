// node --test scripts/live-checks/signpage-pool-pins.test.mjs: the live check's verdict replays recorded runs
// (signpage-pool-pins.answers.json), each read on 9 Nov by signpage-pool-pins.mjs collect() (card
// sol-pools-mainnet-pin, which added reads 4 and 5):
//   good: --harness at 17:06:26Z, card sol-pools-mainnet-pin's signing page bundle and public/_headers as SIGN_HOST's:
//         the bundle carries no testnet pin and carries the mainnet pin (the deploy record's program EN1Wb2iW… and one
//         fee payer literal, CPWhFyFL…), the
//         page's Solana pair (publicnode and the helper's route) agreed on the Rent sysvar (5,080 lamports per byte,
//         factor 1), the CSP names both, the helper at ed0f714a answered that program, its pool 7ijWvp3x… and that fee
//         payer with fee 1,300,000, and mainnet-beta and publicnode read the program executable and the fee payer a
//         system account holding 10,000,000 lamports: PASS;
//   bad:  live SIGN_HOST at 17:06:30Z, serving the bundle from before this card (its sha384 is not the checkout's, and it
//         pins no fee payer, so neither the helper's answer nor the chain reads match a pin): FAIL.
// Planted from the good run: a testnet pin in the served bundle, a disagreeing Rent read, another pair, a CSP without
// the helper; and for the mainnet pin, a helper that names another fee payer, program or fee, a bundle with no fee payer,
// two, or not the deploy's program, a fee payer missing on one RPC, a program that is not executable, another account
// read, the accounts read on the helper's own route.
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

test("recorded good answer: this card's bundle, no testnet pin, the mainnet pin the helper and two RPCs hold: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST serving the bundle from before this card: FAIL", () => {
  fails(judge(ANSWERS.bad), /^BAD SIGN_HOST's \/app\.js is this checkout's signing page bundle: served sha384-/);
  fails(judge(ANSWERS.bad), /^BAD the served bundle pins one fee payer: none/);
  fails(judge(ANSWERS.bad), /^BAD the helper signs with the pinned fee payer: CPWh\w+, the bundle's none/);
});

test("planted: a testnet pin served, a failed or one-sided Rent read, another pair, a CSP without the helper", () => {
  fails(mut((r) => (r.signBundle.testnet = ["9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8"])), /mainnet table/);
  fails(mut((r) => (r.rent = { rpcs: r.rent.rpcs, error: "the two providers' Rent differ" })), /agrees on the Rent sysvar: the two providers/);
  fails(mut((r) => (r.rent.rpcs = [r.rent.rpcs[0], r.rent.rpcs[0]])), /page's Solana pair/);
  fails(mut((r) => (r.signCsp = r.signCsp.replace("https://ct-api.unrealized.trade", ""))), /connect-src names both: not https:\/\/ct-api\./);
  fails(mut((r) => (r.signBundle.status = 404)), /HTTP 404/);
});

test("planted: the mainnet pin not the helper's, not served, or not on chain on both RPCs", () => {
  // the helper's fee payer is not the pin's (helper-sol-fee-payer-mainnet's throwaway key): every mainnet release refused
  fails(mut((r) => (r.helperFee.body.fee_payer = "8Rj4ZJubKsa3dB9b63Y4eopdFbuchWPWsjohC8YAnEzL")), /^BAD the helper signs with the pinned fee payer: 8Rj4\w+, the bundle's CPWh/);
  fails(mut((r) => (r.signBundle.feePayers = ["9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb"])), /^BAD the helper signs with the pinned fee payer: CPWh\w+, the bundle's 9T3R/);
  fails(mut((r) => r.signBundle.feePayers.push("9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb")), /^BAD the served bundle pins one fee payer: CPWh\w+, 9T3R/);
  fails(mut((r) => (r.helperFee.body.program = "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8")), /^BAD the helper's mainnet fee answer is the pinned pool's/);
  fails(mut((r) => (r.helperFee = { status: 404, body: { error: "not_found" } })), /^BAD the helper's mainnet fee answer is the pinned pool's: HTTP 404/);
  fails(mut((r) => (r.helperFee.body.fee = "1400000")), /^BAD the helper's fee is solanaPoolFee at that rent: 1400000, not 1300000/);
  fails(mut((r) => (r.signBundle.program = false)), /^BAD the served bundle carries the deploy record's program: not EN1W/);
  fails(mut((r) => (r.chain.feePayer = r.chain.feePayer.map((a) => ({ ...a, address: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" })))), /^BAD the fee payer is a system account/);
  fails(mut((r) => (r.chain.feePayer[1] = { url: r.chain.feePayer[1].url, error: "no account" })), /^BAD the fee payer is a system account/);
  fails(mut((r) => (r.chain.program[0].executable = false)), /^BAD the program is an executable on both/);
  fails(mut((r) => (r.chain.rpcs = ["https://api.mainnet-beta.solana.com", "https://ct-api.unrealized.trade/v1/rpc/solana"])), /^BAD the pin's accounts are read on/);
});

test("a provider with no usable answer for the pin's accounts is named and not judged: INCONCLUSIVE, never PASS; FAIL beside a wrong answer", () => {
  const quiet = (r) => (r.chain.feePayer[1] = { url: r.chain.feePayer[1].url, address: r.chain.feePayer[1].address, noAnswer: "solana-rpc.publicnode.com: no answer (HTTP 429)" });
  const r = mut(quiet);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^--- solana-rpc\.publicnode\.com: no answer \(HTTP 429\) \(the fee payer is a system account/.test(l)), r.lines.join("\n"));
  const both = mut((x) => (quiet(x), (x.helperFee.body.fee_payer = "8Rj4ZJubKsa3dB9b63Y4eopdFbuchWPWsjohC8YAnEzL")));
  assert.equal(both.verdict, "FAIL", both.lines.join("\n"));
  assert.equal(judge(ANSWERS.good).verdict, "PASS");
});
